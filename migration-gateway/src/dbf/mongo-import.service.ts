import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { randomUUID } from 'crypto'
import { MongoClient, type Binary, type Db, type Decimal128, type Double, type Int32, type Long } from 'mongodb'
import { MongoExportService, MONGO_DELETE_BATCH, SYNC_KEYS_COLLECTION, type MongoOp } from './mongo-export.service'
import type { DbfRelationship } from '../types/dbf-relationship.types'
import type { DbfSession } from '../types/dbf-session.types'
import type {
    MongoConnectionInfo,
    MongoConnectionInput,
    MongoExportOptions,
    MongoExportPlan,
    MongoImportProgress,
    MongoImportResult,
    MongoImportStatus,
    MongoSyncCounts,
} from '../types/mongo-export.types'

const CONNECT_TIMEOUT_MS = 8000
const JOB_TTL_MS = 60 * 60 * 1000

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** The connection string without its password, for logs and messages. */
const safeUri = (uri: string): string => uri.replace(/\/\/[^@/]*@/, '//***@')

/** MongoDB / network errors as a sentence for the UI. */
function describeMongoError(err: unknown, input: MongoConnectionInput): string {
    const e = err as { name?: string; code?: number; codeName?: string; message?: string }
    if (e.name === 'MongoParseError' || e.name === 'MongoInvalidArgumentError')
        return `Некоректний рядок підключення: ${e.message ?? ''}`
    if (e.name === 'MongoServerSelectionError' || e.name === 'MongoNetworkError' || e.name === 'MongoNetworkTimeoutError')
        return `Не вдається підключитися до MongoDB (${safeUri(input.uri)}) — чи запущено сервер і чи правильна адреса?`
    if (e.code === 18 || e.codeName === 'AuthenticationFailed')
        return 'MongoDB не прийняв логін або пароль з рядка підключення'
    if (e.code === 13 || e.codeName === 'Unauthorized')
        return `Користувачу MongoDB бракує прав: ${e.message ?? ''}`
    return `MongoDB: ${e.message ?? String(err)}${e.codeName ? ` (${e.codeName})` : ''}`
}

function hintFor(err: unknown, options: MongoExportOptions): string | null {
    const code = (err as { code?: number }).code
    if (code === 11000) {
        return options.writeMode === 'append'
            ? 'Колекція вже містить документи з такими _id — виберіть «Замінити колекції» або «Синхронізувати» замість «Дописати документи».'
            : 'У даних є повторювані значення в полі з унікальним індексом.'
    }
    if (code === 85 || code === 86)
        return 'Індекс із такою назвою вже є, але з іншими полями — виберіть «Замінити колекції» або видаліть його вручну.'
    return null
}

interface ImportJob {
    readonly id: string
    readonly database: string
    readonly startedAt: number
    state: MongoImportStatus['state']
    progress: Mutable<Omit<MongoImportProgress, 'elapsedMs'>>
    result?: MongoImportResult
    error?: string
    cancelRequested: boolean
    finishedAt?: number
}

class ImportCancelled extends Error {}

/** What a primary key can turn into (see toBson). */
type DocumentId = string | boolean | Date | Int32 | Long | Decimal128 | Double | Binary | null

interface AnyIdDocument {
    _id?: DocumentId
    [field: string]: unknown
}

@Injectable()
export class MongoImportService {
    private readonly logger = new Logger(MongoImportService.name)
    private readonly jobs = new Map<string, ImportJob>()

    constructor(private readonly exportService: MongoExportService) {}

    async testConnection(input: MongoConnectionInput): Promise<MongoConnectionInfo> {
        const client = await this.connect(input)
        try {
            const admin = client.db('admin')
            const info = await admin.command({ buildInfo: 1 })
            // Listing databases needs a privilege a database-scoped user may not have.
            const databases = await admin.command({ listDatabases: 1, nameOnly: true })
                .then(r => (r.databases as { name: string }[]).map(d => d.name))
                .catch(() => [])
            return { serverVersion: String(info.version ?? 'unknown'), databases }
        } catch (err) {
            throw new BadRequestException(describeMongoError(err, input))
        } finally {
            await client.close()
        }
    }

