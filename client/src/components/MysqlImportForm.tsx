import { useEffect, useState } from "react";
import { CheckCircle2, DatabaseZap, Loader2, PlugZap, Square, XCircle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cancelImport, fetchImportStatus, useMysqlImport, useMysqlTestConnection } from "@/hooks/useMysqlExport";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/plural";
import { formatDuration } from "@/lib/format";
import type { MysqlConnectionInput, MysqlExportOptions, MysqlImportResult, MysqlImportStatus, MysqlWriteMode } from "@/api/api.types";

const DEFAULT_CONNECTION: MysqlConnectionInput = {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
}

const POLL_MS = 500

const EXISTING_TABLES: Readonly<Record<MysqlWriteMode, string>> = {
    replace: 'її таблиці з такими самими назвами буде замінено',
    append: 'рядки буде додано до її наявних таблиць',
    sync: 'її таблиці отримають нові та змінені рядки; спершу таблиці звіряються з планом',
}

interface MysqlImportFormProps {
    readonly sessionId: string
    readonly options: MysqlExportOptions
    /** False while the database name in the export settings is invalid. */
    readonly databaseValid: boolean
    /** Data problems that would make MySQL reject rows; the import stays locked while there are any. */
    readonly blockingIssues: number
}

export function MysqlImportForm({ sessionId, options, databaseValid, blockingIssues }: MysqlImportFormProps) {
    const [connection, setConnection] = useState<MysqlConnectionInput>(DEFAULT_CONNECTION)
    const test = useMysqlTestConnection()
    const runImport = useMysqlImport()
    // The import runs on the server; this is its latest known status, refreshed while it runs.
    const [job, setJob] = useState<MysqlImportStatus | null>(null)
    const [pollError, setPollError] = useState<string | null>(null)
    const [cancelling, setCancelling] = useState(false)
    const running = job?.state === 'running'

    useEffect(() => {
        if (!job || job.state !== 'running') return
        const timer = setTimeout(() => {
            fetchImportStatus(job.jobId)
                .then((next) => { setJob(next); setPollError(null) })
                // A missed poll is retried by the next render's timer; only show it.
                .catch((err) => { setPollError(errorMessage(err)); setJob({ ...job }) })
        }, POLL_MS)
        return () => clearTimeout(timer)
    }, [job])

    const database = options.database ?? ''
    const canConnect = connection.host.trim() !== '' && connection.user.trim() !== '' && connection.port > 0
    const busy = test.isPending || runImport.isPending || running
    const databaseExists = test.state.status === 'success' && test.state.data.databases.includes(database)

    const update = (patch: Partial<MysqlConnectionInput>) => {
        setConnection((c) => ({ ...c, ...patch }))
        // A changed connection invalidates the previous check.
        test.reset()
    }

    const onTest = () => { void test.mutate(connection).catch(() => { /* surfaced via test.state */ }) }
    const onImport = () => {
        setJob(null)
        setCancelling(false)
        void runImport.mutate({ sessionId, options, connection })
            .then(setJob)
            .catch(() => { /* surfaced via runImport.state */ })
    }
    const onCancel = () => {
        setCancelling(true)
        if (job) void cancelImport(job.jobId).then(setJob).catch((err) => setPollError(errorMessage(err)))
    }

    return (
        <div className="flex flex-col gap-4 border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-xs font-semibold">Імпорт напряму в MySQL</h3>
                <p className="text-xs text-muted-foreground">
                    Виконує на вашому сервері той самий SQL, що й файл вище. Використовує налаштування вище; назва бази даних обов'язкова.
                </p>
            </div>

            <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mysqlHost" className="text-xs text-muted-foreground">Хост</Label>
                    <Input id="mysqlHost" value={connection.host} onChange={(e) => update({ host: e.target.value })} className="w-44" />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mysqlPort" className="text-xs text-muted-foreground">Порт</Label>
                    <Input
                        id="mysqlPort"
                        type="number"
                        min={1}
                        max={65535}
                        value={connection.port}
                        onChange={(e) => update({ port: Number(e.target.value) })}
                        className="w-24 tabular-nums"
                    />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mysqlUser" className="text-xs text-muted-foreground">Користувач</Label>
                    <Input id="mysqlUser" value={connection.user} onChange={(e) => update({ user: e.target.value })} className="w-36" autoComplete="username" />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mysqlPassword" className="text-xs text-muted-foreground">Пароль</Label>
                    <Input
                        id="mysqlPassword"
                        type="password"
                        value={connection.password}
                        onChange={(e) => update({ password: e.target.value })}
                        className="w-44"
                        autoComplete="current-password"
                    />
                </div>
                <Button variant="outline" disabled={!canConnect || busy} onClick={onTest}>
                    {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
                    Перевірити з'єднання
                </Button>
                <Button className="ml-auto" disabled={!canConnect || busy || !database || !databaseValid || blockingIssues > 0} onClick={onImport}>
                    {runImport.isPending ? <Loader2 className="animate-spin" /> : <DatabaseZap />}
                    {database ? `Імпортувати в ${database}` : 'Вкажіть назву бази даних вище'}
                </Button>
            </div>

            {blockingIssues > 0 && (
                <p className="text-xs text-destructive">
                    Імпорт заблоковано: через проблеми в даних ({blockingIssues}) MySQL відхилить рядки, і база залишиться завантаженою наполовину. Див. «Якість даних» нижче.
                </p>
            )}
            {test.state.status === 'success' && (
                <p className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="size-3.5" />
                    Підключено до MySQL {test.state.data.serverVersion}.
                    {database && (databaseExists
                        ? ` База даних "${database}" існує — ${EXISTING_TABLES[options.writeMode]}.`
                        : ` Базу даних "${database}" буде створено.`)}
                </p>
            )}
            {test.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(test.state.error)}</p>}
            {runImport.isPending && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Перевіряю дані й підключаюся…
                </p>
            )}
            {runImport.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(runImport.state.error)}</p>}
            {job?.state === 'running' && <ImportProgress job={job} onCancel={onCancel} cancelling={cancelling} />}
            {pollError && <p className="text-xs text-destructive">Втрачено зв'язок з імпортом: {pollError} — пробую ще раз…</p>}
            {(job?.state === 'failed' || job?.state === 'cancelled') && (
                <p className="text-xs text-destructive">{job.error}</p>
            )}
            {job?.state === 'done' && job.result && <ImportResultTable result={job.result} />}
        </div>
    )
}

