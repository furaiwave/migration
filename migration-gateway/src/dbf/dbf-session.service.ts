import { Injectable, NotFoundException, Logger, BadRequestException, type OnModuleInit } from "@nestjs/common"
import { randomUUID } from "crypto"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { parseTable } from "./dbf-parse"
import type { MemoFormat } from "../memo"
import type { DbfSession, DbfSource, ParsedFileMap, SourceFileMap } from "../types/dbf-session.types"
import type { SessionId, ManualRelationship, AddManualRelationShipDto, DbfRelationship, FileName } from "../types/dbf-relationship.types"
import { relationshipId, toFileName, toSessionId } from "../types/dbf-relationship.types"

// Sessions live on disk so a backend restart (nest start --watch restarts on every save) loses nothing.
// Memory only holds the ones in use; the disk copy is the source of truth until it expires.
const SESSION_ROOT = process.env.DBF_SESSION_DIR ?? path.join(os.tmpdir(), 'dbf-inspector-sessions')
const MEMORY_IDLE_MS = 30 * 60 * 1000
const DISK_IDLE_MS = 24 * 60 * 60 * 1000
const TOUCH_EVERY_MS = 60 * 1000
const META_FILE = 'session.json'
// Ids end up in file paths; anything but a UUID is refused before touching the disk.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

interface StoredFile {
    readonly fileName: string
    readonly dbf: string
    readonly memo: { readonly fileName: string; readonly format: MemoFormat; readonly path: string } | null
    /** Absent in sessions stored before index files were accepted. */
    readonly index?: { readonly fileName: string; readonly path: string } | null
}

/** session.json: everything needed to rebuild a session from the files next to it. */
interface StoredSession {
    readonly version: 1
    readonly id: string
    readonly createdAt: string
    readonly previewRows: number
    readonly files: readonly StoredFile[]
    readonly manualRels: readonly DbfRelationship[]
    readonly disabledRels: readonly string[]
    readonly encodings: Readonly<Record<string, string>>
}

const sessionDir = (id: string): string => path.join(SESSION_ROOT, id)

@Injectable()
export class DbfSessionService implements OnModuleInit {
    private readonly logger = new Logger(DbfSessionService.name)

    private readonly store = new Map<SessionId, DbfSession>()
    private readonly lastUsed = new Map<SessionId, number>()
    /** Layout of each session's files on disk, written once at upload. */
    private readonly layouts = new Map<SessionId, readonly StoredFile[]>()

    onModuleInit(): void {
        this.sweepDisk()
    }

    createSession(files: ParsedFileMap, sources: SourceFileMap, previewRows: number): DbfSession {
        this.evictIdle()
        const id: SessionId = toSessionId(randomUUID())
        const session: DbfSession = {
            id,
            createdAt: new Date(),
            files,
            sources,
            manualRels: [],
            disabledRels: new Set(),
            encodings: new Map(),
            previewRows,
        }
        this.store.set(id, session)
        this.lastUsed.set(id, Date.now())
        this.writeFiles(session)
        this.logger.log(`Session created: ${id} | files: ${files.size}`)
        return session
    }

    getSession(id: SessionId): DbfSession {
        const session = this.store.get(id) ?? this.restore(id)
        const now = Date.now()
        const previous = this.lastUsed.get(id) ?? 0
        this.lastUsed.set(id, now)
        if(now - previous > TOUCH_EVERY_MS) this.touch(id)
        return session
    }

    addManualRelationship(dto: AddManualRelationShipDto): DbfSession {
        const session = this.getSession(dto.sessionId)

        if(!session.files.has(dto.sourceFile))
            throw new NotFoundException(`File not in session: ${dto.sourceFile}`)
        if(!session.files.has(dto.targetFile))
            throw new NotFoundException(`File not in session: ${dto.targetFile}`)

        const rel: ManualRelationship = {
            kind: 'manual',
            sourceFile: dto.sourceFile,
            sourceField: dto.sourceField,
            targetFile: dto.targetFile,
            targetField: dto.targetField,
            label: dto.label
        }
        if(session.manualRels.some(r => relationshipId(r) === relationshipId(rel)))
            throw new BadRequestException('This link already exists')

        return this.save({ ...session, manualRels: [...session.manualRels, rel] })
    }