    async startImport(
        session: DbfSession,
        relationships: readonly DbfRelationship[],
        options: MongoExportOptions,
        input: MongoConnectionInput,
    ): Promise<MongoImportStatus> {
        if (!options.database)
            throw new BadRequestException('Вкажіть назву бази даних для імпорту')

        const { plan, ops } = this.exportService.operations(session, relationships, options)
        const blocking = plan.quality.filter(q => q.effect === 'fail')
        if (blocking.length > 0) {
            const list = blocking.slice(0, 3).map(q => `${q.table}.${q.column}: ${q.problem}`).join('; ')
            throw new BadRequestException(
                `Проблем у даних, через які MongoDB відхилить імпорт: ${blocking.length} — спершу виправте їх у плані (${list}${blocking.length > 3 ? '; …' : ''})`)
        }

        const client = await this.connect(input)
        const collections = plan.collections.filter(c => !c.excluded)
        const withDeleted = collections.filter(c => c.deletedCollection !== null)
        const job: ImportJob = {
            id: randomUUID(),
            database: options.database,
            startedAt: Date.now(),
            state: 'running',
            cancelRequested: false,
            progress: {
                phase: 'collections',
                collectionIndex: 0,
                collectionCount: collections.length + withDeleted.length,
                collection: null,
                collectionRowsDone: 0,
                collectionRows: 0,
                rowsDone: 0,
                rowsTotal: options.includeData
                    ? collections.reduce((n, c) => n + c.rowCount, 0) + withDeleted.reduce((n, c) => n + c.deletedRows, 0)
                    : 0,
                indexesDone: 0,
                indexesTotal: collections.reduce((n, c) => n + c.indexes.filter(ix => ix.status === 'create').length, 0),
            },
        }
        this.forgetOldJobs()
        this.jobs.set(job.id, job)
        void this.run(job, plan, ops, client, options, input, session.id)
        return this.statusOf(job)
    }

    getStatus(jobId: string): MongoImportStatus {
        const job = this.jobs.get(jobId)
        if (!job) throw new NotFoundException('Імпорт не знайдено — він завершився понад годину тому або бекенд перезапускався')
        return this.statusOf(job)
    }

    /** Stops after the operation in flight; collections loaded so far stay in MongoDB. */
    cancel(jobId: string): MongoImportStatus {
        const job = this.jobs.get(jobId)
        if (!job) throw new NotFoundException('Імпорт не знайдено')
        if (job.state === 'running') job.cancelRequested = true
        return this.statusOf(job)
    }

    private async run(
        job: ImportJob,
        plan: MongoExportPlan,
        ops: Iterable<MongoOp>,
        client: MongoClient,
        options: MongoExportOptions,
        input: MongoConnectionInput,
        sessionId: string,
    ): Promise<void> {
        const db = client.db(job.database)
        const collections = plan.collections.filter(c => !c.excluded)
        const rowCounts = new Map(collections.flatMap(c => [
            [c.collection, c.rowCount] as const,
            ...(c.deletedCollection ? [[c.deletedCollection, c.deletedRows] as const] : []),
        ]))
        const p = job.progress
        const done: string[] = []
        const finish = () => {
            if (p.collection && !done.includes(p.collection)) done.push(p.collection)
        }
        const sync = options.writeMode === 'sync'
        const counts = new Map<string, Mutable<MongoSyncCounts>>()
        const countsOf = (name: string) => {
            let c = counts.get(name)
            if (!c) counts.set(name, c = { inserted: 0, updated: 0, unchanged: 0, deleted: 0, reloaded: false })
            return c
        }

        try {
            for (const op of ops) {
                if (job.cancelRequested) throw new ImportCancelled()
                if (op.op === 'index') {
                    if (p.phase !== 'indexes') {
                        finish()
                        p.phase = 'indexes'
                    }
                } else if (op.table && op.table !== p.collection) {
                    finish()
                    p.collection = op.table
                    p.collectionIndex++
                    p.collectionRowsDone = 0
                    p.collectionRows = options.includeData ? rowCounts.get(op.table) ?? 0 : 0
                }
                await this.apply(db, op, sync ? countsOf : null)
                if (op.op === 'index') p.indexesDone++
                if (op.rows) {
                    p.collectionRowsDone += op.rows
                    p.rowsDone += op.rows
                }
            }
            finish()

            p.phase = 'verifying'
            const verified: Mutable<MongoImportResult['collections'][number]>[] = []
            const verify = async (fileName: string, name: string, role: 'table' | 'deleted', expectedRows: number) => {
                verified.push({
                    fileName,
                    collection: name,
                    role,
                    expectedRows: options.includeData ? expectedRows : 0,
                    importedRows: await db.collection(name).countDocuments({}),
                    sync: sync ? countsOf(name) : undefined,
                })
            }
            for (const c of collections) {
                await verify(c.fileName, c.collection, 'table', c.rowCount)
                if (c.deletedCollection) await verify(c.fileName, c.deletedCollection, 'deleted', c.deletedRows)
            }

            const info = await client.db('admin').command({ buildInfo: 1 })
            job.result = {
                database: job.database,
                serverVersion: String(info.version ?? 'unknown'),
                durationMs: Date.now() - job.startedAt,
                writeMode: options.writeMode,
                syncDeletes: options.syncDeletes,
                collections: verified,
                indexesCreated: p.indexesDone,
                warnings: plan.warnings,
            }
            job.state = 'done'
            this.logger.log(`Imported session ${sessionId} into ${safeUri(input.uri)}/${job.database} (${options.writeMode}) in ${job.result.durationMs} ms`)
        } catch (err) {
            const partial = p.phase === 'collections' && p.collection && !done.includes(p.collection) && p.collectionRowsDone > 0
                ? ` Колекцію "${p.collection}" завантажено частково (${p.collectionRowsDone.toLocaleString('uk-UA')} з ${p.collectionRows.toLocaleString('uk-UA')} документів).`
                : ''
            const kept = (done.length > 0 ? ` Уже завантажені колекції залишаються в "${job.database}": ${done.join(', ')}.` : '') + partial
            if (err instanceof ImportCancelled) {
                job.state = 'cancelled'
                job.error = `Імпорт скасовано.${kept}`
            } else {
                const hint = hintFor(err, options)
                const where = p.phase === 'indexes' ? ' Збій під час створення індексів.' : p.collection ? ` Збій на колекції "${p.collection}".` : ''
                job.state = 'failed'
                job.error = `${describeMongoError(err, input)}.${where}${hint ? ` ${hint}` : ''}${kept}`
            }
            this.logger.warn(`Import ${job.id} ${job.state}: ${job.error}`)
        } finally {
            job.finishedAt = Date.now()
            await client.close().catch(() => { /* already closed */ })
        }
    }

