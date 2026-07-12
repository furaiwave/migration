import * as fs from 'fs'
import type { DbfFileTypeByte } from './types/dbf-file-types.types'
import type { DbfFieldDescriptor, DbfFieldOffset, DbfFieldTypeCode } from './types/dbf-field.types'

/**
 * Pure-TypeScript .DBF reader.
 * Layout (per the spec):
 *   0        DBF file type
 *   1..3     last update date (YY MM DD)
 *   4..7     number of records        (uint32 LE)
 *   8..9     first record offset      (uint16 LE)
 *   10..11   length of one record     (uint16 LE)
 *   12..27   reserved
 *   28       table flags (.cdx / memo / .dbc)
 *   29       code page mark
 *   30..31   reserved
 *   32..n    field descriptors (32 bytes each), terminated by byte 0x0D
 */

export interface RawDbfHeader {
    readonly typeByte: DbfFileTypeByte
    readonly tableFlagsByte: number
    readonly lastUpdateYear: number
    readonly lastUpdateMonth: number
    readonly lastUpdateDay: number
    readonly recordCount: number
    readonly firstRecordOffset: number
    readonly recordLength: number
    readonly codePage: number
    readonly fields: DbfFieldDescriptor[]
}

export interface RawDbfParseResult {
    readonly header: RawDbfHeader
    /** Record preview: array of rows, each row holding field values by index. */
    readonly preview: string[][]
}

const HEADER_SIZE = 32
const FIELD_DESCRIPTOR_SIZE = 32
const FIELD_TERMINATOR = 0x0d
const HEADER_TERMINATOR = 0x1a
const DELETED_FLAG = 0x2a // '*'

/**
 * Code page mark (byte 29) -> TextDecoder label.
 * Covers the common DOS/ANSI encodings, including Cyrillic
 * (0x26/0x65 = cp866, 0xC9 = windows-1251).
 */
const CODE_PAGE_LABELS: Readonly<Record<number, string>> = {
    0x01: 'cp437',
    0x02: 'cp850',
    0x03: 'windows-1252',
    0x08: 'cp865',
    0x09: 'cp437',
    0x0a: 'cp850',
    0x0b: 'cp437',
    0x0d: 'cp437',
    0x0e: 'cp850',
    0x0f: 'cp437',
    0x10: 'cp850',
    0x11: 'cp437',
    0x12: 'cp850',
    0x13: 'shift_jis',
    0x1f: 'cp852',
    0x22: 'cp852',
    0x23: 'cp852',
    0x24: 'cp860',
    0x25: 'cp850',
    0x26: 'cp866', // Russian MS-DOS
    0x40: 'cp852',
    0x4d: 'gbk',
    0x4e: 'euc-kr',
    0x4f: 'big5',
    0x50: 'windows-874',
    0x57: 'windows-1252',
    0x58: 'windows-1252',
    0x59: 'windows-1252',
    0x64: 'cp852',
    0x65: 'cp866', // Russian
    0x66: 'cp865',
    0x67: 'cp861',
    0x6b: 'cp857',
    0x78: 'big5',
    0x79: 'euc-kr',
    0x7a: 'gbk',
    0x7b: 'shift_jis',
    0x7c: 'windows-874',
    0x7d: 'windows-1255',
    0x7e: 'windows-1256',
    0xc8: 'windows-1250',
    0xc9: 'windows-1251', // Russian Windows
    0xca: 'windows-1254',
    0xcb: 'windows-1253',
    0xcc: 'windows-1257',
}

/** Builds a decoder from the code page mark; falls back to latin1 on failure. */
function resolveDecoder(codePageByte: number): TextDecoder {
    const label = CODE_PAGE_LABELS[codePageByte]
    if (label) {
        try {
            return new TextDecoder(label)
        } catch {
            /* label not supported by ICU — fall back to latin1 below */
        }
    }
    return new TextDecoder('latin1')
}

function decodeField(decoder: TextDecoder, slice: Uint8Array): string {
    return decoder.decode(slice).replace(/\0+$/, '').trim()
}

export function parseDbfNative(filePath: string, previewRows: number): RawDbfParseResult {
    const buffer = fs.readFileSync(filePath)

    if (buffer.length < HEADER_SIZE) {
        throw new Error(`DBF file too small: ${buffer.length} bytes`)
    }

    const typeByte = buffer.readUInt8(0) as DbfFileTypeByte
    const lastUpdateYear = 1900 + buffer.readUInt8(1)
    const lastUpdateMonth = buffer.readUInt8(2)
    const lastUpdateDay = buffer.readUInt8(3)
    const recordCount = buffer.readUInt32LE(4)
    const firstRecordOffset = buffer.readUInt16LE(8)
    const recordLength = buffer.readUInt16LE(10)
    const tableFlagsByte = buffer.readUInt8(28)
    const codePage = buffer.readUInt8(29)

    if (firstRecordOffset < HEADER_SIZE || firstRecordOffset > buffer.length) {
        throw new Error(`Invalid first-record offset: ${firstRecordOffset}`)
    }
    if (recordLength <= 0) {
        throw new Error(`Invalid record length: ${recordLength}`)
    }

    const decoder = resolveDecoder(codePage)
    const nameDecoder = new TextDecoder('latin1')

    // Field descriptors: from byte 32 up to 0x0D
    const fields: DbfFieldDescriptor[] = []
    let cursor = HEADER_SIZE
    // field offset within a record: the first record byte is the deletion flag
    let fieldOffset = 1

    while (cursor + FIELD_DESCRIPTOR_SIZE <= buffer.length) {
        if (buffer.readUInt8(cursor) === FIELD_TERMINATOR) break

        const nameBytes = buffer.subarray(cursor, cursor + 11)
        const nul = nameBytes.indexOf(0)
        const name = nameDecoder
            .decode(nul === -1 ? nameBytes : nameBytes.subarray(0, nul))
            .trim()

        const type = String.fromCharCode(buffer.readUInt8(cursor + 11)) as DbfFieldTypeCode
        const length = buffer.readUInt8(cursor + 16)
        const decimalCount = buffer.readUInt8(cursor + 17)

        fields.push({
            name,
            type,
            length,
            decimalCount,
            offset: fieldOffset as DbfFieldOffset,
        })

        fieldOffset += length
        cursor += FIELD_DESCRIPTOR_SIZE
    }

    // Read records for the preview
    const preview: string[][] = []
    const rowsToRead = Math.max(0, Math.min(previewRows, recordCount))

    let recordStart = firstRecordOffset
    let collected = 0
    let scanned = 0

    while (
        collected < rowsToRead &&
        scanned < recordCount &&
        recordStart + recordLength <= buffer.length
    ) {
        const flag = buffer.readUInt8(recordStart)
        scanned += 1

        // EOF marker or deleted record — skip deleted ones, stop at EOF
        if (flag === HEADER_TERMINATOR) break

        if (flag !== DELETED_FLAG) {
            const row = fields.map((field) => {
                const start = recordStart + (field.offset as number)
                return decodeField(decoder, buffer.subarray(start, start + field.length))
            })
            preview.push(row)
            collected += 1
        }

        recordStart += recordLength
    }

    return {
        header: {
            typeByte,
            tableFlagsByte,
            lastUpdateYear,
            lastUpdateMonth,
            lastUpdateDay,
            recordCount,
            firstRecordOffset,
            recordLength,
            codePage,
            fields,
        },
        preview,
    }
}
