const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),ts=require('typescript');
const saved=new Map();
const source=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src/lib/sqlEditor.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText;
const moduleCopy={exports:{}};
vm.runInNewContext(source,{exports:moduleCopy.exports,module:moduleCopy,localStorage:{setItem:(key,value)=>saved.set(key,value),getItem:key=>saved.get(key)??null},require:()=>({})});
const lib=moduleCopy.exports;
test('table browsing quotes identifiers for all three SQL engines',()=>{
 assert.equal(lib.tableQuery('postgres','s"chema','ta"ble',100),'SELECT * FROM "s""chema"."ta""ble" LIMIT 100;');
 const q=String.fromCharCode(96);
 assert.equal(lib.tableQuery('mysql','db','x'+q+'y',10),'SELECT * FROM '+q+'db'+q+'.'+q+'x'+q+q+'y'+q+' LIMIT 10;');
 assert.equal(lib.tableQuery('mssql','dbo','x]y',25),'SELECT TOP (25) * FROM [dbo].[x]]y];');
});
test('saved connections whitelist endpoint metadata and discard passwords',()=>{
 lib.saveConnections([{id:'one',label:'test',connection:{engine:'postgres',host:'localhost',port:5432,user:'test',database:'db',password:'hidden-password',uri:'also-secret',encrypt:true}}]);
 assert.ok(!JSON.stringify([...saved.values()]).includes('hidden-password'));
 assert.ok(!JSON.stringify([...saved.values()]).includes('also-secret'));
 const profile=lib.loadConnections()[0];assert.equal(profile.connection.host,'localhost');assert.equal(profile.connection.password,undefined);
});
test('invalid profile endpoints are discarded',()=>{
 saved.set('data-migrator:sql-connections',JSON.stringify([{id:'a',label:'x',connection:{engine:'postgres',host:'x',port:99999,user:'u',database:'db'}}]));
 assert.equal(lib.loadConnections().length,0);
});
test('result sorting does not round big integers or decimals',()=>{
 assert.ok(lib.compareValues('9007199254740993','9007199254740992')>0);
 assert.ok(lib.compareValues('-100.01','-100.001')<0);
 assert.equal(lib.compareValues('001.20','1.2'),0);
 assert.equal(lib.compareValues('-0','0'),0);
 assert.ok(lib.compareValues(null,'')<0);
});
test('CSV preserves exact values and escapes quotes, newlines and duplicate headers',()=>{
 const csv=lib.resultCsv({columns:[{name:'id'},{name:'id'}],rows:[['9007199254740993','a"b\nc'],[null,'']]});
 assert.equal(csv,'\ufeff"id","id"\r\n"9007199254740993","a""b\nc"\r\n,""');
});

test('editor IDs remain unique without secure-context crypto',()=>{const ids=Array.from({length:100},()=>lib.editorId());assert.equal(new Set(ids).size,100);assert.ok(ids.every(id=>id.startsWith('sql-')));});
