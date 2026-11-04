import { Injectable, NotFoundException } from '@nestjs/common'
import { Readable } from 'stream'
import { binaryFieldText, fieldBytes, isDbase7, iterateRecords, recordNumberOf, type RecordSet } from '../addon'
import { createDecoder, type TextDecoderLike } from '../codepages'
import { transliterate } from '../translit'
import { decodeMemoText, memoBlockOf, openMemo, VFP_TYPE_BYTES, type MemoReader } from '../memo'
import { indexParts, type CdxTag } from '../cdx'
import { isCharacterType, isKeyableType, typeProblem, type ValueKind } from './mysql-types'
import type { DbfFieldDescriptor } from '../types/dbf-field.types'
import type { DbfParseResult } from '../types/dbf-result.types'
import type { DbfSession } from '../types/dbf-session.types'
import type { DbfRelationship, FileName, RelationshipKind } from '../types/dbf-relationship.types'
import type {
    MysqlColumnKey,
    MysqlExportOptions,
    MysqlExportPlan,
    MysqlForeignKeyPlan,
    MysqlIndexPlan,
    MysqlQualityEffect,
    MysqlQualityIssue,
} from '../types/mysql-export.types'

const NULL_FLAGS_FIELD_TYPE = '0' // Visual FoxPro system field (_NullFlags)
const INSERT_BATCH_ROWS = 500
// Keeps each INSERT well under MySQL's default max_allowed_packet (64 MB) even with large memos.
const INSERT_BATCH_CHARS = 4 * 1024 * 1024
const MAX_IDENTIFIER = 64
const TABLE_COLLATION = 'utf8mb4_unicode_ci'
// Key columns compare byte-for-byte, the same way uniqueness is checked here.
const KEY_COLLATION = 'utf8mb4_bin'
const QUALITY_EXAMPLES = 3
const EXAMPLE_CHARS = 60
// InnoDB limits (DYNAMIC row format): key size in bytes, columns per index, secondary indexes per table.
const MAX_KEY_BYTES = 3072
const MAX_KEY_PARTS = 16
const MAX_INDEXES = 64
/** First column of a <table>_deleted table: the record's position in the DBF (RECNO()). */
const RECNO_COLUMN = '_dbf_recno'
const SYNC_KEYS_TABLE = '_dbf_sync_keys'

/** Columns may only reference each other within the same family. */
type KeyFamily = 'numeric' | 'text' | 'date' | null

interface FieldMapping {
    readonly kind: ValueKind
    readonly mysqlType: string
    readonly family: KeyFamily
}

function mapField(field: DbfFieldDescriptor, typeByte: number): FieldMapping | null {
    const { type, length, decimalCount } = field
    const isVfp = VFP_TYPE_BYTES.has(typeByte)
    switch (type) {
        case 'C': case 'V':
            return { kind: 'text', mysqlType: `VARCHAR(${Math.max(1, length)})`, family: 'text' }
        case 'N': {
            if (decimalCount > 0) {
                const scale = Math.min(decimalCount, 30)
                const precision = Math.min(65, Math.max(length, scale + 1))
                return { kind: 'number', mysqlType: `DECIMAL(${precision},${scale})`, family: 'numeric' }
            }
            // N(len) holds at most len characters including the sign, so INT/BIGINT never overflow.
            if (length <= 9) return { kind: 'number', mysqlType: 'INT', family: 'numeric' }
            if (length <= 18) return { kind: 'number', mysqlType: 'BIGINT', family: 'numeric' }
            return { kind: 'number', mysqlType: `DECIMAL(${Math.min(65, length)},0)`, family: 'numeric' }
        }
        case 'F':
            return { kind: 'number', mysqlType: 'DOUBLE', family: 'numeric' }
        case 'D':
            return { kind: 'date', mysqlType: 'DATE', family: 'date' }
        case 'T':
            return length === 8 ? { kind: 'datetime', mysqlType: 'DATETIME', family: 'date' } : null
        case 'L':
            return { kind: 'bool', mysqlType: 'TINYINT(1)', family: null }
        case 'I': case '+':
            return length === 4 ? { kind: 'int32', mysqlType: 'INT', family: 'numeric' } : null
        case 'Y':
            return length === 8 ? { kind: 'currency', mysqlType: 'DECIMAL(19,4)', family: 'numeric' } : null
        case 'B':
            // Visual FoxPro: 8-byte double. dBASE: block pointer into a binary memo file.
            return isVfp
                ? { kind: 'double', mysqlType: 'DOUBLE', family: 'numeric' }
                : { kind: 'memoBinary', mysqlType: 'LONGBLOB', family: null }
        case 'M':
            return { kind: 'memoText', mysqlType: 'LONGTEXT', family: null }
        case 'G': case 'P':
            return { kind: 'memoBinary', mysqlType: 'LONGBLOB', family: null }
        case 'Q':
            return { kind: 'binary', mysqlType: `VARBINARY(${Math.max(1, length)})`, family: null }
        // dBASE 7 Double and Timestamp
        case 'O':
            return length === 8 && isDbase7(typeByte) ? { kind: 'double', mysqlType: 'DOUBLE', family: 'numeric' } : null
        case '@':
            return length === 8 && isDbase7(typeByte) ? { kind: 'datetime', mysqlType: 'DATETIME', family: 'date' } : null
        default:
            return null
    }
}

// ---------------------------------------------------------------- values

const NUMBER_RE = /^[+-]?(\d+\.?\d*|\.\d+)$/

/** Canonical decimal text, so "007", "7.00" and "+7" compare equal. Garbage like "*****" → null. */
function normalizeNumber(raw: string): string | null {
    if (!NUMBER_RE.test(raw)) return null
    let s = raw.startsWith('+') ? raw.slice(1) : raw
    const negative = s.startsWith('-')
    if (negative) s = s.slice(1)
    const [intPart = '', fracPart = ''] = s.split('.')
    const int = intPart.replace(/^0+(?=\d)/, '') || '0'
    const frac = fracPart.replace(/0+$/, '')
    const body = frac ? `${int}.${frac}` : int
    return negative && body !== '0' ? `-${body}` : body
}

function decodeDate(raw: string): string | null {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw)
    if (!m) return null
    const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])]
    if (year < 1000) return null
    // Rejects impossible dates such as 2023-02-30.
    const probe = new Date(Date.UTC(year, month - 1, day))
    if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
    return `${m[1]}-${m[2]}-${m[3]}`
}

interface ColumnSpec {
    readonly field: DbfFieldDescriptor
    readonly kind: ValueKind
    readonly family: KeyFamily
    readonly column: string
    readonly note?: string
    readonly excluded: boolean
    readonly typeOverridden: boolean
    mysqlType: string
    collation: string | null
    nullable: boolean
    key: MysqlColumnKey
}

interface DecodeContext {
    readonly decoder: TextDecoderLike
    readonly memo: MemoReader | null
    readonly result: DbfParseResult
}

/** The field's bytes, or null where Visual FoxPro stored NULL (see fieldBytes). */
const fieldSlice = (column: ColumnSpec, record: Buffer): Buffer | null => fieldBytes(record, column.field)

