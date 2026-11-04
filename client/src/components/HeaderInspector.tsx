import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import type { DbfHeader } from "@/api/api.types";

const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`

function formatLastUpdate({ year, month, day }: DbfHeader['lastUpdate']): string {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function flagsOf(header: DbfHeader): string {
    const flags: string[] = []
    if(header.hasMemo) flags.push('memo')
    if(header.tableFlags.hasStructuralCdx) flags.push('індекс .cdx')
    if(header.tableFlags.isDatabase) flags.push('база .dbc')
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
        ['Формат', header.typeName],
        ['Байт типу', hex(header.typeByte)],
        ['Записи', liveRecords.toLocaleString()],
        ['Видалені', (header.recordCount - liveRecords).toLocaleString()],
        ['Поля', String(header.fields.length)],
        ['Довжина запису', `${header.recordLength} Б`],
        ['Зміщення даних', `${header.firstRecordOffset} (${hex(header.firstRecordOffset)})`],
        ['Останнє оновлення', formatLastUpdate(header.lastUpdate)],
        ['Кодова сторінка', hex(header.codePage)],
        ['Кодування', encoding ?? '—'],
        ['Ознаки', flagsOf(header)],
        ['Memo-файл', memoFile ?? '—'],
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
