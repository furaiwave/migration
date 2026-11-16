import type { RedisOptions, RedisPlan, RedisImportStatus } from '@/api/api.types';
import { readApiBody } from '@/lib/responseBody';
import type { NativeSchema } from '@/api/api.types';
import type { NativeDiagnostic } from '@/api/api.types';
import type { NativeServer, DatabaseEngine } from '@/lib/nativeTarget';
import type { SqlConnectionInput, SqlImportOptions, SqlImportPlan } from '@/api/api.types';
import { logActivity, observeResult } from '@/lib/activityLog';
import { LocalizedError } from '@/i18n';
import type {
    ParseMultipleResult,
    DbfRelationshipGraph,
    AddManualRelationshipInput,
    MysqlExportOptions,
    MysqlExportPlan,
    MysqlConnectionInput,
    MysqlConnectionInfo,
    MysqlImportStatus,
    DbfFilePreview,
    MongoExportPlan,
    MongoConnectionInput,
    MongoConnectionInfo,
    MongoImportStatus,
} from "@/api/api.types";

// VITE_API_BASE=/ serves the API from the same address in desktop and cloud builds.
const API_BASE = (import.meta.env.VITE_API_BASE?.trim() || 'http://127.0.0.1:3000').replace(/\/+$/, '')

/** Cloud help differs from the packaged desktop application. */
export const CLOUD_APP = import.meta.env.VITE_DEPLOYMENT === 'cloud'
export const BUNDLED_APP = API_BASE === '' && !CLOUD_APP

export interface ApiRoutes {
    'POST /dbf/session/:id/redis/plan': { body: RedisOptions; response: RedisPlan }
    'POST /dbf/session/:id/redis/import': { body: RedisOptions & { uri: string }; response: RedisImportStatus }
    'GET /dbf/redis/import/:jobId': { body: never; response: RedisImportStatus }
    'DELETE /dbf/redis/import/:jobId': { body: never; response: RedisImportStatus }
    'POST /dbf/native/inspect': { body: ApiRoutes['POST /dbf/native/test-connection']['body']; response: NativeSchema }

    'POST /dbf/native/catalog': { body: ApiRoutes['POST /dbf/native/test-connection']['body']; response: ApiRoutes['POST /dbf/native/test-connection']['response'] }
    'POST /dbf/native/diagnose': { body: {host:string;port:number}; response: NativeDiagnostic }

    'GET /dbf/native/servers': { body: never; response: { servers: NativeServer[]; warnings: string[] } }
    'POST /dbf/native/test-connection': { body: { engine: DatabaseEngine; host?: string; port?: number; user?: string; password?: string; database?: string; encrypt?: boolean; trustServerCertificate?: boolean; uri?: string }; response: MysqlConnectionInfo & { connector: 'rust'; elapsedMs?: number } }

    'POST /dbf/sql/:dialect/test-connection': { body: SqlConnectionInput; response: MysqlConnectionInfo }
    'POST /dbf/session/:id/sql/:dialect/plan': { body: SqlImportOptions; response: SqlImportPlan }
    'POST /dbf/session/:id/sql/:dialect/import': { body: SqlConnectionInput & SqlImportOptions; response: MysqlImportStatus }
    'GET /dbf/sql/:dialect/import/:jobId': { body: never; response: MysqlImportStatus }
    'DELETE /dbf/sql/:dialect/import/:jobId': { body: never; response: MysqlImportStatus }

    'POST /dbf/parse-multiple': {
        body: FormData
        response: ParseMultipleResult
    }
    'GET /dbf/session/:id': {
        body: never
        response: ParseMultipleResult
    }
    'GET /dbf/session/:id/graph': {
        body: never
        response: DbfRelationshipGraph
    }
    'POST /dbf/session/relationship': {
        body: AddManualRelationshipInput
        response: DbfRelationshipGraph
    }
    'POST /dbf/session/:id/mysql/plan': {
        body: MysqlExportOptions
        response: MysqlExportPlan
    }
    'POST /dbf/session/:id/mysql/export': {
        body: MysqlExportOptions
        response: Blob
    }
    'POST /dbf/session/:id/mysql/import': {
        body: MysqlExportOptions & MysqlConnectionInput
        response: MysqlImportStatus
    }
    'GET /dbf/mysql/import/:jobId': {
        body: never
        response: MysqlImportStatus
    }
    'DELETE /dbf/mysql/import/:jobId': {
        body: never
        response: MysqlImportStatus
    }
    'PATCH /dbf/session/:id/file/:fileName/encoding': {
        /** null = back to the code page mark / detection. */
        body: { readonly encoding: string | null }
        response: { readonly file: DbfFilePreview; readonly graph: DbfRelationshipGraph }
    }
    'POST /dbf/mysql/test-connection': {
        body: MysqlConnectionInput
        response: MysqlConnectionInfo
    }
    'PATCH /dbf/session/:id/relationship/:relId': {
        body: { readonly disabled: boolean }
        response: DbfRelationshipGraph
    }
    'DELETE /dbf/session/:id/relationship/:relId': {
        body: never
        response: DbfRelationshipGraph
    }
    'POST /dbf/session/:id/mongo/plan': {
        body: MysqlExportOptions
        response: MongoExportPlan
    }
    'POST /dbf/session/:id/mongo/export': {
        body: MysqlExportOptions
        response: Blob
    }
    'POST /dbf/mongo/test-connection': {
        body: MongoConnectionInput
        response: MongoConnectionInfo
    }
    'POST /dbf/session/:id/mongo/import': {
        body: MysqlExportOptions & MongoConnectionInput
        response: MongoImportStatus
    }
    'GET /dbf/mongo/import/:jobId': {
        body: never
        response: MongoImportStatus
    }
    'DELETE /dbf/mongo/import/:jobId': {
        body: never
        response: MongoImportStatus
    }
    'DELETE /dbf/session/:id': {
        body: never
        response: void
    }
}

