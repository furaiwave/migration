import type {
    ParseMultipleResult,
    DbfRelationshipGraph,
    AddManualRelationshipInput,
    MysqlExportOptions,
    MysqlExportPlan,
    MysqlConnectionInput,
    MysqlConnectionInfo,
    MysqlImportResult,
} from "@/api/api.types";

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3000'

export interface ApiRoutes {
    'POST /dbf/parse-multiple': {
        body: FormData
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
        response: MysqlImportResult
    }
    'POST /dbf/mysql/test-connection': {
        body: MysqlConnectionInput
        response: MysqlConnectionInfo
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

export async function apiRequest<R extends ApiRoute>(
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

    const res = await fetch(url, init)

    if(!res.ok){
        let parsed: unknown = null
        try { parsed = await res.json() } catch { /* non-JSON error body */ }
        throw new ApiError(res.status, res.statusText, parsed)
    }
    if(res.status === 204) return undefined as ResponseOf<R>
    // Files (e.g. the .sql dump) come back as a Blob; everything else is JSON.
    const contentType = res.headers.get('content-type') ?? ''
    if(!contentType.includes('application/json')) return (await res.blob()) as ResponseOf<R>
    return (await res.json()) as ResponseOf<R>
}
