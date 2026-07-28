import { Badge } from "./ui/badge";
import { cn } from "@/lib/utils";
import {
    type DbfFieldTypeCode,
    FIELD_TYPE_LABELS,
    fieldCategory,
    type FieldCategory
} from '@/api/api.types'

const CATEGORY_STYLES: Record<FieldCategory, string> = {
    text: 'border-sky-500/30 bg-sky-500/10 text-sky-300',
    number: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
    temporal: 'border-voilet-500/30 bg-violet-500/10 text-violet-300',
    boolean: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
    blob: 'border-rose-500/30 bg-rose-500/10 text-rose-300',  
}

interface FieldTypeBadgeProps {
    readonly type: DbfFieldTypeCode
    readonly showLabel?: boolean
    readonly className?: string
}

export function FieldTypeBadge({ type, showLabel = false, className}: FieldTypeBadgeProps) {
    const category = fieldCategory(type)
    return (
        <Badge
            variant="outline"
            className={cn('font-mono tabular-nums', CATEGORY_STYLES[category], className)}
            title={FIELD_TYPE_LABELS[type]}
        >
            {type}
            {showLabel && <span className="ml-1.5 opacity-70">{FIELD_TYPE_LABELS[type]}</span>}
        </Badge>
    )
}