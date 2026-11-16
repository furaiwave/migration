import type { MysqlQualityIssue } from './mysql-export.types';
export interface RedisOptions {
  prefix: string;
  writeMode: 'new' | 'update';
  keepDeleted: boolean;
  ttlSeconds: number;
}
export interface RedisPlan {
  prefix: string;
  tables: {
    fileName: string;
    table: string;
    deletedTable: string | null;
    rowCount: number;
    deletedRows: number;
    keyMode: 'primary' | 'record';
    columns: { name: string; kind: string }[];
  }[];
  warnings: string[];
  quality: readonly MysqlQualityIssue[];
}
export interface RedisImportStatus {
  jobId: string;
  database: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  progress: {
    phase: string;
    table: string | null;
    tableIndex: number;
    tableCount: number;
    tableRowsDone: number;
    rowsDone: number;
    rowsTotal: number;
    elapsedMs: number;
  };
  result?: {
    tables: {
      fileName: string;
      table: string;
      expectedRows: number;
      importedRows: number;
      skippedRows: number;
    }[];
    warnings: string[];
    durationMs: number;
  };
  error?: string;
}
