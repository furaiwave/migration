import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { Readable } from 'stream'
import { encodingFromCodePage, isSupportedEncoding, iterateRecords } from '../addon'
import { transliterate } from '../translit'
import { decodeMemoText, memoBlockOf, openMemo, VFP_TYPE_BYTES, type MemoReader } from '../memo'
import type { DbfFieldDescriptor } from '../types/dbf-field.types'
import type { DbfParseResult } from '../types/dbf-result.types'
import type { DbfSession } from '../types/dbf-session.types'
import type { DbfRelationship, FileName, RelationshipKind } from '../types/dbf-relationship.types'
import type {
    MysqlColumnKey,
    MysqlExportOptions,
    MysqlExportPlan,
    MysqlForeignKeyPlan,
} from '../types/mysql-export.types'

const NULL_FLAGS_FIELD_TYPE = '0' // Visual FoxPro system field (_NullFlags)
const INSERT_BATCH_ROWS = 500
// Keeps each INSERT well under MySQL's default max_allowed_packet (64 MB) even with large memos.
const INSERT_BATCH_CHARS = 4 * 1024 * 1024
const MAX_IDENTIFIER = 64
const TABLE_COLLATION = 'utf8mb4_unicode_ci'
// Key columns compare byte-for-byte, the same way uniqueness is checked here.
const KEY_COLLATION = 'utf8mb4_bin'
const JULIAN_UNIX_EPOCH = 2440588
const MS_PER_DAY = 86_400_000

/** How raw field bytes turn into a SQL value. */
type ValueKind =
    | 'text' | 'number' | 'date' | 'datetime' | 'bool'
    | 'int32' | 'double' | 'currency' | 'binary' | 'memoText' | 'memoBinary'

/** Columns may only reference each other within the same family. */
type KeyFamily = 'numeric' | 'text' | 'date' | null

interface FieldMapping {
    readonly kind: ValueKind
    readonly mysqlType: string
    readonly family: KeyFamily
}

