import type { Readable, Writable } from 'stream';
import {
  queryResult,
  type NativeQueryResult,
} from '../types/native-query.types';
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { spawn, type ChildProcessByStdio } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
export type NativeEngine = 'mysql' | 'mongo' | 'postgres' | 'mssql' | 'redis';
export interface NativeServer {
  id: string;
  engine: NativeEngine;
  label: string;
  host: string;
  port: number;
  source: string;
  reachable: boolean;
  protocolConfirmed: boolean;
}
export interface NativeDiscovery {
  servers: NativeServer[];
  warnings: string[];
}
export interface NativeConnection {
  engine: NativeEngine;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
  uri?: string;
}
export interface NativeConnectionInfo {
  serverVersion: string;
  databases: string[];
  connector: 'rust';
  elapsedMs?: number;
}
export interface NativeEndpoint {
  host: string;
  port: number;
}
export interface NativeDiagnostic extends NativeEndpoint {
  status:
    | 'reachable'
    | 'refused'
    | 'timeout'
    | 'unreachable'
    | 'dnsError'
    | 'dnsTimeout';
  elapsedMs: number;
  resolvedAddresses: string[];
}
export interface NativeSchema {
  engine: NativeEngine;
  database: string;
  elapsedMs: number;
  truncated: boolean;
  objects: {
    schema: string;
    name: string;
    kind: 'table' | 'view' | 'collection';
    columns: {
      name: string;
      dataType: string;
      nullable: boolean;
      ordinal: number;
    }[];
  }[];
}
type NativeRequest =
  | {
      command: 'query';
      connection: NativeConnection;
      sql: string;
      maxRows: number;
    }
  | { command: 'discover' }
  | { command: 'test' | 'catalog' | 'inspect'; connection: NativeConnection }
  | { command: 'diagnose'; endpoint: NativeEndpoint };
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v: unknown) => typeof v === 'string');
function discoveryResult(value: unknown): value is NativeDiscovery {
  return (
    record(value) &&
    strings(value.warnings) &&
    Array.isArray(value.servers) &&
    value.servers.every(
      (s: unknown) =>
        record(s) &&
        typeof s.engine === 'string' &&
        ['mysql', 'mongo', 'postgres', 'mssql', 'redis'].includes(s.engine) &&
        ['id', 'label', 'host', 'source'].every(
          (k) => typeof s[k] === 'string',
        ) &&
        typeof s.host === 'string' &&
        s.host.trim().length > 0 &&
        typeof s.port === 'number' &&
        Number.isInteger(s.port) &&
        s.port >= 1 &&
        s.port <= 65535 &&
        typeof s.reachable === 'boolean' &&
        typeof s.protocolConfirmed === 'boolean',
    )
  );
}
function connectionResult(value: unknown): value is NativeConnectionInfo {
  return (
    record(value) &&
    typeof value.serverVersion === 'string' &&
    strings(value.databases) &&
    value.connector === 'rust' &&
    (value.elapsedMs === undefined ||
      (typeof value.elapsedMs === 'number' &&
        Number.isSafeInteger(value.elapsedMs) &&
        value.elapsedMs >= 0))
  );
}
function diagnosticResult(value: unknown): value is NativeDiagnostic {
  return (
    record(value) &&
    typeof value.host === 'string' &&
    typeof value.port === 'number' &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535 &&
    typeof value.status === 'string' &&
    [
      'reachable',
      'refused',
      'timeout',
      'unreachable',
      'dnsError',
      'dnsTimeout',
    ].includes(value.status) &&
    typeof value.elapsedMs === 'number' &&
    Number.isSafeInteger(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    strings(value.resolvedAddresses)
  );
}
function schemaResult(value: unknown): value is NativeSchema {
  return (
    record(value) &&
    typeof value.engine === 'string' &&
    ['mysql', 'mongo', 'postgres', 'mssql', 'redis'].includes(value.engine) &&
    typeof value.database === 'string' &&
    typeof value.truncated === 'boolean' &&
    typeof value.elapsedMs === 'number' &&
    Number.isSafeInteger(value.elapsedMs) &&
    value.elapsedMs >= 0 &&
    Array.isArray(value.objects) &&
    value.objects.length <= 200 &&
    value.objects.every(
      (object: unknown) =>
        record(object) &&
        typeof object.schema === 'string' &&
        typeof object.name === 'string' &&
        typeof object.kind === 'string' &&
        ['table', 'view', 'collection'].includes(object.kind) &&
        Array.isArray(object.columns) &&
        object.columns.length <= 2000 &&
        object.columns.every(
          (column: unknown) =>
            record(column) &&
            typeof column.name === 'string' &&
            typeof column.dataType === 'string' &&
            typeof column.nullable === 'boolean' &&
            typeof column.ordinal === 'number' &&
            Number.isSafeInteger(column.ordinal) &&
            column.ordinal >= 1,
        ),
    )
  );
}
@Injectable()
export class NativeConnectorService {
  private readonly binary = this.findBinary();
  private active = 0;
  private discovery?: Promise<NativeDiscovery>;
  private findBinary(): string | undefined {
    const name =
      process.platform === 'win32' ? 'db-connector.exe' : 'db-connector';
    const configured = process.env.DBF_CONNECTOR_BIN;
    // An explicitly selected packaged binary must never fall back to an old development build.
    if (configured !== undefined)
      return path.isAbsolute(configured)
        ? path.normalize(configured)
        : undefined;
    const candidates = [
      path.resolve(
        process.cwd(),
        '../native/db-connector/target/release',
        name,
      ),
      path.resolve(process.cwd(), 'native/db-connector/target/release', name),
    ];
    return candidates.find((p) => existsSync(p));
  }

  discover(): Promise<NativeDiscovery> {
    // Coalesce concurrent scans from multiple panels/windows.
    this.discovery ??= this.run<NativeDiscovery>({
      command: 'discover',
    }).finally(() => {
      this.discovery = undefined;
    });
    return this.discovery;
  }
  test(connection: NativeConnection): Promise<NativeConnectionInfo> {
    return this.run({ command: 'test', connection });
  }
  catalog(connection: NativeConnection): Promise<NativeConnectionInfo> {
    return this.run({ command: 'catalog', connection });
  }
  diagnose(endpoint: NativeEndpoint): Promise<NativeDiagnostic> {
    return this.run({ command: 'diagnose', endpoint });
  }
  inspect(connection: NativeConnection): Promise<NativeSchema> {
    return this.run({ command: 'inspect', connection });
  }
  query(
    connection: NativeConnection,
    sql: string,
    maxRows: number,
    signal?: AbortSignal,
  ): Promise<NativeQueryResult> {
    if (!['mysql', 'postgres', 'mssql'].includes(connection.engine))
      throw new BadRequestException(
        'The SQL editor supports PostgreSQL, MySQL and SQL Server',
      );
    return this.run({ command: 'query', connection, sql, maxRows }, signal);
  }
  private async run<T>(
    request: NativeRequest,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted)
      throw new BadRequestException('SQL execution was stopped');
    if (!this.binary || !existsSync(this.binary))
      throw new ServiceUnavailableException(
        'Rust connector is not built. Run cargo build --release --locked in native/db-connector, then rebuild desktop.',
      );
    if (this.active >= 4)
      throw new ServiceUnavailableException('Connector is busy; retry shortly');
    const input = JSON.stringify(request);
    if (
      Buffer.byteLength(input, 'utf8') >
      (request.command === 'query' ? 262144 : 65536)
    )
      throw new BadRequestException('Connector request is too large');
    this.active++;
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn(this.binary, [], {
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'ignore'],
      });
    } catch {
      this.active--;
      throw new ServiceUnavailableException('Rust connector could not start');
    }
    // Never read or report stderr: native driver errors can contain connection data.
    return new Promise<T>((resolve, reject) => {
      const chunks: string[] = [];
      let outputBytes = 0;
      let ended = false;
      const finish = (error?: Error, value?: T) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.active--;
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => {
        child.kill();
        finish(new BadRequestException('SQL execution was stopped'));
      };
      const timer = setTimeout(
        () => {
          child.kill();
          finish(new ServiceUnavailableException('Rust connector timed out'));
        },
        request.command === 'query' ? 35000 : 20000,
      );
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      child.on('error', () =>
        finish(
          new ServiceUnavailableException('Rust connector could not start'),
        ),
      );
      child.stdin.on('error', () => {
        /* The close/error event reports a failed connector. */
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (ended) return;
        outputBytes += Buffer.byteLength(chunk);
        if (outputBytes <= (request.command === 'query' ? 4 : 1) * 1024 * 1024)
          chunks.push(chunk);
        else {
          child.kill();
          finish(
            new ServiceUnavailableException('Invalid Rust connector response'),
          );
        }
      });
      child.on('close', (code) => {
        if (ended) return;
        if (code !== 0)
          return finish(
            new ServiceUnavailableException(
              'Rust connector exited unexpectedly',
            ),
          );
        try {
          const parsed: unknown = JSON.parse(chunks.join(''));
          if (!record(parsed)) throw new Error('Invalid connector envelope');
          const valid =
            request.command === 'query'
              ? queryResult(parsed.result)
              : request.command === 'discover'
                ? discoveryResult(parsed.result)
                : request.command === 'diagnose'
                  ? diagnosticResult(parsed.result)
                  : request.command === 'inspect'
                    ? schemaResult(parsed.result)
                    : connectionResult(parsed.result);
          if (parsed.ok === true && valid)
            finish(undefined, parsed.result as T);
          else if (parsed.ok === true)
            throw new Error('Invalid connector result');
          else
            finish(
              new BadRequestException(
                typeof parsed.error === 'string'
                  ? parsed.error
                  : 'Native connection failed',
              ),
            );
        } catch {
          finish(
            new ServiceUnavailableException('Invalid Rust connector response'),
          );
        }
      });
      child.stdout.on('error', () => {
        child.kill();
        finish(new ServiceUnavailableException('Rust connector output failed'));
      });
      try {
        child.stdin.end(input);
      } catch {
        child.kill();
        finish(new ServiceUnavailableException('Rust connector input failed'));
      }
    });
  }
}
