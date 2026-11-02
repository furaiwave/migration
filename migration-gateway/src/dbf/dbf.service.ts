import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { parseDbfBuffer } from '../addon';
import { memoFormatOf, openMemo } from '../memo';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import { DBF_FILE_TYPES } from '../types/dbf-file-types.types';
import { DbfFileTypeByte, DbfTableFlags } from '../types/dbf-file-types.types';
import { DbfRecordCount } from '../types/dbf-field.types';
import { DbfParseResult } from '../types/dbf-result.types';
import { MemoSource, ParsedFileMap, SourceFileMap } from '../types/dbf-session.types';
import { DbfRelationshipGraph } from '../types/dbf-relationship.types';
import { toFileName, toSessionId } from '../types/dbf-relationship.types';

export interface UploadedDbfFile{
    readonly originalName: string
    readonly buffer: Buffer
    readonly size: number
}

export interface DbfFilePreview{
    readonly fileName: string
    readonly header: DbfParseResult['header']
    readonly fieldsNames: string[]
    readonly preview: ReadonlyArray<Readonly<Record<string, string>>>
    readonly totalRecords: number
    readonly encoding: string
    readonly memoFile: string | null
}

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

    private parseSingle(file: UploadedDbfFile, memo: MemoSource | null, previewRows: number): DbfParseResult {
        try {
            const reader = memo ? openMemo(memo.buffer, memo.format) : null
            const raw = parseDbfBuffer(file.buffer, previewRows, reader)
            const rh = raw.header

            const tableFlags: DbfTableFlags = {
                hasStructuralCdx: (rh.tableFlagsByte & 0x01) !== 0,
                hasMemoField: (rh.tableFlagsByte & 0x02) !== 0,
                isDatabase: (rh.tableFlagsByte & 0x04) !== 0
            }

            const typeByte = rh.typeByte satisfies DbfFileTypeByte
            const fieldNames = rh.fields.map(f => f.name)

            return {
                header: {
                    typeByte,
                    typeName: DBF_FILE_TYPES[typeByte],
                    hasMemo: tableFlags.hasMemoField as DbfParseResult['header']['hasMemo'],
                    lastUpdate: { year: rh.lastUpdateYear, month: rh.lastUpdateMonth, day: rh.lastUpdateDay},
                    recordCount: rh.recordCount as DbfRecordCount,
                    firstRecordOffset: rh.firstRecordOffset,
                    recordLength: rh.recordLength,
                    tableFlags,
                    codePage: rh.codePage,
                    fields: rh.fields
                },

                preview: raw.preview.map(row => Object.fromEntries(fieldNames.map((name, i) => [name, row[i] ?? '']))),
                totalRecords: raw.liveRecords,
                encoding: raw.encoding,
                memoFile: memo?.fileName ?? null,
            }
        } catch (err) {
            throw new BadRequestException(`${file.originalName}: ${err instanceof Error ? err.message : String(err)}`)
        }
    }

    parseMultipleFiles(
        files: UploadedDbfFile[],
        previewRows: number = 20
    ) : ParseMultipleResult {
        const dbfFiles = files.filter(f => /\.dbf$/i.test(f.originalName))
        if(dbfFiles.length === 0)
            throw new BadRequestException('At least one .dbf file is required')

        if(dbfFiles.length > 20)
            throw new BadRequestException('Maximum 20 .dbf files per session')

        // A memo file belongs to the table with the same base name: CLIENTS.FPT ↔ CLIENTS.DBF.
        const memoByBase = new Map<string, MemoSource>()
        for(const f of files){
            const format = memoFormatOf(f.originalName)
            if(format) memoByBase.set(baseName(f.originalName), { fileName: f.originalName.toUpperCase(), format, buffer: f.buffer })
        }
        const dbfBases = new Set(dbfFiles.map(f => baseName(f.originalName)))
        const orphanMemos = [...memoByBase.entries()].filter(([base]) => !dbfBases.has(base)).map(([, m]) => m.fileName)
        if(orphanMemos.length > 0)
            throw new BadRequestException(`No matching .dbf for memo file(s): ${orphanMemos.join(', ')}`)

        const named = dbfFiles.map(file => [
            toFileName(file.originalName.toUpperCase()),
            file,
            memoByBase.get(baseName(file.originalName)) ?? null,
        ] as const)

        const parsedMap: ParsedFileMap = new Map(
            named.map(([fileName, file, memo]) => {
                this.logger.log(`Parsing: ${fileName} (${file.size} bytes)${memo ? ` + ${memo.fileName}` : ''}`)
                return [fileName, this.parseSingle(file, memo, previewRows)] as const
            })
        )
        const sources: SourceFileMap = new Map(
            named.map(([fileName, file, memo]) => [fileName, { dbf: file.buffer, memo }] as const)
        )

        const session = this.sessionService.createSession(parsedMap, sources)
        const graph = this.relationShipService.buildGraph(parsedMap, session.manualRels)

        const filePreview: DbfFilePreview[] = [...parsedMap.entries()].map(
            ([fileName, result]) => ({
                fileName,
                header: result.header,
                fieldsNames: result.header.fields.map(f => f.name),
                preview: result.preview,
                totalRecords: result.totalRecords,
                encoding: result.encoding,
                memoFile: result.memoFile,
            })
        )

        return { sessionId: session.id, files: filePreview, graph }
    }

    getSessionGraph(sessionId: string): DbfRelationshipGraph{
        const session = this.sessionService.getSession(toSessionId(sessionId))
        return this.relationShipService.buildGraph(session.files, session.manualRels)
    }
}
