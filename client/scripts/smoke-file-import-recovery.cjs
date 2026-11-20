const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname,'..');
const dist = path.join(root,'dist');
const cache = path.join(root,'node_modules','.cache');
const executable = process.env.I18N_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if(!fs.existsSync(executable))throw new Error('Set I18N_TEST_BROWSER to a Chromium browser executable');
fs.mkdirSync(cache,{recursive:true});
const profile = fs.mkdtempSync(path.join(cache,'file-import-recovery-browser-'));
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const KEY = 'dbf-inspector:file-import-jobs';
const sessionId = 'resume-session';
const graph = {relationships:[],stats:{autoName:0,autoFk:0,manual:0,total:0,disabled:0}};
const session = {sessionId, graph, files:[{fileName:'CLIENTS.DBF',fieldsNames:['ID'],totalRecords:2,encoding:'utf-8',encodingSource:'manual',memoFile:null,index:null,
  header:{typeByte:3,typeName:'dBASE III',hasMemo:false,lastUpdate:{year:2026,month:11,day:20},recordCount:2,firstRecordOffset:65,recordLength:7,
    tableFlags:{hasStructuralCdx:false,hasMemoField:false,isDatabase:false},codePage:0,fields:[{name:'ID',type:'C',length:6,decimalCount:0,offset:1}]},preview:[{ID:'001'}]}]};
