import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import { createClient } from 'redis';
import {
  MysqlExportService,
  type DocumentSource,
  type DocumentTable,
} from './mysql-export.service';
import type { DbfSession } from '../types/dbf-session.types';
import type { DbfRelationship } from '../types/dbf-relationship.types';
import type {
  RedisOptions,
  RedisPlan,
  RedisImportStatus,
} from '../types/redis-import.types';

// Each record is atomic. Never delete keys, clear a database or silently overwrite another Redis type.
export const WRITE_HASH =
  "local t=redis.call('TYPE',KEYS[1]).ok; " +
  "if ARGV[1]=='new' and t~='none' then return 0 end; " +
  "if t~='none' and t~='hash' then return -1 end; " +
  "redis.call('HSET',KEYS[1],unpack(ARGV,3)); " +
  "local ttl=tonumber(ARGV[2]); if ttl>0 then redis.call('EXPIRE',KEYS[1],ttl) else redis.call('PERSIST',KEYS[1]) end; return 1";

type Client = ReturnType<typeof createClient>;
interface Job {
  status: RedisImportStatus;
  cancel: boolean;
  started: number;
  finished?: number;
  done?: Promise<void>;
}
class RedisRecordError extends Error {}
const FAILED =
  'Redis operation failed. Check the address, credentials, TLS, permissions, database index and available memory. Records already written remain in Redis.';
