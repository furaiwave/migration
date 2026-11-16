import * as fs from 'fs';
import * as path from 'path';
import type { WebAccess } from './web-access';

export interface WebConfig {
  readonly host: string;
  readonly port: number;
  readonly origin: string;
  readonly clientDir: string;
  readonly sessionDir: string;
  readonly connector: string;
  readonly access: WebAccess;
}
export function webConfig(env: NodeJS.ProcessEnv = process.env): WebConfig {
  const fail = (name: string): never => {
    throw new Error('Invalid or missing web configuration: ' + name);
  };
  let origin: URL;
  try {
    origin = new URL(env.PUBLIC_ORIGIN ?? '');
  } catch {
    return fail('PUBLIC_ORIGIN');
  }
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    origin.hostname.includes('*')
  )
    return fail('PUBLIC_ORIGIN');
  const port = Number(env.PORT ?? '3000');
  if (
    !/^\d+$/.test(env.PORT ?? '3000') ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  )
    return fail('PORT');
  const user = env.APP_USER ?? '';
  if (!user || user.length > 256 || /[:\x00-\x1f\x7f]/.test(user))
    return fail('APP_USER');
  if (env.APP_PASSWORD !== undefined && env.APP_PASSWORD_FILE !== undefined)
    return fail('use APP_PASSWORD or APP_PASSWORD_FILE');
  let password = env.APP_PASSWORD ?? '';
  if (env.APP_PASSWORD_FILE !== undefined) {
    try {
      password = fs
        .readFileSync(env.APP_PASSWORD_FILE, 'utf8')
        .replace(/\r?\n$/, '');
    } catch {
      return fail('APP_PASSWORD_FILE');
    }
  }
  if (
    Buffer.byteLength(password) < 16 ||
    Buffer.byteLength(password) > 8192 ||
    /[\x00-\x1f\x7f]/.test(password)
  )
    return fail('APP_PASSWORD (16–8192 UTF-8 bytes, no control characters)');
  const absolute = (name: string): string => {
    const value = env[name];
    if (!value || !path.isAbsolute(value))
      return fail(name + ' (absolute path required)');
    return path.normalize(value);
  };
  return {
    host: env.HOST ?? '0.0.0.0',
    port,
    origin: origin.origin,
    clientDir: absolute('DBF_CLIENT_DIR'),
    sessionDir: absolute('DBF_SESSION_DIR'),
    connector: absolute('DBF_CONNECTOR_BIN'),
    access: { user, password },
  };
}

export function checkWebFiles(config: WebConfig): void {
  fs.accessSync(path.join(config.clientDir, 'index.html'), fs.constants.R_OK);
  fs.accessSync(config.connector, fs.constants.R_OK | fs.constants.X_OK);
  fs.mkdirSync(config.sessionDir, { recursive: true });
  fs.accessSync(config.sessionDir, fs.constants.W_OK);
}
