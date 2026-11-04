import * as fs from 'fs'
import type { DbfFileTypeByte } from './types/dbf-file-types.types'
import type { DbfFieldDescriptor, DbfFieldOffset, DbfFieldTypeCode } from './types/dbf-field.types'
import { decodeMemoText, isMemoField, isTextMemo, memoBlockOf, VFP_TYPE_BYTES, type MemoReader } from './memo'
import { createDecoder, isSupportedEncoding, type TextDecoderLike } from './codepages'

export { isSupportedEncoding } from './codepages'

/**
 * Pure-TypeScript .DBF reader.
 * Layout (dBASE III and later, FoxPro, Visual FoxPro):
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
 *            0..10 name, 11 type, 12..15 offset (VFP), 16 length, 17 decimals,
 *            18 flags (VFP: 0x01 system, 0x02 nullable, 0x04 binary)
 *
 * dBASE 7 (0x04 / 0x8C): the same up to byte 31, a language driver name at 32..63, descriptors
 * from 68, 48 bytes each (0..31 name, 32 type, 33 length, 34 decimals).
 *
 * dBASE II (0x02): 1..2 record count, 6..7 record length, descriptors from 8, 16 bytes each
 * (0..10 name, 11 type, 12 length, 15 decimals); records start at 521.
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

/** Where a table's text encoding came from. */
export type EncodingSource = 'codepage' | 'detected' | 'manual'

/** A preview cell: the value as text, or null for a Visual FoxPro NULL. */
export type PreviewValue = string | null

export interface RawDbfParseResult {
    readonly header: RawDbfHeader
    /** Decoder label (see codepages.ts) the text is read with. */
    readonly encoding: string
    /** Records not marked deleted; the header's recordCount includes deleted ones. */
    readonly liveRecords: number
    readonly encodingSource: EncodingSource
    /** Record preview: array of rows, each row holding field values by index (system fields empty). */
    readonly preview: PreviewValue[][]
}

const HEADER_SIZE = 32
const FIELD_DESCRIPTOR_SIZE = 32
const FIELD_TERMINATOR = 0x0d
const HEADER_TERMINATOR = 0x1a
const DELETED_FLAG = 0x2a // '*'
const PREVIEW_MEMO_CHARS = 200

const DBASE2_FIELDS_AT = 8
const DBASE2_DESCRIPTOR_SIZE = 16
const DBASE2_FIRST_RECORD = 521
const DBASE7_FIELDS_AT = 68
const DBASE7_DESCRIPTOR_SIZE = 48

const VFP_FIELD_NULLABLE = 0x02
const NULL_FLAGS_TYPE = '0'

/** dBASE 7 stores its binary numbers big-endian with the sign bit flipped (so they sort as bytes). */
export const isDbase7 = (typeByte: number): boolean => typeByte === 0x04 || typeByte === 0x8c

/**
 * Code page mark (byte 29) -> decoder label.
 * Covers the common DOS/ANSI encodings, including Cyrillic
 * (0x26/0x65 = cp866, 0xC9 = windows-1251).
 */
const CODE_PAGE_LABELS: Readonly<Record<number, string>> = {
    0x01: 'cp437',
    0x02: 'cp850',
    0x03: 'windows-1252',
    0x04: 'macintosh',
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
    0x14: 'cp850',
    0x15: 'cp437',
    0x16: 'cp850',
    0x17: 'cp865',
    0x18: 'cp437',
    0x19: 'cp437',
    0x1a: 'cp850',
    0x1b: 'cp437',
    0x1c: 'cp863',
    0x1d: 'cp850',
    0x1f: 'cp852',
    0x22: 'cp852',
    0x23: 'cp852',
    0x24: 'cp860',
    0x25: 'cp850',
    0x26: 'cp866', // Russian MS-DOS
    0x37: 'cp850',
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
    0x69: 'cp620', // Mazovia (Polish MS-DOS)
    0x6b: 'cp857',
    0x78: 'big5',
    0x79: 'euc-kr',
    0x7a: 'gbk',
    0x7b: 'shift_jis',
    0x7c: 'windows-874',
    0x7d: 'windows-1255',
    0x7e: 'windows-1256',
    0x87: 'cp852',
    0x96: 'x-mac-cyrillic', // Russian Macintosh
    0xc8: 'windows-1250',
    0xc9: 'windows-1251', // Russian Windows
    0xca: 'windows-1254',
    0xcb: 'windows-1253',
    0xcc: 'windows-1257',
}

