/**
 * Reader for FoxPro compound index files (.CDX). Only the list of tags is read, not their keys:
 * MySQL rebuilds the indexes from the data, it just needs to know which ones existed.
 *
 *   The file is made of 512-byte pages. A tag header takes two pages:
 *     0..3     root node of the tag's B-tree (int32 LE)
 *     12..13   key length (uint16 LE)
 *     14       options: 0x01 UNIQUE, 0x04 candidate (VFP primary/candidate key), 0x08 has FOR,
 *              0x20 compact, 0x40 compound header
 *     502..503 descending
 *     506..507 FOR expression length, 510..511 key expression length (both with their NUL)
 *     512..    key expression, then the FOR expression
 *
 *   The header at offset 0 is a B-tree whose keys are the tag names and whose "record numbers"
 *   are the offsets of the tags' own headers. Nodes:
 *     0..1 attributes (bit 1 = leaf), 2..3 key count, 4..11 sibling pointers
 *     interior: from 12, entries of key + record number (uint32 BE) + child page (uint32 BE)
 *     leaf (compact): 14..17 record number mask, 18..19 duplicate/trailing count masks,
 *                     20..22 bit widths, 23 bytes per entry; entries from 24, key bytes packed
 *                     from the end of the page backwards (only the part not shared with the previous key)
 */

import type { TextDecoderLike } from './codepages'

export interface CdxTag {
    readonly name: string
    readonly expression: string
    /** FOR clause: only records matching it were indexed. */
    readonly filter: string | null
    /** INDEX … UNIQUE: FoxPro indexes only the first record of each key, it does not refuse duplicates. */
    readonly unique: boolean
    /** Candidate (or primary) key: Visual FoxPro refuses duplicates. */
    readonly candidate: boolean
    readonly descending: boolean
}

const PAGE = 512
const TAG_HEADER = 1024
const OPT_UNIQUE = 0x01
const OPT_CANDIDATE = 0x04
const OPT_COMPACT = 0x20
const LEAF = 0x02
// A tag list never comes close; the cap only stops a damaged file from looping.
const MAX_NODES = 10_000

export function cdxFileOf(fileName: string): boolean {
    return /\.cdx$/i.test(fileName)
}

/** Tags in the order FoxPro lists them (alphabetical). Throws on a file that is not a compact CDX. */
export function readCdxTags(buffer: Buffer, decoder: TextDecoderLike): CdxTag[] {
    if (buffer.length < TAG_HEADER || buffer.length % PAGE !== 0)
        throw new Error(`not a .CDX file (${buffer.length} bytes)`)
    if ((buffer[14] & OPT_COMPACT) === 0)
        throw new Error('only compact .CDX files (FoxPro 2.x / Visual FoxPro) are supported')

    const keyLength = buffer.readUInt16LE(12)
    const entries = readTree(buffer, buffer.readInt32LE(0), keyLength)

    return entries.map(({ key, recno: offset }) => {
        if (offset < 0 || offset + TAG_HEADER > buffer.length)
            throw new Error(`tag ${key} points outside the file`)
        const options = buffer[offset + 14]
        const forLength = buffer.readUInt16LE(offset + 506)
        const exprLength = buffer.readUInt16LE(offset + 510)
        const pool = buffer.subarray(offset + PAGE, offset + TAG_HEADER)
        const text = (from: number, length: number) => {
            const bytes = pool.subarray(from, Math.min(pool.length, from + length))
            const nul = bytes.indexOf(0)
            return decoder.decode(nul === -1 ? bytes : bytes.subarray(0, nul)).trim()
        }
        const expression = text(0, exprLength || pool.length)
        const filter = forLength > 1 ? text(exprLength, forLength) : ''
        return {
            name: key,
            expression,
            filter: filter === '' ? null : filter,
            unique: (options & OPT_UNIQUE) !== 0,
            candidate: (options & OPT_CANDIDATE) !== 0,
            descending: buffer.readUInt16LE(offset + 502) !== 0,
        }
    })
}

interface TreeEntry {
    readonly key: string
    readonly recno: number
}

