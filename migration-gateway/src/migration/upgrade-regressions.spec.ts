/* Async protocol fakes implement the database driver contracts. */
/* eslint-disable @typescript-eslint/require-await */
import { BSON, MongoClient } from 'mongodb';
import { MigrationConnectors } from './connectors';
import { MigrationService } from './migration.service';
import { sqlType, type Row, type Source, type Target } from './model';
import {
  SqlSource,
  SqlTarget,
  columnFromMetadata,
  type SqlConnection,
} from './sql';
import { serverVersion } from './versions';
import type {
  MigrationColumn,
  MigrationObject,
  PlannedObject,
} from './migration.types';

jest.mock('mongodb', () => ({
  ...jest.requireActual<typeof import('mongodb')>('mongodb'),
  MongoClient: jest.fn(),
}));
const column: MigrationColumn = {
  name: 'amount',
  kind: 'decimal',
  nullable: false,
};
function connection(): jest.Mocked<SqlConnection> {
  return {
    query: jest.fn(async () => []),
    rows: jest.fn(async function* () {}),
    close: jest.fn(async () => {}),
  } as unknown as jest.Mocked<SqlConnection>;
}
const numericCases = [
  [2, -3, 'decimal(5,0)'],
  [3, 5, 'decimal(5,5)'],
  [1000, -1000, 'numeric'],
] as const;
test.each(numericCases)(
  'PostgreSQL numeric(%s,%s) can move to a newer server without losing capacity',
  (precision, scale, expected) => {
    expect(sqlType({ ...column, precision, scale }, 'postgres')).toBe(expected);
  },
);
test.each(['mysql', 'mssql'] as const)(
  '%s receives lossless portable types for unusual PostgreSQL numeric scales',
  (engine) => {
    expect(sqlType({ ...column, precision: 2, scale: -3 }, engine)).toBe(
      'decimal(5,0)',
    );
    expect(sqlType({ ...column, precision: 3, scale: 5 }, engine)).toBe(
      'decimal(5,5)',
    );
    expect(() =>
      sqlType({ ...column, precision: 1000, scale: -1000 }, engine),
    ).toThrow('precision');
  },
);
test.each(['USD', 'EUR', 'large negative'] as const)(
  'PostgreSQL money uses exact server conversion for %s',
  async (label) => {
    const localized =
      label === 'USD'
        ? '$1,234.56'
        : label === 'EUR'
          ? '1.234,56 EUR'
          : '-$92,233,720,368,547,758.08';
    const exact =
      label === 'large negative' ? '-92233720368547758.08' : '1234.56';
    const db = connection();
    db.rows.mockImplementation(async function* (query) {
      yield {
        amount: /CAST\(CAST\("amount" AS numeric\) AS text\)/.test(query)
          ? exact
          : localized,
      };
    });
    const source = new SqlSource(db, { engine: 'postgres', database: 'old' });
    const money = columnFromMetadata({
      engine: 'postgres',
      type: 'money',
      column: 'amount',
      nullable: 'NO',
    });
    const object: MigrationObject = {
      id: 'money',
      schema: 'public',
      name: 'balance',
      format: 'rows',
      columns: [money],
    };
    const rows: unknown[] = [];
    for await (const row of source.read(object, new AbortController().signal))
      rows.push(row.amount);
    expect(rows).toEqual([exact]);
  },
);
test('PostgreSQL 15 to 16 plans and executes unusual numeric columns through the real SQL adapters', async () => {
  const old = connection(),
    next = connection();
  old.query.mockImplementation(async (query) =>
    query.includes('server_version')
      ? [{ version: '15.5' }]
      : [
          {
            schema: 'public',
            table: 'totals',
            column: 'rounded',
            type: 'numeric',
            precision: 2,
            scale: -3,
            nullable: 'NO',
          },
          {
            schema: 'public',
            table: 'totals',
            column: 'fraction',
            type: 'numeric',
            precision: 3,
            scale: 5,
            nullable: 'YES',
          },
        ],
  );
  old.rows.mockImplementation(async function* () {
    yield { rounded: '99000', fraction: '0.00999' };
  });
  next.query.mockImplementation(async (query) =>
    query.includes('server_version') ? [{ version: '16.4' }] : [],
  );
  const source = new SqlSource(old, { engine: 'postgres', database: 'old' });
  const target = new SqlTarget(next, { engine: 'postgres', database: 'new' });
  const connectors = {
    source: async (): Promise<Source> => source,
    target: async (): Promise<Target> => target,
    differentRedisDatabases: async () => {},
  } as unknown as MigrationConnectors;
  const service = new MigrationService(connectors);
  try {
    const plan = await service.prepare({
      mode: 'upgrade',
      source: {
        engine: 'postgres',
        host: 'old',
        database: 'old',
        user: 'operator',
      },
      target: {
        engine: 'postgres',
        host: 'new',
        database: 'new',
        user: 'operator',
      },
      objects: [
        {
          sourceId: JSON.stringify(['public', 'totals']),
          targetName: 'totals',
        },
      ],
    });
    expect(plan.objects[0].columns.map((c) => c.targetType)).toEqual([
      'decimal(5,0)',
      'decimal(5,5)',
    ]);
    expect(
      next.query.mock.calls.some(([sql]) => sql.startsWith('CREATE')),
    ).toBe(false);
    const started = service.start(plan.id);
    for (
      let i = 0;
      i < 100 && service.status(started.id).state === 'running';
      i++
    )
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.status(started.id)).toMatchObject({
      state: 'done',
      read: 1,
      written: 1,
      skipped: 0,
    });
    const insert = next.query.mock.calls.find(([sql]) =>
      sql.startsWith('INSERT'),
    );
    expect(insert?.[1]).toEqual(['99000', '0.00999']);
  } finally {
    await service.onModuleDestroy();
  }
});

