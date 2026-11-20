import { MigrationConnectors } from '../src/migration/connectors';
import { SqlSource, SqlTarget, type SqlConnection } from '../src/migration/sql';
import type { Row } from '../src/migration/model';
import type {
  MigrationPlan,
  MigrationStatus,
} from '../src/migration/migration.types';
import type { Server } from 'http';
import type { INestApplication } from '@nestjs/common';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, resolve } from 'path';
import request from 'supertest';
import { startServer } from '../src/server';
import { e2eSessionRoot } from './setup-e2e';
import type { ParseMultipleResult } from '../src/dbf/dbf.service';
import type { DbfRelationshipGraph } from '../src/types/dbf-relationship.types';

const credentials = { user: 'operator', password: 'e2e-only-password-123456' };
function dbf(field: string, warningField?: string) {
  const offset = warningField ? 97 : 65;
  const recordLength = warningField ? 13 : 7;
  const buffer = Buffer.alloc(offset + recordLength + 1);
  buffer[0] = 3;
  buffer[1] = 126;
  buffer[2] = 11;
  buffer[3] = 20;
  buffer.writeUInt32LE(1, 4);
  buffer.writeUInt16LE(offset, 8);
  buffer.writeUInt16LE(recordLength, 10);
  buffer.write(field, 32, 'ascii');
  buffer[43] = 67;
  buffer[48] = 6;
  if (warningField) {
    buffer.write(warningField, 64, 'ascii');
    buffer[75] = 90;
    buffer[80] = 6;
  }
  buffer[offset - 1] = 13;
  buffer.write(' 001   ' + (warningField ? 'unused' : ''), offset, 'ascii');
  buffer[offset + recordLength] = 26;
  return buffer;
}
describe('application HTTP integration', () => {
  let app: INestApplication<Server>;
  beforeAll(async () => {
    app = await startServer({
      host: '127.0.0.1',
      port: 0,
      origins: ['https://client.example.test'],
      access: credentials,
      logger: [],
    });
  });
  afterAll(async () => {
    await app?.close();
    const root = resolve(e2eSessionRoot);
    if (
      dirname(root) !== resolve(tmpdir()) ||
      !basename(root).startsWith('data-migrator-e2e-')
    )
      throw new Error('Unexpected e2e session path');
    rmSync(root, { recursive: true, force: true });
  });
  const api = () => request(app.getHttpServer());
  test('health is public while database REST and GraphQL require authentication', async () => {
    await api().get('/healthz').expect(200, { status: 'ok' });
    await api()
      .post('/dbf/graphql')
      .send({ query: '{__typename}' })
      .expect(401);
    await api().get('/dbf/native/servers').expect(401);
    await api()
      .get('/')
      .auth(credentials.user, credentials.password)
      .expect(404);
  });
  test('the running server validates origins, DTOs and the GraphQL schema', async () => {
    await api()
      .post('/dbf/graphql')
      .auth(credentials.user, credentials.password)
      .set('Origin', 'https://other.example.test')
      .send({ query: '{__typename}' })
      .expect(403);
    const graphql = await api()
      .post('/dbf/graphql')
      .auth(credentials.user, credentials.password)
      .send({ query: '{__schema{queryType{name} mutationType{name}}}' })
      .expect(200);
    expect(graphql.body).toEqual({
      data: {
        __schema: {
          queryType: { name: 'Query' },
          mutationType: { name: 'Mutation' },
        },
      },
    });
    expect(graphql.headers['cache-control']).toBe('no-store');
    await api()
      .post('/dbf/migration/catalog')
      .auth(credentials.user, credentials.password)
      .send({ engine: 'oracle', database: 'test' })
      .expect(400);
  });
  test('real file upload, relationships, planning and session deletion work through the API', async () => {
    const response = await api()
      .post('/dbf/parse-multiple')
      .auth(credentials.user, credentials.password)
      .attach('files', dbf('CLIENT_ID'), 'orders.dbf')
      .attach('files', dbf('ID'), 'clients.dbf')
      .expect(200);
    const session = response.body as ParseMultipleResult;
    expect(session.files).toHaveLength(2);
    expect(session.graph.relationships).toHaveLength(1);
    const relation = session.graph.relationships[0];
    const toggled = await api()
      .patch(
        '/dbf/session/' +
          session.sessionId +
          '/relationship/' +
          encodeURIComponent(relation.id),
      )
      .auth(credentials.user, credentials.password)
      .send({ disabled: true })
      .expect(200);
    expect(
      (toggled.body as DbfRelationshipGraph).relationships[0].disabled,
    ).toBe(true);
    await api()
      .patch('/dbf/session/' + session.sessionId + '/relationship/missing')
      .auth(credentials.user, credentials.password)
      .send({ disabled: true })
      .expect(400);
    await api()
      .post('/dbf/session/relationship')
      .auth(credentials.user, credentials.password)
      .send({
        sessionId: session.sessionId,
        sourceFile: 'ORDERS.DBF',
        sourceField: 'MISSING',
        targetFile: 'CLIENTS.DBF',
        targetField: 'ID',
      })
      .expect(400);
    await api()
      .post('/dbf/session/' + session.sessionId + '/mysql/plan')
      .auth(credentials.user, credentials.password)
      .send({ database: 'destination' })
      .expect(200);
    await api()
      .get('/dbf/session/' + session.sessionId)
      .auth(credentials.user, credentials.password)
      .expect(200);
    await api()
      .delete('/dbf/session/' + session.sessionId)
      .auth(credentials.user, credentials.password)
      .expect(204);
    await api()
      .get('/dbf/session/' + session.sessionId)
      .auth(credentials.user, credentials.password)
      .expect(404);
  });
  test.each(['mysql', 'mongo'] as const)(
    '%s HTTP export keeps uploaded field metadata inside comments',
    async (engine) => {
      const marker = engine === 'mysql' ? 'DO 1;#' : 'x=1;//';
      const uploaded = await api()
        .post('/dbf/parse-multiple')
        .auth(credentials.user, credentials.password)
        .attach('files', dbf('ID', 'X\r' + marker), 'metadata.dbf')
        .expect(200);
      const session = uploaded.body as ParseMultipleResult;
      const response = await fetch(
        (await app.getUrl()) +
          '/dbf/session/' +
          session.sessionId +
          '/' +
          engine +
          '/export',
        {
          method: 'POST',
          headers: {
            Authorization:
              'Basic ' +
              Buffer.from(
                credentials.user + ':' + credentials.password,
              ).toString('base64'),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            database: 'destination',
            includeData: false,
            writeMode: 'append',
          }),
        },
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('content-disposition')).toContain(
        'attachment',
      );
      const output = await response.text();
      const metadataLines = output
        .split(/[\r\n\u2028\u2029]/)
        .filter((line) => line.includes(marker));
      expect(metadataLines.length).toBeGreaterThan(0);
      expect(
        metadataLines.every((line) =>
          line.trimStart().startsWith(engine === 'mysql' ? '--' : '//'),
        ),
      ).toBe(true);
      await api()
        .delete('/dbf/session/' + session.sessionId)
        .auth(credentials.user, credentials.password)
        .expect(204);
    },
  );
  describe('MySQL older-to-newer migration over HTTP', () => {
    let old: jest.Mocked<SqlConnection>;
    let next: jest.Mocked<SqlConnection>;
    let destinationVersion: string;
    const values: Row[] = [
      {
        id: '18446744073709551615',
        amount:
          '12345678901234567890123456789012345.123456789012345678901234567890',
        at: '0000-00-00 00:00:00',
        payload: Buffer.from([0, 0, 255]),
        title: 'private-source-value',
      },
      {
        id: '9007199254740993',
        amount: '0.000000000000000000000000000001',
        at: '2026-11-20 12:34:56.123456',
        payload: Buffer.alloc(0),
        title: "quoted ' and zero \u0000",
      },
    ];
    beforeEach(() => {
      destinationVersion = '8.0.40';
      old = {
        query: jest.fn(
          (sql: string): Promise<Row[]> =>
            Promise.resolve(
              sql.includes('VERSION()')
                ? [{ version: '5.6.51' }]
                : [
                    {
                      schema: 'old',
                      table: 'ledger',
                      column: 'id',
                      type: 'bigint',
                      precision: 20,
                      scale: 0,
                      nullable: 'NO',
                    },
                    {
                      schema: 'old',
                      table: 'ledger',
                      column: 'amount',
                      type: 'decimal',
                      precision: 65,
                      scale: 30,
                      nullable: 'NO',
                    },
                    {
                      schema: 'old',
                      table: 'ledger',
                      column: 'at',
                      type: 'timestamp',
                      nullable: 'NO',
                    },
                    {
                      schema: 'old',
                      table: 'ledger',
                      column: 'payload',
                      type: 'blob',
                      nullable: 'YES',
                    },
                    {
                      schema: 'old',
                      table: 'ledger',
                      column: 'title',
                      type: 'varchar',
                      nullable: 'NO',
                    },
                  ],
            ),
        ),
        // The generator models asynchronous driver rows without a live database.
        // eslint-disable-next-line @typescript-eslint/require-await
        rows: jest.fn(async function* () {
          yield* values;
        }),
        close: jest.fn(() => Promise.resolve()),
      } as unknown as jest.Mocked<SqlConnection>;
      next = {
        query: jest.fn(
          (sql: string): Promise<Row[]> =>
            Promise.resolve(
              sql.includes('VERSION()')
                ? [{ version: destinationVersion }]
                : [],
            ),
        ),

        rows: jest.fn(async function* () {}),
        close: jest.fn(() => Promise.resolve()),
      } as unknown as jest.Mocked<SqlConnection>;
      const adapters = app.get(MigrationConnectors);
      jest
        .spyOn(adapters, 'source')
        .mockImplementation((input) =>
          Promise.resolve(new SqlSource(old, input)),
        );
      jest
        .spyOn(adapters, 'target')
        .mockImplementation((input) =>
          Promise.resolve(new SqlTarget(next, input)),
        );
    });
    afterEach(() => jest.restoreAllMocks());
    const input = () => ({
      mode: 'upgrade',
      source: {
        engine: 'mysql',
        host: 'old.example.test',
        user: 'operator',
        password: 'source-private-password',
        database: 'old',
      },
      target: {
        engine: 'mysql',
        host: 'new.example.test',
        user: 'operator',
        password: 'target-private-password',
        database: 'new',
      },
      objects: [
        { sourceId: JSON.stringify(['old', 'ledger']), targetName: 'ledger' },
      ],
    });
    async function planViaRest(): Promise<MigrationPlan> {
      const response = await api()
        .post('/dbf/migration/plan')
        .auth(credentials.user, credentials.password)
        .send(input())
        .expect(200);
      return response.body as MigrationPlan;
    }
    async function finish(id: string): Promise<MigrationStatus> {
      for (let i = 0; i < 100; i++) {
        const response = await api()
          .get('/dbf/migration/jobs/' + id)
          .auth(credentials.user, credentials.password)
          .expect(200);
        const result = response.body as MigrationStatus;
        if (result.state !== 'running') return result;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      throw new Error('HTTP migration did not finish');
    }
    test.each(['REST', 'GraphQL'])(
      '%s plan preserves MySQL 5.6 values when starting on 8.0',
      async (transport) => {
        let plan: MigrationPlan;
        if (transport === 'REST') plan = await planViaRest();
        else {
          const response = await api()
            .post('/dbf/graphql')
            .auth(credentials.user, credentials.password)
            .send({
              query:
                'mutation($input:MigrationPlanInput!){prepareMigration(input:$input){id mode sourceVersion{family version} targetVersion{family version} objects{targetName columns{name targetType}} warnings}}',
              variables: { input: input() },
            })
            .expect(200);
          const body = response.body as {
            errors?: unknown[];
            data: { prepareMigration: MigrationPlan };
          };
          expect(body.errors).toBeUndefined();
          plan = body.data.prepareMigration;
        }
        expect(plan).toMatchObject({
          mode: 'upgrade',
          sourceVersion: { family: 'mysql', version: '5.6.51' },
          targetVersion: { family: 'mysql', version: '8.0.40' },
        });
        expect(plan.objects[0].columns.map((c) => c.targetType)).toEqual([
          'decimal(20,0)',
          'decimal(65,30)',
          'longtext',
          'longblob',
          'longtext',
        ]);
        expect(
          next.query.mock.calls.some(([sql]) => sql.startsWith('CREATE')),
        ).toBe(false);
        const response = await api()
          .post('/dbf/migration/plan/' + plan.id + '/start')
          .auth(credentials.user, credentials.password)
          .expect(202);
        const started = response.body as MigrationStatus;
        const status = await finish(started.id);
        expect(status).toMatchObject({
          state: 'done',
          read: 2,
          written: 2,
          skipped: 0,
        });
        const inserts = next.query.mock.calls.filter(([sql]) =>
          sql.startsWith('INSERT'),
        );
        expect(inserts.map(([, parameters]) => parameters)).toEqual(
          values.map((row) => [
            row.id,
            row.amount,
            row.at,
            row.payload,
            row.title,
          ]),
        );
        expect(next.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(
          true,
        );
        expect(JSON.stringify({ plan, status })).not.toMatch(
          /source-private-password|target-private-password|private-source-value/,
        );
        await api()
          .post('/dbf/migration/plan/' + plan.id + '/start')
          .auth(credentials.user, credentials.password)
          .expect(404);
      },
    );
    test('a changed destination version rejects the reviewed plan before CREATE', async () => {
      const plan = await planViaRest();
      destinationVersion = '8.4.0';
      const started = await api()
        .post('/dbf/migration/plan/' + plan.id + '/start')
        .auth(credentials.user, credentials.password)
        .expect(202);
      const status = await finish((started.body as MigrationStatus).id);
      expect(status.state).toBe('failed');
      expect(status.error).toContain('version changed');
      expect(
        next.query.mock.calls.some(([sql]) =>
          /^(CREATE|INSERT|BEGIN)/.test(sql),
        ),
      ).toBe(false);
    });
    test('a MySQL development milestone is refused before creating destination objects', async () => {
      destinationVersion = '8.0.0-dmr';
      const result = await api()
        .post('/dbf/migration/plan')
        .auth(credentials.user, credentials.password)
        .send(input())
        .expect(400);
      expect((result.body as { message: string }).message).toContain('stable');
      expect(
        next.query.mock.calls.some(([sql]) =>
          /^(CREATE|INSERT|BEGIN)/.test(sql),
        ),
      ).toBe(false);
    });
  });
});
