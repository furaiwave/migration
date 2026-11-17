const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const cache = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const profile = fs.mkdtempSync(path.join(cache, 'sql-editor-browser-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket;
const errors = [], requests = [];

const nativeRequests = [], delayed = new Set();
const columnNames = ['id','name','email','status','created_at','notes',...Array.from({length:10},(_,i)=>'custom_'+(i+1))];
const schema = {engine:'postgres',database:'editor_test',elapsedMs:3,truncated:false,objects:[
 {schema:'public',name:'users',kind:'table',columns:[{name:'id',dataType:'bigint',nullable:false,ordinal:1},{name:'name',dataType:'text',nullable:true,ordinal:2},{name:'email',dataType:'text',nullable:true,ordinal:3}]},
 {schema:'public',name:'events',kind:'table',columns:columnNames.map((name,i)=>({name,dataType:i===0?'bigint':'text',nullable:i>0,ordinal:i+1}))}
]};
function report(sql) {
 if(sql.startsWith('SELEC '))return {connector:'rust',elapsedMs:2,truncated:false,error:{message:'SQL syntax error',code:'42601',position:1},sets:[]};
 const large=sql.includes('events'), names=large?columnNames:['id','name','nullable'];
 const rows=Array.from({length:large?5000:2},(_,i)=>large?[
   (9007199254740993n+BigInt(i)).toString(),'Person '+i,'person-'+i+'@example.test',['active','pending','paused'][i%3],
   '2026-11-'+String(i%17+1).padStart(2,'0'),i%7===0?null:'Record '+i,
   ...Array.from({length:10},(_,j)=>'value-'+i+'-'+j)
 ]:[(9007199254740993n+BigInt(i)).toString(),'Person '+i,null]);
 return {connector:'rust',elapsedMs:large?18:3,truncated:false,error:null,sets:[{columns:names.map((name,i)=>({name,dataType:i===0?'bigint':'text'})),rows,affectedRows:String(rows.length),rowCount:rows.length,truncated:false,clipped:false}]};
}

const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  let file = path.resolve(dist, '.' + pathname);
  if (file !== dist && !file.startsWith(dist + path.sep)) { response.writeHead(403); response.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  response.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
  response.end(fs.readFileSync(file));
});
async function main() {
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    browser = spawn(process.env.I18N_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await sleep(100);
    if (!fs.existsSync(portFile)) throw new Error('Browser did not start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0;
    const pending = new Map();
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
      pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const task = pending.get(message.id); if (!task) return;
        pending.delete(message.id); clearTimeout(task.timeout);
        if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
      }

      if (message.method === 'Fetch.requestPaused') {
        const {requestId,request}=message.params;
        const pathname=new URL(request.url).pathname;
        const body=request.postData?JSON.parse(request.postData):null;
        if(request.method!=='OPTIONS')nativeRequests.push({pathname,body});
        const data=request.method==='OPTIONS'?{}:pathname.endsWith('/inspect')?schema:
          pathname.endsWith('/catalog')?{serverVersion:'test',databases:['editor_test'],connector:'rust',elapsedMs:2}:report(body?.sql??'');
        const fulfill=()=>send('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[
          {name:'Content-Type',value:'application/json'},
          {name:'Access-Control-Allow-Origin',value:'*'},
          {name:'Access-Control-Allow-Headers',value:'content-type'},
          {name:'Access-Control-Allow-Methods',value:'POST,GET,OPTIONS'}
        ],body:Buffer.from(JSON.stringify(data)).toString('base64')}).catch(error=>{
          if(!body?.sql?.includes('pg_sleep'))errors.push(String(error));
        });
        if(body?.sql?.includes('pg_sleep')){
          const timer=setTimeout(()=>{delayed.delete(timer);void fulfill();},1500);delayed.add(timer);
        }else void fulfill();
      }

      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
      if (message.method === 'Network.requestWillBeSent' && message.params.request.method === 'POST') requests.push(message.params.request.url);
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); }
      throw new Error('Not found: ' + expression);
    };
    const captureUI = async (name, width = 1440, height = 1000) => {
      if (!process.env.UI_REVIEW) return;
      await send('Emulation.setDeviceMetricsOverride', {width, height, deviceScaleFactor:1, mobile:false});
      await evaluate("document.fonts.ready.then(()=>window.scrollTo(0,0))");
      await sleep(150);
      const screenshot = await send('Page.captureScreenshot', {format:'png', captureBeyondViewport:false});
      fs.writeFileSync(path.join(cache, name + '.png'), Buffer.from(screenshot.data, 'base64'));
    };

    await send('Runtime.enable');await send('Network.enable');await send('Page.enable');
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1100,deviceScaleFactor:1,mobile:false});
    await send('Fetch.enable',{patterns:[{urlPattern:'*/dbf/native/*'}]});
    await send('Page.navigate',{url:'http://127.0.0.1:'+server.address().port});
    await waitFor("!!document.querySelector('main > label select')");
    await evaluate("(()=>{const s=document.querySelector('main > label select');s.value='editor';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("!!document.querySelector('.cm-content')");
    assert.equal(await evaluate("document.querySelector('.sql-connection-status').textContent.includes('Not connected')"),true);
    const fill=async(label,value)=>evaluate("(()=>{const label=Array.from(document.querySelectorAll('.sql-connection-form label')).find(label=>label.firstChild.textContent==="+JSON.stringify(label)+");const input=label.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,"+JSON.stringify(value)+");input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await fill('User','test');await fill('Password','editor-password-secret');await fill('Database name','editor_test');
    await evaluate("document.querySelector('.sql-connect-actions [aria-label=\"Save connection\"]').click()");
    assert.equal(await evaluate("JSON.stringify(localStorage).includes('editor-password-secret')"),false);
    await evaluate("document.querySelector('.sql-connection-form form').requestSubmit()");
    await waitFor("document.querySelector('.sql-connection-status').textContent.includes('Connected') && document.querySelector('.sql-object-tree').innerText.includes('users')");
    assert.equal(nativeRequests.find(r=>r.pathname.endsWith('/inspect')).body.password,'editor-password-secret');
    const key=async(key,code,virtual,modifiers=0)=>{
      await send('Input.dispatchKeyEvent',{type:'keyDown',key,code,windowsVirtualKeyCode:virtual,modifiers});
      await send('Input.dispatchKeyEvent',{type:'keyUp',key,code,windowsVirtualKeyCode:virtual,modifiers});
    };
    const setSql=async text=>{
      await evaluate("document.querySelector('.cm-content').focus()");
      await key('a','KeyA',65,2);await send('Input.insertText',{text});
      await waitFor("document.querySelector('.cm-content').innerText.includes("+JSON.stringify(text.split('\n')[0])+")");
    };
    const queryCount=()=>nativeRequests.filter(r=>r.pathname.endsWith('/query')).length;
    const runSql=async text=>{
      await setSql(text);const count=queryCount();await key('Enter','Enter',13,2);
      for(let i=0;queryCount()===count && i<100;i++)await sleep(30);
      assert.ok(queryCount()>count,'Ctrl+Enter submits SQL');
      await waitFor("!document.querySelector('.sql-query-toolbar button').disabled");
    };
    await setSql('SELECT 11;\nSELECT 22;');
    await evaluate("(()=>{const line=document.querySelector('.cm-line'),range=document.createRange();range.selectNodeContents(line);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));})()");
    await waitFor("window.getSelection().toString() === 'SELECT 11;'");
    await sleep(80);
    let count=queryCount();await key('Enter','Enter',13,2);
    await waitFor("!!document.querySelector('.sql-grid-viewport')");
    assert.equal(queryCount(),count+1);
    assert.equal(nativeRequests.filter(r=>r.pathname.endsWith('/query')).at(-1).body.sql,'SELECT 11;');
    assert.equal(await evaluate("document.querySelector('.sql-grid-row [role=gridcell]').textContent"),'9007199254740993');
    assert.equal(await evaluate("document.querySelectorAll('.sql-grid-row .is-null').length > 0"),true);
    const firstId=await evaluate("document.querySelector('.sql-tab-bar [role=tab]').id");
    await evaluate("document.querySelector('[aria-label=\"New query\"]').click()");
    await waitFor("document.querySelectorAll('.sql-tab-bar [role=tab]').length === 2");
    await setSql('SELECT 33;');
    await evaluate("document.getElementById("+JSON.stringify(firstId)+").click()");
    await waitFor("document.querySelector('.cm-content').innerText.includes('SELECT 22;')");
    assert.equal(await evaluate("document.querySelector('.cm-content').innerText.includes('SELECT 33;')"),false);
    await key('Enter','Enter',13,2);
    await waitFor("!document.querySelector('.sql-query-toolbar button').disabled");
    assert.equal(nativeRequests.filter(r=>r.pathname.endsWith('/query')).at(-1).body.sql,'SELECT 11;','selection survives a tab switch');

    await setSql('SELECT * FROM us');await key(' ','Space',32,2);
    await waitFor("!!document.querySelector('.cm-tooltip-autocomplete') && document.querySelector('.cm-tooltip-autocomplete').textContent.includes('users')");
    await key('Escape','Escape',27);
    await evaluate("(()=>{const s=document.querySelector('.sql-query-toolbar select');s.value='5000';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await runSql('SELECT * FROM public.events LIMIT 5000;');
    await waitFor("document.querySelector('.sql-grid-viewport')?.getAttribute('aria-rowcount') === '5001'");
    const rendered=await evaluate("document.querySelectorAll('.sql-grid-row [role=gridcell]').length");
    assert.ok(rendered<1000,'virtualization renders fewer than 1000 cells for 80000 cells');
    assert.equal(nativeRequests.filter(r=>r.pathname.endsWith('/query')).at(-1).body.maxRows,5000);
    await evaluate("document.querySelector('.sql-grid-row [role=gridcell]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await waitFor("!!document.querySelector('.sql-value-dialog[open]')");
    assert.equal(await evaluate("document.querySelector('.sql-value-dialog textarea').value"),'9007199254740993');
    await evaluate("document.querySelector('.sql-value-dialog [aria-label=\"Close\"]').click()");
    await evaluate("document.querySelector('.sql-grid-header [role=columnheader][aria-colindex=\"2\"]').click()");
    await evaluate("document.querySelector('.sql-grid-header [role=columnheader][aria-colindex=\"2\"]').click()");
    await waitFor("document.querySelector('.sql-grid-row [role=gridcell]').textContent === '9007199254745992'");
    const beforeFilter=queryCount();
    await evaluate("(()=>{const i=document.querySelector('.sql-result-tools input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'Person 4999');i.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await waitFor("document.querySelector('.sql-grid-viewport').getAttribute('aria-rowcount') === '2'");
    assert.equal(queryCount(),beforeFilter);
    await evaluate("(()=>{const i=document.querySelector('.sql-result-tools input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'');i.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await waitFor("document.querySelector('.sql-grid-viewport').getAttribute('aria-rowcount') === '5001'");
    await evaluate("(()=>{const e=document.querySelector('.sql-grid-viewport');e.scrollTop=100000;e.scrollLeft=1200;e.dispatchEvent(new Event('scroll'));})()");
    await waitFor("Number(document.querySelector('.sql-grid-row').getAttribute('aria-rowindex')) > 3000");
    assert.ok(await evaluate("document.querySelectorAll('.sql-grid-row [role=gridcell]').length")<1000);
    await evaluate("(()=>{const e=document.querySelector('.sql-grid-viewport');e.scrollTop=0;e.scrollLeft=0;e.dispatchEvent(new Event('scroll'));})()");

    await evaluate("window.__downloads=[];window.__blobs=new Map();const originalUrl=URL.createObjectURL;URL.createObjectURL=blob=>{const url=originalUrl(blob);window.__blobs.set(url,blob);return url;};HTMLAnchorElement.prototype.click=function(){if(this.download)window.__downloads.push({name:this.download,blob:window.__blobs.get(this.href)});};");
    await evaluate("Array.from(document.querySelectorAll('.sql-result-tools button')).find(b=>b.textContent.includes('CSV')).click()");
    const csv=await evaluate("window.__downloads.find(d=>d.name.endsWith('.csv')).blob.text()");
    assert.ok(csv.startsWith('"id"'));assert.ok(csv.includes('9007199254740993'));
    assert.deepEqual(await evaluate("window.__downloads.find(d=>d.name.endsWith('.csv')).blob.arrayBuffer().then(buffer=>Array.from(new Uint8Array(buffer,0,3)))"),[239,187,191]);
    await evaluate("Array.from(document.querySelectorAll('.sql-result-tools button')).find(b=>b.textContent.includes('JSON')).click()");
    const json=JSON.parse(await evaluate("window.__downloads.find(d=>d.name.endsWith('.json')).blob.text()"));
    assert.equal(json.rows.length,5000);assert.equal(json.rows[0][0],'9007199254740993');

    const beforeLocale=queryCount();
    await evaluate("(()=>{const s=document.querySelector('header select');s.value='uk';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("document.documentElement.lang === 'uk'");
    assert.equal(await evaluate("document.querySelector('.sql-workspace-heading h2').textContent"),'SQL-\u0440\u0435\u0434\u0430\u043a\u0442\u043e\u0440');
    assert.equal(await evaluate("document.querySelector('.sql-result-tools label').textContent.includes('\u0424\u0456\u043b\u044c\u0442\u0440')"),true);
    assert.equal(queryCount(),beforeLocale);
    await evaluate("(()=>{const s=document.querySelector('header select');s.value='en';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("document.documentElement.lang === 'en'");
    await captureUI('sql-editor-dark',1440,1100);
    await runSql('SELEC nope;');
    await waitFor("Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('42601'))");
    await setSql('SELECT pg_sleep(10);');
    await key('Enter','Enter',13,2);
    await waitFor("Array.from(document.querySelectorAll('.sql-query-toolbar button')).some(button=>button.textContent==='Stop')");
    await evaluate("Array.from(document.querySelectorAll('.sql-query-toolbar button')).find(button=>button.textContent==='Stop').click()");
    await waitFor("document.querySelector('.sql-editor-main').innerText.includes('Request stopped')");
    await sleep(1600);
    assert.equal(await evaluate("document.querySelectorAll('.sql-grid-row').length"),0,'late aborted responses do not replace stopped results');

    await evaluate("(()=>{const data=new DataTransfer();data.items.add(new File([\"SELECT 'file_editor_marker';\"],'local.sql'));const i=document.querySelector('.sql-query-toolbar input[type=file]');i.files=data.files;i.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("document.querySelector('.cm-content').innerText.includes('file_editor_marker')");
    await evaluate("document.querySelector('[aria-label=\"Save SQL file\"]').click()");
    assert.equal(await evaluate("window.__downloads.find(d=>d.name==='local.sql').blob.text()"),"SELECT 'file_editor_marker';");
    assert.equal(await evaluate("JSON.stringify(localStorage).includes('editor-password-secret') || JSON.stringify(localStorage).includes('file_editor_marker') || JSON.stringify(localStorage).includes('SELECT * FROM public.events')"),false);
    await evaluate("document.querySelector('[aria-label=\"Browse table users\"]').click()");
    await waitFor("Array.from(document.querySelectorAll('.sql-tab-bar [role=tab]')).some(tab=>tab.textContent.includes('users')) && !!document.querySelector('.sql-grid-row')");
    assert.equal(nativeRequests.filter(r=>r.pathname.endsWith('/query')).at(-1).body.sql,'SELECT * FROM "public"."users" LIMIT 5000;');
    await evaluate("Array.from(document.querySelectorAll('.sql-schema-heading button')).find(button=>button.textContent.includes('History')).click()");
    await waitFor("document.querySelectorAll('.sql-history>button').length > 0");
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await sleep(100);
    assert.equal(await evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"),true,'editor fits a narrow viewport');
    await captureUI('sql-editor-mobile',390,844);
    assert.deepEqual(errors,[]);
    console.log('PASS: SQL editor connection and credential privacy; Ctrl+Enter selection, tab state, completion, 5000x16 results with '+rendered+' rendered cells, virtual scrolling, exact exports, Unicode, errors, stop/stale-response handling, files and table browsing.');

  } finally {
    for(const timer of delayed)clearTimeout(timer);
    if (socket) socket.close();
    if (browser) browser.kill();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
