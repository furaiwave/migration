export type DumpColumn = { name: string; type: string; primary: boolean };
export type DumpTable = { name: string; columns: DumpColumn[] };
export type DumpLink = { from: string; columns: string[]; to: string; references: string[]; fromMissing?: true; toMissing?: true };
export type DumpSchema = { tables: DumpTable[]; links: DumpLink[] };

type Token = { value: string; kind: "word" | "identifier" | "string" | "symbol" | "body"; raw?: string };
type SqlName = { parts: string[]; quoted: boolean[] };
export type DumpDialect = "postgres" | "mysql" | "sqlite";
type LexState = { backslashStrings: boolean; mysql: boolean; ansiQuotes: boolean };
type Table = { path: SqlName; table: DumpTable; primary: string[] };
type Key = { from: SqlName; searchPath: string[]; columns: string[] };
type ForeignKey = Key & { to: SqlName; references: string[] };
const INCOMPLETE = "The SQL dump is incomplete or contains unterminated SQL. Export the schema again.";
const word = (token: Token | undefined, value: string) => token?.kind === "word" && token.value.toUpperCase() === value;
const symbol = (token: Token | undefined, value: string) => token?.kind === "symbol" && token.value === value;
const identifier = (token: Token | undefined): token is Token => !!token && ["word", "identifier", "string"].includes(token.kind);
const asciiLower = (value: string) => value.replace(/[A-Z]/g, char => char.toLowerCase());
const identifierValue = (token: Token, dialect: DumpDialect) => dialect === "postgres" && token.kind === "word" ? token.value.toLowerCase() : token.value;
const display = (path: SqlName) => path.parts.map(part =>
  /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(part) ? part : '"' + part.replaceAll('"', '""') + '"',
).join(".");
const qualify = (path: SqlName, searchPath: string[]): SqlName =>
  path.parts.length === 1 && searchPath.length
    ? { parts: [searchPath[0], ...path.parts], quoted: [true, ...path.quoted] }
    : path;

// Yield only statement headers/DDL; do not retain INSERT rows in memory.
function* statements(sql: string, state: LexState, retainAll = false): Generator<Token[]> {
  let tokens: Token[] = [];
  let keep = true;
  let delimiter = ";";
  const lineComment = (at: number) => sql.startsWith("--", at) && (!state.mysql || !sql[at + 2] || /\s/.test(sql[at + 2]));
  const push = (token: Token) => {
    if (!tokens.length) keep = retainAll || ["CREATE", "ALTER", "DROP", "COPY", "SET", "SELECT", "USE"].some(value => word(token, value));
    if (keep || !tokens.length) tokens.push(token);
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }
    // psql directives are line based, not terminated by a SQL semicolon.
    if (!tokens.length && c === "\\") {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (!tokens.length && (c === "D" || c === "d")) {
      const command = /^DELIMITER[ \t]+(\S+)[^\r\n]*/i.exec(sql.slice(i));
      if (command) {
        delimiter = command[1];
        if (!state.mysql) { state.mysql = true; state.backslashStrings = true; }
        i += command[0].length; continue;
      }
    }
    if (lineComment(i) || (state.mysql && c === "#")) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const start = i;
      let depth = 1; i += 2;
      while (i < sql.length && depth) {
        if (sql.startsWith("/*", i)) { depth++; i += 2; }
        else if (sql.startsWith("*/", i)) { depth--; i += 2; }
        else i++;
      }
      if (depth) throw new Error(INCOMPLETE);
      if (state.mysql && /^\/\*(?:!|M!)/.test(sql.slice(start, start + 4))) {
        const body = sql.slice(start, i - 2).replace(/^\/\*(?:!|M!)\d*\s*/, "");
        for (const statement of statements(body, state, true)) statement.forEach(push);
      }
      continue;
    }
    if (sql.startsWith(delimiter, i)) {
      yield tokens;
      i += delimiter.length;
      if (word(tokens[0], "COPY") && tokens.some((t, n) => word(t, "FROM") && word(tokens[n + 1], "STDIN"))) {
        const end = /(?:^|\r?\n)\\\.(?=\r?\n|$)/g;
        end.lastIndex = i;
        if (!end.exec(sql)) throw new Error(INCOMPLETE);
        i = end.lastIndex;
      }
      tokens = []; keep = true; continue;
    }
    const dollar = !state.mysql && c === "$" ? /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))?.[0] : undefined;
    if (dollar) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end < 0) throw new Error(INCOMPLETE);
      i = end + dollar.length; push({ value: "", kind: "body" }); continue;
    }
    if (sql.startsWith("[]", i)) { push({ value: "[]", kind: "symbol" }); i += 2; continue; }
    if (c === "'" || c === '"' || c === String.fromCharCode(96) || c === "[") {
      const start = i;
      const close = c === "[" ? "]" : c;
      const literal = c === "'" || (c === '"' && state.mysql && !state.ansiQuotes);
      const escaped = literal && (state.backslashStrings || (sql[i - 1]?.toUpperCase() === "E" && !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? "")));
      if (c === String.fromCharCode(96) && !state.mysql) { state.mysql = true; state.backslashStrings = true; }
      let value = ""; let closed = false; i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          i++;
          if (sql[i] !== close) { closed = true; break; }
        } else if (literal && sql[i] === "\\" && escaped) {
          if (keep) value += sql[i + 1] ?? "";
          i += 2; continue;
        }
        if (keep) value += sql[i];
        i++;
      }
      if (!closed) throw new Error(INCOMPLETE);
      push({ value, kind: literal ? "string" : "identifier", raw: keep ? sql.slice(start, i) : undefined });
      continue;
    }
    if ("(),.=;".includes(c)) { push({ value: c, kind: "symbol" }); i++; continue; }
    const start = i;
    while (i < sql.length && !/[\s(),.=;'"\x60[]/.test(sql[i]) && !(state.mysql && sql[i] === "#") &&
      !lineComment(i) && !sql.startsWith("/*", i) && !sql.startsWith(delimiter, i)) i++;
    if (i === start) i++;
    push({ value: sql.slice(start, i), kind: "word" });
  }
  if (tokens.length) yield tokens;
}