export type ApiRoute = keyof ApiRoutes
export type ResponseOf<R extends ApiRoute> = ApiRoutes[R]['response']
export type BodyOf<R extends ApiRoute> = ApiRoutes[R]['body']

type Path<R extends ApiRoute> = R extends `${string} ${infer P}` ? P : never

type PathParam<P extends string> = P extends `${string}:${infer Param}/${infer Rest}`
    ? { [K in Param | keyof PathParam<`/${Rest}`>]: string }
    : P extends `${string}:${infer Param}`
      ? { [K in Param]: string }
      : Record<string, never>

export type ParamsOf<R extends ApiRoute> = PathParam<Path<R>>

export class ApiError extends Error {
    constructor(
        readonly status: number,
        readonly statusText: string,
        readonly body: unknown,
    ){
        super(`API ${status} ${statusText}`)
        this.name = 'ApiError'
    }
}

/** fetch failed: connection, browser policy, or a local upload read error. */
export class BackendUnreachableError extends LocalizedError {
    constructor(readonly baseUrl: string, cause: unknown) {
        super("Не вдалося виконати запит до {0}. Причиною може бути з’єднання, блокування браузером або зміна вибраних файлів. Перевірте помилку запиту у F12 → Console та Network.", [baseUrl], { cause })
        this.name = 'BackendUnreachableError'
    }
}

function buildPath<R extends ApiRoute>(route: R, params: ParamsOf<R>): string {
    const path = route.slice(route.indexOf(' ') + 1)
    return path.replace(/:([A-Za-z0-9_]+)/g, (_, key: string) => {
        const value =  (params as Record<string, string>)[key]
        if(value === undefined)  throw new Error(`Missing path param ":${key}" for ${route}`)
        return encodeURIComponent(value)
    })
}

interface RequestArgs<R extends ApiRoute> {
    readonly params?: ParamsOf<R>
    readonly body?: BodyOf<R>
}

async function performRequest<R extends ApiRoute>(
    route: R,
    args: RequestArgs<R> = {}
): Promise<ResponseOf<R>> {
    const method = route.slice(0, route.indexOf(' '))
    const path = buildPath(route, (args.params ?? {}) as ParamsOf<R>)
    const url = `${API_BASE}${path}`
    const isFormData = args.body instanceof FormData
    const init: RequestInit = {
        method,
        headers: isFormData ? undefined: args.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        body: isFormData ? (args.body as FormData): args.body !== undefined ? JSON.stringify(args.body): undefined
    }

    let res: Response
    try {
        res = await fetch(url, init)
    } catch (err) {
        // A rejected fetch does not prove the backend is down (e.g. ERR_UPLOAD_FILE_CHANGED).
        throw new BackendUnreachableError(API_BASE || window.location.origin, err)
    }

    if(!res.ok){
        let parsed: unknown = null
        try { parsed = await res.json() } catch { /* non-JSON error body */ }
        throw new ApiError(res.status, res.statusText, parsed)
    }
    if(res.status === 204) return undefined as ResponseOf<R>
    // Only explicit download routes accept non-JSON. A proxy's HTML page is never API data.
    return (await readApiBody(res, route.endsWith('/export'))) as ResponseOf<R>
}

// Record operation boundaries without logging connection bodies, passwords, or URIs.
export async function apiRequest<R extends ApiRoute>(route: R, args: RequestArgs<R> = {}): Promise<ResponseOf<R>> {
    const polling = route.startsWith('GET ') && route.includes('/import/');
    const tracked = !route.startsWith('GET ') || polling;
    const params = args.params as Record<string, string> | undefined;
    const source = params?.fileName || params?.id || params?.jobId || 'application';
    const type = route.includes('/redis/') ? 'REDIS' : route.includes('/native/') ? 'DB' : (route.includes('/mysql/') || route.includes('/sql/')) ? 'SQL' : route.includes('/mongo/') ? 'JS' : 'DBF';
    if (tracked && !polling) {
        if (args.body instanceof FormData) {
            for (const file of args.body.getAll('files')) if (file instanceof File)
                logActivity(file.name.split('.').pop()?.toUpperCase() || 'FILE', file.name, 'INFO', 'Uploading for parsing');
        } else logActivity(type, source, 'INFO', route);
    }
    try {
        const result = await performRequest(route, args);
        if (tracked) {
            observeResult(route, result, params?.id);
            if (!polling && !(result && typeof result === 'object' && 'jobId' in result)) logActivity(type, source, 'DONE', route);
        }
        return result;
    } catch (error) {
        if (tracked) logActivity(type, source, 'ERROR', route + ': ' + (error instanceof ApiError ? 'HTTP ' + error.status : 'Request failed; see operation details'));
        throw error;
    }
}
