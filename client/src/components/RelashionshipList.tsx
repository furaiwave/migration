import { ArrowRight } from "lucide-react";
import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";
import type { DbfRelationship, RelationshipConfidence, RelationshipKind } from "@/api/api.types";


const KIND_META: Record<RelationshipKind, { label: string; className: string }> = {
    auto_name: {
        label: 'name match',
        className: 'border-sky-500/30 text-sky-300',
    },
    auto_fk: {
        label: 'foreign key',
        className: 'border-amber-500/30 text-amber-300'
    },
    manual: {
        label: 'manual',
        className: 'border-emerald-500/30 text-emerald-300'
    }
}

const CONFIDENCE_STYLE: Record<RelationshipConfidence, string> = {
    certain: 'text-emerald-400',
    high: 'text-sky-400',
    medium: 'text-amber-400',
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

function RelationshipRow({ rel }: { rel: DbfRelationship }) {
    const meta = KIND_META[rel.kind]
    return (
        <li className="flex flex-col gap-2 reounded-md border border-border/50 bg-card/40 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-sm">
                <span className="text-foreground">{rel.sourceField}</span>
                <span className="text-muted-foreground">.</span>
                <span className="text-sky-300">{rel.sourceField}</span>
                <ArrowRight className="size-3.5 text-muted-foreground" />
                <span className="size-3.5 text-muted-foreground" />
                <span className="text-foreground">{rel.targetFile}</span>
                <span className="text-muted-foreground">.</span>
                <span className="text-amber-300">{rel.targetField}</span>
            </div>
            <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{relationshipDetail(rel)}</span>
                {rel.kind !== 'manual' && (
                    <span className={cn('text-xs font-medium', CONFIDENCE_STYLE[rel.confidence])}>{rel.confidence}</span>
                )}
                <Badge variant="outline" className={meta.className}>{meta.label}</Badge>
            </div>
        </li>
    )
}

interface RelationshipListProps {
    readonly relationships: readonly DbfRelationship[]
}

export function RelationshipList({ relationships }: RelationshipListProps){
    if(relationships.length === 0){
        return (
            <div className="flex h-24 items-center justify-center rounded-md border border-dashed border-border/60 text-sm text-muted-foreground">
                No relationships detected yet. Add one manually below.
            </div>
        )
    }

    return (
        <ul className="flex flex-col gap-2">
            {relationships.map((rel, i) => (
                <RelationshipRow key={`${rel.kind}-${rel.sourceFile}-${rel.sourceField}-${i}`} rel={rel} />
            ))}
        </ul>
    )
}