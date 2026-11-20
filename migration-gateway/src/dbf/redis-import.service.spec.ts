import { createClient } from 'redis';
import {
  RedisImportService,
  redisRecord,
  validateRedisUri,
} from './redis-import.service';
import {
  MysqlExportService,
  type DocumentTable,
  type DocumentSource,
} from './mysql-export.service';
import type { DbfSession } from '../types/dbf-session.types';
import type { RedisOptions } from '../types/redis-import.types';
jest.mock('redis', () => ({ createClient: jest.fn() }));
const options: RedisOptions = {
  prefix: 'legacy',
  writeMode: 'new',
  ttlSeconds: 0,
  keepDeleted: false,
};
const table = (): DocumentTable =>
  ({
    name: 'clients',
    fileName: 'CLIENTS.dbf',
    deletedName: null,
    rowCount: 2,
    deletedCount: 0,
    excluded: false,
    columns: [
      { name: 'id', key: 'PRI', excluded: false, kind: 'number' },
      { name: 'text', key: null, excluded: false, kind: 'text' },
    ],
    records: function* () {
      yield { recno: 1, values: ['9007199254740993', null] };
      yield { recno: 2, values: ['2', ''] };
    },
  }) as unknown as DocumentTable;
function setup() {
  const data: DocumentSource = {
    tables: [table()],
    warnings: [],
    quality: [],
    links: [],
    foreignKeys: [],
  };
  const source = {
    documentSource: jest.fn<
      ReturnType<MysqlExportService['documentSource']>,
      Parameters<MysqlExportService['documentSource']>
    >(),
  };
  source.documentSource.mockReturnValue(data);
  const client = {
    connect: jest.fn().mockResolvedValue(undefined),
    on: jest.fn(),
    isOpen: true,
    destroy: jest.fn(),
    eval: jest
      .fn<Promise<number>, [string, { keys: string[]; arguments: string[] }]>()
      .mockResolvedValue(1),
  };
  jest
    .mocked(createClient)
    .mockReturnValue(client as unknown as ReturnType<typeof createClient>);
  return {
    data,
    source,
    client,
    service: new RedisImportService(source as unknown as MysqlExportService),
  };
}
async function finish(service: RedisImportService, id: string) {
  for (let i = 0; i < 100; i++) {
    const status = service.getStatus(id);
    if (status.state !== 'running') return status;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error('Import did not finish');
}
beforeEach(() => {
  jest.clearAllMocks();
});
test('Redis key identity is stable and lossless values distinguish null and empty text', () => {
  const t = table();
  const first = redisRecord(t, 'clients', 'dbf', ['9007199254740993', null], 1);
  expect(first.key).toBe(
    redisRecord(t, 'clients', 'dbf', ['9007199254740993', 'changed'], 9).key,
  );
  expect(first.fields).toEqual(['id', '"9007199254740993"', 'text', 'null']);
  expect(redisRecord(t, 'clients', 'dbf', ['2', ''], 2).fields[3]).toBe('""');
  expect(
    redisRecord(t, 'clients_deleted', 'dbf', ['2', 'same'], 2).key,
  ).not.toBe(redisRecord(t, 'clients_deleted', 'dbf', ['2', 'same'], 3).key);
  const keyless = {
    ...t,
    columns: t.columns.map((c) => ({ ...c, key: null })),
  };
  expect(redisRecord(keyless, 'clients', 'dbf', ['1', 'test'], 8).key).toBe(
    'dbf:clients:row:8',
  );
});
test('accepts TLS/ACL URIs and rejects unsupported schemes, query options and invalid database indices', () => {
  for (const uri of [
    'redis://localhost:6379/0',
    'rediss://user:password@localhost:6380/1',
    'redis://localhost',
  ])
    expect(validateRedisUri(uri)).toBeInstanceOf(URL);
  for (const uri of [
    'https://localhost',
    'redis://localhost/-1',
    'redis://localhost/1?db=2',
    'redis://localhost/01',
    'redis://localhost/1#insecure',
    'redis://localhost/2147483648',
  ])
    expect(() => validateRedisUri(uri)).toThrow();
});
test('keeps Redis planning independent of SQL constraints and rejects invalid prefixes', () => {
  const { service, source } = setup();
  expect(
    service.prepare({} as DbfSession, [], options).plan.tables[0].keyMode,
  ).toBe('primary');
  expect(source.documentSource.mock.calls[0][2]).toEqual(
    expect.objectContaining({
      foreignKeys: false,
      indexes: true,
      orphansAsNull: false,
      emptyStringsAsNull: false,
    }),
  );
  expect(source.documentSource.mock.calls[0][3]).toBe('sql');
  expect(() =>
    service.prepare({} as DbfSession, [], { ...options, prefix: '*' }),
  ).toThrow();
});
test('counts writes and skips and passes TTL without exposing credentials in status', async () => {
  const { service, client } = setup();
  client.eval.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  const job = await service.startImport(
    {} as DbfSession,
    [],
    { ...options, ttlSeconds: 60 },
    'redis://user:private-secret@localhost/0',
  );
  const status = await finish(service, job.jobId);
  expect(status.state).toBe('done');
  expect(status.progress.rowsDone).toBe(2);
  expect(status.result?.tables[0]).toEqual(
    expect.objectContaining({ importedRows: 1, skippedRows: 1 }),
  );
  expect(client.eval.mock.calls[0][1].arguments.slice(0, 2)).toEqual([
    'new',
    '60',
  ]);
  expect(JSON.stringify(status)).not.toContain('private-secret');
  expect(client.destroy).toHaveBeenCalled();
});
test('cancels after the in-flight record without executing later records', async () => {
  const { service, client } = setup();
  let release!: (n: number) => void;
  client.eval.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const job = await service.startImport(
    {} as DbfSession,
    [],
    options,
    'redis://localhost/0',
  );
  service.cancel(job.jobId);
  release(1);
  const status = await finish(service, job.jobId);
  expect(status.state).toBe('cancelled');
  expect(client.eval).toHaveBeenCalledTimes(1);
  expect(status.progress.rowsDone).toBe(1);
});
test('driver errors are sanitized and failed jobs close the client', async () => {
  const { service, client } = setup();
  client.eval.mockRejectedValueOnce(new Error('private-secret data'));
  const job = await service.startImport(
    {} as DbfSession,
    [],
    options,
    'redis://localhost/0',
  );
  const status = await finish(service, job.jobId);
  expect(status.state).toBe('failed');
  expect(JSON.stringify(status)).not.toContain('private-secret');
  expect(client.destroy).toHaveBeenCalled();
});
test('unknown jobs return 404 and non-hash replies fail without further writes', async () => {
  const { service, client } = setup();
  expect(() => service.getStatus('missing')).toThrow();
  client.eval.mockResolvedValueOnce(-1);
  const job = await service.startImport(
    {} as DbfSession,
    [],
    options,
    'redis://localhost/0',
  );
  expect((await finish(service, job.jobId)).state).toBe('failed');
  expect(client.eval).toHaveBeenCalledTimes(1);
});

test('synchronous driver setup failures are sanitized and release the import slot', async () => {
  const { service } = setup();
  for (let i = 0; i < 3; i++) {
    jest.mocked(createClient).mockImplementationOnce(() => {
      throw new Error('private-secret URI malformed');
    });
    await expect(
      service.startImport({} as DbfSession, [], options, 'redis://localhost/0'),
    ).rejects.toThrow('Redis operation failed');
  }
});

test('shutdown waits for the active Redis record and refuses new imports', async () => {
  const { service, client } = setup();
  let release!: (value: number) => void;
  client.eval.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const job = await service.startImport(
    {} as DbfSession,
    [],
    options,
    'redis://localhost/0',
  );
  let closed = false;
  const closing = service.onModuleDestroy().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  release(1);
  await closing;
  expect(service.getStatus(job.jobId).state).toBe('cancelled');
  expect(client.eval).toHaveBeenCalledTimes(1);
  expect(client.destroy).toHaveBeenCalledTimes(1);
  await expect(
    service.startImport({} as DbfSession, [], options, 'redis://localhost/0'),
  ).rejects.toThrow('stopping');
});
test('shutdown during a Redis connection closes the client without writing records', async () => {
  const { service, client } = setup();
  let release!: () => void;
  client.connect.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const start = service.startImport(
    {} as DbfSession,
    [],
    options,
    'redis://localhost/0',
  );
  await service.onModuleDestroy();
  release();
  await expect(start).rejects.toThrow('stopping');
  expect(client.eval).not.toHaveBeenCalled();
  expect(client.destroy).toHaveBeenCalledTimes(1);
});
