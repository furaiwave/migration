const assert = require('node:assert/strict');
const {test} = require('node:test');
const {readFileSync} = require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const KEY='dbf-inspector:native-target';
const server={id:'local-pg',engine:'postgres',label:'PostgreSQL',host:'127.0.0.1',port:5544,source:'process',reachable:true,protocolConfirmed:true};
function environment(saved) {
  const storage=new Map(saved ? [[KEY,JSON.stringify(saved)]] : []);let ref;let cleanup;
  const react={useRef:value=>ref??=( {current:value} ),useEffect:effect=>{if(cleanup)cleanup();cleanup=effect();},useSyncExternalStore:(_,get)=>get()};
  const module={exports:{}};
  const compiled=ts.transpileModule(readFileSync(path.join(__dirname,'../src/lib/nativeTarget.ts'),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(compiled,{module,exports:module.exports,require:id=>{assert.equal(id,'react');return react;},localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}});
  return {store:module.exports,storage};
}
test('refreshing the same endpoint preserves entered credentials',()=>{
  const {store}=environment();const applied=[];
  store.selectNativeServer(server);store.useNativeSelection('postgres',s=>applied.push(s),false);
  store.selectNativeServer({...server,label:'Updated label',source:'service'});
  store.useNativeSelection('postgres',s=>applied.push(s),false);
  assert.equal(applied.length,1);
  store.selectNativeServer({...server,port:5545});assert.equal(applied.length,2);assert.equal(applied[1].port,5545);
});
test('a running import defers endpoint changes until it finishes',()=>{
  const {store}=environment();const applied=[];
  store.selectNativeServer(server);store.useNativeSelection('postgres',s=>applied.push(s),false);
  store.useNativeSelection('postgres',s=>applied.push(s),true);store.selectNativeServer({...server,port:5545});assert.equal(applied.length,1);
  store.useNativeSelection('postgres',s=>applied.push(s),false);assert.equal(applied.length,2);assert.equal(applied[1].port,5545);
});
test('restored profiles discard unknown fields and invalid endpoints',()=>{
  const {store,storage}=environment({active:'postgres',servers:{postgres:{...server,password:'old-secret',uri:'private-uri'},mysql:{...server,engine:'mysql',port:70000}}});
  assert.equal(store.getNativeTarget().servers.postgres.password,undefined);assert.equal(store.getNativeTarget().servers.mysql,undefined);
  store.activateNativeEngine('mssql');assert.equal(storage.get(KEY).includes('old-secret'),false);assert.equal(storage.get(KEY).includes('private-uri'),false);
});
test('invalid selections do not replace a valid future import target',()=>{
  const {store,storage}=environment();store.selectNativeServer({...server,password:'not-persisted'});
  store.selectNativeServer({...server,host:'',port:0});assert.equal(store.getNativeTarget().servers.postgres.port,5544);assert.equal(storage.get(KEY).includes('not-persisted'),false);
});

test('Redis endpoints persist without connection URIs or credentials',()=>{
 const {store,storage}=environment();store.selectNativeServer({...server,id:'redis-local',engine:'redis',port:6379,uri:'redis://user:secret@localhost/0',password:'secret'});
 assert.equal(store.getNativeTarget().active,'redis');assert.equal(store.getNativeTarget().servers.redis.port,6379);assert.equal(storage.get(KEY).includes('secret'),false);assert.equal(storage.get(KEY).includes('redis://'),false);
});
