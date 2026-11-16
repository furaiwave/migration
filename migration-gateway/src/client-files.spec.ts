import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { clientFromDir } from './client-files';
test('serves artifacts and treats malformed/escaping paths as missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbf-client-files-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, '<html>test</html>');
  try {
    const read = clientFromDir(dir);
    expect(read('/index.html')?.toString()).toBe('<html>test</html>');
    for (const url of [
      '/bad%zz',
      '/%00',
      '/../outside',
      '/%2e%2e/outside',
      '/..%5coutside',
      '/missing.js',
      'index.html',
    ]) {
      expect(read(url)).toBeUndefined();
    }
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});