    private async apply(db: Db, op: MongoOp, countsOf: ((name: string) => Mutable<MongoSyncCounts>) | null): Promise<void> {
        // _id is whatever the primary key holds (number, text, date), not an ObjectId.
        const collection = db.collection<AnyIdDocument>(op.collection)
        switch (op.op) {
            case 'drop':
                await collection.drop().catch((err: { codeName?: string }) => {
                    if (err.codeName !== 'NamespaceNotFound') throw err
                })
                return
            case 'create': {
                const exists = await db.listCollections({ name: op.collection }, { nameOnly: true }).hasNext()
                if (!exists) await db.createCollection(op.collection)
                return
            }
            case 'clear':
                await collection.deleteMany({})
                if (countsOf) countsOf(op.collection).reloaded = true
                return
            case 'insert':
                await collection.insertMany([...op.docs], { ordered: true })
                if (countsOf) countsOf(op.collection).inserted += op.docs.length
                return
            case 'upsert': {
                const result = await collection.bulkWrite(
                    op.docs.map(d => ({ replaceOne: { filter: { _id: d._id as DocumentId }, replacement: d, upsert: true } })),
                    { ordered: false })
                if (countsOf) {
                    const c = countsOf(op.collection)
                    c.inserted += result.upsertedCount
                    c.updated += result.modifiedCount
                    c.unchanged += result.matchedCount - result.modifiedCount
                }
                return
            }
            case 'syncKeys':
                await collection.insertMany(op.ids.map(id => ({ _id: id as DocumentId })), { ordered: false })
                return
            case 'syncDelete': {
                const gone = await collection.aggregate<{ _id: DocumentId }>([
                    { $lookup: { from: SYNC_KEYS_COLLECTION, localField: '_id', foreignField: '_id', as: 'k' } },
                    { $match: { k: { $size: 0 } } },
                    { $project: { _id: 1 } },
                ]).toArray()
                for (let i = 0; i < gone.length; i += MONGO_DELETE_BATCH) {
                    const result = await collection.deleteMany({ _id: { $in: gone.slice(i, i + MONGO_DELETE_BATCH).map(d => d._id) } })
                    if (countsOf) countsOf(op.collection).deleted += result.deletedCount
                }
                await db.collection(SYNC_KEYS_COLLECTION).drop().catch(() => { /* already gone */ })
                return
            }
            case 'index':
                await collection.createIndex({ ...op.keys }, { name: op.name, unique: op.unique })
                return
        }
    }

    private statusOf(job: ImportJob): MongoImportStatus {
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

    private async connect(input: MongoConnectionInput): Promise<MongoClient> {
        try {
            const client = new MongoClient(input.uri, {
                serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
                connectTimeoutMS: CONNECT_TIMEOUT_MS,
                appName: 'dbf-inspector',
            })
            await client.connect()
            return client
        } catch (err) {
            throw new BadRequestException(describeMongoError(err, input))
        }
    }
}
