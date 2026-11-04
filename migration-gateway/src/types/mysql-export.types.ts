import type { DbfFieldTypeCode } from "./dbf-field.types";
import type { RelationshipKind } from "./dbf-relationship.types";

/**
 * replace: DROP and CREATE every table, then INSERT.
 * append:  CREATE missing tables, INSERT into them (fails on rows that are already there).
 * sync:    CREATE missing tables, then INSERT … ON DUPLICATE KEY UPDATE by primary key — re-running
 *          it while the old system is still in use carries over only new and changed rows.
 */
export type MysqlWriteMode = 'replace' | 'append' | 'sync'

export interface MysqlExportOptions {
    /** Database to create and USE; omitted → the dump targets the current database. */
    readonly database?: string
    readonly includeData: boolean
    readonly foreignKeys: boolean
    readonly writeMode: MysqlWriteMode
    /** sync only: delete MySQL rows whose key is no longer among the DBF's live records. */
    readonly syncDeletes: boolean
    /** Records marked deleted go to a <table>_deleted table instead of being dropped. */
    readonly keepDeleted: boolean
    /** Create the indexes listed in the tables' .CDX files. */
    readonly indexes: boolean
    /** Blank DBF values become NULL instead of '' / 0. */
    readonly emptyStringsAsNull: boolean
    /** The user's edits to the generated plan, keyed by DBF file name. */
    readonly overrides: MysqlPlanOverrides
}

export interface MysqlColumnOverride {
    readonly exclude?: boolean
    readonly name?: string
    /** A MySQL type from the supported grammar (see mysql-types.ts). */
    readonly type?: string
}

export interface MysqlTableOverride {
    readonly exclude?: boolean
    readonly name?: string
    /** DBF field to use as primary key; null = no primary key; absent = chosen automatically. */
    readonly primaryKey?: string | null
    /** Keyed by DBF field name. */
    readonly columns?: Readonly<Record<string, MysqlColumnOverride>>
    /** .CDX tags the user does not want as MySQL indexes. */
    readonly excludedIndexes?: readonly string[]
}

export type MysqlPlanOverrides = Readonly<Record<string, MysqlTableOverride>>

export type MysqlColumnKey = 'PRI' | 'UNI' | null

export interface MysqlColumnPlan {
    readonly dbfField: string
    readonly dbfType: DbfFieldTypeCode
    readonly length: number
    readonly decimals: number
    readonly column: string
    readonly mysqlType: string
    readonly nullable: boolean
    readonly key: MysqlColumnKey
    /** Left out of the MySQL table by the user. */
    readonly excluded: boolean
    readonly typeOverridden: boolean
    /** Why the values are not carried over (memo without .fpt/.dbt, unsupported type…). */
    readonly note?: string
}

/** One .CDX tag and what becomes of it in MySQL. */
export interface MysqlIndexPlan {
    readonly tag: string
    /** FoxPro key expression, e.g. UPPER(NAME)+DTOS(DATE). */
    readonly expression: string
    readonly filter: string | null
    readonly candidate: boolean
    readonly unique: boolean
    /** Index name in MySQL ('' unless created). */
    readonly name: string
    /** MySQL columns, with a prefix length where FoxPro indexed LEFT(field, n). */
    readonly columns: readonly string[]
    /** primary: the tag became the table's primary key. excluded: switched off by the user. */
    readonly status: 'create' | 'primary' | 'skip' | 'excluded'
    /** Why it is skipped, or what differs from FoxPro. */
    readonly note?: string
}

export interface MysqlTablePlan {
    readonly fileName: string
    readonly table: string
    readonly rowCount: number
    /** Records marked deleted in the DBF. */
    readonly deletedRows: number
    /** Table that receives them (keepDeleted), or null. */
    readonly deletedTable: string | null
    /** How sync mode writes this table: row by row on the primary key, or emptied and reloaded. */
    readonly sync: 'upsert' | 'reload'
    readonly indexFile: string | null
    readonly indexes: readonly MysqlIndexPlan[]
    readonly encoding: string
    readonly memoFile: string | null
    /** Left out of the export by the user (or every column was). */
    readonly excluded: boolean
    readonly columns: readonly MysqlColumnPlan[]
    /** DBF fields with no MySQL equivalent; they are left out of the table. */
    readonly skippedFields: readonly string[]
}

export interface MysqlForeignKeyPlan {
    readonly name: string
    readonly childTable: string
    readonly childColumn: string
    readonly parentTable: string
    readonly parentColumn: string
    readonly source: RelationshipKind
    readonly status: 'create' | 'skip'
    readonly reason?: string
}

/** 'null': the value is lost (stored as NULL). 'fail': strict-mode MySQL rejects the row, the import stops. */
export type MysqlQualityEffect = 'null' | 'fail'

/** One kind of problem in one column, found by reading every record before anything is sent to MySQL. */
export interface MysqlQualityIssue {
    readonly fileName: string
    readonly table: string
    readonly dbfField: string
    readonly column: string
    readonly problem: string
    readonly count: number
    /** A few offending values as they are in the DBF. */
    readonly examples: readonly string[]
    readonly effect: MysqlQualityEffect
}

export interface MysqlExportPlan {
    readonly database: string | null
    readonly tables: readonly MysqlTablePlan[]
    readonly foreignKeys: readonly MysqlForeignKeyPlan[]
    readonly quality: readonly MysqlQualityIssue[]
    readonly warnings: readonly string[]
}

export interface MysqlConnectionInput {
    readonly host: string
    readonly port: number
    readonly user: string
    readonly password: string
}

export interface MysqlConnectionInfo {
    readonly serverVersion: string
    readonly databases: readonly string[]
}

/** What a sync did to one table, counted from MySQL's answers. */
export interface MysqlSyncCounts {
    readonly inserted: number
    readonly updated: number
    readonly unchanged: number
    readonly deleted: number
    /** Emptied and loaded again (no primary key, or a *_deleted table). */
    readonly reloaded: boolean
}

export interface MysqlImportResult {
    readonly database: string
    readonly serverVersion: string
    readonly durationMs: number
    readonly writeMode: MysqlWriteMode
    readonly syncDeletes: boolean
    readonly tables: readonly {
        readonly fileName: string
        readonly table: string
        /** 'deleted': the <table>_deleted copy of records marked deleted. */
        readonly role: 'table' | 'deleted'
        readonly expectedRows: number
        readonly importedRows: number
        readonly sync?: MysqlSyncCounts
    }[]
    readonly foreignKeysCreated: number
    readonly indexesCreated: number
    readonly warnings: readonly string[]
}

export interface MysqlImportProgress {
    readonly phase: 'tables' | 'foreign_keys' | 'verifying'
    /** 1-based position of the table being loaded; 0 before the first one. */
    readonly tableIndex: number
    readonly tableCount: number
    readonly table: string | null
    readonly tableRowsDone: number
    readonly tableRows: number
    readonly rowsDone: number
    readonly rowsTotal: number
    readonly foreignKeysDone: number
    readonly foreignKeysTotal: number
    readonly elapsedMs: number
}

export type MysqlImportState = 'running' | 'done' | 'failed' | 'cancelled'

/** A running or finished import; the client polls it for progress. */
export interface MysqlImportStatus {
    readonly jobId: string
    readonly state: MysqlImportState
    readonly database: string
    readonly progress: MysqlImportProgress
    readonly result?: MysqlImportResult
    readonly error?: string
}
