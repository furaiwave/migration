/** Russian → Latin, close to the passport (ICAO) scheme; used for MySQL identifiers and name matching. */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
    к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
    х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    і: 'i', ї: 'yi', є: 'ye', ґ: 'g', '№': 'n',
}

/** Lower-cased, Cyrillic spelled in Latin letters; everything else untouched. */
export function transliterate(s: string): string {
    let out = ''
    for (const ch of s.toLowerCase()) out += CYRILLIC_TO_LATIN[ch] ?? ch
    return out
}
