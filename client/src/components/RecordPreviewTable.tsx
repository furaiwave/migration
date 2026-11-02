import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { FieldTypeBadge } from "./FieldTypeBadge";
import { cn } from "@/lib/utils";
import { fieldCategory, type DbfFieldDescriptor } from "@/api/api.types";

interface RecordPreviewTableProps {
    readonly fields: readonly DbfFieldDescriptor[]
    readonly rows: ReadonlyArray<Readonly<Record<string, string>>>
}

// Line breaks would otherwise collapse into spaces; show them, keep the row one line high.
const oneLine = (value: string): string => value.replace(/\r?\n/g, ' ↵ ')

// DBF stores dates as YYYYMMDD; show them the way MySQL will.
const formatCell = (type: DbfFieldDescriptor['type'], value: string): string =>
    type === 'D' && /^\d{8}$/.test(value) ? `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}` : oneLine(value)

export function RecordPreviewTable({ fields, rows }: RecordPreviewTableProps){
    if(rows.length === 0) {
        return(
            <div className="flex h-32 items-center justify-center border border-dashed text-sm text-muted-foreground">
                No records to preview — the table is empty or all rows are deleted
            </div>
        )
    }

    return(
        <Table containerClassName="max-h-[60vh]">
            <TableHeader>
                <TableRow>
                    <TableHead className="w-12 text-right text-muted-foreground">#</TableHead>
                    {fields.map((f) => (
                        <TableHead key={f.name} className={cn(fieldCategory(f.type) === 'number' && 'text-right')}>
                            <span className="inline-flex items-center gap-2">
                                {f.name}
                                <FieldTypeBadge type={f.type} />
                            </span>
                        </TableHead>
                    ))}
                </TableRow>
            </TableHeader>
            <TableBody>
                {rows.map((row, ri) => (
                    <TableRow key={ri}>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{ri + 1}</TableCell>
                        {fields.map((f) => {
                            const value = row[f.name] ?? ''
                            const isMemo = value.startsWith('(memo:')
                            const isBool = value === 'true' || value === 'false'

                            return (
                                <TableCell
                                    key={f.name}
                                    title={value.length > 40 || value.includes('\n') ? value : undefined}
                                    className={cn(
                                        fieldCategory(f.type) === 'number' && 'text-right tabular-nums',
                                        value === '' && 'text-muted-foreground/50',
                                        isMemo && 'italic text-rose-700 dark:text-rose-300',
                                        isBool && 'text-emerald-700 dark:text-emerald-300'
                                    )}
                                >
                                    {/* max-width is ignored on <td> itself, so the limit sits on an inner block. */}
                                    <span className="block max-w-[28rem] truncate">{value === '' ? '∅' : formatCell(f.type, value)}</span>
                                </TableCell>
                            )
                        })}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    )
}
