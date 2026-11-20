const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const root = process.env.WEB_TEST_ROOT || path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dbf-web-smoke-'));
const sessions = path.join(temp, 'sessions');
const password = randomBytes(32).toString('hex');
const secret = path.join(temp, 'password');
fs.writeFileSync(secret, password + '\n');
const auth = 'Basic ' + Buffer.from('tester:' + password).toString('base64');
const connector = process.env.DBF_CONNECTOR_BIN || path.resolve(root, '../native/db-connector/target/release', process.platform === 'win32' ? 'db-connector.exe' : 'db-connector');
let child, url, output = '';
async function start() {
  child = spawn(process.execPath, [path.join(root, 'dist/web-main.js')], {
    cwd: root, windowsHide: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', PUBLIC_ORIGIN: 'https://migration.example.test',
      APP_USER: 'tester', APP_PASSWORD: undefined, APP_PASSWORD_FILE: secret,
      DBF_CLIENT_DIR: process.env.WEB_TEST_CLIENT || path.resolve(root, '../client/dist'),
      DBF_SESSION_DIR: sessions, DBF_CONNECTOR_BIN: connector },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Web startup timed out')), 20000);
    const read = (chunk) => {
      output += chunk.toString();
      const match = output.match(/Web app listening on (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { url = match[1]; clearTimeout(timer); resolve(); }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.once('error', err => { clearTimeout(timer); reject(err); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error('Web exited before ready: ' + code)); });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'exit'); child.kill(); await closed; child = undefined;
}
function request(route, options = {}) {
  return fetch(url + route, { ...options, signal: AbortSignal.timeout(20000), headers: { Authorization: auth, ...options.headers } });
}
function dbf() {
  const b = Buffer.alloc(75); b[0] = 3; b[1] = 126; b[2] = 11; b[3] = 15;
  b.writeUInt32LE(1, 4); b.writeUInt16LE(65, 8); b.writeUInt16LE(9, 10);
  b.write('NAME', 32, 'ascii'); b[43] = 67; b[48] = 8; b[64] = 13;
  b[65] = 32; b.write('CLOUD   ', 66, 'ascii'); b[74] = 26; return b;
}
(async () => {
  await start();
  assert.equal((await fetch(url + '/healthz')).status, 200);
  for (const route of ['/', '/dbf/native/servers']) assert.equal((await fetch(url + route)).status, 401);
  assert.equal((await fetch(url + '/dbf/parse-multiple', { method: 'POST' })).status, 401);
  assert.equal((await request('/')).status, 200);
  const page = await (await request('/')).text(); assert.match(page, /<html/);
  const asset = page.match(/src="([^"]+\.js)"/); assert.ok(asset);
  assert.equal((await fetch(url + asset[1])).status, 401);
  assert.equal((await request(asset[1])).status, 200);
  assert.equal((await request('/bad%zz')).status, 404);
  assert.equal((await request('/dbf/native/servers', { headers: { Origin: 'https://other.example.test' } })).status, 403);
  console.log('PASS: web page, assets and API require authentication; health, origin checks and malformed URLs work.');
  assert.equal((await fetch(url + '/dbf/graphql/schema')).status, 401);
  assert.equal((await fetch(url + '/dbf/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '{__typename}' }) })).status, 401);
  const graphqlBody = JSON.stringify({ query: '{__schema {queryType {name} mutationType {name}}}' });
  const graphql = await request('/dbf/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/graphql-response+json' }, body: graphqlBody });
  assert.equal(graphql.status, 200);
  assert.equal(graphql.headers.get('cache-control'), 'no-store');
  assert.deepEqual((await graphql.json()).data, { __schema: { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } } });
  assert.equal((await request('/dbf/graphql', { method: 'POST', headers: { Origin: 'https://other.example.test', 'Content-Type': 'application/json' }, body: graphqlBody })).status, 403);
  assert.equal((await request('/dbf/graphql')).status, 405);
  const schema = await request('/dbf/graphql/schema');
  assert.equal(schema.status, 200);
  assert.match(schema.headers.get('content-type'), /text\/plain/);
  assert.match(await schema.text(), /type Mutation/);
  console.log('PASS: GraphQL schema and execution share authentication, Origin checks and no-store responses; introspection works in the actual web process.');
  const diagnostic = await request('/dbf/native/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ host: '127.0.0.1', port: Number(new URL(url).port) }) });
  assert.equal(diagnostic.status, 200); assert.equal((await diagnostic.json()).status, 'reachable');
  console.log('PASS: the packaged Rust connector performs real TCP diagnostics.');
  const data = new FormData(); data.append('files', new Blob([dbf()]), 'CLOUD.dbf');
  const uploaded = await request('/dbf/parse-multiple', { method: 'POST', body: data });
  assert.equal(uploaded.status, 200); const session = await uploaded.json();
  assert.equal(session.files[0].preview[0].NAME.trim(), 'CLOUD');
  await stop(); output = '';
  // Simulate moving a Windows session volume to Linux.
  const metaPath = path.join(sessions, session.sessionId, 'session.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); meta.files[0].dbf = meta.files[0].dbf.replaceAll('/', '\\');
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  await start();
  const restored = await request('/dbf/session/' + session.sessionId); assert.equal(restored.status, 200);
  assert.equal((await restored.json()).files[0].preview[0].NAME.trim(), 'CLOUD');
  for (const patch of [{ createdAt: 'invalid' }, { manualRels: [null] }, { manualRels: [{ kind: 'manual', sourceField: 'NAME' }] }, { encodings: { 'CLOUD.DBF': 42 } }, { disabledRels: [null] }, { files: [meta.files[0], meta.files[0]] }, { files: null }, { files: [{ ...meta.files[0], dbf: 'tables/missing.dbf' }] }, { files: [{ ...meta.files[0], dbf: '../outside.dbf' }] }]) {
    const id = randomUUID(); fs.mkdirSync(path.join(sessions, id));
    fs.writeFileSync(path.join(sessions, id, 'session.json'), JSON.stringify({ ...meta, ...patch, id }));
    assert.equal((await request('/dbf/session/' + id)).status, 404);
  }
  console.log('PASS: uploaded DBF survives restart; Windows paths restore; damaged and escaping session layouts return 404.');
  assert.equal(output.includes(password), false);
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
  await stop();
  if (path.dirname(temp) === path.resolve(os.tmpdir()) && path.basename(temp).startsWith('dbf-web-smoke-')) fs.rmSync(temp, { recursive: true, force: true });
});
