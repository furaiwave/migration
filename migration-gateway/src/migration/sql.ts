import { createConnection, type Connection as MysqlConnection } from 'mysql2';
import { Client, types as pgTypes } from 'pg';
import { serverVersion } from './versions';
import type * as Mssql from 'mssql';
import type {
  MigrationConnection,
  MigrationObject,
  MigrationColumn,
  PlannedObject,
} from './migration.types';
import {
  identifier,
  qualified,
  sqlType,
  scalarText,
  MigrationError,
  type Source,
  type Target,
  type Row,
} from './model';

export interface SqlConnection {
  query(sql: string, parameters?: unknown[]): Promise<Row[]>;
  rows(sql: string, signal: AbortSignal): AsyncIterable<Row>;
  close(): Promise<void>;
}
const TIMEOUT = 120_000;
export async function connectSql(
  input: MigrationConnection,
): Promise<SqlConnection> {
  if (input.engine === 'mysql') {
    const db: MysqlConnection = createConnection({
      host: input.host,
      port: input.port ?? 3306,
      user: input.user,
      password: input.password,
      database: input.database,
      connectTimeout: 10000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      dateStrings: true,
      jsonStrings: true,
      ssl: input.encrypt
        ? { rejectUnauthorized: !input.trustServerCertificate }
        : undefined,
    });
    db.on('error', () => {});
    try {
      await db.promise().connect();
    } catch (error) {
      db.destroy();
      throw error;
    }
    return {
      query: async (sql, parameters = []) => {
        const [rows] = await db
          .promise()
          .query({ sql, timeout: TIMEOUT }, parameters);
        return Array.isArray(rows) ? (rows as Row[]) : [];
      },
      rows: async function* (sql, signal) {
        const stream = db
          .query({ sql, timeout: TIMEOUT })
          .stream({ highWaterMark: 32 });
        const abort = () =>
          stream.destroy(new MigrationError('Migration cancelled'));
        signal.addEventListener('abort', abort, { once: true });
        try {
          signal.throwIfAborted();
          for await (const row of stream) {
            signal.throwIfAborted();
            yield row;
          }
        } finally {
          signal.removeEventListener('abort', abort);
          stream.destroy();
        }
      },
      close: () => {
        db.destroy();
        return Promise.resolve();
      },
    };
  }
  if (input.engine === 'postgres') {
    const db = new Client({
      host: input.host,
      port: input.port ?? 5432,
      user: input.user,
      password: input.password,
      database: input.database,
      connectionTimeoutMillis: 10000,
      query_timeout: TIMEOUT,
      ssl: input.encrypt
        ? { rejectUnauthorized: !input.trustServerCertificate }
        : false,
      // pg defaults round timestamp fractions and int8 values when coerced to JS primitives.
      types: {
        getTypeParser: (oid: number) => {
          if ([1082, 1114, 1184, 20, 1700, 114, 3802].includes(oid))
            return (value: string) => value;
          return pgTypes.getTypeParser(oid) as (value: string) => unknown;
        },
      },
    });
    db.on('error', () => {});
    try {
      await db.connect();
    } catch (error) {
      await db.end().catch(() => {});
      throw error;
    }
    return {
      query: async (sql, parameters = []) =>
        (await db.query<Row>(sql, parameters)).rows,
      rows: async function* (sql, signal) {
        await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        try {
          await db.query(
            'DECLARE migration_cursor NO SCROLL CURSOR FOR ' + sql,
          );
          while (true) {
            signal.throwIfAborted();
            const result = await db.query(
              'FETCH FORWARD 250 FROM migration_cursor',
            );
            if (!result.rows.length) break;
            for (const row of result.rows) {
              signal.throwIfAborted();
              yield row;
            }
          }
        } finally {
          await db.query('ROLLBACK').catch(() => {});
        }
      },
      close: () => db.end(),
    };
  }
  const mssql = (await import('mssql')).default;
  const pool = new mssql.ConnectionPool({
    server: input.host!,
    port: input.port ?? 1433,
    user: input.user,
    password: input.password,
    database: input.database,
    connectionTimeout: 10000,
    requestTimeout: TIMEOUT,
    pool: { max: 1, min: 0 },
    options: {
      encrypt: input.encrypt ?? true,
      trustServerCertificate: input.trustServerCertificate ?? false,
    },
  });
  pool.on('error', () => {});
  try {
    await pool.connect();
  } catch (error) {
    await pool.close().catch(() => {});
    throw error;
  }
  let tx: Mssql.Transaction | undefined;
  const request = () => (tx ? new mssql.Request(tx) : pool.request());
  return {
    query: async (sql, parameters = []) => {
      if (sql === 'BEGIN') {
        tx = new mssql.Transaction(pool);
        await tx.begin();
        return [];
      }
      if (sql === 'COMMIT') {
        await tx!.commit();
        tx = undefined;
        return [];
      }
      if (sql === 'ROLLBACK') {
        if (tx) await tx.rollback();
        tx = undefined;
        return [];
      }
      const req = request();
      parameters.forEach((value, i) =>
        req.input(
          'p' + i,
          Buffer.isBuffer(value)
            ? mssql.VarBinary(mssql.MAX)
            : typeof value === 'boolean'
              ? mssql.Bit
              : mssql.NVarChar(mssql.MAX),
          Buffer.isBuffer(value) || typeof value === 'boolean' || value === null
            ? value
            : scalarText(value),
        ),
      );
      return (await req.query<Row>(sql)).recordset ?? [];
    },
    rows: async function* (sql, signal) {
      const req = request();
      const stream = req.toReadableStream({ highWaterMark: 32 });
      const abort = () => {
        req.cancel();
        stream.destroy(new MigrationError('Migration cancelled'));
      };
      signal.addEventListener('abort', abort, { once: true });
      // The stream forwards request errors; consume the query promise to avoid an unhandled rejection.
      void req
        .query(sql)
        .catch((error: unknown) =>
          stream.destroy(
            error instanceof Error ? error : new Error('SQL query failed'),
          ),
        );
      try {
        signal.throwIfAborted();
        for await (const row of stream) {
          signal.throwIfAborted();
          yield row;
        }
      } finally {
        signal.removeEventListener('abort', abort);
        req.cancel();
        stream.destroy();
      }
    },
    close: () => pool.close(),
  };
}

