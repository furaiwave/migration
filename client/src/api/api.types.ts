declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type SessionId = Brand<string, 'SessionId'>
export type FileName = Brand<string, 'FileName'>
export const asSessionId = (s: string): SessionId => s as SessionId
export const asFileName = (s: string): FileName => s as FileName

/** '0' is Visual FoxPro's hidden _NullFlags field; '@' and 'O' are dBASE 7 Timestamp and Double. */
export type DbfFieldTypeCode =
    | 'C' | 'N' | 'F' | 'D' | 'T' | 'L' | 'M'
    | 'B' | 'G' | 'P' | 'Y' | 'I' | 'V' | 'Q' | '+'
    | '0' | '@' | 'O'

export const FIELD_TYPE_LABELS = {
    C: 'Символьний', N: 'Числовий', F: 'Дробовий (Float)', D: 'Дата',
    T: 'Дата й час', L: 'Логічний', M: 'Memo', B: 'Double',
    G: 'General (OLE)', P: 'Picture', Y: 'Грошовий', I: 'Цілий',
    V: 'Varchar', Q: 'Varbinary', '+': 'Автоінкремент',
    '0': 'Прапорці NULL', '@': 'Мітка часу', O: 'Double',
} as const satisfies Record<DbfFieldTypeCode, string>

export type FieldCategory = 'text' | 'number' | 'temporal' | 'boolean' | 'blob'

export const fieldCategory = (t: DbfFieldTypeCode): FieldCategory => {
    switch(t){
        case 'C': case 'V': return 'text';
        case 'N': case 'F': case 'B': case 'Y': case 'I': case '+': case 'O': return 'number'
        case 'D': case 'T': case '@': return 'temporal'
        case 'L': return 'boolean'
        case 'M': case 'G': case 'P': case 'Q': case '0': return 'blob'
        default: return 'text'
    }
}

export interface DbfFieldDescriptor {
    readonly name: string
    readonly type: DbfFieldTypeCode
    readonly length: number
    readonly decimalCount: number
    readonly offset: number
    /** Visual FoxPro: the field may hold NULL. */
    readonly nullable?: boolean
    /** Visual FoxPro system field (_NullFlags): bookkeeping, not data. */
    readonly system?: boolean
}

export interface DbfTableFlags {
    readonly hasStructuralCdx: boolean
    readonly hasMemoField: boolean
    readonly isDatabase: boolean
}

export interface DbfLastUpdate {
    readonly year: number
    readonly month: number
    readonly day: number
}

export interface DbfHeader {
    readonly typeByte: number
    readonly typeName: string
    readonly hasMemo: boolean
    readonly lastUpdate: DbfLastUpdate
    readonly recordCount: number
    readonly firstRecordOffset: number
    readonly recordLength: number
    readonly tableFlags: DbfTableFlags
    readonly codePage: number
    readonly fields: readonly DbfFieldDescriptor[]
}

export interface DbfFilePreview {
    readonly fileName: string
    readonly header: DbfHeader
    readonly fieldsNames: string[]
    /** Values as text; null where Visual FoxPro stored NULL. */
    readonly preview: ReadonlyArray<Readonly<Record<string, string | null>>>
    readonly totalRecords: number
    readonly encoding: string
    /** From the code page mark, guessed from the text, or picked by the user. */
    readonly encodingSource: EncodingSource
    /** Uploaded .fpt/.dbt that holds this table's memo contents. */
    readonly memoFile: string | null
    /** Uploaded .cdx with the table's indexes. */
    readonly index: DbfIndexInfo | null
}

export interface CdxTag {
    readonly name: string
    readonly expression: string
    readonly filter: string | null
    readonly unique: boolean
    readonly candidate: boolean
    readonly descending: boolean
}

export interface DbfIndexInfo {
    readonly fileName: string
    readonly tags: readonly CdxTag[]
    readonly error: string | null
}

export type EncodingSource = 'codepage' | 'detected' | 'manual'

export type RelationshipConfidence = 'certain' | 'high' | 'medium' | 'low'

export interface AutoNameRelationship {
    readonly kind: 'auto_name'
    readonly confidence: RelationshipConfidence
    readonly sourceFile: FileName
    readonly sourceField: string
    readonly targetFile: FileName
    readonly targetField: string
    readonly matchedOn: 'exact_name' | 'normalized_name'
}

