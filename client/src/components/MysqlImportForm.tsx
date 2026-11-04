import { useEffect, useState } from "react";
import { CheckCircle2, DatabaseZap, Loader2, PlugZap, Square, XCircle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cancelImport, fetchImportStatus, useMysqlImport, useMysqlTestConnection } from "@/hooks/useMysqlExport";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { MysqlConnectionInput, MysqlExportOptions, MysqlImportResult, MysqlImportStatus, MysqlWriteMode } from "@/api/api.types";

const DEFAULT_CONNECTION: MysqlConnectionInput = {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
}

const POLL_MS = 500

const EXISTING_TABLES: Readonly<Record<MysqlWriteMode, string>> = {
    replace: 'its tables with the same names will be replaced',
    append: 'rows will be added to its existing tables',
    sync: 'its tables will get the new and changed rows; the tables are checked against the plan first',
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
                <h3 className="text-xs font-semibold">Import directly into MySQL</h3>
                <p className="text-xs text-muted-foreground">
                    Runs the same SQL as the file above on your server. Uses the settings above; the database name is required.
                </p>
            </div>

            <div className="flex flex-wrap items-end gap-4">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mysqlHost" className="text-xs text-muted-foreground">Host</Label>
                    <Input id="mysqlHost" value={connection.host} onChange={(e) => update({ host: e.target.value })} className="w-44" />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mysqlPort" className="text-xs text-muted-foreground">Port</Label>
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
                    <Label htmlFor="mysqlUser" className="text-xs text-muted-foreground">User</Label>
                    <Input id="mysqlUser" value={connection.user} onChange={(e) => update({ user: e.target.value })} className="w-36" autoComplete="username" />
                </div>
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="mysqlPassword" className="text-xs text-muted-foreground">Password</Label>
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
                    Test connection
                </Button>
                <Button className="ml-auto" disabled={!canConnect || busy || !database || !databaseValid || blockingIssues > 0} onClick={onImport}>
                    {runImport.isPending ? <Loader2 className="animate-spin" /> : <DatabaseZap />}
                    {database ? `Import into ${database}` : 'Enter a database name above'}
                </Button>
            </div>

            {blockingIssues > 0 && (
                <p className="text-xs text-destructive">
                    Import is locked: {blockingIssues} data problem{blockingIssues === 1 ? '' : 's'} would make MySQL reject rows and leave a half-loaded database. See Data quality below.
                </p>
            )}
            {test.state.status === 'success' && (
                <p className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="size-3.5" />
                    Connected to MySQL {test.state.data.serverVersion}.
                    {database && (databaseExists
                        ? ` Database "${database}" exists — ${EXISTING_TABLES[options.writeMode]}.`
                        : ` Database "${database}" will be created.`)}
                </p>
            )}
            {test.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(test.state.error)}</p>}
            {runImport.isPending && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Checking the data and connecting…
                </p>
            )}
            {runImport.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(runImport.state.error)}</p>}
            {job?.state === 'running' && <ImportProgress job={job} onCancel={onCancel} cancelling={cancelling} />}
            {pollError && <p className="text-xs text-destructive">Lost track of the import: {pollError} — retrying…</p>}
            {(job?.state === 'failed' || job?.state === 'cancelled') && (
                <p className="text-xs text-destructive">{job.error}</p>
            )}
            {job?.state === 'done' && job.result && <ImportResultTable result={job.result} />}
        </div>
    )
}

const formatDuration = (ms: number): string => {
    const s = Math.round(ms / 1000)
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
}

