import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoClient } from 'mongodb';
import { MigrationConnectors } from './connectors';
import {
  identifier,
  MigrationError,
  sqlType,
  type Source,
  type Target,
} from './model';
import type {
  MigrationConnection,
  MigrationPlanRequest,
  MigrationPlan,
  MigrationStatus,
  PlannedObject,
} from './migration.types';

interface StoredPlan {
  view: MigrationPlan;
  request: MigrationPlanRequest;
  expires: number;
}
interface Job {
  status: MigrationStatus;
  abort: AbortController;
  finished?: number;
  done?: Promise<void>;
}
const PLAN_TTL = 15 * 60 * 1000;
const JOB_TTL = 60 * 60 * 1000;
const clone = <T>(value: T): T => structuredClone(value);
const failure = (error: unknown): string =>
  error instanceof MigrationError || error instanceof BadRequestException
    ? error.message
    : 'Database operation failed. Check connection, permissions, compatible data types and available space. Driver details are hidden to protect credentials and source values.';

export function validateConnection(input: MigrationConnection) {
  if (
    !input ||
    !['mysql', 'mongo', 'postgres', 'mssql', 'redis'].includes(input.engine)
  )
    throw new BadRequestException('Unsupported database engine');
  if (
    typeof input.database !== 'string' ||
    !input.database.trim() ||
    input.database.length > 128 ||
    input.database.includes('\0')
  )
    throw new BadRequestException('Database name is required');
  if (input.engine === 'mongo' || input.engine === 'redis') {
    try {
      if (
        !input.uri ||
        input.uri.length > 8192 ||
        Array.from(input.uri).some(
          (character) =>
            character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127,
        )
      )
        throw new Error();
      if (input.engine === 'mongo') {
        new MongoClient(input.uri);
        return;
      }
      const uri = new URL(input.uri);
      const allowed = ['redis:', 'rediss:'];
      if (!allowed.includes(uri.protocol) || !uri.hostname || uri.hash)
        throw new Error();
      if (
        input.engine === 'redis' &&
        (uri.search ||
          !/^\/(?:0|[1-9]\d*)?$/.test(uri.pathname || '/') ||
          Number(uri.pathname.slice(1)) > 2147483647 ||
          Number(input.database) !== Number(uri.pathname.slice(1) || 0))
      )
        throw new Error();
    } catch {
      throw new BadRequestException(
        'Invalid database URI or Redis database index',
      );
    }
  } else {
    if (
      !input.host?.trim() ||
      input.host.length > 255 ||
      !input.user?.trim() ||
      (input.port !== undefined &&
        (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535))
    )
      throw new BadRequestException('Host, user and a valid port are required');
  }
}
@Injectable()
export class MigrationService {
  private readonly plans = new Map<string, StoredPlan>();
  private readonly jobs = new Map<string, Job>();
  private preparing = 0;
  // Expired plans contain credentials. Release them on a timer even if no further request arrives.
  private readonly cleanup = setInterval(() => this.sweep(), 30_000).unref();
  constructor(private readonly connectors: MigrationConnectors) {}
  async onModuleDestroy() {
    clearInterval(this.cleanup);
    for (const job of this.jobs.values()) job.abort.abort();
    this.plans.clear();
    await Promise.allSettled(
      [...this.jobs.values()].map((job) => job.done ?? Promise.resolve()),
    );
  }
  private sweep() {
    const now = Date.now();
    for (const [id, plan] of this.plans)
      if (plan.expires <= now) this.plans.delete(id);
    for (const [id, job] of this.jobs)
      if (job.finished && now - job.finished >= JOB_TTL) this.jobs.delete(id);
  }
  async catalog(input: MigrationConnection) {
    validateConnection(input);
    if (this.preparing >= 3)
      throw new ServiceUnavailableException(
        'Too many concurrent catalog requests',
      );
    this.preparing++;
    let source: Source | undefined;
    try {
      source = await this.connectors.source(input);
      return { objects: await source.objects() };
    } catch (error) {
      throw new BadRequestException(failure(error));
    } finally {
      this.preparing--;
      await source?.close().catch(() => {});
    }
  }
  async prepare(request: MigrationPlanRequest): Promise<MigrationPlan> {
    this.sweep();
    if (this.preparing >= 3 || this.plans.size >= 30)
      throw new ServiceUnavailableException(
        'Too many migration plans. Retry after a few minutes.',
      );
    validateConnection(request.source);
    validateConnection(request.target);
    if (
      !Array.isArray(request.objects) ||
      !request.objects.length ||
      request.objects.length > 200
    )
      throw new BadRequestException('Select between 1 and 200 source objects');
    const engine = request.target.engine;
    const schema = ['mysql', 'mongo', 'redis'].includes(engine)
      ? ''
      : request.targetSchema || (engine === 'postgres' ? 'public' : 'dbo');
    const prefix = request.redisPrefix ?? 'migration';
    if (engine === 'redis' && !/^[A-Za-z0-9_-]{1,64}$/.test(prefix))
      throw new BadRequestException(
        'Redis prefix must contain 1 to 64 letters, digits, underscores or hyphens',
      );
    let source: Source | undefined;
    let target: Target | undefined;
    this.preparing++;
    try {
      await this.connectors.differentRedisDatabases(
        request.source,
        request.target,
      );
      source = await this.connectors.source(request.source);
      const catalog = await source.objects();
      const names = new Set<string>();
      const sources = new Set<string>();
      const objects: PlannedObject[] = request.objects.map((selection) => {
        const found = catalog.find(
          (object) => object.id === selection.sourceId,
        );
        if (!found)
          throw new BadRequestException(
            'Selected source object no longer exists',
          );
        if (sources.has(found.id))
          throw new BadRequestException(
            'A source object was selected more than once',
          );
        sources.add(found.id);
        if (!selection.targetName || selection.targetName.includes('\0'))
          throw new BadRequestException('Destination name is required');
        // Conservative comparison catches collisions on case-insensitive servers before writing.
        const folded = selection.targetName.toLowerCase();
        if (names.has(folded))
          throw new BadRequestException(
            'Destination object names must be distinct',
          );
        names.add(folded);
        if (!['mongo', 'redis'].includes(engine)) {
          identifier(selection.targetName, engine);
          if (schema) identifier(schema, engine);
          if (
            !found.columns.length ||
            found.columns.length > (engine === 'mssql' ? 1024 : 1000)
          )
            throw new BadRequestException(
              'Unsupported destination column count',
            );
          const columns = new Set<string>();
          for (const column of found.columns) {
            const folded = column.name.toLowerCase();
            if (columns.has(folded))
              throw new BadRequestException('Destination column names collide');
            columns.add(folded);
          }
        }
        return {
          source: found,
          targetName: selection.targetName,
          targetSchema: schema,
          columns: found.columns.map((column) => ({
            ...column,
            targetType:
              engine === 'mongo'
                ? found.format === 'documents'
                  ? 'BSON document'
                  : column.kind === 'json'
                    ? 'BSON JSON text'
                    : 'BSON ' + column.kind
                : engine === 'redis'
                  ? found.format === 'redis'
                    ? 'native Redis value'
                    : 'Extended JSON string'
                  : sqlType(column, engine),
          })),
        };
      });
      target = await this.connectors.target(request.target, prefix);
      await target.check(objects);
      const warnings = [
        'Only new destination objects are created. Existing tables, collections and Redis keys are never overwritten.',
        'Indexes, primary and foreign key constraints, triggers, defaults, computed expressions and database users are not recreated.',
        'The source remains unchanged. Stop application writes for a consistent migration across tables, collections and Redis keys.',
      ];
      if (engine === 'mongo')
        warnings.push(
          'MongoDB writes into temporary collections, then renames without replacing existing collections. Failure can leave temporary collections; their names appear in the final status. SQL JSON columns remain JSON text to preserve numeric precision.',
        );
      if (engine === 'mysql')
        warnings.push(
          'MySQL table creation cannot be rolled back. A failed or cancelled migration can leave empty destination tables; inserted rows are rolled back.',
        );
      if (engine === 'mongo' || engine === 'redis')
        warnings.push(
          'Writes are atomic per record. On failure or cancellation, records already written remain in the destination.',
        );
      if (!['mongo', 'redis'].includes(engine)) {
        warnings.push(
          'Dates and timestamps are stored as ISO text to preserve timezone offsets, zero dates and fractional precision. Unbounded decimals and unsupported source types are stored as text when necessary.',
        );
        if (request.source.engine === 'mongo')
          warnings.push(
            'Each MongoDB document becomes an _id plus a canonical Extended JSON document column, preserving nested structures and BSON types.',
          );
        if (request.source.engine === 'redis')
          warnings.push(
            'Each Redis key becomes a row with binary key, type, binary DUMP payload and absolute expiry in milliseconds. Redis values are not flattened into SQL columns.',
          );
      }
      if (request.source.engine === 'redis')
        warnings.push(
          'Redis uses SCAN and deduplicates key fingerprints in memory. Keys expiring during migration may be skipped; DUMP payloads require a compatible Redis version and modules when restored.',
        );
      if (engine === 'redis')
        warnings.push(
          request.source.engine === 'redis'
            ? 'Native Redis types and expiry are preserved. Destination keys use prefix:object:original-key; original key bytes are preserved after that namespace.'
            : 'Each source record is stored as a canonical Extended JSON string at prefix:object:row. Nested documents and BSON types remain encoded in that string.',
        );
      if (
        engine === 'mongo' &&
        objects.some((object) =>
          object.columns.some((column) => column.kind === 'decimal'),
        )
      )
        warnings.push(
          'MongoDB Decimal128 supports up to 34 significant digits; out-of-range decimal values fail without rounding.',
        );
      const expires = Date.now() + PLAN_TTL;
      const view: MigrationPlan = {
        id: randomUUID(),
        expiresAt: new Date(expires).toISOString(),
        sourceEngine: request.source.engine,
        targetEngine: engine,
        objects,
        redisPrefix: prefix,
        warnings,
      };
      this.plans.set(view.id, {
        view: clone(view),
        request: clone(request),
        expires,
      });
      return clone(view);
    } catch (error) {
      throw new BadRequestException(failure(error));
    } finally {
      this.preparing--;
      await target?.close().catch(() => {});
      await source?.close().catch(() => {});
    }
  }
  start(id: string): MigrationStatus {
    this.sweep();
    const plan = this.plans.get(id);
    if (!plan)
      throw new NotFoundException(
        'Migration plan expired or has already been used. Build a new plan.',
      );
    if ([...this.jobs.values()].filter((job) => !job.finished).length >= 2)
      throw new ServiceUnavailableException(
        'Two migrations are already running',
      );
    this.plans.delete(id);
    const job: Job = {
      abort: new AbortController(),
      status: {
        id: randomUUID(),
        state: 'running',
        phase: 'connecting',
        read: 0,
        written: 0,
        skipped: 0,
        startedAt: new Date().toISOString(),
        warnings: [...plan.view.warnings],
      },
    };
    this.jobs.set(job.status.id, job);
    // Defer execution until the controller has sent the initial status.
    job.done = new Promise((resolve) =>
      setImmediate(() => {
        void this.run(job, plan).finally(resolve);
      }),
    );
    return clone(job.status);
  }
  status(id: string): MigrationStatus {
    this.sweep();
    const job = this.jobs.get(id);
    if (!job)
      throw new NotFoundException(
        'Migration job not found. The gateway may have restarted. Check the destination before retrying.',
      );
    return clone(job.status);
  }
  cancel(id: string): MigrationStatus {
    const job = this.jobs.get(id);
    if (!job)
      throw new NotFoundException(
        'Migration job not found. The gateway may have restarted. Check the destination before retrying.',
      );
    if (job.status.state === 'running' && job.status.phase !== 'committing')
      job.abort.abort();
    return clone(job.status);
  }
  private async run(job: Job, plan: StoredPlan) {
    let source: Source | undefined;
    let target: Target | undefined;
    let writing = false;
    let committed = false;
    const signal = job.abort.signal;
    try {
      signal.throwIfAborted();
      await this.connectors.differentRedisDatabases(
        plan.request.source,
        plan.request.target,
      );
      source = await this.connectors.source(plan.request.source);
      const current = await source.objects();
      for (const object of plan.view.objects)
        if (
          JSON.stringify(
            current.find((candidate) => candidate.id === object.source.id),
          ) !== JSON.stringify(object.source)
        )
          throw new MigrationError(
            'Source structure changed after planning; build a new plan',
          );
      target = await this.connectors.target(
        plan.request.target,
        plan.view.redisPrefix,
      );
      await target.check(plan.view.objects);
      signal.throwIfAborted();
      writing = true;
      await target.begin(plan.view.objects);
      job.status.phase = 'copying';
      for (const object of plan.view.objects) {
        job.status.object = object.source.name;
        let ordinal = 0;
        for await (const row of source.read(object.source, signal)) {
          signal.throwIfAborted();
          job.status.read++;
          if (await target.write(object, row, ++ordinal)) job.status.written++;
          else job.status.skipped++;
        }
      }
      signal.throwIfAborted();
      job.status.phase = 'committing';
      await target.commit();
      committed = true;
      job.status.state = 'done';
    } catch (error) {
      job.status.state = signal.aborted ? 'cancelled' : 'failed';
      job.status.error = signal.aborted
        ? 'Migration cancelled'
        : failure(error);
      if (target && writing && !committed) {
        try {
          const rolledBack = await target.rollback();
          if (rolledBack) {
            job.status.written = 0;
            job.status.warnings.push('Inserted rows were rolled back.');
          } else
            job.status.warnings.push(
              'Records already written remain in the destination; review them before retrying.',
            );
        } catch {
          job.status.warnings.push(
            'Rollback could not be confirmed. Check the destination before retrying.',
          );
        }
      }
    } finally {
      job.status.warnings.push(...(target?.warnings?.() ?? []));
      await target?.close().catch(() => {});
      await source?.close().catch(() => {});
      job.finished = Date.now();
      job.status.finishedAt = new Date(job.finished).toISOString();
      job.status.phase = 'finished';
    }
  }
}
