import * as fs from 'fs'
import type { DbfFileTypeByte } from './types/dbf-file-types.types'
import type { DbfFieldDescriptor, DbfFieldOffset, DbfFieldTypeCode } from './types/dbf-field.types'
import { decodeMemoText, isMemoField, isTextMemo, memoBlockOf, VFP_TYPE_BYTES, type MemoReader } from './memo'

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
    /** TextDecoder label resolved from the code page mark. */
    readonly encoding: string
    /** Records not marked deleted; the header's recordCount includes deleted ones. */
    readonly liveRecords: number
    /** Record preview: array of rows, each row holding field values by index. */
    readonly preview: string[][]
}

const HEADER_SIZE = 32
const FIELD_DESCRIPTOR_SIZE = 32
const FIELD_TERMINATOR = 0x0d
const HEADER_TERMINATOR = 0x1a
const DELETED_FLAG = 0x2a // '*'
const PREVIEW_MEMO_CHARS = 200

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

/** Whether TextDecoder (Node's ICU) understands the given encoding label. */
export function isSupportedEncoding(label: string): boolean {
    try {
        new TextDecoder(label)
        return true
    } catch {
        return false
    }
}

/** Encoding label from the code page mark, or null when the mark is missing/unknown/unsupported. */
export function encodingFromCodePage(codePageByte: number): string | null {
    const label = CODE_PAGE_LABELS[codePageByte]
    return label && isSupportedEncoding(label) ? label : null
}

const CYRILLIC_CANDIDATES = ['cp866', 'windows-1251', 'koi8-r'] as const
// The most frequent Russian letters; wrong decodings land on rarer letters or pseudographics.
const FREQUENT_RUSSIAN = new Set('оеаинтсрвлкмдпуОЕАИНТСРВЛКМДПУ')
const DETECT_SAMPLE_BYTES = 256 * 1024

/**
 * Guesses the encoding of unmarked text (code page byte 0 is common in DOS-era Russian files).
 * Pure ASCII → latin1; otherwise the Cyrillic code page whose decoding yields the most frequent
 * Russian letters, as long as it explains most of the non-ASCII bytes; else latin1.
 */
export function detectEncoding(sample: Buffer): string {
    let highBytes = 0
    for (const b of sample) if (b >= 0x80) highBytes++
    if (highBytes === 0) return 'latin1'

    let best: { label: string; score: number } | null = null
    for (const label of CYRILLIC_CANDIDATES) {
        let score = 0
        for (const ch of new TextDecoder(label).decode(sample)) if (FREQUENT_RUSSIAN.has(ch)) score++
        if (!best || score > best.score) best = { label, score }
    }
    // Frequent letters are roughly two thirds of Russian text; demand a clear majority of the high bytes.
    return best && best.score >= highBytes * 0.4 ? best.label : 'latin1'
}

export function decodeField(decoder: TextDecoder, slice: Uint8Array): string {
    return decoder.decode(slice).replace(/\0+$/, '').trim()
}

type RecordLayout = Pick<RawDbfHeader, 'firstRecordOffset' | 'recordLength' | 'recordCount'>

/** Yields every live record (deleted ones skipped) as a slice; field offsets are relative to it. */
export function* iterateRecords(buffer: Buffer, layout: RecordLayout): Generator<Buffer> {
    const { firstRecordOffset, recordLength, recordCount } = layout
    let recordStart = firstRecordOffset

    for (
        let scanned = 0;
        scanned < recordCount && recordStart + recordLength <= buffer.length;
        scanned++, recordStart += recordLength
    ) {
        const flag = buffer.readUInt8(recordStart)
        // EOF marker or deleted record — skip deleted ones, stop at EOF
        if (flag === HEADER_TERMINATOR) return
        if (flag === DELETED_FLAG) continue
        yield buffer.subarray(recordStart, recordStart + recordLength)
    }
}

