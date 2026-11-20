const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const moduleValue = { exports: {} };
const source = readFileSync(path.join(__dirname, '../src/lib/schemaTree.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
vm.runInNewContext(compiled, { module: moduleValue, exports: moduleValue.exports });
const { createSchemaTree, filterSchemaTree, visibleSchemaNodes, schemaBranchIds } = moduleValue.exports;
const plain = value => JSON.parse(JSON.stringify(value));
const report = () => ({ engine: 'postgres', database: 'active_db', truncated: false, elapsedMs: 1, objects: [
  {schema: 'public', name: 'items', kind: 'table', columns: [{name: 'email_address', dataType: 'text', nullable: true, ordinal: 2}, {name: 'id', dataType: 'bigint', nullable: false, ordinal: 1}]},
  {schema: 'audit', name: 'items', kind: 'table', columns: [{name: 'audit_id', dataType: 'integer', nullable: false, ordinal: 1}]},
  {schema: 'public', name: 'summary', kind: 'view', columns: []},
] });
test('groups identically named tables under their actual schemas with distinct node identities', () => {
  const root = createSchemaTree(report());
  assert.equal(root.name, 'active_db');
  assert.deepEqual(plain(root.children.map(node => node.name)), ['audit', 'public']);
  const left = root.children[0].children[0];
  const right = root.children[1].children[0];
  assert.equal(left.name, right.name);
  assert.notEqual(left.id, right.id);
  const rows = visibleSchemaNodes(root, () => true);
  assert.equal(new Set(rows.map(row => row.node.id)).size, rows.length);
});
test('retains column order, type, nullability and view kind without mutating the response', () => {
  const input = report(); const before = JSON.stringify(input);
  const root = createSchemaTree(input);
  const columns = root.children[1].children[0].children;
  assert.deepEqual(plain(columns.map(node => [node.name, node.dataType, node.nullable])), [['id', 'bigint', false], ['email_address', 'text', true]]);
  assert.equal(root.children[1].children[1].kind, 'view');
  assert.equal(JSON.stringify(input), before);
});
test('a field or data-type search retains its schema and table ancestors', () => {
  const root = createSchemaTree(report());
  const matched = filterSchemaTree(root, 'EMAIL_ADDRESS');
  assert.equal(matched.name, 'active_db');
  assert.deepEqual(plain(matched.children.map(node => node.name)), ['public']);
  assert.deepEqual(plain(matched.children[0].children[0].children.map(node => node.name)), ['email_address']);
  assert.equal(filterSchemaTree(root, 'bigint').children[0].children[0].children[0].name, 'id');
  assert.equal(filterSchemaTree(root, 'missing'), null);
  assert.equal(filterSchemaTree(root, '  '), root);
  assert.equal(root.children[1].children[0].children.length, 2);
});
test('schema and table matches retain all objects/fields inside the matching branch', () => {
  const root = createSchemaTree(report());
  assert.equal(filterSchemaTree(root, 'public').children[0].children.length, 2);
  const tables = filterSchemaTree(root, 'items');
  assert.equal(tables.children.length, 2);
  assert.equal(tables.children[1].children[0].children.length, 2);
});
test('collapsed nodes hide descendants and visible rows retain accessible hierarchy positions', () => {
  const root = createSchemaTree(report());
  assert.equal(visibleSchemaNodes(root, () => false).length, 1);
  const rows = visibleSchemaNodes(root, id => id === root.id);
  assert.deepEqual(plain(rows.map(row => [row.node.name, row.level, row.position, row.siblings])), [['active_db', 1, 1, 1], ['audit', 2, 1, 2], ['public', 2, 2, 2]]);
  assert.equal(rows[1].parentId, root.id);
  assert.equal(visibleSchemaNodes(null, () => true).length, 0);
  assert.equal(schemaBranchIds(root).includes(root.id), true);
});
for (const engine of ['mysql', 'mongo', 'redis']) test(engine + ' uses database objects directly without inventing a SQL schema level', () => {
  const input = { engine, database: 'db', truncated: false, elapsedMs: 1, objects: [{schema: 'db', name: 'entries', kind: engine === 'mongo' ? 'collection' : engine === 'redis' ? 'keys' : 'table', columns: []}] };
  const root = createSchemaTree(input);
  assert.equal(root.children.length, 1);
  assert.notEqual(root.children[0].kind, 'schema');
  assert.equal(root.children[0].children.length, 0);
});
test('quoted, dotted and Unicode identifiers remain intact and cannot collide through concatenation', () => {
  const input = report(); input.objects = [
    {schema: 'a.b', name: 'c', kind: 'table', columns: []},
    {schema: 'a', name: 'b.c', kind: 'table', columns: []},
    {schema: 'public', name: '<unsafe>\"\u5ba2\u6237', kind: 'view', columns: []},
  ];
  const nodes = visibleSchemaNodes(createSchemaTree(input), () => true);
  assert.equal(new Set(nodes.map(row => row.node.id)).size, nodes.length);
  assert.equal(nodes.some(row => row.node.name === '<unsafe>\"\u5ba2\u6237'), true);
});
