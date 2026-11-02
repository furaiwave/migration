import { Fragment, useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Badge } from "./ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { FieldTypeBadge } from "./FieldTypeBadge";
import { MysqlImportForm } from "./MysqlImportForm";
import { useMysqlDump, useMysqlPlan } from "@/hooks/useMysqlExport";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { DbfRelationshipGraph, MysqlColumnPlan, MysqlExportOptions, MysqlExportPlan } from "@/api/api.types";

const ENCODINGS = [
    { value: 'auto', label: 'Auto (from code page)' },
    { value: 'cp866', label: 'cp866 — DOS Cyrillic' },
    { value: 'windows-1251', label: 'windows-1251 — Windows Cyrillic' },
    { value: 'koi8-r', label: 'koi8-r' },
    { value: 'utf-8', label: 'utf-8' },
    { value: 'windows-1252', label: 'windows-1252 — Western' },
    { value: 'latin1', label: 'latin1' },
] as const

const DEFAULT_OPTIONS: MysqlExportOptions = {
    database: '',
    encoding: 'auto',
    includeData: true,
    foreignKeys: true,
    dropExisting: true,
    emptyStringsAsNull: true,
}

type Toggle = 'includeData' | 'foreignKeys' | 'dropExisting' | 'emptyStringsAsNull'

const TOGGLES: ReadonlyArray<{ key: Toggle; label: string }> = [
    { key: 'includeData', label: 'Include data (INSERT)' },
    { key: 'foreignKeys', label: 'Create foreign keys' },
    { key: 'dropExisting', label: 'Drop existing tables' },
    { key: 'emptyStringsAsNull', label: "Blank text → NULL instead of ''" },
]

const DATABASE_PATTERN = /^[A-Za-z0-9_]{0,64}$/

interface MysqlExportPanelProps {
    readonly sessionId: string
    /** Passed so the plan is rebuilt whenever relationships change. */
    readonly graph: DbfRelationshipGraph
}

export function MysqlExportPanel({ sessionId, graph }: MysqlExportPanelProps) {
    const [options, setOptions] = useState<MysqlExportOptions>(DEFAULT_OPTIONS)
    const { mutate: loadPlan, state: planState } = useMysqlPlan()
    const dump = useMysqlDump()

    // Only these settings change the plan; the database name and data toggles affect the file alone.
    const { encoding, foreignKeys, emptyStringsAsNull } = options
    useEffect(() => {
        loadPlan({ sessionId, options: { ...DEFAULT_OPTIONS, encoding, foreignKeys, emptyStringsAsNull } })
            .catch(() => { /* surfaced via planState */ })
    }, [sessionId, graph, encoding, foreignKeys, emptyStringsAsNull, loadPlan])

    const databaseValid = DATABASE_PATTERN.test(options.database ?? '')
    const plan = planState.status === 'success' ? planState.data : null
    const fileName = `${options.database || 'dbf_export'}.sql`

    const download = () => {
        void dump.mutate({ sessionId, options }).catch(() => { /* surfaced via dump.state */ })
    }

    return (
        <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-sm font-semibold">Export to MySQL</h2>
                <p className="text-xs text-muted-foreground">
                    Builds a .sql dump: CREATE TABLE, INSERT and FOREIGN KEY statements, utf8mb4.
                </p>
            </div>

            <div className="flex flex-col gap-4 border p-4">
                <div className="flex flex-wrap items-end gap-4">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="mysqlDatabase" className="text-xs text-muted-foreground">Database name (optional)</Label>
                        <Input
                            id="mysqlDatabase"
                            placeholder="legacy_db"
                            value={options.database ?? ''}
                            aria-invalid={!databaseValid}
                            onChange={(e) => setOptions((o) => ({ ...o, database: e.target.value }))}
                            className="w-56"
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label className="text-xs text-muted-foreground">Text encoding</Label>
                        <Select
                            items={ENCODINGS}
                            value={options.encoding}
                            onValueChange={(value) => setOptions((o) => ({ ...o, encoding: value ?? 'auto' }))}
                        >
                            <SelectTrigger className="w-64">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {ENCODINGS.map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-2 pb-2">
                        {TOGGLES.map(({ key, label }) => (
                            <label key={key} className="flex cursor-pointer items-center gap-2 text-xs">
                                <input
                                    type="checkbox"
                                    className="size-3.5 accent-primary"
                                    checked={options[key]}
                                    onChange={(e) => setOptions((o) => ({ ...o, [key]: e.target.checked }))}
                                />
                                {label}
                            </label>
                        ))}
                    </div>
                    <Button className="ml-auto" disabled={!databaseValid || dump.isPending || !plan} onClick={download}>
                        {dump.isPending ? <Loader2 className="animate-spin" /> : <Download />}
                        Download {fileName}
                    </Button>
                </div>
                {!databaseValid && (
                    <p className="text-xs text-destructive">Database name: Latin letters, digits and _ only, up to 64 characters.</p>
                )}
                {dump.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(dump.state.error)}</p>}
                <p className="text-xs text-muted-foreground">
                    Import: <code className="bg-muted px-1">mysql --default-character-set=utf8mb4 -u root -p &lt; {fileName}</code>
                    {' '}or in MySQL Workbench: File → Run SQL Script.
                </p>
            </div>

            <MysqlImportForm sessionId={sessionId} options={options} databaseValid={databaseValid} />

            {planState.status === 'error' && <p className="text-sm text-destructive">{errorMessage(planState.error)}</p>}
            {planState.status === 'pending' && !plan && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" /> Building plan…</p>
            )}
            {plan && <MysqlPlanTables plan={plan} />}
        </section>
    )
}

