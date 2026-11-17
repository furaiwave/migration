export type EditorEngine = "postgres" | "mysql" | "mssql";
export interface EditorConnection {
  engine: EditorEngine;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}
export interface QueryColumn {
  name: string;
  dataType: string;
}
export interface QuerySet {
  columns: QueryColumn[];
  rows: (string | null)[][];
  affectedRows: string | null;
  rowCount: number;
  truncated: boolean;
  clipped: boolean;
}
export interface QueryReport {
  connector: "rust";
  elapsedMs: number;
  truncated: boolean;
  error: {
    message: string;
    code: string | null;
    position: number | null;
  } | null;
  sets: QuerySet[];
}
