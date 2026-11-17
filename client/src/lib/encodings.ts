import { translate } from '@/i18n';
import type { EncodingSource } from "@/api/api.types";

/** Encodings offered for a table; values are TextDecoder labels, '' = automatic. */
export const ENCODINGS = [
    { value: '', get label() { return translate("Automatic") } },
    { value: 'cp866', get label() { return translate("cp866 — DOS, Cyrillic") } },
    { value: 'windows-1251', get label() { return translate("windows-1251 — Windows, Cyrillic") } },
    { value: 'koi8-r', label: 'koi8-r' },
    { value: 'utf-8', label: 'utf-8' },
    { value: 'windows-1252', get label() { return translate("windows-1252 — Western European") } },
    { value: 'latin1', label: 'latin1' },
    { value: 'x-mac-cyrillic', get label() { return translate("x-mac-cyrillic — Mac, Cyrillic") } },
    { value: 'cp437', get label() { return translate("cp437 — DOS, US") } },
    { value: 'cp850', get label() { return translate("cp850 — DOS, Western European") } },
    { value: 'cp852', get label() { return translate("cp852 — DOS, Central European") } },
    { value: 'cp620', get label() { return translate("cp620 — DOS, Polish (Mazovia)") } },
    { value: 'windows-1250', get label() { return translate("windows-1250 — Windows, Central European") } },
] as const

export const ENCODING_SOURCE_LABEL: Readonly<Record<EncodingSource, string>> = {
    get codepage() { return translate("from code page marker") },
    get detected() { return translate("detected from text") },
    get manual() { return translate("selected by you") },
}
