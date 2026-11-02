import { Table, TableBody, TableCell, TableHead, TableRow, TableHeader } from "./ui/table";
import { FieldTypeBadge } from "./FieldTypeBadge";
import { FIELD_TYPE_LABELS, type DbfFieldDescriptor } from "@/api/api.types";

interface FieldSchemaTableProps {
    readonly fields: readonly DbfFieldDescriptor[]
}

export function FieldSchemaTable({ fields }: FieldSchemaTableProps){
    return (
        <Table containerClassName="max-h-[60vh]">
            <TableHeader>
                <TableRow>
                    <TableHead className="w-12 text-right">#</TableHead>
                    <TableHead>Field name</TableHead>
                    <TableHead className="w-16">Code</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead className="w-24 text-right">Length</TableHead>
                    <TableHead className="w-24 text-right">Decimals</TableHead>
                    <TableHead className="w-24 text-right">Offset</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {fields.map((f, i) => (
                    <TableRow key={`${f.name}-${f.offset}`}>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="font-medium">{f.name}</TableCell>
                        <TableCell><FieldTypeBadge type={f.type} /></TableCell>
                        <TableCell>{FIELD_TYPE_LABELS[f.type]}</TableCell>
                        <TableCell className="text-right tabular-nums">{f.length}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                            {f.type === 'N' || f.type === 'F' ? f.decimalCount : '—'}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{f.offset}</TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    )
}
