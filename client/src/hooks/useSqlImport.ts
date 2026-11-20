import { trackStartedFileImport } from '@/lib/fileImportJobs';
import { apiRequest } from "@/client/client";
import type {
  SqlDialect,
  SqlConnectionInput,
  SqlImportOptions,
} from "@/api/api.types";
import { useApiMutation } from "./useApiMutation";
const test = (input: { dialect: SqlDialect; connection: SqlConnectionInput }) =>
  apiRequest("POST /dbf/native/test-connection", {
    body: { engine: input.dialect, ...input.connection },
  });
const plan = (input: {
  dialect: SqlDialect;
  sessionId: string;
  options: SqlImportOptions;
}) =>
  apiRequest("POST /dbf/session/:id/sql/:dialect/plan", {
    params: { id: input.sessionId, dialect: input.dialect },
    body: input.options,
  });
const start = (input: {
  dialect: SqlDialect;
  sessionId: string;
  options: SqlImportOptions;
  connection: SqlConnectionInput;
}) =>
  apiRequest("POST /dbf/session/:id/sql/:dialect/import", {
    params: { id: input.sessionId, dialect: input.dialect },
    body: { ...input.connection, ...input.options },
  }).then((status) => trackStartedFileImport(input.sessionId, input.dialect, status));
export const useSqlConnectionTest = () => useApiMutation(test);
export const useSqlPlan = () => useApiMutation(plan);
export const useSqlImport = () => useApiMutation(start);
export const fetchSqlImport = (dialect: SqlDialect, jobId: string) =>
  apiRequest("GET /dbf/sql/:dialect/import/:jobId", {
    params: { dialect, jobId },
  });
export const cancelSqlImport = (dialect: SqlDialect, jobId: string) =>
  apiRequest("DELETE /dbf/sql/:dialect/import/:jobId", {
    params: { dialect, jobId },
  });

const catalog = (input: {
  dialect: SqlDialect;
  connection: SqlConnectionInput;
}) =>
  apiRequest("POST /dbf/native/catalog", {
    body: { engine: input.dialect, ...input.connection },
  });
export const useSqlCatalog = () => useApiMutation(catalog);
