import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { MysqlPlanTables } from "./MysqlPlanTables";
import { MysqlImportForm } from "./MysqlImportForm";
import { useMysqlDump, useMysqlPlan } from "@/hooks/useMysqlExport";
import { errorMessage } from "@/lib/errors";
import type {
    DbfRelationshipGraph,
    MysqlColumnOverride,
    MysqlExportOptions,
    MysqlExportPlan,
    MysqlPlanOverrides,
    MysqlTableOverride,
    MysqlWriteMode,
} from "@/api/api.types";

const DEFAULT_OPTIONS: MysqlExportOptions = {
    database: '',
    includeData: true,
    foreignKeys: true,
    writeMode: 'replace',
    syncDeletes: false,
    keepDeleted: false,
    indexes: true,
    emptyStringsAsNull: true,
    overrides: {},
}

type Toggle = 'includeData' | 'foreignKeys' | 'indexes' | 'keepDeleted' | 'emptyStringsAsNull'

const TOGGLES: ReadonlyArray<{ key: Toggle; label: string; title?: string }> = [
    { key: 'includeData', label: 'Include data (INSERT)' },
    { key: 'foreignKeys', label: 'Create foreign keys' },
    { key: 'indexes', label: 'Create indexes from .CDX' },
    { key: 'keepDeleted', label: 'Keep deleted records in <table>_deleted', title: 'Records marked deleted (*) in the DBF are otherwise left out' },
    { key: 'emptyStringsAsNull', label: "Blank text → NULL instead of ''" },
]

const WRITE_MODES: ReadonlyArray<{ value: MysqlWriteMode; label: string; hint: string }> = [
    { value: 'replace', label: 'Replace tables', hint: 'Existing tables with the same names are dropped and created again.' },
    { value: 'append', label: 'Append rows', hint: 'Missing tables are created; rows are added to existing ones (fails on rows that are already there).' },
    {
        value: 'sync',
        label: 'Sync (new and changed rows)',
        hint: 'Run it again while the old system is still in use: new rows are inserted and changed ones updated by primary key, the rest is left alone. Tables without a primary key are reloaded.',
    },
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
    // The last plan stays on screen while the next one is built, so editing does not make the tables jump.
    const [plan, setPlan] = useState<MysqlExportPlan | null>(null)

    // Everything but the database name and "delete gone rows" changes the plan or its data check.
    const { foreignKeys, emptyStringsAsNull, includeData, overrides, writeMode, keepDeleted, indexes } = options
    useEffect(() => {
        let current = true
        loadPlan({ sessionId, options: { ...DEFAULT_OPTIONS, foreignKeys, emptyStringsAsNull, includeData, overrides, writeMode, keepDeleted, indexes } })
            .then((p) => { if (current) setPlan(p) })
            .catch(() => { /* surfaced via planState */ })
        return () => { current = false }
    }, [sessionId, graph, foreignKeys, emptyStringsAsNull, includeData, overrides, writeMode, keepDeleted, indexes, loadPlan])

    const setOverrides = (update: (o: MysqlPlanOverrides) => MysqlPlanOverrides) =>
        setOptions((o) => ({ ...o, overrides: update(o.overrides) }))

    const editTable = (fileName: string, patch: MysqlTableOverride) =>
        setOverrides((o) => ({ ...o, [fileName]: { ...o[fileName], ...patch } }))

    const editColumn = (fileName: string, dbfField: string, patch: MysqlColumnOverride) =>
        setOverrides((o) => {
            const table = o[fileName] ?? {}
            const next: MysqlTableOverride = {
                ...table,
                columns: { ...table.columns, [dbfField]: { ...table.columns?.[dbfField], ...patch } },
                // A field that is no longer exported cannot stay the primary key.
                ...(patch.exclude && table.primaryKey === dbfField ? { primaryKey: undefined } : {}),
            }
            return { ...o, [fileName]: next }
        })

    const databaseValid = DATABASE_PATTERN.test(options.database ?? '')
    const blockingIssues = plan?.quality.filter((q) => q.effect === 'fail').length ?? 0
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
                        <Label className="text-xs text-muted-foreground">Existing tables</Label>
                        <Select
                            items={WRITE_MODES.map(({ value, label }) => ({ value, label }))}
                            value={options.writeMode}
                            onValueChange={(v) => v && setOptions((o) => ({ ...o, writeMode: v as MysqlWriteMode }))}
                        >
                            <SelectTrigger className="min-w-60">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {WRITE_MODES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="flex flex-wrap gap-x-5 gap-y-2 pb-2">
                        {TOGGLES.map(({ key, label, title }) => (
                            <label key={key} title={title} className="flex cursor-pointer items-center gap-2 text-xs">
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
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
                    <span>{WRITE_MODES.find((m) => m.value === options.writeMode)?.hint}</span>
                    {options.writeMode === 'sync' && (
                        <label className="flex cursor-pointer items-center gap-2 text-foreground">
                            <input
                                type="checkbox"
                                className="size-3.5 accent-primary"
                                checked={options.syncDeletes}
                                disabled={!options.includeData}
                                onChange={(e) => setOptions((o) => ({ ...o, syncDeletes: e.target.checked }))}
                            />
                            Also delete MySQL rows that are gone from the DBF (deleted or packed in the old system)
                        </label>
                    )}
                </div>
                {!databaseValid && (
                    <p className="text-xs text-destructive">Database name: Latin letters, digits and _ only, up to 64 characters.</p>
                )}
                {dump.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(dump.state.error)}</p>}
                {blockingIssues > 0 && (
                    <p className="text-xs text-destructive">
                        The file can be downloaded, but MySQL will stop on {blockingIssues} data problem{blockingIssues === 1 ? '' : 's'} listed in Data quality below.
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    Import: <code className="bg-muted px-1">mysql --default-character-set=utf8mb4 -u root -p &lt; {fileName}</code>
                    {' '}or in MySQL Workbench: File → Run SQL Script.
                </p>
            </div>

            <MysqlImportForm sessionId={sessionId} options={options} databaseValid={databaseValid} blockingIssues={blockingIssues} />

            {planState.status === 'error' && (
                <p className="text-sm text-destructive">
                    {errorMessage(planState.error)}
                    {Object.keys(overrides).length > 0 && (
                        <Button variant="link" size="sm" onClick={() => setOptions((o) => ({ ...o, overrides: {} }))}>Reset edits</Button>
                    )}
                </p>
            )}
            {planState.status === 'pending' && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {plan ? 'Updating plan…' : 'Building plan and checking every record…'}
                </p>
            )}
            {plan && (
                <MysqlPlanTables
                    plan={plan}
                    dataChecked={includeData}
                    overrides={overrides}
                    onTable={editTable}
                    onColumn={editColumn}
                    onReset={() => setOptions((o) => ({ ...o, overrides: {} }))}
                    syncMode={writeMode === 'sync'}
                />
            )}
        </section>
    )
}
