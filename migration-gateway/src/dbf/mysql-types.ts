import { BadRequestException } from '@nestjs/common'
import type { MysqlColumnOverride, MysqlPlanOverrides, MysqlTableOverride } from '../types/mysql-export.types'

/** How raw field bytes turn into a SQL value. */
export type ValueKind =
    | 'text' | 'number' | 'date' | 'datetime' | 'bool'
    | 'int32' | 'double' | 'currency' | 'binary' | 'memoText' | 'memoBinary'

// ---------------------------------------------------------------- type grammar

/**
 * MySQL column types a user may pick. The type text goes into CREATE TABLE verbatim,
 * so anything outside this grammar is rejected rather than escaped.
 */
const TYPE_PATTERNS: readonly RegExp[] = [
    /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)(\(\d{1,3}\))?( UNSIGNED)?$/,
    /^(DECIMAL|NUMERIC)\((\d{1,2})(,(\d{1,2}))?\)$/,
    /^(FLOAT|DOUBLE|DATE|DATETIME|TIMESTAMP|TIME|YEAR|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|JSON)$/,
    /^(CHAR|BINARY)\((\d{1,3})\)$/,
    /^(VARCHAR|VARBINARY)\((\d{1,5})\)$/,
]

/** Canonical upper-case spelling of a MySQL type, or an error message. */
export function normalizeMysqlType(raw: string): { type: string } | { error: string } {
    const type = raw.trim().toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*\(\s*/g, '(')
        .replace(/\s*,\s*/g, ',')
        .replace(/\s*\)/g, ')')
    if (!TYPE_PATTERNS.some(p => p.test(type)))
        return { error: `"${raw}" is not a supported MySQL type (e.g. INT, BIGINT, DECIMAL(12,2), VARCHAR(100), TEXT, DATE)` }

    const decimal = /^(?:DECIMAL|NUMERIC)\((\d+)(?:,(\d+))?\)$/.exec(type)
    if (decimal) {
        const precision = Number(decimal[1])
        const scale = Number(decimal[2] ?? 0)
        if (precision < 1 || precision > 65 || scale > 30 || scale > precision)
            return { error: `${type}: precision must be 1–65, scale 0–30 and not above the precision` }
    }
    const sized = /^(CHAR|BINARY|VARCHAR|VARBINARY)\((\d+)\)$/.exec(type)
    if (sized) {
        const n = Number(sized[2])
        const max = sized[1] === 'CHAR' || sized[1] === 'BINARY' ? 255 : sized[1] === 'VARCHAR' ? 16383 : 65535
        if (n < 1 || n > max) return { error: `${type}: length must be 1–${max}` }
    }
    return { type }
}

/** TEXT/BLOB/JSON cannot be a PRIMARY/UNIQUE key or a foreign key without a prefix length. */
export const isKeyableType = (type: string): boolean => !/TEXT|BLOB|JSON/.test(type)

/** Whether a text collation clause applies to the type. */
export const isCharacterType = (type: string): boolean => /CHAR|TEXT/.test(type) && !/BINARY/.test(type)

// ---------------------------------------------------------------- value fit

const INT_RANGES: Readonly<Record<string, readonly [bigint, bigint]>> = {
    TINYINT: [-128n, 127n],
    SMALLINT: [-32768n, 32767n],
    MEDIUMINT: [-8388608n, 8388607n],
    INT: [-2147483648n, 2147483647n],
    INTEGER: [-2147483648n, 2147483647n],
    BIGINT: [-(2n ** 63n), 2n ** 63n - 1n],
}

const BYTE_LIMITS: Readonly<Record<string, number>> = {
    TINYTEXT: 255, TEXT: 65535, MEDIUMTEXT: 16777215,
    TINYBLOB: 255, BLOB: 65535, MEDIUMBLOB: 16777215,
}

const NUMERIC_VALUE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i
const DATE_VALUE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/

const isBinaryKind = (kind: ValueKind): boolean => kind === 'binary' || kind === 'memoBinary'

/** Size of the value as MySQL will store it: binary kinds travel as hex. */
const byteLength = (value: string, kind: ValueKind): number =>
    isBinaryKind(kind) ? value.length / 2 : Buffer.byteLength(value, 'utf8')

/**
 * Why a decoded value would be rejected by a strict-mode MySQL column of `type`, or null if it fits.
 * Rounding that MySQL does silently (extra decimals, a time part into DATE) is not reported.
 */
