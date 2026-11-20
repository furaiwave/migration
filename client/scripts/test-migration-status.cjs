const assert=require('node:assert/strict');
const {test}=require('node:test');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const moduleValue={exports:{}};
const code=ts.transpileModule(readFileSync(path.join(__dirname,'../src/lib/databaseMigration.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
vm.runInNewContext(code,{module:moduleValue,exports:moduleValue.exports});
const {mergeMigrationStatus}=moduleValue.exports;
const running={id:'current',state:'running'};
test('a delayed cancellation reply cannot revive a finished database migration',()=>{
  for(const state of ['done','failed','cancelled']){
    const completed={...running,state};
    assert.equal(mergeMigrationStatus(completed,running),completed);
  }
});
test('responses for a previous migration cannot replace a newer job',()=>{
  assert.equal(mergeMigrationStatus(running,{id:'old',state:'cancelled'}),running);
  assert.equal(mergeMigrationStatus(null,running),null);
  const finished={...running,state:'done'};
  assert.equal(mergeMigrationStatus(running,finished),finished);
});
