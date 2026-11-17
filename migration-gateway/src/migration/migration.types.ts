export type Engine = 'mysql' | 'mongo' | 'postgres' | 'mssql' | 'redis';
export interface MigrationConnection {
  engine: Engine;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database: string;
  uri?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}
export type ColumnKind =
  | 'text'
  | 'boolean'
  | 'integer'
  | 'decimal'
  | 'float'
  | 'date'
  | 'datetime'
  | 'binary'
  | 'json';
export interface MigrationColumn {
  name: string;
  kind: ColumnKind;
  nullable: boolean;
  precision?: number;
  scale?: number;
  primaryKey?: boolean;
}
export interface MigrationObject {
  id: string;
  schema: string;
  name: string;
  format: 'rows' | 'documents' | 'redis';
  columns: MigrationColumn[];
}
export interface ObjectSelection {
  sourceId: string;
  targetName: string;
}
export interface MigrationPlanRequest {
  source: MigrationConnection;
  target: MigrationConnection;
  objects: ObjectSelection[];
  targetSchema?: string;
  redisPrefix?: string;
}
export interface PlannedObject {
  source: MigrationObject;
  targetName: string;
  targetSchema: string;
  columns: (MigrationColumn & { targetType: string })[];
}
export interface MigrationPlan {
  id: string;
  expiresAt: string;
  sourceEngine: Engine;
  targetEngine: Engine;
  objects: PlannedObject[];
  redisPrefix: string;
  warnings: string[];
}
export interface MigrationStatus {
  id: string;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  phase: 'connecting' | 'copying' | 'committing' | 'finished';
  object?: string;
  read: number;
  written: number;
  skipped: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  warnings: string[];
}