/** Encoding label from the code page mark, or null when the mark is missing/unknown/unsupported. */
export function encodingFromCodePage(codePageByte: number): string | null {
    const label = CODE_PAGE_LABELS[codePageByte]
    return label && isSupportedEncoding(label) ? label : null
}

// ---------------------------------------------------------------- encoding detection

const CYRILLIC_CANDIDATES = ['cp866', 'windows-1251', 'koi8-r'] as const
// DOS (FoxPro 2.x, Clipper) or Windows (Visual FoxPro) Western text.
const WESTERN_CANDIDATES = ['cp850', 'windows-1252'] as const
// The most frequent Russian letters; wrong decodings land on rarer letters or pseudographics.
const FREQUENT_RUSSIAN = new Set('оеаинтсрвлкмдпуОЕАИНТСРВЛКМДПУ')
const DETECT_SAMPLE_BYTES = 256 * 1024

const LETTER = /\p{L}/u
const LOWER = /\p{Ll}/u
const UPPER = /\p{Lu}/u
const LATIN = /[A-Za-z]/
const CYRILLIC = /[Ѐ-ӿ]/

/**
 * Whether the text pieces read as UTF-8 with at least one multi-byte character. A piece may end
 * in the middle of a character (a field cut at its length), which is not counted against it.
 * Russian or Western text in a single-byte code page is practically never valid UTF-8.
 */
function looksLikeUtf8(parts: readonly Buffer[]): boolean {
    let multibyte = 0
    for (const part of parts) {
        for (let i = 0; i < part.length;) {
            const b = part[i]
            if (b < 0x80) { i++; continue }
            const need = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : b >= 0xf0 && b <= 0xf4 ? 3 : -1
            if (need < 0) return false
            let j = 1
            for (; j <= need && i + j < part.length; j++) if ((part[i + j] & 0xc0) !== 0x80) return false
            if (j <= need) break // cut at the end of the field
            multibyte++
            i += need + 1
        }
    }
    return multibyte > 0
}

/** Share of Cyrillic words that also contain Latin letters: "penedКs" is a wrong decoding, not Russian. */
function mixedScriptShare(text: string): number {
    let cyrillic = 0
    let mixed = 0
    for (const word of text.split(/[^\p{L}]+/u)) {
        if (!CYRILLIC.test(word)) continue
        cyrillic++
        if (LATIN.test(word)) mixed++
    }
    return cyrillic === 0 ? 1 : mixed / cyrillic
}

/**
 * How natural the non-ASCII characters look as Western text: accented letters inside words
 * score, symbols glued to letters (‡é, ╡) and capitals in the middle of lower-case words cost.
 */
function westernScore(text: string): number {
    const chars = [...text]
    let score = 0
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i]
        if (c.charCodeAt(0) < 0x80) continue
        const prev = chars[i - 1] ?? ' '
        const next = chars[i + 1] ?? ' '
        const inWord = LETTER.test(prev) || LETTER.test(next)
        if (LOWER.test(c)) score += inWord ? 2 : 1
        else if (UPPER.test(c)) score += /[a-z]/.test(prev) && /[a-z]/.test(next) ? -2 : 1
        else score -= inWord ? 2 : 1
    }
    return score
}

/**
 * Guesses the encoding of unmarked text (code page byte 0 is common in DOS-era files).
 * Pure ASCII → latin1; valid UTF-8 → utf-8; then the Cyrillic code page whose decoding yields the
 * most frequent Russian letters (if it explains most non-ASCII bytes and does not mix scripts
 * inside words); otherwise the more natural of DOS and Windows Western.
 */