function readTree(buffer: Buffer, root: number, keyLength: number): TreeEntry[] {
    const out: TreeEntry[] = []
    const seen = new Set<number>()
    const visit = (page: number) => {
        if (page < 0 || page + PAGE > buffer.length || page % PAGE !== 0 || seen.has(page) || seen.size >= MAX_NODES)
            throw new Error('damaged index tree')
        seen.add(page)
        const node = buffer.subarray(page, page + PAGE)
        const count = node.readUInt16LE(2)
        if (node.readUInt16LE(0) & LEAF) {
            out.push(...readLeaf(node, count, keyLength))
            return
        }
        const entry = keyLength + 8
        for (let i = 0; i < count; i++) {
            const at = 12 + i * entry
            if (at + entry > PAGE) throw new Error('damaged index node')
            visit(node.readUInt32BE(at + keyLength + 4))
        }
    }
    visit(root)
    return out
}

function readLeaf(node: Buffer, count: number, keyLength: number): TreeEntry[] {
    const recnoMask = BigInt(node.readUInt32LE(14))
    const dupMask = BigInt(node[18])
    const trailMask = BigInt(node[19])
    const recnoBits = BigInt(node[20])
    const dupBits = BigInt(node[21])
    const entryBytes = node[23]
    if (entryBytes === 0 || 24 + count * entryBytes > PAGE) throw new Error('damaged index leaf')

    const out: TreeEntry[] = []
    let keyEnd = PAGE
    let previous = Buffer.alloc(keyLength, 0x20)
    for (let i = 0; i < count; i++) {
        let packed = 0n
        for (let b = 0; b < entryBytes; b++) packed |= BigInt(node[24 + i * entryBytes + b]) << BigInt(8 * b)
        const dup = Number((packed >> recnoBits) & dupMask)
        const trail = Number((packed >> (recnoBits + dupBits)) & trailMask)
        const fresh = keyLength - dup - trail
        keyEnd -= fresh
        if (fresh < 0 || keyEnd < 24 + count * entryBytes) throw new Error('damaged index leaf')
        const key = Buffer.concat([previous.subarray(0, dup), node.subarray(keyEnd, keyEnd + fresh), Buffer.alloc(trail, 0x20)])
        previous = key
        out.push({ key: key.toString('latin1').replace(/[\0 ]+$/, ''), recno: Number(packed & recnoMask) })
    }
    return out
}

// ---------------------------------------------------------------- key expressions

/** A field the index is built on; `prefix` when only its first characters are (LEFT/SUBSTR). */
export interface IndexPart {
    readonly field: string
    readonly prefix?: number
}

// Wrappers that keep the order of their first argument (close enough for MySQL to index the field itself).
const PASS_THROUGH = [
    'UPPER', 'LOWER', 'ALLTRIM', 'LTRIM', 'RTRIM', 'TRIM', 'PADL', 'PADR', 'PADC',
    'DTOS', 'DTOC', 'TTOC', 'TTOD', 'STR', 'VAL', 'INT', 'BINTOC', 'TRANSFORM', 'NVL',
] as const
const KNOWN = [...PASS_THROUGH, 'LEFT', 'SUBSTR', 'DELETED'] as const

/** FoxPro accepts function names cut down to four letters: SUBS(), UPPE(), ALLT(). */
function functionName(raw: string): string | null {
    const name = raw.toUpperCase()
    return KNOWN.find(k => k === name || (name.length >= 4 && k.startsWith(name))) ?? null
}

type Token =
    | { readonly t: 'name'; readonly v: string }
    | { readonly t: 'number'; readonly v: number }
    | { readonly t: 'string' }
    | { readonly t: 'op'; readonly v: string }

function tokenize(expression: string): Token[] {
    const tokens: Token[] = []
    const s = expression
    let i = 0
    while (i < s.length) {
        const c = s[i]
        if (/\s/.test(c)) { i++; continue }
        if (/[A-Za-z_\u0080-￿]/.test(c)) {
            const m = /^[A-Za-z_0-9\u0080-￿]+/.exec(s.slice(i))!
            tokens.push({ t: 'name', v: m[0] })
            i += m[0].length
            continue
        }
        // A dot starts a number only before a digit; otherwise it is alias.field.
        const number = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i))
        if (number) {
            tokens.push({ t: 'number', v: Number(number[0]) })
            i += number[0].length
            continue
        }
        const close = c === '"' ? '"' : c === "'" ? "'" : c === '[' ? ']' : null
        if (close) {
            const end = s.indexOf(close, i + 1)
            if (end === -1) throw new Error('unterminated string')
            tokens.push({ t: 'string' })
            i = end + 1
            continue
        }
        if (s.startsWith('->', i)) { tokens.push({ t: 'op', v: '.' }); i += 2; continue }
        if ('()+-,.'.includes(c)) { tokens.push({ t: 'op', v: c }); i++; continue }
        throw new Error(`"${c}" is not supported`)
    }
    return tokens
}

