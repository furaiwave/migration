import { isCharacterType, normalizeMysqlType } from './mysql-types';
export interface ExpectedColumn {
  readonly name: string;
  readonly type: string;
  readonly collation: string | null;
}
export interface ExistingColumn {
  readonly type: unknown;
  readonly charset: unknown;
  readonly collation: unknown;
}
const integerBits: Readonly<Record<string, number>> = {
  TINYINT: 8,
  SMALLINT: 16,
  MEDIUMINT: 24,
  INT: 32,
  BIGINT: 64,
};
const textBytes: Readonly<Record<string, number>> = {
  TINYTEXT: 255,
  TEXT: 65535,
  MEDIUMTEXT: 16777215,
  LONGTEXT: 4294967295,
};
const blobBytes: Readonly<Record<string, number>> = {
  TINYBLOB: 255,
  BLOB: 65535,
  MEDIUMBLOB: 16777215,
  LONGBLOB: 4294967295,
};
function canonical(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*\(\s*/g, '(')
    .replace(/\s*,\s*/g, ',')
    .replace(/\s*\)/g, ')')
    .replace(/^INTEGER\b/, 'INT')
    .replace(/^NUMERIC\b/, 'DECIMAL')
    .replace(/^(BOOL|BOOLEAN)$/, 'TINYINT')
    .replace(/^(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)\(\d+\)/, '$1')
    .replace(/ ZEROFILL$/, '')
    .replace(/^DECIMAL\((\d+)\)$/, 'DECIMAL($1,0)');
}
function integer(type: string) {
  const match = /^(TINYINT|SMALLINT|MEDIUMINT|INT|BIGINT)( UNSIGNED)?$/.exec(
    type,
  );
  if (!match) return null;
  const bits = BigInt(integerBits[match[1]]);
  const unsigned = !!match[2];
  return {
    min: unsigned ? 0n : -(1n << (bits - 1n)),
    max: (1n << (unsigned ? bits : bits - 1n)) - 1n,
  };
}
function decimal(type: string) {
  const match = /^DECIMAL\((\d+),(\d+)\)$/.exec(type);
  return match
    ? { precision: Number(match[1]), scale: Number(match[2]) }
    : null;
}
function sized(type: string, base: string) {
  const match = new RegExp('^' + base + '\\((\\d+)\\)$').exec(type);
  return match ? Number(match[1]) : null;
}
function binaryCapacity(type: string) {
  return blobBytes[type] ?? sized(type, 'VARBINARY');
}
/** Capacity is compared without relying on server coercions that could change key identity or round data. */
export function canRepresentMysqlType(
  planned: string,
  existing: string,
): boolean {
  const from = canonical(planned),
    to = canonical(existing);
  if ('error' in normalizeMysqlType(from)) return false;
  if (from === to) return true;
  const a = integer(from),
    b = integer(to);
  if (a && b) return b.min <= a.min && b.max >= a.max;
  const ad = decimal(from),
    bd = decimal(to);
  if (ad && bd)
    return (
      bd.scale >= ad.scale && bd.precision - bd.scale >= ad.precision - ad.scale
    );
  if (a && bd) {
    const max = 10n ** BigInt(bd.precision - bd.scale) - 1n;
    return a.min >= -max && a.max <= max;
  }
  if (ad && b) {
    if (ad.scale !== 0) return false;
    const max = 10n ** BigInt(ad.precision) - 1n;
    return b.min <= -max && b.max >= max;
  }
  const av = sized(from, 'VARCHAR'),
    bv = sized(to, 'VARCHAR');
  if (av !== null && bv !== null) return bv >= av;
  if (av !== null && textBytes[to] !== undefined)
    return textBytes[to] >= av * 4;
  if (textBytes[from] !== undefined && textBytes[to] !== undefined)
    return textBytes[to] >= textBytes[from];
  const ab = binaryCapacity(from),
    bb = binaryCapacity(to);
  if (ab !== null && ab !== undefined && bb !== null && bb !== undefined)
    return bb >= ab;
  const at = /^(DATETIME|TIMESTAMP|TIME)(?:\((\d)\))?$/.exec(from),
    bt = /^(DATETIME|TIMESTAMP|TIME)(?:\((\d)\))?$/.exec(to);
  if (at && bt && at[1] === bt[1])
    return Number(bt[2] ?? 0) >= Number(at[2] ?? 0);
  return from === 'FLOAT' && to === 'DOUBLE';
}
export function mysqlColumnProblem(
  planned: ExpectedColumn,
  existing: ExistingColumn,
): string | null {
  if (
    typeof existing.type !== 'string' ||
    !canRepresentMysqlType(planned.type, existing.type)
  )
    return (
      'destination column type cannot preserve the planned ' +
      planned.type +
      ' values'
    );
  if (isCharacterType(planned.type) && existing.charset !== 'utf8mb4')
    return 'destination character set cannot preserve all planned Unicode values; utf8mb4 is required';
  if (planned.collation && existing.collation !== planned.collation)
    return (
      'destination collation changes key comparisons; ' +
      planned.collation +
      ' is required'
    );
  return null;
}
