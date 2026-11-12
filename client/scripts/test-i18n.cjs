const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const catalog = require('../src/i18n/messages.json');
const root = path.join(__dirname, '..');
const languageCodes = ['uk', 'en', 'fr', 'es', 'pl', 'ja', 'ko', 'de', 'sv', 'it'];
const key = 'dbf-inspector:language';
const newSession = 'Нова сесія';

function load(file, globals, imports) {
  const source = readFileSync(path.join(root, file), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, esModuleInterop: true },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports,
    require: (id) => { if (!(id in imports)) throw new Error('Unexpected import: ' + id); return imports[id]; },
    ...globals }, { filename: file });
  return module.exports;
}

function environment({ saved, languages = ['uk-UA'], blocked = false } = {}) {
  const storage = new Map(saved === undefined ? [] : [[key, saved]]);
  const document = { documentElement: { lang: '' } };
  const events = new Map();
  let notifications = 0;
  let unsubscribe;
  const globals = {
    document,
    navigator: { languages, language: languages[0] },
    window: { addEventListener: (name, handler) => events.set(name, handler) },
    localStorage: {
      getItem: (k) => { if (blocked) throw new Error('Storage blocked'); return storage.get(k) ?? null; },
      setItem: (k, value) => { if (blocked) throw new Error('Storage blocked'); storage.set(k, value); },
    },
  };
  const i18n = load('src/i18n/index.ts', globals, {
    './messages.json': catalog,
    react: { useSyncExternalStore: (subscribe, getSnapshot) => {
      unsubscribe = subscribe(() => { notifications++; });
      return getSnapshot();
    } },
  });
  return { i18n, document, storage, events, get notifications() { return notifications; },
    unsubscribe: () => unsubscribe(), load: (file) => load(file, globals, { '@/i18n': i18n }) };
}

const placeholders = (text) => [...text.matchAll(/\{\d+\}/g)].map(([match]) => match).sort().join(',');

test('every message has all nine translations with intact placeholders', () => {
  assert.ok(Object.keys(catalog).length >= 419);
  for (const [source, values] of Object.entries(catalog)) {
    assert.deepEqual(Object.keys(values).sort(), languageCodes.slice(1).sort());
    for (const [code, text] of Object.entries(values)) {
      assert.equal(typeof text, 'string', code + ': ' + source);
      assert.ok(text.trim(), code + ': ' + source);
      assert.equal(placeholders(text), placeholders(source), code + ': ' + source);
    }
  }
});

test('the selector offers exactly the ten requested languages', () => {
  const { i18n } = environment();
  assert.equal(i18n.LANGUAGES.map(({ code }) => code).join(','), languageCodes.join(','));
  for (const code of ['ru', 'zh', 'zh-CN', '', null, undefined]) assert.equal(i18n.isLanguage(code), false);
});

test('saved choice wins; regional browser locales resolve; unsupported choices fall back', () => {
  assert.equal(environment({ saved: 'ja', languages: ['de-DE'] }).i18n.getLanguage(), 'ja');
  assert.equal(environment({ languages: ['fr-CA'] }).i18n.getLanguage(), 'fr');
  assert.equal(environment({ saved: 'ru', languages: ['zh-CN', 'pl-PL'] }).i18n.getLanguage(), 'pl');
  assert.equal(environment({ saved: 'zh', languages: ['ru-RU', 'zh-CN'] }).i18n.getLanguage(), 'uk');
});

test('switching updates subscribers and document language, persists and survives reload', () => {
  const env = environment();
  assert.equal(env.i18n.useLanguage(), 'uk');
  env.i18n.setLanguage('de');
  assert.equal(env.i18n.translate(newSession), 'Neue Sitzung');
  assert.equal(env.document.documentElement.lang, 'de');
  assert.equal(env.storage.get(key), 'de');
  assert.equal(env.notifications, 1);
  env.i18n.setLanguage('de');
  assert.equal(env.notifications, 1);
  env.i18n.setLanguage('ru');
  assert.equal(env.i18n.getLanguage(), 'de');
  assert.equal(environment({ saved: env.storage.get(key) }).i18n.getLanguage(), 'de');
  env.unsubscribe();
  env.i18n.setLanguage('it');
  assert.equal(env.notifications, 1);
});

