import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { MongoPlanTables } from "./MongoPlanTables";
import { MongoImportForm } from "./MongoImportForm";
import { useMongoPlan, useMongoScript } from "@/hooks/useMongoExport";
import { errorMessage } from "@/lib/errors";
import type {
    DbfRelationshipGraph,
    MongoExportPlan,
    MysqlColumnOverride,
    MysqlExportOptions,
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
    { key: 'includeData', label: 'Включати дані' },
    { key: 'foreignKeys', label: 'Індексувати посилання', title: "Зв'язки, перевірені на даних, отримують індекс на дочірньому полі — $lookup працює швидко" },
    { key: 'indexes', label: 'Створювати індекси з .CDX' },
    { key: 'keepDeleted', label: 'Зберігати видалені записи в <колекція>_deleted', title: 'Інакше записи, позначені в DBF як видалені (*), пропускаються' },
    { key: 'emptyStringsAsNull', label: "Порожній текст → null замість ''" },
    {
        key: 'orphansAsNull',
        label: 'Значення без відповідника → null',
        title: "Посилання на запис, якого немає в батьківській таблиці (0 як «не вказано», видалений запис), записується як null — і зв'язок створюється. Інакше такий зв'язок пропускається.",
    },
]

const WRITE_MODES: ReadonlyArray<{ value: MysqlWriteMode; label: string; hint: string }> = [
    { value: 'replace', label: 'Замінити колекції', hint: 'Наявні колекції з такими самими назвами видаляються й створюються заново.' },
    { value: 'append', label: 'Дописати документи', hint: 'Документи додаються до наявних колекцій (з помилкою, якщо документ із таким _id уже є).' },
    {
        value: 'sync',
        label: 'Синхронізувати (нові та змінені)',
        hint: 'Запускайте повторно, поки стара система ще працює: документи замінюються за _id, нові додаються, решта лишається як є. Колекції без _id з первинного ключа завантажуються заново.',
    },
]

const DATABASE_PATTERN = /^[A-Za-z0-9_]{0,64}$/

interface MongoExportPanelProps {
    readonly sessionId: string
    /** Passed so the plan is rebuilt whenever relationships change. */
    readonly graph: DbfRelationshipGraph
}

export function MongoExportPanel({ sessionId, graph }: MongoExportPanelProps) {
    const [options, setOptions] = useState<MysqlExportOptions>(DEFAULT_OPTIONS)
    const { mutate: loadPlan, state: planState } = useMongoPlan()
    const script = useMongoScript()
    // The last plan stays on screen while the next one is built, so editing does not make the tables jump.
    const [plan, setPlan] = useState<MongoExportPlan | null>(null)

    // Everything but the database name and "delete gone documents" changes the plan or its data check.
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
                // A field that is no longer exported cannot stay the _id.
                ...(patch.exclude && table.primaryKey === dbfField ? { primaryKey: undefined } : {}),
            }
            return { ...o, [fileName]: next }
        })

    const databaseValid = DATABASE_PATTERN.test(options.database ?? '')
    const blockingIssues = plan?.quality.filter((q) => q.effect === 'fail').length ?? 0
    const fileName = `${options.database || 'dbf_export'}.js`

    return (
        <section className="flex flex-col gap-4">
            <div className="flex flex-col gap-4 border p-4">
                <div className="flex flex-wrap items-end gap-4">
                    <div className="flex flex-col gap-1.5">
                        <Label htmlFor="mongoDatabase" className="text-xs text-muted-foreground">Назва бази даних</Label>
                        <Input
                            id="mongoDatabase"
                            placeholder="legacy_db"
                            value={options.database ?? ''}
                            aria-invalid={!databaseValid}
                            onChange={(e) => setOptions((o) => ({ ...o, database: e.target.value }))}
                            className="w-56"
                        />
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Label className="text-xs text-muted-foreground">Наявні колекції</Label>
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
                    <Button
                        className="ml-auto"
                        disabled={!databaseValid || script.isPending || !plan}
                        onClick={() => { void script.mutate({ sessionId, options }).catch(() => { /* surfaced via script.state */ }) }}
                    >
                        {script.isPending ? <Loader2 className="animate-spin" /> : <Download />}
                        Завантажити {fileName}
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
                            Також видаляти з MongoDB документи, яких уже немає в DBF (видалені або прибрані PACK у старій системі)
                        </label>
                    )}
                </div>
                {!databaseValid && (
                    <p className="text-xs text-destructive">Назва бази даних: лише латинські літери, цифри та _, до 64 символів.</p>
                )}
                {script.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(script.state.error)}</p>}
                {blockingIssues > 0 && (
                    <p className="text-xs text-destructive">
                        Скрипт можна завантажити, але MongoDB зупиниться на проблемах у даних ({blockingIssues}) — див. «Якість даних» нижче.
                    </p>
                )}
                <p className="text-xs text-muted-foreground">
                    Запуск: <code className="bg-muted px-1">mongosh "mongodb://localhost:27017" {fileName}</code>
                    {' '}або в MongoDB Compass: вкладка «Mongosh», <code className="bg-muted px-1">load("{fileName}")</code>.
                    {!options.database && ' Без назви бази скрипт пише в поточну базу mongosh.'}
                </p>
            </div>

            <MongoImportForm sessionId={sessionId} options={options} databaseValid={databaseValid} blockingIssues={blockingIssues} />

            {planState.status === 'error' && (
                <p className="text-sm text-destructive">
                    {errorMessage(planState.error)}
                    {Object.keys(overrides).length > 0 && (
                        <Button variant="link" size="sm" onClick={() => setOptions((o) => ({ ...o, overrides: {} }))}>Скинути зміни</Button>
                    )}
                </p>
            )}
            {planState.status === 'pending' && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {plan ? 'Оновлюю план…' : 'Будую план і перевіряю кожен запис…'}
                </p>
            )}
            {plan && (
                <MongoPlanTables
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
