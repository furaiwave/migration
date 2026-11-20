import type { Engine, ServerVersion } from './migration.types';
import { MigrationError } from './model';

// Return only numeric version metadata, never arbitrary server response text.
export function serverVersion(engine: Engine, raw: unknown): ServerVersion {
  if (typeof raw !== 'string' || raw.length > 1024)
    throw new MigrationError(
      'Cannot determine server version; version metadata permission is required',
    );
  const maria = engine === 'mysql' && /mariadb/i.test(raw);
  const text = maria ? raw.replace(/^5\.5\.5-/, '') : raw;
  const match = /^(\d{1,4}\.\d{1,4}(?:\.\d{1,5}){0,2})(?=$|[^\d.])/.exec(text);
  if (
    !match ||
    /(?:^|[^a-z])(?:alpha|beta|rc|preview|snapshot|devel|dev|dmr|ctp|milestone|m\d+)(?=$|[^a-z])/i.test(
      text,
    )
  )
    throw new MigrationError(
      'Cannot verify a stable server version for this migration',
    );
  return { family: maria ? 'mariadb' : engine, version: match[1] };
}

export function validateUpgrade(source: ServerVersion, target: ServerVersion) {
  if (source.family !== target.family)
    throw new MigrationError(
      'Version upgrade requires the same database family. Use data transfer for MySQL to MariaDB or other engine changes.',
    );
  const left = source.version.split('.').map(Number);
  const right = target.version.split('.').map(Number);
  let comparison = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    comparison = (right[i] ?? 0) - (left[i] ?? 0);
    if (comparison) break;
  }
  if (comparison <= 0)
    throw new MigrationError(
      'The destination version must be newer than the source version. Use data transfer for equal versions or downgrades.',
    );
  if (
    source.family === 'mongo' &&
    (left[0] < 4 || (left[0] === 4 && left[1] < 2))
  )
    throw new MigrationError(
      'The installed MongoDB driver requires MongoDB 4.2 or newer. Upgrade older servers with MongoDB tools first.',
    );
}
