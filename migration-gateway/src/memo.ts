/**
 * Readers for the side files that hold memo field contents.
 *
 *   .FPT (FoxPro / Visual FoxPro)
 *     header: 0..3 next free block (uint32 BE), 6..7 block size (uint16 BE)
 *     block:  0..3 type (uint32 BE: 0 picture, 1 text, 2 object), 4..7 length (uint32 BE), data
 *
 *   .DBT (dBASE)
 *     dBASE III: 512-byte blocks, text runs until a 0x1A terminator
 *     dBASE IV:  block size at 20..21 (uint16 LE); a block starts with FF FF 08 00
 *                followed by its length (uint32 LE, the 8 header bytes included)
 *
 * The DBF record stores the starting block number: 10 ASCII digits, or uint32 LE in 4-byte fields.
 */

import type { TextDecoderLike } from './codepages'

export type MemoFormat = 'fpt' | 'dbt'

export interface MemoReader {
    readonly format: MemoFormat
    /** Raw contents of the memo that starts at `block`, or null when the pointer is empty/out of range. */
    read(block: number): Buffer | null
}

const DBT_DEFAULT_BLOCK = 512
const DBT4_SIGNATURE = 0x0008ffff // FF FF 08 00 read as uint32 LE
const MEMO_TERMINATOR = 0x1a

export function memoFormatOf(fileName: string): MemoFormat | null {
    if (/\.fpt$/i.test(fileName)) return 'fpt'
    if (/\.dbt$/i.test(fileName)) return 'dbt'
    return null
}

export function openMemo(buffer: Buffer, format: MemoFormat): MemoReader {
    if (buffer.length < 512) throw new Error(`Memo file too small: ${buffer.length} bytes`)
    return format === 'fpt' ? openFpt(buffer) : openDbt(buffer)
}

function openFpt(buffer: Buffer): MemoReader {
    const blockSize = buffer.readUInt16BE(6) || DBT_DEFAULT_BLOCK
    return {
        format: 'fpt',
        read(block) {
            const start = block * blockSize
            if (block <= 0 || start + 8 > buffer.length) return null
            const length = buffer.readUInt32BE(start + 4)
            return buffer.subarray(start + 8, Math.min(buffer.length, start + 8 + length))
        },
    }
}

function openDbt(buffer: Buffer): MemoReader {
    const declared = buffer.readUInt16LE(20)
    const blockSize = declared > 0 && declared % 64 === 0 ? declared : DBT_DEFAULT_BLOCK
    return {
        format: 'dbt',
        read(block) {
            const start = block * blockSize
            if (block <= 0 || start >= buffer.length) return null
            if (start + 8 <= buffer.length && buffer.readUInt32LE(start) === DBT4_SIGNATURE) {
                const length = buffer.readUInt32LE(start + 4)
                return buffer.subarray(start + 8, Math.min(buffer.length, start + Math.max(8, length)))
            }
            const end = buffer.indexOf(MEMO_TERMINATOR, start)
            return buffer.subarray(start, end === -1 ? buffer.length : end)
        },
    }
}

/** Starting block number stored in a memo field of a DBF record; 0 means "no memo". */
export function memoBlockOf(slice: Buffer): number {
    if (slice.length === 4) return slice.readUInt32LE(0)
    const n = Number(slice.toString('latin1').trim())
    return Number.isInteger(n) && n > 0 ? n : 0
}

/** Memo text without the padding FoxPro/dBASE leave at the end. */
export function decodeMemoText(decoder: TextDecoderLike, data: Buffer): string {
    return decoder.decode(data).replace(/[\0\x1a]+$/, '').trimEnd()
}

/** Field types whose record bytes are a memo pointer. 'B' is one only outside Visual FoxPro. */
export function isMemoField(type: string, isVfp: boolean): boolean {
    return type === 'M' || type === 'G' || type === 'P' || (type === 'B' && !isVfp)
}

export const isTextMemo = (type: string): boolean => type === 'M'

export const VFP_TYPE_BYTES: ReadonlySet<number> = new Set([0x30, 0x31, 0x32])
