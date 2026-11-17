/** Russian → Latin, close to the passport (ICAO) scheme; used for MySQL identifiers and name matching. */
const CYRILLIC_TO_LATIN: Readonly<Record<string, string>> = {
    \u0430: 'a', \u0431: 'b', \u0432: 'v', \u0433: 'g', \u0434: 'd', \u0435: 'e', \u0451: 'e', \u0436: 'zh', \u0437: 'z', \u0438: 'i', \u0439: 'y',
    \u043a: 'k', \u043b: 'l', \u043c: 'm', \u043d: 'n', \u043e: 'o', \u043f: 'p', \u0440: 'r', \u0441: 's', \u0442: 't', \u0443: 'u', \u0444: 'f',
    \u0445: 'kh', \u0446: 'ts', \u0447: 'ch', \u0448: 'sh', \u0449: 'shch', \u044a: '', \u044b: 'y', \u044c: '', \u044d: 'e', \u044e: 'yu', \u044f: 'ya',
    \u0456: 'i', \u0457: 'yi', \u0454: 'ye', \u0491: 'g', '№': 'n',
}

/** Lower-cased, Cyrillic spelled in Latin letters; everything else untouched. */
export function transliterate(s: string): string {
    let out = ''
    for (const ch of s.toLowerCase()) out += CYRILLIC_TO_LATIN[ch] ?? ch
    return out
}
