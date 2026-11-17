import type {
  EditorConnection,
  EditorEngine,
  QuerySet,
} from "@/api/sql-editor.types";
export const isEditorEngine = (engine: string): engine is EditorEngine =>
  ["postgres", "mysql", "mssql"].includes(engine);
let idCounter = 0;
export function editorId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    "sql-" +
      Date.now().toString(36) +
      "-" +
      (++idCounter).toString(36) +
      "-" +
      Math.random().toString(36).slice(2)
  );
}
const STORAGE = "data-migrator:sql-connections";
export type ConnectionProfile = {
  id: string;
  label: string;
  connection: Omit<EditorConnection, "password">;
};
export function safeConnection(
  value: unknown,
): Omit<EditorConnection, "password"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const c = value as Record<string, unknown>;
  if (
    typeof c.engine !== "string" ||
    !isEditorEngine(c.engine) ||
    typeof c.host !== "string" ||
    !c.host.trim() ||
    c.host.length > 255 ||
    typeof c.port !== "number" ||
    !Number.isInteger(c.port) ||
    c.port < 1 ||
    c.port > 65535 ||
    typeof c.user !== "string" ||
    c.user.length > 256 ||
    typeof c.database !== "string" ||
    c.database.length > 128
  )
    return null;
  return {
    engine: c.engine,
    host: c.host,
    port: c.port,
    user: c.user,
    database: c.database,
    encrypt: c.encrypt === true,
    trustServerCertificate: c.trustServerCertificate === true,
  };
}
export function loadConnections(): ConnectionProfile[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(STORAGE) ?? "[]");
    if (!Array.isArray(data)) return [];
    return data.slice(0, 30).flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const p = item as Record<string, unknown>,
        connection = safeConnection(p.connection);
      return connection &&
        typeof p.id === "string" &&
        typeof p.label === "string"
        ? [{ id: p.id.slice(0, 64), label: p.label.slice(0, 256), connection }]
        : [];
    });
  } catch {
    return [];
  }
}
export function saveConnections(profiles: ConnectionProfile[]): void {
  const safe = profiles.slice(0, 30).flatMap((p) => {
    const connection = safeConnection(p.connection);
    return connection ? [{ id: p.id, label: p.label, connection }] : [];
  });
  try {
    localStorage.setItem(STORAGE, JSON.stringify(safe));
  } catch {
    /* Keep in memory. */
  }
}
export function quoteIdentifier(value: string, engine: EditorEngine): string {
  if (engine === "mysql")
    return (
      String.fromCharCode(96) +
      value.replaceAll(
        String.fromCharCode(96),
        String.fromCharCode(96).repeat(2),
      ) +
      String.fromCharCode(96)
    );
  if (engine === "mssql") return "[" + value.replaceAll("]", "]]") + "]";
  return '"' + value.replaceAll('"', '""') + '"';
}
export function tableQuery(
  engine: EditorEngine,
  schema: string,
  table: string,
  limit: number,
): string {
  const count = Math.max(1, Math.min(5000, Math.floor(limit)));
  const name = [schema, table]
    .filter(Boolean)
    .map((part) => quoteIdentifier(part, engine))
    .join(".");
  return engine === "mssql"
    ? "SELECT TOP (" + count + ") * FROM " + name + ";"
    : "SELECT * FROM " + name + " LIMIT " + count + ";";
}
export function resultCsv(set: QuerySet): string {
  const quote = (value: string | null) =>
    value === null ? "" : '"' + value.replaceAll('"', '""') + '"';
  return (
    "\ufeff" +
    [
      set.columns.map((c) => quote(c.name)).join(","),
      ...set.rows.map((row) => row.map(quote).join(",")),
    ].join("\r\n")
  );
}
export function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const collator = new Intl.Collator(undefined, { numeric: true });
export function compareValues(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const number = /^(-?)(\d+)(?:\.(\d+))?$/;
  const x = number.exec(a),
    y = number.exec(b);
  if (x && y) {
    const ax = x[2].replace(/^0+(?=\d)/, ""),
      by = y[2].replace(/^0+(?=\d)/, "");
    const az = ax === "0" && !(x[3] ?? "").replaceAll("0", ""),
      bz = by === "0" && !(y[3] ?? "").replaceAll("0", "");
    const an = !!x[1] && !az,
      bn = !!y[1] && !bz;
    if (an !== bn) return an ? -1 : 1;
    const size = Math.max((x[3] ?? "").length, (y[3] ?? "").length);
    const result =
      ax.length - by.length ||
      ax.localeCompare(by) ||
      (x[3] ?? "")
        .padEnd(size, "0")
        .localeCompare((y[3] ?? "").padEnd(size, "0"));
    return an ? -result : result;
  }
  return collator.compare(a, b);
}
