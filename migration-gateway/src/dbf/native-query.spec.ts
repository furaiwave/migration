import { EventEmitter } from 'events';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { Test } from '@nestjs/testing';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { Server } from 'http';
import request from 'supertest';
import { NativeConnectorService } from './native-connector.service';
import { NativeConnectorController } from './native-connector.controller';
import {
  queryResult,
  type NativeQueryResult,
} from '../types/native-query.types';
jest.mock('child_process', () => ({ spawn: jest.fn() }));
const report: NativeQueryResult = {
  connector: 'rust',
  elapsedMs: 4,
  truncated: false,
  error: null,
  sets: [
    {
      columns: [{ name: 'id', dataType: 'bigint' }],
      rows: [['9007199254740993']],
      affectedRows: '1',
      rowCount: 1,
      truncated: false,
      clipped: false,
    },
  ],
};
const settings = {
  engine: 'postgres' as const,
  host: 'localhost',
  port: 5432,
  user: 'test',
  password: 'private-secret',
  database: 'test',
};
function processMock() {
  return Object.assign(new EventEmitter(), {
    stdout: Object.assign(new EventEmitter(), { setEncoding: jest.fn() }),
    stdin: Object.assign(new EventEmitter(), {
      end: jest.fn((input: string) => {
        void input;
      }),
    }),
    kill: jest.fn(),
  });
}
describe('SQL execution bridge', () => {
  const previous = process.env.DBF_CONNECTOR_BIN;
  beforeEach(() => {
    process.env.DBF_CONNECTOR_BIN = process.execPath;
    jest.mocked(spawn).mockReset();
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.DBF_CONNECTOR_BIN;
    else process.env.DBF_CONNECTOR_BIN = previous;
  });
  test('streams the SQL request through stdin and preserves precise result strings', async () => {
    const child = processMock();
    jest
      .mocked(spawn)
      .mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
    const pending = new NativeConnectorService().query(
      settings,
      'SELECT private_value FROM t',
      1000,
    );
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(JSON.stringify(jest.mocked(spawn).mock.calls)).not.toContain(
      'private-secret',
    );
    expect(JSON.parse(child.stdin.end.mock.calls[0][0])).toEqual({
      command: 'query',
      connection: settings,
      sql: 'SELECT private_value FROM t',
      maxRows: 1000,
    });
    child.stdout.emit('data', JSON.stringify({ ok: true, result: report }));
    child.emit('close', 0);
    await expect(pending).resolves.toEqual(report);
  });
  test('abort kills the native request and releases a concurrency slot', async () => {
    const child = processMock();
    jest
      .mocked(spawn)
      .mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
    const service = new NativeConnectorService();
    for (let i = 0; i < 6; i++) {
      const controller = new AbortController(),
        pending = service.query(settings, 'SELECT 1', 100, controller.signal);
      const assertion = expect(pending).rejects.toThrow('stopped');
      controller.abort();
      await assertion;
    }
    expect(child.kill).toHaveBeenCalledTimes(6);
  });
  test('rejects invalid row shapes and unbounded cell responses', () => {
    expect(queryResult(report)).toBe(true);
    expect(
      queryResult({ ...report, sets: [{ ...report.sets[0], rows: [[123]] }] }),
    ).toBe(false);
    expect(
      queryResult({
        ...report,
        sets: [{ ...report.sets[0], rows: [['x'.repeat(16385)]] }],
      }),
    ).toBe(false);
    expect(
      queryResult({
        ...report,
        sets: [{ ...report.sets[0], rows: [[null, null]] }],
      }),
    ).toBe(false);
    expect(
      queryResult({
        ...report,
        error: { message: 'safe', code: 'secret\nvalue', position: 1 },
      }),
    ).toBe(false);
  });
  test('rejects unsupported engines without spawning a process', () => {
    expect(() =>
      new NativeConnectorService().query({ engine: 'mongo' }, 'SELECT 1', 100),
    ).toThrow('supports');
    expect(spawn).not.toHaveBeenCalled();
  });
});
describe('SQL execution endpoint', () => {
  let app: INestApplication<Server>;
  const query = jest.fn().mockResolvedValue(report);
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [NativeConnectorController],
      providers: [{ provide: NativeConnectorService, useValue: { query } }],
    }).compile();
    app = module.createNestApplication<INestApplication<Server>>();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  test('executes an explicitly submitted statement with a bounded row count', async () => {
    await request(app.getHttpServer())
      .post('/dbf/native/query')
      .send({
        connection: settings,
        sql: 'UPDATE t SET active=1',
        maxRows: 100,
      })
      .expect(200, report);
    expect(query).toHaveBeenCalledWith(
      settings,
      'UPDATE t SET active=1',
      100,
      expect.any(AbortSignal),
    );
  });
  test.each([
    { sql: 'SELECT 1' },
    { connection: settings, sql: 1 },
    { connection: settings, sql: 'SELECT 1', maxRows: 5001 },
    { connection: { ...settings, arbitrary: 'secret' }, sql: 'SELECT 1' },
    { connection: settings, sql: 'SELECT 1', command: 'shell' },
  ])('validates nested connection and SQL options: %j', async (body) => {
    await request(app.getHttpServer())
      .post('/dbf/native/query')
      .send(body)
      .expect(400);
  });
});
