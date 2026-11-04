// Mirrors the server's grammar (migration-gateway/src/dbf/mysql-types.ts) so a bad type is caught
// while typing instead of failing every plan request after it.

const TYPE_PATTERNS: readonly RegExp[] = [
    /^(TINYINT|SMALLINT|MEDIUMINT|INT|INTEGER|BIGINT)(\(\d{1,3}\))?( UNSIGNED)?$/,
    /^(DECIMAL|NUMERIC)\((\d{1,2})(,(\d{1,2}))?\)$/,
    /^(FLOAT|DOUBLE|DATE|DATETIME|TIMESTAMP|TIME|YEAR|TINYTEXT|TEXT|MEDIUMTEXT|LONGTEXT|TINYBLOB|BLOB|MEDIUMBLOB|LONGBLOB|JSON)$/,
    /^(CHAR|BINARY)\((\d{1,3})\)$/,
    /^(VARCHAR|VARBINARY)\((\d{1,5})\)$/,
]

export const MYSQL_TYPE_SUGGESTIONS = [
    'INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'TINYINT(1)', 'INT UNSIGNED',
    'DECIMAL(12,2)', 'DECIMAL(19,4)', 'DOUBLE',
    'VARCHAR(50)', 'VARCHAR(255)', 'CHAR(10)', 'TEXT', 'MEDIUMTEXT', 'LONGTEXT',
    'DATE', 'DATETIME', 'LONGBLOB',
] as const

const normalize = (raw: string): string =>
    raw.trim().toUpperCase()
        .replace(/\s+/g, ' ')
        .replace(/\s*\(\s*/g, '(')
        .replace(/\s*,\s*/g, ',')
        .replace(/\s*\)/g, ')')

/** Why the type is not accepted, or null when it is. Empty means "back to automatic". */
export function mysqlTypeError(raw: string): string | null {
    if (raw.trim() === '') return null
    const type = normalize(raw)
    if (!TYPE_PATTERNS.some((p) => p.test(type))) return 'Непідтримуваний тип — наприклад INT, BIGINT, DECIMAL(12,2), VARCHAR(100), TEXT, DATE'
    const decimal = /^(?:DECIMAL|NUMERIC)\((\d+)(?:,(\d+))?\)$/.exec(type)
    if (decimal) {
        const precision = Number(decimal[1])
        const scale = Number(decimal[2] ?? 0)
        if (precision < 1 || precision > 65 || scale > 30 || scale > precision) return 'Точність 1–65, знаків після коми 0–30 і не більше за точність'
    }
    const sized = /^(CHAR|BINARY|VARCHAR|VARBINARY)\((\d+)\)$/.exec(type)
    if (sized) {
        const n = Number(sized[2])
        const max = sized[1] === 'CHAR' || sized[1] === 'BINARY' ? 255 : sized[1] === 'VARCHAR' ? 16383 : 65535
        if (n < 1 || n > max) return `Довжина має бути 1–${max}`
    }
    return null
}

const IDENTIFIER = /^[A-Za-z0-9_]{1,64}$/

/** Why a table/column name is not accepted, or null. Empty means "back to the generated name". */
export const identifierError = (raw: string): string | null =>
    raw === '' || IDENTIFIER.test(raw) ? null : 'Лише латинські літери, цифри та _, до 64 символів'
