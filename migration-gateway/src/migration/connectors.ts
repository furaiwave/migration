import { Injectable } from '@nestjs/common';
import { BSON, MongoClient, type Db } from 'mongodb';
import { createClient, RESP_TYPES } from 'redis';
import { createHash, randomUUID } from 'crypto';
import type {
  MigrationConnection,
  MigrationMode,
  MigrationObject,
  PlannedObject,
} from './migration.types';
import {
  bsonRow,
  documentColumns,
  redisColumns,
  MigrationError,
  type Row,
  type Source,
  type Target,
} from './model';
import { connectSql, SqlSource, SqlTarget } from './sql';
import { serverVersion } from './versions';

async function connectMongo(input: MigrationConnection) {
  const client = new MongoClient(input.uri!, {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 120000,
    promoteLongs: false,
  });
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return { client, db: client.db(input.database) };
}
async function connectRedis(input: MigrationConnection) {
  const client = createClient({
    url: input.uri!,
    socket: {
      connectTimeout: 10000,
      socketTimeout: 120000,
      reconnectStrategy: false,
    },
    disableOfflineQueue: true,
  }).withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
  client.on('error', () => {});
  try {
    await client.connect();
  } catch (error) {
    if (client.isOpen) client.destroy();
    throw error;
  }
  return client;
}
type RedisClient = Awaited<ReturnType<typeof connectRedis>>;
class MongoSource implements Source {
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
  ) {}
  async version() {
    const info = await this.db.admin().command({ buildInfo: 1 });
    return serverVersion('mongo', info.version);
  }
  async objects(): Promise<MigrationObject[]> {
    const collections = await this.db
      .listCollections({}, { nameOnly: false })
      .toArray();
    if (collections.length > 1000)
      throw new MigrationError('More than 1000 source collections');
    return collections
      .filter(
        (collection) =>
          ['collection', 'timeseries'].includes(collection.type ?? '') &&
          !collection.name.startsWith('system.'),
      )
      .map((collection) => ({
        id: collection.name,
        name: collection.name,
        schema: '',
        format: 'documents',
        columns: documentColumns,
      }));
  }
  async *read(object: MigrationObject, signal: AbortSignal) {
    const cursor = this.db
      .collection(object.name)
      .find({}, { batchSize: 250, promoteValues: false, bsonRegExp: true });
    const abort = () => {
      void cursor.close().catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      signal.throwIfAborted();
      for await (const document of cursor) {
        signal.throwIfAborted();
        yield {
          _id: BSON.EJSON.stringify(document._id, { relaxed: false }),
          document: BSON.EJSON.stringify(document, { relaxed: false }),
        };
      }
    } finally {
      signal.removeEventListener('abort', abort);
      await cursor.close();
    }
  }
  close() {
    return this.client.close();
  }
}
class MongoTarget implements Target {
  private readonly staging = new Map<string, string>();
  constructor(
    private readonly client: MongoClient,
    private readonly db: Db,
  ) {}
  async version() {
    const info = await this.db.admin().command({ buildInfo: 1 });
    return serverVersion('mongo', info.version);
  }
  async check(objects: PlannedObject[]) {
    const names = new Set(
      (await this.db.listCollections({}, { nameOnly: true }).toArray()).map(
        (collection) => collection.name,
      ),
    );
    for (const object of objects) {
      if (
        !object.targetName ||
        object.targetName.includes('\0') ||
        object.targetName.startsWith('system.') ||
        Buffer.byteLength(this.db.databaseName + '.' + object.targetName) > 120
      )
        throw new MigrationError('Invalid destination collection name');
      if (names.has(object.targetName))
        throw new MigrationError(
          'Destination collection already exists: ' + object.targetName,
        );
    }
  }
  async begin(objects: PlannedObject[]) {
    for (const object of objects) {
      const name = '__migration_' + randomUUID().replace(/-/g, '');
      await this.db.createCollection(name);
      this.staging.set(object.targetName, name);
    }
  }
  async write(object: PlannedObject, row: Row): Promise<boolean> {
    await this.db
      .collection(this.staging.get(object.targetName)!)
      .insertOne(bsonRow(object.source, row));
    return true;
  }
  async commit() {
    for (const [destination, temporary] of this.staging) {
      await this.db
        .collection(temporary)
        .rename(destination, { dropTarget: false });
      this.staging.delete(destination);
    }
  }
  warnings() {
    return [...this.staging.values()].map(
      (name) => 'Partial MongoDB data remains in temporary collection: ' + name,
    );
  }
  rollback() {
    return Promise.resolve(false);
  }
  close() {
    return this.client.close();
  }
}
async function redisVersion(client: RedisClient) {
  const info = await client.info('server');
  return serverVersion(
    'redis',
    /(?:^|\r?\n)redis_version:([^\r\n]+)/.exec(String(info))?.[1],
  );
}
class RedisSource implements Source {
  constructor(private readonly client: RedisClient) {}
  version() {
    return redisVersion(this.client);
  }
  objects(): Promise<MigrationObject[]> {
    return Promise.resolve([
      {
        id: 'keys',
        schema: '',
        name: 'keys',
        format: 'redis',
        columns: redisColumns,
      },
    ]);
  }
  async *read(_object: MigrationObject, signal: AbortSignal) {
    let cursor = '0';
    // SCAN can return a key more than once. Keep fingerprints, never entire values.
    const seen = new Set<string>();
    do {
      signal.throwIfAborted();
      const page = await this.client.scan(cursor, { COUNT: 250 });
      cursor = String(page.cursor);
      for (const key of page.keys) {
        signal.throwIfAborted();
        const fingerprint = createHash('sha256').update(key).digest('hex');
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        const started = Date.now();
        const replies = await this.client
          .multi()
          .dump(key)
          .pTTL(key)
          .type(key)
          .exec();
        const dump = replies[0];
        const ttl = Number(replies[1]);
        const keyType = replies[2];
        if (typeof keyType !== 'string' && !Buffer.isBuffer(keyType))
          throw new MigrationError('Invalid Redis key type reply');
        if (!dump || ttl === -2) continue;
        yield {
          key: Buffer.from(key),
          type: Buffer.isBuffer(keyType) ? keyType.toString() : keyType,
          dump: Buffer.from(dump as unknown as Buffer),
          expiresAt: ttl >= 0 ? String(started + ttl) : null,
        };
      }
    } while (cursor !== '0');
  }
  close() {
    if (this.client.isOpen) this.client.destroy();
    return Promise.resolve();
  }
}
class RedisTarget implements Target {
  constructor(
    private readonly client: RedisClient,
    private readonly prefix: string,
    private readonly preserveKeys = false,
  ) {}
  version() {
    return redisVersion(this.client);
  }
  async check() {
    await this.client.ping();
  }
  async begin() {}
  async write(
    object: PlannedObject,
    row: Row,
    ordinal: number,
  ): Promise<boolean> {
    if (object.source.format === 'redis') {
      const key = this.preserveKeys
        ? Buffer.from(row.key as Buffer)
        : Buffer.concat([
            Buffer.from(
              this.prefix + ':' + encodeURIComponent(object.targetName) + ':',
            ),
            row.key as Buffer,
          ]);
      const expires = row.expiresAt === null ? null : Number(row.expiresAt);
      if (expires !== null && expires <= Date.now()) return false;
      // RESTORE without REPLACE refuses existing keys and preserves binary keys and native Redis types.
      await this.client.restore(
        key,
        expires === null ? 0 : Math.max(1, expires - Date.now()),
        row.dump as Buffer,
      );
    } else {
      const key =
        this.prefix +
        ':' +
        encodeURIComponent(object.targetName) +
        ':' +
        ordinal;
      const value = BSON.EJSON.stringify(bsonRow(object.source, row), {
        relaxed: false,
      });
      if (!(await this.client.set(key, value, { NX: true })))
        throw new MigrationError(
          'Destination Redis key already exists; choose another prefix',
        );
    }
    return true;
  }
  async commit() {}
  rollback() {
    return Promise.resolve(false);
  }
  close() {
    if (this.client.isOpen) this.client.destroy();
    return Promise.resolve();
  }
}
export async function redisIdentity(
  input: MigrationConnection,
): Promise<string> {
  const client = await connectRedis(input);
  try {
    const info = await client.info('server');
    const runId = /(?:^|\r?\n)run_id:([^\r\n]+)/.exec(String(info))?.[1];
    if (!runId)
      throw new MigrationError(
        'Cannot verify Redis server identity; INFO server permission is required for Redis-to-Redis migration',
      );
    const database = new URL(input.uri!).pathname.replace(/^\//, '') || '0';
    return runId + ':' + Number(database);
  } finally {
    if (client.isOpen) client.destroy();
  }
}
@Injectable()
export class MigrationConnectors {
  async source(input: MigrationConnection): Promise<Source> {
    if (input.engine === 'mongo') {
      const { client, db } = await connectMongo(input);
      return new MongoSource(client, db);
    }
    if (input.engine === 'redis')
      return new RedisSource(await connectRedis(input));
    return new SqlSource(await connectSql(input), input);
  }
  async target(
    input: MigrationConnection,
    prefix: string,
    mode?: MigrationMode,
  ): Promise<Target> {
    if (input.engine === 'mongo') {
      const { client, db } = await connectMongo(input);
      return new MongoTarget(client, db);
    }
    if (input.engine === 'redis')
      return new RedisTarget(
        await connectRedis(input),
        prefix,
        mode === 'upgrade',
      );
    return new SqlTarget(await connectSql(input), input);
  }
  async differentRedisDatabases(
    source: MigrationConnection,
    target: MigrationConnection,
  ) {
    if (source.engine !== 'redis' || target.engine !== 'redis') return;
    const [left, right] = await Promise.all([
      redisIdentity(source),
      redisIdentity(target),
    ]);
    if (left === right)
      throw new MigrationError(
        'Source and destination Redis databases must be different, including when host aliases are used',
      );
  }
}
