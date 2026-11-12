import { translate, getLanguage } from '@/i18n';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import type { DbfHeader } from "@/api/api.types";

const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`

function formatLastUpdate({ year, month, day }: DbfHeader['lastUpdate']): string {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function flagsOf(header: DbfHeader): string {
    const flags: string[] = []
    if(header.hasMemo) flags.push('memo')
    if(header.tableFlags.hasStructuralCdx) flags.push(translate("індекс .cdx"))
    if(header.tableFlags.isDatabase) flags.push(translate("база .dbc"))
    return flags.length > 0 ? flags.join(', ') : '—'
}

interface HeaderInspectorProps {
    readonly header: DbfHeader
    readonly encoding?: string
    readonly memoFile?: string | null
    /** Records not marked deleted. */
    readonly liveRecords: number
}

export function HeaderInspector({ header, encoding, memoFile, liveRecords }: HeaderInspectorProps){
    const columns: ReadonlyArray<readonly [label: string, value: string]> = [
        [translate("Формат"), header.typeName],
        [translate("Байт типу"), hex(header.typeByte)],
        [translate("Записи"), liveRecords.toLocaleString(getLanguage())],
        [translate("Видалені"), (header.recordCount - liveRecords).toLocaleString(getLanguage())],
        [translate("Поля"), String(header.fields.length)],
        [translate("Довжина запису"), translate("{0} Б", [header.recordLength])],
        [translate("Зміщення даних"), `${header.firstRecordOffset} (${hex(header.firstRecordOffset)})`],
        [translate("Останнє оновлення"), formatLastUpdate(header.lastUpdate)],
        [translate("Кодова сторінка"), hex(header.codePage)],
        [translate("Кодування"), encoding ?? '—'],
        [translate("Ознаки"), flagsOf(header)],
        [translate("Memo-файл"), memoFile ?? '—'],
    ]

    return(
        <Table>
            <TableHeader>
                <TableRow>
                    {columns.map(([label]) => <TableHead key={label}>{label}</TableHead>)}
                </TableRow>
            </TableHeader>
            <TableBody>
                <TableRow>
                    {columns.map(([label, value]) => <TableCell key={label} className="tabular-nums">{value}</TableCell>)}
                </TableRow>
            </TableBody>
        </Table>
    )
}
