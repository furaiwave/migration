import { useState } from "react";
import { CheckCircle2, DatabaseZap, Loader2, PlugZap, XCircle } from "lucide-react";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { useMysqlImport, useMysqlTestConnection } from "@/hooks/useMysqlExport";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import type { MysqlConnectionInput, MysqlExportOptions, MysqlImportResult } from "@/api/api.types";

const DEFAULT_CONNECTION: MysqlConnectionInput = {
    host: 'localhost',
    port: 3306,
    user: 'root',
    password: '',
}

interface MysqlImportFormProps {
    readonly sessionId: string
    readonly options: MysqlExportOptions
    /** False while the database name in the export settings is invalid. */
    readonly databaseValid: boolean
}

export function MysqlImportForm({ sessionId, options, databaseValid }: MysqlImportFormProps) {
    const [connection, setConnection] = useState<MysqlConnectionInput>(DEFAULT_CONNECTION)
    const test = useMysqlTestConnection()
    const runImport = useMysqlImport()

    const database = options.database ?? ''
    const canConnect = connection.host.trim() !== '' && connection.user.trim() !== '' && connection.port > 0
    const busy = test.isPending || runImport.isPending
    const databaseExists = test.state.status === 'success' && test.state.data.databases.includes(database)

    const update = (patch: Partial<MysqlConnectionInput>) => {
        setConnection((c) => ({ ...c, ...patch }))
        // A changed connection invalidates the previous check.
        test.reset()
    }

    const onTest = () => { void test.mutate(connection).catch(() => { /* surfaced via test.state */ }) }
    const onImport = () => {
        void runImport.mutate({ sessionId, options, connection }).catch(() => { /* surfaced via runImport.state */ })
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
                <Button className="ml-auto" disabled={!canConnect || busy || !database || !databaseValid} onClick={onImport}>
                    {runImport.isPending ? <Loader2 className="animate-spin" /> : <DatabaseZap />}
                    {database ? `Import into ${database}` : 'Enter a database name above'}
                </Button>
            </div>

            {test.state.status === 'success' && (
                <p className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                    <CheckCircle2 className="size-3.5" />
                    Connected to MySQL {test.state.data.serverVersion}.
                    {database && (databaseExists
                        ? ` Database "${database}" exists — ${options.dropExisting ? 'its tables with the same names will be replaced' : 'existing tables are kept'}.`
                        : ` Database "${database}" will be created.`)}
                </p>
            )}
            {test.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(test.state.error)}</p>}
            {runImport.isPending && <p className="text-xs text-muted-foreground">Importing… large tables can take a while.</p>}
            {runImport.state.status === 'error' && <p className="text-xs text-destructive">{errorMessage(runImport.state.error)}</p>}
            {runImport.state.status === 'success' && <ImportResultTable result={runImport.state.data} />}
        </div>
    )
}

function ImportResultTable({ result }: { result: MysqlImportResult }) {
    const allMatch = result.tables.every((t) => t.importedRows === t.expectedRows)

    return (
        <div className="flex flex-col gap-2">
            <p className={cn('flex items-center gap-2 text-xs', allMatch ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive')}>
                {allMatch ? <CheckCircle2 className="size-3.5" /> : <XCircle className="size-3.5" />}
                {allMatch ? 'Import finished' : 'Import finished with row count differences'} — "{result.database}" on MySQL {result.serverVersion},
                {' '}{result.tables.length} tables, {result.foreignKeysCreated} foreign keys, {(result.durationMs / 1000).toFixed(1)} s.
            </p>
            <Table>
                <TableHeader>
                    <TableRow>
                        <TableHead>DBF file</TableHead>
                        <TableHead>MySQL table</TableHead>
                        <TableHead className="text-right">Rows in DBF</TableHead>
                        <TableHead className="text-right">Rows in MySQL</TableHead>
                        <TableHead>Check</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {result.tables.map((t) => {
                        const ok = t.importedRows === t.expectedRows
                        return (
                            <TableRow key={t.table}>
                                <TableCell>{t.fileName}</TableCell>
                                <TableCell className="font-medium">{result.database}.{t.table}</TableCell>
                                <TableCell className="text-right tabular-nums">{t.expectedRows.toLocaleString()}</TableCell>
                                <TableCell className="text-right tabular-nums">{t.importedRows.toLocaleString()}</TableCell>
                                <TableCell className={ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-destructive'}>
                                    {ok ? 'match' : 'mismatch'}
                                </TableCell>
                            </TableRow>
                        )
                    })}
                </TableBody>
            </Table>
        </div>
    )
}
