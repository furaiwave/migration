import type { MysqlOrphans } from "@/api/api.types";
import { plural } from "@/lib/plural";

export const formatDuration = (ms: number): string => {
    const s = Math.round(ms / 1000)
    return s < 60 ? `${s} с` : `${Math.floor(s / 60)} хв ${String(s % 60).padStart(2, '0')} с`
}

/** "2 значення без відповідника (9 рядків, напр. 0, 9) → NULL" for a link kept by nulling them. */
export function orphansNote(o: MysqlOrphans, nullWord = 'NULL'): string {
    return `${o.values} ${plural(o.values, 'значення', 'значення', 'значень')} без відповідника ` +
        `(${o.rows} ${plural(o.rows, 'рядок', 'рядки', 'рядків')}, напр. ${o.examples.join(', ')}) → ${nullWord}`
}