function name(tokens: Token[], start: number, dialect: DumpDialect): [SqlName, number] {
  if (!identifier(tokens[start])) throw new Error(INCOMPLETE);
  const parts = [identifierValue(tokens[start], dialect)];
  const quoted = [tokens[start].kind !== "word"];
  let i = start + 1;
  while (symbol(tokens[i], ".")) {
    if (!identifier(tokens[i + 1])) throw new Error(INCOMPLETE);
    parts.push(identifierValue(tokens[i + 1], dialect)); quoted.push(tokens[i + 1].kind !== "word"); i += 2;
  }
  return [{ parts, quoted }, i];
}
function group(tokens: Token[], start: number): [Token[], number] {
  if (!symbol(tokens[start], "(")) return [[], start];
  let depth = 1; let i = start + 1;
  while (i < tokens.length && depth) {
    if (symbol(tokens[i], "(")) depth++;
    if (symbol(tokens[i], ")")) depth--;
    if (depth) i++;
  }
  if (depth) throw new Error(INCOMPLETE);
  return [tokens.slice(start + 1, i), i + 1];
}
function parts(tokens: Token[]): Token[][] {
  const result: Token[][] = []; let depth = 0; let start = 0;
  tokens.forEach((token, i) => {
    if (symbol(token, "(")) depth++;
    if (symbol(token, ")")) depth--;
    if (symbol(token, ",") && depth === 0) { result.push(tokens.slice(start, i)); start = i + 1; }
  });
  if (depth) throw new Error(INCOMPLETE);
  if (start < tokens.length) result.push(tokens.slice(start));
  return result;
}
function columns(tokens: Token[], start: number, dialect: DumpDialect): string[] {
  const [inside] = group(tokens, start);
  return parts(inside).filter(part => identifier(part[0])).map(part => identifierValue(part[0], dialect));
}


function tableConstraint(tokens: Token[]): boolean {
  if (word(tokens[0], "CONSTRAINT")) return true;
  if (word(tokens[0], "PRIMARY") || word(tokens[0], "FOREIGN")) return word(tokens[1], "KEY");
  if (word(tokens[0], "CHECK")) return symbol(tokens[1], "(");
  if (word(tokens[0], "EXCLUDE")) return word(tokens[1], "USING") || symbol(tokens[1], "(");
  if (["UNIQUE", "KEY", "INDEX", "FULLTEXT", "SPATIAL"].some(value => word(tokens[0], value))) {
    return symbol(tokens[1], "(") || word(tokens[1], "KEY") || word(tokens[1], "INDEX") ||
      (identifier(tokens[1]) && (symbol(tokens[2], "(") || word(tokens[2], "USING")));
  }
  return false;
}