/** Field value as unquoted canonical text (hex for binary), or null for SQL NULL. */
function decodeValue(
    column: ColumnSpec,
    record: Buffer,
    { decoder, memo, result }: DecodeContext,
    emptyStringsAsNull: boolean,
): string | null {
    const slice = fieldSlice(column, record)
    if (slice === null) return null

    switch (column.kind) {
        case 'text': {
            const s = decoder.decode(slice).replace(/\0+$/, '').trimEnd()
            return s === '' && emptyStringsAsNull ? null : s
        }
        case 'number':
            return normalizeNumber(slice.toString('latin1').trim())
        case 'date':
            return decodeDate(slice.toString('latin1').trim())
        case 'bool': {
            const c = String.fromCharCode(slice[0] ?? 0x20)
            if ('TtYy'.includes(c)) return '1'
            if ('FfNn'.includes(c)) return '0'
            return null
        }
        // Binary numbers and dates decode exactly as the preview shows them.
        case 'datetime': case 'int32': case 'double': case 'currency':
            return binaryFieldText(column.field.type, slice, result.header.typeByte) || null
        case 'binary':
            return slice.every(b => b === 0) ? null : slice.toString('hex')
        case 'memoText': {
            const data = memo?.read(memoBlockOf(slice))
            if (!data) return null
            const s = decodeMemoText(decoder, data)
            return s === '' && emptyStringsAsNull ? null : s
        }
        case 'memoBinary': {
            const data = memo?.read(memoBlockOf(slice))
            return data && data.length > 0 ? data.toString('hex') : null
        }
    }
}

/**
 * For a value that decoded to NULL: why data was lost, or null when the DBF cell was simply blank.
 * This is what separates "empty in the old system" from "garbage the old system let in".
 */
function lossReason(column: ColumnSpec, record: Buffer, memo: MemoReader | null): string | null {
    const slice = fieldSlice(column, record)
    // NULL in Visual FoxPro stays NULL; nothing is lost.
    if (slice === null) return null
    switch (column.kind) {
        case 'number':
            return slice.toString('latin1').trim() === '' ? null : 'not a number — becomes NULL'
        case 'date': {
            const raw = slice.toString('latin1').trim()
            return raw === '' || /^0+$/.test(raw) ? null : 'impossible date — becomes NULL'
        }
        case 'datetime':
            return slice.every(b => b === 0 || b === 0x20) ? null : 'impossible date/time — becomes NULL'
        case 'bool':
            return ' ?\0'.includes(String.fromCharCode(slice[0] ?? 0x20)) ? null : 'not T/F/Y/N — becomes NULL'
        case 'double':
            return 'not a finite number — becomes NULL'
        case 'memoText': case 'memoBinary': {
            const block = memoBlockOf(slice)
            if (block === 0) return null
            if (!memo) return 'memo file (.fpt/.dbt) not uploaded — becomes NULL'
            return memo.read(block) ? null : 'memo block missing from the memo file — becomes NULL'
        }
        default:
            return null
    }
}

/** The cell as it sits in the DBF, for showing next to a problem. */
function rawDisplay(column: ColumnSpec, record: Buffer, decoder: TextDecoderLike): string {
    const slice = fieldSlice(column, record)
    if (slice === null) return 'NULL'
    switch (column.kind) {
        case 'memoText': case 'memoBinary':
            return `memo block ${memoBlockOf(slice)}`
        case 'binary': case 'datetime': case 'int32': case 'double': case 'currency':
            return `0x${slice.toString('hex')}`
        case 'text':
            return decoder.decode(slice).replace(/\0+$/, '').trimEnd()
        default:
            return slice.toString('latin1').trim()
    }
}

const shorten = (s: string): string => (s.length > EXAMPLE_CHARS ? `${s.slice(0, EXAMPLE_CHARS)}…` : s)

// ---------------------------------------------------------------- SQL text

const STRING_ESCAPES: Readonly<Record<string, string>> = {
    '\0': '\\0', '\n': '\\n', '\r': '\\r', '\\': '\\\\', "'": "\\'", '"': '\\"', '\x1a': '\\Z',
}

const quoteString = (s: string): string =>
    `'${s.replace(/[\0\n\r\\'"\x1a]/g, c => STRING_ESCAPES[c] ?? c)}'`

const quoteIdent = (s: string): string => `\`${s.replace(/`/g, '``')}\``

function sqlLiteral(kind: ValueKind, value: string | null): string {
    if (value === null) return 'NULL'
    switch (kind) {
        case 'text': case 'memoText': case 'date': case 'datetime': return quoteString(value)
        case 'binary': case 'memoBinary': return `X'${value}'`
        default: return value
    }
}

function toIdentifier(raw: string, fallback: string): string {
    let s = transliterate(raw).replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '')
    if (s === '') s = fallback
    if (/^\d/.test(s)) s = `_${s}`
    return s.slice(0, MAX_IDENTIFIER)
}

function uniqueName(base: string, taken: Set<string>): string {
    let name = base
    for (let i = 2; taken.has(name); i++) {
        const suffix = `_${i}`
        name = base.slice(0, MAX_IDENTIFIER - suffix.length) + suffix
    }
    taken.add(name)
    return name
}

const isMemoKind = (kind: ValueKind): boolean => kind === 'memoText' || kind === 'memoBinary'

const describeField = (f: DbfFieldDescriptor): string =>
    `${f.name} ${f.type}(${f.length}${f.decimalCount > 0 ? `,${f.decimalCount}` : ''})`

const FIXED_KEY_BYTES: Readonly<Record<string, number>> = {
    TINYINT: 1, SMALLINT: 2, MEDIUMINT: 3, INT: 4, INTEGER: 4, BIGINT: 8, FLOAT: 4, DOUBLE: 8,
    DATE: 3, TIME: 3, YEAR: 1, DATETIME: 8, TIMESTAMP: 4,
}

/** Declared length of CHAR/VARCHAR/BINARY/VARBINARY, or null for other types. */
const sizedLength = (type: string): number | null => {
    const m = /^(?:VAR)?(?:CHAR|BINARY)\((\d+)\)$/.exec(type)
    return m ? Number(m[1]) : null
}

