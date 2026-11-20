import { useFileImportRecovery } from '@/hooks/useFileImportRecovery';
import { useImportActivity } from '@/lib/importActivity';
import { mergeImportStatus } from "@/lib/importStatus";
import { NativeSchemaInspector } from './NativeSchemaInspector';
import { isMissingImportJob, lostImportMessage } from '@/lib/importPolling';
import { useNativeSelection } from '@/lib/nativeTarget';
import { translate, getLanguage } from '@/i18n';
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
    get replace() { return translate("its collections with matching names will be replaced") },
    get append() { return translate("documents will be added to its existing collections") },
    get sync() { return translate("its collections will receive new and changed documents") },
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
    const [pollError, setPollError] = useState<Error | null>(null)
    const [cancelling, setCancelling] = useState(false)
    const running = job?.state === 'running'
    const recovery = useFileImportRecovery({
      sessionId,
      engine: 'mongo',
      job,
      load: fetchMongoImportStatus,
      onRestore: setJob,
    });
    useImportActivity(recovery.restoring || runImport.isPending || !!running);

    useEffect(() => {
        if (!job || job.state !== 'running') return;
        let active = true;
        const timer = setTimeout(() => {
            void fetchMongoImportStatus(job.jobId)
                .then(next => { if (active) { setJob(current => mergeImportStatus(current, next)); setPollError(null); } })
                .catch(err => {
                    if (!active) return;
                    if (isMissingImportJob(err)) {
                        setPollError(null);
                        setJob(current => mergeImportStatus(current, { ...job, state: 'failed', error: lostImportMessage() }));
                    } else {
                        setPollError(err instanceof Error ? err : new Error(String(err)));
                        setJob(current => mergeImportStatus(current, { ...job }));
                    }
                });
        }, POLL_MS);
        return () => { active = false; clearTimeout(timer); };
    }, [job]);

    const database = options.database ?? ''
    const uriValid = URI_PATTERN.test(uri.trim())
    const busy = recovery.restoring || test.isPending || runImport.isPending || running
    useNativeSelection('mongo', (server) => { setUri('mongodb://' + (server.host.includes(':') ? '[' + server.host + ']' : server.host) + ':' + server.port); test.reset(); }, busy)
    const databaseExists = test.state.status === 'success' && test.state.data.databases.includes(database)
    // A user limited to one database cannot list them; then nothing is known either way.
    const databasesListed = test.state.status === 'success' && test.state.data.databases.length > 0

    const onTest = () => { void test.mutate({ uri: uri.trim() }).catch(() => { /* surfaced via test.state */ }) }
    const onImport = () => {
        setJob(null)
        setPollError(null)
        setCancelling(false)
        void runImport.mutate({ sessionId, options, connection: { uri: uri.trim() } })
            .then(setJob)
            .catch(() => { /* surfaced via runImport.state */ })
    }
    const onCancel = () => {
        setCancelling(true)
        if (job) void cancelMongoImport(job.jobId).then(next => setJob(current => mergeImportStatus(current, next))).catch((err) => { setPollError(err instanceof Error ? err : new Error(String(err))); setCancelling(false) })
    }

    return (
        <div className="flex flex-col gap-4 border p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-xs font-semibold">{translate("Direct import to MongoDB")}</h3>
                <p className="text-xs text-muted-foreground">
                    {translate("Runs the script above on your server using the selected settings. A database name is required.")}
                </p>
            </div>

            <div className="flex flex-wrap items-end gap-4">
                <div className="flex min-w-80 flex-1 flex-col gap-1.5">
                    <Label htmlFor="mongoUri" className="text-xs text-muted-foreground">{translate("Connection string")}</Label>
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
                    {translate("Test connection")}
                </Button>
                <Button disabled={!uriValid || busy || !database || !databaseValid || blockingIssues > 0} onClick={onImport}>
                    {runImport.isPending ? <Loader2 className="animate-spin" /> : <DatabaseZap />}
                    {database ? translate("Import to {0}", [database]) : translate("Enter a database name above")}
                </Button>
            </div>
            <p className="text-xs text-muted-foreground">
                {translate("Include credentials in the connection string if needed:")} <code className="bg-muted px-1">mongodb://user:password@host:27017/?authSource=admin</code>{translate(". For Atlas use")} <code className="bg-muted px-1">mongodb+srv://…</code>.
            </p>

            {!uriValid && <p className="text-xs text-destructive">{translate("The connection string must start with mongodb:// or mongodb+srv://")}</p>}
            <NativeSchemaInspector connection={{engine:'mongo',uri:uri.trim(),database:options.database}} disabled={!!busy || !databaseValid} />
            {blockingIssues > 0 && (
                <p className="text-xs text-destructive">
                    {translate("Import blocked: data issues (")}{blockingIssues}{translate(") would make MongoDB reject documents. See Data quality below.")}
                </p>
            )}
            {test.state.status === 'success' && (
                <p className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="size-3.5" />
                    {translate("Connected to MongoDB")} {test.state.data.serverVersion}.
                    {database && databasesListed && (databaseExists
                        ? translate(" Database \"{0}\" exists — {1}.", [database, EXISTING_COLLECTIONS[options.writeMode]])
                        : translate(" Database \"{0}\" will be created.", [database]))}
                </p>
            )}
            {test.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(test.state.error)}</p>}
            {recovery.restoring && (
              <p role="status" className="text-xs text-muted-foreground">{translate("Checking…")}</p>
            )}
      {recovery.error != null && (
        <p role="alert" className="text-xs text-destructive">{errorMessage(recovery.error)}</p>
      )}
      {recovery.missing && !job && (
        <p role="alert" className="text-xs text-destructive">{lostImportMessage()}</p>
      )}
      {runImport.isPending && (
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> {translate("Checking data and connecting…")}
                </p>
            )}
            {runImport.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(runImport.state.error)}</p>}
            {job?.state === 'running' && <ImportProgress job={job} onCancel={onCancel} cancelling={cancelling} />}
            {pollError && <p className="text-xs text-destructive">{translate("Lost connection to the import:")} {errorMessage(pollError)} {translate("— retrying…")}</p>}
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
        p.phase === 'indexes' ? translate("Creating indexes · {0} of {1}", [p.indexesDone, p.indexesTotal])
        : p.phase === 'verifying' ? translate("Counting MongoDB documents to verify…")
        : p.collectionIndex === 0 ? translate("Starting…")
        : translate("Collection {0} of {1} · {2}", [p.collectionIndex, p.collectionCount, p.collection]) +
          (p.collectionRows > 0 ? ` · ${p.collectionRowsDone.toLocaleString(getLanguage())} / ${p.collectionRows.toLocaleString(getLanguage())} ${plural(p.collectionRows, translate("document (count)"), translate("documents (many)"), translate("documents (many)"))}` : '')

    return (
        <div className="flex flex-col gap-2 border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2 font-medium">
                    <Loader2 className="size-3.5 animate-spin" /> {translate("Import to \"")}{job.database}" — {stage}
                </span>
                <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelling}>
                    <Square /> {cancelling ? translate("Stopping…") : translate("Stop")}
                </Button>
            </div>
            <ProgressBar value={done} max={total} />
            {p.phase === 'collections' && p.collectionRows > 0 && <ProgressBar value={p.collectionRowsDone} max={p.collectionRows} />}
            {p.phase === 'indexes' && p.indexesTotal > 0 && <ProgressBar value={p.indexesDone} max={p.indexesTotal} />}
            <p className="text-xs text-muted-foreground tabular-nums">
                {p.rowsTotal > 0 && translate("total {0} / {1} {2} · ", [p.rowsDone.toLocaleString(getLanguage()), p.rowsTotal.toLocaleString(getLanguage()), plural(p.rowsTotal, translate("document (count)"), translate("documents (many)"), translate("documents (many)"))])}
                {translate("elapsed")} {formatDuration(p.elapsedMs)}
                {rate > 0 && translate(" · {0} docs/s", [Math.round(rate).toLocaleString(getLanguage())])}
                {remainingMs !== null && translate(" · about {0} remaining", [formatDuration(remainingMs)])}
                {' · '}{translate("collections already imported remain after stopping")}
            </p>
        </div>
    )
}