export function typeProblem(value: string, kind: ValueKind, type: string): string | null {
    const base = /^[A-Z]+/.exec(type)?.[0] ?? type
    const unsigned = type.endsWith(' UNSIGNED')

    if (base in INT_RANGES || base === 'DECIMAL' || base === 'NUMERIC' || base === 'FLOAT' || base === 'DOUBLE' || base === 'YEAR') {
        if (isBinaryKind(kind) || !NUMERIC_VALUE.test(value)) return `not a number for ${type}`
        if (base === 'FLOAT' || base === 'DOUBLE') return null
        if (base === 'YEAR') {
            const y = Number(value)
            return y === 0 || (y >= 1901 && y <= 2155) ? null : `out of range for YEAR (1901–2155)`
        }
        if (base === 'DECIMAL' || base === 'NUMERIC') {
            const [, p = '10', s = '0'] = /\((\d+)(?:,(\d+))?\)/.exec(type) ?? []
            const intDigits = value.replace(/^-/, '').replace(/e.*$/i, '').split('.')[0]!.replace(/^0+/, '').length
            const exponent = Number(/e([+-]?\d+)$/i.exec(value)?.[1] ?? 0)
            return intDigits + Math.max(0, exponent) > Number(p) - Number(s) ? `too many digits for ${type}` : null
        }
        const [min, max] = INT_RANGES[base]!
        const lo = unsigned ? 0n : min
        const hi = unsigned ? max * 2n + 1n : max
        let n: bigint
        try {
            n = /e/i.test(value) ? BigInt(Math.round(Number(value))) : BigInt(value.split('.')[0]!.replace(/^-0*$/, '0') || '0')
        } catch {
            return `not a number for ${type}`
        }
        return n < lo || n > hi ? `out of range for ${type} (${lo}…${hi})` : null
    }

    const sized = /^(CHAR|VARCHAR|BINARY|VARBINARY)\((\d+)\)$/.exec(type)
    if (sized) {
        const limit = Number(sized[2])
        const isBytes = sized[1] === 'BINARY' || sized[1] === 'VARBINARY'
        const size = isBytes ? byteLength(value, kind) : [...value].length
        return size > limit ? `longer than ${limit} ${isBytes ? 'bytes' : 'characters'}` : null
    }

    if (base in BYTE_LIMITS) {
        return byteLength(value, kind) > BYTE_LIMITS[base]! ? `larger than ${type} allows (${BYTE_LIMITS[base]} bytes)` : null
    }

    if (base === 'DATE' || base === 'DATETIME' || base === 'TIMESTAMP') {
        if (kind !== 'date' && kind !== 'datetime' && !DATE_VALUE.test(value)) return `not a date (YYYY-MM-DD) for ${type}`
        if (base === 'TIMESTAMP') {
            const year = Number(value.slice(0, 4))
            if (year < 1970 || year > 2037) return 'outside the TIMESTAMP range (1970–2038)'
        }
        return null
    }

    if (base === 'JSON') {
        try {
            JSON.parse(value)
            return null
        } catch {
            return 'not valid JSON'
        }
    }

    return null
}

// ---------------------------------------------------------------- overrides

const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/
const NAME_RULE = 'Latin letters, digits and _ only, up to 64 characters'

const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Validates the plan edits sent by the client. The type and names end up in DDL,
 * so every field is checked here instead of trusting the request shape.
 */
export function normalizeOverrides(raw: unknown): MysqlPlanOverrides {
    if (raw === undefined || raw === null) return {}
    if (!isObject(raw)) throw new BadRequestException('overrides must be an object keyed by DBF file name')

    const out: Record<string, MysqlTableOverride> = {}
    for (const [file, value] of Object.entries(raw)) {
        if (!isObject(value)) throw new BadRequestException(`overrides.${file} must be an object`)
        const table: { -readonly [K in keyof MysqlTableOverride]: MysqlTableOverride[K] } = {}

        if (value.exclude !== undefined) {
            if (typeof value.exclude !== 'boolean') throw new BadRequestException(`overrides.${file}.exclude must be true/false`)
            table.exclude = value.exclude
        }
        if (value.name !== undefined && value.name !== '') {
            if (typeof value.name !== 'string' || !IDENTIFIER.test(value.name))
                throw new BadRequestException(`Table name for ${file}: ${NAME_RULE}`)
            table.name = value.name.toLowerCase()
        }
        if (value.primaryKey !== undefined) {
            if (value.primaryKey !== null && typeof value.primaryKey !== 'string')
                throw new BadRequestException(`overrides.${file}.primaryKey must be a field name or null`)
            table.primaryKey = value.primaryKey
        }
        if (value.columns !== undefined) {
            if (!isObject(value.columns)) throw new BadRequestException(`overrides.${file}.columns must be an object`)
            const columns: Record<string, MysqlColumnOverride> = {}
            for (const [field, col] of Object.entries(value.columns)) {
                if (!isObject(col)) throw new BadRequestException(`overrides.${file}.columns.${field} must be an object`)
                const column: { -readonly [K in keyof MysqlColumnOverride]: MysqlColumnOverride[K] } = {}
                if (col.exclude !== undefined) {
                    if (typeof col.exclude !== 'boolean') throw new BadRequestException(`${file}.${field}: exclude must be true/false`)
                    column.exclude = col.exclude
                }
                if (col.name !== undefined && col.name !== '') {
                    if (typeof col.name !== 'string' || !IDENTIFIER.test(col.name))
                        throw new BadRequestException(`Column name for ${file}.${field}: ${NAME_RULE}`)
                    column.name = col.name.toLowerCase()
                }
                if (col.type !== undefined && col.type !== '') {
                    if (typeof col.type !== 'string') throw new BadRequestException(`${file}.${field}: type must be text`)
                    const normalized = normalizeMysqlType(col.type)
                    if ('error' in normalized) throw new BadRequestException(`${file}.${field}: ${normalized.error}`)
                    column.type = normalized.type
                }
                columns[field] = column
            }
            table.columns = columns
        }
        if (value.excludedIndexes !== undefined) {
            if (!Array.isArray(value.excludedIndexes) || !value.excludedIndexes.every(t => typeof t === 'string'))
                throw new BadRequestException(`overrides.${file}.excludedIndexes must be a list of tag names`)
            table.excludedIndexes = value.excludedIndexes as string[]
        }
        out[file] = table
    }
    return out
}