export const BINARY_DUMP_MESSAGE = "Use a plain-text SQL dump. Binary and compressed dumps must be exported to SQL first.";

export function isBinarySqlDump(bytes: Uint8Array): boolean {
  const signatures = [
    [0x50, 0x47, 0x44, 0x4d, 0x50], // PostgreSQL custom archive
    [0x1f, 0x8b], [0x50, 0x4b, 0x03, 0x04], // gzip, zip
    [0x42, 0x5a, 0x68], [0xfd, 0x37, 0x7a, 0x58, 0x5a], // bzip2, xz
    [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7zip
  ];
  return bytes.includes(0) || signatures.some(signature => signature.every((value, i) => bytes[i] === value));
}

function detectDialect(sql: string): DumpDialect {
  if (/^--\s*PostgreSQL database dump\b/m.test(sql)) return "postgres";
  if (/^--\s*(?:MySQL|MariaDB) dump\b/m.test(sql) ||
    /^\s*(?:USE\b|DELIMITER\b|SET\s+(?:SESSION\s+)?SQL_MODE\b|CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?\x60)/mi.test(sql) ||
    /\/\*(?:!|M!)\d{5,6}\s/.test(sql)) return "mysql";
  if (/^\s*PRAGMA\b/mi.test(sql) || /^\s*CREATE\s+(?:TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?['[]/mi.test(sql)) return "sqlite";
  return "postgres";
}

export function parseSqlDump(sql: string, dialect: DumpDialect = detectDialect(sql)): DumpSchema {
  if (sql.startsWith("PGDMP") || sql.includes("\0")) throw new Error(BINARY_DUMP_MESSAGE);
  const tables = new Map<string, Table>();
  const primary: Key[] = [];
  const foreign: ForeignKey[] = [];
  const key = (path: SqlName) => JSON.stringify(dialect === "sqlite" ? path.parts.map(asciiLower) : path.parts);
  const columnKey = (value: string) => dialect === "postgres" ? value : asciiLower(value);
  const defaultSearchPath = dialect === "postgres" ? ["public"] : dialect === "sqlite" ? ["main"] : [];
  let searchPath = [...defaultSearchPath];
  let explicitSearchPath = false;
  let sawTable = false;
  const state: LexState = { backslashStrings: dialect === "mysql", mysql: dialect === "mysql", ansiQuotes: false };

  const resolve = (path: SqlName, namespaces: string[]): Table | undefined => {
    const candidates = path.parts.length > 1 || (!namespaces.length && dialect !== "postgres")
      ? [path] : namespaces.map(namespace => ({ parts: [namespace, ...path.parts], quoted: [true, ...path.quoted] }));
    for (const candidate of candidates) {
      const found = tables.get(key(candidate));
      if (found) return found;
    }
  };
  const actualColumns = (table: Table | undefined, names: string[]) => {
    const actual = new Map(table?.table.columns.map(column => [columnKey(column.name), column.name]));
    return names.map(value => actual.get(columnKey(value)) ?? value);
  };
  const discardKeys = (path: SqlName, cascade = false) => {
    for (let i = primary.length - 1; i >= 0; i--) if (key(primary[i].from) === key(path)) primary.splice(i, 1);
    for (let i = foreign.length - 1; i >= 0; i--) {
      const link = foreign[i];
      const target = cascade ? resolve(link.to, link.searchPath) : undefined;
      if (key(link.from) === key(path) || (target && key(target.path) === key(path))) foreign.splice(i, 1);
    }
  };
  const constraints = (from: SqlName, tokens: Token[], column?: string) => {
    const namespaces = dialect === "mysql" && from.parts.length > 1 ? [from.parts[0]] : [...searchPath];
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      if (symbol(tokens[i], "(")) { depth++; continue; }
      if (symbol(tokens[i], ")")) { depth--; continue; }
      if (depth) continue;
      if (word(tokens[i], "PRIMARY") && word(tokens[i + 1], "KEY")) {
        primary.push({ from, searchPath: namespaces, columns: column ? [column] : columns(tokens, i + 2, dialect) });
      }
      if (!column && word(tokens[i], "FOREIGN") && word(tokens[i + 1], "KEY")) {
        const start = symbol(tokens[i + 2], "(") ? i + 2 : i + 3;
        const local = columns(tokens, start, dialect);
        const [, next] = group(tokens, start);
        if (!local.length || !word(tokens[next], "REFERENCES")) continue;
        const [to, end] = name(tokens, next + 1, dialect);
        foreign.push({ from, searchPath: namespaces, columns: local, to, references: columns(tokens, end, dialect) });
      } else if (column && word(tokens[i], "REFERENCES")) {
        const [to, end] = name(tokens, i + 1, dialect);
        foreign.push({ from, searchPath: namespaces, columns: [column], to, references: columns(tokens, end, dialect) });
      }
    }
  };
  const addColumn = (table: Table | undefined, from: SqlName, part: Token[], ifNotExists = false) => {
    if (!identifier(part[0])) throw new Error(INCOMPLETE);
    const column = identifierValue(part[0], dialect);
    if (ifNotExists && table?.table.columns.some(value => columnKey(value.name) === columnKey(column))) return;
    let depth = 0;
    let stop = part.length;
    for (let n = 1; n < part.length; n++) {
      if (symbol(part[n], "(")) depth++;
      if (symbol(part[n], ")")) depth--;
      if (!depth && ["NOT", "NULL", "DEFAULT", "PRIMARY", "REFERENCES", "CONSTRAINT", "UNIQUE", "CHECK", "GENERATED", "COLLATE", "AUTO_INCREMENT", "AUTOINCREMENT"].some(value => word(part[n], value))) { stop = n; break; }
    }
    table?.table.columns.push({
      name: column,
      type: part.slice(1, stop).map(t => t.raw ?? t.value).join(" ").replaceAll(" []", "[]"),
      primary: false,
    });
    constraints(from, part.slice(1), column);
  };
  const setSearchPath = (tokens: Token[]) => {
    if (word(tokens[0], "DEFAULT")) {
      searchPath = [...defaultSearchPath]; explicitSearchPath = false; return;
    }
    if (tokens.length === 1 && tokens[0].kind === "string") {
      tokens = [...statements(tokens[0].value, { backslashStrings: false, mysql: false, ansiQuotes: false }, true)][0] ?? [];
    }
    explicitSearchPath = true;
    searchPath = parts(tokens).filter(part => identifier(part[0])).map(part => identifierValue(part[0], dialect))
      .filter(value => value && value !== "$user" && value !== "pg_catalog");
  };

  for (const tokens of statements(sql, state)) {
    if (word(tokens[0], "SET")) {
      let settings = tokens.slice(1);
      if (word(settings[0], "SESSION") || word(settings[0], "LOCAL") || word(settings[0], "GLOBAL")) settings = settings.slice(1);
      for (const assignment of parts(settings)) {
        const separator = assignment.findIndex(token => symbol(token, "=") || word(token, "TO"));
        if (separator < 0) continue;
        const setting = assignment.slice(0, separator).map(token => token.value).join("").toUpperCase();
        const value = assignment[separator + 1];
        if (setting === "SEARCH_PATH") { setSearchPath(settings.slice(separator + 1)); break; }
        if (setting === "STANDARD_CONFORMING_STRINGS") state.backslashStrings = value?.value.toLowerCase() === "off";
        if (/^(?:@@(?:(?:SESSION|LOCAL|GLOBAL)\.)?)?SQL_MODE$/.test(setting) && value && ["string", "identifier"].includes(value.kind)) {
          const modes = value.value.toUpperCase().split(",").map(mode => mode.trim());
          state.mysql = true;
          state.backslashStrings = !modes.includes("NO_BACKSLASH_ESCAPES");
          state.ansiQuotes = modes.includes("ANSI_QUOTES");
        }
      }
      continue;
    }
    if (word(tokens[0], "SELECT") && identifier(tokens[1])) {
      const [fn, next] = name(tokens, 1, dialect);
      if ((fn.parts.length === 1 || (fn.parts.length === 2 && fn.parts[0] === "pg_catalog")) && fn.parts.at(-1) === "set_config" && symbol(tokens[next], "(")) {
        const args = parts(group(tokens, next)[0]);
        if (args[0]?.[0]?.value === "search_path" && args[1]?.[0]?.kind === "string") setSearchPath(args[1]);
      }
      continue;
    }
    if (word(tokens[0], "USE")) {
      searchPath = name(tokens, 1, dialect)[0].parts;
      explicitSearchPath = true;
      continue;
    }
    let i = 1;
    if (word(tokens[0], "CREATE")) {
      if (word(tokens[i], "TEMP") || word(tokens[i], "TEMPORARY") || word(tokens[i], "UNLOGGED")) i++;
      if (!word(tokens[i++], "TABLE")) continue;
      const ifNotExists = word(tokens[i], "IF") && word(tokens[i + 1], "NOT") && word(tokens[i + 2], "EXISTS");
      if (ifNotExists) i += 3;
      const [raw, next] = name(tokens, i, dialect);
      if (!symbol(tokens[next], "(")) continue;
      const path = qualify(raw, searchPath);
      sawTable = true;
      if (ifNotExists && tables.has(key(path))) continue;
      const [body] = group(tokens, next);
      discardKeys(path);
      const table: Table = { path, table: { name: display(explicitSearchPath ? path : raw), columns: [] }, primary: [] };
      tables.set(key(path), table);
      for (const part of parts(body)) {
        if (!part.length) continue;
        if (tableConstraint(part)) constraints(path, part);
        else addColumn(table, path, part);
      }
    } else if (word(tokens[0], "ALTER") && word(tokens[1], "TABLE")) {
      i = 2;
      if (word(tokens[i], "IF") && word(tokens[i + 1], "EXISTS")) i += 2;
      if (word(tokens[i], "ONLY")) i++;
      const [raw, next] = name(tokens, i, dialect);
      const table = resolve(raw, searchPath);
      const path = table?.path ?? qualify(raw, searchPath);
      for (const action of parts(tokens.slice(next))) {
        if (!word(action[0], "ADD")) continue;
        let start = word(action[1], "COLUMN") ? 2 : 1;
        const ifNotExists = word(action[start], "IF") && word(action[start + 1], "NOT") && word(action[start + 2], "EXISTS");
        if (ifNotExists) start += 3;
        const definition = action.slice(start);
        if (tableConstraint(definition)) constraints(path, definition);
        else if (symbol(definition[0], "(")) {
          for (const part of parts(group(definition, 0)[0])) addColumn(table, path, part, ifNotExists);
        } else addColumn(table, path, definition, ifNotExists);
      }
    } else if (word(tokens[0], "DROP")) {
      if (word(tokens[i], "TEMP") || word(tokens[i], "TEMPORARY")) i++;
      if (!word(tokens[i++], "TABLE")) continue;
      if (word(tokens[i], "IF") && word(tokens[i + 1], "EXISTS")) i += 2;
      const cascade = tokens.some(token => word(token, "CASCADE"));
      for (const entry of parts(tokens.slice(i))) {
        const [raw] = name(entry, 0, dialect);
        const table = resolve(raw, searchPath);
        if (table) { discardKeys(table.path, cascade); tables.delete(key(table.path)); }
      }
    }
  }
  if (!sawTable) throw new Error("No CREATE TABLE statements found. Upload a plain-text SQL dump that includes the database schema.");

  for (const entry of primary) {
    const table = resolve(entry.from, entry.searchPath);
    if (!table) continue;
    table.primary = actualColumns(table, entry.columns);
    const names = new Set(table.primary);
    table.table.columns.forEach(column => { column.primary = names.has(column.name); });
  }
  const links: DumpLink[] = foreign.map(link => {
    const from = resolve(link.from, link.searchPath);
    const to = resolve(link.to, link.searchPath);
    return {
      from: from?.table.name ?? display(link.from),
      columns: actualColumns(from, link.columns),
      to: to?.table.name ?? display(link.to),
      references: link.references.length ? actualColumns(to, link.references) : to?.primary ?? [],
      ...(!from ? { fromMissing: true as const } : {}),
      ...(!to ? { toMissing: true as const } : {}),
    };
  });
  return { tables: [...tables.values()].map(value => value.table), links };
}
