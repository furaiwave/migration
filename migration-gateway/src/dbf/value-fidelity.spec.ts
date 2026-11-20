import { Binary } from 'mongodb';
import { julianDateTime, dbase7Timestamp } from '../addon';
import { parseTable } from './dbf-parse';
import { MysqlExportService } from './mysql-export.service';
import { MongoExportService } from './mongo-export.service';
import { SqlImportService, parameterValue } from './sql-import.service';
import { redisRecord } from './redis-import.service';
import { normalizeMysqlType, typeProblem } from './mysql-types';
import { toFileName, toSessionId } from '../types/dbf-relationship.types';
import type { DbfSession } from '../types/dbf-session.types';
import type { MysqlExportOptions } from '../types/mysql-export.types';
const options: MysqlExportOptions = {
  database: 'legacy',
  writeMode: 'append',
  includeData: true,
  foreignKeys: false,
  indexes: false,
  keepDeleted: false,
  syncDeletes: false,
  emptyStringsAsNull: true,
  orphansAsNull: false,
  overrides: { 'VALUES.DBF': { primaryKey: null } },
};
function source(type: 'Q' | 'T' | 'D', value: Buffer, flags = 0): DbfSession {
  const variable = type === 'Q';
  const count = variable ? 2 : 1;
  const offset = 32 + count * 32 + 1;
  const recordLength = 1 + value.length + (variable ? 1 : 0);
  const bytes = Buffer.alloc(offset + recordLength + 1);
  bytes[0] = 0x30;
  bytes.writeUInt32LE(1, 4);
  bytes.writeUInt16LE(offset, 8);
  bytes.writeUInt16LE(recordLength, 10);
  bytes.write(
    type === 'Q' ? 'PAYLOAD' : type === 'T' ? 'AT' : 'DAY',
    32,
    'ascii',
  );
  bytes[43] = type.charCodeAt(0);
  bytes[48] = value.length;
  if (variable) {
    bytes[50] = 2;
    bytes.write('_NullFlags', 64, 'ascii');
    bytes[75] = 48;
    bytes[80] = 1;
    bytes[82] = 1;
    bytes[offset + 1 + value.length] = flags;
  }
  bytes[offset - 1] = 13;
  bytes[offset] = 32;
  value.copy(bytes, offset + 1);
  bytes[bytes.length - 1] = 26;
  const name = toFileName('VALUES.DBF');
  return {
    id: toSessionId('value-fidelity'),
    createdAt: new Date(),
    previewRows: 1,
    files: new Map([[name, parseTable(name, bytes, null, null, 1, 'utf-8')]]),
    sources: new Map([[name, { dbf: bytes, memo: null, index: null }]]),
    manualRels: [],
    disabledRels: new Set(),
    encodings: new Map(),
  };
}
function timestamp(date = '2024-02-29', ms = 45_296_123) {
  const bytes = Buffer.alloc(8);
  bytes.writeInt32LE(
    Math.floor(Date.parse(date + 'T00:00:00Z') / 86_400_000) + 2440588,
    0,
  );
  bytes.writeInt32LE(ms, 4);
  return bytes;
}
function mongoValue(session: DbfSession, field: string): unknown {
  const ops = [
    ...new MongoExportService(new MysqlExportService()).operations(
      session,
      [],
      options,
    ).ops,
  ];
  const write = ops.find((op) => op.op === 'insert');
  if (!write || write.op !== 'insert') throw new Error('No MongoDB document');
  return write.docs[0][field] as unknown;
}
const binaryCases = [
  ['zero bytes', 0, '00000000'],
  ['empty bytes', 1, ''],
  ['explicit NULL', 2, null],
] as const;
test.each(binaryCases)(
  'MySQL preserves %s distinctly',
  (_label, flags, value) => {
    const session = source('Q', Buffer.alloc(4), flags);
    const exporter = new MysqlExportService();
    const data = exporter.documentSource(session, [], options, 'sql');
    expect([...data.tables[0].records('live')][0].values).toEqual([value]);
    const sql = [...exporter.statements(session, [], options).chunks]
      .filter((chunk) => chunk.rows)
      .map((chunk) => chunk.sql)
      .join('');
    expect(sql).toContain(value === null ? '(NULL)' : "(X'" + value + "')");
  },
);
test.each(binaryCases)(
  'MongoDB preserves %s distinctly',
  (_label, flags, value) => {
    const actual = mongoValue(source('Q', Buffer.alloc(4), flags), 'payload');
    if (value === null) {
      expect(actual).toBeNull();
      return;
    }
    expect(actual).toBeInstanceOf(Binary);
    if (!(actual instanceof Binary)) throw new Error('Not BSON binary');
    expect(Buffer.from(actual.value())).toEqual(Buffer.from(value, 'hex'));
  },
);
test.each(binaryCases)(
  'Redis preserves %s distinctly',
  (_label, flags, value) => {
    const data = new MysqlExportService().documentSource(
      source('Q', Buffer.alloc(4), flags),
      [],
      options,
      'sql',
    );
    const table = data.tables[0];
    const record = [...table.records('live')][0];
    expect(
      redisRecord(table, table.name, 'data', record.values, record.recno)
        .fields,
    ).toEqual(['payload', JSON.stringify(value)]);
  },
);
test.each(['postgres', 'mssql'] as const)(
  '%s preserves zero, empty and NULL binary values',
  (dialect) => {
    for (const [, flags, value] of binaryCases) {
      const service = new SqlImportService(new MysqlExportService());
      const data = service.prepare(
        source('Q', Buffer.alloc(4), flags),
        [],
        options,
        dialect,
      ).source;
      const table = data.tables[0],
        record = [...table.records('live')][0];
      expect(
        parameterValue(record.values[0], table.columns[0], dialect),
      ).toEqual(value === null ? null : Buffer.from(value, 'hex'));
    }
  },
);
test('FoxPro preview and export keep millisecond precision', () => {
  const session = source('T', timestamp());
  expect([...session.files.values()][0].preview[0].AT).toBe(
    '2024-02-29 12:34:56.123',
  );
  const exporter = new MysqlExportService();
  const result = exporter.statements(session, [], options);
  expect(result.plan.tables[0].columns[0].mysqlType).toBe('DATETIME(3)');
  expect(
    [...result.chunks]
      .filter((chunk) => chunk.rows)
      .map((chunk) => chunk.sql)
      .join(''),
  ).toContain('2024-02-29 12:34:56.123');
});
test('MongoDB receives the same milliseconds as the original FoxPro timestamp', () => {
  const value = mongoValue(source('T', timestamp()), 'at');
  expect(value).toBeInstanceOf(Date);
  expect((value as Date).toISOString()).toBe('2024-02-29T12:34:56.123Z');
});
test.each(['postgres', 'mssql'] as const)(
  '%s keeps millisecond precision in timestamp parameters',
  (dialect) => {
    const data = new SqlImportService(new MysqlExportService()).prepare(
      source('T', timestamp()),
      [],
      options,
      dialect,
    ).source;
    const table = data.tables[0];
    const value = [...table.records('live')][0].values[0];
    expect(parameterValue(value, table.columns[0], dialect)).toBe(
      '2024-02-29 12:34:56.123',
    );
  },
);
test('dBASE 7 timestamp decoding also keeps millisecond precision', () => {
  const value =
    (Math.floor(Date.parse('2024-02-29T00:00:00Z') / 86_400_000) + 2440588) *
      86_400_000 +
    45_296_123;
  const bytes = Buffer.alloc(8);
  bytes.writeDoubleBE(value);
  bytes[0] ^= 0x80;
  expect(dbase7Timestamp(bytes)).toBe('2024-02-29 12:34:56.123');
});
test('whole-second timestamps retain their original display format', () => {
  expect(julianDateTime(2440588, 1000)).toBe('1970-01-01 00:00:01');
});
test.each([-1, 86_400_000, Infinity, NaN])(
  'invalid milliseconds %s cannot silently roll over into another date',
  (ms) => {
    expect(julianDateTime(2440588, ms)).toBeNull();
  },
);
test.each(['00010102', '00990228', '09991231'])(
  'valid early date %s is retained by non-MySQL exports',
  (date) => {
    const session = source('D', Buffer.from(date));
    const expected =
      date.slice(0, 4) + '-' + date.slice(4, 6) + '-' + date.slice(6);
    const exporter = new MysqlExportService();
    expect(
      [
        ...exporter
          .documentSource(session, [], options, 'sql')
          .tables[0].records('live'),
      ][0].values,
    ).toEqual([expected]);
    expect((mongoValue(session, 'day') as Date).toISOString()).toBe(
      expected + 'T00:00:00.000Z',
    );
    expect(
      exporter
        .plan(session, [], options)
        .quality.some(
          (issue) => issue.effect === 'fail' && issue.problem.includes('range'),
        ),
    ).toBe(true);
  },
);
test('early binary timestamps use four-digit years and retain their milliseconds', () => {
  const session = source('T', timestamp('0001-01-02', 123));
  const value = [
    ...new MysqlExportService()
      .documentSource(session, [], options, 'sql')
      .tables[0].records('live'),
  ][0].values[0];
  expect(value).toBe('0001-01-02 00:00:00.123');
});
test.each([
  'DATETIME(0)',
  'DATETIME(3)',
  'DATETIME(6)',
  'TIMESTAMP(3)',
  'TIME(6)',
])('accepts valid fractional-second column type %s', (type) => {
  expect(normalizeMysqlType(type)).toEqual({ type });
});
test.each(['DATETIME(7)', 'TIMESTAMP(-1)', 'TIME(9)'])(
  'rejects invalid fractional-second column type %s',
  (type) => {
    expect(normalizeMysqlType(type)).toHaveProperty('error');
  },
);
test('fractional timestamp text is recognized when overriding a character field', () => {
  expect(
    typeProblem('2024-02-29 12:34:56.123', 'text', 'DATETIME(3)'),
  ).toBeNull();
});

test.each(['DATETIME', 'DATETIME(0)', 'DATETIME(2)', 'TIMESTAMP(2)'])(
  'prevents nonzero milliseconds being lost to %s',
  (type) => {
    expect(typeProblem('2024-02-29 12:34:56.123', 'datetime', type)).toContain(
      'precision',
    );
  },
);
test.each(['DATETIME(1)', 'DATETIME(3)', 'DATETIME(6)', 'TIMESTAMP(3)'])(
  'accepts fractional seconds without a loss for %s',
  (type) => {
    expect(typeProblem('2024-02-29 12:34:56.100', 'datetime', type)).toBeNull();
  },
);
test('an explicitly narrowed timestamp override produces a blocking quality issue', () => {
  const plan = new MysqlExportService().plan(source('T', timestamp()), [], {
    ...options,
    overrides: {
      'VALUES.DBF': { primaryKey: null, columns: { AT: { type: 'DATETIME' } } },
    },
  });
  expect(
    plan.quality.some(
      (issue) => issue.effect === 'fail' && issue.problem.includes('precision'),
    ),
  ).toBe(true);
});
