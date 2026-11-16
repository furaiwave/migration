import { EventEmitter } from 'events';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { NativeConnectorService } from './native-connector.service';
jest.mock('child_process', () => ({ spawn: jest.fn() }));
function child() {
  const output = Object.assign(new EventEmitter(), { setEncoding: jest.fn() });
  const input = Object.assign(new EventEmitter(), {
    end: jest.fn((input: string) => {
      void input;
    }),
  });
  return Object.assign(new EventEmitter(), {
    stdout: output,
    stdin: input,
    kill: jest.fn(),
  });
}
describe('Rust connector bridge', () => {
  const previous = process.env.DBF_CONNECTOR_BIN;
  beforeEach(() => {
    process.env.DBF_CONNECTOR_BIN = process.execPath;
    jest.clearAllMocks();
    jest.mocked(spawn).mockReset();
  });
  afterEach(() => {
    jest.useRealTimers();
    if (previous === undefined) delete process.env.DBF_CONNECTOR_BIN;
    else process.env.DBF_CONNECTOR_BIN = previous;
  });
  test('passes secrets only through stdin and coalesces duplicate discoveries', async () => {
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const service = new NativeConnectorService();
    const result = service.test({
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'test',
      password: 'private-secret',
      database: 'test',
    });
    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [],
      expect.objectContaining({ shell: false, windowsHide: true }),
    );
    expect(JSON.stringify(jest.mocked(spawn).mock.calls)).not.toContain(
      'private-secret',
    );
    const sent: unknown = JSON.parse(proc.stdin.end.mock.calls[0][0]);
    expect(sent).toEqual({
      command: 'test',
      connection: {
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
        user: 'test',
        password: 'private-secret',
        database: 'test',
      },
    });
    proc.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        result: {
          serverVersion: 'server',
          databases: ['test'],
          connector: 'rust',
        },
      }),
    );
    proc.emit('close', 0);
    await expect(result).resolves.toEqual({
      serverVersion: 'server',
      databases: ['test'],
      connector: 'rust',
    });
    const first = service.discover();
    const second = service.discover();
    expect(first).toBe(second);
    proc.stdout.emit(
      'data',
      JSON.stringify({ ok: true, result: { servers: [], warnings: [] } }),
    );
    proc.emit('close', 0);
    await expect(first).resolves.toEqual({ servers: [], warnings: [] });
  });
  test('kills a stalled connector and reports a sanitized error', async () => {
    jest.useFakeTimers();
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const service = new NativeConnectorService();
    const pending = service.discover();
    const assertion = expect(pending).rejects.toThrow('timed out');
    jest.advanceTimersByTime(20000);
    await assertion;
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
  test('rejects malformed output rather than returning success', async () => {
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const pending = new NativeConnectorService().discover();
    const assertion = expect(pending).rejects.toThrow(
      'Invalid Rust connector response',
    );
    proc.stdout.emit('data', 'not json');
    proc.emit('close', 0);
    await assertion;
  });
  test('recovers its concurrency slots after synchronous spawn errors', async () => {
    jest.mocked(spawn).mockImplementation(() => {
      throw new Error('sensitive OS details');
    });
    const service = new NativeConnectorService();
    for (let i = 0; i < 6; i++)
      await expect(
        service.test({
          engine: 'mysql',
          host: 'localhost',
          port: 3306,
          user: 'test',
        }),
      ).rejects.toThrow('could not start');
  });
  test('does not replace a missing explicit binary with a stale development build', async () => {
    process.env.DBF_CONNECTOR_BIN = 'relative-missing-connector.exe';
    await expect(new NativeConnectorService().discover()).rejects.toThrow(
      'not built',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  test('validates successful response fields before returning them to the interface', async () => {
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const result = new NativeConnectorService().test({ engine: 'mysql' });
    const assertion = expect(result).rejects.toThrow(
      'Invalid Rust connector response',
    );
    proc.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        result: { serverVersion: 'test', databases: [123], connector: 'rust' },
      }),
    );
    proc.emit('close', 0);
    await assertion;
  });
  test('rejects malformed discovery endpoints', async () => {
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const result = new NativeConnectorService().discover();
    const assertion = expect(result).rejects.toThrow(
      'Invalid Rust connector response',
    );
    proc.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        result: {
          servers: [
            {
              id: 'a',
              engine: 'postgres',
              host: 'localhost',
              port: 70000,
              label: 'DB',
              source: 'port',
              reachable: true,
              protocolConfirmed: true,
            },
          ],
          warnings: [],
        },
      }),
    );
    proc.emit('close', 0);
    await assertion;
  });
  test('rejects oversized UTF-8 input without starting a child', async () => {
    await expect(
      new NativeConnectorService().test({
        engine: 'mysql',
        password: 'x'.repeat(65536),
      }),
    ).rejects.toThrow('too large');
    expect(spawn).not.toHaveBeenCalled();
  });
  test('terminates a child when its stdin fails synchronously', async () => {
    const proc = child();
    proc.stdin.end.mockImplementation(() => {
      throw new Error('pipe failed');
    });
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    await expect(
      new NativeConnectorService().test({ engine: 'mysql' }),
    ).rejects.toThrow('input failed');
    expect(proc.kill).toHaveBeenCalledTimes(1);
  });
  test('sends the catalog command and preserves elapsed connection time', async () => {
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const result = new NativeConnectorService().catalog({
      engine: 'postgres',
      host: 'localhost',
      port: 5432,
      user: 'test',
    });
    const sent: unknown = JSON.parse(proc.stdin.end.mock.calls[0][0]);
    expect(sent).toEqual({
      command: 'catalog',
      connection: {
        engine: 'postgres',
        host: 'localhost',
        port: 5432,
        user: 'test',
      },
    });
    proc.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        result: {
          serverVersion: 'PG',
          databases: ['archive', 'legacy'],
          connector: 'rust',
          elapsedMs: 12,
        },
      }),
    );
    proc.emit('close', 0);
    await expect(result).resolves.toEqual({
      serverVersion: 'PG',
      databases: ['archive', 'legacy'],
      connector: 'rust',
      elapsedMs: 12,
    });
  });
  test('returns typed network diagnostics without requiring credentials', async () => {
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const result = new NativeConnectorService().diagnose({
      host: 'localhost',
      port: 5432,
    });
    const report = {
      host: 'localhost',
      port: 5432,
      status: 'refused',
      elapsedMs: 5,
      resolvedAddresses: ['127.0.0.1'],
    };
    proc.stdout.emit('data', JSON.stringify({ ok: true, result: report }));
    proc.emit('close', 0);
    await expect(result).resolves.toEqual(report);
  });
  test('rejects unsupported diagnostic statuses', async () => {
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const result = new NativeConnectorService().diagnose({
      host: 'localhost',
      port: 5432,
    });
    const assertion = expect(result).rejects.toThrow(
      'Invalid Rust connector response',
    );
    proc.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        result: {
          host: 'localhost',
          port: 5432,
          status: 'authenticated',
          elapsedMs: 5,
          resolvedAddresses: [],
        },
      }),
    );
    proc.emit('close', 0);
    await assertion;
  });
  test('passes structure inspection to Rust and accepts metadata-only reports', async () => {
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const result = new NativeConnectorService().inspect({
      engine: 'postgres',
      database: 'legacy',
      password: 'private-secret',
    });
    const request: unknown = JSON.parse(proc.stdin.end.mock.calls[0][0]);
    expect(request).toEqual({
      command: 'inspect',
      connection: {
        engine: 'postgres',
        database: 'legacy',
        password: 'private-secret',
      },
    });
    const report = {
      engine: 'postgres',
      database: 'legacy',
      elapsedMs: 4,
      truncated: false,
      objects: [
        {
          schema: 'public',
          name: 'clients',
          kind: 'table',
          columns: [
            { name: 'id', dataType: 'integer', nullable: false, ordinal: 1 },
          ],
        },
      ],
    };
    proc.stdout.emit('data', JSON.stringify({ ok: true, result: report }));
    proc.emit('close', 0);
    await expect(result).resolves.toEqual(report);
    expect(JSON.stringify(report)).not.toContain('private-secret');
  });
  test('rejects malformed structure columns instead of passing them to the UI', async () => {
    const proc = child();
    jest
      .mocked(spawn)
      .mockReturnValue(proc as unknown as ChildProcessWithoutNullStreams);
    const result = new NativeConnectorService().inspect({
      engine: 'postgres',
      database: 'legacy',
    });
    const assertion = expect(result).rejects.toThrow(
      'Invalid Rust connector response',
    );
    proc.stdout.emit(
      'data',
      JSON.stringify({
        ok: true,
        result: {
          engine: 'postgres',
          database: 'legacy',
          elapsedMs: 4,
          truncated: false,
          objects: [
            {
              schema: 'public',
              name: 'clients',
              kind: 'table',
              columns: [{ name: 'id', dataType: 'integer', ordinal: 0 }],
            },
          ],
        },
      }),
    );
    proc.emit('close', 0);
    await assertion;
  });
});
