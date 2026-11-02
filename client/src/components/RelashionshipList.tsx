import { Badge } from "./ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "@/lib/utils";
import type { DbfRelationship, RelationshipConfidence, RelationshipKind } from "@/api/api.types";

const KIND_META: Record<RelationshipKind, { label: string; className: string }> = {
    auto_name: {
        label: 'name match',
        className: 'border-sky-500/30 text-sky-700 dark:text-sky-300',
    },
    auto_fk: {
        label: 'foreign key',
        className: 'border-amber-500/30 text-amber-700 dark:text-amber-300'
    },
    manual: {
        label: 'manual',
        className: 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300'
    }
}

const CONFIDENCE_STYLE: Record<RelationshipConfidence, string> = {
    certain: 'text-emerald-700 dark:text-emerald-400',
    high: 'text-sky-700 dark:text-sky-400',
    medium: 'text-amber-700 dark:text-amber-400',
    low: 'text-muted-foreground'
}

function relationshipDetail(rel: DbfRelationship): string {
    switch(rel.kind){
        case 'auto_name':
            return rel.matchedOn === 'exact_name' ? 'identical field name' : 'normalized name match'
        case 'auto_fk':
            return `inferred from ${rel.inferredFrom}`
        case 'manual':
            return rel.label ?? 'user-defined link'
        default: {
            const _never: never = rel
            return _never
        }
    }
}

interface RelationshipListProps {
    readonly relationships: readonly DbfRelationship[]
}

export function RelationshipList({ relationships }: RelationshipListProps){
    if(relationships.length === 0){
        return (
            <div className="flex h-24 items-center justify-center border border-dashed text-sm text-muted-foreground">
                No relationships detected yet. Add one manually below.
            </div>
        )
    }

    return (
        <Table containerClassName="max-h-[50vh]">
            <TableHeader>
                <TableRow>
                    <TableHead className="w-12 text-right">#</TableHead>
                    <TableHead>Source table</TableHead>
                    <TableHead>Source field</TableHead>
                    <TableHead className="w-10 text-center">→</TableHead>
                    <TableHead>Target table</TableHead>
                    <TableHead>Target field</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Detail</TableHead>
                </TableRow>
            </TableHeader>
            <TableBody>
                {relationships.map((rel, i) => {
                    const meta = KIND_META[rel.kind]
                    return (
                        <TableRow key={`${rel.kind}-${rel.sourceFile}-${rel.sourceField}-${rel.targetFile}-${rel.targetField}-${i}`}>
                            <TableCell className="text-right tabular-nums text-muted-foreground">{i + 1}</TableCell>
                            <TableCell>{rel.sourceFile}</TableCell>
                            <TableCell className="font-medium">{rel.sourceField}</TableCell>
                            <TableCell className="text-center text-muted-foreground">→</TableCell>
                            <TableCell>{rel.targetFile}</TableCell>
                            <TableCell className="font-medium">{rel.targetField}</TableCell>
                            <TableCell><Badge variant="outline" className={meta.className}>{meta.label}</Badge></TableCell>
                            <TableCell className={cn(rel.kind !== 'manual' && CONFIDENCE_STYLE[rel.confidence])}>
                                {rel.kind === 'manual' ? '—' : rel.confidence}
                            </TableCell>
                            <TableCell className="text-muted-foreground">{relationshipDetail(rel)}</TableCell>
                        </TableRow>
                    )
                })}
            </TableBody>
        </Table>
    )
}
