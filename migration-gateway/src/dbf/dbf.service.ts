import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { memoFormatOf } from '../memo';
import { cdxFileOf } from '../cdx';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import { parseTable, toPreview, type DbfFilePreview } from './dbf-parse';
import { IndexSource, MemoSource, ParsedFileMap, SourceFileMap } from '../types/dbf-session.types';
import { DbfRelationshipGraph } from '../types/dbf-relationship.types';
import { toFileName, toSessionId } from '../types/dbf-relationship.types';

export interface UploadedDbfFile{
    readonly originalName: string
    readonly buffer: Buffer
    readonly size: number
}

export type { DbfFilePreview } from './dbf-parse';

/** Maximum DBF tables per session; accompanying memo and index files are counted separately. */
export const MAX_TABLES = 30

export interface ParseMultipleResult{
    readonly sessionId: string
    readonly files: readonly DbfFilePreview[]
    readonly graph: DbfRelationshipGraph
}

const baseName = (fileName: string): string => fileName.replace(/\.[^.]+$/, '').toUpperCase()

@Injectable()
export class DbfService {
    private readonly logger = new Logger(DbfService.name)

    constructor(
        private readonly sessionService: DbfSessionService,
        private readonly relationShipService: DbfRelationshipService
    ) {}

    parseMultipleFiles(
        files: UploadedDbfFile[],
        previewRows: number = 20
    ) : ParseMultipleResult {
        const dbfFiles = files.filter(f => /\.dbf$/i.test(f.originalName))
        if(dbfFiles.length === 0)
            throw new BadRequestException('Потрібен хоча б один файл .dbf')

        if(dbfFiles.length > MAX_TABLES)
            throw new BadRequestException(`Не більше ${MAX_TABLES} файлів .dbf в одній сесії`)

        const seenNames = new Set<string>()
        for(const f of dbfFiles){
            const name = f.originalName.toUpperCase()
            if(seenNames.has(name)) throw new BadRequestException(`Дві таблиці мають назву ${name} — завантажте їх в окремих сесіях`)
            seenNames.add(name)
        }

        // Side files belong to the table with the same base name: CLIENTS.FPT / CLIENTS.CDX ↔ CLIENTS.DBF.
        const memoByBase = new Map<string, MemoSource>()
        const indexByBase = new Map<string, IndexSource>()
        for(const f of files){
            const format = memoFormatOf(f.originalName)
            if(format) memoByBase.set(baseName(f.originalName), { fileName: f.originalName.toUpperCase(), format, buffer: f.buffer })
            if(cdxFileOf(f.originalName)) indexByBase.set(baseName(f.originalName), { fileName: f.originalName.toUpperCase(), buffer: f.buffer })
        }
        const dbfBases = new Set(dbfFiles.map(f => baseName(f.originalName)))
        const orphans = [...memoByBase.entries(), ...indexByBase.entries()].filter(([base]) => !dbfBases.has(base)).map(([, m]) => m.fileName)
        if(orphans.length > 0)
            throw new BadRequestException(`Немає відповідного .dbf для: ${orphans.join(', ')}`)

        const named = dbfFiles.map(file => [
            toFileName(file.originalName.toUpperCase()),
            file,
            memoByBase.get(baseName(file.originalName)) ?? null,
            indexByBase.get(baseName(file.originalName)) ?? null,
        ] as const)

        const parsedMap: ParsedFileMap = new Map(
            named.map(([fileName, file, memo, index]) => {
                const extras = [memo?.fileName, index?.fileName].filter(Boolean).map(n => ` + ${n}`).join('')
                this.logger.log(`Parsing: ${fileName} (${file.size} bytes)${extras}`)
                return [fileName, parseTable(fileName, file.buffer, memo, index, previewRows, null)] as const
            })
        )
        const sources: SourceFileMap = new Map(
            named.map(([fileName, file, memo, index]) => [fileName, { dbf: file.buffer, memo, index }] as const)
        )

        const session = this.sessionService.createSession(parsedMap, sources, previewRows)
        const graph = this.relationShipService.buildGraph(parsedMap, session.manualRels, session.disabledRels)

        const filePreview: DbfFilePreview[] = [...parsedMap.entries()].map(([fileName, result]) => toPreview(fileName, result))

        return { sessionId: session.id, files: filePreview, graph }
    }

    getSessionGraph(sessionId: string): DbfRelationshipGraph{
        const session = this.sessionService.getSession(toSessionId(sessionId))
        return this.relationShipService.buildGraph(session.files, session.manualRels, session.disabledRels)
    }
}
