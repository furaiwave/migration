import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "@/lib/utils";

interface RecordPreviewTableProps {
    readonly fieldNames: readonly string[]
    readonly rows: ReadonlyArray<Readonly<Record<string, string>>>
}

export function RecordPreviewTable({ fieldNames, rows }: RecordPreviewTableProps){
    if(rows.length === 0) {
        return(
            <div className="flex h-32 items-center justify-center rounded-md border border-dashed border-border/60 text-sm text-muted-foreground">
                No records to preview - the table is empty or all rows are detected
            </div>
        )
    }

    return(
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead className="w-10 text-right text-muted-foreground">#</TableHead>
                    {fieldNames.map((name) => (
                        <TableHead key={name} className="font-mono whitespace-nowrap">{name}</TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((row, ri) => (
                    <TableRow key={ri}>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">{ri + 1}</TableCell>
                        {fieldNames.map((name) => {
                            const value = row[name] ?? ''
                            const isMemo = value.startsWith('(memo:')
                            const isBool = value === 'true' || value === 'false'

                            return (
                                <TableCell
                                    key={name}
                                    className={cn(
                                        'font-mono whitespace-nowrap',
                                        value === '' && 'text-muted-foreground/40',
                                        isMemo && 'italic text-rose-300/80',
                                        isBool && 'text-emerald-300'
                                    )}
                                >
                                    {value === '' ? '∅' : value}
                                </TableCell>
                            )
                        })}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    )
}