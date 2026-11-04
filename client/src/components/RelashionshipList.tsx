import { Trash2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "@/lib/utils";
import type { DbfRelationship, GraphRelationship, RelationshipConfidence, RelationshipKind } from "@/api/api.types";

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
    readonly relationships: readonly GraphRelationship[]
    /** Id of the link whose change is in flight; its controls are locked meanwhile. */
    readonly busyId: string | null
    readonly onToggle: (rel: GraphRelationship, disabled: boolean) => void
    readonly onDelete: (rel: GraphRelationship) => void
}

export function RelationshipList({ relationships, busyId, onToggle, onDelete }: RelationshipListProps){
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
                    <TableHead className="w-16 text-center" title="Unchecked links are kept here but left out of the MySQL export">Use</TableHead>
                    <TableHead>Source table</TableHead>
                    <TableHead>Source field</TableHead>
                    <TableHead className="w-10 text-center">→</TableHead>
                    <TableHead>Target table</TableHead>
                    <TableHead>Target field</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Confidence</TableHead>
                    <TableHead>Detail</TableHead>
                    <TableHead className="w-12" />
                </TableRow>
            </TableHeader>
            <TableBody>
                {relationships.map((rel, i) => {
                    const meta = KIND_META[rel.kind]
                    const busy = busyId === rel.id
                    return (
                        <TableRow
                            key={rel.id}
                            className={cn(rel.disabled && 'text-muted-foreground [&>td:not(:nth-child(2)):not(:last-child)]:line-through [&>td:not(:nth-child(2)):not(:last-child)]:opacity-60')}
                        >
                            <TableCell className="text-right tabular-nums text-muted-foreground">{i + 1}</TableCell>
                            <TableCell className="text-center">
                                <input
                                    type="checkbox"
                                    className="size-3.5 cursor-pointer accent-primary align-middle"
                                    checked={!rel.disabled}
                                    disabled={busy}
                                    aria-label={`Use link ${rel.sourceFile}.${rel.sourceField} → ${rel.targetFile}.${rel.targetField}`}
                                    onChange={(e) => onToggle(rel, !e.target.checked)}
                                />
                            </TableCell>
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
                            <TableCell className="text-center">
                                {rel.kind === 'manual' && (
                                    <button
                                        className="text-muted-foreground hover:text-destructive disabled:opacity-40"
                                        disabled={busy}
                                        onClick={() => onDelete(rel)}
                                        aria-label="Delete this link"
                                        title="Delete this link"
                                    >
                                        <Trash2 className="size-3.5" />
                                    </button>
                                )}
                            </TableCell>
                        </TableRow>
                    )
                })}
            </TableBody>
        </Table>
    )
}
