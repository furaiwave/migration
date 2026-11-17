const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const catalog = require('../src/i18n/messages.json');
const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
const cache = path.join(root, 'node_modules', '.cache');
const executable = process.env.I18N_TEST_BROWSER || [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((file) => fs.existsSync(file));
if (!executable) throw new Error('Set I18N_TEST_BROWSER to a Chromium browser executable.');
fs.mkdirSync(cache, { recursive: true });
const profile = fs.mkdtempSync(path.join(cache, 'i18n-browser-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const codes = ['uk', 'en', 'fr', 'es', 'pl', 'ja', 'ko', 'de', 'sv', 'it'];
const rawValue = '\u041a\u043b\u0456\u0454\u043d\u0442 \u5ba2\u6237 {0}';
const graph = { relationships: [], stats: { autoName: 0, autoFk: 0, manual: 0, total: 0, disabled: 0 } };
const session = { sessionId: 'i18n-smoke', graph, files: [{
  fileName: 'CLIENTS.dbf',
  header: { typeByte: 3, typeName: 'dBASE III', hasMemo: false, lastUpdate: { year: 2026, month: 11, day: 12 },
    recordCount: 1, firstRecordOffset: 65, recordLength: 41,
    tableFlags: { hasStructuralCdx: false, hasMemoField: false, isDatabase: false }, codePage: 0,
    fields: [{ name: 'NAME', type: 'C', length: 40, decimalCount: 0, offset: 1 }] },
  fieldsNames: ['NAME'], preview: [{ NAME: rawValue }], totalRecords: 1,
  encoding: 'utf-8', encodingSource: 'manual', memoFile: null, index: null,
}] };
let browser;
let socket;
let send;
const exceptions = [];
const apiRequests = [];
const sqlPayloads = [];
const redisPayloads = [];
let missingImport = false;
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  let file = path.resolve(dist, '.' + pathname);
  if (file !== dist && !file.startsWith(dist + path.sep)) { response.writeHead(403); response.end(); return; }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  response.end(fs.readFileSync(file));
});

async function main() {
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0',
      '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await sleep(100);
    if (!fs.existsSync(portFile)) throw new Error('Test browser did not start.');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find((page) => page.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    let sequence = 0;
    const pending = new Map();
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 10000);
      pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, params }));
    });
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const task = pending.get(message.id);
        if (!task) return;
        pending.delete(message.id);
        clearTimeout(task.timeout);
        if (message.error) task.reject(new Error(JSON.stringify(message.error))); else task.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        exceptions.push(details.exception?.description || details.text);
      }
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params;
        apiRequests.push(request.method + ' ' + new URL(request.url).pathname);
        let data = session;
        let responseCode = 200;
        if (request.url.includes('/mysql/plan')) data = { tables: [], foreignKeys: [], warnings: [], quality: [] };
        if (request.url.includes('/mongo/plan')) data = { collections: [], references: [], warnings: [], quality: [] };
        if (request.url.endsWith('/native/servers')) data = { servers: [{ id: 'local-pg', engine: 'postgres', label: 'PostgreSQL local test', host: '127.0.0.1', port: 5544, source: 'process', reachable: true, protocolConfirmed: true }], warnings: [] };
        if (request.url.endsWith('/native/inspect') && request.method === 'POST') { const body=JSON.parse(request.postData); data={engine:body.engine,database:body.database,elapsedMs:6,truncated:false,objects:[{schema:'public',name:'clients_existing',kind:'table',columns:[{name:'ID_native',dataType:'bigint',nullable:false,ordinal:1}]}]}; }
        if (request.url.endsWith('/native/catalog') && request.method === 'POST') { const body=JSON.parse(request.postData); data={serverVersion:body.engine+'-test',databases:['archive_db','legacy_db'],connector:'rust',elapsedMs:12}; }
        if (request.url.endsWith('/native/diagnose') && request.method === 'POST') { const body=JSON.parse(request.postData); data={host:body.host,port:body.port,status:'reachable',elapsedMs:7,resolvedAddresses:['127.0.0.1']}; }
        if (request.url.endsWith('/native/test-connection') && request.method === 'POST') { const body = JSON.parse(request.postData); data = { serverVersion: body.engine + '-test', databases: ['legacy_db'], connector: 'rust' }; }
        if (request.url.includes('/redis/plan')) data = {prefix:'data', tables:[{fileName:'CLIENTS.dbf',table:'clients',deletedTable:null,rowCount:1,deletedRows:0,keyMode:'record',columns:[{name:'name',kind:'text'}]}],warnings:[],quality:[]};
        if (request.url.includes('/redis/import')) {
          const running=request.method==='POST'; if(running)redisPayloads.push(JSON.parse(request.postData));
          data={jobId:'redis-job',database:'0',state:running?'running':'done',progress:{phase:'records',table:'clients',tableIndex:1,tableCount:1,tableRowsDone:running?0:1,rowsDone:running?0:1,rowsTotal:1,elapsedMs:500},...(!running?{result:{tables:[{fileName:'CLIENTS.dbf',table:'clients',expectedRows:1,importedRows:1,skippedRows:0}],warnings:[],durationMs:500}}:{})};
        }
        if (request.url.includes('/sql/')) {
          const dialect = request.url.includes('/postgres/') ? 'postgres' : 'mssql';
          if (request.url.endsWith('/plan')) data = { dialect, tables: [{ fileName: 'CLIENTS.dbf', table: 'clients', rowCount: 1, columns: [{ name: 'name', type: dialect === 'postgres' ? 'text' : 'nvarchar(450)', key: null }] }], warnings: [], quality: [] };
          if (request.url.endsWith('/test-connection')) data = { serverVersion: dialect + '-test', databases: ['legacy_db'] };
          if (request.url.includes('/import')) {
            if (request.method === 'POST') sqlPayloads.push({ dialect, body: JSON.parse(request.postData) });
            const running = request.method === 'POST';
            data = { jobId: dialect + '-job', state: running ? 'running' : 'done', database: 'legacy_db', progress: { phase: running ? 'tables' : 'verifying', tableIndex: 1, tableCount: 1, table: 'clients', tableRowsDone: running ? 0 : 1, tableRows: 1, rowsDone: running ? 0 : 1, rowsTotal: 1, foreignKeysDone: 0, foreignKeysTotal: 0, elapsedMs: 500 },
              ...(!running ? { result: { database: 'legacy_db', serverVersion: 'test', durationMs: 500, writeMode: 'append', syncDeletes: false, tables: [{ fileName: 'CLIENTS.dbf', table: 'clients', role: 'table', expectedRows: 1, importedRows: 1 }], foreignKeysCreated: 0, indexesCreated: 0, warnings: [] } } : {}) };
          }
        }
        if (missingImport && request.method === 'GET' && request.url.includes('/sql/mssql/import/')) { responseCode = 404; data = { statusCode: 404, message: 'Import not found' }; }
        void send('Fetch.fulfillRequest', { requestId, responseCode,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' },
            { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,DELETE,OPTIONS' }],
          body: Buffer.from(request.method === 'OPTIONS' ? '{}' : JSON.stringify(data)).toString('base64'),
        }).catch((error) => exceptions.push(error.message));
      }
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:*/dbf/*', requestStage: 'Request' }] });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const captureUI = async (name, width=1440, height=1000, section=null) => {
      if (!process.env.UI_REVIEW) return;
      const directory=path.join(cache,'ui-review');fs.mkdirSync(directory,{recursive:true});
      await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await evaluate(section ? 'document.querySelector('+JSON.stringify(section)+').scrollIntoView({block:"start"})' : 'window.scrollTo(0,0)');
      await sleep(150);
      const screenshot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(directory,name+'.png'),Buffer.from(screenshot.data,'base64'));
    };
    const waitFor = async (expression) => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); }
      throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText') + '\n' + exceptions.join('\n'));
    };
    const choose = async (code) => {
      await evaluate("(() => { const select = document.querySelector('select'); select.value = " + JSON.stringify(code) +
        "; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
      await waitFor('document.documentElement.lang === ' + JSON.stringify(code));
      await sleep(50);
    };
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('dbf-inspector:language','uk'); Object.defineProperty(navigator,'languages',{get:()=>['uk-UA']}); Object.defineProperty(navigator,'language',{get:()=>'uk-UA'});" });
    await send('Page.navigate', { url });
    await waitFor("document.querySelector('select')?.options.length === 10");
    assert.deepEqual(await evaluate("Array.from(document.querySelector('select').options, (option) => option.value)"), codes);
    assert.equal(await evaluate('document.documentElement.lang'), 'en', 'English is used without a language selection');
    assert.equal(await evaluate("(() => { const page = document.body.cloneNode(true); page.querySelector('header select')?.remove(); return !/[\\u0400-\\u04ff]/.test(page.textContent); })()"), true, 'default interface is English outside native language names');
    assert.equal(await evaluate('document.title'), 'Data Migrator');
    assert.doesNotMatch(await evaluate('document.body.innerText'), /dbf/i, 'public names are format-neutral');
    await choose('en');
    if (process.env.WEB_TEST_CLOUD === '1') {
      assert.ok((await evaluate('document.body.innerText')).includes('Discovery and connections run on the cloud server.'));
      console.log('PASS: cloud mode explains where discovery and database connections run.');
    }
    await captureUI('01-empty-light');
    const isDark = "document.documentElement.classList.contains('dark')";
    const clickTheme = async (label) => {
      await evaluate("Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === " + JSON.stringify(label) + ").click()");
    };
    assert.equal(await evaluate(isDark), false, 'first launch follows the light system preference');
    const lightBackground = await evaluate('getComputedStyle(document.body).backgroundColor');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await waitFor(isDark);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await waitFor('!' + isDark);
    await clickTheme('Dark theme');
    await waitFor(isDark);
    assert.notEqual(await evaluate('getComputedStyle(document.body).backgroundColor'), lightBackground, 'theme changes the visible page colors');
    assert.equal(await evaluate('document.documentElement.style.colorScheme'), 'dark', 'native controls follow the theme');
    assert.equal(await evaluate("localStorage.getItem('dbf-inspector:theme')"), 'dark');
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await sleep(100);
    assert.equal(await evaluate(isDark), true, 'manual choice takes priority over the system');
    console.log('PASS: light/dark colors, native controls, system preference and manual override.');
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Find database servers')).click()");
    await waitFor("Array.from(document.querySelectorAll('select')).some(s => Array.from(s.options).some(o => o.value === 'local-pg'))");
    await evaluate("(() => { const s = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'local-pg')); s.value = 'local-pg'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Use for import')).click()");
    await waitFor("document.body.innerText.includes('Selected: PostgreSQL local test')");
    assert.equal(await evaluate("JSON.parse(localStorage.getItem('dbf-inspector:native-target')).servers.postgres.port"), 5544);
    console.log('PASS: native discovery selects and remembers a local server before uploading files.');
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Network diagnostics')).click()");
    await waitFor("document.body.innerText.includes('Check time: 7 ms') && document.body.innerText.includes('Addresses: 127.0.0.1')");
    console.log('PASS: network diagnostics display TCP status, resolved addresses and elapsed time.');
    await evaluate("document.querySelector('button[aria-label=\"Expand log\"]').click()");
    await waitFor("document.querySelector('button[aria-label=\"Collapse log\"]').getAttribute('aria-expanded') === 'true'");
    await evaluate("Array.from(document.querySelectorAll('.workspace-log-filters button')).find(b=>b.textContent==='ERROR').click()");
    await waitFor("document.querySelector('[role=log]').innerText.includes('No events match this filter')");
    await evaluate("Array.from(document.querySelectorAll('.workspace-log-filters button')).find(b=>b.textContent==='All events').click()");
    await waitFor("document.querySelector('[role=log]').innerText.includes('Rust local database discovery started')");
    await captureUI('02-empty-dark-console');
    await evaluate("document.querySelector('button[aria-label=\"Collapse log\"]').click()");
    console.log('PASS: compact activity dock expands, filters errors and restores all log events.');


    await evaluate("(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['dbf'], 'CLIENTS.dbf')); " +
      "transfer.items.add(new File(['skip'], 'notes.txt')); const input = document.querySelector('#source input[type=file]'); " +
      "input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await waitFor("document.body.innerText.includes('CLIENTS.dbf') && document.body.innerText.includes('.txt')");
    await evaluate("(() => { const input = document.querySelector('#previewRows'); " +
      "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '37'); " +
      "input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    for (const code of codes) {
      await choose(code);
      const source = "Choose files";
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(catalog[source][code]) + ')'), true);
      assert.equal(await evaluate("document.querySelector('#previewRows').value"), '37', code + ': preview setting retained');
      assert.equal(await evaluate("document.body.innerText.includes('CLIENTS.dbf')"), true, code + ': files retained');
      const notice = "Skipped {0} {1}: ";
      const prefix = (catalog[notice][code]).split('{')[0];
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(prefix) + ')'), true, code + ': notice updated');
    }
    console.log('PASS: ten languages; file selection, preview setting and translated notices retained.');
    await choose('en');
    await evaluate("Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('Open 1')).click()");
    await waitFor("document.body.innerText.includes('Relationships') && document.querySelector('input[type=password]') !== null");
    await evaluate("Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Data').click()");
    await waitFor('document.body.innerText.includes(' + JSON.stringify(rawValue) + ')');
    await waitFor("document.body.innerText.includes('clients')");

    const pgPanel = "Array.from(document.querySelectorAll('h3')).find(h => h.textContent.endsWith('PostgreSQL')).parentElement";
    await evaluate("(() => { const input = (" + pgPanel + ").querySelector('input[type=password]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'profile-password-test'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Find database servers')).click()");
    await waitFor("Array.from(document.querySelectorAll('button')).some(b => b.textContent.includes('Find database servers') && !b.disabled)");
    await evaluate("(() => { const select = Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'local-pg')); select.value = 'local-pg'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Use for import')).click()");
    assert.equal(await evaluate('(' + pgPanel + ').querySelector("input[type=password]").value'), 'profile-password-test');
    assert.equal(await evaluate("JSON.stringify(localStorage).includes('profile-password-test')"), false);
    console.log('PASS: rescanning and selecting the same endpoint preserves the password without persisting it.');
    await captureUI('03-session-dark');
    await clickTheme('Light theme');await waitFor('!' + isDark);
    await captureUI('04-session-light');
    await captureUI('05-session-compact',900,1000);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'),true,'compact workspace stays within the viewport');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await clickTheme('Dark theme');await waitFor(isDark);

    const requestCount = apiRequests.length;
    for (const code of codes) {
      await choose(code);
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(rawValue) + ')'), true, code + ': data unchanged');
      const source = "Relationships";
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(catalog[source][code]) + ')'), true, code + ': session labels');
      assert.equal(await evaluate("localStorage.getItem('dbf-inspector:last-session')"), 'i18n-smoke');
    }
    await choose('en');
    for (const label of ['Light theme', 'Dark theme']) {
      await clickTheme(label);
      await waitFor(label === 'Dark theme' ? isDark : '!' + isDark);
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(rawValue) + ')'), true, 'theme toggle retains the open data view');
    }
    assert.equal(apiRequests.length, requestCount, 'language and theme changes do not reupload files or rebuild export plans');
    await captureUI('06-transfer-dark',1440,1000,'#transfer');
    const targetSelect = "Array.from(document.querySelectorAll('#transfer select')).find(s => Array.from(s.options).some(o => o.value === 'postgres'))";
    assert.deepEqual(await evaluate('Array.from((' + targetSelect + ').options, o => o.value).sort()'), ['mongo', 'mssql', 'mysql', 'postgres', 'redis']);
    await evaluate("(() => {const s="+targetSelect+";s.value='redis';s.dispatchEvent(new Event('change',{bubbles:true}));})()");
    const redisPanel="Array.from(document.querySelectorAll('h3')).find(h=>h.textContent==='Redis').parentElement";
    await waitFor('('+redisPanel+').innerText.includes("row:<recno>")');
    await evaluate("Array.from(("+redisPanel+").querySelectorAll('button')).find(b=>b.textContent.includes('Test connection')).click()");
    await waitFor('('+redisPanel+').innerText.includes("redis-test")');
    await evaluate("Array.from(("+redisPanel+").querySelectorAll('button')).find(b=>b.textContent.includes('→')).click()");
    await waitFor('('+redisPanel+').innerText.includes("Written: 1; skipped: 0.")');
    assert.equal(redisPayloads.length,1);assert.equal(redisPayloads[0].uri,'redis://localhost:6379/0');assert.equal(redisPayloads[0].prefix,'data');assert.equal(redisPayloads[0].writeMode,'new');
    assert.equal((await evaluate("localStorage.getItem('dbf-inspector:native-target') || ''")).includes('redis://'),false);
    console.log('PASS: Redis hash plan, Rust connection test, import polling and written/skipped result.');
    for (const dialect of ['postgres', 'mssql']) {
      const label = dialect === 'postgres' ? 'PostgreSQL' : 'MSSQL';
      await evaluate("(() => { const s = " + targetSelect + "; s.value = " + JSON.stringify(dialect) + "; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
      const panel = "Array.from(document.querySelectorAll('h3')).find(h => h.textContent.endsWith(" + JSON.stringify(label) + ")).parentElement";
      await waitFor('(' + panel + ').innerText.includes("clients")');
      assert.equal(await evaluate('(' + panel + ').querySelector("input[type=number]").value'), dialect === 'postgres' ? '5544' : '1433');
      await evaluate("Array.from((" + panel + ").querySelectorAll('button')).find(b => b.textContent.includes('Load database list')).click()");
      await waitFor('(' + panel + ').querySelector(' + JSON.stringify('select[aria-label="Available databases"]') + ')?.options.length === 3');
      await evaluate("(() => { const select = (" + panel + ").querySelector('select[aria-label=\"Available databases\"]'); select.value='legacy_db'; select.dispatchEvent(new Event('change',{bubbles:true})); })()");

      await evaluate("Array.from((" + panel + ").querySelectorAll('button')).find(b => b.textContent.includes('Test connection')).click()");
      await waitFor('(' + panel + ').innerText.includes(' + JSON.stringify(dialect + '-test') + ')');
      await evaluate("Array.from((" + panel + ").querySelectorAll('button')).find(b => b.textContent.includes('→')).click()");
      await waitFor('(' + panel + ').innerText.includes("done")');

      await evaluate("Array.from((" + panel + ").querySelectorAll('button')).find(b => b.textContent.includes('View structure')).click()");
      await waitFor('(' + panel + ').innerText.includes("clients_existing")');
      await evaluate("Array.from((" + panel + ").querySelectorAll('summary')).find(s => s.textContent.includes('clients_existing')).click()");
      await waitFor('(' + panel + ').innerText.includes("ID_native") && (' + panel + ').innerText.includes("bigint")');
      await evaluate("(() => { const original=URL.createObjectURL; URL.createObjectURL=blob=>{window.__schemaBlob=blob;return original(blob);}; HTMLAnchorElement.prototype.click=function(){}; })()");
      await evaluate("Array.from((" + panel + ").querySelectorAll('button')).find(b => b.textContent.includes('Download structure .json')).click()");
      const schemaJson=await evaluate('window.__schemaBlob.text()');const schema=JSON.parse(schemaJson);assert.equal(schema.database,'legacy_db');assert.equal(schema.objects[0].columns[0].name,'ID_native');assert.equal(schemaJson.includes('profile-password-test'),false);assert.equal('connection' in schema,false);
      await evaluate("(() => { const input=Array.from((" + panel + ").querySelectorAll('label')).find(l=>l.textContent.trim()==='Database').querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'archive_db');input.dispatchEvent(new Event('input',{bubbles:true})); })()");
      await waitFor('!(' + panel + ').innerText.includes("clients_existing")');
      await evaluate("(() => { const input=Array.from((" + panel + ").querySelectorAll('label')).find(l=>l.textContent.trim()==='Database').querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'legacy_db');input.dispatchEvent(new Event('input',{bubbles:true})); })()");
      const sent = sqlPayloads.find(p => p.dialect === dialect);
      assert.ok(sent, dialect + ': import was sent');
      assert.equal(sent.body.database, 'legacy_db'); if (dialect === 'postgres') { assert.equal(sent.body.host, '127.0.0.1'); assert.equal(sent.body.port, 5544); } assert.equal(sent.body.writeMode, 'append'); assert.equal(sent.body.encrypt, true);
      await waitFor("document.querySelector('[role=log]').innerText.includes('[SQL][CLIENTS.dbf][DONE:')");
    }
    assert.equal(await evaluate("localStorage.getItem('dbf-inspector:export-target')"), 'mssql');
    console.log('PASS: native structure inspection, column metadata, JSON export without credentials and stale-report hiding.');
    console.log('PASS: five database choices; PostgreSQL/MSSQL connection forms, native plans, import polling, file logs and saved target.');
    const mssqlPanel = "Array.from(document.querySelectorAll('h3')).find(h => h.textContent.endsWith('MSSQL')).parentElement";
    missingImport = true;
    await evaluate("Array.from((" + mssqlPanel + ").querySelectorAll('button')).find(b => b.textContent.includes('→')).click()");
    await waitFor('(' + mssqlPanel + ').innerText.includes("The server no longer has this import status")');
    const polls = () => apiRequests.filter(r => r.startsWith('GET ') && r.includes('/sql/mssql/import/')).length;
    const stopped = polls(); await sleep(1200); assert.equal(polls(), stopped, 'missing imports stop polling instead of retrying forever');
    assert.equal(await evaluate("Array.from((" + mssqlPanel + ").querySelectorAll('button')).find(b => b.textContent.includes('→')).disabled"), false);
    missingImport = false;
    console.log('PASS: a missing import stops polling, explains that the database must be checked and releases the import controls.');

    await evaluate("(() => { const s = " + targetSelect + "; s.value = 'mysql'; s.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await choose('ja');
    await send('Page.reload');
    await waitFor("document.documentElement.lang === 'ja' && document.body.innerText.includes('CLIENTS.dbf')");
    assert.equal(await evaluate("document.querySelector('select').value"), 'ja');
    console.log('PASS: active session and data view retained; Japanese language and session restored after reload.');
    assert.equal(await evaluate(isDark), true, 'dark theme restored after reload');
    assert.equal(await evaluate('document.documentElement.style.colorScheme'), 'dark');
    await clickTheme(catalog["Light theme"].ja);
    await waitFor('!' + isDark);
    await send('Page.reload');
    await waitFor("document.querySelector('select')?.value === 'ja' && document.body.innerText.includes('CLIENTS.dbf')");
    assert.equal(await evaluate(isDark), false, 'light theme restored after reload');
    assert.equal(await evaluate('document.documentElement.style.colorScheme'), 'light');
    assert.equal(await evaluate("localStorage.getItem('dbf-inspector:theme')"), 'light');
    console.log('PASS: both themes persist after reload; switching themes retains the active session.');
    assert.deepEqual(exceptions, []);
    console.log('PASS: no browser runtime exceptions.');
  } finally {
    if (socket) socket.close();
    if (browser) browser.kill();
    await new Promise((resolve) => server.close(resolve));
    // Only remove this test's fresh profile under the project's cache directory.
    if (path.dirname(profile) === cache && path.basename(profile).startsWith('i18n-browser-')) {
      await sleep(300);
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* Browser may still hold a cache file. */ }
    }
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
