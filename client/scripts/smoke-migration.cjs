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
let nativeInspections = 0, brokenInspection = false, delayCancellation = false, heldCancellation;
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
    const fulfill=(requestId,data,responseCode=200)=>send('Fetch.fulfillRequest',{requestId,responseCode,responseHeaders:[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'*'},{name:'Access-Control-Allow-Headers',value:'*'},{name:'Access-Control-Allow-Methods',value:'GET,POST,DELETE,OPTIONS'}],body:Buffer.from(JSON.stringify(data)).toString('base64')});
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
          if (pathname.endsWith('/native/inspect')) {
            const body = JSON.parse(request.postData);
            nativeInspections++;
            if (brokenInspection) { responseCode = 400; data = { message: 'Metadata access denied' }; }
            else data = { engine: body.engine, database: body.database, elapsedMs: 5, truncated: body.database === 'partial_db', objects: body.database === 'empty_db' ? [] : body.engine === 'postgres' || body.engine === 'mssql' ? [
              { schema: 'public', name: 'items', kind: 'table', columns: [{name: 'id', dataType: 'bigint', nullable: false, ordinal: 1}, {name: 'email_address', dataType: 'text', nullable: true, ordinal: 2}] },
              { schema: 'audit', name: 'items', kind: 'table', columns: [{name: 'audit_id', dataType: 'integer', nullable: false, ordinal: 1}] },
              { schema: 'public', name: 'summary', kind: 'view', columns: [] },
            ] : [{ schema: body.database, name: 'destination_items', kind: body.engine === 'mongo' ? 'collection' : 'table', columns: [] }] };
          } else if (pathname.endsWith('/catalog')) {
            const body = JSON.parse(request.postData);
            data = { objects: body.engine === 'redis' ? [{id:'keys',schema:'',name:'keys',format:'redis',columns:[]}] : [sourceObject] };
          }
          else if (pathname.endsWith('/plan')) {
            const body = JSON.parse(request.postData);
            lastPlan = body;
            if (body.mode === 'upgrade') {
              assert.equal(body.source.engine, body.target.engine);
            } else {
              assert.equal(body.source.password, 'source-browser-secret');
              assert.equal(body.target.uri, 'mongodb://target-browser-secret@localhost');
            }
            data = { id: 'plan-' + (++planCount), expiresAt: new Date(Date.now() + 900000).toISOString(), sourceEngine: body.source.engine, targetEngine: body.target.engine,
              mode: body.mode, ...(body.mode === 'upgrade' ? { sourceVersion: { family: body.source.engine, version: '5.6.51' }, targetVersion: { family: body.target.engine, version: '8.0.40' } } : {}),
              redisPrefix: body.redisPrefix, objects: [{ source: sourceObject, targetName: body.objects[0].targetName, targetSchema: '', columns: sourceObject.columns.map(column => ({ ...column, targetType: 'BSON integer' })) }],
              warnings: ['Only new destination objects are created.', 'Indexes and constraints are not recreated.'] };
          } else if (pathname.endsWith('/start')) {
            polls = 0; responseCode = 202;
            activeJob = { id: 'job-' + (++jobCount), state: 'running', phase: 'copying', read: 0, written: 0, skipped: 0, startedAt: new Date().toISOString(), warnings: [] };
            data = activeJob;
          } else if (pathname.includes('/jobs/')) {
            if (missingJob) { responseCode = 404; data = { message: 'Migration job not found. Check the destination before retrying.' }; }
            else {
              if (request.method === 'DELETE' && delayCancellation) {
                delayCancellation=false;
                const snapshot={...activeJob};
                activeJob={...activeJob,state:'done',phase:'finished',read:2,written:2};
                heldCancellation=()=>fulfill(requestId,snapshot);return;
              }
              if (request.method === 'DELETE') activeJob = { ...activeJob, state: 'cancelled', phase: 'finished', written: 1, read: 1, error: 'Migration cancelled', warnings: ['Partial results remain in the destination.'] };
              else if (!holdJob && ++polls >= 2 && activeJob.state === 'running') activeJob = { ...activeJob, state: 'done', phase: 'finished', read: 2, written: 2 };
              data = activeJob;
            }
          }
        }
        void fulfill(requestId,data,responseCode).catch(error => errors.push(error.message));
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
    const go = async page => evaluate("document.querySelector('[data-workspace-link="+page+"]').click()");
    const currentPage = page => "document.querySelector('[data-workspace-link="+page+"]')?.getAttribute('aria-current') === 'page'";
    await waitFor(currentPage('home'));
    assert.equal(await evaluate("document.querySelectorAll('[data-workflow]').length"),3);
    assert.equal(await evaluate("document.querySelectorAll('nav [data-workspace-link]').length"),6);
    assert.equal(await evaluate("document.querySelector('#database-migration') === null"),true,'the homepage does not open a migration form');
    for(const width of [1440,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth + 1'),true,'navigation and cards fit at '+width);
      assert.equal(await evaluate("Array.from(document.querySelectorAll('[data-workflow]')).every(card=>card.scrollWidth <= card.clientWidth + 1)"),true);
      const shot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
      fs.writeFileSync(path.join(cache,width===1440?'navigation-home.png':'navigation-home-mobile.png'),Buffer.from(shot.data,'base64'));
    }
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await evaluate("document.querySelector('[data-workflow=upgrade]').click()");
    await waitFor(currentPage('upgrade'));
    await waitFor("document.querySelector('#database-migration select[aria-label=\"Migration mode\"]').value === 'upgrade'");
    assert.equal(await evaluate("document.querySelector('#database-migration fieldset:first-child legend').textContent"),'Old server');
    assert.equal(await evaluate("document.querySelector('#database-migration h2').textContent"),'Version upgrade');
    assert.equal(await evaluate("document.querySelector('#database-migration fieldset:last-child select').disabled"),true);
    await setInput('#database-migration fieldset:first-child input[type=password]','navigation-password');
    await evaluate('window.scrollTo(0,document.body.scrollHeight)');
    await go('home');await waitFor(currentPage('home'));
    assert.equal(await evaluate('scrollY'),0,'a new workspace opens at the top of its page');
    await evaluate("document.querySelector('[data-workspace-link=upgrade]').focus()");
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await waitFor(currentPage('upgrade'));
    assert.equal(await evaluate("document.querySelector('#database-migration fieldset:first-child input[type=password]').value"),'navigation-password','navigation retains connection edits in memory');
    assert.equal(await evaluate("JSON.stringify(localStorage).includes('navigation-password')"),false);
    await go('home');await waitFor(currentPage('home'));
    await evaluate('history.back()');await waitFor(currentPage('upgrade'));
    await evaluate('history.forward()');await waitFor(currentPage('home'));
    await send('Page.navigate',{url:url+'/?view=upgrade'});
    await waitFor(currentPage('upgrade'));
    await waitFor("document.querySelector('#database-migration select[aria-label=\"Migration mode\"]').value === 'upgrade'");
    await send('Page.reload');
    await waitFor(currentPage('upgrade'));
    assert.equal(await evaluate("document.querySelector('#database-migration select[aria-label=\"Migration mode\"]').value"),'upgrade','deep links retain the workflow after reload');
    assert.equal(await evaluate("document.querySelector('#database-migration input[type=password]').value"),'');
    const upgradeShot=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(path.join(cache,'navigation-upgrade.png'),Buffer.from(upgradeShot.data,'base64'));
    await go('files');await waitFor(currentPage('files'));
    assert.equal(await evaluate("document.querySelector('#source input[type=file]') !== null"),true);
    await go('transfer');await waitFor(currentPage('transfer'));
    await waitFor("document.querySelector('#database-migration select[aria-label=\"Migration mode\"]').value === 'transfer'");
    console.log('PASS: homepage scenarios, persistent navigation, direct upgrade entry, keyboard access, back/forward, reload, in-memory edits and mobile layout.');
    await waitFor("document.querySelectorAll('#database-migration fieldset').length === 2");
    for (const index of [1, 2]) assert.deepEqual(await evaluate("Array.from(document.querySelector('#database-migration fieldset:nth-child(" + index + ") select').options).map(option => option.value)"), ['mysql','mongo','postgres','mssql','redis']);
    const sourceScope = '#database-migration fieldset:first-child';
    const targetScope = '#database-migration fieldset:last-child';
    const sourceTree = sourceScope + ' [role=tree]';
    const scopedClick = async (scope, label) => evaluate("Array.from(document.querySelector(" + JSON.stringify(scope) + ").querySelectorAll('button')).find(button => button.textContent.trim() === " + JSON.stringify(label) + ").click()");
    const key = async (name, code) => {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: code });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: code });
    };
    await select(sourceScope + ' select', 'postgres');
    await setInput(sourceScope + ' > label:nth-of-type(2) input', 'user');
    await setInput(sourceScope + ' input[type=password]', 'source-browser-secret');
    await setInput(sourceScope + ' > label:nth-of-type(4) input', 'active_db');
    await scopedClick(sourceScope, 'View structure');
    await waitFor("document.querySelector(" + JSON.stringify(sourceTree) + ") !== null");
    assert.equal(await evaluate("document.querySelector(" + JSON.stringify(sourceTree + ' [data-kind=database]') + ").dataset.name"), 'active_db');
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll(" + JSON.stringify(sourceTree + ' [data-kind=schema]') + ")).map(node => node.dataset.name)"), ['audit', 'public']);
    assert.equal(await evaluate("document.querySelectorAll(" + JSON.stringify(sourceTree + ' [data-kind=table][data-name=items]') + ").length"), 2, 'identically named tables remain separate across schemas');
    assert.equal(await evaluate("document.querySelectorAll(" + JSON.stringify(sourceTree + ' [tabindex="0"]') + ").length"), 1);
    await evaluate("document.querySelector(" + JSON.stringify(sourceTree + ' [role=treeitem]') + ").focus()");
    await key('ArrowDown', 40);
    assert.equal(await evaluate('document.activeElement.dataset.kind'), 'schema');
    await key('ArrowRight', 39);
    assert.equal(await evaluate('document.activeElement.dataset.kind'), 'table');
    await key('ArrowRight', 39);
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-expanded')"), 'true');
    await key('ArrowRight', 39);
    assert.equal(await evaluate('document.activeElement.dataset.name'), 'audit_id');
    await key('ArrowLeft', 37);
    assert.equal(await evaluate('document.activeElement.dataset.kind'), 'table');
    await key('End', 35);
    assert.equal(await evaluate('document.activeElement.dataset.name'), 'summary');
    await key('Home', 36);
    assert.equal(await evaluate('document.activeElement.dataset.kind'), 'database');
    await scopedClick(sourceScope, 'Expand all');
    await waitFor("document.querySelectorAll(" + JSON.stringify(sourceTree + ' [data-kind=column]') + ").length === 3");
    assert.equal(await evaluate("document.querySelector(" + JSON.stringify(sourceTree) + ").textContent.includes('NOT NULL')"), true);
    await setInput(sourceScope + ' input[type=search]', 'EMAIL_ADDRESS');
    await waitFor("document.querySelectorAll(" + JSON.stringify(sourceTree + ' [data-kind=column]') + ").length === 1");
    assert.deepEqual(await evaluate("Array.from(document.querySelectorAll(" + JSON.stringify(sourceTree + ' [data-kind=schema]') + ")).map(node => node.dataset.name)"), ['public']);
    await setInput(sourceScope + ' input[type=search]', 'no_matching_object');
    await waitFor("document.querySelector(" + JSON.stringify(sourceScope) + ").textContent.includes('No matching objects.')");
    await setInput(sourceScope + ' input[type=search]', '');
    await scopedClick(sourceScope, 'Collapse all');
    assert.equal(await evaluate("document.querySelectorAll(" + JSON.stringify(sourceTree + ' [role=treeitem]') + ").length"), 1);
    await scopedClick(sourceScope, 'Expand all');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), true, 'expanded tree fits the mobile page');
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1150, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector(" + JSON.stringify(sourceScope + ' .schema-browser') + ").scrollIntoView({block:'center'})");
    const treeScreenshot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(cache, 'schema-tree.png'), Buffer.from(treeScreenshot.data, 'base64'));
    const beforeRefresh = nativeInspections;
    await scopedClick(sourceScope, 'Refresh structure');
    await waitFor("document.querySelector(" + JSON.stringify(sourceTree) + ") !== null");
    assert.equal(nativeInspections, beforeRefresh + 1);
    brokenInspection = true;
    await scopedClick(sourceScope, 'Refresh structure');
    await waitFor("document.querySelector(" + JSON.stringify(sourceScope + ' [role=alert]') + ")?.textContent.includes('Metadata access denied')");
    assert.equal(await evaluate("document.querySelector(" + JSON.stringify(sourceTree) + ") === null"), true);
    brokenInspection = false;
    await scopedClick(sourceScope, 'View structure');
    await waitFor("document.querySelector(" + JSON.stringify(sourceTree) + ") !== null");
    await setInput(targetScope + ' > label:nth-of-type(2) input', 'target-user');
    await setInput(targetScope + ' > label:nth-of-type(4) input', 'target_tree_db');
    await scopedClick(targetScope, 'View structure');
    await waitFor("document.querySelector(" + JSON.stringify(targetScope + ' [role=tree] [data-kind=database]') + ")?.dataset.name === 'target_tree_db'");
    assert.equal(await evaluate("document.querySelector(" + JSON.stringify(sourceTree + ' [data-kind=database]') + ").dataset.name"), 'active_db');
    await setInput(sourceScope + ' > label:nth-of-type(4) input', 'empty_db');
    assert.equal(await evaluate("document.querySelector(" + JSON.stringify(sourceTree) + ") === null"), true, 'editing a connection hides stale metadata');
    await scopedClick(sourceScope, 'View structure');
    await waitFor("document.querySelector(" + JSON.stringify(sourceScope) + ").textContent.includes('No accessible objects found.')");
    await setInput(sourceScope + ' > label:nth-of-type(4) input', 'partial_db');
    await scopedClick(sourceScope, 'View structure');
    await waitFor("document.querySelector(" + JSON.stringify(sourceScope) + ").textContent.includes('The structure is partial')");
    assert.equal(await evaluate("JSON.stringify(localStorage).includes('source-browser-secret')"), false);
    console.log('PASS: source/destination schema trees, duplicate table names, column types, keyboard navigation, search, expand/collapse, refresh, errors, empty/partial metadata and mobile layout.');
    await select(sourceScope + ' select', 'mongo');
    await setInput(sourceScope + ' > label:last-of-type input', 'mongo_tree_db');
    await scopedClick(sourceScope, 'View structure');
    await waitFor("document.querySelector(" + JSON.stringify(sourceTree + ' [data-kind=collection]') + ") !== null");
    assert.equal(await evaluate("document.querySelectorAll(" + JSON.stringify(sourceTree + ' [data-kind=schema], ' + sourceTree + ' [data-kind=column]') + ").length"), 0);
    await select(sourceScope + ' select', 'redis');
    await scopedClick(sourceScope, 'View structure');
    await waitFor("document.querySelector(" + JSON.stringify(sourceTree + ' [data-kind=keys]') + ")?.dataset.name === 'keys'");
    assert.equal(await evaluate("document.querySelector(" + JSON.stringify(sourceTree + ' [data-kind=database]') + ").dataset.name"), '0');
    assert.equal(await evaluate("document.querySelectorAll(" + JSON.stringify(sourceTree + ' [data-kind=schema], ' + sourceTree + ' [data-kind=column]') + ").length"), 0);
    console.log('PASS: MongoDB collections and Redis database/key metadata appear without invented SQL schemas or document fields.');
    await select(sourceScope + ' select', 'mysql');
    await setInput('#database-migration fieldset:first-child input:nth-of-type(1)', 'localhost');
    // Address inputs by their labels to avoid coupling to layout or shared input internals.
    await setInput('#database-migration fieldset:first-child > label:nth-of-type(2) input', 'user');
    await setInput('#database-migration fieldset:first-child input[type=password]', 'source-browser-secret');
    await setInput('#database-migration fieldset:first-child > label:nth-of-type(4) input', 'source_db');
    await select('#database-migration fieldset:last-child select', 'mongo');
    await waitFor("document.querySelector('#database-migration fieldset:last-child input[type=password]') !== null");
    await setInput('#database-migration fieldset:last-child input[type=password]', 'mongodb://target-browser-secret@localhost');
    await setInput('#database-migration fieldset:last-child > label:last-of-type input', 'target_db');
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
    console.log('PASS: all five engines, rename, review gate, mobile layout, start/progress and credential privacy.');
    holdJob = true;
    await click('Build plan'); await waitFor("document.querySelector('#review input[type=checkbox]') !== null");
    await evaluate("document.querySelector('#review input[type=checkbox]').click()");
    await click('Start migration'); await waitFor("document.querySelector('[data-workspace-link=home]').getAttribute('aria-disabled') === 'true'");
    const runningJob=await evaluate("localStorage.getItem('dbf-inspector:database-migration-job')");
    await go('home');assert.equal(await evaluate(currentPage('transfer')),true,'active migrations block menu navigation');
    await evaluate('history.back()');await sleep(150);
    assert.equal(await evaluate(currentPage('transfer')),true,'browser back cannot hide an active migration');
    assert.equal(await evaluate("new URL(location.href).searchParams.get('view')"),'transfer');
    assert.equal(await evaluate("localStorage.getItem('dbf-inspector:database-migration-job')"),runningJob);

    await send('Page.reload');
    await waitFor("document.body.innerText.includes('Migration running') && ['transfer','upgrade'].includes(document.querySelector('[data-workspace-link][aria-current=page]')?.dataset.workspaceLink)");
    assert.equal(await evaluate("document.querySelector('#database-migration input[type=password]').value"), '');
    await click('Stop'); await waitFor("document.body.innerText.includes('Migration cancelled')");
    await waitFor("document.querySelector('[data-workspace-link=home]').getAttribute('aria-disabled') !== 'true'");
    assert.equal(await evaluate("document.body.innerText.includes('Partial results remain')"), true);
    console.log('PASS: refresh restores the job without credentials; cancellation exposes partial results and releases controls.');
    missingJob = true; await send('Page.reload');
    await waitFor("document.body.innerText.includes('Migration job not found')");
    await waitFor("document.querySelector('[data-workspace-link=home]').getAttribute('aria-disabled') !== 'true'");
    assert.equal(await evaluate("localStorage.getItem('dbf-inspector:database-migration-job')"), null);
    missingJob = false;
    holdJob = false;
    await select('#database-migration select[aria-label="Migration mode"]', 'upgrade');
    await waitFor("document.querySelector('#database-migration fieldset:last-child select').disabled");
    assert.equal(await evaluate("document.querySelector('#database-migration fieldset:first-child legend').textContent"), 'Old server');
    assert.equal(await evaluate("document.querySelector('#database-migration fieldset:last-child legend').textContent"), 'New server');
    for (const engine of ['mysql', 'mongo', 'postgres', 'mssql', 'redis']) {
      await select('#database-migration fieldset:first-child select', engine);
      await waitFor("document.querySelector('#database-migration fieldset:last-child select').value === '" + engine + "'");
      assert.equal(await evaluate("document.querySelector('#database-migration fieldset:last-child select').disabled"), true);
    }
    assert.equal(await evaluate("document.querySelector('#database-migration').textContent.includes('Key prefix')"), false);
    await select('#database-migration fieldset:first-child select', 'mysql');
    await click('Load structure');
    await waitFor("document.querySelector('#database-migration table tbody input[type=checkbox]') !== null");
    await evaluate("document.querySelector('#database-migration table tbody input[type=checkbox]').click()");
    await click('Build plan');
    await waitFor("document.querySelector('#review')?.textContent.includes('5.6.51')");
    assert.equal(lastPlan.mode, 'upgrade');
    assert.equal(lastPlan.source.engine, lastPlan.target.engine);
    assert.equal(await evaluate("document.querySelector('#review').textContent.includes('8.0.40')"), true);
    assert.equal(await evaluate("Array.from(document.querySelectorAll('button')).find(button => button.textContent.trim() === 'Start migration').disabled"), true);
    await evaluate("document.querySelector('#review input[type=checkbox]').click()");
    await click('Start migration');
    await waitFor("document.body.innerText.includes('Migration completed')");
    holdJob=true;delayCancellation=true;
    await click('Build plan');await waitFor("document.querySelector('#review input[type=checkbox]') !== null");
    await evaluate("document.querySelector('#review input[type=checkbox]').click()");
    await click('Start migration');await waitFor("document.body.innerText.includes('Migration running')");
    await click('Stop');
    await waitFor("document.body.innerText.includes('Migration completed')");
    assert.equal(typeof heldCancellation,'function');
    await heldCancellation();heldCancellation=undefined;await sleep(200);
    assert.equal(await evaluate("document.body.innerText.includes('Migration completed') && document.querySelector('[data-workspace-link=home]').getAttribute('aria-disabled') !== 'true'"),true,'a delayed running cancellation reply must not revive a completed migration');
    holdJob=false;
    console.log('PASS: completed migrations stay completed when an older cancellation reply arrives.');
    await select('#database-migration select[aria-label="Migration mode"]', 'transfer');
    assert.equal(await evaluate("document.querySelector('#review') === null"), true);
    assert.equal(await evaluate("document.querySelector('#database-migration fieldset:last-child select').disabled"), false);
    console.log('PASS: version upgrade synchronizes all five engines, displays detected versions, preserves review gating and can return to transfer mode.');
    await go('home');await waitFor(currentPage('home'));
    await send('Page.reload');await waitFor(currentPage('home'));
    await waitFor("document.querySelector('[data-workspace-link=home]').getAttribute('aria-disabled') !== 'true'");
    assert.equal(await evaluate("document.querySelector('.workspace-home') !== null"),true,'a completed cached job cannot replace the homepage');
    console.log('PASS: active migrations block navigation and browser back; completed job restoration keeps an explicitly selected homepage.');
    assert.deepEqual(errors, []);
    console.log('PASS: missing jobs release controls, clear stale IDs and show an actionable error; no browser exceptions.');
  } finally {
    if (heldCancellation) await heldCancellation().catch(()=>{});
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
