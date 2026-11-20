const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const KEY = 'dbf-inspector:file-import-jobs';
function environment(initial, blocked = false) {
  const storage = new Map(initial === undefined ? [] : [[KEY, JSON.stringify(initial)]]);
  const module = {exports:{}};
  const compiled = ts.transpileModule(readFileSync(path.join(__dirname, '../src/lib/fileImportJobs.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(compiled, {module, exports:module.exports, localStorage:{
    getItem(key) {if(blocked)throw new Error('Storage blocked');return storage.get(key) ?? null;},
    setItem(key, value) {if(blocked)throw new Error('Storage blocked');storage.set(key,value);},
  }});
  return {store:module.exports, storage};
}
test('job persistence contains only IDs and engine, never connection data or server payloads', () => {
  const {store, storage} = environment();
  const status = {jobId:'job-1',state:'running',database:'private-db',password:'secret',uri:'mongodb://user:secret@localhost',progress:{rowsDone:0}};
  assert.equal(store.trackStartedFileImport('session-1','mongo',status), status);
  assert.deepEqual(JSON.parse(storage.get(KEY)), [{sessionId:'session-1',engine:'mongo',jobId:'job-1'}]);
});
test('jobs are isolated by session and engine and the most recent job wins', () => {
  const {store} = environment();
  for(const [session,engine,id] of [['one','mysql','old'],['one','redis','redis-1'],['two','mysql','other'],['one','mysql','new']])
    store.trackStartedFileImport(session,engine,{jobId:id,state:'running'});
  assert.equal(store.savedFileImportJob('one','mysql'),'new');
  assert.equal(store.savedFileImportJob('one','redis'),'redis-1');
  assert.equal(store.savedFileImportJob('two','mysql'),'other');
  assert.equal(store.savedFileImportJob('two','redis'),null);
  assert.deepEqual(Array.from(store.fileImportEngines('one')),['redis','mysql']);
});
test('late completion of an older job cannot forget its replacement or another session', () => {
  const {store} = environment();
  store.trackStartedFileImport('one','mysql',{jobId:'old',state:'running'});
  store.trackStartedFileImport('one','mysql',{jobId:'new',state:'running'});
  store.trackStartedFileImport('two','mysql',{jobId:'new',state:'running'});
  store.forgetFileImportJob('one','mysql','old');
  assert.equal(store.savedFileImportJob('one','mysql'),'new');
  store.forgetFileImportJob('one','mysql','new');
  assert.equal(store.savedFileImportJob('one','mysql'),null);
  assert.equal(store.savedFileImportJob('two','mysql'),'new');
});
test('invalid stored references cannot become status request paths', () => {
  const valid = {sessionId:'safe-session',engine:'mysql',jobId:'safe-job'};
  const {store,storage} = environment([null,[],{}, {...valid,engine:'unknown'}, {...valid,jobId:'../session/private'}, {...valid,sessionId:'https://private'}, {...valid,jobId:'x'.repeat(129)},valid]);
  assert.equal(store.savedFileImportJob('safe-session','mysql'),'safe-job');
  assert.deepEqual(Array.from(store.fileImportEngines('safe-session')),['mysql']);
  storage.set(KEY,'invalid JSON');assert.equal(store.savedFileImportJob('safe-session','mysql'),null);
  storage.set(KEY,JSON.stringify({jobs:[valid]}));assert.equal(store.savedFileImportJob('safe-session','mysql'),null);
});
test('completed and invalid start responses create no resumable job', () => {
  const {store,storage} = environment();
  store.trackStartedFileImport('one','mysql',{jobId:'done',state:'done'});
  store.trackStartedFileImport('one','mysql',{jobId:'../unsafe',state:'running'});
  store.trackStartedFileImport('bad/session','mysql',{jobId:'job',state:'running'});
  assert.equal(storage.size,0);
});
test('blocked browser storage never prevents an in-memory import', () => {
  const {store} = environment(undefined,true);
  const status={jobId:'job',state:'running'};
  assert.equal(store.trackStartedFileImport('session','mysql',status),status);
  assert.equal(store.savedFileImportJob('session','mysql'),null);
  assert.doesNotThrow(()=>store.forgetFileImportJob('session','mysql','job'));
});
test('abandoned sessions cannot grow persisted history without a bound', () => {
  const {store,storage} = environment();
  for(let i=0;i<50;i++)store.trackStartedFileImport('session-'+i,'mysql',{jobId:'job-'+i,state:'running'});
  assert.equal(JSON.parse(storage.get(KEY)).length,30);
  assert.equal(store.savedFileImportJob('session-0','mysql'),null);
  assert.equal(store.savedFileImportJob('session-49','mysql'),'job-49');
});
