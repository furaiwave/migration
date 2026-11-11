import { apiRequest, ApiError } from "@/client/client";
import type {
    MongoConnectionInfo,
    MongoConnectionInput,
    MongoExportPlan,
    MongoImportStatus,
} from "@/api/api.types";
import { useApiMutation } from "./useApiMutation";
import type { MysqlExportInput } from "./useMysqlExport";

// An empty database name means "none"; the server rejects '' as a name.
const requestOptions = (input: MysqlExportInput) => ({ ...input.options, database: input.options.database || undefined })

async function fetchPlan(input: MysqlExportInput): Promise<MongoExportPlan> {
    return apiRequest('POST /dbf/session/:id/mongo/plan', { params: { id: input.sessionId }, body: requestOptions(input) })
}

/** Downloads the mongosh script and hands it to the browser as a file; resolves with the file name. */
async function downloadScript(input: MysqlExportInput): Promise<string> {
    const blob = await apiRequest('POST /dbf/session/:id/mongo/export', { params: { id: input.sessionId }, body: requestOptions(input) })
    const fileName = `${input.options.database || 'dbf_export'}.js`
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return fileName
}

export function useMongoPlan() {
    return useApiMutation<MysqlExportInput, MongoExportPlan, ApiError>(fetchPlan)
}

export function useMongoScript() {
    return useApiMutation<MysqlExportInput, string, ApiError>(downloadScript)
}

export interface MongoImportInput extends MysqlExportInput {
    readonly connection: MongoConnectionInput
}

async function testConnection(connection: MongoConnectionInput): Promise<MongoConnectionInfo> {
    return apiRequest('POST /dbf/mongo/test-connection', { body: connection })
}

/** Starts the import; it runs on the server and is followed with fetchMongoImportStatus. */
async function importIntoMongo(input: MongoImportInput): Promise<MongoImportStatus> {
    return apiRequest('POST /dbf/session/:id/mongo/import', {
        params: { id: input.sessionId },
        body: { ...requestOptions(input), ...input.connection },
    })
}

export function useMongoTestConnection() {
    return useApiMutation<MongoConnectionInput, MongoConnectionInfo, ApiError>(testConnection)
}

export function useMongoImport() {
    return useApiMutation<MongoImportInput, MongoImportStatus, ApiError>(importIntoMongo)
}

export function fetchMongoImportStatus(jobId: string): Promise<MongoImportStatus> {
    return apiRequest('GET /dbf/mongo/import/:jobId', { params: { jobId } })
}

export function cancelMongoImport(jobId: string): Promise<MongoImportStatus> {
    return apiRequest('DELETE /dbf/mongo/import/:jobId', { params: { jobId } })
}