    /** Switches a link off (kept in the list, left out of the export) or back on. */
    setRelationshipDisabled(id: SessionId, relId: string, disabled: boolean): DbfSession {
        const session = this.getSession(id)
        const disabledRels = new Set(session.disabledRels)
        if(disabled) disabledRels.add(relId)
        else disabledRels.delete(relId)
        return this.save({ ...session, disabledRels })
    }

    /** Removes a link the user added; detected links can only be disabled. */
    deleteManualRelationship(id: SessionId, relId: string): DbfSession {
        const session = this.getSession(id)
        const manualRels = session.manualRels.filter(r => relationshipId(r) !== relId)
        if(manualRels.length === session.manualRels.length)
            throw new NotFoundException('Manual link not found — detected links can be disabled, not deleted')
        const disabledRels = new Set(session.disabledRels)
        disabledRels.delete(relId)
        return this.save({ ...session, manualRels, disabledRels })
    }

    /** Re-reads one table with another encoding (null = back to code page mark / detection). */
    setFileEncoding(id: SessionId, fileName: FileName, encoding: string | null): DbfSession {
        const session = this.getSession(id)
        const source = session.sources.get(fileName)
        if(!source) throw new NotFoundException(`File not in session: ${fileName}`)

        const result = parseTable(fileName, source.dbf, source.memo, source.index, session.previewRows, encoding)
        const files = new Map(session.files)
        files.set(fileName, result)
        const encodings = new Map(session.encodings)
        if(encoding) encodings.set(fileName, encoding)
        else encodings.delete(fileName)
        return this.save({ ...session, files, encodings })
    }

    deleteSession(id: SessionId): void {
        this.store.delete(id)
        this.lastUsed.delete(id)
        this.layouts.delete(id)
        if(SESSION_ID.test(id)) fs.rmSync(sessionDir(id), { recursive: true, force: true })
        this.logger.log(`Session deleted: ${id}`)
    }

    // ------------------------------------------------------------ persistence

    private save(session: DbfSession): DbfSession {
        this.store.set(session.id, session)
        this.writeMeta(session)
        return session
    }

