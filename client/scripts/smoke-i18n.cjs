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
const rawValue = 'Клієнт 客户 {0}';
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
        if (request.url.includes('/mysql/plan')) data = { tables: [], foreignKeys: [], warnings: [], quality: [] };
        if (request.url.includes('/mongo/plan')) data = { collections: [], references: [], warnings: [], quality: [] };
        void send('Fetch.fulfillRequest', { requestId, responseCode: 200,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' },
            { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: '*' },
            { name: 'Access-Control-Allow-Methods', value: 'GET,POST,PATCH,DELETE,OPTIONS' }],
          body: Buffer.from(request.method === 'OPTIONS' ? '{}' : JSON.stringify(data)).toString('base64'),
        }).catch((error) => exceptions.push(error.message));
      }
    });
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: 'http://127.0.0.1:3000/*', requestStage: 'Request' }] });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
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
    await send('Page.navigate', { url });
    await waitFor("document.querySelector('select')?.options.length === 10");
    assert.deepEqual(await evaluate("Array.from(document.querySelector('select').options, (option) => option.value)"), codes);
    await choose('en');
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
    await evaluate("(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['dbf'], 'CLIENTS.dbf')); " +
      "transfer.items.add(new File(['skip'], 'notes.txt')); const input = document.querySelector('input[type=file]'); " +
      "input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()");
    await waitFor("document.body.innerText.includes('CLIENTS.dbf') && document.body.innerText.includes('.txt')");
    await evaluate("(() => { const input = document.querySelector('#previewRows'); " +
      "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '37'); " +
      "input.dispatchEvent(new Event('input', { bubbles: true })); })()");
    for (const code of codes) {
      await choose(code);
      const source = 'Вибрати файли';
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(code === 'uk' ? source : catalog[source][code]) + ')'), true);
      assert.equal(await evaluate("document.querySelector('#previewRows').value"), '37', code + ': preview setting retained');
      assert.equal(await evaluate("document.body.innerText.includes('CLIENTS.dbf')"), true, code + ': files retained');
      const notice = 'Пропущено {0} {1}: ';
      const prefix = (code === 'uk' ? notice : catalog[notice][code]).split('{')[0];
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(prefix) + ')'), true, code + ': notice updated');
    }
    console.log('PASS: ten languages; file selection, preview setting and translated notices retained.');
    await choose('en');
    await evaluate("Array.from(document.querySelectorAll('button')).find((button) => button.textContent.includes('Open 1')).click()");
    await waitFor("document.body.innerText.includes('Relationships') && document.querySelector('input[type=password]') !== null");
    await evaluate("Array.from(document.querySelectorAll('button')).find((button) => button.textContent.trim() === 'Data').click()");
    await waitFor('document.body.innerText.includes(' + JSON.stringify(rawValue) + ')');
    const requestCount = apiRequests.length;
    for (const code of codes) {
      await choose(code);
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(rawValue) + ')'), true, code + ': data unchanged');
      const source = "Зв'язки";
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(code === 'uk' ? source : catalog[source][code]) + ')'), true, code + ': session labels');
      assert.equal(await evaluate("localStorage.getItem('dbf-inspector:last-session')"), 'i18n-smoke');
    }
    await choose('en');
    for (const label of ['Light theme', 'Dark theme']) {
      await clickTheme(label);
      await waitFor(label === 'Dark theme' ? isDark : '!' + isDark);
      assert.equal(await evaluate('document.body.innerText.includes(' + JSON.stringify(rawValue) + ')'), true, 'theme toggle retains the open data view');
    }
    assert.equal(apiRequests.length, requestCount, 'language and theme changes do not reupload files or rebuild export plans');
    await choose('ja');
    await send('Page.reload');
    await waitFor("document.documentElement.lang === 'ja' && document.body.innerText.includes('CLIENTS.dbf')");
    assert.equal(await evaluate("document.querySelector('select').value"), 'ja');
    console.log('PASS: active session and data view retained; Japanese language and session restored after reload.');
    assert.equal(await evaluate(isDark), true, 'dark theme restored after reload');
    assert.equal(await evaluate('document.documentElement.style.colorScheme'), 'dark');
    await clickTheme(catalog['Світла тема'].ja);
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