export function ProgressBar({ value, max }: { value: number; max: number }) {
    const percent = max > 0 ? Math.min(100, (value / max) * 100) : 0
    return (
        <div className="h-2 w-full overflow-hidden bg-muted" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-primary transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
    )
}

function ImportProgress({ job, onCancel, cancelling }: { job: MysqlImportStatus; onCancel: () => void; cancelling: boolean }) {
    const p = job.progress
    // Rows give the truest picture; without data only the table count moves.
    const [done, total] = p.rowsTotal > 0 ? [p.rowsDone, p.rowsTotal] : [p.tableIndex, p.tableCount]
    const rate = p.elapsedMs > 0 ? p.rowsDone / (p.elapsedMs / 1000) : 0
    const remainingMs = rate > 0 && p.rowsTotal > p.rowsDone ? ((p.rowsTotal - p.rowsDone) / rate) * 1000 : null

    const stage =
        p.phase === 'foreign_keys' ? `Додаю зовнішні ключі · ${p.foreignKeysDone} з ${p.foreignKeysTotal}`
        : p.phase === 'verifying' ? 'Рахую рядки в MySQL для перевірки…'
        : p.tableIndex === 0 ? 'Починаю…'
        : `Таблиця ${p.tableIndex} з ${p.tableCount} · ${p.table}` +
          (p.tableRows > 0 ? ` · ${p.tableRowsDone.toLocaleString()} / ${p.tableRows.toLocaleString()} ${plural(p.tableRows, 'рядка', 'рядків', 'рядків')}` : '')

    return (
        <div className="flex flex-col gap-2 border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 font-medium">
                    <Loader2 className="size-3.5 animate-spin" /> Імпорт у "{job.database}" — {stage}
                </span>
                <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelling}>
                    <Square /> {cancelling ? 'Зупиняю…' : 'Зупинити'}
                </Button>
            </div>
            <ProgressBar value={done} max={total} />
            {p.phase === 'tables' && p.tableRows > 0 && <ProgressBar value={p.tableRowsDone} max={p.tableRows} />}
            {p.phase === 'foreign_keys' && p.foreignKeysTotal > 0 && <ProgressBar value={p.foreignKeysDone} max={p.foreignKeysTotal} />}
            <p className="text-xs text-muted-foreground tabular-nums">
                {p.rowsTotal > 0 && `усього ${p.rowsDone.toLocaleString()} / ${p.rowsTotal.toLocaleString()} ${plural(p.rowsTotal, 'рядка', 'рядків', 'рядків')} · `}
                минуло {formatDuration(p.elapsedMs)}
                {rate > 0 && ` · ${Math.round(rate).toLocaleString()} рядків/с`}
                {remainingMs !== null && ` · залишилося близько ${formatDuration(remainingMs)}`}
                {' · '}після зупинки вже завантажені таблиці залишаються
            </p>
        </div>
    )
}

type ResultRow = MysqlImportResult['tables'][number]

