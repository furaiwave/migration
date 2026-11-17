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
    if(header.tableFlags.hasStructuralCdx) flags.push(translate(".cdx index"))
    if(header.tableFlags.isDatabase) flags.push(translate(".dbc database"))
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
        [translate("Format"), header.typeName],
        [translate("Type byte"), hex(header.typeByte)],
        [translate("Records (label)"), liveRecords.toLocaleString(getLanguage())],
        [translate("Deleted"), (header.recordCount - liveRecords).toLocaleString(getLanguage())],
        [translate("Fields"), String(header.fields.length)],
        [translate("Record length"), translate("{0} B", [header.recordLength])],
        [translate("Data offset"), `${header.firstRecordOffset} (${hex(header.firstRecordOffset)})`],
        [translate("Last update"), formatLastUpdate(header.lastUpdate)],
        [translate("Code page"), hex(header.codePage)],
        [translate("Encoding"), encoding ?? '—'],
        [translate("Flags"), flagsOf(header)],
        [translate("Memo file"), memoFile ?? '—'],
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