test('blocked storage still allows switching in memory', () => {
  const env = environment({ blocked: true });
  env.i18n.setLanguage('ko');
  assert.equal(env.i18n.translate(newSession), '새 세션');
  assert.equal(env.document.documentElement.lang, 'ko');
});

test('other windows follow storage changes and recover from invalid values', () => {
  const env = environment();
  env.storage.set(key, 'sv');
  env.events.get('storage')({ key });
  assert.equal(env.i18n.getLanguage(), 'sv');
  env.storage.set(key, 'ru');
  env.events.get('storage')({ key });
  assert.equal(env.i18n.getLanguage(), 'uk');
  env.storage.delete(key);
  env.events.get('storage')({ key: null });
  assert.equal(env.i18n.getLanguage(), 'uk');
});

test('interpolation never translates filenames, database names or nested placeholder content', () => {
  const { i18n } = environment({ saved: 'ja' });
  const data = '客户_Клиенты_{0}.dbf';
  assert.equal(i18n.translate('Прибрати {0}', [data]), data + ' を削除');
  assert.equal(i18n.translate('unknown input'), 'unknown input');
  i18n.setLanguage('uk');
  assert.equal(i18n.translate('Прибрати {0}', [data]), 'Прибрати ' + data);
});

test('metadata and existing errors follow later language changes', () => {
  const env = environment({ saved: 'en' });
  const labels = env.load('src/api/api.types.ts').FIELD_TYPE_LABELS;
  const encodings = env.load('src/lib/encodings.ts').ENCODINGS;
  const cause = new Error('file locked');
  const error = new env.i18n.LocalizedError('Прибрати {0}', ['DATA.dbf'], { cause });
  assert.equal(labels.D, 'Date');
  assert.equal(encodings[0].label, 'Automatic');
  assert.equal(error.message, 'Remove DATA.dbf');
  env.i18n.setLanguage('de');
  assert.equal(labels.D, 'Datum');
  assert.equal(encodings[0].label, 'Automatisch');
  assert.equal(error.message, 'DATA.dbf entfernen');
  assert.equal(error.cause, cause);
});

test('plural forms match Ukrainian, Polish, English, French, Japanese and Korean', () => {
  const env = environment();
  const { plural } = env.load('src/lib/plural.ts');
  for (const [code, count, expected] of [
    ['uk', 1, 'one'], ['uk', 2, 'few'], ['uk', 5, 'many'], ['uk', 11, 'many'], ['uk', 21, 'one'],
    ['pl', 1, 'one'], ['pl', 2, 'few'], ['pl', 5, 'many'], ['pl', 12, 'many'], ['pl', 22, 'few'],
    ['en', 1, 'one'], ['en', 2, 'many'], ['fr', 0, 'one'], ['fr', 2, 'many'],
    ['ja', 1, 'many'], ['ja', 2, 'many'], ['ko', 1, 'many'], ['ko', 2, 'many'],
  ]) {
    env.i18n.setLanguage(code);
    assert.equal(plural(count, 'one', 'few', 'many'), expected, code + ': ' + count);
  }
});

test('all Cyrillic UI literals are covered by the translation catalog', () => {
  function scan(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'i18n') scan(file); continue; }
      if (!/\.tsx?$/.test(file)) continue;
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if (ts.isStringLiteral(node) && /[\u0400-\u04ff]/.test(node.text)) {
          assert.ok(Object.hasOwn(catalog, node.text), file + ': missing ' + node.text);
        }
        if (ts.isJsxText(node)) assert.ok(!/[\u0400-\u04ff]/.test(node.text), file + ': untranslated JSX');
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
  }
  scan(path.join(root, 'src'));
});