type ResultRow = MongoImportResult['collections'][number]

/** How a collection's document count compares, read with the write mode in mind. */
function checkOf(c: ResultRow, result: MongoImportResult): { ok: boolean; text: string } {
    if (c.importedRows === c.expectedRows) return { ok: true, get text() { return translate("matches") } }
    // A sync that keeps documents deleted in the old system leaves them in MongoDB on purpose.
    if (result.writeMode === 'sync' && !result.syncDeletes && c.importedRows > c.expectedRows && !c.sync?.reloaded)
        return { ok: true, text: translate("+{0} retained (not in the source)", [(c.importedRows - c.expectedRows).toLocaleString(getLanguage())]) }
    if (result.writeMode === 'append' && c.importedRows > c.expectedRows)
        return { ok: true, text: translate("+{0} already in collection", [(c.importedRows - c.expectedRows).toLocaleString(getLanguage())]) }
    return { ok: false, get text() { return translate("mismatch") } }
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
                {sync ? translate("Synchronization") : translate("Import")} {allMatch ? translate("completed") : translate("completed with document count mismatches")} — "{result.database}{translate("\" on MongoDB")} {result.serverVersion},
                {' '}{translate("collections:")} {result.collections.length}{translate(", indexes:")} {result.indexesCreated}, {(result.durationMs / 1000).toFixed(1)} {translate("s.")}
                {sync && translate(" New: {0}, updated: {1}, unchanged: {2}", [total('inserted').toLocaleString(getLanguage()), total('updated').toLocaleString(getLanguage()), total('unchanged').toLocaleString(getLanguage())]) +
                    (result.syncDeletes ? translate(", deleted: {0}", [total('deleted').toLocaleString(getLanguage())]) : '') +
                    (reloaded > 0 ? translate("; collections without a primary-key _id fully reloaded: {0}.", [reloaded]) : '.')}
            </p>
            <Table containerClassName="max-h-[50vh]">
                <TableHeader>
                    <TableRow>
                        <TableHead>{translate("Source file")}</TableHead>
                        <TableHead>{translate("MongoDB collection")}</TableHead>
                        <TableHead className="text-right">{translate("Source records")}</TableHead>
                        <TableHead className="text-right">{translate("MongoDB documents")}</TableHead>
                        {sync && <>
                            <TableHead className="text-right">{translate("New")}</TableHead>
                            <TableHead className="text-right">{translate("Updated")}</TableHead>
                            <TableHead className="text-right">{translate("Unchanged")}</TableHead>
                            <TableHead className="text-right">{translate("Deleted")}</TableHead>
                        </>}
                        <TableHead>{translate("Verification")}</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map((c) => {
                        const check = checks.get(c)!
                        return (
                            <TableRow key={c.collection}>
                                <TableCell>{c.fileName}{c.role === 'deleted' && <span className="text-muted-foreground">  {translate("· deleted records")}</span>}</TableCell>
                                <TableCell className="font-medium">{result.database}.{c.collection}</TableCell>
                                <TableCell className="text-right tabular-nums">{c.expectedRows.toLocaleString(getLanguage())}</TableCell>
                                <TableCell className="text-right tabular-nums">{c.importedRows.toLocaleString(getLanguage())}</TableCell>
                                {sync && (c.sync?.reloaded ? (
                                    <TableCell colSpan={4} className="text-right text-muted-foreground">
                                        {translate("reloaded:")} {c.sync.inserted.toLocaleString(getLanguage())} {plural(c.sync.inserted, translate("document (standalone)"), translate("documents (few)"), translate("documents (many)"))}
                                    </TableCell>
                                ) : <>
                                    <TableCell className="text-right tabular-nums">{(c.sync?.inserted ?? 0).toLocaleString(getLanguage())}</TableCell>
                                    <TableCell className="text-right tabular-nums">{(c.sync?.updated ?? 0).toLocaleString(getLanguage())}</TableCell>
                                    <TableCell className="text-right tabular-nums text-muted-foreground">{(c.sync?.unchanged ?? 0).toLocaleString(getLanguage())}</TableCell>
                                    <TableCell className="text-right tabular-nums">{result.syncDeletes ? (c.sync?.deleted ?? 0).toLocaleString(getLanguage()) : '—'}</TableCell>
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
