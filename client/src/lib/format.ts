import { translate } from '@/i18n';
import type { MysqlOrphans } from "@/api/api.types";
import { plural } from "@/lib/plural";

export const formatDuration = (ms: number): string => {
    const s = Math.round(ms / 1000)
    return s < 60 ? translate("{0} s", [s]) : translate("{0} min {1} s", [Math.floor(s / 60), String(s % 60).padStart(2, '0')])
}

/** "2 \u0437\u043d\u0430\u0447\u0435\u043d\u043d\u044f \u0431\u0435\u0437 \u0432\u0456\u0434\u043f\u043e\u0432\u0456\u0434\u043d\u0438\u043a\u0430 (9 \u0440\u044f\u0434\u043a\u0456\u0432, \u043d\u0430\u043f\u0440. 0, 9) → NULL" for a link kept by nulling them. */
export function orphansNote(o: MysqlOrphans, nullWord = 'NULL'): string {
    return translate("{0} unmatched {1} ", [o.values, plural(o.values, translate("value"), translate("value"), translate("values"))]) +
        translate("({0} {1}, e.g. {2}) → {3}", [o.rows, plural(o.rows, translate("row (standalone)"), translate("rows (few)"), translate("rows (many)")), o.examples.join(', '), nullWord])
}
