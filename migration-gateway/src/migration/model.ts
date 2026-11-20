import { BadRequestException } from '@nestjs/common';
import { BSON } from 'mongodb';
import type {
  Engine,
  MigrationColumn,
  MigrationObject,
  PlannedObject,
  ServerVersion,
} from './migration.types';

export type Row = Record<string, unknown>;
export class MigrationError extends Error {}
export interface Source {
  version(): Promise<ServerVersion>;
  objects(): Promise<MigrationObject[]>;
  read(object: MigrationObject, signal: AbortSignal): AsyncIterable<Row>;
  close(): Promise<void>;
}
export interface Target {
  version(): Promise<ServerVersion>;
  check(objects: PlannedObject[]): Promise<void>;
  begin(objects: PlannedObject[]): Promise<void>;
  write(object: PlannedObject, row: Row, ordinal: number): Promise<boolean>;
  commit(): Promise<void>;
  rollback(): Promise<boolean>;
  close(): Promise<void>;
  warnings?(): string[];
}
export function identifier(name: string, engine: Engine): string {
  const max = engine === 'mysql' ? 64 : engine === 'postgres' ? 63 : 128;
  if (
    !name ||
    name.includes('\0') ||
    (engine === 'postgres' ? Buffer.byteLength(name, 'utf8') : name.length) >
      max
  )
    throw new BadRequestException('Invalid or too long database identifier');
  return engine === 'mysql'
    ? '`' + name.replace(/`/g, '``') + '`'
    : engine === 'mssql'
      ? '[' + name.replace(/\]/g, ']]') + ']'
      : '"' + name.replace(/"/g, '""') + '"';
}
export function qualified(object: PlannedObject, engine: Engine): string {
  return (
    (object.targetSchema ? identifier(object.targetSchema, engine) + '.' : '') +
    identifier(object.targetName, engine)
  );
}
export function sqlType(column: MigrationColumn, engine: Engine): string {
  switch (column.kind) {
    case 'boolean':
      return engine === 'mysql'
        ? 'boolean'
        : engine === 'postgres'
          ? 'boolean'
          : 'bit';
    case 'integer':
      return column.precision && column.precision > 19
        ? 'decimal(20,0)'
        : 'bigint';
    case 'decimal': {
      if (column.precision === undefined)
        return engine === 'postgres'
          ? 'numeric'
          : engine === 'mysql'
            ? 'longtext'
            : 'nvarchar(max)';
      const sourcePrecision = column.precision;
      const sourceScale = column.scale ?? 0;
      // PostgreSQL permits negative scales and scales larger than precision. Widen
      // those declarations to portable decimal capacity without rounding values.
      const scale = Math.max(0, sourceScale);
      const precision = Math.max(
        sourcePrecision - Math.min(0, sourceScale),
        scale,
      );
      const max = engine === 'mssql' ? 38 : engine === 'mysql' ? 65 : 1000;
      if (
        !Number.isInteger(sourcePrecision) ||
        sourcePrecision < 1 ||
        !Number.isInteger(sourceScale) ||
        (engine !== 'postgres' && precision > max) ||
        (engine === 'mysql' && scale > 30)
      )
        throw new BadRequestException(
          column.name +
            ': decimal precision cannot be represented by the destination',
        );
      // A valid PostgreSQL numeric(1000,-1000) needs more than 1000 digits
      // after widening. Unbounded numeric keeps that capacity on older targets too.
      if (engine === 'postgres' && (precision > max || scale > max))
        return 'numeric';
      return 'decimal(' + precision + ',' + scale + ')';
    }
    case 'float':
      return engine === 'postgres'
        ? 'double precision'
        : engine === 'mysql'
          ? 'double'
          : 'float';
    case 'binary':
      return engine === 'postgres'
        ? 'bytea'
        : engine === 'mysql'
          ? 'longblob'
          : 'varbinary(max)';
    // Dates remain ISO text: this also preserves zero dates, timezone offsets and sub-millisecond digits.
    default:
      return engine === 'postgres'
        ? 'text'
        : engine === 'mysql'
          ? 'longtext'
          : 'nvarchar(max)';
  }
}
export function scalarText(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean'
  )
    return String(value);
  throw new MigrationError('Unsupported scalar source value');
}
export function bsonRow(object: MigrationObject, row: Row): Row {
  if (object.format === 'documents') {
    const document: unknown = BSON.EJSON.parse(scalarText(row.document), {
      relaxed: false,
    });
    if (!document || typeof document !== 'object' || Array.isArray(document))
      throw new MigrationError('Expected a BSON document');
    return document as Row;
  }
  return Object.fromEntries(
    object.columns.map((column) => {
      const value = row[column.name];
      if (value === null || value === undefined) return [column.name, null];
      if (column.kind === 'integer') {
        const text = scalarText(value);
        return [
          column.name,
          BigInt(text) <= 9223372036854775807n &&
          BigInt(text) >= -9223372036854775808n
            ? BSON.Long.fromString(text)
            : BSON.Decimal128.fromString(text),
        ];
      }
      if (column.kind === 'decimal')
        return [column.name, BSON.Decimal128.fromString(scalarText(value))];
      if (column.kind === 'binary')
        return [column.name, new BSON.Binary(value as Buffer)];
      if (column.kind === 'json')
        return [
          column.name,
          typeof value === 'string' ? value : JSON.stringify(value),
        ];
      return [column.name, value];
    }),
  );
}
export const documentColumns: MigrationColumn[] = [
  { name: '_id', kind: 'text', nullable: false },
  { name: 'document', kind: 'text', nullable: false },
];
export const redisColumns: MigrationColumn[] = [
  { name: 'key', kind: 'binary', nullable: false },
  { name: 'type', kind: 'text', nullable: false },
  { name: 'dump', kind: 'binary', nullable: false },
  { name: 'expiresAt', kind: 'integer', nullable: true },
];