    /** Uploaded bytes go to disk once; later changes only rewrite session.json. */
    private writeFiles(session: DbfSession): void {
        try {
            const dir = path.join(sessionDir(session.id), 'tables')
            fs.mkdirSync(dir, { recursive: true })
            const layout: StoredFile[] = []
            let n = 0
            for(const [fileName, source] of session.sources){
                const dbf = path.join('tables', `${n}.dbf`)
                fs.writeFileSync(path.join(sessionDir(session.id), dbf), source.dbf)
                let memo: StoredFile['memo'] = null
                if(source.memo){
                    const memoPath = path.join('tables', `${n}.memo`)
                    fs.writeFileSync(path.join(sessionDir(session.id), memoPath), source.memo.buffer)
                    memo = { fileName: source.memo.fileName, format: source.memo.format, path: memoPath }
                }
                let index: StoredFile['index'] = null
                if(source.index){
                    const indexPath = path.join('tables', `${n}.cdx`)
                    fs.writeFileSync(path.join(sessionDir(session.id), indexPath), source.index.buffer)
                    index = { fileName: source.index.fileName, path: indexPath }
                }
                layout.push({ fileName, dbf, memo, index })
                n++
            }
            this.layouts.set(session.id, layout)
            this.writeMeta(session)
        } catch(err) {
            // The session still works from memory; it just will not survive a restart.
            this.logger.warn(`Could not store session ${session.id} on disk: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    private writeMeta(session: DbfSession): void {
        const files = this.layouts.get(session.id)
        if(!files) return
        const meta: StoredSession = {
            version: 1,
            id: session.id,
            createdAt: session.createdAt.toISOString(),
            previewRows: session.previewRows,
            files,
            manualRels: session.manualRels,
            disabledRels: [...session.disabledRels],
            encodings: Object.fromEntries(session.encodings),
        }
        try {
            const target = path.join(sessionDir(session.id), META_FILE)
            // Write-then-rename, so a crash mid-write never leaves a half-written session.json.
            fs.writeFileSync(`${target}.tmp`, JSON.stringify(meta))
            fs.renameSync(`${target}.tmp`, target)
        } catch(err) {
            this.logger.warn(`Could not update session ${session.id} on disk: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    private restore(id: SessionId): DbfSession {
        const gone = new NotFoundException(`Session not found: ${id} — it may have expired, upload the files again`)
        if(!SESSION_ID.test(id)) throw gone

        const metaPath = path.join(sessionDir(id), META_FILE)
        let meta: StoredSession
        try {
            if(Date.now() - fs.statSync(metaPath).mtimeMs > DISK_IDLE_MS){
                this.deleteSession(id)
                throw gone
            }
            meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')) as StoredSession
        } catch {
            throw gone
        }

        const read = (relative: string): Buffer => fs.readFileSync(path.join(sessionDir(id), relative))
        const sources = new Map<FileName, DbfSource>()
        const files = new Map<FileName, ReturnType<typeof parseTable>>()
        for(const f of meta.files){
            const fileName = toFileName(f.fileName)
            const source: DbfSource = {
                dbf: read(f.dbf),
                memo: f.memo ? { fileName: f.memo.fileName, format: f.memo.format, buffer: read(f.memo.path) } : null,
                index: f.index ? { fileName: f.index.fileName, buffer: read(f.index.path) } : null,
            }
            sources.set(fileName, source)
            files.set(fileName, parseTable(fileName, source.dbf, source.memo, source.index, meta.previewRows, meta.encodings[fileName] ?? null))
        }

        const session: DbfSession = {
            id,
            createdAt: new Date(meta.createdAt),
            files,
            sources,
            manualRels: meta.manualRels,
            disabledRels: new Set(meta.disabledRels),
            encodings: new Map(Object.entries(meta.encodings).map(([k, v]) => [toFileName(k), v])),
            previewRows: meta.previewRows,
        }
        this.store.set(id, session)
        this.layouts.set(id, meta.files)
        this.logger.log(`Session restored from disk: ${id} | files: ${files.size}`)
        return session
    }

    /** Keeps the disk copy alive while the session is being used. */
    private touch(id: SessionId): void {
        try {
            const now = new Date()
            fs.utimesSync(path.join(sessionDir(id), META_FILE), now, now)
        } catch { /* not stored on disk; nothing to keep alive */ }
    }

    private evictIdle(): void {
        const cutoff = Date.now() - MEMORY_IDLE_MS
        for(const [id, at] of this.lastUsed){
            if(at < cutoff){
                // Only memory is freed; the session comes back from disk on its next request.
                this.store.delete(id)
                this.lastUsed.delete(id)
                this.layouts.delete(id)
            }
        }
        this.sweepDisk()
    }

    private sweepDisk(): void {
        let entries: string[]
        try {
            entries = fs.readdirSync(SESSION_ROOT)
        } catch {
            return
        }
        const cutoff = Date.now() - DISK_IDLE_MS
        for(const name of entries){
            if(!SESSION_ID.test(name)) continue
            try {
                if(fs.statSync(path.join(SESSION_ROOT, name, META_FILE)).mtimeMs < cutoff){
                    fs.rmSync(path.join(SESSION_ROOT, name), { recursive: true, force: true })
                    this.logger.log(`Session expired: ${name}`)
                }
            } catch {
                // A folder without session.json is a failed upload; clear it too.
                fs.rmSync(path.join(SESSION_ROOT, name), { recursive: true, force: true })
            }
        }
    }
}