/** Memo cell for the preview table: the text itself, or a "(memo: …)" marker the client styles. */
function previewMemo(slice: Buffer, isText: boolean, decoder: TextDecoder, memo: MemoReader | null): string {
    const block = memoBlockOf(slice)
    if (block === 0) return ''
    if (!memo) return `(memo: block ${block}, memo file not uploaded)`
    const data = memo.read(block)
    if (!data) return `(memo: block ${block} not found)`
    if (!isText) return `(memo: binary, ${data.length} bytes)`
    const text = decodeMemoText(decoder, data)
    return text.length > PREVIEW_MEMO_CHARS ? `${text.slice(0, PREVIEW_MEMO_CHARS)}…` : text
}

/** Field names plus character-field bytes from the first records: what encoding detection looks at. */
function textSample(
    buffer: Buffer,
    layout: RecordLayout,
    fields: readonly { nameBytes: Buffer; type: string; length: number; offset: number }[],
): Buffer {
    const parts: Buffer[] = fields.map(f => f.nameBytes)
    const textFields = fields.filter(f => f.type === 'C' || f.type === 'V')
    let size = 0
    if (textFields.length > 0) {
        for (const record of iterateRecords(buffer, layout)) {
            for (const f of textFields) {
                const slice = record.subarray(f.offset, f.offset + f.length)
                parts.push(slice)
                size += slice.length
            }
            if (size >= DETECT_SAMPLE_BYTES) break
        }
    }
    return Buffer.concat(parts)
}

export function parseDbfNative(filePath: string, previewRows: number): RawDbfParseResult {
    return parseDbfBuffer(fs.readFileSync(filePath), previewRows)
}

export function parseDbfBuffer(buffer: Buffer, previewRows: number, memo: MemoReader | null = null): RawDbfParseResult {
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

    // Field descriptors: from byte 32 up to 0x0D. Names are decoded once the encoding is known.
    const rawFields: { nameBytes: Buffer; type: DbfFieldTypeCode; length: number; decimalCount: number; offset: number }[] = []
    let cursor = HEADER_SIZE
    // field offset within a record: the first record byte is the deletion flag
    let fieldOffset = 1

    while (cursor + FIELD_DESCRIPTOR_SIZE <= buffer.length) {
        if (buffer.readUInt8(cursor) === FIELD_TERMINATOR) break

        const nameBytes = buffer.subarray(cursor, cursor + 11)
        const nul = nameBytes.indexOf(0)
        const length = buffer.readUInt8(cursor + 16)

        rawFields.push({
            nameBytes: nul === -1 ? nameBytes : nameBytes.subarray(0, nul),
            type: String.fromCharCode(buffer.readUInt8(cursor + 11)) as DbfFieldTypeCode,
            length,
            decimalCount: buffer.readUInt8(cursor + 17),
            offset: fieldOffset,
        })

        fieldOffset += length
        cursor += FIELD_DESCRIPTOR_SIZE
    }

    const layout = { firstRecordOffset, recordLength, recordCount }
    const encoding = encodingFromCodePage(codePage) ?? detectEncoding(textSample(buffer, layout, rawFields))
    const decoder = new TextDecoder(encoding)

    const fields: DbfFieldDescriptor[] = rawFields.map(f => ({
        name: decoder.decode(f.nameBytes).trim(),
        type: f.type,
        length: f.length,
        decimalCount: f.decimalCount,
        offset: f.offset as DbfFieldOffset,
    }))

    // Read records for the preview
    const preview: string[][] = []
    const rowsToRead = Math.max(0, Math.min(previewRows, recordCount))

    const isVfp = VFP_TYPE_BYTES.has(typeByte)

    if (rowsToRead > 0) {
        for (const record of iterateRecords(buffer, { firstRecordOffset, recordLength, recordCount })) {
            preview.push(fields.map((field) => {
                const start = field.offset as number
                const slice = record.subarray(start, start + field.length)
                return isMemoField(field.type, isVfp)
                    ? previewMemo(slice, isTextMemo(field.type), decoder, memo)
                    : decodeField(decoder, slice)
            }))
            if (preview.length >= rowsToRead) break
        }
    }

    let liveRecords = 0
    for (const _ of iterateRecords(buffer, { firstRecordOffset, recordLength, recordCount })) liveRecords++

    return {
        encoding,
        liveRecords,
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
