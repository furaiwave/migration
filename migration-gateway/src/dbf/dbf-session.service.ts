import { Injectable, NotFoundException, Logger } from "@nestjs/common"
import { randomUUID } from "crypto"
import type { DbfSession, ParsedFileMap, SourceFileMap } from "../types/dbf-session.types"
import type { SessionId, ManualRelationship, AddManualRelationShipDto } from "../types/dbf-relationship.types"
import { toSessionId } from "../types/dbf-relationship.types"

// Sessions hold every uploaded file in memory; forget the ones nobody has touched for a while.
const SESSION_IDLE_MS = 2 * 60 * 60 * 1000

@Injectable()
export class DbfSessionService {
    private readonly logger = new Logger(DbfSessionService.name)

    private readonly store = new Map<SessionId, DbfSession>()
    private readonly lastUsed = new Map<SessionId, number>()

    createSession(files: ParsedFileMap, sources: SourceFileMap): DbfSession {
        this.evictIdle()
        const id: SessionId = toSessionId(randomUUID())
        const session: DbfSession = {
            id, 
            createdAt: new Date(),
            files,
            sources,
            manualRels: [],
        }
        this.store.set(id, session)
        this.lastUsed.set(id, Date.now())
        this.logger.log(`Session created: ${id} | files: ${files.size}`)
        return session
    }

    getSession(id: SessionId): DbfSession {
        const session = this.store.get(id)
        if(!session) throw new NotFoundException(`Session not found: ${id} — it may have expired, upload the files again`)
        this.lastUsed.set(id, Date.now())
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

        const updated: DbfSession = {
            ...session,
            manualRels: [...session.manualRels, rel]
        }

        this.store.set(session.id, updated)
        return updated
    }

    deleteSession(id: SessionId): void {
        this.store.delete(id)
        this.lastUsed.delete(id)
        this.logger.log(`Session deleted: ${id}`)
    }

    private evictIdle(): void {
        const cutoff = Date.now() - SESSION_IDLE_MS
        for(const [id, at] of this.lastUsed){
            if(at < cutoff){
                this.store.delete(id)
                this.lastUsed.delete(id)
                this.logger.log(`Session expired: ${id}`)
            }
        }
    }
}