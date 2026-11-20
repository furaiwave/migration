/* Async protocol fakes implement driver contracts. */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import type { Server } from 'http';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { getIntrospectionQuery } from 'graphql';
import request from 'supertest';
import { GraphqlController } from './graphql.controller';
import { GraphqlService } from './graphql.service';
import { MigrationController } from '../migration/migration.controller';
import { MigrationService } from '../migration/migration.service';
import { MigrationConnectors } from '../migration/connectors';
import type {
  Engine,
  MigrationConnection,
  MigrationObject,
  MigrationPlan,
  MigrationStatus,
} from '../migration/migration.types';
import type { Source, Target } from '../migration/model';
import {
  NativeConnectorService,
  type NativeConnection,
  type NativeConnectionInfo,
} from '../dbf/native-connector.service';
import { webAccess } from '../web-access';

interface GraphqlResponse {
  data?: Record<string, unknown> | null;
  errors?: { message: string; extensions: { code: string } }[];
}
const payload = (response: { body: unknown }) =>
  response.body as GraphqlResponse;
const settings = (engine: Engine = 'mysql'): MigrationConnection => ({
  engine,
  host: 'localhost',
  port: 3306,
  user: 'user',
  password: 'source-secret',
  database: engine === 'redis' ? '0' : 'legacy',
  ...(engine === 'mongo'
    ? { uri: 'mongodb://localhost' }
    : engine === 'redis'
      ? { uri: 'redis://localhost/0' }
      : {}),
});
const sourceObject: MigrationObject = {
  id: '["legacy","items"]',
  schema: 'legacy',
  name: 'items',
  format: 'rows',
  columns: [{ name: 'id', kind: 'integer', precision: 19, nullable: false }],
};
const statusSelection = 'id state phase read written skipped warnings error';
const planQuery =
  'mutation Plan($input: MigrationPlanInput!) { prepareMigration(input: $input) { id mode expiresAt sourceEngine targetEngine sourceVersion {family version} targetVersion {family version} objects {targetName columns {name targetType}} warnings } }';
const catalogQuery =
  'query Catalog($connection: DatabaseConnectionInput!) { databaseCatalog(connection: $connection) { objects {id schema name format columns {name kind nullable precision scale}} } }';
