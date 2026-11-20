const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const cache = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const profile = fs.mkdtempSync(path.join(cache, 'sql-dump-browser-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, socket;
const errors = [], requests = [];
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

    await send('Runtime.enable'); await send('Network.enable'); await send('Page.enable');
    if(process.env.UI_REVIEW) await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:'dark'}]});
    await send('Page.navigate', { url: 'http://127.0.0.1:' + server.address().port });
    await waitFor("!!document.querySelector('[data-workspace-link=dump]')");
    await captureUI('desktop-files-dark');
    await evaluate("document.querySelector('[data-workspace-link=dump]').click()");
    await waitFor("!!document.querySelector('input[accept*=sql]')");
    await captureUI('desktop-dump-empty');
    const upload = async sql => evaluate("(()=>{const input=document.querySelector('input[accept*=sql]');const data=new DataTransfer();data.items.add(new File([" + JSON.stringify(sql) + "],'schema.sql',{type:'application/sql'}));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await upload('CREATE TABLE parent(id int PRIMARY KEY); CREATE TABLE child(id int PRIMARY KEY, p int REFERENCES parent(id)); CREATE TABLE unrelated(id int);');
    await waitFor("document.querySelectorAll('article').length === 3");
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] g[role=button]').length"), 3);
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] > path').length"), 1);
    await evaluate("Array.from(document.querySelectorAll('article button')).find(b=>b.textContent==='child').click()");
    await waitFor("document.querySelector('article button[aria-pressed=true]')?.textContent === 'child'");
    assert.equal(await evaluate("document.querySelectorAll('article strong[title=\"Foreign key\"]').length"), 1);

    // A table search must affect the cards, links and diagram together.
    const filter = async value => evaluate("(()=>{const input=document.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input," + JSON.stringify(value) + ");input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    await filter('unrelated');
    await waitFor("document.querySelectorAll('article').length === 1");
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] g[role=button]').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] > path').length"), 0);
    await filter('does-not-exist');
    await waitFor("document.querySelectorAll('article').length === 0");
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] g[role=button]').length"), 0);
    await filter('parent');
    await waitFor("document.querySelectorAll('article').length === 2");
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] > path').length"), 1);
    assert.equal(await evaluate("document.querySelector('svg[role=group] > path title').textContent.includes('\\u2192')"), true);
    await evaluate("document.querySelector('svg[role=group] g[aria-label=child]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))");
    await waitFor("document.querySelector('article button[aria-pressed=true]')?.textContent === 'child'");
    assert.equal(await evaluate("document.querySelector('input[type=search]').value"), '');

    // Localized labels must contain real Unicode rather than question marks.
    await evaluate("(()=>{const input=document.querySelector('header select');input.value='uk';input.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("document.documentElement.lang === 'uk'");
    assert.equal(await evaluate("document.querySelector('input[accept*=sql]').closest('section').querySelector('h2').textContent"), 'SQL-\u0434\u0430\u043c\u043f');
    await evaluate("(()=>{const input=document.querySelector('header select');input.value='en';input.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("document.documentElement.lang === 'en'");

    // A worker response queued before cancellation must not restore stale results.
    await evaluate("window.__RealDumpWorker=window.Worker; window.__dumpWorkers=[]; window.Worker=class{constructor(){window.__dumpWorkers.push(this);}postMessage(){}terminate(){this.terminated=true;}}");
    await upload('CREATE TABLE stale(id int);');
    await waitFor("!!document.querySelector('[role=status]')");
    assert.equal(await evaluate("document.querySelector('[role=status]').textContent"), 'Reading SQL dump\u2026');
    await evaluate("Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Cancel').click()");
    await waitFor("!document.querySelector('input[accept*=sql]').disabled");
    assert.equal(await evaluate("window.__dumpWorkers[0].terminated"), true);
    await evaluate("window.__dumpWorkers[0].onmessage({data:{schema:{tables:[{name:'stale',columns:[]}],links:[]}}})");
    assert.equal(await evaluate("document.querySelectorAll('article').length"), 0);
    await evaluate("window.Worker=class{constructor(){window.__dumpWorkers.push(this);}postMessage(){throw new Error('send failed');}terminate(){this.terminated=true;}}");
    await upload('CREATE TABLE failed(id int);');
    await waitFor("Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('send failed'))");
    assert.equal(await evaluate("window.__dumpWorkers.at(-1).terminated"), true);
    assert.equal(await evaluate("document.querySelector('input[accept*=sql]').disabled"), false);
    await evaluate("window.Worker=window.__RealDumpWorker");

    await evaluate("(()=>{const input=document.querySelector('input[accept*=sql]');const data=new DataTransfer();data.items.add(new File([new Uint8Array([0xc3,0x28])],'invalid.sql'));input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await waitFor("Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('not valid UTF-8'))");

    await upload('PGDMPinvalid');
    await waitFor("Array.from(document.querySelectorAll('[role=alert]')).some(e=>e.textContent.includes('plain-text SQL'))");
    assert.equal(await evaluate("document.querySelectorAll('article').length"), 0);

    // The unresolved parent belongs to custom, not the existing public table.
    await upload('CREATE TABLE parent(id int PRIMARY KEY); SET search_path=custom; CREATE TABLE child(p int REFERENCES parent);');
    await waitFor("document.querySelectorAll('article').length === 2");
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] > path').length"), 0);
    assert.equal(await evaluate("document.body.innerText.includes('Referenced table is not included in this dump.')"), true);
    await evaluate("Array.from(document.querySelectorAll('article button')).find(button=>button.textContent==='parent').click()");
    await waitFor("document.querySelector('article button[aria-pressed=true]')?.textContent === 'parent'");
    assert.equal(await evaluate("document.querySelectorAll('article').length"), 1);
    assert.equal(await evaluate("document.body.innerText.includes('No declared foreign keys found for this selection.')"), true);

    // Changing a format reparses the selected File without uploading it again.
    await upload('CREATE TABLE "Parent"("ID" int, PRIMARY KEY("id")); CREATE TABLE child("P" int, FOREIGN KEY("p") REFERENCES "parent"("id"));');
    await waitFor("document.querySelectorAll('article').length === 2");
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] > path').length"), 0);
    const format = async value => evaluate("(()=>{const input=document.querySelector('input[accept*=sql]').closest('section').querySelector('select');input.value=" + JSON.stringify(value) + ";input.dispatchEvent(new Event('change',{bubbles:true}));})()");
    await format('sqlite');
    await waitFor("document.querySelectorAll('svg[role=group] > path').length === 1");
    assert.equal(await evaluate("document.querySelectorAll('article strong[title=\"Primary key\"]').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('article strong[title=\"Foreign key\"]').length"), 1);
    await format('postgres');
    await waitFor("document.querySelectorAll('article').length === 2 && document.querySelectorAll('svg[role=group] > path').length === 0");
    await format('auto');
    await waitFor("document.querySelectorAll('article').length === 2 && !document.querySelector('input[accept*=sql]').disabled");

    await upload('CREATE TABLE parent(id int PRIMARY KEY); CREATE TABLE child(id int); ALTER TABLE child ADD COLUMN parent_id integer REFERENCES parent(id);');
    await waitFor("document.querySelectorAll('article').length === 2");
    assert.equal(await evaluate("document.querySelectorAll('article strong[title=\"Foreign key\"]').length"), 1);
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] > path').length"), 1);
    await upload('CREATE TABLE parent(id int PRIMARY KEY); CREATE TABLE child(p int REFERENCES parent(id)); DROP TABLE child; CREATE TABLE child(fresh text);');
    await waitFor("Array.from(document.querySelectorAll('article')).some(table=>table.innerText.includes('fresh'))");
    assert.equal(await evaluate("document.querySelectorAll('svg[role=group] > path').length"), 0);

    await upload('CREATE TABLE lone(id integer);');
    await waitFor("document.querySelectorAll('article').length === 1");
    assert.equal(await evaluate("document.body.innerText.includes('No declared foreign keys found for this selection.')"), true);

    await captureUI('desktop-dump-dark', 1440, 1000);
    if (process.env.UI_REVIEW) {
      await send('Emulation.setDeviceMetricsOverride', {width:390,height:844,deviceScaleFactor:1,mobile:false});
      await sleep(100);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'),true,'SQL workspace does not overflow a narrow window');
      await captureUI('desktop-dump-mobile',390,844);
      await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    }

    await evaluate("(()=>{const input=document.querySelector('input[accept*=sql]');const transfer=new DataTransfer();transfer.items.add(new File(['CREATE TABLE dropped_file(id int);'],'dropped.sql',{type:'application/sql'}));input.closest('.workspace-dump-upload').dispatchEvent(new DragEvent('drop',{dataTransfer:transfer,bubbles:true,cancelable:true}));})()");
    await waitFor("Array.from(document.querySelectorAll('article button')).some(table=>table.textContent==='dropped_file')");

    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    console.log('PASS: SQL dump upload, filtering, format changes, unresolved cross-schema links, ALTER/DROP snapshots, localization, cancellation, worker cleanup and decoding errors; no uploads or browser exceptions.');
  } finally {
    if (socket) socket.close();
    if (browser) browser.kill();
    await new Promise(resolve => server.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