export function detectEncoding(parts: readonly Buffer[]): string {
    const sample = Buffer.concat(parts)
    let highBytes = 0
    for (const b of sample) if (b >= 0x80) highBytes++
    if (highBytes === 0) return 'latin1'
    if (looksLikeUtf8(parts)) return 'utf-8'

    let best: { label: string; score: number; text: string } | null = null
    for (const label of CYRILLIC_CANDIDATES) {
        const text = createDecoder(label).decode(sample)
        let score = 0
        for (const ch of text) if (FREQUENT_RUSSIAN.has(ch)) score++
        if (!best || score > best.score) best = { label, score, text }
    }
    // Frequent letters are roughly two thirds of Russian text; demand a clear majority of the high bytes.
    if (best && best.score >= highBytes * 0.4 && mixedScriptShare(best.text) <= 0.15) return best.label

    const [dos, windows] = WESTERN_CANDIDATES.map(label => westernScore(createDecoder(label).decode(sample)))
    return dos > windows ? WESTERN_CANDIDATES[0] : WESTERN_CANDIDATES[1]
}

export function decodeField(decoder: TextDecoderLike, slice: Uint8Array): string {
    return decoder.decode(slice).replace(/\0+$/, '').trim()
}

// ---------------------------------------------------------------- records

type RecordLayout = Pick<RawDbfHeader, 'firstRecordOffset' | 'recordLength' | 'recordCount'>

/** Which records to walk: the live ones, or only those marked deleted ('*'). */
export type RecordSet = 'live' | 'deleted'

/** Yields every record of the set as a slice; field offsets are relative to it. */
export function* iterateRecords(buffer: Buffer, layout: RecordLayout, set: RecordSet = 'live'): Generator<Buffer> {
    const { firstRecordOffset, recordLength, recordCount } = layout
    let recordStart = firstRecordOffset

    for (
        let scanned = 0;
        scanned < recordCount && recordStart + recordLength <= buffer.length;
        scanned++, recordStart += recordLength
    ) {
        const flag = buffer.readUInt8(recordStart)
        // EOF marker ends the table; deleted records belong to the other set
        if (flag === HEADER_TERMINATOR) return
        if ((flag === DELETED_FLAG) !== (set === 'deleted')) continue
        yield buffer.subarray(recordStart, recordStart + recordLength)
    }
}

/** 1-based position of a record yielded by iterateRecords — what FoxPro shows as RECNO(). */
export function recordNumberOf(buffer: Buffer, layout: RecordLayout, record: Buffer): number {
    return (record.byteOffset - buffer.byteOffset - layout.firstRecordOffset) / layout.recordLength + 1
}

/**
 * The bytes of one field in a record: null when Visual FoxPro marks it NULL, and only the used
 * part of a Varchar/Varbinary that is shorter than the field (its length is in the last byte).
 */
export function fieldBytes(record: Buffer, field: DbfFieldDescriptor): Buffer | null {
    const start = field.offset as number
    const slice = record.subarray(start, start + field.length)
    const flags = field.nullFlags
    if (!flags) return slice
    const bit = (n: number) => ((record[flags.offset + (n >> 3)] ?? 0) >> (n & 7)) & 1
    if (flags.nullBit !== undefined && bit(flags.nullBit)) return null
    if (flags.varLengthBit !== undefined && bit(flags.varLengthBit))
        return slice.subarray(0, Math.min(slice[slice.length - 1] ?? 0, slice.length - 1))
    return slice
}

// ---------------------------------------------------------------- binary values

const JULIAN_UNIX_EPOCH = 2440588
const MS_PER_DAY = 86_400_000
const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 'YYYY-MM-DD HH:MM:SS' for a Julian day number and milliseconds since midnight, or null. */
export function julianDateTime(julianDay: number, ms: number): string | null {
    if (julianDay <= 0) return null
    const d = new Date((julianDay - JULIAN_UNIX_EPOCH) * MS_PER_DAY + ms)
    const year = d.getUTCFullYear()
    if (Number.isNaN(year) || year < 1000 || year > 9999) return null
    return `${year}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
        `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
}

/** dBASE 7 Long / Autoincrement: big-endian, sign bit flipped. */
export const dbase7Long = (slice: Buffer): number => (slice.readUInt32BE(0) ^ 0x80000000) | 0

/** dBASE 7 Double: big-endian; positives have the sign bit flipped, negatives every bit inverted. */
export function dbase7Double(slice: Buffer): number {
    const bytes = Buffer.from(slice.subarray(0, 8))
    if (bytes[0] & 0x80) bytes[0] ^= 0x80
    else for (let i = 0; i < 8; i++) bytes[i] = ~bytes[i] & 0xff
    return bytes.readDoubleBE(0)
}

