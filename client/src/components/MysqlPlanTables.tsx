import { Fragment, useState } from "react";
import { CheckCircle2, RotateCcw } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { FieldTypeBadge } from "./FieldTypeBadge";
import { cn } from "@/lib/utils";
import { identifierError, mysqlTypeError, MYSQL_TYPE_SUGGESTIONS } from "@/lib/mysqlTypes";
import type {
    MysqlColumnOverride,
    MysqlColumnPlan,
    MysqlExportPlan,
    MysqlIndexPlan,
    MysqlPlanOverrides,
    MysqlTableOverride,
    MysqlTablePlan,
} from "@/api/api.types";

const TYPE_LIST_ID = 'mysql-type-suggestions'
const PK_AUTO = '__auto__'
const PK_NONE = '__none__'

interface PlanEdits {
    readonly overrides: MysqlPlanOverrides
    readonly onTable: (fileName: string, patch: MysqlTableOverride) => void
    readonly onColumn: (fileName: string, dbfField: string, patch: MysqlColumnOverride) => void
    readonly onReset: () => void
    /** Sync mode: show which tables are updated by key and which are reloaded. */
    readonly syncMode: boolean
}

interface MysqlPlanTablesProps extends PlanEdits {
    readonly plan: MysqlExportPlan
    /** Data was left out of the export, so values were not checked. */
    readonly dataChecked: boolean
}

