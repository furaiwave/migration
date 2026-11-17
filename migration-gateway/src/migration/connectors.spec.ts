/* Async protocol fakes implement driver contracts; method references are used only in Jest assertions. */
/* eslint-disable @typescript-eslint/require-await */
import { BSON, MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { MigrationConnectors } from './connectors';
import { documentColumns, redisColumns, type Row } from './model';
import type { MigrationConnection, PlannedObject } from './migration.types';

jest.mock('redis', () => ({
  ...jest.requireActual<typeof import('redis')>('redis'),
  createClient: jest.fn(),
}));
jest.mock('mongodb', () => ({
  ...jest.requireActual<typeof import('mongodb')>('mongodb'),
  MongoClient: jest.fn(),
}));
const redisConnection: MigrationConnection = {
  engine: 'redis',
  database: '0',
  uri: 'redis://localhost/0',
};
const mongoConnection: MigrationConnection = {
  engine: 'mongo',
  database: 'test',
  uri: 'mongodb://localhost',
};
const redisObject: PlannedObject = {
  source: {
    id: 'keys',
    name: 'keys',
    schema: '',
    format: 'redis',
    columns: redisColumns,
  },
  targetName: 'keys',
  targetSchema: '',
  columns: redisColumns.map((column) => ({ ...column, targetType: 'Redis' })),
};
function redisMock() {
  const multi = {
    exec: jest.fn<Promise<unknown[]>, []>(),
    dump: jest.fn(),
    pTTL: jest.fn(),
    type: jest.fn(),
  };
  multi.dump.mockReturnValue(multi);
  multi.pTTL.mockReturnValue(multi);
  multi.type.mockReturnValue(multi);
  const client = {
    isOpen: true,
    connect: jest.fn(() => Promise.resolve()),
    destroy: jest.fn(),
    on: jest.fn(),
    ping: jest.fn(() => Promise.resolve('PONG')),
    restore: jest.fn<Promise<string>, [Buffer, number, Buffer]>(() =>
      Promise.resolve('OK'),
    ),
    set: jest.fn<Promise<string | null>, [string, string, { NX: boolean }]>(
      () => Promise.resolve('OK'),
    ),
    scan: jest.fn<
      Promise<{ cursor: Buffer; keys: Buffer[] }>,
      [string, unknown]
    >(),
    info: jest.fn(() => Promise.resolve('run_id:server-one\r\n')),
    multi: jest.fn(() => multi),
    withTypeMapping: jest.fn(),
  };
  client.withTypeMapping.mockReturnValue(client);
  (createClient as jest.Mock).mockReturnValue(client);
  return { client, multi };
}

describe('Redis and MongoDB source and destination adapters', () => {
  const connectors = new MigrationConnectors();
  beforeEach(() => jest.clearAllMocks());
  test('Redis scanning deduplicates binary keys and preserves DUMP bytes and expiry', async () => {
    const { client, multi } = redisMock();
    const key = Buffer.from([0, 255, 65]);
    const dump = Buffer.from([255, 0, 128, 42]);
    client.scan
      .mockResolvedValueOnce({ cursor: Buffer.from('1'), keys: [key, key] })
      .mockResolvedValueOnce({
        cursor: Buffer.from('0'),
        keys: [key, Buffer.from('expired')],
      });
    multi.exec
      .mockResolvedValueOnce([dump, 60000, 'hash'])
      .mockResolvedValueOnce([null, -2, 'none']);
    const source = await connectors.source(redisConnection);
    const start = Date.now();
    const rows: Row[] = [];
    for await (const row of source.read(
      redisObject.source,
      new AbortController().signal,
    ))
      rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toEqual(key);
    expect(rows[0].dump).toEqual(dump);
    expect(Number(rows[0].expiresAt)).toBeGreaterThanOrEqual(start + 60000);
    expect(rows[0].type).toBe('hash');
    expect(client.scan).toHaveBeenCalledTimes(2);
    await source.close();
    expect(client.destroy).toHaveBeenCalled();
  });
  test('Redis restores native data and remaining TTL without REPLACE', async () => {
    const { client } = redisMock();
    const target = await connectors.target(redisConnection, 'copy');
    const key = Buffer.from([0, 255]);
    const dump = Buffer.from([255, 128]);
    const expiresAt = Date.now() + 60000;
    expect(
      await target.write(
        redisObject,
        { key, dump, type: 'stream', expiresAt: String(expiresAt) },
        1,
      ),
    ).toBe(true);
    expect(client.restore.mock.calls[0][0]).toEqual(
      Buffer.concat([Buffer.from('copy:keys:'), key]),
    );
    expect(client.restore.mock.calls[0][1]).toBeGreaterThan(59000);
    expect(client.restore.mock.calls[0][1]).toBeLessThanOrEqual(60000);
    expect(client.restore.mock.calls[0][2]).toEqual(dump);
    expect(client.restore.mock.calls[0]).toHaveLength(3);
    expect(
      await target.write(redisObject, { key, dump, expiresAt: '1' }, 2),
    ).toBe(false);
    expect(client.restore).toHaveBeenCalledTimes(1);
  });
  test('Redis strings contain canonical Extended JSON and are insert-only', async () => {
    const { client } = redisMock();
    const target = await connectors.target(redisConnection, 'copy');
    const object: PlannedObject = {
      ...redisObject,
      source: {
        ...redisObject.source,
        format: 'rows',
        columns: [{ name: 'id', kind: 'integer', nullable: false }],
      },
      targetName: 'items',
    };
    await target.write(object, { id: '9007199254740993' }, 1);
    const [key, value, options] = client.set.mock.calls[0];
    expect(key).toBe('copy:items:1');
    expect(options).toEqual({ NX: true });
    expect(
      (BSON.EJSON.parse(value, { relaxed: false }) as { id: unknown }).id,
    ).toEqual(BSON.Long.fromString('9007199254740993'));
    client.set.mockResolvedValueOnce(null);
    await expect(target.write(object, { id: '2' }, 2)).rejects.toThrow(
      'already exists',
    );
  });
  test('Redis identity prevents copying into the same DB through different host aliases', async () => {
    redisMock();
    await expect(
      connectors.differentRedisDatabases(redisConnection, {
        ...redisConnection,
        uri: 'redis://127.0.0.1/0',
      }),
    ).rejects.toThrow('must be different');
    await expect(
      connectors.differentRedisDatabases(redisConnection, {
        ...redisConnection,
        database: '1',
        uri: 'redis://127.0.0.1/1',
      }),
    ).resolves.toBeUndefined();
  });
  test('MongoDB preserves nested BSON and closes cursors', async () => {
    const document = {
      _id: new BSON.ObjectId(),
      count: BSON.Long.fromString('9007199254740993'),
      nested: {
        binary: new BSON.Binary(Buffer.from([0, 255]), 128),
        at: new Date('2026-01-01T00:00:00Z'),
      },
    };
    const cursor = {
      close: jest.fn(async () => {}),
      async *[Symbol.asyncIterator]() {
        yield document;
      },
    };
    const collection = {
      find: jest.fn(() => cursor),
      insertOne: jest.fn(async () => ({})),
      rename: jest.fn(async () => ({})),
    };
    const db = {
      databaseName: 'test',
      collection: jest.fn(() => collection),
      listCollections: jest.fn(() => ({
        toArray: async () => [{ name: 'items', type: 'collection' }],
      })),
      createCollection: jest.fn(async () => {}),
    };
    const client = {
      connect: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
      db: jest.fn(() => db),
    };
    (MongoClient as unknown as jest.Mock).mockImplementation(() => client);
    const source = await connectors.source(mongoConnection);
    const objects = await source.objects();
    const rows: Row[] = [];
    for await (const row of source.read(
      objects[0],
      new AbortController().signal,
    ))
      rows.push(row);
    const target = await connectors.target(mongoConnection, 'copy');
    const object: PlannedObject = {
      source: objects[0],
      targetName: 'copy',
      targetSchema: '',
      columns: documentColumns.map((column) => ({
        ...column,
        targetType: 'BSON',
      })),
    };
    await target.check([object]);
    await target.begin([object]);
    await target.write(object, rows[0], 1);
    expect(collection.insertOne).toHaveBeenCalledWith(document);
    expect(db.createCollection.mock.calls[0]).not.toEqual(['copy']);
    expect(target.warnings?.().join(' ')).toContain('__migration_');
    await target.commit();
    expect(collection.rename).toHaveBeenCalledWith('copy', {
      dropTarget: false,
    });
    expect(target.warnings?.()).toEqual([]);
    const concurrent = await connectors.target(mongoConnection, 'copy');
    await concurrent.begin([object]);
    collection.rename.mockRejectedValueOnce(new Error('NamespaceExists'));
    await expect(concurrent.commit()).rejects.toThrow('NamespaceExists');
    expect(concurrent.warnings?.().join(' ')).toContain('__migration_');
    expect(cursor.close).toHaveBeenCalled();
    await expect(
      target.check([{ ...object, targetName: 'items' }]),
    ).rejects.toThrow('already exists');
    await source.close();
    await target.close();
  });
});