/** dBASE 7 Timestamp: a dBASE 7 Double of milliseconds since 1 January 4713 BC (Julian day 0). */
export function dbase7Timestamp(slice: Buffer): string | null {
    const ms = dbase7Double(slice)
    if (!Number.isFinite(ms) || ms <= 0) return null
    const day = Math.floor(ms / MS_PER_DAY)
    return julianDateTime(day, ms - day * MS_PER_DAY)
}

/**
 * Fields stored as binary rather than text: Visual FoxPro Integer, Double, Currency and DateTime,
 * dBASE 7 Long, Double and Timestamp. Returns the value as text ('' when empty), or undefined for
 * every other field.
 */
export function binaryFieldText(type: string, slice: Buffer, typeByte: number): string | undefined {
    if (isDbase7(typeByte)) {
        if ((type === 'I' || type === '+') && slice.length === 4) return slice.every(b => b === 0) ? '' : String(dbase7Long(slice))
        if (type === 'O' && slice.length === 8) {
            if (slice.every(b => b === 0)) return ''
            const v = dbase7Double(slice)
            return Number.isFinite(v) ? String(v) : ''
        }
        if (type === '@' && slice.length === 8) return slice.every(b => b === 0) ? '' : dbase7Timestamp(slice) ?? ''
        return undefined
    }
    const isVfp = VFP_TYPE_BYTES.has(typeByte)
    if ((type === 'I' || type === '+') && slice.length === 4) return String(slice.readInt32LE(0))
    if (type === 'B' && isVfp && slice.length === 8) {
        const v = slice.readDoubleLE(0)
        return Number.isFinite(v) ? String(v) : ''
    }
    if (type === 'Y' && slice.length === 8) {
        const raw = slice.readBigInt64LE(0)
        const abs = raw < 0n ? -raw : raw
        return `${raw < 0n ? '-' : ''}${abs / 10000n}.${String(abs % 10000n).padStart(4, '0')}`
    }
    if (type === 'T' && slice.length === 8) return julianDateTime(slice.readInt32LE(0), slice.readInt32LE(4)) ?? ''
    return undefined
}

// ---------------------------------------------------------------- preview

/** Memo cell for the preview table: the text itself, or a "(memo: …)" marker the client styles. */
function previewMemo(slice: Buffer, isText: boolean, decoder: TextDecoderLike, memo: MemoReader | null): string {
    const block = memoBlockOf(slice)
    if (block === 0) return ''
    if (!memo) return `(memo: block ${block}, memo file not uploaded)`
    const data = memo.read(block)
    if (!data) return `(memo: block ${block} not found)`
    if (!isText) return `(memo: binary, ${data.length} bytes)`
    const text = decodeMemoText(decoder, data)
    return text.length > PREVIEW_MEMO_CHARS ? `${text.slice(0, PREVIEW_MEMO_CHARS)}…` : text
}

/** A preview cell as the user should read it: logical fields as true/false, binary numbers and dates decoded. */
function previewValue(
    field: DbfFieldDescriptor,
    record: Buffer,
    typeByte: number,
    decoder: TextDecoderLike,
    memo: MemoReader | null,
): PreviewValue {
    if (field.system) return ''
    const slice = fieldBytes(record, field)
    if (slice === null) return null
    if (isMemoField(field.type, VFP_TYPE_BYTES.has(typeByte))) return previewMemo(slice, isTextMemo(field.type), decoder, memo)
    const binary = binaryFieldText(field.type, slice, typeByte)
    if (binary !== undefined) return binary
    if (field.type === 'L') {
        const c = String.fromCharCode(slice[0] ?? 0x20)
        return 'TtYy'.includes(c) ? 'true' : 'FfNn'.includes(c) ? 'false' : ''
    }
    if (field.type === 'Q') return slice.length === 0 ? '' : `0x${slice.toString('hex')}`
    // Varchar keeps its trailing blanks on purpose; everything else is padded with them.
    return field.type === 'V' ? decoder.decode(slice).replace(/\0+$/, '') : decodeField(decoder, slice)
}

// ---------------------------------------------------------------- header

