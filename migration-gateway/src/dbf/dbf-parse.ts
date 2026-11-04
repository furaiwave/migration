import { BadRequestException } from '@nestjs/common'
import { parseDbfBuffer } from '../addon'
import { openMemo } from '../memo'
import { readCdxTags } from '../cdx'
import { createDecoder } from '../codepages'
import { DBF_FILE_TYPES, type DbfFileTypeByte, type DbfTableFlags } from '../types/dbf-file-types.types'
import type { DbfRecordCount } from '../types/dbf-field.types'
import type { DbfIndexInfo, DbfParseResult } from '../types/dbf-result.types'
import type { IndexSource, MemoSource } from '../types/dbf-session.types'

/** What the client gets for one table: header, a few rows and how its text is decoded. */
export interface DbfFilePreview {
    readonly fileName: string
    readonly header: DbfParseResult['header']
    readonly fieldsNames: string[]
    readonly preview: ReadonlyArray<Readonly<Record<string, string | null>>>
    readonly totalRecords: number
    readonly encoding: string
    readonly encodingSource: DbfParseResult['encodingSource']
    readonly memoFile: string | null
    readonly index: DbfIndexInfo | null
}

/** A broken .CDX only costs the indexes, so it is reported instead of failing the upload. */
function readIndex(index: IndexSource, encoding: string): DbfIndexInfo {
    try {
        return { fileName: index.fileName, tags: readCdxTags(index.buffer, createDecoder(encoding)), error: null }
    } catch (err) {
        return { fileName: index.fileName, tags: [], error: err instanceof Error ? err.message : String(err) }
    }
}

/**
 * Parses one uploaded table (plus its memo and index files). Used on upload, when the user picks
 * another encoding, and when a session is restored from disk after a restart.
 */
export function parseTable(
    fileName: string,
    dbf: Buffer,
    memo: MemoSource | null,
    index: IndexSource | null,
    previewRows: number,
    encoding: string | null,
): DbfParseResult {
    try {
        const reader = memo ? openMemo(memo.buffer, memo.format) : null
        const raw = parseDbfBuffer(dbf, previewRows, reader, encoding)
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
                lastUpdate: { year: rh.lastUpdateYear, month: rh.lastUpdateMonth, day: rh.lastUpdateDay },
                recordCount: rh.recordCount as DbfRecordCount,
                firstRecordOffset: rh.firstRecordOffset,
                recordLength: rh.recordLength,
                tableFlags,
                codePage: rh.codePage,
                fields: rh.fields
            },
            // null is a Visual FoxPro NULL and must reach the client as such; only a missing cell is ''.
            preview: raw.preview.map(row => Object.fromEntries(fieldNames.map((name, i) => [name, row[i] === undefined ? '' : row[i]]))),
            totalRecords: raw.liveRecords,
            encoding: raw.encoding,
            encodingSource: raw.encodingSource,
            memoFile: memo?.fileName ?? null,
            index: index ? readIndex(index, raw.encoding) : null,
        }
    } catch (err) {
        throw new BadRequestException(`${fileName}: ${err instanceof Error ? err.message : String(err)}`)
    }
}

export function toPreview(fileName: string, result: DbfParseResult): DbfFilePreview {
    return {
        fileName,
        header: result.header,
        // Names a link can be made on: _NullFlags is bookkeeping, not data.
        fieldsNames: result.header.fields.filter(f => !f.system).map(f => f.name),
        preview: result.preview,
        totalRecords: result.totalRecords,
        encoding: result.encoding,
        encodingSource: result.encodingSource,
        memoFile: result.memoFile,
        index: result.index,
    }
}
