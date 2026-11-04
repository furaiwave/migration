import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { createConnection, type Connection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise'
import { MysqlExportService, type ExpectedTable, type SqlChunk } from './mysql-export.service'
import type { DbfSession } from '../types/dbf-session.types'
import type { DbfRelationship } from '../types/dbf-relationship.types'
import type {
    MysqlConnectionInput,
    MysqlConnectionInfo,
    MysqlExportOptions,
    MysqlExportPlan,
    MysqlImportProgress,
    MysqlImportResult,
    MysqlImportState,
    MysqlImportStatus,
    MysqlSyncCounts,
} from '../types/mysql-export.types'

const CONNECT_TIMEOUT_MS = 10_000
// Finished jobs stay readable for a while so a reloaded page can still show the outcome.
const JOB_TTL_MS = 60 * 60 * 1000

/** Drops comment lines; a chunk with nothing else left must not be sent (MySQL: "Query was empty"). */
function executableSql(chunk: string): string | null {
    const sql = chunk.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trim()
    return sql === '' ? null : sql
}

/** What the user can do about the common failures. */
function hintFor(code: string | undefined, options: MysqlExportOptions): string | null {
    switch (code) {
        case 'ER_DUP_ENTRY':
            return options.writeMode === 'append'
                ? 'The table already holds these rows — choose "Replace tables" or "Sync" instead of "Append".'
                : 'The data has duplicate values in a key column.'
        case 'ER_DBACCESS_DENIED_ERROR': case 'ER_TABLEACCESS_DENIED_ERROR': case 'ER_SPECIFIC_ACCESS_DENIED_ERROR':
            return 'This MySQL user needs CREATE, DROP, INSERT, ALTER and REFERENCES on the database.'
        case 'ER_NET_PACKET_TOO_LARGE':
            return 'A row is larger than the server allows — raise max_allowed_packet in my.ini.'
        case 'ER_FK_INCOMPATIBLE_COLUMNS': case 'ER_CANNOT_ADD_FOREIGN':
            return 'Turn off "Create foreign keys" to import without them.'
        default:
            return null
    }
}

/** MySQL / socket errors as a sentence for the UI. */
function describeMysqlError(err: unknown, connection: MysqlConnectionInput): string {
    const e = err as { code?: string; message?: string; sqlMessage?: string }
    switch (e.code) {
        case 'ECONNREFUSED':
            return `Cannot connect to ${connection.host}:${connection.port} — is the MySQL server running?`
        case 'ENOTFOUND':
            return `Unknown host: ${connection.host}`
        case 'ETIMEDOUT':
            return `Connection to ${connection.host}:${connection.port} timed out`
        default:
            return `MySQL: ${e.sqlMessage ?? e.message ?? String(err)}${e.code ? ` (${e.code})` : ''}`
    }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/**
 * Splits MySQL's answer to INSERT … ON DUPLICATE KEY UPDATE. Without CLIENT_FOUND_ROWS
 * affectedRows counts 1 per new row, 2 per changed row and 0 per unchanged one, and the info
 * text ("Records: 500  Duplicates: 12  Warnings: 0") counts the changed rows as Duplicates.
 */
function countUpsert(counts: Mutable<MysqlSyncCounts>, rows: number, result: ResultSetHeader): void {
    const affected = result.affectedRows
    const reported = /Duplicates:\s*(\d+)/.exec(result.info ?? '')
    // A single-row INSERT sends no info text; affectedRows alone tells (1 new, 2 changed, 0 same).
    const updated = reported ? Number(reported[1]) : Number(affected === 2)
    const inserted = Math.max(0, affected - 2 * updated)
    counts.inserted += inserted
    counts.updated += updated
    counts.unchanged += Math.max(0, rows - inserted - updated)
}

/** Existing tables an append or sync would write into, checked against the plan before anything runs. */
async function schemaMismatches(
    connection: Connection,
    database: string,
    expected: readonly ExpectedTable[],
    checkKeys: boolean,
): Promise<string[]> {
    const [rows] = await connection.query<RowDataPacket[]>(
        'SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?', [database])
    const existing = new Map<string, { columns: Set<string>; primary: string[] }>()
    for (const r of rows) {
        const name = String(r.t).toLowerCase()
        const entry = existing.get(name) ?? { columns: new Set<string>(), primary: [] }
        entry.columns.add(String(r.c).toLowerCase())
        if (r.k === 'PRI') entry.primary.push(String(r.c).toLowerCase())
        existing.set(name, entry)
    }

    const problems: string[] = []
    for (const t of expected) {
        const found = existing.get(t.table.toLowerCase())
        if (!found) continue // created by this run
        const missing = t.columns.filter(c => !found.columns.has(c.toLowerCase()))
        if (missing.length > 0) problems.push(`${t.table} has no column ${missing.join(', ')}`)
        const planned = t.primaryKey.map(c => c.toLowerCase())
        if (checkKeys && planned.length > 0 && planned.join(',') !== [...found.primary].sort().join(','))
            problems.push(`${t.table}: the primary key in MySQL is (${found.primary.join(', ') || 'none'}), the plan uses (${planned.join(', ')})`)
    }
    return problems
}

interface ImportJob {
    readonly id: string
    readonly database: string
    readonly startedAt: number
    state: MysqlImportState
    progress: Mutable<Omit<MysqlImportProgress, 'elapsedMs'>>
    result?: MysqlImportResult
    error?: string
    cancelRequested: boolean
    finishedAt?: number
}

class ImportCancelled extends Error {}

@Injectable()
export class MysqlImportService {
    private readonly logger = new Logger(MysqlImportService.name)
    private readonly jobs = new Map<string, ImportJob>()

    constructor(private readonly exportService: MysqlExportService) {}

    async testConnection(input: MysqlConnectionInput): Promise<MysqlConnectionInfo> {
        const connection = await this.connect(input)
        try {
            const [versionRows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version')
            const [databaseRows] = await connection.query<RowDataPacket[]>('SHOW DATABASES')
            return {
                serverVersion: String(versionRows[0]?.version ?? 'unknown'),
                databases: databaseRows.map(r => String(Object.values(r)[0])),
            }
        } catch (err) {
            throw new BadRequestException(describeMysqlError(err, input))
        } finally {
            await connection.end()
        }
    }

    /**
     * Checks what can be checked up front (database name, data problems, the connection) and answers
     * right away with a job; the SQL then runs in the background while the client polls the job.
     */
    async startImport(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MysqlExportOptions,
        input: MysqlConnectionInput,
    ): Promise<MysqlImportStatus> {
        if (!options.database)
            throw new BadRequestException('Choose a database name to import into')

        const { plan, chunks, expected } = this.exportService.statements(session, relationships, options)
        // These would make MySQL reject rows halfway through, leaving a half-loaded database behind.
        const blocking = plan.quality.filter(q => q.effect === 'fail')
        if (blocking.length > 0) {
            const list = blocking.slice(0, 3).map(q => `${q.table}.${q.column}: ${q.problem}`).join('; ')
            throw new BadRequestException(
                `${blocking.length} data problem(s) would make MySQL reject the import — fix them in the plan first (${list}${blocking.length > 3 ? '; …' : ''})`)
        }

        const connection = await this.connect(input)
        if (options.writeMode !== 'replace') {
            // Rows go into tables an earlier run made; a different shape would fail halfway through.
            let problems: string[]
            try {
                problems = await schemaMismatches(connection, options.database, expected, options.writeMode === 'sync')
            } catch (err) {
                await connection.end().catch(() => { /* closing anyway */ })
                throw new BadRequestException(describeMysqlError(err, input))
            }
            if (problems.length > 0) {
                await connection.end().catch(() => { /* closing anyway */ })
                throw new BadRequestException(
                    `The tables already in "${options.database}" do not match the plan: ${problems.join('; ')}. ` +
                    'Change the plan to match them (names, primary key), or use "Replace tables".')
            }
        }

        const tables = plan.tables.filter(t => !t.excluded)
        const deletedTables = tables.filter(t => t.deletedTable !== null)
        const job: ImportJob = {
            id: randomUUID(),
            database: options.database,
            startedAt: Date.now(),
            state: 'running',
            cancelRequested: false,
            progress: {
                phase: 'tables',
                tableIndex: 0,
                tableCount: tables.length + deletedTables.length,
                table: null,
                tableRowsDone: 0,
                tableRows: 0,
                rowsDone: 0,
                rowsTotal: options.includeData
                    ? tables.reduce((n, t) => n + t.rowCount, 0) + deletedTables.reduce((n, t) => n + t.deletedRows, 0)
                    : 0,
                foreignKeysDone: 0,
                foreignKeysTotal: plan.foreignKeys.filter(fk => fk.status === 'create').length,
            },
        }
        this.forgetOldJobs()
        this.jobs.set(job.id, job)
        void this.run(job, plan, chunks, connection, options, input, session.id)
        return this.statusOf(job)
    }

    getStatus(jobId: string): MysqlImportStatus {
        const job = this.jobs.get(jobId)
        if (!job) throw new NotFoundException('Import not found — it finished more than an hour ago or the backend restarted')
        return this.statusOf(job)
    }

    /** Stops after the statement in flight; tables loaded so far stay in MySQL. */
    cancel(jobId: string): MysqlImportStatus {
        const job = this.jobs.get(jobId)
        if (!job) throw new NotFoundException('Import not found')
        if (job.state === 'running') job.cancelRequested = true
        return this.statusOf(job)
    }

    private async run(
        job: ImportJob,
        plan: MysqlExportPlan,
        chunks: Iterable<SqlChunk>,
        connection: Connection,
        options: MysqlExportOptions,
        input: MysqlConnectionInput,
        sessionId: string,
    ): Promise<void> {
        const database = job.database
        const tables = plan.tables.filter(t => !t.excluded)
        const rowCounts = new Map(tables.flatMap(t => [
            [t.table, t.rowCount] as const,
            ...(t.deletedTable ? [[t.deletedTable, t.deletedRows] as const] : []),
        ]))
        const doneTables: string[] = []
        const p = job.progress
        const finishTable = () => {
            if (p.table && !doneTables.includes(p.table)) doneTables.push(p.table)
        }
        const sync = options.writeMode === 'sync'
        const syncCounts = new Map<string, Mutable<MysqlSyncCounts>>()
        const countsOf = (table: string) => {
            let c = syncCounts.get(table)
            if (!c) syncCounts.set(table, c = { inserted: 0, updated: 0, unchanged: 0, deleted: 0, reloaded: false })
            return c
        }

        try {
            for (const chunk of chunks) {
                if (job.cancelRequested) throw new ImportCancelled()
                if (chunk.table && chunk.table !== p.table) {
                    finishTable()
                    p.table = chunk.table
                    p.tableIndex++
                    p.tableRowsDone = 0
                    p.tableRows = options.includeData ? rowCounts.get(chunk.table) ?? 0 : 0
                }
                if (chunk.foreignKeys && p.phase !== 'foreign_keys') {
                    finishTable()
                    p.phase = 'foreign_keys'
                }
                const sql = executableSql(chunk.sql)
                if (sql !== null) {
                    const [answer] = await connection.query<ResultSetHeader>(sql)
                    if (sync && chunk.table) {
                        if (chunk.sync === 'upsert') countUpsert(countsOf(chunk.table), chunk.rows ?? 0, answer)
                        else if (chunk.sync === 'delete') countsOf(chunk.table).deleted += answer.affectedRows
                        else if (chunk.sync === 'reload') countsOf(chunk.table).reloaded = true
                        else if (chunk.rows) countsOf(chunk.table).inserted += chunk.rows
                    }
                }
                if (chunk.foreignKeys && sql !== null) p.foreignKeysDone++
                if (chunk.rows) {
                    p.tableRowsDone += chunk.rows
                    p.rowsDone += chunk.rows
                }
            }
            finishTable()

            p.phase = 'verifying'
            const verified: Mutable<MysqlImportResult['tables'][number]>[] = []
            const verify = async (fileName: string, table: string, role: 'table' | 'deleted', expectedRows: number) => {
                const [rows] = await connection.query<RowDataPacket[]>('SELECT COUNT(*) AS n FROM ??.??', [database, table])
                verified.push({
                    fileName,
                    table,
                    role,
                    expectedRows: options.includeData ? expectedRows : 0,
                    importedRows: Number(rows[0]?.n ?? 0),
                    sync: sync ? countsOf(table) : undefined,
                })
            }
            for (const t of tables) {
                await verify(t.fileName, t.table, 'table', t.rowCount)
                if (t.deletedTable) await verify(t.fileName, t.deletedTable, 'deleted', t.deletedRows)
            }

            const result: MysqlImportResult = {
                database,
                serverVersion: await this.serverVersion(connection),
                durationMs: Date.now() - job.startedAt,
                writeMode: options.writeMode,
                syncDeletes: options.syncDeletes,
                tables: verified,
                foreignKeysCreated: plan.foreignKeys.filter(fk => fk.status === 'create').length,
                indexesCreated: tables.reduce((n, t) => n + t.indexes.filter(ix => ix.status === 'create').length, 0),
                warnings: plan.warnings,
            }
            job.result = result
            job.state = 'done'
            this.logger.log(`Imported session ${sessionId} into ${input.host}:${input.port}/${database} (${options.writeMode}) in ${result.durationMs} ms`)
        } catch (err) {
            const partial = p.phase === 'tables' && p.table && !doneTables.includes(p.table) && p.tableRowsDone > 0
                ? ` Table "${p.table}" was left half-loaded (${p.tableRowsDone.toLocaleString('en-US')} of ${p.tableRows.toLocaleString('en-US')} rows).`
                : ''
            const kept = (doneTables.length > 0 ? ` Tables already loaded stay in "${database}": ${doneTables.join(', ')}.` : '') + partial
            if (err instanceof ImportCancelled) {
                job.state = 'cancelled'
                job.error = `Import cancelled.${kept}`
            } else {
                const hint = hintFor((err as { code?: string }).code, options)
                const where = p.phase === 'foreign_keys' ? ' Failed while adding foreign keys.' : p.table ? ` Failed on table "${p.table}".` : ''
                job.state = 'failed'
                job.error = `${describeMysqlError(err, input)}.${where}${hint ? ` ${hint}` : ''}${kept}`
            }
            this.logger.warn(`Import ${job.id} ${job.state}: ${job.error}`)
        } finally {
            job.finishedAt = Date.now()
            await connection.end().catch(() => { /* already closed */ })
        }
    }

    private statusOf(job: ImportJob): MysqlImportStatus {
        return {
            jobId: job.id,
            state: job.state,
            database: job.database,
            progress: { ...job.progress, elapsedMs: (job.finishedAt ?? Date.now()) - job.startedAt },
            result: job.result,
            error: job.error,
        }
    }

    private forgetOldJobs(): void {
        const cutoff = Date.now() - JOB_TTL_MS
        for (const [id, job] of this.jobs) {
            if (job.finishedAt !== undefined && job.finishedAt < cutoff) this.jobs.delete(id)
        }
    }

    private async connect(input: MysqlConnectionInput): Promise<Connection> {
        try {
            return await this.open(input, input.host)
        } catch (err) {
            // Node resolves "localhost" to ::1 first, while many MySQL installs listen on 127.0.0.1 only.
            if (input.host === 'localhost' && (err as { code?: string }).code === 'ECONNREFUSED') {
                try {
                    return await this.open(input, '127.0.0.1')
                } catch { /* report the original error below */ }
            }
            throw new BadRequestException(describeMysqlError(err, input))
        }
    }

    private open(input: MysqlConnectionInput, host: string): Promise<Connection> {
        return createConnection({
            host,
            port: input.port,
            user: input.user,
            password: input.password,
            charset: 'utf8mb4',
            multipleStatements: true,
            connectTimeout: CONNECT_TIMEOUT_MS,
            // Unchanged rows of an upsert then count 0 instead of 1, which is how sync tells them apart.
            flags: ['-FOUND_ROWS'],
        })
    }

    private async serverVersion(connection: Connection): Promise<string> {
        const [rows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version')
        return String(rows[0]?.version ?? 'unknown')
    }
}
