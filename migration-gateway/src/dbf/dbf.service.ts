import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import { parseDbfNative } from '../addon';
import { DbfSessionService } from './dbf-session.service';
import { DbfRelationshipService } from './dbf.relationship.service';
import { DBF_FILE_TYPES } from '../types/dbf-file-types.types';
import { DbfFileTypeByte, DbfTableFlags } from '../types/dbf-file-types.types';
import { DbfRecordCount } from '../types/dbf-field.types';
import { DbfParseResult } from '../types/dbf-result.types';
import { ParsedFileMap } from '../types/dbf-session.types';
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
}

export interface ParseMultipleResult{
    readonly sessionId: string
    readonly files: readonly DbfFilePreview[]
    readonly graph: DbfRelationshipGraph
}

@Injectable()
export class DbfService {
    private readonly logger = new Logger(DbfService.name)

    constructor(
        private readonly sessionService: DbfSessionService,
        private readonly relationShipService: DbfRelationshipService
    ) {}

    private parseSingle(file: UploadedDbfFile, previewRows: number): DbfParseResult {
        const tmpPath = path.join(
            os.tmpdir(),
            `dbf_${Date.now()}_${Math.random().toString(36).slice(2)}.dbf`
        )
        fs.writeFileSync(tmpPath, file.buffer)

        try {
            const raw = parseDbfNative(tmpPath, previewRows)
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
                totalRecords: rh.recordCount
            } 
        } finally {
            try { fs.unlinkSync(tmpPath) } catch { }
        }
    }

    parseMultipleFiles(
        files: UploadedDbfFile[],
        previewRows: number = 20
    ) : ParseMultipleResult {
        if(files.length === 0) 
            throw new BadRequestException('At least one .dbf file is required')
        
        if(files.length === 20)
            throw new BadRequestException('Maximu 20 files per session')
        

        const parsedMap: ParsedFileMap = new Map(
            files.map(file => {
                const fileName = toFileName(file.originalName.toUpperCase())
                this.logger.log(`Parsing: ${fileName} (${file.size}) bytes`)
                return [fileName, this.parseSingle(file, previewRows)] as const
            })
        )

        const session = this.sessionService.createSession(parsedMap)
        const graph = this.relationShipService.buildGraph(parsedMap, session.manualRels)

        const filePreview: DbfFilePreview[] = [...parsedMap.entries()].map(
            ([fileName, result]) => ({
                fileName,
                header: result.header,
                fieldsNames: result.header.fields.map(f => f.name),
                preview: result.preview,
                totalRecords: result.totalRecords,
            })
        )

        return { sessionId: session.id, files: filePreview, graph }
    }

    getSessionGraph(sessionId: string): DbfRelationshipGraph{
        const session = this.sessionService.getSession(toSessionId(sessionId))
        return this.relationShipService.buildGraph(session.files, session.manualRels)
    }
}
