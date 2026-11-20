const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {installGracefulQuit}=require('../graceful-quit.cjs');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('quit waits for the server rollback and close, including repeated quit attempts',async()=>{
  const app=new EventEmitter();let resolveClose,closeCalls=0,quits=0,prevented=0;
  app.quit=()=>{quits++;app.emit('before-quit',{preventDefault(){prevented++;}});};
  installGracefulQuit(app,()=>{closeCalls++;return new Promise(resolve=>{resolveClose=resolve;});});
  const event={preventDefault(){prevented++;}};
  app.emit('before-quit',event);app.emit('before-quit',event);await tick();
  assert.equal(closeCalls,1);assert.equal(quits,0);assert.equal(prevented,2);
  resolveClose();await tick();assert.equal(quits,1);assert.equal(prevented,2);
});
test('a rejected server shutdown still releases the quit guard',async(t)=>{
  const app=new EventEmitter();let quits=0;
  t.mock.method(console,'error',()=>{});
  app.quit=()=>{quits++;app.emit('before-quit',{preventDefault(){throw new Error('quit guard was not released');}});};
  installGracefulQuit(app,async()=>{throw new Error('driver close failed');});
  app.emit('before-quit',{preventDefault(){}});await tick();assert.equal(quits,1);
});
