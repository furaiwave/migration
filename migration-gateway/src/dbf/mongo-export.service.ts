import { Injectable } from '@nestjs/common'
import { Readable } from 'stream'
import { Binary, Decimal128, Double, Int32, Long, type Document } from 'mongodb'
import { indexParts } from '../cdx'
import { MysqlExportService, type DocumentColumn, type DocumentSource, type DocumentTable } from './mysql-export.service'
import type { DbfRelationship } from '../types/dbf-relationship.types'
import type { DbfSession } from '../types/dbf-session.types'
import type {
    BsonType,
    MongoCollectionPlan,
    MongoExportOptions,
    MongoExportPlan,
    MongoFieldPlan,
    MongoIndexPlan,
    MongoReferencePlan,
} from '../types/mongo-export.types'

/** Temporary collection holding the live keys while a sync looks for documents gone from the DBF. */
export const SYNC_KEYS_COLLECTION = '_dbf_sync_keys'
const BATCH_DOCS = 500
// Well under MongoDB's 48 MB message limit, counted roughly from the decoded values.
const BATCH_CHARS = 4 * 1024 * 1024
const MAX_INDEXES = 63 // 64 per collection, _id included
const MAX_INDEX_FIELDS = 32
const DELETE_BATCH = 1000

// ---------------------------------------------------------------- values

function bsonTypeOf(column: DocumentColumn): BsonType {
    const { length, decimalCount } = column.field
    switch (column.kind) {
        case 'text': case 'memoText': return 'string'
        case 'number':
            // N(len) holds at most len characters including the sign.
            if (decimalCount > 0) return 'decimal'
            return length <= 9 ? 'int' : length <= 18 ? 'long' : 'decimal'
        case 'date': case 'datetime': return 'date'
        case 'bool': return 'bool'
        case 'int32': return 'int'
        case 'double': return 'double'
        case 'currency': return 'decimal'
        case 'binary': case 'memoBinary': return 'binData'
    }
}

const INT32_MIN = -(2 ** 31)
const INT32_MAX = 2 ** 31 - 1
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

/** Canonical text from the decoder as a BSON value; numbers that do not fit their type stay exact as Decimal128. */
function toBson(type: BsonType, value: string | null): unknown {
    if (value === null) return null
    switch (type) {
        case 'string': return value
        case 'int': {
            const n = /^-?\d+$/.test(value) ? Number(value) : NaN
            return n >= INT32_MIN && n <= INT32_MAX ? new Int32(n) : Decimal128.fromString(value)
        }
        case 'long': {
            if (!/^-?\d+$/.test(value)) return Decimal128.fromString(value)
            const n = BigInt(value)
            return n >= INT64_MIN && n <= INT64_MAX ? Long.fromBigInt(n) : Decimal128.fromString(value)
        }
        case 'decimal': return Decimal128.fromString(value)
        case 'double': return new Double(Number(value))
        // DATE arrives as YYYY-MM-DD, DATETIME as YYYY-MM-DD HH:MM:SS; both are stored as UTC.
        case 'date': return new Date(value.length === 10 ? `${value}T00:00:00Z` : `${value.replace(' ', 'T')}Z`)
        case 'bool': return value === '1'
        case 'binData': return new Binary(Buffer.from(value, 'hex'))
    }
}