function ColumnMappingRow({ column: c }: { column: MysqlColumnPlan }) {
    return (
        <TableRow>
            <TableCell className="pl-6">{c.dbfField}</TableCell>
            <TableCell>
                <span className="flex items-center gap-2">
                    <FieldTypeBadge type={c.dbfType} showLabel />
                    <span className="tabular-nums text-muted-foreground">
                        ({c.length}{c.decimals > 0 ? `,${c.decimals}` : ''})
                    </span>
                </span>
            </TableCell>
            <TableCell className="font-medium">{c.column}</TableCell>
            <TableCell>{c.mysqlType}</TableCell>
            <TableCell>{c.nullable ? 'YES' : 'NO'}</TableCell>
            <TableCell>{c.key ?? '—'}</TableCell>
            <TableCell className="text-muted-foreground">{c.note ?? ''}</TableCell>
        </TableRow>
    )
}

function MysqlPlanTables({ plan }: { plan: MysqlExportPlan }) {
    const created = plan.foreignKeys.filter((fk) => fk.status === 'create').length

    return (
        <div className="flex flex-col gap-5">
            <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Tables</h3>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>DBF file</TableHead>
                            <TableHead>MySQL table</TableHead>
                            <TableHead className="text-right">Rows</TableHead>
                            <TableHead className="text-right">Columns</TableHead>
                            <TableHead>Primary key</TableHead>
                            <TableHead>Encoding</TableHead>
                            <TableHead>Memo file</TableHead>
                            <TableHead>Left out</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {plan.tables.map((t) => (
                            <TableRow key={t.table}>
                                <TableCell>{t.fileName}</TableCell>
                                <TableCell className="font-medium">{t.table}</TableCell>
                                <TableCell className="text-right tabular-nums">{t.rowCount.toLocaleString()}</TableCell>
                                <TableCell className="text-right tabular-nums">{t.columns.length}</TableCell>
                                <TableCell>{t.columns.filter((c) => c.key === 'PRI').map((c) => c.column).join(', ') || '—'}</TableCell>
                                <TableCell>{t.encoding}</TableCell>
                                <TableCell>{t.memoFile ?? '—'}</TableCell>
                                <TableCell className="text-muted-foreground">{t.skippedFields.join(', ') || '—'}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            <div className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">Column mapping</h3>
                <Table containerClassName="max-h-[60vh]">
                    <TableHeader>
                        <TableRow>
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
                            <Fragment key={t.table}>
                                {/* One group per table: a caption row, then its columns. */}
                                <TableRow className="bg-muted/40 hover:bg-muted/40">
                                    <TableCell colSpan={7} className="font-semibold">
                                        {t.fileName} → {t.table}
                                        <span className="ml-2 font-normal text-muted-foreground">
                                            {t.columns.length} columns · {t.rowCount.toLocaleString()} rows
                                        </span>
                                    </TableCell>
                                </TableRow>
                                {t.columns.map((c) => <ColumnMappingRow key={c.column} column={c} />)}
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
