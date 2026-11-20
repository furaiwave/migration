/* Async protocol fakes implement driver contracts; method references are used only in Jest assertions. */
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { MigrationService, validateConnection } from './migration.service';
import { MigrationConnectors } from './connectors';
import { MigrationError, type Source, type Target } from './model';
import type {
  Engine,
  MigrationConnection,
  MigrationObject,
  MigrationPlanRequest,
} from './migration.types';

const engines: Engine[] = ['mysql', 'mongo', 'postgres', 'mssql', 'redis'];
const connection = (engine: Engine): MigrationConnection => ({
  engine,
  host: 'localhost',
  user: 'test',
  password: 'top-secret',
  port: 3306,
  database: engine === 'redis' ? '0' : 'test',
  uri: engine === 'redis' ? 'redis://localhost/0' : 'mongodb://localhost',
});
const object: MigrationObject = {
  id: 'items',
  name: 'items',
  schema: '',
  format: 'rows',
  columns: [{ name: 'id', kind: 'integer', nullable: false, precision: 19 }],
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('database migration orchestration', () => {
  let service: MigrationService;
  let source: Source;
  let target: jest.Mocked<Target>;
  let connectors: jest.Mocked<MigrationConnectors>;
  let request: MigrationPlanRequest;
  beforeEach(() => {
    source = {
      version: jest.fn(async () => ({
        family: 'mysql' as const,
        version: '5.6.51',
      })),
      objects: jest.fn(async () => [structuredClone(object)]),
      read: async function* () {
        yield { id: '9007199254740993' };
        yield { id: '2' };
      },
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
    } as unknown as jest.Mocked<Target>;
    connectors = {
      source: jest.fn(async () => source),
      target: jest.fn(async () => target),
      differentRedisDatabases: jest.fn(async () => {}),
    } as unknown as jest.Mocked<MigrationConnectors>;
    service = new MigrationService(connectors);
    request = {
      source: connection('mysql'),
      target: connection('postgres'),
      objects: [{ sourceId: 'items', targetName: 'items_copy' }],
    };
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    jest.restoreAllMocks();
  });
  async function finish(id: string) {
    for (let i = 0; i < 100; i++) {
      await tick();
      if (service.status(id).state !== 'running') return service.status(id);
    }
    throw new Error('Migration did not finish');
  }
  test.each(
    engines.flatMap((left) => engines.map((right) => [left, right] as const)),
  )(
    '%s → %s routes reads and writes through the appropriate adapters',
    async (left, right) => {
      request.source = connection(left);
      request.target = connection(right);
      const plan = await service.prepare(request);
      expect(target.write).not.toHaveBeenCalled();
      expect(JSON.stringify(plan)).not.toContain('top-secret');
      const status = await finish(service.start(plan.id).id);
      expect(status).toMatchObject({
        state: 'done',
        read: 2,
        written: 2,
        skipped: 0,
        phase: 'finished',
      });
      expect(connectors.source).toHaveBeenLastCalledWith(request.source);
      expect(connectors.target).toHaveBeenLastCalledWith(
        request.target,
        'migration',
        undefined,
      );
      expect(target.write.mock.calls[0][1]).toEqual({ id: '9007199254740993' });
      expect(target.commit).toHaveBeenCalledTimes(1);
    },
  );
  test.each([
    ['mysql', '5.6.51', '8.0.40'],
    ['mongo', '4.2.24', '8.0.0'],
    ['postgres', '9.6.24', '16.4'],
    ['mssql', '12.0.6024.0', '16.0.1000.6'],
    ['redis', '6.2.14', '7.2.5'],
  ] as const)(
    '%s upgrades from %s to %s using detected versions',
    async (engine, oldVersion, newVersion) => {
      request.mode = 'upgrade';
      request.source = connection(engine);
      request.target = connection(engine);
      source.version = jest.fn(async () => ({
        family: engine,
        version: oldVersion,
      }));
      target.version.mockResolvedValue({ family: engine, version: newVersion });
      const plan = await service.prepare(request);
      expect(plan).toMatchObject({
        mode: 'upgrade',
        sourceVersion: { version: oldVersion },
        targetVersion: { version: newVersion },
      });
      expect(target.begin).not.toHaveBeenCalled();
      expect((await finish(service.start(plan.id).id)).state).toBe('done');
      expect(source.version).toHaveBeenCalledTimes(2);
      expect(target.version).toHaveBeenCalledTimes(2);
      expect(connectors.target).toHaveBeenLastCalledWith(
        request.target,
        'migration',
        'upgrade',
      );
    },
  );
  test('upgrade rejects different engines before opening connections', async () => {
    request.mode = 'upgrade';
    await expect(service.prepare(request)).rejects.toThrow(
      'same database engine',
    );
    expect(connectors.source).not.toHaveBeenCalled();
  });
  test.each(['5.5.62', '5.6.51'])(
    'upgrade rejects a destination at %s',
    async (version) => {
      request.mode = 'upgrade';
      request.target = connection('mysql');
      target.version.mockResolvedValue({ family: 'mysql', version });
      await expect(service.prepare(request)).rejects.toThrow('must be newer');
      expect(target.begin).not.toHaveBeenCalled();
      expect(source.close).toHaveBeenCalled();
      expect(target.close).toHaveBeenCalled();
    },
  );
  test('upgrade rechecks versions before creating any destination objects', async () => {
    request.mode = 'upgrade';
    request.target = connection('mysql');
    const plan = await service.prepare(request);
    target.version.mockResolvedValue({ family: 'mysql', version: '8.4.0' });
    const status = await finish(service.start(plan.id).id);
    expect(status.error).toMatch(/version changed/);
    expect(target.begin).not.toHaveBeenCalled();
  });
  test('upgrade never exposes driver errors from version queries', async () => {
    request.mode = 'upgrade';
    request.target = connection('mysql');
    target.version.mockRejectedValue(new Error('top-secret / private-record'));
    await expect(service.prepare(request)).rejects.toThrow(
      'Driver details are hidden',
    );
    expect(target.begin).not.toHaveBeenCalled();
    expect(target.close).toHaveBeenCalled();
  });
  test('plans are immutable snapshots, single-use and expire', async () => {
    const plan = await service.prepare(request);
    plan.objects[0].targetName = 'tampered';
    request.source.password = 'changed-after-plan';
    const started = service.start(plan.id);
    expect(() => service.start(plan.id)).toThrow(
      'expired or has already been used',
    );
    await finish(started.id);
    expect(target.write.mock.calls[0][0].targetName).toBe('items_copy');
    expect(connectors.source.mock.calls.at(-1)![0].password).toBe('top-secret');
    const expires = await service.prepare(request);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60 * 1000);
    expect(() => service.start(expires.id)).toThrow('expired');
  });
  test('rejects destination collisions and duplicate selections before writes', async () => {
    request.objects.push({ sourceId: 'items', targetName: 'second' });
    await expect(service.prepare(request)).rejects.toThrow('more than once');
    expect(target.begin).not.toHaveBeenCalled();
  });
  test('refuses a changed source schema before creating destination objects', async () => {
    const plan = await service.prepare(request);
    source.objects = async () => [
      {
        ...object,
        columns: [
          ...object.columns,
          { name: 'new_field', kind: 'text', nullable: true },
        ],
      },
    ];
    const status = await finish(service.start(plan.id).id);
    expect(status.state).toBe('failed');
    expect(status.error).toMatch(/structure changed/);
    expect(target.begin).not.toHaveBeenCalled();
  });
  test('cancellation before work does not open connections or write', async () => {
    const plan = await service.prepare(request);
    connectors.source.mockClear();
    const status = service.start(plan.id);
    service.cancel(status.id);
    expect((await finish(status.id)).state).toBe('cancelled');
    expect(connectors.source).not.toHaveBeenCalled();
    expect(target.begin).not.toHaveBeenCalled();
  });
  test.each([true, false])(
    'cancellation reports rollback=%s accurately',
    async (rolledBack) => {
      target.rollback.mockResolvedValue(rolledBack);
      const plan = await service.prepare(request);
      const job = service.start(plan.id);
      target.write.mockImplementationOnce(async () => {
        service.cancel(job.id);
        return true;
      });
      const status = await finish(job.id);
      expect(status.state).toBe('cancelled');
      expect(status.read).toBe(1);
      expect(status.written).toBe(rolledBack ? 0 : 1);
      expect(target.commit).not.toHaveBeenCalled();
      expect(target.close).toHaveBeenCalled();
      expect(source.close).toHaveBeenCalled();
    },
  );
  test('driver errors never expose credentials or row contents', async () => {
    const plan = await service.prepare(request);
    target.write.mockRejectedValueOnce(
      new Error('top-secret / private-record'),
    );
    const status = await finish(service.start(plan.id).id);
    expect(status.state).toBe('failed');
    expect(status.error).not.toMatch(/top-secret|private-record/);
    expect(target.rollback).toHaveBeenCalled();
  });
  test('counts skipped expired Redis keys separately', async () => {
    const plan = await service.prepare(request);
    target.write.mockResolvedValueOnce(false);
    expect(await finish(service.start(plan.id).id)).toMatchObject({
      read: 2,
      written: 1,
      skipped: 1,
    });
  });
  test('reports an unconfirmed rollback instead of claiming zero writes', async () => {
    const plan = await service.prepare(request);
    target.write
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('network'));
    target.rollback.mockRejectedValue(new Error('connection closed'));
    const status = await finish(service.start(plan.id).id);
    expect(status.written).toBe(1);
    expect(status.warnings.join(' ')).toMatch(/could not be confirmed/);
  });
  test('Redis identity checks run at planning and execution', async () => {
    request.source = connection('redis');
    request.target = connection('redis');
    const plan = await service.prepare(request);
    connectors.differentRedisDatabases.mockRejectedValueOnce(
      new MigrationError('same Redis database'),
    );
    const status = await finish(service.start(plan.id).id);
    expect(status.error).toMatch(/same Redis database/);
    expect(target.begin).not.toHaveBeenCalled();
  });
  test('returned job status cannot mutate server state', async () => {
    const plan = await service.prepare(request);
    const job = service.start(plan.id);
    job.state = 'failed';
    expect(service.status(job.id).state).toBe('running');
    await finish(job.id);
  });
});
describe('connection validation', () => {
  test.each([
    'http://localhost',
    'file:///etc/passwd',
    'redis://localhost/-1',
    'redis://localhost/0?x=y',
  ])('rejects invalid Redis URI %s', (uri) => {
    expect(() => validateConnection({ ...connection('redis'), uri })).toThrow();
  });
  test('rejects mismatched Redis database and URI index', () => {
    expect(() =>
      validateConnection({ ...connection('redis'), database: '1' }),
    ).toThrow();
  });
  test('accepts MongoDB replica-set URIs', () => {
    expect(() =>
      validateConnection({
        ...connection('mongo'),
        uri: 'mongodb://db1:27017,db2:27017/?replicaSet=rs0',
      }),
    ).not.toThrow();
  });
});
