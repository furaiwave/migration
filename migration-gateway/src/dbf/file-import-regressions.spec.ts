import { MongoClient } from 'mongodb';
import { createConnection, type Connection } from 'mysql2/promise';
import { Logger } from '@nestjs/common';
import { MysqlExportService } from './mysql-export.service';
import { MongoExportService } from './mongo-export.service';
import { MysqlImportService } from './mysql-import.service';
import { MongoImportService } from './mongo-import.service';
import { parseTable } from './dbf-parse';
import { toFileName, toSessionId } from '../types/dbf-relationship.types';
import type { DbfSession } from '../types/dbf-session.types';
import type { MysqlExportOptions } from '../types/mysql-export.types';
jest.mock('mysql2/promise', () => ({ createConnection: jest.fn() }));
jest.mock('mongodb', () => ({
  ...jest.requireActual<typeof import('mongodb')>('mongodb'),
  MongoClient: jest.fn(),
}));
const input = {
  host: 'localhost',
  port: 3306,
  user: 'test',
  password: 'private-password',
};
const options: MysqlExportOptions = {
  database: 'legacy',
  writeMode: 'append',
  includeData: true,
  foreignKeys: false,
  indexes: false,
  keepDeleted: false,
  syncDeletes: false,
  emptyStringsAsNull: false,
  orphansAsNull: false,
  overrides: { 'CLIENTS.DBF': { name: 'clients', primaryKey: 'ID' } },
};
function session(
  idType = 'N',
  idValue = '2',
  decimals = 0,
  email = 'existing@example.test',
): DbfSession {
  const bytes = Buffer.alloc(97 + 47 + 1);
  bytes[0] = 3;
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt16LE(97, 8);
  bytes.writeUInt16LE(47, 10);
  bytes.write('ID', 32, 'ascii');
  bytes[43] = idType.charCodeAt(0);
  bytes[48] = 6;
  bytes[49] = decimals;
  bytes.write('EMAIL', 64, 'ascii');
  bytes[75] = 67;
  bytes[80] = 40;
  bytes[96] = 13;
  bytes.fill(32, 97, 144);
  bytes.write(' ' + idValue.padStart(6), 97, 'ascii');
  Buffer.from(email, 'utf8').copy(bytes, 104, 0, 40);
  bytes[bytes.length - 1] = 26;
  const name = toFileName('CLIENTS.DBF');
  return {
    id: toSessionId('import-regression'),
    createdAt: new Date(),
    previewRows: 1,
    files: new Map([[name, parseTable(name, bytes, null, null, 1, 'utf-8')]]),
    sources: new Map([[name, { dbf: bytes, memo: null, index: null }]]),
    manualRels: [],
    disabledRels: new Set(),
    encodings: new Map(),
  };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until(predicate: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('Timed out waiting for import');
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function mysqlSetup(idType = 'N') {
  const columns = [
    {
      t: 'clients',
      c: 'id',
      k: 'PRI',
      column_type: idType === 'C' ? 'varchar(6)' : 'int(11)',
      charset_name: idType === 'C' ? 'utf8mb4' : null,
      collation_name: idType === 'C' ? 'utf8mb4_bin' : null,
    },
    {
      t: 'clients',
      c: 'email',
      k: '',
      column_type: 'varchar(40)',
      charset_name: 'utf8mb4',
      collation_name: 'utf8mb4_unicode_ci',
    },
  ];
  const indexes: {
    t: string;
    i: string;
    c: string | null;
    prefix_length: number | null;
  }[] = [{ t: 'clients', i: 'PRIMARY', c: 'id', prefix_length: null }];
  const connection = {
    query: jest.fn<Promise<[unknown, unknown]>, [string, unknown[]?]>((sql) =>
      Promise.resolve([
        sql.includes('information_schema.COLUMNS')
          ? columns
          : sql.includes('information_schema.STATISTICS')
            ? indexes
            : sql.startsWith('SELECT COUNT')
              ? [{ n: 1 }]
              : sql.startsWith('SELECT VERSION')
                ? [{ version: '8.0.40' }]
                : sql === 'SHOW DATABASES'
                  ? [{ Database: 'legacy' }]
                  : { affectedRows: 1, info: '' },
        [],
      ]),
    ),
    destroy: jest.fn(),
    end: jest.fn<Promise<void>, []>(() => Promise.resolve()),
  };
  jest
    .mocked(createConnection)
    .mockResolvedValue(connection as unknown as Connection);
  return {
    connection,
    indexes,
    columns,
    service: new MysqlImportService(new MysqlExportService()),
  };
}
function mongoSetup() {
  const collection = {
    insertMany: jest.fn<Promise<void>, unknown[]>(() => Promise.resolve()),
    countDocuments: jest.fn<Promise<number>, unknown[]>(() =>
      Promise.resolve(1),
    ),
  };
  const command = jest.fn<
    Promise<{ version: string; databases: { name: string }[] }>,
    unknown[]
  >(() =>
    Promise.resolve({ version: '7.0.0', databases: [{ name: 'legacy' }] }),
  );
  const db = {
    collection: jest.fn(() => collection),
    listCollections: jest.fn(() => ({ hasNext: () => Promise.resolve(true) })),
  };
  const client = {
    connect: jest.fn(() => Promise.resolve()),
    close: jest.fn<Promise<void>, []>(() => Promise.resolve()),
    db: jest.fn((name: string) => (name === 'admin' ? { command } : db)),
  };
  jest
    .mocked(MongoClient)
    .mockImplementation(() => client as unknown as MongoClient);
  return {
    client,
    collection,
    command,
    service: new MongoImportService(
      new MongoExportService(new MysqlExportService()),
    ),
  };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
test('MySQL sync refuses an unrelated unique index before any data or DDL is written', async () => {
  const { service, connection, indexes } = mysqlSetup();
  indexes.push({
    t: 'clients',
    i: 'unique_email',
    c: 'email',
    prefix_length: null,
  });
  await expect(
    service.startImport(
      session(),
      [],
      { ...options, writeMode: 'sync' },
      input,
    ),
  ).rejects.toThrow(/unique_email.*different primary key/);
  expect(
    connection.query.mock.calls.every(([sql]) => sql.startsWith('SELECT')),
  ).toBe(true);
  expect(connection.end).toHaveBeenCalledTimes(1);
});
test('MySQL sync permits a unique index containing the complete primary key', async () => {
  const { service, connection, indexes } = mysqlSetup();
  indexes.push(
    { t: 'clients', i: 'email_id', c: 'email', prefix_length: null },
    { t: 'clients', i: 'email_id', c: 'id', prefix_length: null },
  );
  const job = await service.startImport(
    session(),
    [],
    { ...options, writeMode: 'sync' },
    input,
  );
  await until(() => service.getStatus(job.jobId).state !== 'running');
  expect(service.getStatus(job.jobId).state).toBe('done');
  expect(
    connection.query.mock.calls.some(([sql]) => sql.startsWith('INSERT')),
  ).toBe(true);
});
test.each(['id_prefix', 'PRIMARY'])(
  'MySQL sync refuses the %s prefix index that does not identify the full primary key',
  async (indexName) => {
    const { service, indexes } = mysqlSetup('C');
    if (indexName === 'PRIMARY') indexes[0].prefix_length = 1;
    else
      indexes.push({ t: 'clients', i: indexName, c: 'id', prefix_length: 1 });
    await expect(
      service.startImport(
        session('C'),
        [],
        { ...options, writeMode: 'sync' },
        input,
      ),
    ).rejects.toThrow(new RegExp(indexName + '.*different primary key'));
  },
);
test.each(['last statement', 'verification', 'server version'] as const)(
  'MySQL honours cancellation during %s',
  async (phase) => {
    const { service, connection } = mysqlSetup();
    const original = connection.query;
    const pending = deferred<[unknown, unknown]>();
    let waiting = false;
    connection.query = jest.fn((sql, parameters) => {
      if (
        (phase === 'last statement' &&
          sql.includes('sql_mode = @DBF_OLD_SQL_MODE')) ||
        (phase === 'verification' && sql.startsWith('SELECT COUNT')) ||
        (phase === 'server version' && sql.startsWith('SELECT VERSION'))
      ) {
        waiting = true;
        return pending.promise;
      }
      return original(sql, parameters);
    });
    const job = await service.startImport(session(), [], options, input);
    await until(() => waiting);
    service.cancel(job.jobId);
    pending.resolve([
      phase === 'verification'
        ? [{ n: 1 }]
        : phase === 'server version'
          ? [{ version: '8.0.40' }]
          : { affectedRows: 0 },
      [],
    ]);
    await until(() => service.getStatus(job.jobId).state !== 'running');
    expect(service.getStatus(job.jobId).state).toBe('cancelled');
    expect(service.getStatus(job.jobId).result).toBeUndefined();
    expect(connection.end).toHaveBeenCalledTimes(1);
  },
);
test.each(['last write', 'verification', 'server version'] as const)(
  'MongoDB honours cancellation during %s',
  async (phase) => {
    const { service, client, collection, command } = mongoSetup();
    const pending = deferred<void>();
    let waiting = false;
    if (phase === 'last write')
      collection.insertMany.mockImplementation(() => {
        waiting = true;
        return pending.promise;
      });
    if (phase === 'verification')
      collection.countDocuments.mockImplementation(() => {
        waiting = true;
        return pending.promise.then(() => 1);
      });
    if (phase === 'server version')
      command.mockImplementation(() => {
        waiting = true;
        return pending.promise.then(() => ({
          version: '7.0.0',
          databases: [],
        }));
      });
    const job = await service.startImport(session(), [], options, {
      uri: 'mongodb://localhost',
    });
    await until(() => waiting);
    service.cancel(job.jobId);
    pending.resolve();
    await until(() => service.getStatus(job.jobId).state !== 'running');
    expect(service.getStatus(job.jobId).state).toBe('cancelled');
    expect(service.getStatus(job.jobId).result).toBeUndefined();
    expect(client.close).toHaveBeenCalledTimes(1);
  },
);
test.each(['mysql', 'mongo'] as const)(
  '%s connection cleanup cannot replace a sanitized query failure',
  async (engine) => {
    const secret = 'private-driver-close-details';
    let work: Promise<unknown>;
    if (engine === 'mysql') {
      const { service, connection } = mysqlSetup();
      connection.query.mockRejectedValue(new Error('private-query-details'));
      connection.end.mockRejectedValue(new Error(secret));
      work = service.testConnection(input);
    } else {
      const { service, command, client } = mongoSetup();
      command.mockRejectedValue(new Error('private-query-details'));
      client.close.mockRejectedValue(new Error(secret));
      work = service.testConnection({ uri: 'mongodb://localhost' });
    }
    await expect(work).rejects.toThrow('Driver details are hidden');
  },
);
test.each(['mysql', 'mongo'] as const)(
  '%s preserves successfully read connection information when cleanup fails',
  async (engine) => {
    if (engine === 'mysql') {
      const { service, connection } = mysqlSetup();
      connection.end.mockRejectedValue(new Error('close failed'));
      await expect(service.testConnection(input)).resolves.toEqual({
        serverVersion: '8.0.40',
        databases: ['legacy'],
      });
    } else {
      const { service, client } = mongoSetup();
      client.close.mockRejectedValue(new Error('close failed'));
      await expect(
        service.testConnection({ uri: 'mongodb://localhost' }),
      ).resolves.toEqual({ serverVersion: '7.0.0', databases: ['legacy'] });
    }
  },
);

test.each(['mysql', 'mongo'] as const)(
  '%s shutdown waits for the in-flight write and refuses subsequent imports',
  async (engine) => {
    let shuttingDown: Promise<void>;
    let done = false;
    if (engine === 'mysql') {
      const { service, connection } = mysqlSetup();
      const original = connection.query;
      const pending = deferred<[unknown, unknown]>();
      let writing = false;
      connection.query = jest.fn((sql, params) => {
        if (sql.startsWith('INSERT')) {
          writing = true;
          return pending.promise;
        }
        return original(sql, params);
      });
      const job = await service.startImport(session(), [], options, input);
      await until(() => writing);
      shuttingDown = service.onModuleDestroy();
      void shuttingDown.then(() => {
        done = true;
      });
      await tick();
      expect(done).toBe(false);
      pending.resolve([{ affectedRows: 1 }, []]);
      await shuttingDown;
      expect(service.getStatus(job.jobId).state).toBe('cancelled');
      expect(connection.end).toHaveBeenCalledTimes(1);
      await expect(
        service.startImport(session(), [], options, input),
      ).rejects.toThrow('stopping');
    } else {
      const { service, client, collection } = mongoSetup();
      const pending = deferred<void>();
      let writing = false;
      collection.insertMany.mockImplementation(() => {
        writing = true;
        return pending.promise;
      });
      const job = await service.startImport(session(), [], options, {
        uri: 'mongodb://localhost',
      });
      await until(() => writing);
      shuttingDown = service.onModuleDestroy();
      void shuttingDown.then(() => {
        done = true;
      });
      await tick();
      expect(done).toBe(false);
      pending.resolve();
      await shuttingDown;
      expect(service.getStatus(job.jobId).state).toBe('cancelled');
      expect(client.close).toHaveBeenCalledTimes(1);
      await expect(
        service.startImport(session(), [], options, {
          uri: 'mongodb://localhost',
        }),
      ).rejects.toThrow('stopping');
    }
  },
);
test.each(['mysql', 'mongo'] as const)(
  '%s does not launch a late import if shutdown occurs during connection setup',
  async (engine) => {
    if (engine === 'mysql') {
      const { service, connection } = mysqlSetup();
      const pending = deferred<Connection>();
      jest.mocked(createConnection).mockReturnValue(pending.promise);
      const start = service.startImport(session(), [], options, input);
      await service.onModuleDestroy();
      pending.resolve(connection as unknown as Connection);
      await expect(start).rejects.toThrow('stopping');
      expect(connection.end).toHaveBeenCalledTimes(1);
      expect(
        connection.query.mock.calls.every(([sql]) => sql.startsWith('SELECT')),
      ).toBe(true);
    } else {
      const { service, client, collection } = mongoSetup();
      const pending = deferred<void>();
      client.connect.mockImplementation(() => pending.promise);
      const start = service.startImport(session(), [], options, {
        uri: 'mongodb://localhost',
      });
      await service.onModuleDestroy();
      pending.resolve();
      await expect(start).rejects.toThrow('stopping');
      expect(client.close).toHaveBeenCalledTimes(1);
      expect(collection.insertMany).not.toHaveBeenCalled();
    }
  },
);

test.each(['append', 'sync'] as const)(
  '%s rejects a numeric destination for a text primary key before writing',
  async (writeMode) => {
    const { service, connection } = mysqlSetup();
    await expect(
      service.startImport(
        session('C', '001'),
        [],
        { ...options, writeMode },
        input,
      ),
    ).rejects.toThrow(/clients.id.*type/);
    expect(
      connection.query.mock.calls.every(([sql]) => sql.startsWith('SELECT')),
    ).toBe(true);
    expect(connection.end).toHaveBeenCalledTimes(1);
  },
);
test.each(['append', 'sync'] as const)(
  '%s rejects a key collation that changes source identity',
  async (writeMode) => {
    const { service, connection, columns } = mysqlSetup('C');
    columns[0].collation_name = 'utf8mb4_general_ci';
    await expect(
      service.startImport(
        session('C', 'a'),
        [],
        { ...options, writeMode },
        input,
      ),
    ).rejects.toThrow(/clients.id.*collation/);
    expect(
      connection.query.mock.calls.every(([sql]) => sql.startsWith('SELECT')),
    ).toBe(true);
  },
);
test.each(['integer', 'text', 'decimal'] as const)(
  'rejects a narrower %s column before any MySQL writes',
  async (kind) => {
    const { service, connection, columns } = mysqlSetup();
    if (kind === 'integer') columns[0].column_type = 'tinyint(4)';
    if (kind === 'text') columns[1].column_type = 'varchar(4)';
    if (kind === 'decimal') columns[0].column_type = 'decimal(6,1)';
    const source =
      kind === 'integer'
        ? session('N', '200')
        : kind === 'decimal'
          ? session('N', '12.34', 2)
          : session();
    await expect(
      service.startImport(source, [], options, input),
    ).rejects.toThrow(/clients.(id|email).*type/);
    expect(
      connection.query.mock.calls.every(([sql]) => sql.startsWith('SELECT')),
    ).toBe(true);
  },
);
test('rejects a destination character set that cannot preserve Unicode', async () => {
  const { service, connection, columns } = mysqlSetup();
  columns[1].charset_name = 'latin1';
  columns[1].collation_name = 'latin1_swedish_ci';
  await expect(
    service.startImport(
      session('N', '2', 0, '\u0416@example.test'),
      [],
      options,
      input,
    ),
  ).rejects.toThrow(/clients.email.*character set/);
  expect(
    connection.query.mock.calls.every(([sql]) => sql.startsWith('SELECT')),
  ).toBe(true);
});
test.each(['integer', 'text', 'decimal'] as const)(
  'preserves compatible wider %s destination columns',
  async (kind) => {
    const { service, columns } = mysqlSetup();
    if (kind === 'integer') columns[0].column_type = 'bigint(20)';
    if (kind === 'text') columns[1].column_type = 'varchar(100)';
    if (kind === 'decimal') columns[0].column_type = 'decimal(7,3)';
    const source = kind === 'decimal' ? session('N', '12.34', 2) : session();
    const job = await service.startImport(source, [], options, input);
    await until(() => service.getStatus(job.jobId).state !== 'running');
    expect(service.getStatus(job.jobId).state).toBe('done');
  },
);
