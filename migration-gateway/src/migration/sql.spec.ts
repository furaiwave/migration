/* Async protocol fakes implement driver contracts; method references are used only in Jest assertions. */
/* eslint-disable @typescript-eslint/require-await */
import { BSON } from 'mongodb';
import { bsonRow, identifier, sqlType } from './model';
import {
  columnFromMetadata,
  SqlSource,
  SqlTarget,
  type SqlConnection,
} from './sql';
import type { Engine, MigrationColumn, PlannedObject } from './migration.types';

const column: MigrationColumn = {
  name: 'value',
  kind: 'text',
  nullable: false,
};
const object: PlannedObject = {
  source: {
    id: 'x',
    name: 'x',
    schema: 'public',
    format: 'rows',
    columns: [column],
  },
  targetName: 'destination',
  targetSchema: 'public',
  columns: [{ ...column, targetType: 'text' }],
};
function db(): jest.Mocked<SqlConnection> {
  return {
    query: jest.fn(async () => []),
    rows: jest.fn(async function* () {}),
    close: jest.fn(async () => {}),
  } as unknown as jest.Mocked<SqlConnection>;
}
describe('SQL data fidelity and destination protection', () => {
  test.each(['mysql', 'postgres', 'mssql'] as Engine[])(
    '%s quotes hostile identifiers',
    (engine) => {
      const name = 'x`"]; DROP DATABASE test; --';
      const quoted = identifier(name, engine);
      expect(quoted).toContain('DROP DATABASE');
      expect(
        quoted.startsWith(
          engine === 'mysql' ? '`' : engine === 'mssql' ? '[' : '"',
        ),
      ).toBe(true);
      expect(() => identifier('bad\0name', engine)).toThrow();
    },
  );
  test('preserves bigint and exact decimals when creating BSON records', () => {
    const source = {
      ...object.source,
      columns: [
        { ...column, name: 'id', kind: 'integer' as const },
        { ...column, name: 'amount', kind: 'decimal' as const },
        { ...column, name: 'bytes', kind: 'binary' as const },
        { ...column, name: 'missing' },
      ],
    };
    const result = bsonRow(source, {
      id: '9007199254740993',
      amount: '12345678901234567890.1234',
      bytes: Buffer.from([0, 255]),
      missing: null,
    });
    expect(String(result.id)).toBe('9007199254740993');
    expect(result.id).toBeInstanceOf(BSON.Long);
    expect(String(result.amount)).toBe('12345678901234567890.1234');
    expect(result.bytes).toBeInstanceOf(BSON.Binary);
    expect(result.missing).toBeNull();
  });
  test('SQL JSON keeps large numeric literals instead of parsing through JS Number', () => {
    const source = {
      ...object.source,
      columns: [{ ...column, name: 'payload', kind: 'json' as const }],
    };
    const payload =
      '{"id":9007199254740993123456789,"fraction":0.1234567890123456789}';
    expect(bsonRow(source, { payload }).payload).toBe(payload);
  });
  test('unsigned 64-bit values become Decimal128 instead of overflowing Long', () => {
    const source = {
      ...object.source,
      columns: [{ ...column, name: 'id', kind: 'integer' as const }],
    };
    const row = bsonRow(source, { id: '18446744073709551615' });
    expect(row.id).toBeInstanceOf(BSON.Decimal128);
    expect(String(row.id)).toBe('18446744073709551615');
  });
  test('restores nested MongoDB BSON documents from canonical Extended JSON', () => {
    const document = {
      _id: new BSON.ObjectId(),
      nested: { count: BSON.Long.fromString('9007199254740993') },
      bytes: new BSON.Binary(Buffer.from([255]), 128),
    };
    const restored = bsonRow(
      { ...object.source, format: 'documents' },
      { document: BSON.EJSON.stringify(document, { relaxed: false }) },
    );
    expect(restored._id).toEqual(document._id);
    expect(restored.nested).toEqual(document.nested);
    expect((restored.bytes as BSON.Binary).sub_type).toBe(128);
  });
  test('rejects excess destination precision and never rounds unbounded decimals', () => {
    expect(() =>
      sqlType(
        { ...column, kind: 'decimal', precision: 65, scale: 10 },
        'mssql',
      ),
    ).toThrow();
    expect(sqlType({ ...column, kind: 'decimal' }, 'mysql')).toBe('longtext');
    expect(sqlType({ ...column, kind: 'decimal' }, 'postgres')).toBe('numeric');
  });
  test('distinguishes MySQL timestamp, SQL Server rowversion, PostgreSQL bits and MySQL binary bits', () => {
    const metadata = (type: string, engine: string) =>
      columnFromMetadata({ column: 'x', type, engine, nullable: 'YES' });
    expect(metadata('timestamp', 'mysql').kind).toBe('datetime');
    expect(metadata('timestamp', 'mssql').kind).toBe('binary');
    expect(metadata('bit', 'mysql').kind).toBe('binary');
    expect(metadata('bit', 'postgres').kind).toBe('text');
    expect(metadata('bit', 'mssql').kind).toBe('boolean');
  });
  test('destination check refuses existing objects and uses parameters', async () => {
    const connection = db();
    connection.query.mockResolvedValueOnce([{ TABLE_NAME: 'destination' }]);
    const target = new SqlTarget(connection, {
      engine: 'postgres',
      database: 'test',
    });
    await expect(target.check([object])).rejects.toThrow('already exists');
    expect(connection.query.mock.calls[0][1]).toEqual([
      'public',
      'destination',
    ]);
  });
  test('values are bound parameters, never executable SQL', async () => {
    const connection = db();
    const target = new SqlTarget(connection, {
      engine: 'postgres',
      database: 'test',
    });
    const attack = "'); DROP TABLE destination; --";
    await target.write(object, { value: attack });
    expect(connection.query.mock.calls[0][0]).not.toContain(attack);
    expect(connection.query.mock.calls[0][1]).toEqual([attack]);
  });
  test('MySQL uses strict mode and rolls back data after table creation', async () => {
    const connection = db();
    const target = new SqlTarget(connection, {
      engine: 'mysql',
      database: 'test',
    });
    await target.begin([{ ...object, targetSchema: '' }]);
    await target.rollback();
    const commands = connection.query.mock.calls.map((call) => call[0]);
    expect(commands[0]).toMatch(/STRICT_ALL_TABLES/);
    expect(commands[1]).toMatch(/^CREATE TABLE/);
    expect(commands[2]).toBe('BEGIN');
    expect(commands[3]).toBe('ROLLBACK');
  });
  test('PostgreSQL creates tables inside the data transaction', async () => {
    const connection = db();
    const target = new SqlTarget(connection, {
      engine: 'postgres',
      database: 'test',
    });
    await target.begin([object]);
    await target.commit();
    const commands = connection.query.mock.calls.map((call) => call[0]);
    expect(commands[0]).toBe('BEGIN');
    expect(commands[1]).toMatch(/^CREATE TABLE/);
    expect(commands[2]).toBe('COMMIT');
  });
  test('a failed COMMIT never produces a false rollback confirmation', async () => {
    const connection = db();
    const target = new SqlTarget(connection, {
      engine: 'postgres',
      database: 'test',
    });
    await target.begin([object]);
    connection.query.mockRejectedValueOnce(new Error('lost connection'));
    await expect(target.commit()).rejects.toThrow();
    await expect(target.rollback()).rejects.toThrow(/cannot be confirmed/);
  });
  test('PostgreSQL arrays and custom values use server text to preserve numeric precision', async () => {
    const connection = db();
    const source = new SqlSource(connection, {
      engine: 'postgres',
      database: 'test',
    });
    connection.rows.mockImplementation(async function* () {
      yield { value: '{900719925474099312345,1}' };
    });
    const rows: unknown[] = [];
    for await (const row of source.read(
      object.source,
      new AbortController().signal,
    ))
      rows.push(row);
    expect(connection.rows.mock.calls[0][0]).toContain(
      'CAST("value" AS text) AS "value"',
    );
    expect(rows).toEqual([{ value: '{900719925474099312345,1}' }]);
  });
  test('SQL Server reads exact numerics and datetimes as server-formatted text', async () => {
    const connection = db();
    const source = new SqlSource(connection, {
      engine: 'mssql',
      database: 'test',
    });
    const table = {
      ...object.source,
      columns: [
        { ...column, kind: 'decimal' as const },
        { ...column, name: 'at', kind: 'datetime' as const },
      ],
    };
    for await (const row of source.read(table, new AbortController().signal)) {
      expect(row).toBeDefined();
    }
    expect(connection.rows.mock.calls[0][0]).toMatch(
      /CONVERT\(nvarchar\(max\),\[value\]\)/,
    );
    expect(connection.rows.mock.calls[0][0]).toContain(
      'CONVERT(nvarchar(max),[at],127)',
    );
  });
});
