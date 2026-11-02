declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type SessionId = Brand<string, 'SessionId'>
export type FileName = Brand<string, 'FileName'>
export const asSessionId = (s: string): SessionId => s as SessionId
export const asFileName = (s: string): FileName => s as FileName

export type DbfFieldTypeCode = 
    | 'C' | 'N' | 'F' | 'D' | 'T' | 'L' | 'M'
    | 'B' | 'G' | 'P' | 'Y' | 'I' | 'V' | 'Q' | '+'

export const FIELD_TYPE_LABELS = {
    C: 'Character', N: 'Numeric', F: 'Float', D: 'Date',
    T: 'DateTime', L: 'Logical', M: 'Memo', B: 'Double',
    G: 'General', P: 'Picture', Y: 'Currency', I: 'Integer',
    V: 'Varchar', Q: 'Varbinary', '+': 'Autoinc'
} as const satisfies Record<DbfFieldTypeCode, string>

export type FieldCategory = 'text' | 'number' | 'temporal' | 'boolean' | 'blob'

export const fieldCategory = (t: DbfFieldTypeCode): FieldCategory => {
    switch(t){
        case 'C': case 'V': return 'text';
        case 'N': case 'F': case 'B': case 'Y': case 'I': case '+': return 'number'
        case 'D': case 'T': return 'temporal'
        case 'L': return 'boolean'
        case 'M': case 'G': case 'P': case 'Q': return 'blob'
        default: return 'text'
    }
}

export interface DbfFieldDescriptor {
    readonly name: string
    readonly type: DbfFieldTypeCode
    readonly length: number
    readonly decimalCount: number
    readonly offset: number
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
    readonly preview: ReadonlyArray<Readonly<Record<string, string>>>
    readonly totalRecords: number
    readonly encoding: string
    /** Uploaded .fpt/.dbt that holds this table's memo contents. */
    readonly memoFile: string | null
}

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

export interface DbfRelationshipGraph { 
    readonly relationships: readonly DbfRelationship[]
    readonly stats: {
        readonly autoName: number
        readonly autoFk: number
        readonly manual: number
        readonly total: number
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

export interface MysqlExportOptions {
    /** Database to create and USE; empty → the dump targets the current database. */
    readonly database?: string
    /** TextDecoder label, or 'auto' to follow each file's code page mark. */
    readonly encoding: string
    readonly includeData: boolean
    readonly foreignKeys: boolean
    readonly dropExisting: boolean
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
    readonly note?: string
}

export interface MysqlTablePlan {
    readonly fileName: string
    readonly table: string
    readonly rowCount: number
    readonly encoding: string
    readonly memoFile: string | null
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
