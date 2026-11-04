import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { FieldTypeBadge } from "./FieldTypeBadge";
import { cn } from "@/lib/utils";
import { fieldCategory, type DbfFieldDescriptor } from "@/api/api.types";

interface RecordPreviewTableProps {
    readonly fields: readonly DbfFieldDescriptor[]
    /** Values as text; null where Visual FoxPro stored NULL. */
    readonly rows: ReadonlyArray<Readonly<Record<string, string | null>>>
}

// Line breaks would otherwise collapse into spaces; show them, keep the row one line high.
const oneLine = (value: string): string => value.replace(/\r?\n/g, ' ↵ ')

const isDbfDate = (value: string): boolean => /^\d{8}$/.test(value)

// DBF stores dates as YYYYMMDD; show them the way MySQL will.
const formatDate = (value: string): string => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}`

/** How one cell is shown: the text, its colour, and a tooltip where the text alone is not enough. */
function cellView(field: DbfFieldDescriptor, value: string | null): { text: string; className?: string; title?: string } {
    if (value === null) return { text: 'NULL', className: 'text-xs font-medium tracking-wide text-sky-700 dark:text-sky-300', title: 'NULL у Visual FoxPro — у MySQL теж буде NULL' }
    if (value === '') return { text: '∅', className: 'text-muted-foreground/50', title: 'Порожньо' }
    if (value.startsWith('(memo:')) return { text: value, className: 'italic text-rose-700 dark:text-rose-300' }
    if (field.type === 'L') {
        return value === 'true'
            ? { text: '✓ так', className: 'text-emerald-700 dark:text-emerald-300' }
            : { text: '✗ ні', className: 'text-muted-foreground' }
    }
    if (field.type === 'D') {
        return isDbfDate(value)
            ? { text: formatDate(value) }
            : { text: value, className: 'text-amber-700 dark:text-amber-300', title: 'Некоректна дата — у MySQL стане NULL' }
    }
    if (field.type === 'Q') return { text: value, className: 'font-mono text-xs' }
    const long = value.length > 40 || /\n/.test(value)
    return { text: oneLine(value), title: long ? value : undefined }
}

export function RecordPreviewTable({ fields, rows }: RecordPreviewTableProps){
    // _NullFlags is FoxPro's bookkeeping; its meaning is already in the NULL cells.
    const columns = fields.filter((f) => !f.system)

    if(rows.length === 0) {
        return(
            <div className="flex h-32 items-center justify-center border border-dashed text-sm text-muted-foreground">
                Немає записів для перегляду — таблиця порожня або всі записи видалено
            </div>
        )
    }

    return(
        <Table containerClassName="max-h-[60vh]">
            <TableHeader>
                <TableRow>
                    <TableHead className="w-12 text-right text-muted-foreground">#</TableHead>
                    {columns.map((f) => (
                        <TableHead key={f.name} className={cn(fieldCategory(f.type) === 'number' && 'text-right')}>
                            <span className="inline-flex items-center gap-2" title={f.nullable ? 'Може містити NULL' : undefined}>
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
                        {columns.map((f) => {
                            // Only a missing key is empty; null is NULL and must stay distinguishable.
                            const value = row[f.name]
                            const view = cellView(f, value === undefined ? '' : value)
                            return (
                                <TableCell
                                    key={f.name}
                                    title={view.title}
                                    className={cn(fieldCategory(f.type) === 'number' && 'text-right tabular-nums', view.className)}
                                >
                                    {/* max-width is ignored on <td> itself, so the limit sits on an inner block. */}
                                    <span className="block max-w-[28rem] truncate">{view.text}</span>
                                </TableCell>
                            )
                        })}
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    )
}