interface RawField {
    readonly nameBytes: Buffer
    readonly type: DbfFieldTypeCode
    readonly length: number
    readonly decimalCount: number
    readonly offset: number
    readonly flags: number
}

interface HeaderLayout {
    readonly recordCount: number
    readonly firstRecordOffset: number
    readonly recordLength: number
    readonly fieldsAt: number
    readonly descriptorSize: number
    readonly codePage: number
    readonly tableFlagsByte: number
    readonly date: readonly [number, number, number]
}

function headerLayout(buffer: Buffer, typeByte: number): HeaderLayout {
    if (typeByte === 0x02) {
        // dBASE II / FoxBase: date is MM DD YY at 3..5.
        return {
            recordCount: buffer.readUInt16LE(1),
            firstRecordOffset: DBASE2_FIRST_RECORD,
            recordLength: buffer.readUInt16LE(6),
            fieldsAt: DBASE2_FIELDS_AT,
            descriptorSize: DBASE2_DESCRIPTOR_SIZE,
            codePage: 0,
            tableFlagsByte: 0,
            date: [1900 + buffer.readUInt8(5), buffer.readUInt8(3), buffer.readUInt8(4)],
        }
    }
    const dbase7 = isDbase7(typeByte)
    return {
        recordCount: buffer.readUInt32LE(4),
        firstRecordOffset: buffer.readUInt16LE(8),
        recordLength: buffer.readUInt16LE(10),
        fieldsAt: dbase7 ? DBASE7_FIELDS_AT : HEADER_SIZE,
        descriptorSize: dbase7 ? DBASE7_DESCRIPTOR_SIZE : FIELD_DESCRIPTOR_SIZE,
        codePage: buffer.readUInt8(29),
        tableFlagsByte: buffer.readUInt8(28),
        date: [1900 + buffer.readUInt8(1), buffer.readUInt8(2), buffer.readUInt8(3)],
    }
}

function readDescriptors(buffer: Buffer, layout: HeaderLayout, typeByte: number): RawField[] {
    const fields: RawField[] = []
    const dbase2 = typeByte === 0x02
    const dbase7 = isDbase7(typeByte)
    const nameLength = dbase7 ? 32 : 11
    const typeAt = dbase7 ? 32 : 11
    const lengthAt = dbase7 ? 33 : dbase2 ? 12 : 16
    const decimalsAt = dbase7 ? 34 : dbase2 ? 15 : 17
    // The first record byte is the deletion flag.
    let fieldOffset = 1

    for (let cursor = layout.fieldsAt; cursor + layout.descriptorSize <= buffer.length; cursor += layout.descriptorSize) {
        if (buffer.readUInt8(cursor) === FIELD_TERMINATOR) break
        // A field running past the record is a damaged descriptor list; stop rather than read garbage.
        const length = buffer.readUInt8(cursor + lengthAt)
        if (fieldOffset + length > layout.recordLength) break
        const nameBytes = buffer.subarray(cursor, cursor + nameLength)
        const nul = nameBytes.indexOf(0)
        fields.push({
            nameBytes: nul === -1 ? nameBytes : nameBytes.subarray(0, nul),
            type: String.fromCharCode(buffer.readUInt8(cursor + typeAt)) as DbfFieldTypeCode,
            length,
            decimalCount: buffer.readUInt8(cursor + decimalsAt),
            offset: fieldOffset,
            flags: dbase2 || dbase7 ? 0 : buffer.readUInt8(cursor + 18),
        })
        fieldOffset += length
    }
    return fields
}

/**
 * Visual FoxPro keeps NULL markers in a hidden _NullFlags field: one bit per Varchar/Varbinary
 * field ("shorter than the field") and, right after it, one per nullable field ("is NULL").
 */
function nullFlagsOf(raw: readonly RawField[]): (DbfFieldDescriptor['nullFlags'])[] {
    const holder = raw.find(f => f.type === NULL_FLAGS_TYPE)
    if (!holder) return raw.map(() => undefined)
    let bit = 0
    return raw.map(f => {
        if (f === holder) return undefined
        const varLengthBit = f.type === 'V' || f.type === 'Q' ? bit++ : undefined
        const nullBit = f.flags & VFP_FIELD_NULLABLE ? bit++ : undefined
        if (varLengthBit === undefined && nullBit === undefined) return undefined
        return { offset: holder.offset, nullBit, varLengthBit }
    })
}

