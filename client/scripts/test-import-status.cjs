const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const compiled = ts.transpileModule(readFileSync(path.join(__dirname, '../src/lib/importStatus.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const moduleCopy = { exports: {} };
vm.runInNewContext(compiled, { module: moduleCopy, exports: moduleCopy.exports });
const { mergeImportStatus } = moduleCopy.exports;
const running = { jobId: 'a', state: 'running', progress: { rowsDone: 1 } };
test('polling advances the active import', () => {
 const next = { ...running, state: 'done' };
 assert.equal(mergeImportStatus(running, next), next);
});
test('delayed cancellation and polling cannot revive a terminal import', () => {
 for (const state of ['done', 'failed', 'cancelled']) {
  const finished = { ...running, state };
  assert.equal(mergeImportStatus(finished, running), finished);
  assert.equal(mergeImportStatus(finished, { ...running, state: 'cancelled' }), finished);
 }
});
test('responses from an earlier run cannot replace a new import', () => {
 const next = { ...running, jobId: 'b' };
 assert.equal(mergeImportStatus(next, running), next);
 assert.equal(mergeImportStatus(null, running), null);
});
