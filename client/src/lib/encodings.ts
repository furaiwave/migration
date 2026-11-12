import { translate } from '@/i18n';
import type { EncodingSource } from "@/api/api.types";

/** Encodings offered for a table; values are TextDecoder labels, '' = automatic. */
export const ENCODINGS = [
    { value: '', get label() { return translate("Автоматично") } },
    { value: 'cp866', get label() { return translate("cp866 — DOS, кирилиця") } },
    { value: 'windows-1251', get label() { return translate("windows-1251 — Windows, кирилиця") } },
    { value: 'koi8-r', label: 'koi8-r' },
    { value: 'utf-8', label: 'utf-8' },
    { value: 'windows-1252', get label() { return translate("windows-1252 — західноєвропейська") } },
    { value: 'latin1', label: 'latin1' },
    { value: 'x-mac-cyrillic', get label() { return translate("x-mac-cyrillic — Mac, кирилиця") } },
    { value: 'cp437', get label() { return translate("cp437 — DOS, США") } },
    { value: 'cp850', get label() { return translate("cp850 — DOS, західноєвропейська") } },
    { value: 'cp852', get label() { return translate("cp852 — DOS, центральноєвропейська") } },
    { value: 'cp620', get label() { return translate("cp620 — DOS, польська (Mazovia)") } },
    { value: 'windows-1250', get label() { return translate("windows-1250 — Windows, центральноєвропейська") } },
] as const

export const ENCODING_SOURCE_LABEL: Readonly<Record<EncodingSource, string>> = {
    get codepage() { return translate("за позначкою кодової сторінки") },
    get detected() { return translate("визначено за текстом") },
    get manual() { return translate("вибрано вами") },
}