/** Field names as the rest of the app keys them: never empty, never repeated. */
function uniqueNames(names: readonly string[]): string[] {
    const taken = new Set<string>()
    return names.map((raw, i) => {
        // A UTF-8 name cut at 10/11 bytes ends in half a character.
        const base = raw.replace(/�+$/, '').trim() || `FIELD_${i + 1}`
        let name = base
        for (let n = 2; taken.has(name.toUpperCase()); n++) name = `${base}_${n}`
        taken.add(name.toUpperCase())
        return name
    })
}

/** Field names plus character-field bytes from the first records: what encoding detection looks at. */
function textSample(buffer: Buffer, layout: RecordLayout, fields: readonly RawField[]): Buffer[] {
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
    return parts
}

export function parseDbfNative(filePath: string, previewRows: number): RawDbfParseResult {
    return parseDbfBuffer(fs.readFileSync(filePath), previewRows)
}

/** `encoding` forces a decoder label; null means: code page mark, else detect from the text. */
export function parseDbfBuffer(
    buffer: Buffer,
    previewRows: number,
    memo: MemoReader | null = null,
    encoding: string | null = null,
): RawDbfParseResult {
    if (buffer.length < HEADER_SIZE) {
        throw new Error(`DBF file too small: ${buffer.length} bytes`)
    }

    const typeByte = buffer.readUInt8(0) as DbfFileTypeByte
    const layout = headerLayout(buffer, typeByte)
    const { recordCount, firstRecordOffset, recordLength, codePage } = layout

    if (firstRecordOffset < HEADER_SIZE || firstRecordOffset > buffer.length) {
        throw new Error(`Invalid first-record offset: ${firstRecordOffset}`)
    }
    if (recordLength <= 0) {
        throw new Error(`Invalid record length: ${recordLength}`)
    }

    const rawFields = readDescriptors(buffer, layout, typeByte)
    const records = { firstRecordOffset, recordLength, recordCount }

    // A code page mark is trusted unless the text is plainly UTF-8 (written by a newer tool).
    const marked = encodingFromCodePage(codePage)
    const sample = encoding ? null : textSample(buffer, records, rawFields)
    const utf8 = sample !== null && marked !== null && marked !== 'utf-8' && looksLikeUtf8(sample)
    const label = encoding ?? (utf8 ? 'utf-8' : marked) ?? detectEncoding(sample ?? [])
    const encodingSource: EncodingSource = encoding ? 'manual' : marked && !utf8 ? 'codepage' : 'detected'
    const decoder = createDecoder(label)

    const names = uniqueNames(rawFields.map(f => decoder.decode(f.nameBytes)))
    const nullFlags = nullFlagsOf(rawFields)
    // Every descriptor gets the same properties in the same order: they are read for every cell of
    // every record, and V8 keeps that code fastest when all of them share one shape.
    const fields: DbfFieldDescriptor[] = rawFields.map((f, i) => ({
        name: names[i],
        type: f.type,
        length: f.length,
        decimalCount: f.decimalCount,
        offset: f.offset as DbfFieldOffset,
        nullable: (f.flags & VFP_FIELD_NULLABLE) !== 0,
        system: f.type === NULL_FLAGS_TYPE,
        nullFlags: nullFlags[i],
    }))

    // Read records for the preview
    const preview: PreviewValue[][] = []
    const rowsToRead = Math.max(0, Math.min(previewRows, recordCount))

    if (rowsToRead > 0) {
        for (const record of iterateRecords(buffer, records)) {
            preview.push(fields.map(field => previewValue(field, record, typeByte, decoder, memo)))
            if (preview.length >= rowsToRead) break
        }
    }

    let liveRecords = 0
    for (const _ of iterateRecords(buffer, records)) liveRecords++

    return {
        encoding: label,
        encodingSource,
        liveRecords,
        header: {
            typeByte,
            tableFlagsByte: layout.tableFlagsByte,
            lastUpdateYear: layout.date[0],
            lastUpdateMonth: layout.date[1],
            lastUpdateDay: layout.date[2],
            recordCount,
            firstRecordOffset,
            recordLength,
            codePage,
            fields,
        },
        preview,
    }
}
