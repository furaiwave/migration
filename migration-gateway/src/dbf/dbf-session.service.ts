import { Injectable, NotFoundException, Logger, NotImplementedException } from "@nestjs/common"
import { randomUUID } from "crypto"
import type { DbfSession, ParsedFileMap } from "../types/dbf-session.types"
import type { SessionId, ManualRelationship, AddManualRelationShipDto } from "../types/dbf-relationship.types"
import { toSessionId } from "../types/dbf-relationship.types"

@Injectable()
export class DbfSessionService {
    private readonly logger = new Logger(DbfSessionService.name)

    private readonly store = new Map<SessionId, DbfSession>()
    createSession(files: ParsedFileMap): DbfSession {
        const id: SessionId = toSessionId(randomUUID())
        const session: DbfSession = {
            id, 
            createdAt: new Date(),
            files,
            manualRels: [],
        }
        this.store.set(id, session)
        this.logger.log(`Session created: ${id} | files: ${files.size}`)
        return session
    }

    getSession(id: SessionId): DbfSession {
        const session = this.store.get(id)
        if(!session) throw new NotFoundException(`Session not found: ${id}`)
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
        this.logger.log(`Session deleted: ${id}`)
    }
}