import { apiRequest, ApiError } from "@/client/client";
import type {
    MysqlConnectionInfo,
    MysqlConnectionInput,
    MysqlExportOptions,
    MysqlExportPlan,
    MysqlImportStatus,
} from "@/api/api.types";
import { useApiMutation } from "./useApiMutation";

export interface MysqlExportInput {
    readonly sessionId: string
    readonly options: MysqlExportOptions
}

// An empty database name means "none"; the server rejects '' as a name.
const requestOptions = (options: MysqlExportOptions): MysqlExportOptions =>
    ({ ...options, database: options.database || undefined })

async function fetchPlan(input: MysqlExportInput): Promise<MysqlExportPlan> {
    return apiRequest('POST /dbf/session/:id/mysql/plan', { params: { id: input.sessionId }, body: requestOptions(input.options) })
}

/** Downloads the dump and hands it to the browser as a file; resolves with the file name. */
async function downloadDump(input: MysqlExportInput): Promise<string> {
    const blob = await apiRequest('POST /dbf/session/:id/mysql/export', { params: { id: input.sessionId }, body: requestOptions(input.options) })
    const fileName = `${input.options.database || 'dbf_export'}.sql`
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return fileName
}

export function useMysqlPlan() {
    return useApiMutation<MysqlExportInput, MysqlExportPlan, ApiError>(fetchPlan)
}

export function useMysqlDump() {
    return useApiMutation<MysqlExportInput, string, ApiError>(downloadDump)
}

export interface MysqlImportInput extends MysqlExportInput {
    readonly connection: MysqlConnectionInput
}

async function testConnection(connection: MysqlConnectionInput): Promise<MysqlConnectionInfo> {
    return apiRequest('POST /dbf/mysql/test-connection', { body: connection })
}

/** Starts the import; it runs on the server and is followed with fetchImportStatus. */
async function importIntoMysql(input: MysqlImportInput): Promise<MysqlImportStatus> {
    return apiRequest('POST /dbf/session/:id/mysql/import', {
        params: { id: input.sessionId },
        body: { ...requestOptions(input.options), ...input.connection },
    })
}

export function useMysqlTestConnection() {
    return useApiMutation<MysqlConnectionInput, MysqlConnectionInfo, ApiError>(testConnection)
}

export function useMysqlImport() {
    return useApiMutation<MysqlImportInput, MysqlImportStatus, ApiError>(importIntoMysql)
}

export function fetchImportStatus(jobId: string): Promise<MysqlImportStatus> {
    return apiRequest('GET /dbf/mysql/import/:jobId', { params: { jobId } })
}

export function cancelImport(jobId: string): Promise<MysqlImportStatus> {
    return apiRequest('DELETE /dbf/mysql/import/:jobId', { params: { jobId } })
}
