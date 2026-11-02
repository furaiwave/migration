import { BadRequestException, Injectable, Logger } from '@nestjs/common'
import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise'
import { MysqlExportService } from './mysql-export.service'
import type { DbfSession } from '../types/dbf-session.types'
import type { DbfRelationship } from '../types/dbf-relationship.types'
import type {
    MysqlConnectionInput,
    MysqlConnectionInfo,
    MysqlExportOptions,
    MysqlImportResult,
} from '../types/mysql-export.types'

const CONNECT_TIMEOUT_MS = 10_000

/** Drops comment lines; a chunk with nothing else left must not be sent (MySQL: "Query was empty"). */
function executableSql(chunk: string): string | null {
    const sql = chunk.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trim()
    return sql === '' ? null : sql
}

const STATEMENT_TABLE = /(?:INSERT INTO|CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE|DROP TABLE IF EXISTS) `([^`]+)`/

/** The table a dump chunk works on, for error messages. */
const tableOf = (sql: string): string | null => STATEMENT_TABLE.exec(sql)?.[1] ?? null

/** What the user can do about the common failures. */
function hintFor(code: string | undefined, options: MysqlExportOptions): string | null {
    switch (code) {
        case 'ER_DUP_ENTRY':
            return options.dropExisting
                ? 'The data has duplicate values in a key column.'
                : 'The table already holds these rows — turn on "Drop existing tables" to replace it.'
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

@Injectable()
export class MysqlImportService {
    private readonly logger = new Logger(MysqlImportService.name)

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

    /** Runs the same SQL as the downloadable dump, then counts rows to confirm every record arrived. */
    async importSession(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MysqlExportOptions,
        input: MysqlConnectionInput,
    ): Promise<MysqlImportResult> {
        if (!options.database)
            throw new BadRequestException('Choose a database name to import into')

        const { plan, chunks } = this.exportService.statements(session, relationships, options)
        const startedAt = Date.now()
        const connection = await this.connect(input)
        let currentTable: string | null = null
        const doneTables = new Set<string>()

        try {
            for (const chunk of chunks) {
                const sql = executableSql(chunk)
                if (sql === null) continue
                const table = tableOf(sql)
                if (table && table !== currentTable) {
                    if (currentTable) doneTables.add(currentTable)
                    currentTable = table
                }
                await connection.query(sql)
            }

            const tables: MysqlImportResult['tables'][number][] = []
            for (const t of plan.tables) {
                const [rows] = await connection.query<RowDataPacket[]>(
                    'SELECT COUNT(*) AS n FROM ??.??', [options.database, t.table],
                )
                const importedRows = Number(rows[0]?.n ?? 0)
                tables.push({ fileName: t.fileName, table: t.table, expectedRows: options.includeData ? t.rowCount : 0, importedRows })
            }

            const result: MysqlImportResult = {
                database: options.database,
                serverVersion: await this.serverVersion(connection),
                durationMs: Date.now() - startedAt,
                tables,
                foreignKeysCreated: plan.foreignKeys.filter(fk => fk.status === 'create').length,
                warnings: plan.warnings,
            }
            this.logger.log(`Imported session ${session.id} into ${input.host}:${input.port}/${options.database} in ${result.durationMs} ms`)
            return result
        } catch (err) {
            const hint = hintFor((err as { code?: string }).code, options)
            const where = currentTable ? ` Failed on table "${currentTable}".` : ''
            const kept = doneTables.size > 0 ? ` Tables already loaded stay in "${options.database}": ${[...doneTables].join(', ')}.` : ''
            throw new BadRequestException(`${describeMysqlError(err, input)}.${where}${hint ? ` ${hint}` : ''}${kept}`)
        } finally {
            await connection.end()
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
        })
    }

    private async serverVersion(connection: Connection): Promise<string> {
        const [rows] = await connection.query<RowDataPacket[]>('SELECT VERSION() AS version')
        return String(rows[0]?.version ?? 'unknown')
    }
}
