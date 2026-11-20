const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const cache = path.join(root, 'node_modules', '.cache');
const executable = process.env.I18N_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
if (!fs.existsSync(executable)) throw new Error('Set I18N_TEST_BROWSER to a Chromium browser executable');
fs.mkdirSync(cache, { recursive: true });
const profile = fs.mkdtempSync(path.join(cache, 'relationships-browser-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const parent = 'CUSTOMERS_WITH_A_VERY_LONG_DATABASE_TABLE_NAME.dbf';
const child = 'ORDERS_WITH_A_VERY_LONG_DATABASE_TABLE_NAME.dbf';
const field = 'CUSTOMER_REFERENCE_WITH_A_VERY_LONG_FIELD_NAME';
function preview(fileName, fields) {
  return { fileName, fieldsNames: fields, totalRecords: 1, encoding: 'utf-8', encodingSource: 'manual', memoFile: null, index: null,
    header: { typeByte: 3, typeName: 'dBASE III', hasMemo: false, lastUpdate: {year:2026,month:11,day:20}, recordCount:1,firstRecordOffset:65,recordLength:41,
      tableFlags:{hasStructuralCdx:false,hasMemoField:false,isDatabase:false},codePage:0,fields:fields.map((name,index)=>({name,type:'C',length:20,decimalCount:0,offset:1+index*20})) },
    preview: [Object.fromEntries(fields.map(name => [name, '001']))] };
}
const files = [preview(child, [field, 'SHARED_CODE']), preview(parent, ['ID', 'SHARED_CODE']), preview('AUDIT.dbf', ['RELATED_ID', 'NAME'])];
let relationships = [
  {id:'fk-link',kind:'auto_fk',confidence:'high',sourceFile:child,sourceField:field,targetFile:parent,targetField:'ID',inferredFrom:field,disabled:false},
  {id:'name-link',kind:'auto_name',confidence:'certain',sourceFile:child,sourceField:'SHARED_CODE',targetFile:parent,targetField:'SHARED_CODE',matchedOn:'exact_name',disabled:false},
  {id:'manual-link',kind:'manual',sourceFile:'AUDIT.dbf',sourceField:'RELATED_ID',targetFile:parent,targetField:'ID',label:'Reviewed link',disabled:true},
];
const graph = () => ({relationships: structuredClone(relationships),stats:{autoName:relationships.filter(r=>r.kind==='auto_name').length,autoFk:relationships.filter(r=>r.kind==='auto_fk').length,manual:relationships.filter(r=>r.kind==='manual').length,total:relationships.length,disabled:relationships.filter(r=>r.disabled).length}});
let sessionId='relationships-smoke', heldEncoding;
const session = () => ({sessionId,files,graph:graph()});
let browser, socket, send, held, holdNext = false, failNextAdd = false, mutations = 0, additions = 0;
const errors = [];
const server = http.createServer((req,res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  let file = path.resolve(dist, '.' + pathname);
  if (file !== dist && !file.startsWith(dist + path.sep)) {res.writeHead(403);res.end();return;}
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.setHeader('Content-Type', ({'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'})[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
async function main() {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    browser = spawn(executable, ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-extensions','--disable-background-networking','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+profile,'about:blank'], {windowsHide:true,stdio:'ignore'});
    const portFile = path.join(profile, 'DevToolsActivePort');
    for(let i=0;!fs.existsSync(portFile)&&i<100;i++) await sleep(100);
    if (!fs.existsSync(portFile)) throw new Error('Browser did not start');
    const port = fs.readFileSync(portFile,'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:'+port+'/json/list')).json();
    socket = new WebSocket(pages.find(page=>page.type==='page').webSocketDebuggerUrl);
    await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
    let sequence=0;
    const pending = new Map();
    send = (method,params={}) => new Promise((resolve,reject)=>{
      const id=++sequence;const timeout=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);
      pending.set(id,{resolve,reject,timeout});socket.send(JSON.stringify({id,method,params}));
    });
    const fulfill = async (requestId,data,responseCode=200) => send('Fetch.fulfillRequest',{requestId,responseCode,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'*'},{name:'Access-Control-Allow-Methods',value:'GET,POST,PATCH,DELETE,OPTIONS'}],body:Buffer.from(JSON.stringify(data)).toString('base64')});
    socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.id){const task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timeout);if(message.error)task.reject(new Error(JSON.stringify(message.error)));else task.resolve(message.result);return;}
      if(message.method==='Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description||message.params.exceptionDetails.text);
      if(message.method!=='Fetch.requestPaused')return;
      const {requestId,request}=message.params;const route=new URL(request.url).pathname;
      let data=session(),status=200;
      if(request.method==='OPTIONS')data={};
      else if(request.method==='PATCH' && route.includes('/encoding')) {
        const changed={...files[0],fieldsNames:['STALE_COLUMN'],header:{...files[0].header,fields:[{...files[0].header.fields[0],name:'STALE_COLUMN'}]}};
        heldEncoding=()=>fulfill(requestId,{file:changed,graph:{relationships:[],stats:{total:0,manual:0,autoFk:0,autoName:0,disabled:0}}});return;
      }
      else if(route.includes('/mysql/plan'))data={tables:[],foreignKeys:[],warnings:[],quality:[]};
      else if(route.includes('/mongo/plan'))data={collections:[],references:[],warnings:[],quality:[]};
      else if(request.method==='PATCH' && route.includes('/relationship/')) {
        mutations++;const id=decodeURIComponent(route.split('/').at(-1));const body=JSON.parse(request.postData);
        relationships=relationships.map(r=>r.id===id?{...r,disabled:body.disabled}:r);data=graph();
        if(holdNext){holdNext=false;held=()=>fulfill(requestId,data,status);return;}
      } else if(request.method==='DELETE' && route.includes('/relationship/')) {
        mutations++;const id=decodeURIComponent(route.split('/').at(-1));relationships=relationships.filter(r=>r.id!==id);data=graph();
      } else if(request.method==='POST' && route.endsWith('/session/relationship')) {
        additions++;const body=JSON.parse(request.postData);
        if(failNextAdd){failNextAdd=false;status=400;data={message:'Relationship rejected for testing'};}
        else {relationships.push({...body,id:'added-'+additions,kind:'manual',disabled:false});data=graph();}
      }
      void fulfill(requestId,data,status).catch(error=>errors.push(error.message));
    });
    const evaluate = async expression => {const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
    const waitFor = async expression => {for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(100);}throw new Error('Timed out: '+expression+'\n'+await evaluate('document.body.innerText'));};
    const click = async label => evaluate("Array.from(document.querySelector('#review').querySelectorAll('button')).find(button=>button.textContent.trim() === "+JSON.stringify(label)+").click()");
    const input = async (selector,value) => evaluate("(() => {const element=document.querySelector("+JSON.stringify(selector)+"); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(element,"+JSON.stringify(value)+");element.dispatchEvent(new Event('input',{bubbles:true}));})()");
    const select = async (selector,value) => evaluate("(() => {const element=document.querySelector("+JSON.stringify(selector)+");element.value="+JSON.stringify(value)+";element.dispatchEvent(new Event('change',{bubbles:true}));})()");
    const capture = async name => {await evaluate("document.querySelector('#review').scrollIntoView({block:'start'})");const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(cache,name),Buffer.from(result.data,'base64'));};
    await send('Runtime.enable');await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument',{source:"localStorage.setItem('dbf-inspector:language:v2','en');localStorage.setItem('dbf-inspector:last-session','relationships-smoke')"});
    await send('Fetch.enable',{patterns:[{urlPattern:'http://127.0.0.1:*/dbf/*',requestStage:'Request'}]});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate',{url});
    await waitFor("document.querySelector('#review')?.textContent.includes('SHARED_CODE')");
    if(process.env.RELATIONSHIPS_BASELINE){
      await capture('relationships-before.png');
      await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
      console.log('Baseline relationship table:',await evaluate("(() => {const table=document.querySelector('#review table');return {columns:table.querySelectorAll('th').length,width:Math.round(table.getBoundingClientRect().width),panelWidth:Math.round(document.querySelector('#review').getBoundingClientRect().width)};})()"));
      return;
    }
    await waitFor("document.querySelectorAll('#review [data-relationship-id]').length === 3");
    assert.equal(await evaluate("document.querySelector('#review [data-relationship-id=\"name-link\"]').textContent.includes('↔')"),true);
    assert.equal(await evaluate("document.querySelector('#review [data-relationship-id=\"fk-link\"]').textContent.includes('→')"),true);
    assert.equal(await evaluate("document.querySelector('#review [data-relationship-id=\"manual-link\"]').textContent.includes('Disabled')"),true);
    await capture('relationships-after.png');
    for(const width of [390,900]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'),true,'relationship page fits at '+width);
      assert.equal(await evaluate("Array.from(document.querySelectorAll('#review .relationship-card')).every(card=>card.scrollWidth <= card.clientWidth + 1)"),true,'long identifiers fit relationship cards');
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await input('#review input[type=search]','RELATED_ID');
    assert.equal(await evaluate("document.querySelectorAll('#review [data-relationship-id]').length"),1);
    await input('#review input[type=search]','missing_relationship');
    await waitFor("document.querySelector('#review').textContent.includes('No relationships match these filters.')");
    await input('#review input[type=search]','');
    await select('#review select[aria-label=\"Relationship type\"]','auto_fk');
    assert.equal(await evaluate("document.querySelectorAll('#review [data-relationship-id]').length"),1);
    await select('#review select[aria-label=\"Relationship type\"]','all');
    await select('#review select[aria-label=\"Relationship state\"]','disabled');
    assert.equal(await evaluate("document.querySelectorAll('#review [data-relationship-id]').length"),1);
    await select('#review select[aria-label=\"Relationship state\"]','all');
    await select('#review select[aria-label=\"Filter by table\"]','AUDIT.dbf');
    assert.equal(await evaluate("document.querySelectorAll('#review [data-relationship-id]').length"),1);
    await select('#review select[aria-label=\"Filter by table\"]','all');
    holdNext=true;
    await evaluate("document.querySelector('#review [data-relationship-id=\"fk-link\"] input[type=checkbox]').click()");
    await waitFor("Array.from(document.querySelectorAll('#review [data-relationship-id] input[type=checkbox]')).every(input=>input.disabled)");
    assert.equal(mutations,1);
    await evaluate("document.querySelector('#review [data-relationship-id=\"name-link\"] input[type=checkbox]').click()");
    assert.equal(mutations,1,'another link cannot change while a graph update is in flight');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('#review button')).find(button=>button.textContent.trim()==='Link').disabled"),true);
    await held();held=undefined;
    await waitFor("document.querySelector('#review [data-relationship-id=\"fk-link\"]').textContent.includes('Disabled') && !document.querySelector('#review [data-relationship-id=\"name-link\"] input').disabled");
    assert.equal(await evaluate("document.querySelector('#review [data-relationship-id=\"name-link\"] input').checked"),true);
    await evaluate("document.querySelector('#review [data-relationship-id=\"manual-link\"] button').click()");
    await waitFor("document.querySelector('#review [data-relationship-id=\"manual-link\"]') === null");
    assert.equal(relationships.length,2);
    await select('#review select[aria-label=\"Source table\"]','AUDIT.dbf');
    await select('#review select[aria-label=\"Source field\"]','RELATED_ID');
    await select('#review select[aria-label=\"Target table\"]',parent);
    await select('#review select[aria-label=\"Target field\"]','ID');
    failNextAdd=true;await click('Link');
    await waitFor("document.querySelector('#review [role=alert]')?.textContent.includes('Relationship rejected')");
    assert.equal(await evaluate("document.querySelector('#review select[aria-label=\"Source field\"]').value"),'RELATED_ID','failed additions preserve the selected endpoints');
    await click('Link');
    await waitFor("document.querySelectorAll('#review [data-relationship-id]').length === 3");
    assert.equal(await evaluate("document.querySelector('#review select[aria-label=\"Source table\"]').value"),'');
    assert.equal(await evaluate("document.querySelector('#review [data-relationship-id=\"added-2\"]').textContent.includes('certain')"),false,'manual links have no invented confidence');
    console.log('PASS: relationship endpoints, match/reference directions, disabled labels, long-name layouts, search/filters, serialized updates, deletion and retryable manual additions.');
    relationships = Array.from({length:123},(_,index)=>({...relationships[0],id:'bulk-'+index,sourceField:'FIELD_'+index,disabled:false}));
    await send('Page.reload');
    await waitFor("document.querySelectorAll('#review [data-relationship-id]').length === 50");
    await click('Next');
    await waitFor("document.querySelector('#review [data-relationship-id=\"bulk-50\"]') !== null");
    await click('Next');
    await waitFor("document.querySelectorAll('#review [data-relationship-id]').length === 23");
    await input('#review input[type=search]','FIELD_122');
    await waitFor("document.querySelectorAll('#review [data-relationship-id]').length === 1");
    assert.equal(await evaluate("document.querySelector('#review [data-relationship-id]').dataset.relationshipId"),'bulk-122');
    await evaluate("document.querySelector('#source [role=combobox]').click()");
    await waitFor("Array.from(document.querySelectorAll('[role=option]')).some(option=>option.textContent.includes('windows-1251'))");
    await evaluate("Array.from(document.querySelectorAll('[role=option]')).find(option=>option.textContent.includes('windows-1251')).click()");
    for(let i=0;!heldEncoding&&i<100;i++)await sleep(50);
    assert.equal(typeof heldEncoding,'function','encoding reply is deferred');
    await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='New session').click()");
    await waitFor("document.querySelector('#review') === null");
    sessionId='new-session';
    await evaluate("(() => {const input=document.querySelector('input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File(['fixture'],'NEW.dbf'));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("Array.from(document.querySelectorAll('button')).some(button=>button.textContent.trim()==='Open 1 table' && !button.disabled)");
    await evaluate("Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()==='Open 1 table').click()");
    await waitFor("localStorage.getItem('dbf-inspector:last-session')==='new-session' && document.querySelector('#review') !== null");
    await heldEncoding();heldEncoding=undefined;await sleep(200);
    assert.equal(await evaluate("document.querySelector('#source').textContent.includes('STALE_COLUMN')"),false,'old encoding responses cannot replace a new session table');
    assert.equal(await evaluate("document.querySelectorAll('#review [data-relationship-id]').length"),50,'old encoding responses cannot overwrite the new graph');
    console.log('PASS: a delayed encoding response cannot overwrite tables or relationships in a newer session.');
    assert.deepEqual(errors,[]);
    console.log('PASS: large relationship sets are paginated; filtering resets the visible page and preserves stable relationship IDs.');
  }finally{
    if(heldEncoding)await heldEncoding().catch(()=>{});
    if(held)await held().catch(()=>{});
    if(socket)socket.close();if(browser)browser.kill();await new Promise(resolve=>server.close(resolve));
    const resolved=path.resolve(profile);
    if(resolved.startsWith(path.resolve(cache)+path.sep)&&path.basename(resolved).startsWith('relationships-browser-')){await sleep(500);try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:200});}catch{}}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
