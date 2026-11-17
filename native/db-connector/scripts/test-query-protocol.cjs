const assert=require('node:assert/strict');
const net=require('node:net'),path=require('node:path');
const {EventEmitter,once}=require('node:events');
const base=path.resolve(__dirname,'..');
const binary=path.join(base,'target','release',process.platform==='win32'?'db-connector.exe':'db-connector');
process.env.DBF_CONNECTOR_BIN=binary;
process.env.DBF_SESSION_DIR=path.join(base,'../../client/node_modules/.cache/native-query-api');
const {NativeConnectorService}=require(path.join(base,'../../migration-gateway/dist/dbf/native-connector.service.js'));
const i32=value=>{const b=Buffer.alloc(4);b.writeInt32BE(value);return b;};
const i16=value=>{const b=Buffer.alloc(2);b.writeInt16BE(value);return b;};
const str=value=>Buffer.from(value+'\0');
const packet=(type,payload)=>Buffer.concat([Buffer.from(type),i32(payload.length+4),payload]);
const row=values=>packet('D',Buffer.concat([i16(values.length),...values.map(value=>value===null?i32(-1):Buffer.concat([i32(Buffer.byteLength(value)),Buffer.from(value)]))]));
const columns=names=>packet('T',Buffer.concat([i16(names.length),...names.map(name=>Buffer.concat([str(name),i32(0),i16(0),i32(25),i16(-1),i32(-1),i16(0)]))]));
const complete=command=>packet('C',str(command));
const events=new EventEmitter(),sockets=new Set();
const server=net.createServer(socket=>{
 sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>{sockets.delete(socket);events.emit('socketClosed');});
 let data=Buffer.alloc(0),startup=true;
 socket.on('data',chunk=>{
  data=Buffer.concat([data,chunk]);
  while(true){
   if(startup){
    if(data.length<4)return;
    const length=data.readInt32BE(0);if(data.length<length)return;
    const code=data.readInt32BE(4);data=data.subarray(length);
    if(code===80877103){socket.write('N');continue;}
    assert.equal(code,196608);startup=false;
    socket.write(Buffer.concat([packet('R',i32(0)),packet('S',Buffer.concat([str('server_version'),str('16.0')])),packet('S',Buffer.concat([str('client_encoding'),str('UTF8')])),packet('K',Buffer.concat([i32(123),i32(456)])),packet('Z',Buffer.from('I'))]));continue;
   }
   if(data.length<5)return;
   const type=String.fromCharCode(data[0]),length=data.readInt32BE(1);if(data.length<length+1)return;
   const body=data.subarray(5,length+1);data=data.subarray(length+1);
   if(type==='X'){socket.end();continue;}
   assert.equal(type,'Q');
   const sql=body.toString('utf8').replace(/\0$/,'');
   if(sql==='SELECT slow'){events.emit('slowStarted',socket);continue;}
   if(sql==='SELECT error'){
    socket.write(packet('E',Buffer.concat([str('SERROR'),str('C42601'),str('Mprivate error detail must not escape'),str('P8'),Buffer.from([0])])));
   }else if(sql.startsWith('UPDATE')){
    socket.write(complete('UPDATE 3'));
   }else{
    socket.write(columns(['id','nullable','text']));
    const count=sql==='SELECT bounded'?2000:1;
    for(let i=0;i<count;i++)socket.write(row([(9007199254740993n+BigInt(i)).toString(),null,'NULL']));
    socket.write(complete('SELECT '+count));
    if(sql==='SELECT multi; UPDATE t SET a=1')socket.write(complete('UPDATE 2'));
   }
   socket.write(packet('Z',Buffer.from('I')));
  }
 });
});
async function main(){
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const c={engine:'postgres',host:'127.0.0.1',port:server.address().port,user:'test',password:'native-private-password',database:'test',encrypt:false,trustServerCertificate:false};
 const service=new NativeConnectorService();
 let app;
 try{
  const report=await service.query(c,'SELECT bounded',50);
  assert.equal(report.connector,'rust');assert.equal(report.error,null);
  assert.equal(report.sets[0].rows.length,50);assert.equal(report.sets[0].rowCount,2000);
  assert.equal(report.sets[0].rows[0][0],'9007199254740993');
  assert.equal(report.sets[0].rows[0][1],null);assert.equal(report.sets[0].rows[0][2],'NULL');
  assert.equal(report.truncated,true);
  const write=await service.query(c,'UPDATE t SET a=1',100);
  assert.equal(write.sets[0].affectedRows,'3');assert.deepEqual(write.sets[0].columns,[]);
  const multi=await service.query(c,'SELECT multi; UPDATE t SET a=1',100);
  assert.equal(multi.sets.length,2);assert.equal(multi.sets[1].affectedRows,'2');
  const error=await service.query(c,'SELECT error',100);
  assert.equal(error.error.code,'42601');assert.equal(error.error.position,8);
  assert.equal(error.error.message,'SQL syntax error');assert.ok(!JSON.stringify(error).includes('private error detail'));
  const abort=new AbortController(),started=once(events,'slowStarted');
  const pending=service.query(c,'SELECT slow',100,abort.signal);
  const assertion=assert.rejects(pending,/stopped/);
  await started;abort.abort();await assertion;
  const {startServer}=require(path.join(base,'../../migration-gateway/dist/server.js'));
  app=await startServer({host:'127.0.0.1',port:0,origins:[],logger:['error']});
  const url=await app.getUrl();
  const post=(endpoint,body,signal)=>fetch(url+endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal});
  const diagnostic=await post('/dbf/native/diagnose',{host:'127.0.0.1',port:c.port});
  assert.equal(diagnostic.status,200,'non-editor routes keep the default JSON parser');
  assert.equal((await diagnostic.json()).status,'reachable');
  const long=await post('/dbf/native/query',{connection:c,sql:'SELECT 1; -- '+ 'x'.repeat(120000),maxRows:100});
  assert.equal(long.status,200,'the editor accepts SQL bodies larger than the default 100 KB parser limit');
  assert.equal((await long.json()).sets[0].rows[0][0],'9007199254740993');
  const httpAbort=new AbortController(),httpStarted=once(events,'slowStarted');
  const httpPending=post('/dbf/native/query',{connection:c,sql:'SELECT slow',maxRows:100},httpAbort.signal);
  const rejected=assert.rejects(httpPending,error=>error.name==='AbortError');
  const [nativeSocket]=await httpStarted;
  const closed=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('native socket did not close after HTTP abort')),5000);
    nativeSocket.once('close',()=>{clearTimeout(timer);resolve();});
  });
  httpAbort.abort();await rejected;await closed;
  const recovered=await post('/dbf/native/query',{connection:c,sql:'UPDATE t SET a=1',maxRows:100});
  assert.equal((await recovered.json()).sets[0].affectedRows,'3');

  console.log('PASS: real Rust PostgreSQL driver over a local protocol fixture: streamed row limits, exact bigint/nulls, DML counts, multi-results, sanitized SQL errors and abort. Native collection time: '+report.elapsedMs+' ms.');
 }finally{
  if(app)await app.close();
  for(const socket of sockets)socket.destroy();
  await new Promise(resolve=>server.close(resolve));
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