const finished = new Set();
const missing = new Set();
const transient = new Map();
const polls = new Map();
let starts = 0;
let allowStart = false;
let stops = 0;
let migrationPolls = 0;
const errors = [];
let browser, socket, send;
function status(engine, state) {
  const done = state !== 'running';
  const progress = {phase:engine==='mongo'?'collections':'tables',table:'clients',tableIndex:1,tableCount:1,tableRowsDone:done?2:1,tableRows:2,rowsDone:done?2:1,rowsTotal:2,foreignKeysDone:0,foreignKeysTotal:0,elapsedMs:10,
    collection:'clients',collectionIndex:1,collectionCount:1,collectionRowsDone:done?2:1,collectionRows:2,indexesDone:0,indexesTotal:0};
  const row = {fileName:'CLIENTS.DBF',table:'clients',collection:'clients',role:'table',expectedRows:2,importedRows:2,skippedRows:0};
  return {jobId:'resume-'+engine,state,database:'restored_database',progress,
    ...(state==='done'?{result:{database:'restored_database',serverVersion:'test',durationMs:20,writeMode:'append',syncDeletes:false,tables:[row],collections:[row],foreignKeysCreated:0,indexesCreated:0,warnings:[]}}:{})};
}
const server = http.createServer((req,res)=>{
  const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  let file = path.resolve(dist,'.'+pathname);
  if(file!==dist && !file.startsWith(dist+path.sep)){res.writeHead(403);res.end();return;}
  if(!fs.existsSync(file)||fs.statSync(file).isDirectory())file=path.join(dist,'index.html');
  res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function main() {
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const url='http://127.0.0.1:'+server.address().port;
    browser=spawn(executable,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'],{windowsHide:true,stdio:'ignore'});
    const portFile=path.join(profile,'DevToolsActivePort');
    for(let i=0;!fs.existsSync(portFile)&&i<100;i++)await sleep(100);
    if(!fs.existsSync(portFile))throw new Error('Browser did not start');
    const port=fs.readFileSync(portFile,'utf8').split('\n')[0];
    const pages=await(await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket=new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    let sequence=0;
    const pending=new Map();
    send=(method,params={})=>new Promise((resolve,reject)=>{
      const id=++sequence;
      const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);
      pending.set(id,{resolve,reject,timeout});socket.send(JSON.stringify({id,method,params}));
    });
    const fulfill=(requestId,data,responseCode=200)=>send('Fetch.fulfillRequest',{requestId,responseCode,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'*'},{name:'Access-Control-Allow-Methods',value:'GET,POST,PATCH,DELETE,OPTIONS'}],body:Buffer.from(JSON.stringify(data)).toString('base64')});
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.id){const task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timeout);if(message.error)task.reject(new Error(JSON.stringify(message.error)));else task.resolve(message.result);return;}
      if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      if(message.method!=='Fetch.requestPaused')return;
      const {requestId,request}=message.params;
      const route=new URL(request.url).pathname;
      const match=/^\/dbf\/(?:(?:sql\/(postgres|mssql))|(mysql|mongo|redis))\/import\/([^/]+)$/.exec(route);
      let data=session,code=200;
      if(request.method==='OPTIONS')data={};
      else if(match){
        const engine=match[1]||match[2];
        if(request.method==='DELETE'){stops++;finished.add(engine);data=status(engine,'cancelled');}
        else {
          polls.set(engine,(polls.get(engine)||0)+1);
          if(missing.has(engine)){code=404;data={message:'Import not found'};}
          else if(transient.get(engine)>0){transient.set(engine,transient.get(engine)-1);code=503;data={message:'Temporary status outage'};}
          else data=status(engine,finished.has(engine)?'done':'running');
        }
      }
      else if(request.method==='POST'&&/\/import$/.test(route)){starts++;if(allowStart){data=status('mysql','running');code=202;}else{code=500;data={message:'Unexpected repeated import'};}}
      else if(route.includes('/mysql/plan'))data={database:null,tables:[],foreignKeys:[],warnings:[],quality:[]};
      else if(route.includes('/mongo/plan'))data={database:null,collections:[],references:[],warnings:[],quality:[]};
      else if(route.includes('/sql/')&&route.endsWith('/plan'))data={database:'',tables:[],foreignKeys:[],warnings:[],quality:[]};
      else if(route.includes('/redis/plan'))data={prefix:'data',tables:[{fileName:'CLIENTS.DBF',table:'clients',deletedTable:null,rowCount:2,deletedRows:0,keyMode:'record',columns:[{name:'id',kind:'text'}]}],warnings:[],quality:[]};
      else if(route.includes('/migration/jobs/')){migrationPolls++;data={id:'completed-database-job',state:'done',phase:'finished',read:1,written:1,skipped:0,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),warnings:[]};}
      else if(route.includes('/native/'))data={servers:[],databases:[],schemas:[],warnings:[]};
      void fulfill(requestId,data,code).catch(error=>errors.push(error.message));
    });
    const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const waitFor=async(expression,attempts=140)=>{for(let i=0;i<attempts;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error('Timed out: '+expression+'\n'+await evaluate('document.body.innerText'));};
    const resetButton="Array.from(document.querySelectorAll('header button')).find(b=>b.textContent.trim()==='New session')";
    const stopButtons="Array.from(document.querySelectorAll('#transfer button')).filter(b=>b.textContent.trim()==='Stop')";
    await send('Runtime.enable');await send('Page.enable');
    await send('Fetch.enable',{patterns:[{urlPattern:'http://127.0.0.1:*/dbf/*',requestStage:'Request'}]});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    let navigation=0;
    const open=async(refs,oldDatabaseJob=false)=>{
      const source="localStorage.clear();localStorage.setItem('dbf-inspector:language:v2','en');localStorage.setItem('dbf-inspector:last-session','resume-session');localStorage.setItem('dbf-inspector:export-target','redis');localStorage.setItem('dbf-inspector:native-target',JSON.stringify({active:'redis',servers:{}}));localStorage.setItem("+JSON.stringify(KEY)+","+JSON.stringify(JSON.stringify(refs))+");"+(oldDatabaseJob?"localStorage.setItem('dbf-inspector:database-migration-job','completed-database-job');":"");
      const added=await send('Page.addScriptToEvaluateOnNewDocument',{source});
      await send('Page.navigate',{url:url+'/?case='+(++navigation)});
      await waitFor("document.querySelector('#transfer') !== null");
      await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:added.identifier});
    };
    const reference=engine=>({sessionId,engine,jobId:'resume-'+engine});
    for(const engine of ['mysql','mongo','postgres','mssql','redis']){
      finished.delete(engine);missing.delete(engine);
      if(engine==='mongo')transient.set(engine,1);
      const before=polls.get(engine)||0;
      const beforeMigration=migrationPolls;
      await open([reference(engine)],engine==='postgres');
      await waitFor(resetButton+'?.disabled === true');
      assert.equal(await evaluate("document.querySelector('#transfer .workspace-target-heading select').value"),engine,'active job overrides an old native target');
      assert.equal(await evaluate("document.querySelector('[data-workspace-link][aria-current=page]').dataset.workspaceLink"),'files','restored file job remains visible');
      if(engine==='mongo'){
        await waitFor("document.querySelector('#transfer [role=alert]')?.textContent.includes('Temporary status outage')");
        assert.equal(await evaluate(resetButton+'.disabled'),true,'status outage cannot unlock another import');
      }
      await waitFor(stopButtons+'.length === 1');
      assert.ok((polls.get(engine)||0)>before,'restore fetches the existing job');
      if(engine==='postgres')assert.equal(migrationPolls,beforeMigration,'an old database job cannot hide the restored file job');
      const beforeReload=polls.get(engine);
      await send('Page.reload');
      await waitFor(stopButtons+'.length === 1');
      await waitFor(resetButton+'?.disabled === true');
      assert.ok(polls.get(engine)>beforeReload,'reload reconnects to the running job');
      assert.equal(await evaluate("Array.from(document.querySelectorAll('input[type=password]')).every(input=>!input.value.includes('browser-secret'))"),true);
      assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem('+JSON.stringify(KEY)+'))'),[reference(engine)]);
      assert.equal(starts,0,'recovery never starts a duplicate import');
      if(engine==='mysql'){
        await evaluate(stopButtons+'[0].click()');
        await waitFor(resetButton+'?.disabled === false');
        assert.equal(stops,1,'a recovered job remains cancellable');
      }else{
        finished.add(engine);
        await waitFor(resetButton+'?.disabled === false');
        await waitFor("document.querySelector('#transfer [role=status]')?.textContent.includes('done') || document.querySelector('#transfer').textContent.includes('completed')");
      }
      assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem('+JSON.stringify(KEY)+'))'),[],'terminal states clear the resume reference');
      const after=polls.get(engine);
      await send('Page.reload');
      await waitFor("document.querySelector('#transfer') !== null");
      await waitFor(resetButton+'?.disabled === false');
      await sleep(150);
      assert.equal(polls.get(engine),after,'finished imports are not polled after reload');
      console.log('PASS: '+engine+' reconnects after reload, retains cancellation, clears terminal state and starts no duplicate write.');
    }
    missing.add('redis');
    await open([reference('redis')]);
    await waitFor("document.querySelector('#transfer [role=alert]')?.textContent.includes('The server no longer has this import status.')");
    await waitFor(resetButton+'?.disabled === false');
    assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem('+JSON.stringify(KEY)+'))'),[]);
    const redisPolls=polls.get('redis');await sleep(250);assert.equal(polls.get('redis'),redisPolls,'missing jobs are not retried');
    missing.clear();finished.delete('mysql');finished.delete('mongo');
    await open([reference('mysql'),reference('mongo')]);
    await waitFor(stopButtons+'.length === 2');
    finished.add('mysql');
    await waitFor(stopButtons+'.length === 1');
    assert.equal(await evaluate(resetButton+'.disabled'),true,'a hidden running engine keeps the session locked');
    finished.add('mongo');
    await waitFor(resetButton+'?.disabled === false');
    assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem('+JSON.stringify(KEY)+'))'),[]);
    const beforeOther=polls.get('mysql');
    await open([{...reference('mysql'),sessionId:'other-session'}]);
    await waitFor(resetButton+'?.disabled === false');
    await sleep(150);assert.equal(polls.get('mysql'),beforeOther,'another session is never resumed');
    assert.equal(starts,0);
    allowStart=true;finished.delete('mysql');
    await open([]);
    await evaluate("(() => {const select=document.querySelector('#transfer .workspace-target-heading select');select.value='mysql';select.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("document.querySelector('#mysqlDatabase') !== null");
    const input=async(selector,value)=>evaluate("(() => {const element=document.querySelector("+JSON.stringify(selector)+");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,"+JSON.stringify(value)+");element.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await input('#mysqlDatabase','restored_database');
    await input('#mysqlUser','fixture-user');
    await input('#mysqlPassword','browser-secret');
    const startButton="Array.from(document.querySelectorAll('#transfer button')).find(b=>b.textContent.trim()==='Import to restored_database')";
    await waitFor(startButton+'?.disabled === false');
    await evaluate(startButton+'.click()');
    await waitFor(stopButtons+'.length === 1');
    assert.equal(starts,1);
    assert.deepEqual(await evaluate('JSON.parse(localStorage.getItem('+JSON.stringify(KEY)+'))'),[reference('mysql')]);
    assert.equal(await evaluate("JSON.stringify({...localStorage}).includes('browser-secret')"),false,'entered credentials never enter browser storage');
    allowStart=false;
    await send('Page.reload');
    await waitFor(stopButtons+'.length === 1');
    assert.equal(starts,1,'the start response is remembered and reload performs no second POST');
    assert.equal(await evaluate("document.querySelector('#mysqlPassword').value"),'','passwords remain empty after reload');
    await evaluate(stopButtons+'[0].click()');
    await waitFor(resetButton+'?.disabled === false');
    assert.deepEqual(errors,[]);
    console.log('PASS: starting through the UI persists only the job reference; reload restores it without credentials or repeated POST.');
    console.log('PASS: transient outages retry safely; missing jobs unlock with a warning; hidden active imports retain the lock; sessions stay isolated.');
  } finally {
    if(socket)socket.close();if(browser)browser.kill();await new Promise(resolve=>server.close(resolve));
    const resolved=path.resolve(profile);
    if(resolved.startsWith(path.resolve(cache)+path.sep)&&path.basename(resolved).startsWith('file-import-recovery-browser-')){
      await sleep(500);try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch{}
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