/** A BSON value as mongosh source text. */
function shellLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'null'
    if (typeof value === 'string') return JSON.stringify(value)
    if (typeof value === 'boolean') return String(value)
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null'
    if (value instanceof Int32) return `NumberInt(${value.value})`
    if (value instanceof Long) return `NumberLong(${JSON.stringify(value.toString())})`
    if (value instanceof Decimal128) return `NumberDecimal(${JSON.stringify(value.toString())})`
    if (value instanceof Double) return Number.isFinite(value.value) ? String(value.value) : 'null'
    if (value instanceof Date) return `ISODate(${JSON.stringify(value.toISOString())})`
    if (value instanceof Binary) return `BinData(0, ${JSON.stringify(Buffer.from(value.buffer).toString('base64'))})`
    if (Array.isArray(value)) return `[${value.map(shellLiteral).join(', ')}]`
    return `{ ${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${JSON.stringify(k)}: ${shellLiteral(v)}`).join(', ')} }`
}

const indexIdentifier = (raw: string): string =>
    raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'ix'

// ---------------------------------------------------------------- operations

/** One step of the export, run by the live import or written out as mongosh code. */
export type MongoOp = { readonly collection: string; readonly table?: string; readonly rows?: number } & (
    | { readonly op: 'drop' }
    | { readonly op: 'create' }
    | { readonly op: 'clear' }
    | { readonly op: 'insert'; readonly docs: readonly Document[] }
    | { readonly op: 'upsert'; readonly docs: readonly Document[] }
    | { readonly op: 'syncKeys'; readonly ids: readonly unknown[] }
    | { readonly op: 'syncDelete' }
    | { readonly op: 'index'; readonly name: string; readonly keys: Readonly<Record<string, 1 | -1>>; readonly unique: boolean }
)

interface IndexSpec {
    readonly plan: MongoIndexPlan
    readonly keys: Readonly<Record<string, 1 | -1>>
}

interface CollectionSpec {
    readonly table: DocumentTable
    readonly fields: readonly { readonly column: DocumentColumn; readonly type: BsonType }[]
    readonly id: { readonly column: DocumentColumn; readonly type: BsonType } | null
    readonly indexes: readonly IndexSpec[]
}

interface InternalPlan {
    readonly options: MongoExportOptions
    readonly collections: readonly CollectionSpec[]
    readonly references: readonly MongoReferencePlan[]
    readonly source: DocumentSource
    readonly warnings: readonly string[]
}

@Injectable()
export class MongoExportService {
    constructor(private readonly mysqlExport: MysqlExportService) {}

    plan(session: DbfSession, relationships: readonly DbfRelationship[], options: MongoExportOptions): MongoExportPlan {
        return this.toPublicPlan(this.buildPlan(session, relationships, options))
    }

    /** mongosh script, streamed: collections are read record by record. */
    exportScript(session: DbfSession, relationships: readonly DbfRelationship[], options: MongoExportOptions): Readable {
        return Readable.from(this.script(this.buildPlan(session, relationships, options)))
    }

    /** Plan plus the steps to run against a server. */
    operations(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MongoExportOptions,
    ): { plan: MongoExportPlan; ops: Iterable<MongoOp> } {
        const plan = this.buildPlan(session, relationships, options)
        return { plan: this.toPublicPlan(plan), ops: this.generateOps(plan) }
    }

    // ------------------------------------------------------------ plan

    private buildPlan(session: DbfSession, relationships: readonly DbfRelationship[], options: MongoExportOptions): InternalPlan {
        const source = this.mysqlExport.documentSource(session, relationships, options)
        const warnings = [...source.warnings]

        const collections = source.tables.map((table): CollectionSpec => {
            const fields = table.columns.filter(c => !c.excluded).map(column => ({ column, type: bsonTypeOf(column) }))
            const pk = fields.find(f => f.column.key === 'PRI') ?? null
            return { table, fields, id: pk, indexes: [] }
        })

        // A reference is the child keeping the parent's value; its index is what makes $lookup fast.
        const references: MongoReferencePlan[] = []
        const referenceIndexes = new Map<DocumentTable, { field: string; unique: boolean; note: string }[]>()
        const addIndex = (table: DocumentTable, field: string, unique: boolean, note: string) => {
            const list = referenceIndexes.get(table) ?? []
            if (!list.some(i => i.field === field)) list.push({ field, unique, note })
            referenceIndexes.set(table, list)
        }
        for (const fk of source.foreignKeys) {
            const link = source.links.find(l =>
                l.child.table.name === fk.childTable && l.child.column === fk.childColumn &&
                l.parent.table.name === fk.parentTable && l.parent.column === fk.parentColumn)
            if (fk.status !== 'create' || !link) {
                references.push({
                    childCollection: fk.childTable, childField: fk.childColumn,
                    parentCollection: fk.parentTable, parentField: fk.parentColumn,
                    source: fk.source, status: 'skip', reason: fk.reason,
                })
                continue
            }
            const parentIsId = link.parent.table.columns.find(c => c.name === link.parent.column)?.key === 'PRI'
            references.push({
                childCollection: fk.childTable, childField: fk.childColumn,
                parentCollection: fk.parentTable, parentField: parentIsId ? '_id' : fk.parentColumn,
                source: fk.source, status: 'create',
            })
            addIndex(link.child.table, link.child.column, false, `посилання на ${fk.parentTable}`)
            if (!parentIsId) addIndex(link.parent.table, link.parent.column, true, `на нього посилається ${fk.childTable}.${fk.childColumn}`)
        }

        const planned = collections.map(c => ({
            ...c,
            indexes: c.table.excluded ? [] : this.planIndexes(c, options, referenceIndexes.get(c.table) ?? []),
        }))

        if (options.writeMode === 'sync') {
            const keyless = planned.filter(c => !c.table.excluded && !c.id).map(c => c.table.name)
            if (keyless.length > 0)
                warnings.push(`Синхронізація: у колекціях ${keyless.join(', ')} немає _id з первинного ключа — вони очищаються й завантажуються заново під час кожної синхронізації. Виберіть первинний ключ у плані, щоб оновлювати документи за _id.`)
        }

        return { options, collections: planned, references, source, warnings }
    }

    /** The table's .CDX tags, then the indexes references need, as MongoDB indexes. */
    private planIndexes(
        collection: CollectionSpec,
        options: MongoExportOptions,
        forReferences: readonly { field: string; unique: boolean; note: string }[],
    ): IndexSpec[] {
        const { table, id } = collection
        const excluded = new Set(options.overrides[table.fileName]?.excludedIndexes ?? [])
        const out: IndexSpec[] = []
        // Key lists already indexed, with what indexes them.
        const covered = new Map<string, string>()
        if (id) covered.set(id.column.name, '_id')
        const taken = new Set<string>()
        const uniqueName = (base: string) => {
            let name = indexIdentifier(base)
            for (let i = 2; taken.has(name); i++) name = `${indexIdentifier(base).slice(0, 58)}_${i}`
            taken.add(name)
            return name
        }
        let created = 0

        for (const tag of options.indexes ? table.tags : []) {
            const base = { tag: tag.name, expression: tag.expression, filter: tag.filter, unique: false }
            if (tag.name === table.primaryTag) {
                out.push({ plan: { ...base, name: '_id_', keys: id ? [id.column.name] : [], status: 'primary', note: 'ключ-кандидат у FoxPro — його значення стали _id' }, keys: {} })
                continue
            }
            const skip = (note: string, keys: string[] = []) =>
                out.push({ plan: { ...base, name: '', keys, status: 'skip', note }, keys: {} })

            let parts: ReturnType<typeof indexParts>
            try {
                parts = indexParts(tag.expression, table.dbfFieldNames)
            } catch (err) {
                skip(`вираз не перетворюється для MongoDB: ${err instanceof Error ? err.message : String(err)}`)
                continue
            }
            if (parts.length === 0) {
                skip('вираз не використовує полів (лише DELETED() або константи)')
                continue
            }
            const keys: Record<string, 1 | -1> = {}
            let problem: string | null = null
            for (const p of parts) {
                const column = table.columns.find(c => c.field.name === p.field)
                if (!column) problem = `${p.field} не має поля в MongoDB`
                else if (column.excluded) problem = `${column.name} виключено з експорту`
                if (problem || !column) break
                keys[column.name] = tag.descending ? -1 : 1
            }
            const keyList = Object.entries(keys).map(([k, d]) => (d === -1 ? `${k} -1` : k))
            if (problem) {
                skip(problem, keyList)
                continue
            }
            if (excluded.has(tag.name)) {
                out.push({ plan: { ...base, name: '', keys: keyList, status: 'excluded' }, keys: {} })
                continue
            }
            if (keyList.length > MAX_INDEX_FIELDS) {
                skip(`полів: ${keyList.length} — MongoDB дозволяє не більше ${MAX_INDEX_FIELDS} в одному індексі`, keyList)
                continue
            }
            const signature = Object.keys(keys).join(',')
            const same = covered.get(signature)
            if (same) {
                skip(`ті самі поля, що й ${same}`, keyList)
                continue
            }
            if (created >= MAX_INDEXES) {
                skip(`MongoDB дозволяє не більше ${MAX_INDEXES + 1} індексів на колекцію`, keyList)
                continue
            }
            const name = uniqueName(`ix_${tag.name}`)
            covered.set(signature, `індекс ${name}`)
            created++
            const notes = [
                parts.some(p => p.prefix) && 'LEFT()/SUBSTR() у FoxPro — MongoDB індексує поле повністю',
                tag.filter && `FOR ${tag.filter} не переноситься — MongoDB індексує всі документи`,
                tag.candidate && 'ключ-кандидат у FoxPro — тут звичайний індекс, бо _id інший',
                tag.unique && 'UNIQUE у FoxPro лише пропускає повтори ключа — тут звичайний індекс',
            ].filter(Boolean)
            out.push({ plan: { ...base, name, keys: keyList, status: 'create', note: notes.length > 0 ? notes.join('; ') : undefined }, keys })
        }

        for (const ref of forReferences) {
            // An index that starts with the field serves the lookup just as well.
            const served = [...covered.keys()].some(sig => sig === ref.field || (!ref.unique && sig.startsWith(`${ref.field},`)))
            if (served || created >= MAX_INDEXES) continue
            const name = uniqueName(`${ref.unique ? 'uq' : 'ref'}_${ref.field}`)
            covered.set(ref.field, `індекс ${name}`)
            created++
            out.push({
                plan: { tag: null, expression: null, filter: null, name, keys: [ref.field], unique: ref.unique, status: 'create', note: ref.note },
                keys: { [ref.field]: 1 },
            })
        }
        return out
    }

    private toPublicPlan(plan: InternalPlan): MongoExportPlan {
        return {
            database: plan.options.database ?? null,
            collections: plan.collections.map((c): MongoCollectionPlan => ({
                fileName: c.table.fileName,
                collection: c.table.name,
                rowCount: c.table.rowCount,
                deletedRows: c.table.deletedCount,
                deletedCollection: c.table.deletedName,
                idField: c.id?.column.name ?? null,
                sync: c.id ? 'upsert' : 'reload',
                indexFile: c.table.indexFile,
                indexes: c.indexes.map(ix => ix.plan),
                encoding: c.table.encoding,
                memoFile: c.table.memoFile,
                excluded: c.table.excluded,
                skippedFields: c.table.skippedFields,
                fields: c.table.columns.map((column): MongoFieldPlan => ({
                    dbfField: column.field.name,
                    dbfType: column.field.type,
                    length: column.field.length,
                    decimals: column.field.decimalCount,
                    field: column.name,
                    bsonType: bsonTypeOf(column),
                    isId: !column.excluded && column === c.id?.column,
                    excluded: column.excluded,
                    note: column.note,
                })),
            })),
            references: plan.references,
            quality: plan.source.quality,
            warnings: plan.warnings,
        }
    }

    // ------------------------------------------------------------ operations

    private *generateOps(plan: InternalPlan): Generator<MongoOp> {
        const { options } = plan
        const collections = plan.collections.filter(c => !c.table.excluded)
        const replace = options.writeMode === 'replace'
        const sync = options.writeMode === 'sync'

        for (const c of collections) {
            const name = c.table.name
            yield { op: replace ? 'drop' : 'create', collection: name, table: name }
            if (replace) yield { op: 'create', collection: name, table: name }
            if (options.includeData) {
                const upsert = sync && c.id !== null
                // Without _id from a key there is no telling which document is which: empty and reload.
                if (sync && !upsert) yield { op: 'clear', collection: name, table: name }
                yield* this.dataOps(c, 'live', upsert ? 'upsert' : 'insert')
                if (upsert && options.syncDeletes) yield* this.syncDeleteOps(c)
            }
            const deleted = c.table.deletedName
            if (deleted) {
                yield { op: replace ? 'drop' : 'create', collection: deleted, table: deleted }
                if (replace) yield { op: 'create', collection: deleted, table: deleted }
                // A snapshot of what is marked deleted now; record numbers move after PACK.
                if (sync) yield { op: 'clear', collection: deleted, table: deleted }
                yield* this.dataOps(c, 'deleted', 'insert')
            }
        }

        // Indexes go last: building them over loaded data is faster than updating them row by row.
        for (const c of collections) {
            for (const ix of c.indexes) {
                if (ix.plan.status === 'create')
                    yield { op: 'index', collection: c.table.name, name: ix.plan.name, keys: ix.keys, unique: ix.plan.unique }
            }
        }
    }

    private document(c: CollectionSpec, set: 'live' | 'deleted', recno: number, values: readonly (string | null)[]): Document {
        const doc: Document = {}
        if (set === 'deleted') doc._id = new Int32(recno)
        else if (c.id) doc._id = toBson(c.id.type, values[c.fields.indexOf(c.id)] ?? null)
        c.fields.forEach((f, i) => { doc[f.column.name] = toBson(f.type, values[i] ?? null) })
        return doc
    }

    private *dataOps(c: CollectionSpec, set: 'live' | 'deleted', op: 'insert' | 'upsert'): Generator<MongoOp> {
        const collection = set === 'live' ? c.table.name : c.table.deletedName!
        let docs: Document[] = []
        let chars = 0
        for (const { recno, values } of c.table.records(set)) {
            docs.push(this.document(c, set, recno, values))
            chars += values.reduce((n, v) => n + (v?.length ?? 4) + 8, 0)
            if (docs.length >= BATCH_DOCS || chars >= BATCH_CHARS) {
                yield { op, collection, table: collection, rows: docs.length, docs }
                docs = []
                chars = 0
            }
        }
        if (docs.length > 0) yield { op, collection, table: collection, rows: docs.length, docs }
    }

    /** Live keys go to a temporary collection; documents whose _id is not there are deleted. */
    private *syncDeleteOps(c: CollectionSpec): Generator<MongoOp> {
        const id = c.id!
        const index = c.fields.indexOf(id)
        const name = c.table.name
        yield { op: 'drop', collection: SYNC_KEYS_COLLECTION, table: name }
        let ids: unknown[] = []
        for (const { values } of c.table.records('live')) {
            ids.push(toBson(id.type, values[index] ?? null))
            if (ids.length >= BATCH_DOCS * 4) {
                yield { op: 'syncKeys', collection: SYNC_KEYS_COLLECTION, table: name, ids }
                ids = []
            }
        }
        if (ids.length > 0) yield { op: 'syncKeys', collection: SYNC_KEYS_COLLECTION, table: name, ids }
        yield { op: 'syncDelete', collection: name, table: name }
    }

    // ------------------------------------------------------------ mongosh script

    private *script(plan: InternalPlan): Generator<string> {
        const { options } = plan
        const collections = plan.collections.filter(c => !c.table.excluded)
        const mode = {
            replace: 'заміна (колекції видаляються й створюються заново)',
            append: 'дописування (документи додаються до наявних колекцій)',
            sync: `синхронізація (документи замінюються за _id${options.syncDeletes ? ', документи, яких уже немає в DBF, видаляються' : ''})`,
        }[options.writeMode]

        yield '// Скрипт mongosh, створений dbf inspector\n' +
            `// ${new Date().toISOString()}\n` +
            `// Режим: ${mode}\n` +
            `// Колекції: ${collections.map(c => `${c.table.name} (${c.table.fileName}, документів: ${c.table.rowCount})`).join(', ')}\n` +
            `// Запуск: mongosh "mongodb://localhost:27017" ${options.database ?? 'dbf_export'}.js\n\n`
        for (const w of plan.warnings) yield `// ПОПЕРЕДЖЕННЯ: ${w.replace(/\n/g, ' ')}\n`
        for (const q of plan.source.quality)
            yield `// ${q.effect === 'fail' ? 'ПОМИЛКА ДАНИХ' : 'ВТРАТА ДАНИХ'}: ${q.table}.${q.column}: ${q.problem} (значень: ${q.count})\n`

        yield `\nconst target = ${options.database ? `db.getSiblingDB(${JSON.stringify(options.database)})` : 'db'};\n` +
            'const collection = (name) => target.getCollection(name);\n\n'

        let current: string | undefined
        for (const op of this.generateOps(plan)) {
            if (op.table && op.table !== current && op.op !== 'index') {
                current = op.table
                yield `\nprint(${JSON.stringify(`→ ${current}`)});\n`
            }
            yield shellOp(op)
        }
        yield '\nprint("Готово.");\n'
    }
}

