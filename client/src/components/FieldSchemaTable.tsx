import { Table, TableBody, TableCell, TableHead, TableRow, TableHeader } from "./ui/table";
import { FieldTypeBadge } from "./FieldTypeBadge";
import type { DbfFieldDescriptor } from "@/api/api.types";

interface FieldSchemaTableProps {
    readonly fields: readonly DbfFieldDescriptor[]
}

export function FieldSchemaTable({ fields }: FieldSchemaTableProps){
    return (
        <Table>
            <TableHeader>
                <TableRow>
                    <TableHead className="w-10 text-right">#</TableHead>
                    <TableHead>Head</TableHead>
                    <TableHead className="w-20">Type</TableHead>
                    <TableHead className="w-20 text-right">Length</TableHead>
                    <TableHead className="w-20 text-right">Decimals</TableHead>
                    <TableHead className="w-20 text-right">Offset</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {fields.map((f, i) => (
                    <TableRow key={`${f.name}-${f.offset}`}>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</TableCell>
                        <TableCell className="font-mono font-medium">{f.name}</TableCell>
                        <TableBody><FieldTypeBadge type={f.type} showLabel/></TableBody>
                        <TableCell className="text-right font-mono tabular-nums">{f.length}</TableCell>
                        <TableCell className="text-rigth font-mono tabular-nums text-muted-foreground">
                            {f.type === 'N' || f.type === 'F' ? f.decimalCount: '-'}
                        </TableCell>
                        <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                            {f.offset}
                        </TableCell>
                    </TableRow>
                ))}
            </TableBody>
        </Table>
    )
}