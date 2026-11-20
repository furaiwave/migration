import { serverVersion, validateUpgrade } from './versions';

describe('server version verification', () => {
  test.each([
    ['mysql', '5.6.51-log', 'mysql', '5.6.51'],
    ['mysql', '8.0.40-commercial', 'mysql', '8.0.40'],
    ['mysql', '8.0.40-Percona', 'mysql', '8.0.40'],
    ['postgres', '16.4 (Debian)', 'postgres', '16.4'],
    ['mysql', '8.0.40-0ubuntu0.22.04.1', 'mysql', '8.0.40'],
    ['mysql', '5.5.5-10.11.8-MariaDB', 'mariadb', '10.11.8'],
    ['mysql', '11.4.3-MariaDB', 'mariadb', '11.4.3'],
    ['postgres', '9.6.24', 'postgres', '9.6.24'],
    ['postgres', '16.4 (Ubuntu)', 'postgres', '16.4'],
    ['mssql', '16.0.1000.6', 'mssql', '16.0.1000.6'],
    ['mongo', '8.0.0', 'mongo', '8.0.0'],
    ['redis', '7.2.5', 'redis', '7.2.5'],
  ] as const)(
    'normalizes %s %s without exposing response text',
    (engine, raw, family, version) => {
      expect(serverVersion(engine, raw)).toEqual({ family, version });
    },
  );
  test.each([
    undefined,
    '',
    'secret text',
    '8.0.1-rc1',
    '8.0.1.2.3',
    '8.0.1-preview',
    '18.0beta2',
  ])('rejects unknown or unstable version %s', (value) => {
    expect(() => serverVersion('mysql', value)).toThrow();
  });
  test('compares numeric components and accepts patch upgrades', () => {
    expect(() =>
      validateUpgrade(
        serverVersion('mysql', '8.0.9'),
        serverVersion('mysql', '8.0.10'),
      ),
    ).not.toThrow();
    expect(() =>
      validateUpgrade(
        serverVersion('postgres', '9.6.24'),
        serverVersion('postgres', '10.0'),
      ),
    ).not.toThrow();
    expect(() =>
      validateUpgrade(
        serverVersion('mysql', '8.0.10'),
        serverVersion('mysql', '8.0.9'),
      ),
    ).toThrow('must be newer');
    expect(() =>
      validateUpgrade(
        serverVersion('mysql', '8.0'),
        serverVersion('mysql', '8.0.0'),
      ),
    ).toThrow('must be newer');
  });
  test('MariaDB is its own family', () => {
    expect(() =>
      validateUpgrade(
        serverVersion('mysql', '10.6.0-MariaDB'),
        serverVersion('mysql', '11.4.0-MariaDB'),
      ),
    ).not.toThrow();
    expect(() =>
      validateUpgrade(
        serverVersion('mysql', '5.6.51'),
        serverVersion('mysql', '10.11.8-MariaDB'),
      ),
    ).toThrow('same database family');
  });
  test('old MongoDB versions require an intermediate tool', () => {
    expect(() =>
      validateUpgrade(
        serverVersion('mongo', '4.0.28'),
        serverVersion('mongo', '8.0.0'),
      ),
    ).toThrow('4.2 or newer');
  });
});
