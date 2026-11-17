const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const cyrillic = /[\u0400-\u04ff]/;

test('server messages, desktop dialogs and generated export comments use English', () => {
  const inspected = [];
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'target', 'out', 'app'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!/\.(ts|cjs|mjs)$/.test(file) || file.endsWith('.spec.ts') || file.endsWith('translit.ts')) continue;
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      function visit(node) {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && cyrillic.test(node.text)) {
          // Encoding detection uses a Cyrillic alphabet as data, rather than interface text.
          let alphabet = false;
          for (let parent = node.parent; parent; parent = parent.parent) {
            if (ts.isVariableDeclaration(parent) && parent.name.getText(source) === 'FREQUENT_RUSSIAN') alphabet = true;
          }
          assert.ok(alphabet, path.relative(root, file) + ': non-English message: ' + node.text);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
      inspected.push(file);
    }
  }
  scan(path.join(root, 'migration-gateway/src'));
  scan(path.join(root, 'desktop'));
  assert.ok(inspected.length > 40);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
  assert.doesNotMatch(metadata.description, cyrillic);
});

test('all project documentation is in English', () => {
  for (const file of ['README.md', 'DEPLOYMENT.md', 'RUST_FEATURES.md', 'REDIS_IMPORT.md', 'MIGRATIONS.md', 'native/db-connector/README.md']) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, file), 'utf8'), cyrillic, file);
  }
  assert.match(fs.readFileSync(path.join(root, 'client/index.html'), 'utf8'), /<html lang="en">/);
});

test('server counts use English grammar for 21 and 101 as well as small counts', () => {
  const source = fs.readFileSync(path.join(root, 'migration-gateway/src/plural.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { exports: module.exports, module });
  assert.equal(module.exports.plural(1, 'byte', 'bytes'), 'byte');
  for (const count of [0, 2, 4, 11, 21, 101]) assert.equal(module.exports.plural(count, 'byte', 'bytes'), 'bytes');
});

test('source code uses English text outside native language names and translation values', () => {
  const otherScripts = /[\p{Script=Cyrillic}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  function scan(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'target', 'out', 'app'].includes(entry.name)) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { scan(file); continue; }
      if (!/\.(?:ts|tsx|cjs|mjs|rs)$/.test(file)) continue;
      let text = fs.readFileSync(file, 'utf8');
      if (path.relative(root, file).replaceAll(path.sep, '/') === 'client/src/i18n/index.ts') {
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const labels = [];
        function visit(node) {
          if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'label' && ts.isStringLiteral(node.initializer)) {
            labels.push([node.initializer.getStart(source), node.initializer.getEnd()]);
          }
          ts.forEachChild(node, visit);
        }
        visit(source);
        for (const [start, end] of labels.sort((a, b) => b[0] - a[0])) text = text.slice(0, start) + '""' + text.slice(end);
      }
      assert.doesNotMatch(text, otherScripts, path.relative(root, file));
    }
  }
  for (const directory of ['client/src', 'client/scripts', 'migration-gateway/src', 'desktop', 'native/db-connector/src']) scan(path.join(root, directory));
  const messages = JSON.parse(fs.readFileSync(path.join(root, 'client/src/i18n/messages.json'), 'utf8'));
  for (const key of Object.keys(messages)) assert.doesNotMatch(key, otherScripts, key);
});