/**
 * The fields a FoxPro key expression orders by, in order: `CLIENT_ID`, `UPPER(NAME)`,
 * `DTOS(DATE)+STR(NUM,6)`, `LEFT(NAME,20)`… Throws with a short reason for anything
 * MySQL cannot index as plain columns (IIF, arithmetic, unknown functions).
 */
export function indexParts(expression: string, fieldNames: readonly string[]): IndexPart[] {
    const tokens = tokenize(expression)
    const fields = new Map(fieldNames.map(f => [f.toUpperCase(), f]))
    let pos = 0
    const peek = () => tokens[pos]
    const take = () => tokens[pos++]
    const expect = (op: string) => {
        const tok = take()
        if (tok?.t !== 'op' || tok.v !== op) throw new Error(`expected "${op}"`)
    }

    // Literal arguments such as the 20 in LEFT(NAME, 20).
    const numberArg = (): number | null => {
        const tok = peek()
        if (tok?.t === 'number') { pos++; return tok.v }
        parse()
        return null
    }

    const term = (): IndexPart[] => {
        const tok = take()
        if (!tok) throw new Error('unexpected end')
        if (tok.t === 'number' || tok.t === 'string') return []
        if (tok.t === 'op') {
            if (tok.v !== '(') throw new Error(`unexpected "${tok.v}"`)
            const inner = parse()
            expect(')')
            return inner
        }
        const next = peek()
        if (next?.t === 'op' && next.v === '(') {
            pos++
            const fn = functionName(tok.v)
            if (!fn) throw new Error(`${tok.v.toUpperCase()}() has no MySQL equivalent`)
            if (fn === 'DELETED') {
                expect(')')
                return []
            }
            const first = parse()
            const extra: (number | null)[] = []
            while (peek()?.t === 'op' && (peek() as { v: string }).v === ',') {
                pos++
                extra.push(numberArg())
            }
            expect(')')
            if ((fn === 'LEFT' || fn === 'SUBSTR') && first.length === 1) {
                const [start, length] = fn === 'LEFT' ? [1, extra[0]] : [extra[0], extra[1]]
                if (start !== 1) throw new Error(`${fn}() from the middle of a field has no MySQL equivalent`)
                return length ? [{ field: first[0].field, prefix: length }] : first
            }
            return first
        }
        // alias.field / alias->field: the alias is this table.
        if (next?.t === 'op' && next.v === '.') {
            pos++
            const field = take()
            if (field?.t !== 'name') throw new Error('expected a field name after the alias')
            return [{ field: resolveField(field.v) }]
        }
        return [{ field: resolveField(tok.v) }]
    }

    const resolveField = (name: string): string => {
        // Tables of a Visual FoxPro database keep long names in the .DBC; the .DBF header (and so
        // this table) only has their first 10 letters, while index expressions use the long name.
        const field = fields.get(name.toUpperCase()) ?? (name.length > 10 ? fields.get(name.slice(0, 10).toUpperCase()) : undefined)
        if (!field) throw new Error(`${name} is not a field of the table`)
        return field
    }

    // Concatenation with + (and -, which concatenates while moving trailing blanks).
    function parse(): IndexPart[] {
        const parts = [...term()]
        while (peek()?.t === 'op' && ['+', '-'].includes((peek() as { v: string }).v)) {
            pos++
            parts.push(...term())
        }
        return parts
    }

    const parts = parse()
    if (pos < tokens.length) throw new Error('unexpected text after the expression')
    // A field repeated in one key adds nothing to a MySQL index.
    const seen = new Set<string>()
    return parts.filter(p => !seen.has(p.field) && seen.add(p.field))
}
