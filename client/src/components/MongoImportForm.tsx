import { useEffect, useState } from "react";
import { CheckCircle2, DatabaseZap, Loader2, PlugZap, Square, XCircle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { ProgressBar } from "./MysqlImportForm";
import { cancelMongoImport, fetchMongoImportStatus, useMongoImport, useMongoTestConnection } from "@/hooks/useMongoExport";
import { errorMessage } from "@/lib/errors";
import { formatDuration } from "@/lib/format";
import { plural } from "@/lib/plural";
import { cn } from "@/lib/utils";
import type { MongoImportResult, MongoImportStatus, MysqlExportOptions, MysqlWriteMode } from "@/api/api.types";

const DEFAULT_URI = 'mongodb://localhost:27017'
const URI_PATTERN = /^mongodb(\+srv)?:\/\/\S+$/
const POLL_MS = 500

const EXISTING_COLLECTIONS: Readonly<Record<MysqlWriteMode, string>> = {
    replace: 'її колекції з такими самими назвами буде замінено',
    append: 'документи буде додано до її наявних колекцій',
    sync: 'її колекції отримають нові та змінені документи',
}

interface MongoImportFormProps {
    readonly sessionId: string
    readonly options: MysqlExportOptions
    readonly databaseValid: boolean
    /** Data problems that would make MongoDB reject documents; the import stays locked while there are any. */
    readonly blockingIssues: number
}

export function MongoImportForm({ sessionId, options, databaseValid, blockingIssues }: MongoImportFormProps) {
    const [uri, setUri] = useState(DEFAULT_URI)
    const test = useMongoTestConnection()
    const runImport = useMongoImport()
    const [job, setJob] = useState<MongoImportStatus | null>(null)
    const [pollError, setPollError] = useState<string | null>(null)
    const [cancelling, setCancelling] = useState(false)
    const running = job?.state === 'running'

    useEffect(() => {
        if (!job || job.state !== 'running') return
        const timer = setTimeout(() => {
            fetchMongoImportStatus(job.jobId)
                .then((next) => { setJob(next); setPollError(null) })
                // A missed poll is retried by the next render's timer; only show it.
                .catch((err) => { setPollError(errorMessage(err)); setJob({ ...job }) })
        }, POLL_MS)
        return () => clearTimeout(timer)
    }, [job])

    const database = options.database ?? ''
    const uriValid = URI_PATTERN.test(uri.trim())
    const busy = test.isPending || runImport.isPending || running
    const databaseExists = test.state.status === 'success' && test.state.data.databases.includes(database)
    // A user limited to one database cannot list them; then nothing is known either way.
    const databasesListed = test.state.status === 'success' && test.state.data.databases.length > 0

    const onTest = () => { void test.mutate({ uri: uri.trim() }).catch(() => { /* surfaced via test.state */ }) }
    const onImport = () => {
        setJob(null)
        setCancelling(false)
        void runImport.mutate({ sessionId, options, connection: { uri: uri.trim() } })
            .then(setJob)
            .catch(() => { /* surfaced via runImport.state */ })
    }
    const onCancel = () => {
        setCancelling(true)
        if (job) void cancelMongoImport(job.jobId).then(setJob).catch((err) => setPollError(errorMessage(err)))
    }

    return (
        <div className="flex flex-col gap-4 border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-xs font-semibold">Імпорт напряму в MongoDB</h3>
                <p className="text-xs text-muted-foreground">
                    Виконує на вашому сервері те саме, що й скрипт вище. Використовує налаштування вище; назва бази даних обов'язкова.
                </p>
            </div>

            <div className="flex flex-wrap items-end gap-4">
                <div className="flex min-w-80 flex-1 flex-col gap-1.5">
                    <Label htmlFor="mongoUri" className="text-xs text-muted-foreground">Рядок підключення</Label>
                    <Input
                        id="mongoUri"
                        value={uri}
                        aria-invalid={!uriValid}
                        spellCheck={false}
                        autoComplete="off"
                        placeholder={DEFAULT_URI}
                        onChange={(e) => { setUri(e.target.value); test.reset() }}
                        className="font-mono"
                    />
                </div>
                <Button variant="outline" disabled={!uriValid || busy} onClick={onTest}>
                    {test.isPending ? <Loader2 className="animate-spin" /> : <PlugZap />}
                    Перевірити з'єднання
                </Button>
                <Button disabled={!uriValid || busy || !database || !databaseValid || blockingIssues > 0} onClick={onImport}>
                    {runImport.isPending ? <Loader2 className="animate-spin" /> : <DatabaseZap />}
                    {database ? `Імпортувати в ${database}` : 'Вкажіть назву бази даних вище'}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                Логін і пароль, якщо потрібні, — у самому рядку: <code className="bg-muted px-1">mongodb://user:password@host:27017/?authSource=admin</code>.
                Для Atlas — <code className="bg-muted px-1">mongodb+srv://…</code>.
            </p>

            {!uriValid && <p className="text-xs text-destructive">Рядок підключення має починатися з mongodb:// або mongodb+srv://</p>}
            {blockingIssues > 0 && (
                <p className="text-xs text-destructive">
                    Імпорт заблоковано: через проблеми в даних ({blockingIssues}) MongoDB відхилить документи. Див. «Якість даних» нижче.
                </p>
            )}
            {test.state.status === 'success' && (
                <p className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="size-3.5" />
                    Підключено до MongoDB {test.state.data.serverVersion}.
                    {database && databasesListed && (databaseExists
                        ? ` База даних "${database}" існує — ${EXISTING_COLLECTIONS[options.writeMode]}.`
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
            {(job?.state === 'failed' || job?.state === 'cancelled') && <p className="text-xs text-destructive">{job.error}</p>}
            {job?.state === 'done' && job.result && <ImportResultTable result={job.result} />}
        </div>
    )
}

function ImportProgress({ job, onCancel, cancelling }: { job: MongoImportStatus; onCancel: () => void; cancelling: boolean }) {
    const p = job.progress
    const [done, total] = p.rowsTotal > 0 ? [p.rowsDone, p.rowsTotal] : [p.collectionIndex, p.collectionCount]
    const rate = p.elapsedMs > 0 ? p.rowsDone / (p.elapsedMs / 1000) : 0
    const remainingMs = rate > 0 && p.rowsTotal > p.rowsDone ? ((p.rowsTotal - p.rowsDone) / rate) * 1000 : null

    const stage =
        p.phase === 'indexes' ? `Створюю індекси · ${p.indexesDone} з ${p.indexesTotal}`
        : p.phase === 'verifying' ? 'Рахую документи в MongoDB для перевірки…'
        : p.collectionIndex === 0 ? 'Починаю…'
        : `Колекція ${p.collectionIndex} з ${p.collectionCount} · ${p.collection}` +
          (p.collectionRows > 0 ? ` · ${p.collectionRowsDone.toLocaleString()} / ${p.collectionRows.toLocaleString()} ${plural(p.collectionRows, 'документа', 'документів', 'документів')}` : '')

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
            {p.phase === 'collections' && p.collectionRows > 0 && <ProgressBar value={p.collectionRowsDone} max={p.collectionRows} />}
            {p.phase === 'indexes' && p.indexesTotal > 0 && <ProgressBar value={p.indexesDone} max={p.indexesTotal} />}
            <p className="text-xs text-muted-foreground tabular-nums">
                {p.rowsTotal > 0 && `усього ${p.rowsDone.toLocaleString()} / ${p.rowsTotal.toLocaleString()} ${plural(p.rowsTotal, 'документа', 'документів', 'документів')} · `}
                минуло {formatDuration(p.elapsedMs)}
                {rate > 0 && ` · ${Math.round(rate).toLocaleString()} док./с`}
                {remainingMs !== null && ` · залишилося близько ${formatDuration(remainingMs)}`}
                {' · '}після зупинки вже завантажені колекції залишаються
            </p>
        </div>
    )
}

type ResultRow = MongoImportResult['collections'][number]

/** How a collection's document count compares, read with the write mode in mind. */
function checkOf(c: ResultRow, result: MongoImportResult): { ok: boolean; text: string } {
    if (c.importedRows === c.expectedRows) return { ok: true, text: 'збігається' }
    // A sync that keeps documents deleted in the old system leaves them in MongoDB on purpose.
    if (result.writeMode === 'sync' && !result.syncDeletes && c.importedRows > c.expectedRows && !c.sync?.reloaded)
        return { ok: true, text: `+${(c.importedRows - c.expectedRows).toLocaleString()} залишено (немає в DBF)` }
    if (result.writeMode === 'append' && c.importedRows > c.expectedRows)
        return { ok: true, text: `+${(c.importedRows - c.expectedRows).toLocaleString()} уже були в колекції` }
    return { ok: false, text: 'не збігається' }
}

function ImportResultTable({ result }: { result: MongoImportResult }) {
    const checks = new Map(result.collections.map((c) => [c, checkOf(c, result)]))
    const allMatch = [...checks.values()].every((c) => c.ok)
    const sync = result.writeMode === 'sync'
    const rows = [...result.collections].sort((a, b) => Number(checks.get(a)!.ok) - Number(checks.get(b)!.ok))
    const total = (key: 'inserted' | 'updated' | 'unchanged' | 'deleted') =>
        result.collections.reduce((n, c) => n + (c.role === 'table' && !c.sync?.reloaded ? c.sync?.[key] ?? 0 : 0), 0)
    const reloaded = result.collections.filter((c) => c.role === 'table' && c.sync?.reloaded).length

    return (
        <div className="flex flex-col gap-2">
            <p className={cn('flex items-center gap-2 text-xs', allMatch ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive')}>
                {allMatch ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                {sync ? 'Синхронізацію' : 'Імпорт'} {allMatch ? 'завершено' : 'завершено з розбіжностями в кількості документів'} — "{result.database}" на MongoDB {result.serverVersion},
                {' '}колекцій: {result.collections.length}, індексів: {result.indexesCreated}, {(result.durationMs / 1000).toFixed(1)} с.
                {sync && ` Нових: ${total('inserted').toLocaleString()}, змінених: ${total('updated').toLocaleString()}, без змін: ${total('unchanged').toLocaleString()}` +
                    (result.syncDeletes ? `, видалених: ${total('deleted').toLocaleString()}` : '') +
                    (reloaded > 0 ? `; колекцій без _id з ключа, завантажених заново повністю: ${reloaded}.` : '.')}
            </p>
            <Table containerClassName="max-h-[50vh]">
                <TableHeader>
                    <TableRow>
                        <TableHead>Файл DBF</TableHead>
                        <TableHead>Колекція MongoDB</TableHead>
                        <TableHead className="text-right">Записів у DBF</TableHead>
                        <TableHead className="text-right">Документів у MongoDB</TableHead>
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
                    {rows.map((c) => {
                        const check = checks.get(c)!
                        return (
                            <TableRow key={c.collection}>
                                <TableCell>{c.fileName}{c.role === 'deleted' && <span className="text-muted-foreground"> · видалені записи</span>}</TableCell>
                                <TableCell className="font-medium">{result.database}.{c.collection}</TableCell>
                                <TableCell className="text-right tabular-nums">{c.expectedRows.toLocaleString()}</TableCell>
                                <TableCell className="text-right tabular-nums">{c.importedRows.toLocaleString()}</TableCell>
                                {sync && (c.sync?.reloaded ? (
                                    <TableCell colSpan={4} className="text-right text-muted-foreground">
                                        завантажено заново: {c.sync.inserted.toLocaleString()} {plural(c.sync.inserted, 'документ', 'документи', 'документів')}
                                    </TableCell>
                                ) : <>
                                    <TableCell className="text-right tabular-nums">{(c.sync?.inserted ?? 0).toLocaleString()}</TableCell>
                                    <TableCell className="text-right tabular-nums">{(c.sync?.updated ?? 0).toLocaleString()}</TableCell>
                                    <TableCell className="text-right tabular-nums text-muted-foreground">{(c.sync?.unchanged ?? 0).toLocaleString()}</TableCell>
                                    <TableCell className="text-right tabular-nums">{result.syncDeletes ? (c.sync?.deleted ?? 0).toLocaleString() : '—'}</TableCell>
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