export function columnFromMetadata(row: Row): MigrationColumn {
  const type = String(row.type).toLowerCase();
  let kind: MigrationColumn['kind'] = 'text';
  if (
    /^(bool|boolean)$/.test(type) ||
    (type === 'bit' && row.engine === 'mssql')
  )
    kind = 'boolean';
  else if (type === 'bit' && row.engine === 'mysql') kind = 'binary';
  else if (
    /^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8)$/.test(
      type,
    )
  )
    kind = 'integer';
  else if (/^(decimal|numeric|money|smallmoney)$/.test(type)) kind = 'decimal';
  else if (/^(real|float|double|double precision|float4|float8)$/.test(type))
    kind = 'float';
  else if (
    /^(binary|varbinary|image|bytea|.*blob)$/.test(type) ||
    (/^(timestamp|rowversion)$/.test(type) && row.engine === 'mssql')
  )
    kind = 'binary';
  else if (type === 'date') kind = 'date';
  else if (
    /^(datetime.*|timestamp.*|timestamptz|smalldatetime|datetimeoffset)$/.test(
      type,
    )
  )
    kind = 'datetime';
  else if (/^(json|jsonb)$/.test(type)) kind = 'json';
  const column: MigrationColumn = {
    name: String(row.column),
    kind,
    nullable: row.nullable === 'YES',
  };
  if (kind === 'decimal' || kind === 'integer') {
    column.precision =
      Number(row.precision) || (kind === 'integer' ? 19 : undefined);
    column.scale = Number(row.scale) || 0;
  }
  return column;
}
async function sqlVersion(db: SqlConnection, input: MigrationConnection) {
  const query =
    input.engine === 'mssql'
      ? "SELECT CAST(SERVERPROPERTY('ProductVersion') AS varchar(128)) AS version"
      : input.engine === 'postgres'
        ? "SELECT current_setting('server_version') AS version"
        : 'SELECT VERSION() AS version';
  const rows = await db.query(query);
  return serverVersion(input.engine, rows[0]?.version);
}