function mapField(field: DbfFieldDescriptor, isVfp: boolean): FieldMapping | null {
    const { type, length, decimalCount } = field
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

const pad = (n: number): string => String(n).padStart(2, '0')

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

/** Visual FoxPro DateTime: Julian day number + milliseconds since midnight. */
function decodeDateTime(slice: Buffer): string | null {
    const julianDay = slice.readInt32LE(0)
    if (julianDay <= 0) return null
    const date = new Date((julianDay - JULIAN_UNIX_EPOCH) * MS_PER_DAY + slice.readInt32LE(4))
    const year = date.getUTCFullYear()
    if (Number.isNaN(year) || year < 1000 || year > 9999) return null
    return `${year}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
        `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
}

/** Visual FoxPro Currency: int64 scaled by 10 000. */
function decodeCurrency(slice: Buffer): string {
    const raw = slice.readBigInt64LE(0)
    const abs = raw < 0n ? -raw : raw
    return `${raw < 0n ? '-' : ''}${abs / 10000n}.${String(abs % 10000n).padStart(4, '0')}`
}

interface ColumnSpec {
    readonly field: DbfFieldDescriptor
    readonly kind: ValueKind
    readonly family: KeyFamily
    readonly column: string
    readonly note?: string
    mysqlType: string
    collation: string | null
    nullable: boolean
    key: MysqlColumnKey
}

interface DecodeContext {
    readonly decoder: TextDecoder
    readonly memo: MemoReader | null
}

/** Field value as unquoted canonical text (hex for binary), or null for SQL NULL. */
function decodeValue(
    column: ColumnSpec,
    record: Buffer,
    { decoder, memo }: DecodeContext,
    emptyStringsAsNull: boolean,
): string | null {
    const start = column.field.offset as number
    const slice = record.subarray(start, start + column.field.length)

    switch (column.kind) {
        case 'text': {
            const s = decoder.decode(slice).replace(/\0+$/, '').trimEnd()
            return s === '' && emptyStringsAsNull ? null : s
        }
        case 'number':
            return normalizeNumber(slice.toString('latin1').trim())
        case 'date':
            return decodeDate(slice.toString('latin1').trim())
        case 'datetime':
            return decodeDateTime(slice)
        case 'bool': {
            const c = String.fromCharCode(slice[0] ?? 0x20)
            if ('TtYy'.includes(c)) return '1'
            if ('FfNn'.includes(c)) return '0'
            return null
        }
        case 'int32':
            return String(slice.readInt32LE(0))
        case 'double': {
            const v = slice.readDoubleLE(0)
            return Number.isFinite(v) ? String(v) : null
        }
        case 'currency':
            return decodeCurrency(slice)
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

// ---------------------------------------------------------------- plan

interface TableSpec {
    readonly fileName: FileName
    readonly table: string
    readonly result: DbfParseResult
    readonly source: Buffer
    readonly encoding: string
    readonly decoder: TextDecoder
    readonly memo: MemoReader | null
    readonly memoFile: string | null
    readonly rowCount: number
    readonly columns: readonly ColumnSpec[]
    readonly skippedFields: readonly string[]
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

function countLiveRecords(source: Buffer, header: DbfParseResult['header']): number {
    let n = 0
    for (const _ of iterateRecords(source, header)) n++
    return n
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
        return Readable.from(this.generateSql(this.buildPlan(session, relationships, options)))
    }

    /** Plan plus the dump split into executable pieces, for running straight against a server. */
    statements(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MysqlExportOptions,
    ): { plan: MysqlExportPlan; chunks: Iterable<string> } {
        const plan = this.buildPlan(session, relationships, options)
        return { plan: this.toPublicPlan(plan), chunks: this.generateSql(plan) }
    }

    private toPublicPlan(plan: InternalPlan): MysqlExportPlan {
        return {
            database: plan.options.database ?? null,
            tables: plan.tables.map(t => ({
                fileName: t.fileName,
                table: t.table,
                rowCount: t.rowCount,
                encoding: t.encoding,
                memoFile: t.memoFile,
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
                    note: c.note,
                })),
            })),
            foreignKeys: plan.foreignKeys,
            warnings: plan.warnings,
        }
    }

    private buildPlan(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MysqlExportOptions,
    ): InternalPlan {
        const encodingOverride = options.encoding === 'auto' ? null : options.encoding
        if (encodingOverride !== null && !isSupportedEncoding(encodingOverride))
            throw new BadRequestException(`Unsupported encoding: ${encodingOverride}`)

        const warnings: string[] = []
        const takenTables = new Set<string>()
        const tables: TableSpec[] = []

        for (const [fileName, result] of session.files) {
            const source = session.sources.get(fileName)
            if (!source) throw new NotFoundException(`Source bytes missing for ${fileName}`)

            const isVfp = VFP_TYPE_BYTES.has(result.header.typeByte)
            const memo = source.memo ? openMemo(source.memo.buffer, source.memo.format) : null
            const encoding = encodingOverride ?? result.encoding
            const takenColumns = new Set<string>()
            const columns: ColumnSpec[] = []
            const skippedFields: string[] = []

            for (const field of result.header.fields) {
                if ((field.type as string) === NULL_FLAGS_FIELD_TYPE) continue
                const mapping = mapField(field, isVfp)
                if (!mapping) {
                    skippedFields.push(describeField(field))
                    continue
                }
                columns.push({
                    field,
                    kind: mapping.kind,
                    family: mapping.family,
                    column: uniqueName(toIdentifier(field.name, 'column'), takenColumns),
                    note: isMemoKind(mapping.kind)
                        ? source.memo ? `from ${source.memo.fileName}` : 'memo file (.fpt/.dbt) not uploaded — exported as NULL'
                        : undefined,
                    mysqlType: mapping.mysqlType,
                    collation: null,
                    nullable: true,
                    key: null,
                })
            }

            if (columns.length === 0) {
                warnings.push(`${fileName}: no exportable fields, table left out`)
                continue
            }
            if (skippedFields.length > 0)
                warnings.push(`${fileName}: fields with no MySQL equivalent are left out — ${skippedFields.join(', ')}`)
            if (!memo && columns.some(c => isMemoKind(c.kind)))
                warnings.push(`${fileName}: memo fields are exported as NULL — upload ${fileName.replace(/\.dbf$/i, '')}.FPT (or .DBT) together with the table to carry them over`)
            if (encodingOverride === null && encodingFromCodePage(result.header.codePage) === null && columns.some(c => c.kind === 'text'))
                warnings.push(`${fileName}: no code page mark — encoding detected from the text as ${encoding}. If the preview looks wrong, choose the encoding manually.`)

            tables.push({
                fileName,
                table: uniqueName(toIdentifier(fileName.replace(/\.dbf$/i, ''), 'table'), takenTables),
                result,
                source: source.dbf,
                encoding,
                decoder: new TextDecoder(encoding),
                memo,
                memoFile: source.memo?.fileName ?? null,
                rowCount: countLiveRecords(source.dbf, result.header),
                columns,
                skippedFields,
            })
        }

        const { foreignKeys, accepted } = options.foreignKeys
            ? this.planForeignKeys(tables, relationships, options)
            : { foreignKeys: [], accepted: [] }

        return { options, tables, foreignKeys, accepted, warnings }
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

        type Endpoint = NonNullable<ReturnType<typeof resolve>>
        const candidates: { rel: DbfRelationship; source: Endpoint; target: Endpoint }[] = []
        const foreignKeys: MysqlForeignKeyPlan[] = []
        // Same naming as created keys (MySQL table.column), falling back to DBF names when unresolved.
        const displayName = (file: string, field: string) => {
            const table = byFile.get(file)
            const column = table?.columns.find(c => c.field.name === field)
            return { table: table?.table ?? file, column: column?.column ?? field }
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
                skipRaw(rel, `field ${missing} does not exist or is not exported`)
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

        const accepted: AcceptedForeignKey[] = []
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
            seenLinks.add(linkKey)

            if (parent.column.key === null) {
                const hasPrimary = parent.table.columns.some(c => c.key === 'PRI')
                if (!hasPrimary && !parentStats.hasNull) {
                    parent.column.key = 'PRI'
                    parent.column.nullable = false
                } else {
                    parent.column.key = 'UNI'
                }
            }
            if (parent.column.family === 'text') {
                parent.column.collation = KEY_COLLATION
                child.column.collation = KEY_COLLATION
            }

            const name = uniqueName(toIdentifier(`fk_${base.childTable}_${base.childColumn}`, 'fk'), takenNames)
            accepted.push({ name, child, parent })
            foreignKeys.push({ ...base, name, status: 'create' })
        }

        // InnoDB wants identical integer types on both ends; repeat so chains settle.
        for (let changed = true, guard = 0; changed && guard < 10; guard++) {
            changed = false
            for (const { child, parent } of accepted) {
                if (child.column.family === 'numeric' && child.column.mysqlType !== parent.column.mysqlType) {
                    child.column.mysqlType = parent.column.mysqlType
                    changed = true
                }
            }
        }

        // Keys that will exist first; skipped ones after, each group in detection order.
        foreignKeys.sort((a, b) => Number(a.status === 'skip') - Number(b.status === 'skip'))
        return { foreignKeys, accepted }
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

    // ------------------------------------------------------------ SQL

    private *generateSql(plan: InternalPlan): Generator<string> {
        const { options } = plan

        yield `-- MySQL dump generated by dbf inspector\n` +
            `-- ${new Date().toISOString()}\n` +
            `-- Tables: ${plan.tables.map(t => `${t.table} (${t.fileName}, ${t.rowCount} rows)`).join(', ')}\n\n`
        for (const w of plan.warnings) yield `-- WARNING: ${w}\n`
        // Values are escaped with backslashes, which NO_BACKSLASH_ESCAPES would turn into literal text.
        yield '\nSET NAMES utf8mb4;\n' +
            'SET @DBF_OLD_SQL_MODE = @@SESSION.sql_mode;\n' +
            "SET SESSION sql_mode = REPLACE(@@SESSION.sql_mode, 'NO_BACKSLASH_ESCAPES', '');\n" +
            'SET FOREIGN_KEY_CHECKS = 0;\n\n'

        if (options.database) {
            const db = quoteIdent(options.database)
            yield `CREATE DATABASE IF NOT EXISTS ${db} CHARACTER SET utf8mb4 COLLATE ${TABLE_COLLATION};\nUSE ${db};\n\n`
        }

        for (const table of plan.tables) {
            yield this.createTableSql(table, options)
            if (options.includeData) yield* this.insertSql(table, options)
        }

        if (plan.foreignKeys.length > 0) yield '-- Foreign keys\n'
        for (const { name, child, parent } of plan.accepted) {
            yield `ALTER TABLE ${quoteIdent(child.table.table)} ADD CONSTRAINT ${quoteIdent(name)} ` +
                `FOREIGN KEY (${quoteIdent(child.column.column)}) ` +
                `REFERENCES ${quoteIdent(parent.table.table)} (${quoteIdent(parent.column.column)});\n`
        }
        for (const fk of plan.foreignKeys) {
            if (fk.status === 'skip')
                yield `-- skipped: ${fk.childTable}.${fk.childColumn} -> ${fk.parentTable}.${fk.parentColumn}: ${fk.reason}\n`
        }

        yield '\nSET FOREIGN_KEY_CHECKS = 1;\nSET SESSION sql_mode = @DBF_OLD_SQL_MODE;\n'
    }

    private createTableSql(table: TableSpec, options: MysqlExportOptions): string {
        const name = quoteIdent(table.table)
        const lines = table.columns.map(c =>
            `  ${quoteIdent(c.column)} ${c.mysqlType}` +
            (c.collation ? ` CHARACTER SET utf8mb4 COLLATE ${c.collation}` : '') +
            (c.nullable ? ' NULL' : ' NOT NULL') +
            ` COMMENT ${quoteString(`DBF ${describeField(c.field)}`)}`,
        )
        const primary = table.columns.filter(c => c.key === 'PRI')
        if (primary.length > 0) lines.push(`  PRIMARY KEY (${primary.map(c => quoteIdent(c.column)).join(', ')})`)
        for (const c of table.columns) {
            if (c.key === 'UNI') lines.push(`  UNIQUE KEY ${quoteIdent(`uq_${c.column}`.slice(0, MAX_IDENTIFIER))} (${quoteIdent(c.column)})`)
        }

        return (options.dropExisting ? `DROP TABLE IF EXISTS ${name};\n` : '') +
            `CREATE TABLE ${options.dropExisting ? '' : 'IF NOT EXISTS '}${name} (\n${lines.join(',\n')}\n) ` +
            `ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=${TABLE_COLLATION} ` +
            `COMMENT=${quoteString(`Imported from ${table.fileName}`)};\n\n`
    }

    private *insertSql(table: TableSpec, options: MysqlExportOptions): Generator<string> {
        const head = `INSERT INTO ${quoteIdent(table.table)} (${table.columns.map(c => quoteIdent(c.column)).join(', ')}) VALUES\n`
        let batch: string[] = []
        let batchChars = 0

        for (const record of iterateRecords(table.source, table.result.header)) {
            const values = table.columns.map(c =>
                sqlLiteral(c.kind, decodeValue(c, record, table, options.emptyStringsAsNull)))
            const row = `(${values.join(', ')})`
            batch.push(row)
            batchChars += row.length
            if (batch.length >= INSERT_BATCH_ROWS || batchChars >= INSERT_BATCH_CHARS) {
                yield `${head}${batch.join(',\n')};\n`
                batch = []
                batchChars = 0
            }
        }
        if (batch.length > 0) yield `${head}${batch.join(',\n')};\n`
        yield '\n'
    }
}