function ProgressBar({ value, max }: { value: number; max: number }) {
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
        p.phase === 'foreign_keys' ? `Adding foreign keys · ${p.foreignKeysDone} of ${p.foreignKeysTotal}`
        : p.phase === 'verifying' ? 'Counting rows in MySQL to confirm…'
        : p.tableIndex === 0 ? 'Starting…'
        : `Table ${p.tableIndex} of ${p.tableCount} · ${p.table}` +
          (p.tableRows > 0 ? ` · ${p.tableRowsDone.toLocaleString()} / ${p.tableRows.toLocaleString()} rows` : '')

    return (
        <div className="flex flex-col gap-2 border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 font-medium">
                    <Loader2 className="size-3.5 animate-spin" /> Importing into "{job.database}" — {stage}
                </span>
                <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelling}>
                    <Square /> {cancelling ? 'Stopping…' : 'Stop'}
                </Button>
            </div>
            <ProgressBar value={done} max={total} />
            {p.phase === 'tables' && p.tableRows > 0 && <ProgressBar value={p.tableRowsDone} max={p.tableRows} />}
            {p.phase === 'foreign_keys' && p.foreignKeysTotal > 0 && <ProgressBar value={p.foreignKeysDone} max={p.foreignKeysTotal} />}
            <p className="text-xs text-muted-foreground tabular-nums">
                {p.rowsTotal > 0 && `${p.rowsDone.toLocaleString()} / ${p.rowsTotal.toLocaleString()} rows in total · `}
                {formatDuration(p.elapsedMs)} elapsed
                {rate > 0 && ` · ${Math.round(rate).toLocaleString()} rows/s`}
                {remainingMs !== null && ` · about ${formatDuration(remainingMs)} left`}
                {' · '}stopping keeps the tables loaded so far
            </p>
        </div>
    )
}

type ResultRow = MysqlImportResult['tables'][number]

/** How a table's row count compares, read with the write mode in mind. */
function checkOf(t: ResultRow, result: MysqlImportResult): { ok: boolean; text: string } {
    if (t.importedRows === t.expectedRows) return { ok: true, text: 'match' }
    // A sync that keeps rows deleted in the old system leaves them in MySQL on purpose.
    if (result.writeMode === 'sync' && !result.syncDeletes && t.importedRows > t.expectedRows && !t.sync?.reloaded)
        return { ok: true, text: `+${(t.importedRows - t.expectedRows).toLocaleString()} kept (gone from the DBF)` }
    // Appending adds to what the table held before.
    if (result.writeMode === 'append' && t.importedRows > t.expectedRows)
        return { ok: true, text: `+${(t.importedRows - t.expectedRows).toLocaleString()} were already in the table` }
    return { ok: false, text: 'mismatch' }
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
                {sync ? 'Sync' : 'Import'} {allMatch ? 'finished' : 'finished with row count differences'} — "{result.database}" on MySQL {result.serverVersion},
                {' '}{result.tables.length} tables, {result.foreignKeysCreated} foreign keys, {result.indexesCreated} indexes, {(result.durationMs / 1000).toFixed(1)} s.
                {sync && ` ${total('inserted').toLocaleString()} new, ${total('updated').toLocaleString()} changed, ${total('unchanged').toLocaleString()} unchanged` +
                    (result.syncDeletes ? `, ${total('deleted').toLocaleString()} deleted` : '') +
                    (reloaded > 0 ? `; ${reloaded} table${reloaded === 1 ? '' : 's'} without a primary key reloaded as a whole.` : '.')}
            </p>
            <Table containerClassName="max-h-[50vh]">
                <TableHeader>
                    <TableRow>
                        <TableHead>DBF file</TableHead>
                        <TableHead>MySQL table</TableHead>
                        <TableHead className="text-right">Rows in DBF</TableHead>
                        <TableHead className="text-right">Rows in MySQL</TableHead>
                        {sync && <>
                            <TableHead className="text-right">New</TableHead>
                            <TableHead className="text-right">Changed</TableHead>
                            <TableHead className="text-right">Unchanged</TableHead>
                            <TableHead className="text-right">Deleted</TableHead>
                        </>}
                        <TableHead>Check</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((t) => {
                        const check = checks.get(t)!
                        return (
                            <TableRow key={t.table}>
                                <TableCell>{t.fileName}{t.role === 'deleted' && <span className="text-muted-foreground"> · deleted records</span>}</TableCell>
                                <TableCell className="font-medium">{result.database}.{t.table}</TableCell>
                                <TableCell className="text-right tabular-nums">{t.expectedRows.toLocaleString()}</TableCell>
                                <TableCell className="text-right tabular-nums">{t.importedRows.toLocaleString()}</TableCell>
                                {sync && (t.sync?.reloaded ? (
                                    <TableCell colSpan={4} className="text-right text-muted-foreground">
                                        reloaded: {t.sync.inserted.toLocaleString()} rows
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
