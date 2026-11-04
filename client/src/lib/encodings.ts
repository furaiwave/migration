import type { EncodingSource } from "@/api/api.types";

/** Encodings offered for a table; values are TextDecoder labels, '' = automatic. */
export const ENCODINGS = [
    { value: '', label: 'Автоматично' },
    { value: 'cp866', label: 'cp866 — DOS, кирилиця' },
    { value: 'windows-1251', label: 'windows-1251 — Windows, кирилиця' },
    { value: 'koi8-r', label: 'koi8-r' },
    { value: 'utf-8', label: 'utf-8' },
    { value: 'windows-1252', label: 'windows-1252 — західноєвропейська' },
    { value: 'latin1', label: 'latin1' },
    { value: 'x-mac-cyrillic', label: 'x-mac-cyrillic — Mac, кирилиця' },
    { value: 'cp437', label: 'cp437 — DOS, США' },
    { value: 'cp850', label: 'cp850 — DOS, західноєвропейська' },
    { value: 'cp852', label: 'cp852 — DOS, центральноєвропейська' },
    { value: 'cp620', label: 'cp620 — DOS, польська (Mazovia)' },
    { value: 'windows-1250', label: 'windows-1250 — Windows, центральноєвропейська' },
] as const

export const ENCODING_SOURCE_LABEL: Readonly<Record<EncodingSource, string>> = {
    codepage: 'за позначкою кодової сторінки',
    detected: 'визначено за текстом',
    manual: 'вибрано вами',
}