/** Worst-case bytes a column takes in an index key (utf8mb4: 4 bytes per character). */
function keyBytes(type: string, prefix: number | undefined): number {
    const length = sizedLength(type)
    if (length !== null) {
        const n = Math.min(length, prefix ?? length)
        return /BINARY/.test(type) ? n : n * 4
    }
    const decimal = /^(?:DECIMAL|NUMERIC)\((\d+)/.exec(type)
    if (decimal) return Math.ceil(Number(decimal[1]) / 2) + 1
    return FIXED_KEY_BYTES[/^[A-Z]+/.exec(type)?.[0] ?? ''] ?? 8
}

// ---------------------------------------------------------------- plan

interface TableSpec {
    readonly fileName: FileName
    readonly table: string
    readonly result: DbfParseResult
    readonly source: Buffer
    readonly encoding: string
    readonly decoder: TextDecoderLike
    readonly memo: MemoReader | null
    readonly memoFile: string | null
    readonly rowCount: number
    readonly deletedCount: number
    /** Where records marked deleted go (keepDeleted), or null when they are dropped. */
    deletedTable: string | null
    /** Every mappable field, excluded ones included so the plan can show them. */
    readonly columns: readonly ColumnSpec[]
    readonly skippedFields: readonly string[]
    readonly excluded: boolean
    /** The user chose the primary key (or chose none); relationships must not add one. */
    readonly pkLocked: boolean
    /** .CDX candidate tag that became the primary key. */
    primaryTag: string | null
    indexes: readonly IndexSpec[]
}

interface IndexSpec {
    readonly tag: CdxTag
    readonly name: string
    readonly parts: readonly { readonly column: ColumnSpec; readonly prefix?: number }[]
    readonly status: MysqlIndexPlan['status']
    readonly note?: string
}

/** Columns that end up in the MySQL table. */
const active = (table: TableSpec): readonly ColumnSpec[] => table.columns.filter(c => !c.excluded)

// InnoDB (strict mode, DYNAMIC rows) refuses CREATE TABLE when the worst-case row exceeds about
// half a 16 KB page (8126 bytes). It counts a variable-length column of up to 255 bytes in full;
// a longer one, or TEXT/BLOB, may move to overflow pages and counts as its 40-byte local part plus
// length bytes (measured on MySQL 8.0: 190 x VARCHAR(64) is accepted, 250 x is not; 70 x VARCHAR(30)
// is refused). Separately, MySQL caps the declared size of all columns at 65 535 bytes.
const INNODB_ROW_TARGET = 8000
const MYSQL_ROW_LIMIT = 65_535
const INLINE_MAX_BYTES = 255
const OVERFLOW_POINTER = 42
// utf8mb4 VARCHAR(64) is 256 bytes: the shortest text column InnoDB may move out of the row.
const OFF_PAGE_VARCHAR = 'VARCHAR(64)'

/** Bytes a column type counts towards the 65 535 limit and towards InnoDB's in-row limit. */
function rowBytes(type: string): { declared: number; inRow: number } {
    const length = sizedLength(type)
    if (length !== null) {
        const bytes = /BINARY/.test(type) ? length : length * 4
        const declared = bytes + (bytes > INLINE_MAX_BYTES ? 2 : 1)
        return { declared, inRow: bytes > INLINE_MAX_BYTES ? OVERFLOW_POINTER : declared }
    }
    if (!isKeyableType(type)) return { declared: 12, inRow: OVERFLOW_POINTER }
    const bytes = keyBytes(type, undefined)
    return { declared: bytes, inRow: bytes }
}

/**
 * Old tables with a hundred and more character fields exceed those limits once every character
 * takes up to 4 bytes (MySQL then refuses CREATE TABLE). The widest short columns are widened to
 * VARCHAR(64), which InnoDB may store out of the row; if the declared total is still too large, the
 * widest become TEXT. Types the user set are left alone. Values are never cut.
 */
function fitRowSize(table: TableSpec, warnings: string[]): void {
    const columns = active(table)
    // Record header, NULL bitmap and InnoDB's hidden row id and transaction columns.
    const overhead = 30 + Math.ceil(columns.length / 8)
    const total = (kind: 'declared' | 'inRow') => columns.reduce((n, c) => n + rowBytes(c.mysqlType)[kind], overhead)
    const changeable = (c: ColumnSpec) => !c.typeOverridden && /^VARCHAR\(/.test(c.mysqlType)
    const widest = (pick: (c: ColumnSpec) => boolean) =>
        columns.filter(c => changeable(c) && pick(c)).sort((a, b) => sizedLength(b.mysqlType)! - sizedLength(a.mysqlType)!)[0]

    const toText: string[] = []
    for (let c = widest(c => c.key === null); c && total('declared') > MYSQL_ROW_LIMIT; c = widest(c => c.key === null)) {
        c.mysqlType = 'TEXT'
        toText.push(c.column)
    }
    const widened: string[] = []
    const inRow = (c: ColumnSpec) => rowBytes(c.mysqlType).inRow > OVERFLOW_POINTER
    for (let c = widest(inRow); c && total('inRow') > INNODB_ROW_TARGET; c = widest(inRow)) {
        c.mysqlType = OFF_PAGE_VARCHAR
        widened.push(c.column)
    }

    const list = (names: string[]) => names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', ')
    if (toText.length > 0)
        warnings.push(`${table.table}: the columns together exceed MySQL's 64 KB row limit — ${list(toText)} became TEXT`)
    if (widened.length > 0)
        warnings.push(`${table.table}: ${widened.length} short text column(s) widened to ${OFF_PAGE_VARCHAR} so a row fits InnoDB's 8 KB limit (${list(widened)}); values are unchanged`)
    if (total('inRow') > INNODB_ROW_TARGET)
        warnings.push(`${table.table}: a row may still exceed InnoDB's 8 KB limit — exclude some columns or give wide ones a TEXT type`)
}

const primaryKeyOf = (table: TableSpec): ColumnSpec | undefined => active(table).find(c => c.key === 'PRI')

/** The column list of an index as MySQL writes it: `name`(20) for a prefix. */
const indexColumnSql = (part: IndexSpec['parts'][number]): string =>
    `${quoteIdent(part.column.column)}${part.prefix ? `(${part.prefix})` : ''}`

/** The tables a live import writes to, with the columns it expects in them — checked before a sync. */
export interface ExpectedTable {
    readonly table: string
    readonly columns: readonly string[]
    /** Empty: the table has no primary key and is reloaded as a whole. */
    readonly primaryKey: readonly string[]
}

interface ColumnStats {
    readonly values: Set<string>
    unique: boolean
    hasNull: boolean
}

interface AcceptedForeignKey {
    readonly name: string
    readonly child: { readonly table: TableSpec; readonly column: ColumnSpec }
    readonly parent: { readonly table: TableSpec; readonly column: ColumnSpec }
}

interface InternalPlan {
    readonly options: MysqlExportOptions
    readonly tables: readonly TableSpec[]
    readonly foreignKeys: readonly MysqlForeignKeyPlan[]
    readonly accepted: readonly AcceptedForeignKey[]
    readonly quality: readonly MysqlQualityIssue[]
    readonly warnings: readonly string[]
}

// Most deliberate first: user links, then suffix-inferred keys, then plain name matches.
const RELATIONSHIP_PRIORITY: Readonly<Record<RelationshipKind, number>> = {
    manual: 0,
    auto_fk: 1,
    auto_name: 2,
}

// Every table tends to have these; two tables sharing one says nothing about a relationship.
const GENERIC_FIELD_NAMES: ReadonlySet<string> = new Set([
    'ID', 'CODE', 'KOD', 'KEY', 'NUM', 'NO', 'NR', 'N', 'NAME', 'NAIM', 'TYPE', 'TIP', 'DATE', 'DATA',
])

/** One piece of the dump, tagged so a live import can report where it is. */
export interface SqlChunk {
    readonly sql: string
    /** The table this piece creates or fills. */
    readonly table?: string
    /** Rows inserted by this piece. */
    readonly rows?: number
    /** Part of the foreign key phase at the end. */
    readonly foreignKeys?: boolean
    /**
     * Sync bookkeeping, one statement per chunk so MySQL's answer can be read:
     * upsert = INSERT … ON DUPLICATE KEY UPDATE, delete = rows gone from the DBF, reload = table emptied.
     */
    readonly sync?: 'upsert' | 'delete' | 'reload'
}

function* sqlText(chunks: Iterable<SqlChunk>): Generator<string> {
    for (const chunk of chunks) yield chunk.sql
}

function countRecords(source: Buffer, header: DbfParseResult['header'], set: RecordSet): number {
    let n = 0
    for (const _ of iterateRecords(source, header, set)) n++
    return n
}

/**
 * Runs `alter` only when the named constraint is not there yet. Append and sync write into tables
 * an earlier run created, and MySQL has no ADD CONSTRAINT IF NOT EXISTS.
 */
function unlessConstraintExists(table: string, constraint: string, alter: string): string {
    return `SET @dbf_sql = IF((SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS ` +
        `WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = ${quoteString(table)} AND CONSTRAINT_NAME = ${quoteString(constraint)}) = 0, ` +
        `${quoteString(alter)}, 'DO 0');\n` +
        'PREPARE dbf_stmt FROM @dbf_sql;\nEXECUTE dbf_stmt;\nDEALLOCATE PREPARE dbf_stmt;\n'
}

@Injectable()
export class MysqlExportService {
    plan(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MysqlExportOptions,
    ): MysqlExportPlan {
        return this.toPublicPlan(this.buildPlan(session, relationships, options))
    }

    /** The dump as a stream: tables are read record by record, never held as one big string. */
    exportSql(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MysqlExportOptions,
    ): Readable {
        return Readable.from(sqlText(this.generateSql(this.buildPlan(session, relationships, options))))
    }

    /** Plan plus the dump split into executable pieces, for running straight against a server. */
    statements(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MysqlExportOptions,
    ): { plan: MysqlExportPlan; chunks: Iterable<SqlChunk>; expected: ExpectedTable[] } {
        const plan = this.buildPlan(session, relationships, options)
        const expected: ExpectedTable[] = []
        for (const t of plan.tables) {
            if (t.excluded) continue
            const pk = primaryKeyOf(t)
            expected.push({ table: t.table, columns: active(t).map(c => c.column), primaryKey: pk ? [pk.column] : [] })
            if (t.deletedTable)
                expected.push({ table: t.deletedTable, columns: [RECNO_COLUMN, ...active(t).map(c => c.column)], primaryKey: [RECNO_COLUMN] })
        }
        return { plan: this.toPublicPlan(plan), chunks: this.generateSql(plan), expected }
    }

    private toPublicPlan(plan: InternalPlan): MysqlExportPlan {
        return {
            database: plan.options.database ?? null,
            tables: plan.tables.map(t => ({
                fileName: t.fileName,
                table: t.table,
                rowCount: t.rowCount,
                deletedRows: t.deletedCount,
                deletedTable: t.deletedTable,
                sync: primaryKeyOf(t) ? 'upsert' as const : 'reload' as const,
                indexFile: t.result.index?.fileName ?? null,
                indexes: t.indexes.map(ix => ({
                    tag: ix.tag.name,
                    expression: ix.tag.expression,
                    filter: ix.tag.filter,
                    candidate: ix.tag.candidate,
                    unique: ix.tag.unique,
                    name: ix.name,
                    columns: ix.parts.map(p => `${p.column.column}${p.prefix ? `(${p.prefix})` : ''}`),
                    status: ix.status,
                    note: ix.note,
                })),
                encoding: t.encoding,
                memoFile: t.memoFile,
                excluded: t.excluded,
                skippedFields: t.skippedFields,
                columns: t.columns.map(c => ({
                    dbfField: c.field.name,
                    dbfType: c.field.type,
                    length: c.field.length,
                    decimals: c.field.decimalCount,
                    column: c.column,
                    mysqlType: c.mysqlType,
                    nullable: c.nullable,
                    key: c.key,
                    excluded: c.excluded,
                    typeOverridden: c.typeOverridden,
                    note: c.note,
                })),
            })),
            foreignKeys: plan.foreignKeys,
            quality: plan.quality,
            warnings: plan.warnings,
        }
    }

    private buildPlan(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MysqlExportOptions,
    ): InternalPlan {
        const { overrides } = options
        const warnings: string[] = []
        const tables: TableSpec[] = []

        // Names the user typed are reserved first, so generated names step around them.
        const takenTables = new Set<string>()
        const reserve = (name: string | undefined, taken: Set<string>, what: string): string | null => {
            if (!name) return null
            if (taken.has(name)) {
                warnings.push(`${what}: the name "${name}" is used twice — a suffix was added`)
                return null
            }
            taken.add(name)
            return name
        }
        const userTableNames = new Map<string, string | null>()
        for (const fileName of session.files.keys())
            userTableNames.set(fileName, reserve(overrides[fileName]?.name, takenTables, fileName))

        for (const [fileName, result] of session.files) {
            const source = session.sources.get(fileName)
            if (!source) throw new NotFoundException(`Source bytes missing for ${fileName}`)

            const tableOverride = overrides[fileName] ?? {}
            const columnOverrides = tableOverride.columns ?? {}
            const memo = source.memo ? openMemo(source.memo.buffer, source.memo.format) : null
            const encoding = result.encoding
            const skippedFields: string[] = []

            const takenColumns = new Set<string>()
            const userColumnNames = new Map<string, string | null>()
            for (const field of result.header.fields)
                userColumnNames.set(field.name, reserve(columnOverrides[field.name]?.name, takenColumns, `${fileName}.${field.name}`))

            const columns: ColumnSpec[] = []
            for (const field of result.header.fields) {
                if ((field.type as string) === NULL_FLAGS_FIELD_TYPE) continue
                const mapping = mapField(field, result.header.typeByte)
                if (!mapping) {
                    skippedFields.push(describeField(field))
                    continue
                }
                const columnOverride = columnOverrides[field.name] ?? {}
                columns.push({
                    field,
                    kind: mapping.kind,
                    family: mapping.family,
                    column: userColumnNames.get(field.name) ?? uniqueName(toIdentifier(field.name, 'column'), takenColumns),
                    note: isMemoKind(mapping.kind)
                        ? source.memo ? `from ${source.memo.fileName}` : 'memo file (.fpt/.dbt) not uploaded — exported as NULL'
                        : undefined,
                    excluded: columnOverride.exclude === true,
                    typeOverridden: columnOverride.type !== undefined,
                    mysqlType: columnOverride.type ?? mapping.mysqlType,
                    collation: null,
                    nullable: true,
                    key: null,
                })
            }

            const included = columns.filter(c => !c.excluded)
            const excluded = tableOverride.exclude === true || included.length === 0
            if (included.length === 0 && tableOverride.exclude !== true)
                warnings.push(`${fileName}: no fields left to export — table left out`)

            // A primary key the user picked; null means "no primary key at all".
            const pk = tableOverride.primaryKey
            if (typeof pk === 'string') {
                const column = included.find(c => c.field.name === pk)
                if (column) {
                    column.key = 'PRI'
                    column.nullable = false
                    if (isCharacterType(column.mysqlType)) column.collation = KEY_COLLATION
                } else {
                    warnings.push(`${fileName}: primary key field ${pk} is not exported — table has no primary key`)
                }
            }

            if (!excluded) {
                if (skippedFields.length > 0)
                    warnings.push(`${fileName}: fields with no MySQL equivalent are left out — ${skippedFields.join(', ')}`)
                if (!memo && included.some(c => isMemoKind(c.kind)))
                    warnings.push(`${fileName}: memo fields are exported as NULL — upload ${fileName.replace(/\.dbf$/i, '')}.FPT (or .DBT) together with the table to carry them over`)
                if (result.encodingSource === 'detected' && included.some(c => c.kind === 'text'))
                    warnings.push(`${fileName}: no code page mark — encoding detected from the text as ${encoding}. If the preview looks wrong, pick the encoding on the table's tab.`)
                if (options.indexes && result.header.tableFlags.hasStructuralCdx && !result.index)
                    warnings.push(`${fileName}: the table has a .CDX index file — upload ${fileName.replace(/\.dbf$/i, '')}.CDX together with the table to carry its indexes over`)
                if (options.indexes && result.index?.error)
                    warnings.push(`${result.index.fileName}: could not be read (${result.index.error}) — no indexes from it`)
            }

            tables.push({
                fileName,
                table: userTableNames.get(fileName) ?? uniqueName(toIdentifier(fileName.replace(/\.dbf$/i, ''), 'table'), takenTables),
                result,
                source: source.dbf,
                encoding,
                decoder: createDecoder(encoding),
                memo,
                memoFile: source.memo?.fileName ?? null,
                rowCount: countRecords(source.dbf, result.header, 'live'),
                deletedCount: countRecords(source.dbf, result.header, 'deleted'),
                deletedTable: null,
                columns,
                skippedFields,
                excluded,
                pkLocked: pk !== undefined,
                primaryTag: null,
                indexes: [],
            })
        }

        // Named after every real table, so a generated "clients_deleted" never takes a user's name.
        if (options.keepDeleted && options.includeData) {
            for (const t of tables) {
                if (!t.excluded && t.deletedCount > 0)
                    t.deletedTable = uniqueName(toIdentifier(`${t.table}_deleted`, 'deleted'), takenTables)
            }
        }

        // A FoxPro candidate key is the developer's own primary key; it goes first so links do not pick another.
        if (options.indexes) this.primaryKeysFromCandidates(tables, options, warnings)

        const { foreignKeys, accepted } = options.foreignKeys
            ? this.planForeignKeys(tables, relationships, options)
            : { foreignKeys: [], accepted: [] }

        // Types are final now (overrides, keys, foreign key alignment); make sure each row fits InnoDB.
        for (const t of tables) if (!t.excluded) fitRowSize(t, warnings)

        if (options.indexes) {
            for (const t of tables) if (!t.excluded) t.indexes = this.planIndexes(t, options)
        }

        if (options.writeMode === 'sync') {
            const keyless = tables.filter(t => !t.excluded && !primaryKeyOf(t)).map(t => t.table)
            if (keyless.length > 0)
                warnings.push(`Sync: no primary key in ${keyless.join(', ')} — these tables are emptied and loaded again on every sync. Pick a primary key in the plan to update them row by row.`)
        }

        const quality = this.assessQuality(tables, options)
        return { options, tables, foreignKeys, accepted, quality, warnings }
    }

    /**
     * Turns detected relationships into FOREIGN KEY constraints, checked against the data:
     * the referenced side must hold unique values and every child value must exist in it.
     */
    private planForeignKeys(
        tables: readonly TableSpec[],
        relationships: readonly DbfRelationship[],
        options: MysqlExportOptions,
    ): { foreignKeys: MysqlForeignKeyPlan[]; accepted: AcceptedForeignKey[] } {
        const byFile = new Map(tables.map(t => [t.fileName as string, t]))
        const resolve = (file: string, field: string) => {
            const table = byFile.get(file)
            const column = table?.columns.find(c => c.field.name === field)
            return table && column ? { table, column } : null
        }
        const exclusionOf = (file: string, field: string): string | null => {
            const end = resolve(file, field)
            if (end?.table.excluded) return `${end.table.table} is excluded from the export`
            if (end?.column.excluded) return `${end.table.table}.${end.column.column} is excluded from the export`
            return null
        }

        type Endpoint = NonNullable<ReturnType<typeof resolve>>
        const candidates: { rel: DbfRelationship; source: Endpoint; target: Endpoint }[] = []
        const foreignKeys: MysqlForeignKeyPlan[] = []
        // Same naming as created keys (MySQL table.column), falling back to DBF names when unresolved.
        const displayName = (file: string, field: string) => {
            const end = resolve(file, field)
            return { table: end?.table.table ?? byFile.get(file)?.table ?? file, column: end?.column.column ?? field }
        }
        const skipRaw = (rel: DbfRelationship, reason: string) => {
            const child = displayName(rel.sourceFile, rel.sourceField)
            const parent = displayName(rel.targetFile, rel.targetField)
            foreignKeys.push({
                name: '',
                childTable: child.table, childColumn: child.column,
                parentTable: parent.table, parentColumn: parent.column,
                source: rel.kind, status: 'skip', reason,
            })
        }

        const seenPairs = new Set<string>()
        const ordered = [...relationships].sort((a, b) => RELATIONSHIP_PRIORITY[a.kind] - RELATIONSHIP_PRIORITY[b.kind])
        for (const rel of ordered) {
            const ends = [`${rel.sourceFile}.${rel.sourceField}`, `${rel.targetFile}.${rel.targetField}`].sort()
            const pairKey = ends.join('|')
            if (seenPairs.has(pairKey)) continue
            seenPairs.add(pairKey)

            const source = resolve(rel.sourceFile, rel.sourceField)
            const target = resolve(rel.targetFile, rel.targetField)
            if (!source || !target) {
                const missing = !source ? `${rel.sourceFile}.${rel.sourceField}` : `${rel.targetFile}.${rel.targetField}`
                skipRaw(rel, `field ${missing} does not exist or has no MySQL equivalent`)
                continue
            }
            const exclusion = exclusionOf(rel.sourceFile, rel.sourceField) ?? exclusionOf(rel.targetFile, rel.targetField)
            if (exclusion) {
                skipRaw(rel, exclusion)
                continue
            }
            if (source.column === target.column) {
                skipRaw(rel, 'a column cannot reference itself')
                continue
            }
            if (rel.kind === 'auto_name' && GENERIC_FIELD_NAMES.has(rel.sourceField.toUpperCase())) {
                skipRaw(rel, `"${rel.sourceField}" is too generic to imply a link by name alone — add it manually if the tables really are related`)
                continue
            }
            if (!isKeyableType(source.column.mysqlType) || !isKeyableType(target.column.mysqlType)) {
                skipRaw(rel, 'TEXT/BLOB columns cannot take part in a foreign key — use VARCHAR(n)')
                continue
            }
            if (source.column.family === null || source.column.family !== target.column.family ||
                (source.column.family === 'date' && source.column.mysqlType !== target.column.mysqlType)) {
                skipRaw(rel, `incompatible types: ${describeField(source.column.field)} vs ${describeField(target.column.field)}`)
                continue
            }
            candidates.push({ rel, source, target })
        }

        // One pass per table collects the values of every column that takes part in a link.
        const needed = new Map<TableSpec, Set<ColumnSpec>>()
        for (const { source, target } of candidates) {
            for (const end of [source, target]) {
                const set = needed.get(end.table) ?? new Set<ColumnSpec>()
                set.add(end.column)
                needed.set(end.table, set)
            }
        }
        const stats = new Map<ColumnSpec, ColumnStats>()
        for (const [table, columns] of needed) {
            for (const [column, s] of this.collectStats(table, [...columns], options)) stats.set(column, s)
        }

        let accepted: AcceptedForeignKey[] = []
        const takenNames = new Set<string>()
        const seenLinks = new Set<string>()

        const linkBase = (rel: DbfRelationship, parent: Endpoint, child: Endpoint) => ({
            childTable: child.table.table, childColumn: child.column.column,
            parentTable: parent.table.table, parentColumn: parent.column.column,
            source: rel.kind,
        })

        // A direction works when the parent column is unique and holds every child value.
        const evaluate = (parent: Endpoint, child: Endpoint) => {
            const parentStats = stats.get(parent.column)!
            const childStats = stats.get(child.column)!
            if (!parentStats.unique || parentStats.values.size === 0)
                return { parent, child, parentStats, orphans: null }
            let count = 0
            let example: string | null = null
            for (const v of childStats.values) {
                if (!parentStats.values.has(v)) {
                    count++
                    example ??= v
                }
            }
            return { parent, child, parentStats, orphans: { count, example } }
        }

        for (const { rel, source, target } of candidates) {
            const directions = [evaluate(target, source), evaluate(source, target)]
            // Explicit links keep their declared direction first; for name matches the
            // null-free, fuller column is the more likely primary key.
            if (rel.kind === 'auto_name') {
                directions.sort((a, b) =>
                    Number(a.parentStats.hasNull) - Number(b.parentStats.hasNull) ||
                    b.parentStats.values.size - a.parentStats.values.size)
            }

            const chosen = directions.find(d => d.orphans?.count === 0)
            if (!chosen) {
                const closest = directions
                    .filter(d => d.orphans !== null)
                    .sort((a, b) => a.orphans!.count - b.orphans!.count)[0]
                if (!closest) {
                    foreignKeys.push({
                        ...linkBase(rel, directions[0]!.parent, directions[0]!.child), name: '', status: 'skip',
                        reason: 'neither column holds unique values, so neither can be referenced',
                    })
                } else {
                    const base = linkBase(rel, closest.parent, closest.child)
                    foreignKeys.push({
                        ...base, name: '', status: 'skip',
                        reason: `${closest.orphans!.count} value(s) in ${base.childTable}.${base.childColumn} have no match in ${base.parentTable}.${base.parentColumn} (e.g. '${closest.orphans!.example}')`,
                    })
                }
                continue
            }

            const { parent, child, parentStats } = chosen
            const base = linkBase(rel, parent, child)
            const linkKey = `${base.childTable}.${base.childColumn}->${base.parentTable}.${base.parentColumn}`
            if (seenLinks.has(linkKey)) continue
            // A guessed link never gives a column a second parent; user links (sorted first) win.
            const existing = rel.kind !== 'manual' ? accepted.find(a => a.child.column === child.column) : undefined
            if (existing) {
                foreignKeys.push({
                    ...base, name: '', status: 'skip',
                    reason: `${base.childTable}.${base.childColumn} already references ${existing.parent.table.table}.${existing.parent.column.column}`,
                })
                continue
            }
            seenLinks.add(linkKey)

            if (parent.column.key === null) {
                const hasPrimary = parent.table.pkLocked || parent.table.columns.some(c => c.key === 'PRI')
                if (!hasPrimary && !parentStats.hasNull) {
                    parent.column.key = 'PRI'
                    parent.column.nullable = false
                } else {
                    parent.column.key = 'UNI'
                }
            }
            if (parent.column.family === 'text') {
                if (isCharacterType(parent.column.mysqlType)) parent.column.collation = KEY_COLLATION
                if (isCharacterType(child.column.mysqlType)) child.column.collation = KEY_COLLATION
            }

            const name = uniqueName(toIdentifier(`fk_${base.childTable}_${base.childColumn}`, 'fk'), takenNames)
            accepted.push({ name, child, parent })
            foreignKeys.push({ ...base, name, status: 'create' })
        }

        // InnoDB wants identical integer types on both ends; repeat so chains settle.
        // A type the user set by hand is never changed behind their back.
        for (let changed = true, guard = 0; changed && guard < 10; guard++) {
            changed = false
            for (const { child, parent } of accepted) {
                if (child.column.family === 'numeric' && !child.column.typeOverridden && child.column.mysqlType !== parent.column.mysqlType) {
                    child.column.mysqlType = parent.column.mysqlType
                    changed = true
                }
            }
        }
        // …and where a hand-set type still disagrees, the constraint cannot be created.
        const conflicting = new Set(accepted.filter(a =>
            a.child.column.family === 'numeric' && a.child.column.mysqlType !== a.parent.column.mysqlType))
        if (conflicting.size > 0) {
            for (const a of conflicting) {
                const i = foreignKeys.findIndex(fk => fk.name === a.name)
                foreignKeys[i] = {
                    ...foreignKeys[i]!, name: '', status: 'skip',
                    reason: `types differ: ${a.child.column.column} ${a.child.column.mysqlType} vs ${a.parent.column.column} ${a.parent.column.mysqlType} — give both the same type`,
                }
            }
            accepted = accepted.filter(a => !conflicting.has(a))
        }

        // Keys that will exist first; skipped ones after, each group in detection order.
        foreignKeys.sort((a, b) => Number(a.status === 'skip') - Number(b.status === 'skip'))
        return { foreignKeys, accepted }
    }

    /**
     * Tables without a chosen primary key take their .CDX candidate tag on a single field as one,
     * as long as the live records really are unique and filled in.
     */
    private primaryKeysFromCandidates(tables: readonly TableSpec[], options: MysqlExportOptions, warnings: string[]): void {
        for (const table of tables) {
            if (table.excluded || table.pkLocked || primaryKeyOf(table)) continue
            const fieldNames = table.result.header.fields.map(f => f.name)
            for (const tag of table.result.index?.tags ?? []) {
                if (!tag.candidate || tag.filter) continue
                let parts: ReturnType<typeof indexParts>
                try {
                    parts = indexParts(tag.expression, fieldNames)
                } catch {
                    continue
                }
                const part = parts.length === 1 && !parts[0]!.prefix ? parts[0]! : null
                const column = part && table.columns.find(c => c.field.name === part.field)
                if (!column || column.excluded || !isKeyableType(column.mysqlType)) continue

                const stats = this.collectStats(table, [column], options).get(column)!
                if (stats.unique && !stats.hasNull) {
                    column.key = 'PRI'
                    column.nullable = false
                    if (isCharacterType(column.mysqlType)) column.collation = KEY_COLLATION
                    table.primaryTag = tag.name
                } else {
                    warnings.push(`${table.fileName}: candidate key ${tag.name} (${tag.expression}) has ${stats.hasNull ? 'empty' : 'repeated'} values among the live records — not used as the primary key`)
                }
                break
            }
        }
    }

    /** The table's .CDX tags as MySQL indexes, or the reason each one cannot be. */
    private planIndexes(table: TableSpec, options: MysqlExportOptions): IndexSpec[] {
        const fieldNames = table.result.header.fields.map(f => f.name)
        const excluded = new Set(options.overrides[table.fileName]?.excludedIndexes ?? [])
        const pk = primaryKeyOf(table)
        const unique = active(table).filter(c => c.key === 'UNI')
        // Column lists that already have an index in MySQL, with what that index is.
        const covered = new Map<string, string>()
        if (pk) covered.set(quoteIdent(pk.column), 'the primary key')
        for (const c of unique) covered.set(quoteIdent(c.column), `the unique key on ${c.column}`)
        const taken = new Set(unique.map(c => `uq_${c.column}`.slice(0, MAX_IDENTIFIER)))

        const out: IndexSpec[] = []
        let created = 0
        for (const tag of table.result.index?.tags ?? []) {
            if (tag.name === table.primaryTag) {
                out.push({ tag, name: '', parts: pk ? [{ column: pk }] : [], status: 'primary', note: 'candidate key in FoxPro — used as the primary key' })
                continue
            }
            const skip = (note: string, parts: IndexSpec['parts'] = []) => out.push({ tag, name: '', parts, status: 'skip', note })

            let parsed: ReturnType<typeof indexParts>
            try {
                parsed = indexParts(tag.expression, fieldNames)
            } catch (err) {
                skip(`expression cannot be translated: ${err instanceof Error ? err.message : String(err)}`)
                continue
            }
            if (parsed.length === 0) {
                skip('the expression uses no fields (DELETED() or constants only)')
                continue
            }

            const parts: { column: ColumnSpec; prefix?: number }[] = []
            let problem: string | null = null
            for (const p of parsed) {
                const column = table.columns.find(c => c.field.name === p.field)
                if (!column) problem = `${p.field} has no MySQL column`
                else if (column.excluded) problem = `${column.column} is excluded from the export`
                else if (!isKeyableType(column.mysqlType)) problem = `${column.column} is ${column.mysqlType}, which cannot be indexed — use VARCHAR(n)`
                if (problem || !column) break
                const length = sizedLength(column.mysqlType)
                parts.push({ column, prefix: p.prefix && length !== null && p.prefix < length ? p.prefix : undefined })
            }
            if (problem) {
                skip(problem, parts)
                continue
            }
            if (excluded.has(tag.name)) {
                out.push({ tag, name: '', parts, status: 'excluded' })
                continue
            }
            const bytes = parts.reduce((n, p) => n + keyBytes(p.column.mysqlType, p.prefix), 0)
            if (parts.length > MAX_KEY_PARTS) {
                skip(`${parts.length} columns — MySQL allows ${MAX_KEY_PARTS} per index`, parts)
                continue
            }
            if (bytes > MAX_KEY_BYTES) {
                skip(`the key would take up to ${bytes} bytes, InnoDB allows ${MAX_KEY_BYTES}`, parts)
                continue
            }
            const signature = parts.map(indexColumnSql).join(',')
            const same = covered.get(signature)
            if (same) {
                skip(`same columns as ${same}`, parts)
                continue
            }
            if (created >= MAX_INDEXES) {
                skip(`MySQL allows ${MAX_INDEXES} indexes per table`, parts)
                continue
            }

            const name = uniqueName(toIdentifier(`ix_${tag.name}`, 'ix'), taken)
            covered.set(signature, `index ${name}`)
            created++
            const notes = [
                tag.filter && `FOR ${tag.filter} is not carried over — MySQL indexes every row`,
                tag.candidate && 'candidate key in FoxPro — a plain index here, the table has another primary key',
                tag.unique && 'UNIQUE in FoxPro only skips repeated keys — a plain index here',
            ].filter(Boolean)
            out.push({ tag, name, parts, status: 'create', note: notes.length > 0 ? notes.join('; ') : undefined })
        }
        return out
    }

    private collectStats(
        table: TableSpec,
        columns: readonly ColumnSpec[],
        options: MysqlExportOptions,
    ): Map<ColumnSpec, ColumnStats> {
        const stats = new Map<ColumnSpec, ColumnStats>(
            columns.map(c => [c, { values: new Set<string>(), unique: true, hasNull: false }]),
        )
        for (const record of iterateRecords(table.source, table.result.header)) {
            for (const [column, s] of stats) {
                const value = decodeValue(column, record, table, options.emptyStringsAsNull)
                if (value === null) s.hasNull = true
                else if (s.values.has(value)) s.unique = false
                else s.values.add(value)
            }
        }
        return stats
    }

    /**
     * Reads every record the way the export will and reports, per column, values that would be
     * lost (stored as NULL) or that strict-mode MySQL would reject (stopping the import).
     */
    private assessQuality(tables: readonly TableSpec[], options: MysqlExportOptions): MysqlQualityIssue[] {
        const issues = new Map<string, MysqlQualityIssue & { examples: string[]; count: number }>()
        const report = (table: TableSpec, target: string, column: ColumnSpec, problem: string, effect: MysqlQualityEffect, example: string | null) => {
            const key = `${target}\u0000${column.column}\u0000${problem}`
            let issue = issues.get(key)
            if (!issue) {
                issue = {
                    fileName: table.fileName, table: target,
                    dbfField: column.field.name, column: column.column,
                    problem, effect, count: 0, examples: [],
                }
                issues.set(key, issue)
            }
            issue.count++
            if (example !== null && issue.examples.length < QUALITY_EXAMPLES && !issue.examples.includes(shorten(example)))
                issue.examples.push(shorten(example))
        }

        for (const table of tables) {
            if (table.excluded) continue
            const columns = active(table)

            for (const column of columns) {
                if (column.key !== null && !isKeyableType(column.mysqlType)) {
                    issues.set(`${table.table}\u0000${column.column}\u0000keyable`, {
                        fileName: table.fileName, table: table.table, dbfField: column.field.name, column: column.column,
                        problem: `${column.mysqlType} cannot be a ${column.key === 'PRI' ? 'primary' : 'unique'} key — use VARCHAR(n)`,
                        effect: 'fail', count: table.rowCount, examples: [],
                    })
                }
            }

            const keySeen = new Map<ColumnSpec, Set<string>>(
                columns.filter(c => c.key !== null).map(c => [c, new Set<string>()]),
            )
            if (!options.includeData) continue

            // Deleted records land in a keyless copy: only the values themselves can fail there.
            const sets: { set: RecordSet; target: string; keyed: boolean }[] = [{ set: 'live', target: table.table, keyed: true }]
            if (table.deletedTable) sets.push({ set: 'deleted', target: table.deletedTable, keyed: false })

            for (const { set, target, keyed } of sets) {
                for (const record of iterateRecords(table.source, table.result.header, set)) {
                    for (const column of columns) {
                        const value = decodeValue(column, record, table, options.emptyStringsAsNull)
                        if (value === null) {
                            const loss = lossReason(column, record, table.memo)
                            if (loss) report(table, target, column, loss, 'null', rawDisplay(column, record, table.decoder))
                            if (keyed && !column.nullable) report(table, target, column, 'empty value in a NOT NULL primary key', 'fail', null)
                            continue
                        }
                        const misfit = typeProblem(value, column.kind, column.mysqlType)
                        if (misfit) report(table, target, column, misfit, 'fail', isMemoKind(column.kind) || column.kind === 'binary' ? `${value.length / 2} bytes` : value)
                        const seen = keyed ? keySeen.get(column) : undefined
                        if (seen) {
                            if (seen.has(value)) report(table, target, column, `duplicate value in a ${column.key === 'PRI' ? 'primary' : 'unique'} key`, 'fail', value)
                            else seen.add(value)
                        }
                    }
                }
            }
        }

        return [...issues.values()].sort((a, b) =>
            Number(a.effect === 'null') - Number(b.effect === 'null') || b.count - a.count)
    }

    // ------------------------------------------------------------ SQL

    private *generateSql(plan: InternalPlan): Generator<SqlChunk> {
        const { options } = plan
        const tables = plan.tables.filter(t => !t.excluded)

        yield { sql: `-- MySQL dump generated by dbf inspector\n` +
            `-- ${new Date().toISOString()}\n` +
            `-- Mode: ${MODE_DESCRIPTION[options.writeMode]}${options.writeMode === 'sync' && options.syncDeletes ? ', rows gone from the DBF are deleted' : ''}\n` +
            `-- Tables: ${tables.map(t => `${t.table} (${t.fileName}, ${t.rowCount} rows)`).join(', ')}\n\n` }
        for (const w of plan.warnings) yield { sql: `-- WARNING: ${w}\n` }
        for (const q of plan.quality) {
            yield { sql: `-- DATA ${q.effect === 'fail' ? 'ERROR' : 'LOSS'}: ${q.table}.${q.column}: ${q.problem} (${q.count} value(s))\n` }
        }
        // Values are escaped with backslashes, which NO_BACKSLASH_ESCAPES would turn into literal text.
        yield { sql: '\nSET NAMES utf8mb4;\n' +
            'SET @DBF_OLD_SQL_MODE = @@SESSION.sql_mode;\n' +
            "SET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '');\n" +
            'SET FOREIGN_KEY_CHECKS = 0;\n\n' }

        if (options.database) {
            const db = quoteIdent(options.database)
            yield { sql: `CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4 COLLATE ${TABLE_COLLATION};\nUSE ${db};\n\n` }
        }

        const sync = options.writeMode === 'sync'
        for (const table of tables) {
            yield { sql: this.createTableSql(table, options), table: table.table }
            if (options.includeData) {
                const upsert = sync && primaryKeyOf(table) !== undefined
                // Without a key there is no telling which row is which: empty the table and load it again.
                if (sync && !upsert) yield { sql: `DELETE FROM ${quoteIdent(table.table)};\n`, table: table.table, sync: 'reload' }
                yield* this.insertSql(table, options, 'live')
                if (upsert && options.syncDeletes) yield* this.syncDeleteSql(table, options)
            }
            if (table.deletedTable) {
                yield { sql: this.createDeletedTableSql(table, options), table: table.deletedTable }
                // The deleted copy is a snapshot of what is marked deleted now; record numbers move after PACK.
                if (sync) yield { sql: `DELETE FROM ${quoteIdent(table.deletedTable)};\n`, table: table.deletedTable, sync: 'reload' }
                yield* this.insertSql(table, options, 'deleted')
            }
        }

        if (plan.foreignKeys.length > 0) yield { sql: '-- Foreign keys\n', foreignKeys: true }
        for (const { name, child, parent } of plan.accepted) {
            const alter = `ALTER TABLE ${quoteIdent(child.table.table)} ADD CONSTRAINT ${quoteIdent(name)} ` +
                `FOREIGN KEY (${quoteIdent(child.column.column)}) ` +
                `REFERENCES ${quoteIdent(parent.table.table)} (${quoteIdent(parent.column.column)})`
            yield {
                sql: options.writeMode === 'replace' ? `${alter};\n` : unlessConstraintExists(child.table.table, name, alter),
                foreignKeys: true,
            }
        }
        for (const fk of plan.foreignKeys) {
            if (fk.status === 'skip')
                yield { sql: `-- skipped: ${fk.childTable}.${fk.childColumn} -> ${fk.parentTable}.${fk.parentColumn}: ${fk.reason}\n` }
        }

        yield { sql: '\nSET FOREIGN_KEY_CHECKS = 1;\nSET SESSION sql_mode = @DBF_OLD_SQL_MODE;\n' }
    }

    private createTableSql(table: TableSpec, options: MysqlExportOptions): string {
        const columns = active(table)
        const lines = columns.map(c =>
            `  ${quoteIdent(c.column)} ${c.mysqlType}` +
            (c.collation ? ` CHARACTER SET utf8mb4 COLLATE ${c.collation}` : '') +
            (c.nullable ? ' NULL' : ' NOT NULL') +
            ` COMMENT ${quoteString(`DBF ${describeField(c.field)}`)}`,
        )
        const primary = columns.filter(c => c.key === 'PRI')
        if (primary.length > 0) lines.push(`  PRIMARY KEY (${primary.map(c => quoteIdent(c.column)).join(', ')})`)
        for (const c of columns) {
            if (c.key === 'UNI') lines.push(`  UNIQUE KEY ${quoteIdent(`uq_${c.column}`.slice(0, MAX_IDENTIFIER))} (${quoteIdent(c.column)})`)
        }
        for (const ix of table.indexes) {
            if (ix.status === 'create')
                lines.push(`  KEY ${quoteIdent(ix.name)} (${ix.parts.map(indexColumnSql).join(', ')}) COMMENT ${quoteString(`CDX tag ${ix.tag.name}: ${ix.tag.expression}`.slice(0, 1024))}`)
        }

        return this.createSql(table.table, lines, `Imported from ${table.fileName}`, options)
    }

    /** Same columns as the table, all nullable and without keys, plus the record number. */
    private createDeletedTableSql(table: TableSpec, options: MysqlExportOptions): string {
        const lines = [
            `  ${quoteIdent(RECNO_COLUMN)} INT UNSIGNED NOT NULL COMMENT 'Record number in the DBF'`,
            ...active(table).map(c =>
                `  ${quoteIdent(c.column)} ${c.mysqlType} NULL COMMENT ${quoteString(`DBF ${describeField(c.field)}`)}`),
            `  PRIMARY KEY (${quoteIdent(RECNO_COLUMN)})`,
        ]
        return this.createSql(table.deletedTable!, lines, `Records marked deleted in ${table.fileName}`, options)
    }

    private createSql(table: string, lines: readonly string[], comment: string, options: MysqlExportOptions): string {
        const name = quoteIdent(table)
        const replace = options.writeMode === 'replace'
        return (replace ? `DROP TABLE IF EXISTS ${name};\n` : '') +
            `CREATE TABLE ${replace ? '' : 'IF NOT EXISTS '}${name} (\n${lines.join(',\n')}\n) ` +
            `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${TABLE_COLLATION} ` +
            `COMMENT=${quoteString(comment)};\n\n`
    }

    /**
     * INSERT batches for the live records (an upsert on the primary key in sync mode) or for the
     * records marked deleted (into <table>_deleted, with their record numbers).
     */
    private *insertSql(table: TableSpec, options: MysqlExportOptions, set: RecordSet): Generator<SqlChunk> {
        const columns = active(table)
        const deleted = set === 'deleted'
        const target = deleted ? table.deletedTable! : table.table
        const names = [...(deleted ? [RECNO_COLUMN] : []), ...columns.map(c => c.column)].map(quoteIdent)
        const pk = deleted ? undefined : primaryKeyOf(table)
        const upsert = options.writeMode === 'sync' && pk !== undefined

        const head = `INSERT INTO ${quoteIdent(target)} (${names.join(', ')}) VALUES\n`
        let tail = ''
        if (upsert) {
            const updates = columns.filter(c => c !== pk).map(c => `${quoteIdent(c.column)} = VALUES(${quoteIdent(c.column)})`)
            // A table that is nothing but its key still needs a no-op so the duplicate is not an error.
            tail = `\nON DUPLICATE KEY UPDATE ${updates.length > 0 ? updates.join(', ') : `${quoteIdent(pk.column)} = ${quoteIdent(pk.column)}`}`
        }

        let batch: string[] = []
        let batchChars = 0
        const flush = (): SqlChunk => {
            const chunk: SqlChunk = { sql: `${head}${batch.join(',\n')}${tail};\n`, table: target, rows: batch.length, sync: upsert ? 'upsert' : undefined }
            batch = []
            batchChars = 0
            return chunk
        }

        for (const record of iterateRecords(table.source, table.result.header, set)) {
            const values = columns.map(c =>
                sqlLiteral(c.kind, decodeValue(c, record, table, options.emptyStringsAsNull)))
            if (deleted) values.unshift(String(recordNumberOf(table.source, table.result.header, record)))
            const row = `(${values.join(', ')})`
            batch.push(row)
            batchChars += row.length
            if (batch.length >= INSERT_BATCH_ROWS || batchChars >= INSERT_BATCH_CHARS) yield flush()
        }
        if (batch.length > 0) yield flush()
        yield { sql: '\n' }
    }

    /**
     * Sync: deletes the MySQL rows whose primary key is not among the DBF's live records any more
     * (deleted or packed away in the old system). The live keys go to a temporary table first.
     */
    private *syncDeleteSql(table: TableSpec, options: MysqlExportOptions): Generator<SqlChunk> {
        const pk = primaryKeyOf(table)!
        const keys = quoteIdent(SYNC_KEYS_TABLE)
        yield {
            sql: `DROP TEMPORARY TABLE IF EXISTS ${keys};\n` +
                `CREATE TEMPORARY TABLE ${keys} (\`k\` ${pk.mysqlType}` +
                (pk.collation ? ` CHARACTER SET utf8mb4 COLLATE ${pk.collation}` : '') +
                ' NOT NULL, PRIMARY KEY (`k`)) ENGINE=InnoDB;\n',
            table: table.table,
        }
        let batch: string[] = []
        for (const record of iterateRecords(table.source, table.result.header)) {
            batch.push(`(${sqlLiteral(pk.kind, decodeValue(pk, record, table, options.emptyStringsAsNull))})`)
            if (batch.length >= INSERT_BATCH_ROWS * 4) {
                yield { sql: `INSERT INTO ${keys} (\`k\`) VALUES ${batch.join(', ')};\n`, table: table.table }
                batch = []
            }
        }
        if (batch.length > 0) yield { sql: `INSERT INTO ${keys} (\`k\`) VALUES ${batch.join(', ')};\n`, table: table.table }
        const t = quoteIdent(table.table)
        yield {
            sql: `DELETE ${t} FROM ${t} LEFT JOIN ${keys} AS \`s\` ON \`s\`.\`k\` = ${t}.${quoteIdent(pk.column)} WHERE \`s\`.\`k\` IS NULL;\n`,
            table: table.table,
            sync: 'delete',
        }
        yield { sql: `DROP TEMPORARY TABLE ${keys};\n\n`, table: table.table }
    }
}

const MODE_DESCRIPTION: Readonly<Record<MysqlExportOptions['writeMode'], string>> = {
    replace: 'replace (tables are dropped and created again)',
    append: 'append (missing tables are created, rows are added)',
    sync: 'sync (missing tables are created, new rows inserted, changed rows updated by primary key)',
}
