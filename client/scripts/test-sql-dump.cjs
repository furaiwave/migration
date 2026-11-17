const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(path.join(__dirname, '../src/lib/sqlDump.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
const copy = { exports: {} };
vm.runInNewContext(compiled, { module: copy, exports: copy.exports });
const parse = sql => JSON.parse(JSON.stringify(copy.exports.parseSqlDump(sql)));

test('MySQL quoted identifiers, decimal types and composite keys', () => {
  const s = parse('CREATE TABLE '+ String.fromCharCode(96) +'parent'+ String.fromCharCode(96) +' (a int, b int, PRIMARY KEY (a,b)); CREATE TABLE child (id int PRIMARY KEY, a int, b int, price decimal(10,2), CONSTRAINT fk FOREIGN KEY (a,b) REFERENCES parent(a,b));');
  assert.equal(s.tables.length, 2);
  assert.equal(s.tables[1].columns[3].type, 'decimal ( 10 , 2 )');
  assert.deepEqual(s.tables[0].columns.map(c => c.primary), [true,true]);
  assert.deepEqual(s.links, [{from:'child', columns:['a','b'], to:'parent', references:['a','b']}]);
});
test('pg_dump ALTER TABLE ONLY resolves public and omitted referenced keys', () => {
  const s = parse('CREATE TABLE public.parent (id integer); CREATE TABLE public.child (p integer); ALTER TABLE ONLY public.parent ADD CONSTRAINT pk PRIMARY KEY (id); ALTER TABLE ONLY public.child ADD CONSTRAINT fk FOREIGN KEY (p) REFERENCES parent;');
  assert.equal(s.links[0].to, 'public.parent');
  assert.deepEqual(s.links[0].references, ['id']);
});
test('SQLite inline foreign keys and self references', () => {
  const s = parse('CREATE TABLE IF NOT EXISTS "node" ("id" INTEGER PRIMARY KEY, parent INTEGER REFERENCES "node");');
  assert.deepEqual(s.links, [{ from:'node', columns:['parent'], to:'node', references:['id'] }]);
});
test('comments, string literals, function bodies and COPY rows cannot create tables', () => {
  const s = parse("-- CREATE TABLE fake (id int);\n/* CREATE TABLE fake2 (id int); */\nCREATE FUNCTION f() RETURNS void AS $body$ CREATE TABLE fake3(id int); $body$ LANGUAGE sql;\nCREATE TABLE real (id int, value text DEFAULT 'a; CREATE TABLE fake4 (id int);');\nCOPY real FROM stdin;\n1\tvalue; CREATE TABLE fake5 (id int);\n\\.\nCREATE TABLE after_copy (id int);");
  assert.deepEqual(s.tables.map(t => t.name), ['real','after_copy']);
});
test('unresolved references are preserved and multiple ALTER additions work', () => {
  const s = parse('CREATE TABLE c (x int, y int); ALTER TABLE c ADD CONSTRAINT a FOREIGN KEY (x) REFERENCES missing(id), ADD CONSTRAINT b FOREIGN KEY (y) REFERENCES other(id);');
  assert.equal(s.links.length, 2);
  assert.equal(s.links[0].to, 'missing');
});
test('binary dumps and data-only SQL give useful errors', () => {
  for (const sql of ['PGDMPbinary','SQLite format 3\0','INSERT INTO t VALUES(1);']) assert.throws(() => parse(sql), /plain-text SQL|CREATE TABLE/);
});
test('quoted SQL keywords remain identifiers', () => {
  const s = parse('CREATE TABLE "references" ("primary" int, "foreign" int, ")" text, "," text);');
  assert.equal(s.tables[0].columns.length, 4);
  assert.equal(s.links.length, 0);
});

test('implicit references preserve the declared composite primary key order', () => {
  const s = parse('CREATE TABLE parent (a int, b int, PRIMARY KEY (b,a)); CREATE TABLE child (x int, y int, FOREIGN KEY (x,y) REFERENCES parent);');
  assert.deepEqual(s.links[0].references, ['b','a']);
});
test('MySQL accepts an index name between FOREIGN KEY and its column list', () => {
  const s = parse('CREATE TABLE parent (id int PRIMARY KEY); CREATE TABLE child (p int, FOREIGN KEY parent_idx (p) REFERENCES parent(id));');
  assert.equal(s.links.length, 1);
  assert.deepEqual(s.links[0].columns, ['p']);
});
test('quoted punctuation in identifiers is not treated as SQL syntax', () => {
  const s = parse('CREATE TABLE "parent.dot" (")" int, "," int, PRIMARY KEY (")",",")); CREATE TABLE child ("." int, ")" int, FOREIGN KEY (".",")") REFERENCES "parent.dot" (")",","));');
  assert.deepEqual(s.links[0].references, [')',',']);
  assert.deepEqual(s.links[0].columns, ['.',')']);
  assert.deepEqual(s.tables[0].columns.map(c => c.primary), [true,true]);
});
test('PostgreSQL array types do not consume following statements', () => {
  const s = parse('CREATE TABLE parent (id integer PRIMARY KEY, tags text[], matrix integer[][]); CREATE TABLE child (p integer REFERENCES parent(id));');
  assert.equal(s.tables.length, 2);
  assert.equal(s.tables[0].columns[1].type, 'text[]');
  assert.equal(s.tables[0].columns[2].type, 'integer[][]');
});
test('dump client commands do not swallow the first table', () => {
  const s = parse('\\restrict test-token\nCREATE TABLE parent(id int PRIMARY KEY);\n\\unrestrict test-token\n');
  assert.equal(s.tables[0].name, 'parent');
});
test('schema references do not cross-link similarly named tables', () => {
  const s = parse('CREATE TABLE one.parent (id int PRIMARY KEY); CREATE TABLE two.parent (id int PRIMARY KEY); SET search_path = two, public; CREATE TABLE two.child (p int REFERENCES parent(id));');
  assert.equal(s.links[0].to, 'two.parent');
});
test('quoted dotted names stay distinct from qualified names', () => {
  const s = parse('CREATE TABLE "a.b"(id int PRIMARY KEY); CREATE TABLE a.b(id int PRIMARY KEY); CREATE TABLE child(x int REFERENCES "a.b"(id));');
  assert.equal(s.tables.length, 3);
  assert.notEqual(s.tables[0].name, s.tables[1].name);
  assert.equal(s.links[0].to, s.tables[0].name);
});
test('index sort directions are not mistaken for primary key columns', () => {
  const s = parse('CREATE TABLE parent(a int, b int, PRIMARY KEY(b DESC,a ASC)); CREATE TABLE child(x int,y int, FOREIGN KEY(x,y) REFERENCES parent);');
  assert.deepEqual(s.links[0].references, ['b','a']);
});
test('truncated schema files fail instead of showing a successful partial schema', () => {
  for (const tail of ['CREATE TABLE broken (id int;', "CREATE TABLE broken (value text DEFAULT 'unfinished", '/* unfinished', 'CREATE TABLE broken ("unfinished']) {
    assert.throws(() => parse('CREATE TABLE good (id int); ' + tail), /incomplete|unterminated|Unexpected end/i);
  }
});
test('SQLite single-quoted identifiers remain usable', () => {
  const s = parse("CREATE TABLE 'parent' ('id' integer PRIMARY KEY); CREATE TABLE 'child' ('p' int REFERENCES 'parent'('id'));");
  assert.deepEqual(s.tables.map(t => t.name), ['parent','child']);
  assert.equal(s.links[0].to, 'parent');
  assert.deepEqual(s.links[0].references, ['id']);
});

test('a quoted search_path list resolves the first available schema', () => {
  const s = parse('CREATE TABLE fallback.parent(id int PRIMARY KEY); SET search_path = \'missing, fallback\'; CREATE TABLE child(p int REFERENCES parent(id));');
  assert.equal(s.tables[1].name, 'missing.child');
  assert.equal(s.links[0].to, 'fallback.parent');
});
test('search_path does not fall back to public when public is excluded', () => {
  const s = parse('CREATE TABLE public.parent(id int PRIMARY KEY); SET search_path = custom; CREATE TABLE child(p int REFERENCES parent(id));');
  assert.notEqual(s.links[0].to, 'public.parent');
  assert.deepEqual(s.links[0].references, ['id']);
});
test('MySQL custom delimiters do not expose procedure bodies as top-level tables', () => {
  const s = parse('DELIMITER $$\nCREATE PROCEDURE example() BEGIN SELECT 1; CREATE TABLE internal_only(x int); END$$\nDELIMITER ;\nCREATE TABLE visible(id int PRIMARY KEY);');
  assert.deepEqual(s.tables.map(t => t.name), ['visible']);
});
test('PostgreSQL standard strings may end with a backslash', () => {
  const s = parse("SET standard_conforming_strings = on; CREATE TABLE parent(path text DEFAULT 'C:\\'); CREATE TABLE child(id int);");
  assert.equal(s.tables.length, 2);
});
test('enum labels remain intact in the field type display', () => {
  const s = parse("CREATE TABLE things(state enum('new','done') NOT NULL);");
  assert.ok(s.tables[0].columns[0].type.includes("'new'"));
  assert.ok(s.tables[0].columns[0].type.includes("'done'"));
});
test('COPY blocks without an end marker are reported as incomplete', () => {
  assert.throws(() => parse('CREATE TABLE t(id int); COPY t FROM STDIN;\n1\n'), /incomplete/i);
});

async function readInWorker(file) {
  const workerSource = readFileSync(path.join(__dirname, '../src/lib/sqlDump.worker.ts'), 'utf8');
  const compiledWorker = ts.transpileModule(workerSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  let result;
  const self = { postMessage: value => { result = JSON.parse(JSON.stringify(value)); } };
  vm.runInNewContext(compiledWorker, { exports: {}, require: () => copy.exports, self, TextDecoder });
  await self.onmessage({ data: file });
  return result;
}
test('worker rejects invalid UTF-8 instead of replacing characters in names', async () => {
  const result = await readInWorker(new File([new Uint8Array([0xc3, 0x28])], 'broken.sql'));
  assert.match(result.error, /not valid UTF-8/);
  assert.equal(result.schema, undefined);
});
test('worker reads Unicode identifiers and a UTF-8 BOM without corruption', async () => {
  const result = await readInWorker(new File(['\ufeffCREATE TABLE "\u0442\u0430\u0431\u043b\u0438\u0446\u044f" ("\u043a\u043e\u0434" int PRIMARY KEY);'], 'unicode.sql'));
  assert.equal(result.schema.tables[0].name, '\u0442\u0430\u0431\u043b\u0438\u0446\u044f');
  assert.equal(result.schema.tables[0].columns[0].name, '\u043a\u043e\u0434');
});
test('worker enforces the upload size limit before reading the file', async () => {
  const result = await readInWorker({ size: 50 * 1024 * 1024 + 1, arrayBuffer: () => { throw new Error('must not read'); } });
  assert.match(result.error, /50 MB/);
});

test('unreserved key and index column names are not discarded as constraints', () => {
  const s = parse('CREATE TABLE settings(key text PRIMARY KEY, index integer, value text);');
  assert.deepEqual(s.tables[0].columns.map(column => column.name), ['key','index','value']);
  assert.equal(s.tables[0].columns[0].primary, true);
});

test('ALTER TABLE ADD COLUMN preserves inline keys and field definitions', () => {
  const s = parse('CREATE TABLE parent(id int PRIMARY KEY); CREATE TABLE child(id int); ALTER TABLE child ADD COLUMN parent_id integer REFERENCES parent(id);');
  assert.deepEqual(s.tables[1].columns.map(column => column.name), ['id','parent_id']);
  assert.equal(s.tables[1].columns[1].type, 'integer');
  assert.deepEqual(s.links[0], { from:'child', columns:['parent_id'], to:'parent', references:['id'] });
});
test('CREATE TABLE IF NOT EXISTS cannot replace an existing schema or add ghost constraints', () => {
  const s = parse('CREATE TABLE parent(id int PRIMARY KEY); CREATE TABLE IF NOT EXISTS parent(other text REFERENCES missing(id));');
  assert.deepEqual(s.tables[0].columns.map(column => column.name), ['id']);
  assert.equal(s.tables[0].columns[0].primary, true);
  assert.deepEqual(s.links, []);
});
test('DROP and recreate remove keys belonging to the previous table', () => {
  const s = parse('CREATE TABLE parent(id int PRIMARY KEY); CREATE TABLE child(p int REFERENCES parent(id)); DROP TABLE IF EXISTS child; CREATE TABLE child(fresh text);');
  assert.deepEqual(s.tables[1].columns.map(column => column.name), ['fresh']);
  assert.deepEqual(s.links, []);
});
test('pg_dump set_config changes the schema used by subsequent statements', () => {
  const s = parse("SET search_path = old; SELECT pg_catalog.set_config('search_path','new',false); CREATE TABLE parent(id int PRIMARY KEY); CREATE TABLE child(p int REFERENCES parent);");
  assert.deepEqual(s.tables.map(table => table.name), ['new.parent','new.child']);
  assert.equal(s.links[0].to, 'new.parent');
  assert.deepEqual(s.links[0].references, ['id']);
});
test('MySQL executable comments and NO_BACKSLASH_ESCAPES are respected', () => {
  const q = String.fromCharCode(96);
  const sql = "-- MySQL dump\n/*!40101 SET sql_mode = 'NO_BACKSLASH_ESCAPES' */;\nCREATE TABLE " + q + "paths" + q + " (path text DEFAULT 'C:\\'); CREATE TABLE child(id int);";
  const s = parse(sql);
  assert.deepEqual(s.tables.map(table => table.name), ['paths','child']);
});
test('PostgreSQL folds unquoted names without merging quoted mixed-case names', () => {
  const s = parse('-- PostgreSQL database dump\nCREATE TABLE PARENT(ID int PRIMARY KEY); CREATE TABLE "Parent"("ID" int PRIMARY KEY); CREATE TABLE CHILD(P int REFERENCES parent(id));');
  assert.deepEqual(s.tables.map(table => table.name), ['parent','Parent','child']);
  assert.deepEqual(s.links[0], { from:'child', columns:['p'], to:'parent', references:['id'] });
});
test('SQLite resolves quoted table and column names without case sensitivity', () => {
  const s = parse('PRAGMA foreign_keys=OFF; CREATE TABLE "Parent"("ID" integer, PRIMARY KEY("id")); CREATE TABLE "Child"("P" integer, FOREIGN KEY("p") REFERENCES "parent"("id"));');
  assert.equal(s.tables[0].columns[0].primary, true);
  assert.deepEqual(s.links[0], { from:'Child', columns:['P'], to:'Parent', references:['ID'] });
});
test('unresolved references cannot masquerade as an existing same-named table in another schema', () => {
  const s = parse('CREATE TABLE parent(id int PRIMARY KEY); SET search_path = custom; CREATE TABLE child(p int REFERENCES parent);');
  assert.equal(s.links[0].toMissing, true);
  assert.deepEqual(s.links[0].references, []);
});
test('compressed files are identified before UTF-8 decoding', async () => {
  const result = await readInWorker(new File([new Uint8Array([0x1f,0x8b,0x08,0,0,0,0,0])], 'schema.sql.gz'));
  assert.match(result.error, /Binary and compressed/);
});

test('PostgreSQL quoted mixed-case targets do not match unquoted references', () => {
  const s = parse('-- PostgreSQL database dump\nCREATE TABLE "Parent"("ID" int PRIMARY KEY); CREATE TABLE child(p int REFERENCES parent);');
  assert.equal(s.links[0].toMissing, true);
  assert.deepEqual(s.links[0].references, []);
});
test('MySQL preserves case-sensitive table names and resolves column casing', () => {
  const s = parse('-- MySQL dump\nCREATE TABLE Parent(ID int PRIMARY KEY); CREATE TABLE child(P int, FOREIGN KEY(p) REFERENCES Parent(id));');
  assert.deepEqual(s.links[0], {from:'child', columns:['P'], to:'Parent', references:['ID']});
});
test('MySQL double-quoted strings honor backslash escaping', () => {
  const s = parse('-- MySQL dump\nCREATE TABLE paths(v text DEFAULT "a\\"b"); CREATE TABLE after_paths(id int);');
  assert.equal(s.tables.length, 2);
});
test('ANSI_QUOTES treats double-quoted MySQL names as identifiers', () => {
  const s = parse("-- MySQL dump\nSET sql_mode='ANSI_QUOTES,NO_BACKSLASH_ESCAPES'; CREATE TABLE \"Parent\"(id int PRIMARY KEY, v text DEFAULT 'C:\\'); CREATE TABLE child(p int REFERENCES \"Parent\"(id));");
  assert.equal(s.links[0].to, 'Parent');
  assert.equal(s.links[0].toMissing, undefined);
});
test('PostgreSQL hash operators are not MySQL line comments', () => {
  const s = parse('CREATE TABLE bits(v int DEFAULT (1 # 2), other int); CREATE TABLE after_bits(id int);');
  assert.equal(s.tables.length, 2);
  assert.equal(s.tables[0].columns.length, 2);
});
test('MySQL adjacent minus operators do not comment out following DDL', () => {
  const s = parse('-- MySQL dump\nCREATE TABLE numbers(v int); INSERT INTO numbers VALUES(1--2); CREATE TABLE after_numbers(id int);');
  assert.equal(s.tables.length, 2);
});
test('ADD COLUMN IF NOT EXISTS keeps existing columns and constraints unchanged', () => {
  const s = parse('CREATE TABLE t(id int PRIMARY KEY); ALTER TABLE t ADD COLUMN IF NOT EXISTS id int REFERENCES missing(id);');
  assert.equal(s.tables[0].columns.length, 1);
  assert.deepEqual(s.links, []);
});
test('DROP CASCADE removes incoming constraints and an empty final schema is valid', () => {
  const s = parse('CREATE TABLE parent(id int PRIMARY KEY); CREATE TABLE child(p int REFERENCES parent); DROP TABLE parent CASCADE;');
  assert.deepEqual(s.tables.map(table => table.name), ['child']);
  assert.deepEqual(s.links, []);
  const empty = parse('CREATE TABLE t(id int); DROP TABLE t;');
  assert.deepEqual(empty, {tables:[], links:[]});
});
test('worker accepts an explicit format for SQL without dump headers', async () => {
  const sql = 'CREATE TABLE "Parent"("ID" int PRIMARY KEY); CREATE TABLE child(p int REFERENCES "parent"("id"));';
  const pg = await readInWorker({ file: new File([sql], 'schema.sql'), dialect: 'postgres' });
  const sqlite = await readInWorker({ file: new File([sql], 'schema.sql'), dialect: 'sqlite' });
  assert.equal(pg.schema.links[0].toMissing, true);
  assert.equal(sqlite.schema.links[0].to, 'Parent');
  assert.equal(sqlite.schema.links[0].toMissing, undefined);
  assert.deepEqual(sqlite.schema.links[0].references, ['ID']);
});
