import { translate } from '@/i18n';
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
    orphansAsNull: true,
    overrides: {},
}

type Toggle = 'includeData' | 'foreignKeys' | 'indexes' | 'keepDeleted' | 'emptyStringsAsNull' | 'orphansAsNull'

const TOGGLES: ReadonlyArray<{ key: Toggle; label: string; title?: string }> = [
    { key: 'includeData', get label() { return translate("Include data (INSERT)") } },
    { key: 'foreignKeys', get label() { return translate("Create foreign keys") } },
    { key: 'indexes', get label() { return translate("Create indexes from .CDX") } },
    { key: 'keepDeleted', get label() { return translate("Keep deleted records in <table>_deleted") }, get title() { return translate("Otherwise, source records marked as deleted (*) are skipped") } },
    { key: 'emptyStringsAsNull', get label() { return translate("Empty text → NULL instead of ''") } },
    {
        key: 'orphansAsNull',
        get label() { return translate("Unmatched values → NULL") },
        get title() { return translate("References missing from the parent table (such as 0 or a deleted record) become NULL, so the relationship can be created. Otherwise the relationship is skipped.") },
    },
]

const WRITE_MODES: ReadonlyArray<{ value: MysqlWriteMode; label: string; hint: string }> = [
    { value: 'replace', get label() { return translate("Replace tables") }, get hint() { return translate("Existing tables with matching names are deleted and recreated.") } },
    { value: 'append', get label() { return translate("Append rows") }, get hint() { return translate("Missing tables are created; rows are added to existing ones. Duplicate rows cause an error.") } },
    {
        value: 'sync',
        get label() { return translate("Synchronize (new and changed rows)") },
        get hint() { return translate("Repeat while the old system is running: insert new rows, update changed rows by primary key, keep the rest. Tables without a primary key are reloaded.") },
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
    const { foreignKeys, emptyStringsAsNull, orphansAsNull, includeData, overrides, writeMode, keepDeleted, indexes } = options
    useEffect(() => {
        let current = true
        loadPlan({ sessionId, options: { ...DEFAULT_OPTIONS, foreignKeys, emptyStringsAsNull, orphansAsNull, includeData, overrides, writeMode, keepDeleted, indexes } })
            .then((p) => { if (current) setPlan(p) })
            .catch(() => { /* surfaced via planState */ })
        return () => { current = false }
    }, [sessionId, graph, foreignKeys, emptyStringsAsNull, orphansAsNull, includeData, overrides, writeMode, keepDeleted, indexes, loadPlan])

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
    const fileName = `${options.database || "data_export"}.sql`

    const download = () => {
        void dump.mutate({ sessionId, options }).catch(() => { /* surfaced via dump.state */ })
    }

    return (
        <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-4 border p-4">
                <div className="flex flex-wrap items-end gap-4">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="mysqlDatabase" className="text-xs text-muted-foreground">{translate("Database name (optional)")}</Label>
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
                        <Label className="text-xs text-muted-foreground">{translate("Existing tables")}</Label>
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
                        {translate("Download")} {fileName}
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
                            {translate("Also delete MySQL rows no longer in the source (deleted or removed by PACK in the old system)")}
                        </label>
                    )}
                </div>
                {!databaseValid && (
                    <p className="text-xs text-destructive">{translate("Database name: Latin letters, digits and _ only, up to 64 characters.")}</p>
                )}
                {dump.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(dump.state.error)}</p>}
                {blockingIssues > 0 && (
                    <p className="text-xs text-destructive">
                        {translate("The file can be downloaded, but MySQL will stop on data issues (")}{blockingIssues}{translate(") — see Data quality below.")}
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    {translate("Import:")} <code className="bg-muted px-1">mysql --default-character-set=utf8mb4 -u root -p &lt; {fileName}</code>
                    {' '}{translate("or in MySQL Workbench: File → Run SQL Script.")}
                </p>
            </div>

            <MysqlImportForm sessionId={sessionId} options={options} databaseValid={databaseValid} blockingIssues={blockingIssues} />

            {planState.status === 'error' && (
                <p className="text-sm text-destructive">
                    {errorMessage(planState.error)}
                    {Object.keys(overrides).length > 0 && (
                        <Button variant="link" size="sm" onClick={() => setOptions((o) => ({ ...o, overrides: {} }))}>{translate("Reset changes")}</Button>
                    )}
                </p>
            )}
            {planState.status === 'pending' && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {plan ? translate("Updating plan…") : translate("Building plan and checking every record…")}
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
