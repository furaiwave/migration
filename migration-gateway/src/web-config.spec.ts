import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { webConfig } from './web-config';

const base = (): NodeJS.ProcessEnv => ({
  PUBLIC_ORIGIN: 'https://migration.example.com',
  APP_USER: 'admin',
  APP_PASSWORD: 'test-only-password-123456',
  DBF_CLIENT_DIR: path.resolve('client'),
  DBF_SESSION_DIR: path.resolve('sessions'),
  DBF_CONNECTOR_BIN: process.execPath,
});
test('normalizes one explicit public origin and absolute runtime paths', () => {
  const config = webConfig({
    ...base(),
    PUBLIC_ORIGIN: 'https://migration.example.com/',
    PORT: '8080',
  });
  expect(config.origin).toBe('https://migration.example.com');
  expect(config.port).toBe(8080);
});
test.each([
  { PUBLIC_ORIGIN: '' },
  { PUBLIC_ORIGIN: '*' },
  { PUBLIC_ORIGIN: 'file:///tmp/app' },
  { PUBLIC_ORIGIN: 'https://user:secret@example.com' },
  { PUBLIC_ORIGIN: 'https://example.com/path' },
  { APP_USER: '' },
  { APP_USER: 'admin:other' },
  { APP_PASSWORD: '' },
  { APP_PASSWORD: 'short' },
  { APP_PASSWORD: 'test-only-password\n123456' },
  { DBF_SESSION_DIR: 'relative' },
  { DBF_CONNECTOR_BIN: '' },
  { PORT: '-1' },
  { PORT: '65536' },
  { PORT: '' },
])('refuses incomplete or unsafe web configuration: %j', (patch) => {
  expect(() => webConfig({ ...base(), ...patch })).toThrow();
});
test('reads the password secret file without changing spaces and refuses ambiguous sources', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbf-web-config-'));
  const secret = path.join(dir, 'secret');
  try {
    fs.writeFileSync(secret, ' test-password-123456 \n');
    expect(
      webConfig({
        ...base(),
        APP_PASSWORD: undefined,
        APP_PASSWORD_FILE: secret,
      }).access.password,
    ).toBe(' test-password-123456 ');
    expect(() => webConfig({ ...base(), APP_PASSWORD_FILE: secret })).toThrow();
    expect(() =>
      webConfig({
        ...base(),
        APP_PASSWORD: undefined,
        APP_PASSWORD_FILE: path.join(dir, 'missing'),
      }),
    ).toThrow();
  } finally {
    fs.unlinkSync(secret);
    fs.rmdirSync(dir);
  }
});