export function validateRedisUri(uri: string): URL {
  try {
    const url = new URL(uri);
    if (
      !['redis:', 'rediss:'].includes(url.protocol) ||
      !url.hostname ||
      url.search ||
      url.hash ||
      !/^\/(?:0|[1-9]\d*)?$/.test(url.pathname || '/') ||
      uri.length > 8192 ||
      // eslint-disable-next-line no-control-regex -- Reject raw controls and whitespace in connection URIs.
      /[\x00-\x20\x7f]/.test(uri) ||
      Number(url.pathname.slice(1)) > 2147483647
    )
      throw new Error();
    return url;
  } catch {
    throw new BadRequestException(
      'Invalid Redis URI. Use redis:// or rediss:// with a numeric database index.',
    );
  }
}
export function redisRecord(
  table: DocumentTable,
  name: string,
  prefix: string,
  values: readonly (string | null)[],
  recno: number,
) {
  const columns = table.columns.filter((c) => !c.excluded);
  const primary =
    name === table.name ? columns.findIndex((c) => c.key === 'PRI') : -1;
  const id =
    primary >= 0 && values[primary] !== null
      ? 'pk:' +
        createHash('sha256')
          .update(JSON.stringify(values[primary]))
          .digest('hex')
      : 'row:' + recno;
  return {
    key: prefix + ':' + name + ':' + id,
    fields: columns.flatMap((column, index) => [
      column.name,
      JSON.stringify(values[index]),
    ]),
  };
}
@Injectable()
export class RedisImportService {
  private readonly jobs = new Map<string, Job>();
  private active = 0;
  private stopping = false;
  constructor(private readonly source: MysqlExportService) {}
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    for (const job of this.jobs.values()) job.cancel = true;
    await Promise.allSettled(
      [...this.jobs.values()].map((job) => job.done ?? Promise.resolve()),
    );
  }
  private checkRunning(): void {
    if (this.stopping)
      throw new ServiceUnavailableException('The import service is stopping');
  }
  prepare(
    session: DbfSession,
    links: readonly DbfRelationship[],
    options: RedisOptions,
  ): { plan: RedisPlan; source: DocumentSource } {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(options.prefix) ||
      !['new', 'update'].includes(options.writeMode) ||
      !Number.isInteger(options.ttlSeconds) ||
      options.ttlSeconds < 0 ||
      options.ttlSeconds > 2147483647 ||
      typeof options.keepDeleted !== 'boolean'
    )
      throw new BadRequestException('Invalid Redis import options');
    const source = this.source.documentSource(
      session,
      links,
      {
        writeMode: 'append',
        includeData: true,
        foreignKeys: false,
        indexes: true,
        syncDeletes: false,
        emptyStringsAsNull: false,
        orphansAsNull: false,
        keepDeleted: options.keepDeleted,
        overrides: {},
      },
      'sql',
    );
    const tables = source.tables.filter((t) => !t.excluded);
    if (
      !tables.length ||
      tables.some((t) => !t.columns.some((c) => !c.excluded))
    )
      throw new BadRequestException(
        'No supported columns to import into Redis',
      );
    const plan: RedisPlan = {
      prefix: options.prefix,
      tables: tables.map((t) => ({
        fileName: t.fileName,
        table: t.name,
        deletedTable: t.deletedName,
        rowCount: t.rowCount,
        deletedRows: t.deletedCount,
        keyMode: t.columns.some((c) => !c.excluded && c.key === 'PRI')
          ? 'primary'
          : 'record',
        columns: t.columns
          .filter((c) => !c.excluded)
          .map((c) => ({ name: c.name, kind: c.kind })),
      })),
      warnings: [...source.warnings],
      quality: source.quality,
    };
    return { plan, source };
  }
  private async connect(uri: string): Promise<Client> {
    validateRedisUri(uri);
    let client: Client | undefined;
    try {
      client = createClient({
        url: uri,
        disableOfflineQueue: true,
        socket: {
          connectTimeout: 8000,
          socketTimeout: 10000,
          reconnectStrategy: false,
        },
      });
      client.on('error', () => {
        /* Never log driver messages or credentials. */
      });
      await client.connect();
      return client;
    } catch {
      if (client?.isOpen) client.destroy();
      throw new BadRequestException(FAILED);
    }
  }
  async startImport(
    session: DbfSession,
    links: readonly DbfRelationship[],
    options: RedisOptions,
    uri: string,
  ): Promise<RedisImportStatus> {
    this.checkRunning();
    const prepared = this.prepare(session, links, options);
    if (prepared.plan.quality.some((q) => q.effect === 'fail'))
      throw new BadRequestException(
        'Fix the blocking data issues before importing',
      );
    if (this.active >= 2)
      throw new ServiceUnavailableException(
        'Redis imports are busy; retry shortly',
      );
    this.active++;
    let client: Client;
    try {
      client = await this.connect(uri);
      if (this.stopping) {
        if (client.isOpen) client.destroy();
        this.checkRunning();
      }
    } catch (err) {
      this.active--;
      throw err;
    }
    for (const [id, job] of this.jobs)
      if (job.finished && Date.now() - job.finished > 3600000)
        this.jobs.delete(id);
    const tables = prepared.plan.tables;
    const job: Job = {
      cancel: false,
      started: Date.now(),
      status: {
        jobId: randomUUID(),
        database: new URL(uri).pathname.slice(1) || '0',
        state: 'running',
        progress: {
          phase: 'records',
          table: null,
          tableIndex: 0,
          tableCount:
            tables.length + tables.filter((t) => t.deletedTable).length,
          tableRowsDone: 0,
          rowsDone: 0,
          rowsTotal: tables.reduce(
            (sum, t) => sum + t.rowCount + (t.deletedTable ? t.deletedRows : 0),
            0,
          ),
          elapsedMs: 0,
        },
      },
    };
    this.jobs.set(job.status.jobId, job);
    job.done = this.run(job, prepared.source, options, client);
    return this.snapshot(job);
  }
  private async run(
    job: Job,
    source: DocumentSource,
    options: RedisOptions,
    client: Client,
  ) {
    const results: NonNullable<RedisImportStatus['result']>['tables'] = [];
    try {
      for (const table of source.tables.filter((t) => !t.excluded)) {
        for (const set of ['live', 'deleted'] as const) {
          const name = set === 'live' ? table.name : table.deletedName;
          if (!name) continue;
          const p = job.status.progress;
          p.table = name;
          p.tableIndex++;
          p.tableRowsDone = 0;
          const result = {
            fileName: table.fileName,
            table: name,
            expectedRows: set === 'live' ? table.rowCount : table.deletedCount,
            importedRows: 0,
            skippedRows: 0,
          };
          for (const record of table.records(set)) {
            if (job.cancel) {
              job.status.state = 'cancelled';
              return;
            }
            const row = redisRecord(
              table,
              name,
              options.prefix,
              record.values,
              record.recno,
            );
            // Bound Lua argument count and payload to avoid blocking Redis on exceptionally wide memo rows.
            if (
              row.fields.length > 2048 ||
              row.fields.reduce((n, v) => n + Buffer.byteLength(v), 0) >
                4 * 1024 * 1024
            )
              throw new RedisRecordError(
                'Record exceeds Redis import limits (1024 fields or 4 MiB). Earlier records remain in Redis.',
              );
            const written = await client.eval(WRITE_HASH, {
              keys: [row.key],
              arguments: [
                options.writeMode,
                String(options.ttlSeconds),
                ...row.fields,
              ],
            });
            if (written !== 0 && written !== 1)
              throw new RedisRecordError(
                'A destination key has a different Redis type. Choose another prefix. Earlier records remain in Redis.',
              );
            if (written === 1) result.importedRows++;
            else result.skippedRows++;
            p.rowsDone++;
            p.tableRowsDone++;
          }
          results.push(result);
        }
      }
      if (job.cancel) {
        job.status.state = 'cancelled';
        return;
      }
      job.status.state = 'done';
      job.status.result = {
        tables: results,
        warnings: source.warnings.slice(),
        durationMs: Date.now() - job.started,
      };
    } catch (error) {
      job.status.state = 'failed';
      job.status.error =
        error instanceof RedisRecordError ? error.message : FAILED;
    } finally {
      if (client.isOpen) client.destroy();
      this.active--;
      job.finished = Date.now();
    }
  }
  private snapshot(job: Job): RedisImportStatus {
    return {
      ...job.status,
      progress: {
        ...job.status.progress,
        elapsedMs: (job.finished ?? Date.now()) - job.started,
      },
    };
  }
  private find(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new NotFoundException('Redis import not found');
    return job;
  }
  getStatus(id: string) {
    return this.snapshot(this.find(id));
  }
  cancel(id: string) {
    const job = this.find(id);
    if (job.status.state === 'running') job.cancel = true;
    return this.snapshot(job);
  }
}
