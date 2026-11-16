import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Client } from 'pg';
import type { Transaction as MssqlTransaction } from 'mssql';
import {
  MysqlExportService,
  type DocumentColumn,
  type DocumentSource,
  type DocumentTable,
} from './mysql-export.service';
import type { DbfSession } from '../types/dbf-session.types';
import type { DbfRelationship } from '../types/dbf-relationship.types';
import type {
  MysqlConnectionInfo,
  MysqlImportProgress,
  MysqlImportResult,
} from '../types/mysql-export.types';
import type {
  SqlConnectionInput,
  SqlDialect,
  SqlImportOptions,
  SqlImportPlan,
  SqlImportStatus,
} from '../types/sql-import.types';

type Mutable<T> = { -readonly [P in keyof T]: T[P] };
type Cell = string | boolean | Buffer | null;
export interface SqlParameter {
  value: Cell;
  column: DocumentColumn;
}
export interface SqlAdapter {
  query(
    this: void,
    sql: string,
    params?: readonly SqlParameter[],
  ): Promise<Record<string, unknown>[]>;
  begin(this: void): Promise<void>;
  commit(this: void): Promise<void>;
  rollback(this: void): Promise<void>;
  close(this: void): Promise<void>;
}
interface Job {
  id: string;
  dialect: SqlDialect;
  database: string;
  startedAt: number;
  finishedAt?: number;
  state: SqlImportStatus['state'];
  cancel: boolean;
  error?: string;
  result?: MysqlImportResult;
  progress: Mutable<Omit<MysqlImportProgress, 'elapsedMs'>>;
}
class Cancelled extends Error {}
export const quoteIdentifier = (name: string) =>
  '"' + name.replace(/"/g, '""') + '"';
const columnsOf = (t: DocumentTable) => t.columns.filter((c) => !c.excluded);
export function nativeType(c: DocumentColumn, dialect: SqlDialect): string {
  const override = (c as DocumentColumn & { sqlType?: string }).sqlType;
  if (override) return override;
  switch (c.kind) {
    case 'bool':
      return dialect === 'postgres' ? 'boolean' : 'bit';
    case 'int32':
      return 'integer';
    case 'double':
      return dialect === 'postgres' ? 'double precision' : 'float';
    case 'date':
      return 'date';
    case 'datetime':
      return dialect === 'postgres'
        ? 'timestamp without time zone'
        : 'datetime2';
    case 'binary':
    case 'memoBinary':
      return dialect === 'postgres' ? 'bytea' : 'varbinary(max)';
    case 'currency':
      return 'decimal(19,4)';
    case 'number': {
      if (c.field.type === 'F')
        return dialect === 'postgres' ? 'double precision' : 'float';
      const scale = c.field.decimalCount;
      if (dialect === 'postgres') return 'numeric';
      if (scale > 38)
        throw new BadRequestException(
          c.name + ': SQL Server supports at most 38 decimal digits',
        );
      return 'decimal(38,' + scale + ')';
    }
    case 'memoText':
      return dialect === 'postgres' ? 'text' : 'nvarchar(max)';
    default:
      return dialect === 'postgres'
        ? 'text COLLATE "C"'
        : c.field.length > 450
          ? 'nvarchar(max)'
          : 'nvarchar(450) COLLATE Latin1_General_100_BIN2';
  }
}
export function parameterValue(
  value: string | null,
  c: DocumentColumn,
  dialect: SqlDialect,
): Cell {
  if (value === null) return null;
  if (c.kind === 'binary' || c.kind === 'memoBinary')
    return Buffer.from(value, 'hex');
  if (c.kind === 'bool') return value === '1';
  if (
    dialect === 'postgres' &&
    (c.kind === 'text' || c.kind === 'memoText') &&
    value.includes('\0')
  )
    throw new BadRequestException(
      c.name + ': PostgreSQL text cannot contain a zero byte',
    );
  if (
    dialect === 'mssql' &&
    (c.kind === 'number' || c.kind === 'currency' || c.kind === 'int32') &&
    c.field.type !== 'F'
  ) {
    const m = /^-?(\d+)(?:\.(\d+))?$/.exec(value);
    const aligned = /^decimal\((\d+),(\d+)\)$/.exec(nativeType(c, dialect));
    const scale = aligned
      ? Number(aligned[2])
      : c.kind === 'currency'
        ? 4
        : c.field.decimalCount;
    const precision = aligned
      ? Number(aligned[1])
      : c.kind === 'currency'
        ? 19
        : 38;
    if (
      !m ||
      m[1].replace(/^0+/, '').length > precision - scale ||
      (m[2]?.length ?? 0) > scale
    )
      throw new BadRequestException(
        c.name + ': value exceeds SQL Server decimal precision',
      );
  }
  return value;
}

@Injectable()
export class SqlImportService {
  private readonly jobs = new Map<string, Job>();
  constructor(private readonly sourceService: MysqlExportService) {}

  prepare(
    session: DbfSession,
    relationships: readonly DbfRelationship[],
    options: SqlImportOptions,
    dialect: SqlDialect,
  ) {
    const source = this.sourceService.documentSource(
      session,
      relationships,
      options,
      'sql',
    );
    const tables = source.tables.filter((t) => !t.excluded);
    // A checked link may connect DBF integer, numeric and currency fields. Align whole
    // connected components so SQL Server accepts the FK without rounding source values.
    const groups: Set<DocumentColumn>[] = [];
    for (const link of source.links) {
      const child = columnsOf(link.child.table).find(
        (c) => c.name === link.child.column,
      )!;
      const parent = columnsOf(link.parent.table).find(
        (c) => c.name === link.parent.column,
      )!;
      const touching = groups.filter((g) => g.has(child) || g.has(parent));
      const group = new Set([
        child,
        parent,
        ...touching.flatMap((g) => [...g]),
      ]);
      for (const g of touching) groups.splice(groups.indexOf(g), 1);
      groups.push(group);
    }
    for (const group of groups) {
      const columns = [...group];
      if (new Set(columns.map((c) => nativeType(c, dialect))).size < 2)
        continue;
      let type: string;
      if (
        columns.every(
          (c) =>
            ['number', 'int32', 'currency'].includes(c.kind) &&
            c.field.type !== 'F',
        )
      ) {
        const scale = Math.max(
          ...columns.map((c) =>
            c.kind === 'currency'
              ? 4
              : c.kind === 'int32'
                ? 0
                : c.field.decimalCount,
          ),
        );
        if (dialect === 'mssql' && scale > 38)
          throw new BadRequestException(
            'Foreign key numeric precision exceeds SQL Server limits',
          );
        type = dialect === 'postgres' ? 'numeric' : 'decimal(38,' + scale + ')';
      } else if (
        columns.every((c) => c.kind === 'date' || c.kind === 'datetime')
      )
        type =
          dialect === 'postgres' ? 'timestamp without time zone' : 'datetime2';
      else
        throw new BadRequestException(
          'Incompatible native foreign key types; disable foreign keys to import these tables',
        );
      for (const c of columns)
        (c as DocumentColumn & { sqlType?: string }).sqlType = type;
    }
    if (!tables.length)
      throw new BadRequestException('No tables selected for import');
    const max = dialect === 'postgres' ? 63 : 128;
    const names = new Set<string>();
    for (const t of tables) {
      for (const name of [t.name, ...(t.deletedName ? [t.deletedName] : [])]) {
        if (Buffer.byteLength(name) > max)
          throw new BadRequestException(
            'Table identifier is too long: ' + name,
          );
        if (names.has(name.toLowerCase()))
          throw new BadRequestException('Conflicting table names: ' + name);
        names.add(name.toLowerCase());
      }
      if (
        t.deletedName &&
        columnsOf(t).some((c) => c.name.toLowerCase() === '_dbf_recno')
      )
        throw new BadRequestException(
          'Reserved deleted-record column: _dbf_recno',
        );
      if (
        columnsOf(t).length + (t.deletedName ? 1 : 0) >
        (dialect === 'mssql' ? 1024 : 1600)
      )
        throw new BadRequestException(
          'Too many columns for the target database',
        );
      for (const c of columnsOf(t)) {
        if (Buffer.byteLength(c.name) > max)
          throw new BadRequestException(
            'Column identifier is too long: ' + c.name,
          );
        const type = nativeType(c, dialect);
        if (dialect === 'mssql' && c.key && /max|binary/i.test(type))
          throw new BadRequestException(
            t.fileName + '.' + c.name + ': unsupported SQL Server key type',
          );
      }
    }
    const plan: SqlImportPlan = {
      dialect,
      tables: tables.flatMap((t) => [
        {
          fileName: t.fileName,
          table: t.name,
          rowCount: options.includeData ? t.rowCount : 0,
          columns: columnsOf(t).map((c) => ({
            name: c.name,
            type: nativeType(c, dialect),
            key: c.key,
          })),
        },
        ...(t.deletedName
          ? [
              {
                fileName: t.fileName,
                table: t.deletedName,
                rowCount: t.deletedCount,
                columns: [
                  { name: '_dbf_recno', type: 'integer', key: null },
                  ...columnsOf(t).map((c) => ({
                    name: c.name,
                    type: nativeType(c, dialect),
                    key: null,
                  })),
                ],
              },
            ]
          : []),
      ]),
      quality: source.quality,
      warnings: [...source.warnings],
    };
    // Complex FoxPro expressions do not have the same ordering semantics in these engines.
    if (options.indexes && tables.some((t) => t.tags.length))
      plan.warnings.push(
        'CDX candidate keys are preserved; secondary CDX expression indexes are not transferred.',
      );
    return { source, plan };
  }

  async testConnection(
    dialect: SqlDialect,
    input: SqlConnectionInput,
  ): Promise<MysqlConnectionInfo> {
    const db = await this.connect(dialect, input);
    try {
      const rows = await db.query(
        dialect === 'postgres'
          ? 'SELECT version() AS version'
          : 'SELECT @@VERSION AS version',
      );
      return {
        serverVersion:
          typeof rows[0]?.version === 'string' ? rows[0].version : 'unknown',
        databases: [input.database],
      };
    } catch {
      throw new BadRequestException(
        'Could not read database server information',
      );
    } finally {
      await db.close().catch(() => {});
    }
  }

  async startImport(
    session: DbfSession,
    relationships: readonly DbfRelationship[],
    options: SqlImportOptions,
    dialect: SqlDialect,
    input: SqlConnectionInput,
  ): Promise<SqlImportStatus> {
    if (options.writeMode !== 'replace' && options.writeMode !== 'append')
      throw new BadRequestException('Only replace and append are supported');
    const { source, plan } = this.prepare(
      session,
      relationships,
      options,
      dialect,
    );
    if (plan.quality.some((q) => q.effect === 'fail'))
      throw new BadRequestException(
        'Resolve blocking data quality issues before importing',
      );
    // Preflight engine-specific values before any DDL is executed.
    if (options.includeData)
      for (const t of source.tables.filter((t) => !t.excluded)) {
        const columns = columnsOf(t);
        for (const set of t.deletedName
          ? (['live', 'deleted'] as const)
          : (['live'] as const))
          for (const record of t.records(set))
            record.values.forEach((v, i) =>
              parameterValue(v, columns[i], dialect),
            );
      }
    const db = await this.connect(dialect, input);
    for (const [id, job] of this.jobs)
      if (job.finishedAt && Date.now() - job.finishedAt > 3600000)
        this.jobs.delete(id);
    const job: Job = {
      id: randomUUID(),
      dialect,
      database: input.database,
      startedAt: Date.now(),
      state: 'running',
      cancel: false,
      progress: {
        phase: 'tables',
        tableIndex: 0,
        tableCount: plan.tables.length,
        table: null,
        tableRowsDone: 0,
        tableRows: 0,
        rowsDone: 0,
        rowsTotal: plan.tables.reduce((n, t) => n + t.rowCount, 0),
        foreignKeysDone: 0,
        foreignKeysTotal: source.links.length,
      },
    };
    this.jobs.set(job.id, job);
    void this.run(job, source, plan, options, db);
    return this.status(job);
  }

  getStatus(dialect: SqlDialect, id: string): SqlImportStatus {
    return this.status(this.getJob(dialect, id));
  }
  cancel(dialect: SqlDialect, id: string): SqlImportStatus {
    const job = this.getJob(dialect, id);
    if (job.state === 'running') job.cancel = true;
    return this.status(job);
  }
  private getJob(dialect: SqlDialect, id: string): Job {
    const job = this.jobs.get(id);
    if (!job || job.dialect !== dialect)
      throw new NotFoundException('Import not found');
    return job;
  }
  private status(job: Job): SqlImportStatus {
    return {
      jobId: job.id,
      database: job.database,
      state: job.state,
      progress: {
        ...job.progress,
        elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt,
      },
      result: job.result,
      error: job.error,
    };
  }

  private async run(
    job: Job,
    source: DocumentSource,
    plan: SqlImportPlan,
    options: SqlImportOptions,
    db: SqlAdapter,
  ) {
    const q = quoteIdentifier;
    const schema = job.dialect === 'postgres' ? 'public' : 'dbo';
    const table = (name: string) => q(schema) + '.' + q(name);
    const check = () => {
      if (job.cancel) throw new Cancelled();
    };
    let transaction = false;
    try {
      await db.begin();
      transaction = true;
      // No CASCADE: dependencies outside this import must never be removed implicitly.
      if (options.writeMode === 'replace') {
        if (job.dialect === 'postgres')
          await db.query(
            'DROP TABLE IF EXISTS ' +
              plan.tables.map((t) => table(t.table)).join(', '),
          );
        else {
          // Only remove FKs between tables in this plan. External dependencies cause a rollback.
          const names = new Set(plan.tables.map((t) => t.table));
          const fks = await db.query(
            "SELECT fk.name AS name, p.name AS child, r.name AS parent FROM sys.foreign_keys fk JOIN sys.tables p ON p.object_id=fk.parent_object_id JOIN sys.tables r ON r.object_id=fk.referenced_object_id JOIN sys.schemas ps ON ps.schema_id=p.schema_id JOIN sys.schemas rs ON rs.schema_id=r.schema_id WHERE ps.name='dbo' AND rs.name='dbo'",
          );
          for (const fk of fks)
            if (names.has(String(fk.child)) && names.has(String(fk.parent)))
              await db.query(
                'ALTER TABLE ' +
                  table(String(fk.child)) +
                  ' DROP CONSTRAINT ' +
                  q(String(fk.name)),
              );
          for (const t of plan.tables) {
            check();
            await db.query('DROP TABLE IF EXISTS ' + table(t.table));
          }
        }
      }
      const created = new Set<string>();
      for (const t of source.tables.filter((t) => !t.excluded))
        for (const deleted of t.deletedName ? [false, true] : [false]) {
          check();
          const name = deleted ? t.deletedName! : t.name;
          const columns = columnsOf(t);
          const expected = plan.tables.find((x) => x.table === name)!;
          const p = job.progress;
          p.table = name;
          p.tableIndex++;
          p.tableRowsDone = 0;
          p.tableRows = expected.rowCount;
          const exists = await db.query(
            job.dialect === 'postgres'
              ? 'SELECT 1 AS present FROM information_schema.tables WHERE table_schema=$1 AND table_name=$2'
              : 'SELECT 1 AS present FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=@p0 AND TABLE_NAME=@p1',
            [schema, name].map((value) => ({
              value,
              column: { ...columns[0], kind: 'text' as const },
            })),
          );
          if (!exists.length) {
            const definitions = columns.map(
              (c) =>
                q(c.name) +
                ' ' +
                nativeType(c, job.dialect) +
                (!deleted && !c.nullable ? ' NOT NULL' : ' NULL') +
                (!deleted && c.key === 'PRI'
                  ? ' PRIMARY KEY'
                  : !deleted && c.key === 'UNI'
                    ? ' UNIQUE'
                    : ''),
            );
            if (deleted)
              definitions.unshift(q('_dbf_recno') + ' integer NOT NULL');
            await db.query(
              'CREATE TABLE ' +
                table(name) +
                ' (' +
                definitions.join(', ') +
                ')',
            );
            created.add(name);
          }
          if (!options.includeData) continue;
          const names = [
            ...(deleted ? ['_dbf_recno'] : []),
            ...columns.map((c) => c.name),
          ];
          const recno: DocumentColumn = {
            ...columns[0],
            kind: 'int32',
            name: '_dbf_recno',
          };
          const params: SqlParameter[] = [];
          const tuples: string[] = [];
          // SQL Server allows 2100 parameters per request; keep memory bounded for large memo fields.
          const batchRows = Math.max(
            1,
            Math.min(100, Math.floor(2000 / names.length)),
          );
          if (names.length > 2000)
            throw new BadRequestException(
              'Too many columns for one SQL request',
            );
          let bytes = 0;
          const flush = async () => {
            if (!tuples.length) return;
            check();
            await db.query(
              'INSERT INTO ' +
                table(name) +
                ' (' +
                names.map(q).join(',') +
                ') VALUES ' +
                tuples.join(','),
              params,
            );
            p.rowsDone += tuples.length;
            p.tableRowsDone += tuples.length;
            tuples.length = 0;
            params.length = 0;
            bytes = 0;
          };
          for (const record of t.records(deleted ? 'deleted' : 'live')) {
            const values: SqlParameter[] = record.values.map((v, i) => ({
              value: parameterValue(v, columns[i], job.dialect),
              column: columns[i],
            }));
            if (deleted)
              values.unshift({ value: String(record.recno), column: recno });
            const placeholders = values.map((param) => {
              params.push(param);
              bytes +=
                typeof param.value === 'string'
                  ? param.value.length * 2
                  : Buffer.isBuffer(param.value)
                    ? param.value.length
                    : 8;
              return job.dialect === 'postgres'
                ? '$' + params.length
                : '@p' + (params.length - 1);
            });
            tuples.push('(' + placeholders.join(',') + ')');
            if (tuples.length >= batchRows || bytes >= 1024 * 1024)
              await flush();
          }
          await flush();
        }
      job.progress.phase = 'foreign_keys';
      for (const link of source.links) {
        check();
        // Existing tables keep their constraints; append never modifies their schema.
        if (!created.has(link.child.table.name)) continue;
        await db.query(
          'ALTER TABLE ' +
            table(link.child.table.name) +
            ' ADD FOREIGN KEY (' +
            q(link.child.column) +
            ') REFERENCES ' +
            table(link.parent.table.name) +
            ' (' +
            q(link.parent.column) +
            ')',
        );
        job.progress.foreignKeysDone++;
      }
      job.progress.phase = 'verifying';
      const verified: MysqlImportResult['tables'][number][] = [];
      for (const t of plan.tables) {
        check();
        const rows = await db.query(
          'SELECT COUNT(*) AS n FROM ' + table(t.table),
        );
        const count = Number(rows[0]?.n);
        if (
          !Number.isSafeInteger(count) ||
          count < t.rowCount ||
          (options.writeMode === 'replace' && count !== t.rowCount)
        )
          throw new Error('Row verification failed');
        verified.push({
          fileName: t.fileName,
          table: t.table,
          role: source.tables.some((s) => s.deletedName === t.table)
            ? 'deleted'
            : 'table',
          expectedRows: t.rowCount,
          importedRows: count,
        });
      }
      const version = await db.query(
        job.dialect === 'postgres'
          ? 'SELECT version() AS version'
          : 'SELECT @@VERSION AS version',
      );
      check();
      await db.commit();
      transaction = false;
      job.result = {
        database: job.database,
        serverVersion:
          typeof version[0]?.version === 'string'
            ? version[0].version
            : 'unknown',
        durationMs: Date.now() - job.startedAt,
        writeMode: options.writeMode,
        syncDeletes: false,
        tables: verified,
        foreignKeysCreated: job.progress.foreignKeysDone,
        indexesCreated: 0,
        warnings: plan.warnings,
      };
      job.state = 'done';
    } catch (err) {
      let rolledBack = !transaction;
      if (transaction) {
        try {
          await db.rollback();
          rolledBack = true;
        } catch {
          /* Connection may have been lost. */
        }
      }
      job.state = err instanceof Cancelled ? 'cancelled' : 'failed';
      // Never expose source row values, SQL parameters, or connection credentials.
      const code = (err as { code?: string | number }).code;
      job.error =
        (err instanceof Cancelled
          ? 'Import cancelled.'
          : 'Import failed' +
            (code
              ? ' (' + String(code).replace(/[^A-Za-z0-9_-]/g, '') + ')'
              : '') +
            (job.progress.table ? ' at ' + job.progress.table : '') +
            '.') +
        (rolledBack
          ? ' All import changes were rolled back.'
          : 'Rollback could not be confirmed; check the database before retrying.');
    } finally {
      job.finishedAt = Date.now();
      await db.close().catch(() => {});
    }
  }

  private async connect(
    dialect: SqlDialect,
    input: SqlConnectionInput,
  ): Promise<SqlAdapter> {
    if (dialect === 'postgres') {
      const client = new Client({
        host: input.host,
        port: input.port,
        user: input.user,
        password: input.password,
        database: input.database,
        connectionTimeoutMillis: 10000,
        query_timeout: 120000,
        ssl: input.encrypt
          ? { rejectUnauthorized: !input.trustServerCertificate }
          : false,
      });
      client.on('error', () => {
        /* In-flight queries report the connection failure. */
      });
      try {
        await client.connect();
      } catch {
        await client.end().catch(() => {});
        throw new BadRequestException(
          'PostgreSQL connection failed. Check host, port, database, credentials and TLS settings.',
        );
      }
      return {
        query: async (sql, params = []) =>
          (
            await client.query(
              sql,
              params.map((p) => p.value),
            )
          ).rows as Record<string, unknown>[],
        begin: async () => {
          await client.query('BEGIN');
        },
        commit: async () => {
          await client.query('COMMIT');
        },
        rollback: async () => {
          await client.query('ROLLBACK');
        },
        close: () => client.end(),
      };
    }
    const mssql = (await import('mssql')).default;
    const pool = new mssql.ConnectionPool({
      server: input.host,
      port: input.port,
      user: input.user,
      password: input.password,
      database: input.database,
      connectionTimeout: 10000,
      requestTimeout: 120000,
      pool: { max: 1, min: 0 },
      options: {
        encrypt: input.encrypt,
        trustServerCertificate: input.trustServerCertificate,
        enableArithAbort: true,
        enableQuotedIdentifier: true,
      },
    });
    pool.on('error', () => {});
    try {
      await pool.connect();
    } catch {
      await pool.close().catch(() => {});
      throw new BadRequestException(
        'SQL Server connection failed. Check host, port, database, credentials and TLS settings.',
      );
    }
    let tx: MssqlTransaction | undefined;
    return {
      query: async (sql, params = []) => {
        const request = tx ? new mssql.Request(tx) : pool.request();
        params.forEach((p, i) => {
          // Exact decimals travel as text and are converted by SQL Server, avoiding JS Number rounding.
          const type = Buffer.isBuffer(p.value)
            ? mssql.VarBinary(mssql.MAX)
            : typeof p.value === 'boolean'
              ? mssql.Bit
              : mssql.NVarChar(mssql.MAX);
          request.input('p' + i, type, p.value);
        });
        return (await request.query(sql)).recordset ?? [];
      },
      begin: async () => {
        tx = new mssql.Transaction(pool);
        await tx.begin();
      },
      commit: async () => {
        await tx!.commit();
        tx = undefined;
      },
      rollback: async () => {
        await tx!.rollback();
        tx = undefined;
      },
      close: () => pool.close(),
    };
  }
}
