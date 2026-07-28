import { Card } from "./ui/card";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";
import type { DbfHeader } from "@/api/api.types";

function Stat({
    label,
    value,
    mono = true,
} : {
    label: string
    value: string | number
    mono?: boolean
}) {
    return (
        <div className="flex flex-col gap-0.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
            <span className={cn('text-sm text-foreground', mono && 'font-mono tabular-nums')}>{value}</span>
        </div>
    )
}

const hex = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(2, '0')}`

interface HeaderInspectorProps {
    readonly header: DbfHeader
    readonly encoding: string
}

export function HeaderInspector({ header, encoding}: HeaderInspectorProps){
    const { lastUpdate, tableFlags } = header
    const updated = `${2000 + (lastUpdate.year % 100)} - ${String(lastUpdate.month).padStart(2, '0')}-${String(lastUpdate.day).padStart(2, '0')}`

    return(
        <Card className="border-border/60 bg-card/40 p-4">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
                <Stat label="Type byte" value={hex(header.typeByte)} />
                <Stat label="Format" value={header.typeName} mono={false} />
                <Stat label="Records" value={header.recordCount.toLocaleString()} />
                <Stat label="Rocord length" value={`${header.recordLength} B`} />
                <Stat label="Data offset" value={hex(header.firstRecordOffset)} />
                <Stat label="Last update" value={updated} />
                <Stat label="Code page" value={hex(header.codePage)} />
                <Stat label="Encoding" value={encoding} mono={false} />
                <Stat label="Fields" value={header.fields.length} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2 border-2 border-t border-border/40 pt-3">
                {header.hasMemo && (
                    <Badge variant="outline" className="border-rose-500/30 text-rose-300">Memo</Badge>
                )}
                {tableFlags.hasStructuralCdx && (
                    <Badge variant="outline" className="border-sky-500/30 text-sky-300">.cdx index</Badge> 
                )}
                {tableFlags.isDatabase && (
                    <Badge variant="outline" className="border-amber-500/30 text-amber-300">.dbc database</Badge>
                )}
                {!header.hasMemo && !tableFlags.hasStructuralCdx && !tableFlags.isDatabase && (
                    <span className="text-xs text-muted-foreground">No structural flags set</span>
                )}
            </div>
        </Card>
    )
}