/** How a table's row count compares, read with the write mode in mind. */
function checkOf(t: ResultRow, result: MysqlImportResult): { ok: boolean; text: string } {
    if (t.importedRows === t.expectedRows) return { ok: true, text: 'збігається' }
    // A sync that keeps rows deleted in the old system leaves them in MySQL on purpose.
    if (result.writeMode === 'sync' && !result.syncDeletes && t.importedRows > t.expectedRows && !t.sync?.reloaded)
        return { ok: true, text: `+${(t.importedRows - t.expectedRows).toLocaleString()} залишено (немає в DBF)` }
    // Appending adds to what the table held before.
    if (result.writeMode === 'append' && t.importedRows > t.expectedRows)
        return { ok: true, text: `+${(t.importedRows - t.expectedRows).toLocaleString()} уже були в таблиці` }
    return { ok: false, text: 'не збігається' }
}

function ImportResultTable({ result }: { result: MysqlImportResult }) {
    const checks = new Map(result.tables.map((t) => [t, checkOf(t, result)]))
    const allMatch = [...checks.values()].every((c) => c.ok)
    const sync = result.writeMode === 'sync'
    // With dozens of tables the ones that need attention go first.
    const rows = [...result.tables].sort((a, b) => Number(checks.get(a)!.ok) - Number(checks.get(b)!.ok))
    // Reloaded tables are rewritten as a whole, so their rows say nothing about what changed.
    const total = (key: 'inserted' | 'updated' | 'unchanged' | 'deleted') =>
        result.tables.reduce((n, t) => n + (t.role === 'table' && !t.sync?.reloaded ? t.sync?.[key] ?? 0 : 0), 0)
    const reloaded = result.tables.filter((t) => t.role === 'table' && t.sync?.reloaded).length

    return (
        <div className="flex flex-col gap-2">
            <p className={cn('flex items-center gap-2 text-xs', allMatch ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive')}>
                {allMatch ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                {sync ? 'Синхронізацію' : 'Імпорт'} {allMatch ? 'завершено' : 'завершено з розбіжностями в кількості рядків'} — "{result.database}" на MySQL {result.serverVersion},
                {' '}таблиць: {result.tables.length}, зовнішніх ключів: {result.foreignKeysCreated}, індексів: {result.indexesCreated}, {(result.durationMs / 1000).toFixed(1)} с.
                {sync && ` Нових: ${total('inserted').toLocaleString()}, змінених: ${total('updated').toLocaleString()}, без змін: ${total('unchanged').toLocaleString()}` +
                    (result.syncDeletes ? `, видалених: ${total('deleted').toLocaleString()}` : '') +
                    (reloaded > 0 ? `; таблиць без первинного ключа, завантажених заново повністю: ${reloaded}.` : '.')}
            </p>
            <Table containerClassName="max-h-[50vh]">
                <TableHeader>
                    <TableRow>
                        <TableHead>Файл DBF</TableHead>
                        <TableHead>Таблиця MySQL</TableHead>
                        <TableHead className="text-right">Рядків у DBF</TableHead>
                        <TableHead className="text-right">Рядків у MySQL</TableHead>
                        {sync && <>
                            <TableHead className="text-right">Нові</TableHead>
                            <TableHead className="text-right">Змінені</TableHead>
                            <TableHead className="text-right">Без змін</TableHead>
                            <TableHead className="text-right">Видалені</TableHead>
                        </>}
                        <TableHead>Перевірка</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((t) => {
                        const check = checks.get(t)!
                        return (
                            <TableRow key={t.table}>
                                <TableCell>{t.fileName}{t.role === 'deleted' && <span className="text-muted-foreground"> · видалені записи</span>}</TableCell>
                                <TableCell className="font-medium">{result.database}.{t.table}</TableCell>
                                <TableCell className="text-right tabular-nums">{t.expectedRows.toLocaleString()}</TableCell>
                                <TableCell className="text-right tabular-nums">{t.importedRows.toLocaleString()}</TableCell>
                                {sync && (t.sync?.reloaded ? (
                                    <TableCell colSpan={4} className="text-right text-muted-foreground">
                                        завантажено заново: {t.sync.inserted.toLocaleString()} {plural(t.sync.inserted, 'рядок', 'рядки', 'рядків')}
                                    </TableCell>
                                ) : <>
                                    <TableCell className="text-right tabular-nums">{(t.sync?.inserted ?? 0).toLocaleString()}</TableCell>
                                    <TableCell className="text-right tabular-nums">{(t.sync?.updated ?? 0).toLocaleString()}</TableCell>
                                    <TableCell className="text-right tabular-nums text-muted-foreground">{(t.sync?.unchanged ?? 0).toLocaleString()}</TableCell>
                                    <TableCell className="text-right tabular-nums">{result.syncDeletes ? (t.sync?.deleted ?? 0).toLocaleString() : '—'}</TableCell>
                                </>)}
                                <TableCell className={check.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'}>
                                    {check.text}
                                </TableCell>
                            </TableRow>
                        )
                    })}
                </TableBody>
            </Table>
        </div>
    )
}
