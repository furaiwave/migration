// Integration check against a dedicated Redis instance. Cleans only its random test keys.
const assert=require('node:assert/strict');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {spawn}=require('node:child_process');
const root=process.env.REDIS_TEST_ROOT || path.resolve(__dirname,'..');
const {createClient}=require(path.join(root,'node_modules/redis'));
const {RedisImportService,redisRecord}=require(path.join(root,'dist/dbf/redis-import.service.js'));
const {MysqlExportService}=require(path.join(root,'dist/dbf/mysql-export.service.js'));
const {parseTable}=require(path.join(root,'dist/dbf/dbf-parse.js'));
const uri=process.env.REDIS_TEST_URL;
if(!uri)throw new Error('REDIS_TEST_URL must point to a dedicated Redis test instance.');
const client=createClient({url:uri,socket:{reconnectStrategy:false,connectTimeout:5000}});client.on('error',()=>{});
const prefix='test_'+randomUUID().replaceAll('-','');
const keys=new Set();
const options={prefix,writeMode:'new',keepDeleted:true,ttlSeconds:60};
const dbf=Buffer.alloc(97+4*29+1);dbf[0]=3;dbf[1]=126;dbf[2]=11;dbf[3]=15;
dbf.writeUInt32LE(4,4);dbf.writeUInt16LE(97,8);dbf.writeUInt16LE(29,10);
dbf.write('ID',32,'ascii');dbf[43]=78;dbf[48]=20;
dbf.write('NAME',64,'ascii');dbf[75]=67;dbf[80]=8;dbf[96]=13;
for(const [i,[id,name,deleted]] of [['9007199254740993','Alice',false],['2','Bob',false],['2','Old1',true],['2','Old2',true]].entries()){
 const off=97+i*29;dbf[off]=deleted?42:32;dbf.write(id.padStart(20,' '),off+1,'ascii');dbf.write(name.padEnd(8,' '),off+21,'ascii');
}dbf[dbf.length-1]=26;
const fileName='CLIENTS.dbf';
const parsed={...parseTable(fileName,dbf,null,null,20,null),index:{fileName:'CLIENTS.cdx',tags:[{name:'ID',expression:'ID',filter:null,unique:false,candidate:true,descending:false}],error:null}};
const session={id:randomUUID(),createdAt:new Date(),files:new Map([[fileName,parsed]]),sources:new Map([[fileName,{dbf,memo:null,index:null}]]),manualRels:[],disabledRels:new Set(),encodings:new Map(),previewRows:20};
const service=new RedisImportService(new MysqlExportService());
async function run(next=options){
 const job=await service.startImport(session,[],next,uri);
 for(let i=0;i<200;i++){
  const status=service.getStatus(job.jobId);if(status.state!=='running'){assert.equal(status.state,'done',status.error);return status;}
  await new Promise(resolve=>setTimeout(resolve,25));
 }throw new Error('Redis import timed out');
}
(async()=>{
 await client.connect();
 const prepared=service.prepare(session,[],options);const table=prepared.source.tables[0];assert.equal(prepared.plan.tables[0].keyMode,'primary');
 for(const set of ['live','deleted'])for(const row of table.records(set))keys.add(redisRecord(table,set==='live'?table.name:table.deletedName,prefix,row.values,row.recno).key);
 assert.equal(keys.size,4);
 const sentinel=prefix+':sentinel';keys.add(sentinel);await client.set(sentinel,'untouched');
 let status=await run();assert.equal(status.result.tables.reduce((n,t)=>n+t.importedRows,0),4);
 const first=keys.values().next().value;
 assert.equal(JSON.parse(await client.hGet(first,'id')),'9007199254740993');assert.equal(JSON.parse(await client.hGet(first,'name')),'Alice');
 assert.ok(await client.ttl(first)>0);
 status=await run();assert.equal(status.result.tables.reduce((n,t)=>n+t.skippedRows,0),4);
 await client.hSet(first,{extra:'preserved',name:'"changed"'});
 await run({...options,writeMode:'update',ttlSeconds:0});
 assert.equal(await client.hGet(first,'extra'),'preserved');assert.equal(JSON.parse(await client.hGet(first,'name')),'Alice');assert.equal(await client.ttl(first),-1);
 await client.del(first);await client.set(first,'another-type');
 status=await run();assert.equal(status.result.tables.reduce((n,t)=>n+t.skippedRows,0),4);assert.equal(await client.get(first),'another-type');
 const failed=await service.startImport(session,[],{...options,writeMode:'update'},uri);
 for(let i=0;i<200 && service.getStatus(failed.jobId).state==='running';i++)await new Promise(resolve=>setTimeout(resolve,25));
 assert.equal(service.getStatus(failed.jobId).state,'failed');assert.equal(await client.get(first),'another-type');assert.equal(await client.get(sentinel),'untouched');
 if(process.env.DBF_CONNECTOR_BIN){
  const output=await new Promise((resolve,reject)=>{
   const proc=spawn(process.env.DBF_CONNECTOR_BIN,[],{windowsHide:true,stdio:['pipe','pipe','ignore']});let text='';
   const timer=setTimeout(()=>{proc.kill();reject(new Error('Native Redis check timed out'));},20000);
   proc.stdout.on('data',chunk=>{text+=chunk;});proc.on('error',reject);proc.on('close',()=>{clearTimeout(timer);resolve(text);});
   proc.stdin.end(JSON.stringify({command:'test',connection:{engine:'redis',uri}}));
  });const native=JSON.parse(output);assert.equal(native.ok,true);assert.match(native.result.serverVersion,/Redis/);
 }
 console.log('PASS: real Redis hashes, exact values, duplicate skip, TTL, preserved fields, deleted records, protected key types and native authentication.');
})().catch(err=>{console.error(err);process.exitCode=1;}).finally(async()=>{if(client.isOpen){for(const key of keys)await client.del(key);client.destroy();}});