function shellOp(op: MongoOp): string {
    const c = `collection(${JSON.stringify(op.collection)})`
    switch (op.op) {
        case 'drop': return `${c}.drop();\n`
        case 'create': return `if (!target.getCollectionNames().includes(${JSON.stringify(op.collection)})) target.createCollection(${JSON.stringify(op.collection)});\n`
        case 'clear': return `${c}.deleteMany({});\n`
        case 'insert': return `${c}.insertMany([\n${op.docs.map(shellLiteral).join(',\n')}\n], { ordered: true });\n`
        case 'upsert':
            return `${c}.bulkWrite([\n${op.docs.map(d =>
                `{ replaceOne: { filter: { _id: ${shellLiteral(d._id)} }, replacement: ${shellLiteral(d)}, upsert: true } }`).join(',\n')}\n], { ordered: false });\n`
        case 'syncKeys': return `${c}.insertMany([${op.ids.map(id => `{ _id: ${shellLiteral(id)} }`).join(', ')}]);\n`
        case 'syncDelete':
            return '{\n' +
                `  const gone = ${c}.aggregate([\n` +
                `    { $lookup: { from: ${JSON.stringify(SYNC_KEYS_COLLECTION)}, localField: "_id", foreignField: "_id", as: "k" } },\n` +
                '    { $match: { k: { $size: 0 } } }, { $project: { _id: 1 } },\n' +
                '  ]).toArray().map(d => d._id);\n' +
                `  for (let i = 0; i < gone.length; i += ${DELETE_BATCH}) ${c}.deleteMany({ _id: { $in: gone.slice(i, i + ${DELETE_BATCH}) } });\n` +
                `  collection(${JSON.stringify(SYNC_KEYS_COLLECTION)}).drop();\n` +
                `  print(${JSON.stringify(`  видалено документів, яких немає в DBF: `)} + gone.length);\n` +
                '}\n'
        case 'index':
            return `${c}.createIndex(${shellLiteral(op.keys)}, { name: ${JSON.stringify(op.name)}${op.unique ? ', unique: true' : ''} });\n`
    }
}

export const MONGO_DELETE_BATCH = DELETE_BATCH
