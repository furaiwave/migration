import type { DbfFieldTypeCode } from "./dbf-field.types";
import type { RelationshipKind } from "./dbf-relationship.types";

export interface MysqlExportOptions {
    /** Database to create and USE; omitted → the dump targets the current database. */
    readonly database?: string
    /** TextDecoder label for text fields, or 'auto' to use each file's code page mark. */
    readonly encoding: string
    readonly includeData: boolean
    readonly foreignKeys: boolean
    readonly dropExisting: boolean
    /** Blank DBF values become NULL instead of '' / 0. */
    readonly emptyStringsAsNull: boolean
}

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
    /** Why the values are not carried over (memo without .fpt/.dbt, unsupported type…). */
    readonly note?: string
}

export interface MysqlTablePlan {
    readonly fileName: string
    readonly table: string
    readonly rowCount: number
    readonly encoding: string
    readonly memoFile: string | null
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

export interface MysqlExportPlan {
    readonly database: string | null
    readonly tables: readonly MysqlTablePlan[]
    readonly foreignKeys: readonly MysqlForeignKeyPlan[]
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

export interface MysqlImportResult {
    readonly database: string
    readonly serverVersion: string
    readonly durationMs: number
    readonly tables: readonly {
        readonly fileName: string
        readonly table: string
        readonly expectedRows: number
        readonly importedRows: number
    }[]
    readonly foreignKeysCreated: number
    readonly warnings: readonly string[]
}
