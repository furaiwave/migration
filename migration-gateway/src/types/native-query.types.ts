export interface NativeQueryResult {
  connector: 'rust';
  elapsedMs: number;
  truncated: boolean;
  error: {
    message: string;
    code: string | null;
    position: number | null;
  } | null;
  sets: {
    columns: { name: string; dataType: string }[];
    rows: (string | null)[][];
    affectedRows: string | null;
    rowCount: number;
    truncated: boolean;
    clipped: boolean;
  }[];
}
export function queryResult(value: unknown): value is NativeQueryResult {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const count = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (
    !record(value) ||
    value.connector !== 'rust' ||
    !count(value.elapsedMs) ||
    typeof value.truncated !== 'boolean' ||
    !Array.isArray(value.sets) ||
    value.sets.length > 16
  )
    return false;
  if (
    value.error !== null &&
    (!record(value.error) ||
      typeof value.error.message !== 'string' ||
      value.error.message.length > 512 ||
      (value.error.code !== null &&
        (typeof value.error.code !== 'string' ||
          !/^[A-Za-z0-9]{1,16}$/.test(value.error.code))) ||
      (value.error.position !== null && !count(value.error.position)))
  )
    return false;
  return value.sets.every(
    (set: unknown) =>
      record(set) &&
      Array.isArray(set.columns) &&
      set.columns.length <= 512 &&
      set.columns.every(
        (column: unknown) =>
          record(column) &&
          typeof column.name === 'string' &&
          column.name.length <= 256 &&
          typeof column.dataType === 'string' &&
          column.dataType.length <= 128,
      ) &&
      Array.isArray(set.rows) &&
      set.rows.length <= 5000 &&
      set.rows.every(
        (row: unknown) =>
          Array.isArray(row) &&
          row.length === (set.columns as unknown[]).length &&
          row.every(
            (v: unknown) =>
              v === null || (typeof v === 'string' && v.length <= 16384),
          ),
      ) &&
      count(set.rowCount) &&
      typeof set.truncated === 'boolean' &&
      typeof set.clipped === 'boolean' &&
      (set.affectedRows === null ||
        (typeof set.affectedRows === 'string' &&
          /^\d{1,20}$/.test(set.affectedRows))),
  );
}
