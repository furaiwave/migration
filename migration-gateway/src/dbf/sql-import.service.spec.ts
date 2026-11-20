import {
  SqlImportService,
  nativeType,
  parameterValue,
  quoteIdentifier,
  type SqlAdapter,
} from './sql-import.service';
import {
  MysqlExportService,
  type DocumentColumn,
  type DocumentSource,
  type DocumentTable,
} from './mysql-export.service';
import { toFileName, toSessionId } from '../types/dbf-relationship.types';
import type { DbfSession } from '../types/dbf-session.types';
import type { SqlDialect, SqlImportOptions } from '../types/sql-import.types';

const column: DocumentColumn = {
  name: 'amount',
  kind: 'number',
  key: null,
  excluded: false,
  nullable: true,
  field: {
    name: 'AMOUNT',
    type: 'N',
    length: 25,
    decimalCount: 2,
  } as DocumentColumn['field'],
};
const options: SqlImportOptions = {
  writeMode: 'replace',
  includeData: true,
  foreignKeys: true,
  indexes: true,
  keepDeleted: false,
  emptyStringsAsNull: true,
  orphansAsNull: true,
  syncDeletes: false,
  overrides: {},
};
const input = {
  host: 'localhost',
  port: 5432,
  user: 'tester',
  password: 'never-log-this',
  database: 'legacy',
  encrypt: true,
  trustServerCertificate: false,
};
const session: DbfSession = {
  id: toSessionId('test-session'),
  createdAt: new Date(),
  files: new Map(),
  sources: new Map(),
  manualRels: [],
  disabledRels: new Set(),
  encodings: new Map(),
  previewRows: 0,
};
function table(values = ['12345678901234567890.12']): DocumentTable {
  return {
    fileName: toFileName('AMOUNTS.DBF'),
    name: 'amounts',
    deletedName: null,
    rowCount: values.length,
    deletedCount: 0,
    encoding: 'utf-8',
    memoFile: null,
    indexFile: null,
    excluded: false,
    skippedFields: [],
    primaryTag: null,
    tags: [],
    dbfFieldNames: ['AMOUNT'],
    columns: [{ ...column }],
    records: function* () {
      for (const [i, v] of values.entries())
        yield { recno: i + 1, values: [v] };
    },
  };
}
function setup(t = table()) {
  const source: DocumentSource = {
    tables: [t],
    links: [],
    foreignKeys: [],
    quality: [],
    warnings: [],
  };
  const exporter = new MysqlExportService();
  jest.spyOn(exporter, 'documentSource').mockReturnValue(source);
  const service = new SqlImportService(exporter);
  const statements: { sql: string; values: unknown[] }[] = [];
  const db: SqlAdapter = {
    query: jest.fn((sql, params = []) => {
      statements.push({ sql, values: params.map((p) => p.value) });
      if (sql.startsWith('SELECT COUNT'))
        return Promise.resolve([{ n: t.rowCount }]);
      if (sql.includes('AS version'))
        return Promise.resolve([{ version: 'test-server' }]);
      return Promise.resolve([]);
    }),
    begin: jest.fn(async () => {}),
    commit: jest.fn(async () => {}),
    rollback: jest.fn(async () => {}),
    close: jest.fn(async () => {}),
  };
  const connect = jest
    .spyOn(
      service as unknown as {
        connect: (d: SqlDialect, c: typeof input) => Promise<SqlAdapter>;
      },
      'connect',
    )
    .mockResolvedValue(db);
  return { service, exporter, db, statements, source, connect };
}
async function finished(
  service: SqlImportService,
  dialect: SqlDialect,
  id: string,
) {
  for (let i = 0; i < 100; i++) {
    const status = service.getStatus(dialect, id);
    if (status.state !== 'running') return status;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Job did not finish');
}
describe('native SQL imports', () => {
  test.each(['postgres', 'mssql'] as const)(
    '%s preserves exact decimals and commits only after verification',
    async (dialect) => {
      const { service, db, statements } = setup();
      const initial = await service.startImport(
        session,
        [],
        options,
        dialect,
        input,
      );
      const result = await finished(service, dialect, initial.jobId);
      expect(result.state).toBe('done');
      expect(db.begin).toHaveBeenCalledTimes(1);
      expect(db.commit).toHaveBeenCalledTimes(1);
      expect(db.rollback).not.toHaveBeenCalled();
      expect(db.close).toHaveBeenCalledTimes(1);
      const insert = statements.find((s) => s.sql.startsWith('INSERT'))!;
      expect(insert.values).toEqual(['12345678901234567890.12']);
      expect(insert.sql).not.toContain('12345678901234567890');
      expect(insert.sql).toContain(dialect === 'postgres' ? '$1' : '@p0');
      expect(result.result?.tables[0].importedRows).toBe(1);
      expect(() =>
        service.getStatus(
          dialect === 'postgres' ? 'mssql' : 'postgres',
          initial.jobId,
        ),
      ).toThrow('Import not found');
    },
  );
  test.each(['postgres', 'mssql'] as const)(
    '%s rolls back on SQL errors and conceals parameters and credentials',
    async (dialect) => {
      const { service, db } = setup();
      const original = db.query;
      db.query = jest.fn(async (sql, params) => {
        if (sql.startsWith('INSERT'))
          throw Object.assign(
            new Error(input.password + ' private source value'),
            { code: 'SQL_FAIL' },
          );
        return original(sql, params);
      });
      const result = await finished(
        service,
        dialect,
        (await service.startImport(session, [], options, dialect, input)).jobId,
      );
      expect(result.state).toBe('failed');
      expect(db.rollback).toHaveBeenCalledTimes(1);
      expect(db.commit).not.toHaveBeenCalled();
      expect(result.error).toContain('rolled back');
      expect(result.error).not.toContain(input.password);
      expect(result.error).not.toContain('private source value');
    },
  );
  test.each(['postgres', 'mssql'] as const)(
    '%s cancellation rolls back rather than committing partial data',
    async (dialect) => {
      const { service, db } = setup();
      const initial = await service.startImport(
        session,
        [],
        options,
        dialect,
        input,
      );
      service.cancel(dialect, initial.jobId);
      const result = await finished(service, dialect, initial.jobId);
      expect(result.state).toBe('cancelled');
      expect(db.rollback).toHaveBeenCalledTimes(1);
      expect(db.commit).not.toHaveBeenCalled();
    },
  );
  test.each(['postgres', 'mssql'] as const)(
    '%s never claims rollback after an uncertain commit',
    async (dialect) => {
      const { service, db } = setup();
      db.commit = jest.fn(() =>
        Promise.reject(new Error('commit acknowledgement lost')),
      );
      const initial = await service.startImport(
        session,
        [],
        options,
        dialect,
        input,
      );
      const result = await finished(service, dialect, initial.jobId);
      expect(result.state).toBe('failed');
      expect(result.error).toContain('Commit outcome could not be confirmed');
      expect(result.error).not.toContain('All import changes were rolled back');
      expect(db.rollback).toHaveBeenCalled();
      expect(db.close).toHaveBeenCalled();
    },
  );
  test.each(['postgres', 'mssql'] as const)(
    '%s handles a null driver rejection without leaving the job running',
    async (dialect) => {
      const { service, db } = setup();
      const original = db.query;
      db.query = jest.fn((sql, params) =>
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- Reproduce a malformed driver rejection.
        sql.startsWith('INSERT') ? Promise.reject(null) : original(sql, params),
      );
      const initial = await service.startImport(
        session,
        [],
        options,
        dialect,
        input,
      );
      const result = await finished(service, dialect, initial.jobId);
      expect(result.state).toBe('failed');
      expect(result.error).toContain('All import changes were rolled back');
      expect(db.rollback).toHaveBeenCalledTimes(1);
      expect(db.close).toHaveBeenCalledTimes(1);
    },
  );
  test('append preserves existing tables and does not modify their constraints', async () => {
    const { service, db, statements } = setup();
    const original = db.query;
    db.query = jest.fn(async (sql, params) =>
      sql.includes('information_schema.tables')
        ? [{ present: 1 }]
        : original(sql, params),
    );
    expect(
      (
        await finished(
          service,
          'postgres',
          (
            await service.startImport(
              session,
              [],
              { ...options, writeMode: 'append' },
              'postgres',
              input,
            )
          ).jobId,
        )
      ).state,
    ).toBe('done');
    expect(
      statements.some((s) => /DROP TABLE|CREATE TABLE|ALTER TABLE/.test(s.sql)),
    ).toBe(false);
  });
  test('row count mismatch rolls back before commit', async () => {
    const { service, db } = setup();
    const original = db.query;
    db.query = jest.fn(async (sql, params) =>
      sql.startsWith('SELECT COUNT') ? [{ n: 0 }] : original(sql, params),
    );
    expect(
      (
        await finished(
          service,
          'postgres',
          (await service.startImport(session, [], options, 'postgres', input))
            .jobId,
        )
      ).state,
    ).toBe('failed');
    expect(db.commit).not.toHaveBeenCalled();
    expect(db.rollback).toHaveBeenCalled();
  });
  test('preflight rejects precision loss and zero bytes before opening a database', async () => {
    const { service, connect } = setup(table(['9'.repeat(39)]));
    await expect(
      service.startImport(session, [], options, 'mssql', input),
    ).rejects.toThrow('precision');
    expect(connect).not.toHaveBeenCalled();
    const text = { ...column, kind: 'text' as const };
    expect(() => parameterValue('a\0b', text, 'postgres')).toThrow('zero byte');
    expect(parameterValue('1', { ...column, kind: 'bool' }, 'postgres')).toBe(
      true,
    );
    expect(
      parameterValue('ff00', { ...column, kind: 'binary' }, 'mssql'),
    ).toEqual(Buffer.from('ff00', 'hex'));
  });
  test('wide MSSQL inserts respect the 2100 parameter limit', async () => {
    const t = table(Array.from({ length: 100 }, () => '1.00'));
    const columns = Array.from({ length: 40 }, (_, i) => ({
      ...column,
      name: 'c' + i,
    }));
    const wide = {
      ...t,
      columns,
      records: function* () {
        for (let i = 0; i < 100; i++)
          yield { recno: i + 1, values: Array(40).fill('1.00') as string[] };
      },
    };
    const { service, statements } = setup(wide);
    const result = await finished(
      service,
      'mssql',
      (await service.startImport(session, [], options, 'mssql', input)).jobId,
    );
    expect(result.state).toBe('done');
    const inserts = statements.filter((s) => s.sql.startsWith('INSERT'));
    expect(inserts).toHaveLength(2);
    expect(inserts.every((s) => s.values.length <= 2000)).toBe(true);
    expect(result.progress.rowsDone).toBe(100);
  });
  test('native keys are aligned through numeric relationship chains', () => {
    const a = table();
    const b = {
      ...table(),
      name: 'children',
      columns: [
        {
          ...column,
          kind: 'int32' as const,
          field: { ...column.field, decimalCount: 0 },
        },
      ],
    };
    const { service, source } = setup(a);
    (source.tables as DocumentTable[]).push(b);
    (source.links as unknown[]).push({
      child: { table: b, column: 'amount' },
      parent: { table: a, column: 'amount' },
    });
    const plan = service.prepare(session, [], options, 'mssql').plan;
    expect(plan.tables[0].columns[0].type).toBe('decimal(38,2)');
    expect(plan.tables[1].columns[0].type).toBe('decimal(38,2)');
  });
  test('quotes identifiers and chooses native types', () => {
    expect(quoteIdentifier('a"; DROP TABLE x;--')).toBe(
      '"a""; DROP TABLE x;--"',
    );
    expect(nativeType(column, 'postgres')).toBe('numeric');
    expect(nativeType(column, 'mssql')).toBe('decimal(38,2)');
    expect(nativeType({ ...column, kind: 'memoBinary' }, 'postgres')).toBe(
      'bytea',
    );
  });
});

test.each(['postgres', 'mssql'] as const)(
  '%s shutdown waits for rollback and refuses new imports',
  async (dialect) => {
    const { service, db } = setup();
    const original = db.query;
    let writing = false;
    let release!: (value: Record<string, unknown>[]) => void;
    db.query = jest.fn((sql, params) =>
      sql.startsWith('INSERT')
        ? new Promise<Record<string, unknown>[]>((resolve) => {
            writing = true;
            release = resolve;
          })
        : original(sql, params),
    );
    const job = await service.startImport(session, [], options, dialect, input);
    for (let n = 0; !writing && n < 100; n++)
      await new Promise((resolve) => setImmediate(resolve));
    expect(writing).toBe(true);
    let closed = false;
    const closing = service.onModuleDestroy().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed).toBe(false);
    release([]);
    await closing;
    expect(service.getStatus(dialect, job.jobId).state).toBe('cancelled');
    expect(db.rollback).toHaveBeenCalledTimes(1);
    expect(db.commit).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledTimes(1);
    await expect(
      service.startImport(session, [], options, dialect, input),
    ).rejects.toThrow('stopping');
  },
);
test.each(['postgres', 'mssql'] as const)(
  '%s shutdown during connection setup closes the late connection without writing',
  async (dialect) => {
    const { service, db, connect } = setup();
    let release!: (value: SqlAdapter) => void;
    connect.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const start = service.startImport(session, [], options, dialect, input);
    await service.onModuleDestroy();
    release(db);
    await expect(start).rejects.toThrow('stopping');
    expect(db.begin).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
    expect(db.close).toHaveBeenCalledTimes(1);
  },
);
