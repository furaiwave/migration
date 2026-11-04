/** Ukrainian plural form for n: plural(5, 'таблиця', 'таблиці', 'таблиць') → 'таблиць'. */
export function plural(n: number, one: string, few: string, many: string): string {
    const tens = Math.abs(n) % 100
    const units = tens % 10
    if (tens >= 11 && tens <= 14) return many
    if (units === 1) return one
    if (units >= 2 && units <= 4) return few
    return many
}