export function MysqlPlanTables({ plan, dataChecked, ...edits }: MysqlPlanTablesProps) {
    const created = plan.foreignKeys.filter((fk) => fk.status === 'create').length
    // An edit undone leaves its key behind with an undefined value; that is not an edit.
    const hasEdits = Object.values(edits.overrides).some((t) =>
        Object.entries(t).some(([key, v]) => v !== undefined &&
            (key !== 'columns' || Object.values(v as object).some((c) => Object.values(c as object).some((x) => x !== undefined)))))

    return (
        <div className="flex flex-col gap-5">
            <datalist id={TYPE_LIST_ID}>
                {MYSQL_TYPE_SUGGESTIONS.map((t) => <option key={t} value={t} />)}
            </datalist>

            <QualityTable plan={plan} dataChecked={dataChecked} />

            <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold">
                        Column mapping
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                            edit names and types in place · Enter or leaving the field applies · empty = back to automatic
                        </span>
                    </h3>
                    {hasEdits && (
                        <Button variant="outline" size="sm" onClick={edits.onReset}>
                            <RotateCcw /> Reset all edits
                        </Button>
                    )}
                </div>
                <Table containerClassName="max-h-[70vh]">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-12 text-center" title="Export this field">Use</TableHead>
                            <TableHead>DBF field</TableHead>
                            <TableHead>DBF type</TableHead>
                            <TableHead>MySQL column</TableHead>
                            <TableHead>MySQL type</TableHead>
                            <TableHead>Null</TableHead>
                            <TableHead>Key</TableHead>
                            <TableHead>Note</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {plan.tables.map((t) => (
                            <Fragment key={t.fileName}>
                                <TableGroupRow table={t} {...edits} />
                                {!t.excluded && t.columns.map((c) => (
                                    <ColumnMappingRow key={c.dbfField} table={t} column={c} {...edits} />
                                ))}
                            </Fragment>
                        ))}
                    </TableBody>
                </Table>
            </div>

            <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">
                    Foreign keys
                    <span className="ml-2 font-normal text-muted-foreground">
                        {created} will be created, {plan.foreignKeys.length - created} skipped
                    </span>
                </h3>
                {plan.foreignKeys.length === 0 ? (
                    <div className="flex h-16 items-center justify-center border border-dashed text-xs text-muted-foreground">
                        No relationships to turn into foreign keys.
                    </div>
                ) : (
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Status</TableHead>
                                <TableHead>Child column</TableHead>
                                <TableHead className="w-10 text-center">→</TableHead>
                                <TableHead>Referenced column</TableHead>
                                <TableHead>Found by</TableHead>
                                <TableHead>Constraint / reason</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {plan.foreignKeys.map((fk, i) => (
                                <TableRow key={`${fk.childTable}.${fk.childColumn}-${fk.parentTable}.${fk.parentColumn}-${i}`}>
                                    <TableCell>
                                        {fk.status === 'create'
                                            ? <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-300">create</Badge>
                                            : <Badge variant="outline" className="border-amber-500/30 text-amber-700 dark:text-amber-300">skip</Badge>}
                                    </TableCell>
                                    <TableCell>{fk.childTable}.{fk.childColumn}</TableCell>
                                    <TableCell className="text-center text-muted-foreground">→</TableCell>
                                    <TableCell>{fk.parentTable}.{fk.parentColumn}</TableCell>
                                    <TableCell className="text-muted-foreground">{fk.source.replace('_', ' ')}</TableCell>
                                    <TableCell className={cn('whitespace-normal', fk.status === 'skip' && 'text-muted-foreground')}>
                                        {fk.status === 'create' ? fk.name : fk.reason}
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                )}
            </div>

            <IndexTable plan={plan} {...edits} />

            {plan.warnings.length > 0 && (
                <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">Warnings</h3>
                    <Table>
                        <TableBody>
                            {plan.warnings.map((w) => (
                                <TableRow key={w}>
                                    <TableCell className="whitespace-normal text-amber-700 dark:text-amber-300">{w}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    )
}

// ---------------------------------------------------------------- data quality

function QualityTable({ plan, dataChecked }: { plan: MysqlExportPlan; dataChecked: boolean }) {
    const failing = plan.quality.filter((q) => q.effect === 'fail').length
    const rows = plan.tables.filter((t) => !t.excluded).reduce((n, t) => n + t.rowCount, 0)

    return (
        <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
                Data quality
                <span className="ml-2 text-xs font-normal text-muted-foreground">
                    every record checked against the MySQL types before anything is sent
                </span>
            </h3>
            {!dataChecked ? (
                <p className="text-xs text-muted-foreground">Data is not included in the export, so values were not checked.</p>
            ) : plan.quality.length === 0 ? (
                <p className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="size-3.5" />
                    No problems — all {rows.toLocaleString()} rows will arrive unchanged.
                </p>
            ) : (
                <>
                    {failing > 0 && (
                        <p className="text-xs text-destructive">
                            {failing} problem{failing === 1 ? '' : 's'} would make MySQL reject rows — the import is blocked until they are fixed
                            (change the column type, pick another primary key or exclude the field below).
                        </p>
                    )}
                    <Table containerClassName="max-h-[50vh]">
                        <TableHeader>
                            <TableRow>
                                <TableHead>Effect</TableHead>
                                <TableHead>Column</TableHead>
                                <TableHead>DBF field</TableHead>
                                <TableHead>Problem</TableHead>
                                <TableHead className="text-right">Values</TableHead>
                                <TableHead>Examples (as in the DBF)</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {plan.quality.map((q) => (
                                <TableRow key={`${q.table}.${q.column}.${q.problem}`}>
                                    <TableCell>
                                        {q.effect === 'fail'
                                            ? <Badge variant="outline" className="border-destructive/40 text-destructive">import fails</Badge>
                                            : <Badge variant="outline" className="border-amber-500/30 text-amber-700 dark:text-amber-300">becomes NULL</Badge>}
                                    </TableCell>
                                    <TableCell className="font-medium">{q.table}.{q.column}</TableCell>
                                    <TableCell className="text-muted-foreground">{q.fileName} · {q.dbfField}</TableCell>
                                    <TableCell className="whitespace-normal">{q.problem}</TableCell>
                                    <TableCell className="text-right tabular-nums">{q.count.toLocaleString()}</TableCell>
                                    <TableCell className="text-muted-foreground">
                                        <span className="block max-w-[28rem] truncate" title={q.examples.join('\n')}>
                                            {q.examples.length > 0 ? q.examples.map((e) => `«${e}»`).join(', ') : '—'}
                                        </span>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </>
            )}
        </div>
    )
}

// ---------------------------------------------------------------- indexes

const INDEX_STATUS: Readonly<Record<MysqlIndexPlan['status'], { label: string; className: string }>> = {
    create: { label: 'create', className: 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300' },
    primary: { label: 'primary key', className: 'border-sky-500/30 text-sky-700 dark:text-sky-300' },
    skip: { label: 'skip', className: 'border-amber-500/30 text-amber-700 dark:text-amber-300' },
    excluded: { label: 'off', className: 'text-muted-foreground' },
}

function IndexTable({ plan, overrides, onTable }: { plan: MysqlExportPlan } & PlanEdits) {
    const rows = plan.tables.filter((t) => !t.excluded).flatMap((t) => t.indexes.map((ix) => ({ t, ix })))
    const withFile = plan.tables.filter((t) => !t.excluded && t.indexFile).length
    if (rows.length === 0 && withFile === 0) return null
    const created = rows.filter((r) => r.ix.status === 'create').length

    const toggle = (fileName: string, tag: string, on: boolean) => {
        const current = overrides[fileName]?.excludedIndexes ?? []
        const next = on ? current.filter((t) => t !== tag) : [...current, tag]
        onTable(fileName, { excludedIndexes: next.length > 0 ? next : undefined })
    }

    return (
        <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
                Indexes from .CDX
                <span className="ml-2 font-normal text-muted-foreground">
                    {created} will be created, {rows.length - created} not · from {withFile} index file{withFile === 1 ? '' : 's'}
                </span>
            </h3>
            {rows.length === 0 ? (
                <div className="flex h-16 items-center justify-center border border-dashed text-xs text-muted-foreground">
                    The uploaded .CDX files have no tags.
                </div>
            ) : (
                <Table containerClassName="max-h-[50vh]">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-12 text-center">Use</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Table</TableHead>
                            <TableHead>CDX tag</TableHead>
                            <TableHead>FoxPro expression</TableHead>
                            <TableHead>MySQL index</TableHead>
                            <TableHead>Note</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {rows.map(({ t, ix }) => {
                            const status = INDEX_STATUS[ix.status]
                            const switchable = ix.status === 'create' || ix.status === 'excluded'
                            return (
                                <TableRow key={`${t.fileName}.${ix.tag}`} className={cn(!switchable && ix.status !== 'primary' && 'text-muted-foreground')}>
                                    <TableCell className="text-center">
                                        <input
                                            type="checkbox"
                                            className="size-3.5 cursor-pointer accent-primary align-middle disabled:cursor-default"
                                            checked={ix.status === 'create' || ix.status === 'primary'}
                                            disabled={!switchable}
                                            aria-label={`Create index ${ix.tag} on ${t.table}`}
                                            onChange={(e) => toggle(t.fileName, ix.tag, e.target.checked)}
                                        />
                                    </TableCell>
                                    <TableCell><Badge variant="outline" className={status.className}>{status.label}</Badge></TableCell>
                                    <TableCell>{t.table}</TableCell>
                                    <TableCell className="font-medium">
                                        {ix.tag}
                                        {ix.candidate && <span className="ml-1.5 text-xs font-normal text-muted-foreground">candidate</span>}
                                        {ix.unique && <span className="ml-1.5 text-xs font-normal text-muted-foreground">unique</span>}
                                    </TableCell>
                                    <TableCell className="font-mono text-xs">
                                        {ix.expression}
                                        {ix.filter && <span className="text-muted-foreground"> FOR {ix.filter}</span>}
                                    </TableCell>
                                    <TableCell>
                                        {ix.status === 'create'
                                            ? <>{ix.name} <span className="text-muted-foreground">({ix.columns.join(', ')})</span></>
                                            : ix.columns.length > 0 ? <span className="text-muted-foreground">({ix.columns.join(', ')})</span> : '—'}
                                    </TableCell>
                                    <TableCell className="whitespace-normal text-muted-foreground">{ix.note ?? ''}</TableCell>
                                </TableRow>
                            )
                        })}
                    </TableBody>
                </Table>
            )}
        </div>
    )
}

// ---------------------------------------------------------------- editing

/** Text input that applies on Enter / blur, reverts on Escape, and refuses invalid input. */
function EditableCell({
    value,
    placeholder,
    validate,
    onCommit,
    disabled,
    list,
    edited,
    className,
}: {
    value: string
    placeholder?: string
    validate: (draft: string) => string | null
    onCommit: (draft: string) => void
    disabled?: boolean
    list?: string
    edited?: boolean
    className?: string
}) {
    const [draft, setDraft] = useState(value)
    // When the plan comes back with a new value, show it instead of the stale draft.
    const [synced, setSynced] = useState(value)
    if (value !== synced) {
        setSynced(value)
        setDraft(value)
    }

    const error = draft === value ? null : validate(draft)
    const commit = () => {
        if (draft !== value && error === null) onCommit(draft.trim())
    }

    return (
        <Input
            value={draft}
            placeholder={placeholder}
            disabled={disabled}
            list={list}
            aria-invalid={error !== null}
            title={error ?? (edited ? 'Changed by you — clear the field to go back to automatic' : undefined)}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
                if (e.key === 'Enter') commit()
                if (e.key === 'Escape') setDraft(value)
            }}
            className={cn('h-7 min-w-36', edited && 'border-primary/60 font-semibold', className)}
        />
    )
}

function TableGroupRow({ table: t, overrides, onTable, syncMode }: { table: MysqlTablePlan } & PlanEdits) {
    const override = overrides[t.fileName] ?? {}
    const included = t.columns.filter((c) => !c.excluded)
    const pkValue = override.primaryKey === undefined ? PK_AUTO : override.primaryKey === null ? PK_NONE : override.primaryKey
    const pkItems = [
        { value: PK_AUTO, label: 'automatic' },
        { value: PK_NONE, label: 'none' },
        ...included.map((c) => ({ value: c.dbfField, label: c.column })),
    ]

    return (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableCell className="text-center">
                <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer accent-primary align-middle"
                    checked={!override.exclude}
                    aria-label={`Export ${t.fileName}`}
                    onChange={(e) => onTable(t.fileName, { exclude: e.target.checked ? undefined : true })}
                />
            </TableCell>
            <TableCell colSpan={7}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    <span className="font-semibold">{t.fileName} →</span>
                    <EditableCell
                        value={override.name ?? ''}
                        placeholder={t.table}
                        validate={identifierError}
                        onCommit={(name) => onTable(t.fileName, { name: name || undefined })}
                        disabled={t.excluded}
                        edited={override.name !== undefined}
                        className="w-48"
                    />
                    {t.excluded ? (
                        <span className="text-muted-foreground">left out of the export</span>
                    ) : (
                        <>
                            <span className="flex items-center gap-2 text-muted-foreground">
                                primary key
                                <Select
                                    items={pkItems}
                                    value={pkValue}
                                    onValueChange={(v) => onTable(t.fileName, {
                                        primaryKey: v === PK_AUTO || v === null ? undefined : v === PK_NONE ? null : v,
                                    })}
                                >
                                    <SelectTrigger size="sm" className="min-w-36">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {pkItems.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </span>
                            <span className="font-normal text-muted-foreground">
                                {included.length} of {t.columns.length} columns · {t.rowCount.toLocaleString()} rows · {t.encoding}
                                {t.deletedRows > 0 && (t.deletedTable
                                    ? ` · ${t.deletedRows.toLocaleString()} deleted → ${t.deletedTable}`
                                    : ` · ${t.deletedRows.toLocaleString()} deleted (left out)`)}
                                {t.memoFile && ` · memo ${t.memoFile}`}
                                {t.indexFile && ` · indexes ${t.indexFile}`}
                                {syncMode && t.sync === 'reload' && ' · no primary key: sync reloads the whole table'}
                                {t.skippedFields.length > 0 && ` · no MySQL type for ${t.skippedFields.join(', ')}`}
                            </span>
                        </>
                    )}
                </div>
            </TableCell>
        </TableRow>
    )
}

function ColumnMappingRow({ table: t, column: c, overrides, onColumn }: { table: MysqlTablePlan; column: MysqlColumnPlan } & PlanEdits) {
    const override = overrides[t.fileName]?.columns?.[c.dbfField] ?? {}

    return (
        <TableRow className={cn(c.excluded && 'text-muted-foreground')}>
            <TableCell className="text-center">
                <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer accent-primary align-middle"
                    checked={!c.excluded}
                    aria-label={`Export ${t.fileName}.${c.dbfField}`}
                    onChange={(e) => onColumn(t.fileName, c.dbfField, { exclude: e.target.checked ? undefined : true })}
                />
            </TableCell>
            <TableCell className={cn(c.excluded && 'line-through')}>{c.dbfField}</TableCell>
            <TableCell>
                <span className="flex items-center gap-2">
                    <FieldTypeBadge type={c.dbfType} showLabel />
                    <span className="tabular-nums text-muted-foreground">
                        ({c.length}{c.decimals > 0 ? `,${c.decimals}` : ''})
                    </span>
                </span>
            </TableCell>
            <TableCell>
                <EditableCell
                    value={override.name ?? ''}
                    placeholder={c.column}
                    validate={identifierError}
                    onCommit={(name) => onColumn(t.fileName, c.dbfField, { name: name || undefined })}
                    disabled={c.excluded}
                    edited={override.name !== undefined}
                />
            </TableCell>
            <TableCell>
                <EditableCell
                    value={override.type ?? ''}
                    placeholder={c.mysqlType}
                    validate={mysqlTypeError}
                    onCommit={(type) => onColumn(t.fileName, c.dbfField, { type: type ? type.toUpperCase() : undefined })}
                    disabled={c.excluded}
                    list={TYPE_LIST_ID}
                    edited={c.typeOverridden}
                />
            </TableCell>
            <TableCell>{c.excluded ? '' : c.nullable ? 'YES' : 'NO'}</TableCell>
            <TableCell>{c.excluded ? '' : c.key ?? '—'}</TableCell>
            <TableCell className="text-muted-foreground">{c.excluded ? 'not exported' : c.note ?? ''}</TableCell>
        </TableRow>
    )
}
