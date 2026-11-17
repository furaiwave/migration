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
const profile = fs.mkdtempSync(path.join(cache, 'database-migration-browser-'));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const errors = [];
const requests = [];
const sourceObject = { id: 'items', schema: 'public', name: 'items', format: 'rows', columns: [{ name: 'id', kind: 'integer', precision: 19, nullable: false }] };
let planCount = 0, jobCount = 0, activeJob, polls = 0, holdJob = false, lastPlan, missingJob = false;
let browser, socket;
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
    const url = 'http://127.0.0.1:' + server.address().port;
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const portFile = path.join(profile, 'DevToolsActivePort');
    for (let i = 0; !fs.existsSync(portFile) && i < 100; i++) await sleep(100);
    if (!fs.existsSync(portFile)) throw new Error('Browser did not start');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    socket = new WebSocket(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
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
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params;
        const pathname = new URL(request.url).pathname;
        let data = {}, responseCode = 200;
        if (request.method !== 'OPTIONS') {
          requests.push({ method: request.method, pathname });
          if (pathname.endsWith('/catalog')) data = { objects: [sourceObject] };
          else if (pathname.endsWith('/plan')) {
            const body = JSON.parse(request.postData);
            lastPlan = body;
            assert.equal(body.source.password, 'source-browser-secret');
            assert.equal(body.target.uri, 'mongodb://target-browser-secret@localhost');
            data = { id: 'plan-' + (++planCount), expiresAt: new Date(Date.now() + 900000).toISOString(), sourceEngine: body.source.engine, targetEngine: body.target.engine,
              redisPrefix: body.redisPrefix, objects: [{ source: sourceObject, targetName: body.objects[0].targetName, targetSchema: '', columns: sourceObject.columns.map(column => ({ ...column, targetType: 'BSON integer' })) }],
              warnings: ['Only new destination objects are created.', 'Indexes and constraints are not recreated.'] };
          } else if (pathname.endsWith('/start')) {
            polls = 0; responseCode = 202;
            activeJob = { id: 'job-' + (++jobCount), state: 'running', phase: 'copying', read: 0, written: 0, skipped: 0, startedAt: new Date().toISOString(), warnings: [] };
            data = activeJob;
          } else if (pathname.includes('/jobs/')) {
            if (missingJob) { responseCode = 404; data = { message: 'Migration job not found. Check the destination before retrying.' }; }
            else {
              if (request.method === 'DELETE') activeJob = { ...activeJob, state: 'cancelled', phase: 'finished', written: 1, read: 1, error: 'Migration cancelled', warnings: ['Partial results remain in the destination.'] };
              else if (!holdJob && ++polls >= 2 && activeJob.state === 'running') activeJob = { ...activeJob, state: 'done', phase: 'finished', read: 2, written: 2 };
              data = activeJob;
            }
          }
        }
        void send('Fetch.fulfillRequest', { requestId, responseCode, responseHeaders: [
          { name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' },
          { name: 'Access-Control-Allow-Headers', value: '*' }, { name: 'Access-Control-Allow-Methods', value: 'GET,POST,DELETE,OPTIONS' },
        ], body: Buffer.from(JSON.stringify(data)).toString('base64') }).catch(error => errors.push(error.message));
      }
    });
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    const waitFor = async expression => {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(100); }
      throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
    };
    const click = async text => { await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === " + JSON.stringify(text) + ").click()"); };
    const setInput = async (selector, value) => {
      await evaluate("(() => { const input = document.querySelector(" + JSON.stringify(selector) + "); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input," + JSON.stringify(value) + "); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    };
    const select = async (selector, value) => {
      await evaluate("(() => { const input = document.querySelector(" + JSON.stringify(selector) + "); input.value=" + JSON.stringify(value) + "; input.dispatchEvent(new Event('change', { bubbles: true })); })()");
    };
    await send('Runtime.enable'); await send('Page.enable');
    await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('dbf-inspector:language:v2','en')" });
    await send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:*/dbf/*', requestStage: 'Request' }] });
    await send('Page.navigate', { url });
    await waitFor("document.querySelector('main select')?.value === 'files'");
    assert.equal(await evaluate("document.querySelector('#database-migration') === null"), true, 'Table files are the default source');
    await select('main > label select', 'database');
    await waitFor("document.querySelectorAll('#database-migration fieldset').length === 2");
    for (const index of [1, 2]) assert.deepEqual(await evaluate("Array.from(document.querySelector('#database-migration fieldset:nth-child(" + index + ") select').options).map(option => option.value)"), ['mysql','mongo','postgres','mssql','redis']);
    await setInput('#database-migration fieldset:first-child input:nth-of-type(1)', 'localhost');
    // Address inputs by their labels to avoid coupling to layout or shared input internals.
    await setInput('#database-migration fieldset:first-child > label:nth-of-type(2) input', 'user');
    await setInput('#database-migration fieldset:first-child input[type=password]', 'source-browser-secret');
    await setInput('#database-migration fieldset:first-child > label:nth-of-type(4) input', 'source_db');
    await select('#database-migration fieldset:last-child select', 'mongo');
    await waitFor("document.querySelector('#database-migration fieldset:last-child input[type=password]') !== null");
    await setInput('#database-migration fieldset:last-child input[type=password]', 'mongodb://target-browser-secret@localhost');
    await setInput('#database-migration fieldset:last-child > label:last-child input', 'target_db');
    await click('Load structure'); await waitFor("document.querySelector('#database-migration table tbody input[type=checkbox]') !== null");
    await evaluate("document.querySelector('#database-migration table tbody input[type=checkbox]').click()");
    await setInput('#database-migration table tbody input:not([type=checkbox])', 'renamed_items');
    await click('Build plan'); await waitFor("document.body.innerText.includes('Plan valid until')");
    assert.equal(lastPlan.objects[0].targetName, 'renamed_items');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Start migration').disabled"), true);
    await evaluate("document.querySelector('#review input[type=checkbox]').click()");
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'mobile layout does not overflow');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    const screenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(cache, 'database-migration.png'), Buffer.from(screenshot.data, 'base64'));
    await click('Start migration'); await waitFor("document.body.innerText.includes('Migration completed')");
    assert.equal(await evaluate("JSON.stringify(localStorage).includes('browser-secret')"), false);
    assert.equal(await evaluate("document.body.innerText.includes('written: 2')"), true);
    console.log('PASS: Table-file default, all five engines, rename, review gate, mobile layout, start/progress and credential privacy.');
    holdJob = true;
    await click('Build plan'); await waitFor("document.querySelector('#review input[type=checkbox]') !== null");
    await evaluate("document.querySelector('#review input[type=checkbox]').click()");
    await click('Start migration'); await waitFor("document.querySelector('main > label select').disabled");
    await send('Page.reload');
    await waitFor("document.body.innerText.includes('Migration running') && document.querySelector('main > label select').value === 'database'");
    assert.equal(await evaluate("document.querySelector('#database-migration input[type=password]').value"), '');
    await click('Stop'); await waitFor("document.body.innerText.includes('Migration cancelled')");
    await waitFor("!document.querySelector('main > label select').disabled");
    assert.equal(await evaluate("document.body.innerText.includes('Partial results remain')"), true);
    console.log('PASS: refresh restores the job without credentials; cancellation exposes partial results and releases controls.');
    missingJob = true; await send('Page.reload');
    await waitFor("document.body.innerText.includes('Migration job not found')");
    await waitFor("!document.querySelector('main > label select').disabled");
    assert.equal(await evaluate("localStorage.getItem('dbf-inspector:database-migration-job')"), null);
    assert.deepEqual(errors, []);
    console.log('PASS: missing jobs release controls, clear stale IDs and show an actionable error; no browser exceptions.');
  } finally {
    if (socket) socket.close();
    if (browser) browser.kill();
    await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(profile);
    if (resolved.startsWith(path.resolve(cache) + path.sep) && path.basename(resolved).startsWith('database-migration-browser-')) {
      await sleep(500);
      try { fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* A browser subprocess may still hold a cache file. */ }
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
