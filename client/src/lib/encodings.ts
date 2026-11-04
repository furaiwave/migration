import type { EncodingSource } from "@/api/api.types";

/** Encodings offered for a table; values are TextDecoder labels, '' = automatic. */
export const ENCODINGS = [
    { value: '', label: 'Automatic' },
    { value: 'cp866', label: 'cp866 — DOS Cyrillic' },
    { value: 'windows-1251', label: 'windows-1251 — Windows Cyrillic' },
    { value: 'koi8-r', label: 'koi8-r' },
    { value: 'utf-8', label: 'utf-8' },
    { value: 'windows-1252', label: 'windows-1252 — Western' },
    { value: 'latin1', label: 'latin1' },
    { value: 'x-mac-cyrillic', label: 'x-mac-cyrillic — Mac Cyrillic' },
    { value: 'cp437', label: 'cp437 — DOS US' },
    { value: 'cp850', label: 'cp850 — DOS Western' },
    { value: 'cp852', label: 'cp852 — DOS Central European' },
    { value: 'cp620', label: 'cp620 — DOS Polish (Mazovia)' },
    { value: 'windows-1250', label: 'windows-1250 — Windows Central European' },
] as const

export const ENCODING_SOURCE_LABEL: Readonly<Record<EncodingSource, string>> = {
    codepage: 'from the code page mark',
    detected: 'guessed from the text',
    manual: 'chosen by you',
}
