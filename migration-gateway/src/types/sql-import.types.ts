import type {
  MysqlExportOptions,
  MysqlImportStatus,
  MysqlQualityIssue,
} from './mysql-export.types';
export type SqlDialect = 'postgres' | 'mssql';
export interface SqlConnectionInput {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}
export interface SqlImportOptions extends MysqlExportOptions {
  readonly writeMode: 'replace' | 'append';
}
export interface SqlImportPlan {
  dialect: SqlDialect;
  tables: {
    fileName: string;
    table: string;
    rowCount: number;
    columns: { name: string; type: string; key: string | null }[];
  }[];
  warnings: string[];
  quality: readonly MysqlQualityIssue[];
}
export type SqlImportStatus = MysqlImportStatus;