test.each([
  '5.7.1-m1',
  '8.0.0-dmr',
  '9.0.0-milestone1',
  '8.0.0-dev',
  '8.0.0-ctp2',
])(
  'a development version %s cannot be presented as a stable upgrade endpoint',
  (version) => {
    expect(() => serverVersion('mysql', version)).toThrow('stable');
  },
);

test.each([
  ['s', 'first.*last'],
  ['x', 'first  # comment\n last'],
  ['u', 'first'],
  ['l', 'first'],
  ['imsx', 'first'],
  ['', '(a)?(?(1)yes|no)'],
])(
  'MongoDB upgrade retains BSON regex options %s and pattern %s',
  async (options, pattern) => {
    const original = {
      _id: 'regex',
      nested: { expression: new BSON.BSONRegExp(pattern, options) },
      double: new BSON.Double(1),
      zero: new BSON.Double(-0),
    };
    const wire = BSON.serialize(original);
    const cursor = {
      close: jest.fn(async () => {}),
      async *[Symbol.asyncIterator]() {
        yield original;
      },
    };
    const collection = {
      find: jest.fn(
        (_filter: unknown, readOptions: BSON.DeserializeOptions) => {
          const decoded = BSON.deserialize(wire, readOptions);
          return {
            ...cursor,
            async *[Symbol.asyncIterator]() {
              yield decoded;
            },
          };
        },
      ),
      insertOne: jest.fn<Promise<unknown>, [Row]>(async () => ({})),
      rename: jest.fn(async () => ({})),
    };
    const db = {
      databaseName: 'test',
      collection: jest.fn(() => collection),
      createCollection: jest.fn(async () => {}),
      listCollections: jest.fn(() => ({
        toArray: async () => [{ name: 'patterns', type: 'collection' }],
      })),
      admin: jest.fn(() => ({ command: async () => ({ version: '4.2.24' }) })),
    };
    const client = {
      connect: jest.fn(async () => {}),
      close: jest.fn(async () => {}),
      db: jest.fn(() => db),
    };
    (MongoClient as unknown as jest.Mock).mockImplementation(() => client);
    const connectors = new MigrationConnectors();
    const input = {
      engine: 'mongo' as const,
      uri: 'mongodb://localhost',
      database: 'test',
    };
    const source = await connectors.source(input);
    const target = await connectors.target(input, 'unused', 'upgrade');
    try {
      const [object] = await source.objects();
      const planned: PlannedObject = {
        source: object,
        targetName: 'patterns_new',
        targetSchema: '',
        columns: object.columns.map((c) => ({ ...c, targetType: 'BSON' })),
      };
      await target.begin([planned]);
      for await (const row of source.read(object, new AbortController().signal))
        await target.write(planned, row, 1);
      const inserted = collection.insertOne.mock.calls[0][0];
      expect(Buffer.from(BSON.serialize(inserted))).toEqual(Buffer.from(wire));
    } finally {
      await source.close();
      await target.close();
    }
  },
);