export class SqlSource implements Source {
  constructor(
    private readonly db: SqlConnection,
    private readonly input: MigrationConnection,
  ) {}
  version() {
    return sqlVersion(this.db, this.input);
  }
  async objects(): Promise<MigrationObject[]> {
    const engine = this.input.engine;
    const mysql = engine === 'mysql';
    const rows = await this.db.query(
      `SELECT c.TABLE_SCHEMA AS ${identifier('schema', engine)}, c.TABLE_NAME AS ${identifier('table', engine)},
      c.COLUMN_NAME AS ${identifier('column', engine)}, c.DATA_TYPE AS ${identifier('type', engine)},
      c.IS_NULLABLE AS ${identifier('nullable', engine)}, c.NUMERIC_PRECISION AS ${identifier('precision', engine)},
      c.NUMERIC_SCALE AS ${identifier('scale', engine)}
      FROM INFORMATION_SCHEMA.COLUMNS c JOIN INFORMATION_SCHEMA.TABLES t
      ON c.TABLE_SCHEMA=t.TABLE_SCHEMA AND c.TABLE_NAME=t.TABLE_NAME
      WHERE t.TABLE_TYPE='BASE TABLE' AND ${mysql ? 'c.TABLE_SCHEMA = ?' : "c.TABLE_SCHEMA NOT IN ('information_schema','pg_catalog')"}
      ORDER BY c.TABLE_SCHEMA,c.TABLE_NAME,c.ORDINAL_POSITION`,
      mysql ? [this.input.database] : [],
    );
    const objects = new Map<string, MigrationObject>();
    for (const row of rows) {
      const id = JSON.stringify([row.schema, row.table]);
      if (!objects.has(id))
        objects.set(id, {
          id,
          schema: String(row.schema),
          name: String(row.table),
          format: 'rows',
          columns: [],
        });
      objects.get(id)!.columns.push(columnFromMetadata({ ...row, engine }));
    }
    if (objects.size > 1000)
      throw new MigrationError(
        'More than 1000 source tables; narrow the database before migrating',
      );
    return [...objects.values()];
  }
  async *read(object: MigrationObject, signal: AbortSignal) {
    const engine = this.input.engine;
    const columns = object.columns
      .map((column) => {
        const name = identifier(column.name, engine);
        // money output follows lc_monetary. Convert inside PostgreSQL before
        // serializing exact decimal text so currencies and separators never reach INSERT.
        if (engine === 'postgres' && column.kind === 'decimal')
          return 'CAST(CAST(' + name + ' AS numeric) AS text) AS ' + name;
        // Use server text for arrays and custom types so driver parsers cannot round nested numbers.
        if (engine === 'postgres' && column.kind === 'text')
          return 'CAST(' + name + ' AS text) AS ' + name;
        // SQL Server's driver turns exact decimals into Numbers. Convert on the server instead.
        if (
          engine === 'mssql' &&
          ['decimal', 'integer', 'date', 'datetime'].includes(column.kind)
        )
          return (
            'CONVERT(nvarchar(max),' +
            name +
            (['date', 'datetime'].includes(column.kind)
              ? ',127'
              : column.kind === 'decimal'
                ? ',2'
                : '') +
            ') AS ' +
            name
          );
        return name;
      })
      .join(',');
    const table =
      identifier(object.schema, engine) + '.' + identifier(object.name, engine);
    for await (const row of this.db.rows(
      'SELECT ' + columns + ' FROM ' + table,
      signal,
    )) {
      const normalized = Object.create(null) as Row;
      for (const column of object.columns) {
        let value = row[column.name] ?? null;
        if (value instanceof Date) value = value.toISOString();
        if (
          column.kind === 'json' &&
          value !== null &&
          typeof value !== 'string'
        )
          value = JSON.stringify(value);
        if (column.kind === 'boolean' && value !== null)
          value = value === true || value === 1 || value === '1';
        if (
          column.kind === 'text' &&
          value !== null &&
          typeof value === 'object' &&
          !Buffer.isBuffer(value)
        )
          value = JSON.stringify(value);
        normalized[column.name] = value;
      }
      yield normalized;
    }
  }
  close() {
    return this.db.close();
  }
}
export class SqlTarget implements Target {
  private began = false;
  private committed = false;
  private commitStarted = false;
  constructor(
    private readonly db: SqlConnection,
    private readonly input: MigrationConnection,
  ) {}
  version() {
    return sqlVersion(this.db, this.input);
  }
  async check(objects: PlannedObject[]) {
    const engine = this.input.engine;
    for (const object of objects) {
      for (const column of object.columns) {
        identifier(column.name, engine);
        sqlType(column, engine);
      }
      const schema = object.targetSchema || this.input.database;
      const markers =
        engine === 'mysql'
          ? ['?', '?']
          : engine === 'postgres'
            ? ['$1', '$2']
            : ['@p0', '@p1'];
      const rows = await this.db.query(
        'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA=' +
          markers[0] +
          ' AND TABLE_NAME=' +
          markers[1],
        [schema, object.targetName],
      );
      if (rows.length)
        throw new MigrationError(
          'Destination object already exists: ' +
            object.targetName +
            '. Choose another name.',
        );
    }
  }
  async begin(objects: PlannedObject[]) {
    if (this.input.engine === 'mysql')
      await this.db.query(
        "SET SESSION sql_mode='STRICT_ALL_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'",
      );
    if (this.input.engine !== 'mysql') {
      await this.db.query('BEGIN');
      this.began = true;
    }
    for (const object of objects) {
      const columns = object.columns
        .map(
          (column) =>
            identifier(column.name, this.input.engine) +
            ' ' +
            sqlType(column, this.input.engine) +
            (column.nullable ? ' NULL' : ' NOT NULL'),
        )
        .join(',');
      await this.db.query(
        'CREATE TABLE ' +
          qualified(object, this.input.engine) +
          ' (' +
          columns +
          ')' +
          (this.input.engine === 'mysql'
            ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
            : ''),
      );
    }
    if (this.input.engine === 'mysql') {
      await this.db.query('BEGIN');
      this.began = true;
    }
  }
  async write(object: PlannedObject, row: Row): Promise<boolean> {
    const engine = this.input.engine;
    const values = object.columns.map((column) => {
      const value = row[column.name] ?? null;
      if (
        value === null ||
        Buffer.isBuffer(value) ||
        typeof value === 'boolean'
      )
        return value;
      if (column.kind === 'json' && typeof value !== 'string')
        return JSON.stringify(value);
      if (value instanceof Date) return value.toISOString();
      return scalarText(value);
    });
    const markers = values.map((_, i) =>
      engine === 'mysql'
        ? '?'
        : engine === 'postgres'
          ? '$' + (i + 1)
          : '@p' + i,
    );
    await this.db.query(
      'INSERT INTO ' +
        qualified(object, engine) +
        ' (' +
        object.columns
          .map((column) => identifier(column.name, engine))
          .join(',') +
        ') VALUES (' +
        markers.join(',') +
        ')',
      values,
    );
    return true;
  }
  async commit() {
    this.commitStarted = true;
    await this.db.query('COMMIT');
    this.committed = true;
    this.began = false;
  }
  async rollback(): Promise<boolean> {
    if (this.committed) return false;
    if (this.commitStarted)
      throw new MigrationError('Commit outcome cannot be confirmed');
    if (this.began) {
      await this.db.query('ROLLBACK');
      this.began = false;
    }
    return true;
  }
  close() {
    return this.db.close();
  }
}
