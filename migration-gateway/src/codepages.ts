/**
 * Text decoders for DBF code pages. Node's TextDecoder covers the WHATWG encodings (cp866,
 * windows-125x, koi8-r, utf-8…) but not the DOS code pages FoxPro and Clipper used in Western and
 * Central Europe, so those are decoded here from their tables (upper half, 0x80–0xFF).
 */

export interface TextDecoderLike {
    decode(input?: Uint8Array): string
}

// Rows of 16 characters, 0x80–0xFF. The last character of each table is U+00A0 (no-break space).
const DOS_TABLES: Readonly<Record<string, string>> = {
    cp437:
        'ÇüéâäàåçêëèïîìÄÅ' + 'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' + 'áíóúñÑªº¿⌐¬½¼¡«»' + '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
        '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' + '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' + 'αßΓπΣσµτΦΘΩδ∞φε∩' + '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
    cp850:
        'ÇüéâäàåçêëèïîìÄÅ' + 'ÉæÆôöòûùÿÖÜø£Ø×ƒ' + 'áíóúñÑªº¿®¬½¼¡«»' + '░▒▓│┤ÁÂÀ©╣║╗╝¢¥┐' +
        '└┴┬├─┼ãÃ╚╔╩╦╠═╬¤' + 'ðÐÊËÈıÍÎÏ┘┌█▄¦Ì▀' + 'ÓßÔÒõÕµþÞÚÛÙýÝ¯´' + '­±‗¾¶§÷¸°¨·¹³²■ ',
    cp852:
        'ÇüéâäůćçłëŐőîŹÄĆ' + 'ÉĹĺôöĽľŚśÖÜŤťŁ×č' + 'áíóúĄąŽžĘę¬źČş«»' + '░▒▓│┤ÁÂĚŞ╣║╗╝Żż┐' +
        '└┴┬├─┼Ăă╚╔╩╦╠═╬¤' + 'đĐĎËďŇÍÎě┘┌█▄ŢŮ▀' + 'ÓßÔŃńňŠšŔÚŕŰýÝţ´' + '­˝˛ˇ˘§÷¸°¨˙űŘř■ ',
    // Mazovia (Polish DOS): cp437 with Polish letters in place of some accented ones.
    cp620:
        'ÇüéâäàąçêëèïîćÄĄ' + 'ĘęłôöĆûùŚÖÜ¢Ł¥śƒ' + 'ŹŻóÓńŃźż¿⌐¬½¼¡«»' + '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
        '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' + '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' + 'αßΓπΣσµτΦΘΩδ∞φε∩' + '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ',
}

/** Labels other spellings map to (ibm850, dos-850…). */
const ALIASES: Readonly<Record<string, string>> = {
    ibm437: 'cp437', 'dos-437': 'cp437', 437: 'cp437',
    ibm850: 'cp850', 'dos-850': 'cp850', 850: 'cp850',
    ibm852: 'cp852', 'dos-852': 'cp852', 852: 'cp852',
    mazovia: 'cp620', 620: 'cp620',
}

const tableName = (label: string): string | null => {
    const key = label.trim().toLowerCase()
    const name = ALIASES[key] ?? key
    return name in DOS_TABLES ? name : null
}

class TableDecoder implements TextDecoderLike {
    private readonly upper: readonly string[]

    constructor(table: string) {
        this.upper = [...table]
        if (this.upper.length !== 128) throw new Error(`code page table has ${this.upper.length} characters, expected 128`)
    }

    decode(input: Uint8Array = new Uint8Array()): string {
        let out = ''
        for (const b of input) out += b < 0x80 ? String.fromCharCode(b) : this.upper[b - 0x80]
        return out
    }
}

/** A decoder for any label the DBF reader offers; throws on an unknown one. */
export function createDecoder(label: string): TextDecoderLike {
    const table = tableName(label)
    return table ? new TableDecoder(DOS_TABLES[table]) : new TextDecoder(label)
}

export function isSupportedEncoding(label: string): boolean {
    try {
        createDecoder(label)
        return true
    } catch {
        return false
    }
}