const connectionQuery =
  'query Connect($connection: DatabaseConnectionInput!) { databaseConnection(connection: $connection) { serverVersion databases connector elapsedMs } }';
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('GraphQL database API', () => {
  let app: INestApplication<Server>;
  let migrations: MigrationService;
  let source: jest.Mocked<Source>;
  let target: jest.Mocked<Target>;
  let connectors: jest.Mocked<MigrationConnectors>;
  let native: {
    test: jest.Mock<Promise<NativeConnectionInfo>, [NativeConnection]>;
  };
  beforeEach(async () => {
    source = {
      version: jest.fn(async () => ({
        family: 'mysql' as const,
        version: '5.6.51',
      })),
      objects: jest.fn(async () => [structuredClone(sourceObject)]),
      read: jest.fn(async function* () {
        yield { id: '9007199254740993' };
      }),
      close: jest.fn(async () => {}),
    };
    target = {
      version: jest.fn(async () => ({
        family: 'mysql' as const,
        version: '8.0.40',
      })),
      check: jest.fn(async () => {}),
      begin: jest.fn(async () => {}),
      write: jest.fn(async () => true),
      commit: jest.fn(async () => {}),
      rollback: jest.fn(async () => true),
      close: jest.fn(async () => {}),
    };
    connectors = {
      source: jest.fn(async () => source),
      target: jest.fn(async () => target),
      differentRedisDatabases: jest.fn(async () => {}),
    };
    native = {
      test: jest.fn(async () => ({
        serverVersion: '8.0.40',
        databases: ['legacy'],
        connector: 'rust',
        elapsedMs: 2,
      })),
    };
    const module = await Test.createTestingModule({
      controllers: [GraphqlController, MigrationController],
      providers: [
        GraphqlService,
        MigrationService,
        { provide: MigrationConnectors, useValue: connectors },
        { provide: NativeConnectorService, useValue: native },
      ],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>();
    app.use(webAccess({ user: 'operator', password: 'test-password-123456' }));
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
    migrations = module.get(MigrationService);
  });
  afterEach(async () => {
    await app.close();
    jest.restoreAllMocks();
  });
  const planInput = () => ({
    source: settings(),
    target: { ...settings(), database: 'destination' },
    objects: [{ sourceId: sourceObject.id, targetName: 'items' }],
  });
  const post = (
    query: string,
    variables?: Record<string, unknown>,
    operationName?: string,
  ) =>
    request(app.getHttpServer())
      .post('/dbf/graphql')
      .auth('operator', 'test-password-123456')
      .set('Accept', 'application/graphql-response+json')
      .send({ query, variables, operationName });
  async function finish(id: string) {
    for (let i = 0; i < 100; i++) {
      await tick();
      if (migrations.status(id).state !== 'running')
        return migrations.status(id);
    }
    throw new Error('Migration did not finish');
  }

  test('publishes a typed schema and standard introspection behind authentication', async () => {
    const sdl = await request(app.getHttpServer())
      .get('/dbf/graphql/schema')
      .auth('operator', 'test-password-123456')
      .expect(200);
    expect(sdl.headers['content-type']).toContain('text/plain');
    expect(sdl.headers['cache-control']).toBe('no-store');
    expect(sdl.text).toContain('type Mutation');
    const response = await post(getIntrospectionQuery()).expect(200);
    expect(payload(response).errors).toBeUndefined();
    expect(payload(response).data).toHaveProperty('__schema');
    expect(response.headers['cache-control']).toBe('no-store');
  });
  test('rejects unauthenticated requests and credentials in URL queries', async () => {
    await request(app.getHttpServer())
      .post('/dbf/graphql')
      .send({ query: '{__typename}' })
      .expect(401);
    await request(app.getHttpServer()).get('/dbf/graphql/schema').expect(401);
    const response = await request(app.getHttpServer())
      .get('/dbf/graphql')
      .auth('operator', 'test-password-123456')
      .query({ query: '{__typename}' })
      .expect(405);
    expect(response.headers.allow).toBe('POST');
    expect(native.test).not.toHaveBeenCalled();
  });
  test.each(['mysql', 'mongo', 'postgres', 'mssql', 'redis'] as Engine[])(
    '%s uses the existing catalog and connection adapters',
    async (engine) => {
      const connection = settings(engine);
      const checked = await post(connectionQuery, { connection }).expect(200);
      expect(payload(checked).data).toEqual({
        databaseConnection: {
          serverVersion: '8.0.40',
          databases: ['legacy'],
          connector: 'rust',
          elapsedMs: 2,
        },
      });
      expect(native.test).toHaveBeenCalledWith(connection);
      const response = await post(catalogQuery, { connection }).expect(200);
      expect(payload(response).data).toMatchObject({
        databaseCatalog: {
          objects: [
            {
              id: sourceObject.id,
              columns: [{ name: 'id', kind: 'integer', precision: 19 }],
            },
          ],
        },
      });
      expect(connectors.source).toHaveBeenCalledWith(connection);
      expect(response.text).not.toContain('source-secret');
      expect(target.write).not.toHaveBeenCalled();
    },
  );
  test('a connection check can omit a database; a migration catalog cannot', async () => {
    const connection = { ...settings(), database: undefined };
    await post(connectionQuery, { connection }).expect(200);
    // Required database semantics are enforced in the resolver, producing GraphQL execution errors.
    const response = await post(catalogQuery, { connection });
    expect(payload(response).errors?.[0].extensions.code).toBe(
      'BAD_USER_INPUT',
    );
    expect(connectors.source).not.toHaveBeenCalled();
  });
  test('prepares a reviewable plan and shares its lifecycle with REST', async () => {
    const response = await post(planQuery, { input: planInput() }).expect(200);
    const plan = payload(response).data?.prepareMigration as MigrationPlan;
    expect(plan).toMatchObject({
      mode: 'transfer',
      sourceEngine: 'mysql',
      targetEngine: 'mysql',
      objects: [{ targetName: 'items', columns: [{ targetType: 'bigint' }] }],
    });
    expect(response.text).not.toContain('source-secret');
    expect(target.write).not.toHaveBeenCalled();
    const started = await request(app.getHttpServer())
      .post('/dbf/migration/plan/' + plan.id + '/start')
      .auth('operator', 'test-password-123456')
      .expect(202);
    const job = started.body as MigrationStatus;
    await finish(job.id);
    const status = await post(
      'query Status($id: ID!) {migrationStatus(id:$id) {' +
        statusSelection +
        '}}',
      { id: job.id },
    ).expect(200);
    expect(payload(status).data).toMatchObject({
      migrationStatus: { state: 'done', read: 1, written: 1 },
    });
    expect(target.write.mock.calls[0][1]).toEqual({ id: '9007199254740993' });
    expect(target.commit).toHaveBeenCalledTimes(1);
  });
  test('starts a REST-prepared plan through GraphQL and enforces single use', async () => {
    const response = await request(app.getHttpServer())
      .post('/dbf/migration/plan')
      .auth('operator', 'test-password-123456')
      .send(planInput())
      .expect(200);
    const plan = response.body as MigrationPlan;
    const started = await post(
      'mutation Start($id:ID!) {startMigration(planId:$id) {' +
        statusSelection +
        '}}',
      { id: plan.id },
    ).expect(200);
    const job = payload(started).data?.startMigration as MigrationStatus;
    expect((await finish(job.id)).state).toBe('done');
    const reused = await post(
      'mutation Start($id:ID!) {startMigration(planId:$id) {id}}',
      { id: plan.id },
    ).expect(200);
    expect(payload(reused).errors?.[0].extensions.code).toBe('NOT_FOUND');
    expect(target.commit).toHaveBeenCalledTimes(1);
  });
  test('preserves the existing version-upgrade checks and detected versions', async () => {
    const response = await post(planQuery, {
      input: { ...planInput(), mode: 'upgrade' },
    }).expect(200);
    const plan = payload(response).data?.prepareMigration as MigrationPlan;
    expect(plan).toMatchObject({
      mode: 'upgrade',
      sourceVersion: { family: 'mysql', version: '5.6.51' },
      targetVersion: { family: 'mysql', version: '8.0.40' },
    });
    target.version.mockResolvedValueOnce({
      family: 'mysql',
      version: '5.6.51',
    });
    const invalid = await post(planQuery, {
      input: { ...planInput(), mode: 'upgrade' },
    }).expect(200);
    expect(payload(invalid).errors?.[0].message).toContain('must be newer');
    expect(target.write).not.toHaveBeenCalled();
  });
  test('cancels the shared migration job before commit and reports rollback', async () => {
    const plan = await migrations.prepare(planInput());
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    target.write.mockImplementationOnce(async () => {
      entered();
      await waiting;
      return true;
    });
    const job = migrations.start(plan.id);
    await writing;
    try {
      await post(
        'mutation Cancel($id:ID!) {cancelMigration(jobId:$id) {' +
          statusSelection +
          '}}',
        { id: job.id },
      ).expect(200);
    } finally {
      release();
    }
    expect(await finish(job.id)).toMatchObject({
      state: 'cancelled',
      written: 0,
    });
    expect(target.commit).not.toHaveBeenCalled();
  });
  test('counters above the GraphQL Int range stay readable', async () => {
    jest.spyOn(migrations, 'status').mockReturnValue({
      id: 'job',
      state: 'running',
      phase: 'copying',
      read: 4000000000,
      written: 3999999999,
      skipped: 1,
      startedAt: new Date().toISOString(),
      warnings: [],
    });
    const response = await post(
      '{migrationStatus(id:"job") {read written skipped}}',
    ).expect(200);
    expect(payload(response).data).toEqual({
      migrationStatus: { read: 4000000000, written: 3999999999, skipped: 1 },
    });
  });
  test.each([
    { port: 70000 },
    { host: 'x'.repeat(256) },
    { database: 'x'.repeat(129) },
  ])(
    'enforces REST connection validation before accessing drivers: %j',
    async (patch) => {
      const response = await post(connectionQuery, {
        connection: { ...settings(), ...patch },
      }).expect(200);
      expect(payload(response).errors?.[0].extensions.code).toBe(
        'BAD_USER_INPUT',
      );
      expect(native.test).not.toHaveBeenCalled();
    },
  );
  test.each([
    { objects: [] },
    {
      objects: Array.from({ length: 201 }, () => ({
        sourceId: 'items',
        targetName: 'copy',
      })),
    },
  ])('enforces migration selection limits', async ({ objects }) => {
    const response = await post(planQuery, {
      input: { ...planInput(), objects },
    }).expect(200);
    expect(payload(response).errors?.[0].extensions.code).toBe(
      'BAD_USER_INPUT',
    );
    expect(connectors.source).not.toHaveBeenCalled();
  });
  test('masks coercion errors that would otherwise echo connection secrets', async () => {
    const response = await post(connectionQuery, {
      connection: {
        ...settings(),
        password: 'never-echo-this-password',
        port: 'never-echo-this-password',
      },
    }).expect(200);
    expect(response.text).not.toContain('never-echo-this-password');
    expect(response.text).not.toContain('source-secret');
    expect(payload(response).errors?.[0].extensions.code).toBe(
      'BAD_USER_INPUT',
    );
    expect(native.test).not.toHaveBeenCalled();
  });
  test('masks parser and driver errors, with no stack trace or error extensions', async () => {
    const malformed = await post(
      '{ databaseConnection(connection: {password: "never-echo-this-password" ',
    ).expect(400);
    expect(malformed.text).not.toContain('never-echo-this-password');
    native.test.mockRejectedValueOnce(new Error('never-echo-this-password'));
    const failed = await post(connectionQuery, {
      connection: settings(),
    }).expect(200);
    expect(failed.text).not.toContain('never-echo-this-password');
    expect(failed.text).not.toContain('stack');
    expect(payload(failed).errors?.[0].extensions.code).toBe(
      'INTERNAL_SERVER_ERROR',
    );
  });
  test('rejects invalid fields and operation variables before a resolver runs', async () => {
    await post('mutation { executeSql(sql:"DROP TABLE items") }').expect(400);
    await post(catalogQuery, {
      connection: { ...settings(), arbitrarySql: 'DROP TABLE items' },
    }).expect(200);
    await post(
      '{databaseCatalog(connection: {engine: oracle}) {objects{id}}}',
    ).expect(400);
    expect(connectors.source).not.toHaveBeenCalled();
  });
  test('rejects multiple root actions including aliases hidden in fragments', async () => {
    const spy = jest.spyOn(migrations, 'start');
    const response = await post(
      'mutation {one:startMigration(planId:"one"){id} ...More} fragment More on Mutation {two:startMigration(planId:"two"){id}}',
    ).expect(400);
    expect(payload(response).errors?.[0].message).toContain('one root field');
    expect(spy).not.toHaveBeenCalled();
  });
  test('limits cyclic and repeated fragment expansion before execution', async () => {
    const cyclic = await post(
      'query {...Loop} fragment Loop on Query {...Loop}',
    ).expect(400);
    expect(payload(cyclic).errors?.[0].message).toContain('Cyclic');
    const expanded = await post(
      '{migrationStatus(id:"x") {' +
        Array.from({ length: 1001 }, () => '...Fields').join(' ') +
        '}} fragment Fields on MigrationStatus {id}',
    ).expect(400);
    expect(payload(expanded).errors?.[0].message).toContain('1000');
  });
  test('limits selection depth, document bytes and parser tokens', async () => {
    let selection = 'name';
    for (let i = 0; i < 22; i++) selection = 'ofType {' + selection + '}';
    const deep = await post(
      '{__type(name:"Query") {' + selection + '}}',
    ).expect(400);
    expect(payload(deep).errors?.[0].message).toContain('depth');
    const huge = await post('{__typename} #' + 'x'.repeat(32 * 1024)).expect(
      400,
    );
    expect(payload(huge).errors?.[0].message).toContain('32 KiB');
    await post(
      '{__typename ' + '... on Query {__typename} '.repeat(900) + '}',
    ).expect(400);
  });
  test('supports operationName, rejects batching and unsupported media types', async () => {
    const selected = await post(
      'query First {migrationStatus(id:"absent"){id}} query Second {__typename}',
      undefined,
      'Second',
    ).expect(200);
    expect(payload(selected).data).toEqual({ __typename: 'Query' });
    await request(app.getHttpServer())
      .post('/dbf/graphql')
      .auth('operator', 'test-password-123456')
      .send([{ query: '{__typename}' }])
      .expect(400);
    await request(app.getHttpServer())
      .post('/dbf/graphql')
      .auth('operator', 'test-password-123456')
      .type('text')
      .send('{__typename}')
      .expect(415);
  });
});
