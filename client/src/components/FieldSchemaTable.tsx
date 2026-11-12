import { translate } from '@/i18n';
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
                    <TableHead>{translate("Назва поля")}</TableHead>
                    <TableHead className="w-16">{translate("Код")}</TableHead>
                    <TableHead>{translate("Тип")}</TableHead>
                    <TableHead className="w-24 text-right">{translate("Довжина")}</TableHead>
                    <TableHead className="w-28 text-right">{translate("Знаків після коми")}</TableHead>
                    <TableHead className="w-24 text-right">{translate("Зміщення")}</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {fields.map((f, i) => (
                    <TableRow key={`${f.name}-${f.offset}`} className={f.system ? 'text-muted-foreground' : undefined}>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="font-medium">
                            {f.name}
                            {f.system && <span className="ml-2 text-xs font-normal">{translate("службове поле, не експортується")}</span>}
                            {f.nullable && <span className="ml-2 text-xs font-normal text-sky-700 dark:text-sky-300">{translate("допускає NULL")}</span>}
                        </TableCell>
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