export interface AutoFkRelationship {
    readonly kind: 'auto_fk'
    readonly confidence: RelationshipConfidence
    readonly sourceFile: FileName
    readonly sourceField: string
    readonly targetFile: FileName
    readonly targetField: string
    readonly inferredFrom: string
}

export interface ManualRelationship {
    readonly kind: 'manual'
    readonly sourceFile: FileName
    readonly sourceField: string
    readonly targetFile: FileName
    readonly targetField: string
    readonly label?: string
}

export type DbfRelationship = AutoNameRelationship | AutoFkRelationship | ManualRelationship

export type RelationshipKind = DbfRelationship['kind']

export type RelationshipOf<K extends RelationshipKind> = Extract<DbfRelationship, { kind: K }>

/** A relationship as the graph reports it: with its id and whether the user switched it off. */
export type GraphRelationship = DbfRelationship & {
    readonly id: string
    /** Disabled links stay listed but are left out of the MySQL export. */
    readonly disabled: boolean
}

export interface DbfRelationshipGraph {
    readonly relationships: readonly GraphRelationship[]
    readonly stats: {
        readonly autoName: number
        readonly autoFk: number
        readonly manual: number
        readonly total: number
        readonly disabled: number
    }
}

export interface ParseMultipleResult {
    readonly sessionId: string
    readonly files: readonly DbfFilePreview[]
    readonly graph: DbfRelationshipGraph
}

export interface AddManualRelationshipInput {
    readonly sessionId: string
    readonly sourceFile: string
    readonly sourceField: string
    readonly targetFile: string
    readonly targetField: string
    readonly label?: string
}

/** replace: drop and create; append: add rows to existing tables; sync: insert new, update changed rows by primary key. */
export type MysqlWriteMode = 'replace' | 'append' | 'sync'

export interface MysqlExportOptions {
    /** Database to create and USE; empty → the dump targets the current database. */
    readonly database?: string
    readonly includeData: boolean
    readonly foreignKeys: boolean
    readonly writeMode: MysqlWriteMode
    /** sync only: delete MySQL rows that are no longer live in the DBF. */
    readonly syncDeletes: boolean
    /** Records marked deleted go to <table>_deleted. */
    readonly keepDeleted: boolean
    /** Create the indexes from the .CDX files. */
    readonly indexes: boolean
    readonly emptyStringsAsNull: boolean
    /** The user's edits to the generated plan, keyed by DBF file name. */
    readonly overrides: MysqlPlanOverrides
}

export interface MysqlColumnOverride {
    readonly exclude?: boolean
    readonly name?: string
    readonly type?: string
}

export interface MysqlTableOverride {
    readonly exclude?: boolean
    readonly name?: string
    /** DBF field to use as primary key; null = no primary key; absent = chosen automatically. */
    readonly primaryKey?: string | null
    /** Keyed by DBF field name. */
    readonly columns?: Readonly<Record<string, MysqlColumnOverride>>
    /** .CDX tags not to create as MySQL indexes. */
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
    readonly excluded: boolean
    readonly typeOverridden: boolean
    readonly note?: string
}

export interface MysqlIndexPlan {
    readonly tag: string
    readonly expression: string
    readonly filter: string | null
    readonly candidate: boolean
    readonly unique: boolean
    readonly name: string
    readonly columns: readonly string[]
    readonly status: 'create' | 'primary' | 'skip' | 'excluded'
    readonly note?: string
}

export interface MysqlTablePlan {
    readonly fileName: string
    readonly table: string
    readonly rowCount: number
    readonly deletedRows: number
    readonly deletedTable: string | null
    readonly sync: 'upsert' | 'reload'
    readonly indexFile: string | null
    readonly indexes: readonly MysqlIndexPlan[]
    readonly encoding: string
    readonly memoFile: string | null
    readonly excluded: boolean
    readonly columns: readonly MysqlColumnPlan[]
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

export interface MysqlQualityIssue {
    readonly fileName: string
    readonly table: string
    readonly dbfField: string
    readonly column: string
    readonly problem: string
    readonly count: number
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

export interface MysqlSyncCounts {
    readonly inserted: number
    readonly updated: number
    readonly unchanged: number
    readonly deleted: number
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

/** A running or finished import; polled for progress. */
export interface MysqlImportStatus {
    readonly jobId: string
    readonly state: MysqlImportState
    readonly database: string
    readonly progress: MysqlImportProgress
    readonly result?: MysqlImportResult
    readonly error?: string
}
