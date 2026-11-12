import { translate } from '@/i18n';
import type { MysqlOrphans } from "@/api/api.types";
import { plural } from "@/lib/plural";

export const formatDuration = (ms: number): string => {
    const s = Math.round(ms / 1000)
    return s < 60 ? translate("{0} с", [s]) : translate("{0} хв {1} с", [Math.floor(s / 60), String(s % 60).padStart(2, '0')])
}

/** "2 значення без відповідника (9 рядків, напр. 0, 9) → NULL" for a link kept by nulling them. */
export function orphansNote(o: MysqlOrphans, nullWord = 'NULL'): string {
    return translate("{0} {1} без відповідника ", [o.values, plural(o.values, translate("значення"), translate("значення"), translate("значень"))]) +
        translate("({0} {1}, напр. {2}) → {3}", [o.rows, plural(o.rows, translate("рядок"), translate("рядки"), translate("рядків")), o.examples.join(', '), nullWord])
}
