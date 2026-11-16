const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(path.join(__dirname, '../src/lib/responseBody.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleCopy = { exports: {} };
vm.runInNewContext(compiled, { module: moduleCopy, exports: moduleCopy.exports, require: () => ({ LocalizedError: Error }) });
const { readApiBody } = moduleCopy.exports;
test('reads API JSON and accepts case-insensitive content types', async () => {
 const result = await readApiBody(new Response('{"status":"ok"}', { headers: { 'Content-Type': 'Application/JSON; charset=utf-8' } }), false);
 assert.equal(result.status, 'ok');
});
test('rejects proxy HTML and malformed JSON instead of returning a Blob to components', async () => {
 for (const [body, type] of [['<html>proxy</html>', 'text/html'], ['{broken', 'application/json']]) {
  await assert.rejects(readApiBody(new Response(body, { headers: { 'Content-Type': type } }), false), /API/);
 }
});
test('download routes preserve SQL and JavaScript as files', async () => {
 const result = await readApiBody(new Response('SELECT 1;', { headers: { 'Content-Type': 'text/plain' } }), true);
 assert.equal(await result.text(), 'SELECT 1;');
});
