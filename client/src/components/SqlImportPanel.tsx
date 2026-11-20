import { useFileImportRecovery } from '@/hooks/useFileImportRecovery';
import { useImportActivity } from '@/lib/importActivity';
import { mergeImportStatus } from "@/lib/importStatus";
import { NativeSchemaInspector } from "./NativeSchemaInspector";
import { isMissingImportJob, lostImportMessage } from "@/lib/importPolling";
import { useNativeSelection } from "@/lib/nativeTarget";
import { useEffect, useState } from "react";
import { translate } from "@/i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ProgressBar } from "./MysqlImportForm";
import { errorMessage } from "@/lib/errors";
import {
  cancelSqlImport,
  fetchSqlImport,
  useSqlConnectionTest,
  useSqlCatalog,
  useSqlImport,
  useSqlPlan,
} from "@/hooks/useSqlImport";
import type {
  DbfRelationshipGraph,
  MysqlImportStatus,
  SqlConnectionInput,
  SqlDialect,
  SqlImportOptions,
  SqlImportPlan,
} from "@/api/api.types";
const DEFAULTS: SqlImportOptions = {
  writeMode: "append",
  includeData: true,
  foreignKeys: true,
  indexes: true,
  keepDeleted: false,
  emptyStringsAsNull: true,
  orphansAsNull: true,
};
const statusReaders = {
  postgres: (jobId: string) => fetchSqlImport('postgres', jobId),
  mssql: (jobId: string) => fetchSqlImport('mssql', jobId),
};
export function SqlImportPanel({
  dialect,
  sessionId,
  graph,
}: {
  dialect: SqlDialect;
  sessionId: string;
  graph: DbfRelationshipGraph;
}) {
  const name = dialect === "postgres" ? "PostgreSQL" : "MSSQL";
  const [connection, setConnection] = useState<SqlConnectionInput>(() => ({
    host: "localhost",
    port: dialect === "postgres" ? 5432 : 1433,
    user: dialect === "postgres" ? "postgres" : "sa",
    password: "",
    database: "",
    encrypt: true,
    trustServerCertificate: false,
  }));
  const [options, setOptions] = useState<SqlImportOptions>(DEFAULTS);
  const test = useSqlConnectionTest();
  const run = useSqlImport();
  const catalog = useSqlCatalog();
  const { mutate: loadPlan, state: planState } = useSqlPlan();
  const [plan, setPlan] = useState<{
    key: string;
    graph: DbfRelationshipGraph;
    data: SqlImportPlan;
  } | null>(null);
  const planKey = JSON.stringify(options);
  const [job, setJob] = useState<MysqlImportStatus | null>(null);
  const [pollError, setPollError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const recovery = useFileImportRecovery({
    sessionId,
    engine: dialect,
    job,
    load: statusReaders[dialect],
    onRestore: setJob,
  });
  useImportActivity(recovery.restoring || run.isPending || job?.state === "running");
  const busy =
    recovery.restoring || catalog.isPending ||
    run.isPending ||
    test.isPending ||
    job?.state === "running";
  useNativeSelection(
    dialect,
    (server) => {
      setConnection((c) => ({
        ...c,
        host: server.host,
        port: server.port,
        password: "",
        database: "",
      }));
      test.reset();
      catalog.reset();
    },
    !!busy,
  );
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => {
      void loadPlan({
        dialect,
        sessionId,
        options: JSON.parse(planKey) as SqlImportOptions,
      })
        .then((data) => {
          if (active) setPlan({ key: planKey, graph, data });
        })
        .catch(() => {});
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [dialect, sessionId, graph, planKey, loadPlan]);
  useEffect(() => {
    if (!job || job.state !== "running") return;
    let active = true;
    const timer = setTimeout(() => {
      void fetchSqlImport(dialect, job.jobId)
        .then((next) => {
          if (active) {
            setJob(current => mergeImportStatus(current, next));
            setPollError(null);
          }
        })
        .catch((err) => {
          if (active) {
            if (isMissingImportJob(err)) {
              setPollError(null);
              setJob(current => mergeImportStatus(current, { ...job, state: "failed", error: lostImportMessage() }));
            } else {
              setPollError(err);
              setJob(current => mergeImportStatus(current, { ...job }));
            }
          }
        });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [dialect, job]);
  const canCatalog =
    !!connection.host.trim() &&
    !!connection.user.trim() &&
    Number.isInteger(connection.port) &&
    connection.port >= 1 &&
    connection.port <= 65535;
  const valid =
    connection.host.trim() &&
    connection.user.trim() &&
    connection.database.trim() &&
    Number.isInteger(connection.port) &&
    connection.port >= 1 &&
    connection.port <= 65535;
  const ready =
    plan?.key === planKey &&
    plan.graph === graph &&
    planState.status === "success" &&
    !plan.data.quality.some((q) => q.effect === "fail");
  const update = (patch: Partial<SqlConnectionInput>) => {
    setConnection((c) => ({ ...c, ...patch }));
    test.reset();
    if (Object.keys(patch).some((key) => key !== "database")) catalog.reset();
    run.reset();
  };
  const start = () => {
    setJob(null);
    setPollError(null);
    setCancelling(false);
    void run
      .mutate({ dialect, sessionId, connection, options })
      .then(setJob)
      .catch(() => {});
  };
  const cancel = () => {
    if (!job) return;
    setCancelling(true);
    void cancelSqlImport(dialect, job.jobId)
      .then(next => setJob(current => mergeImportStatus(current, next)))
      .catch((err) => {
        setPollError(err);
        setCancelling(false);
      });
  };
  return (
    <section className="flex flex-col gap-4 border p-4">
      <h3 className="text-sm font-semibold">
        {translate("Import")} · {name}
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          "Enter an existing database. Failure or cancellation rolls back the entire import. Schema: {0}.",
          [dialect === "postgres" ? "public" : "dbo"],
        )}
      </p>
      <fieldset
        disabled={busy}
        className="workspace-fieldset disabled:opacity-60"
      >
        <legend>{translate("Database connection")}</legend>
        <div className="workspace-connection-fields">
          {(["host", "port", "user", "password", "database"] as const).map(
            (key) => (
              <label key={key} className="flex flex-col gap-1 text-xs">
                {key === "host"
                  ? translate("Host")
                  : key === "port"
                    ? translate("Port")
                    : key === "user"
                      ? translate("User")
                      : key === "password"
                        ? translate("Password")
                        : translate("Database")}
                <Input
                  type={
                    key === "password"
                      ? "password"
                      : key === "port"
                        ? "number"
                        : "text"
                  }
                  value={connection[key]}
                  onChange={(e) =>
                    update({
                      [key]:
                        key === "port"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                  className={key === "port" ? "w-24" : "w-44"}
                  min={key === "port" ? 1 : undefined}
                  max={key === "port" ? 65535 : undefined}
                  autoComplete={
                    key === "password"
                      ? "current-password"
                      : key === "user"
                        ? "username"
                        : "off"
                  }
                />
              </label>
            ),
          )}
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={connection.encrypt}
              onChange={(e) => update({ encrypt: e.target.checked })}
            />
            TLS
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={connection.trustServerCertificate}
              onChange={(e) =>
                update({ trustServerCertificate: e.target.checked })
              }
            />
            {translate("Trust server certificate")}
          </label>
        </div>
      </fieldset>
      <fieldset
        disabled={busy}
        className="workspace-fieldset disabled:opacity-60"
      >
        <legend>{translate("Transfer options")}</legend>
        <div className="workspace-import-options">
          <label className="flex flex-col gap-1 text-xs">
            {translate("Import mode")}
            <select
              className="h-8 border bg-background px-2"
              value={options.writeMode}
              onChange={(e) =>
                setOptions((o) => ({
                  ...o,
                  writeMode: e.target.value as SqlImportOptions["writeMode"],
                }))
              }
            >
              <option value="append">{translate("Append rows")}</option>
              <option value="replace">{translate("Replace tables")}</option>
            </select>
          </label>
          {(
            [
              "includeData",
              "foreignKeys",
              "keepDeleted",
              "emptyStringsAsNull",
              "orphansAsNull",
            ] as const
          ).map((key) => (
            <label key={key} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={options[key]}
                onChange={(e) =>
                  setOptions((o) => ({ ...o, [key]: e.target.checked }))
                }
              />
              {key === "includeData"
                ? translate("Include data (INSERT)")
                : key === "foreignKeys"
                  ? translate("Create foreign keys")
                  : key === "keepDeleted"
                    ? translate("Keep deleted records in <table>_deleted")
                    : key === "emptyStringsAsNull"
                      ? translate("Empty text → NULL instead of ''")
                      : translate("Unmatched values → NULL")}
            </label>
          ))}
        </div>
      </fieldset>
      {options.writeMode === "replace" && (
        <p className="text-xs text-amber-600">
          {translate(
            "Existing tables with matching names are deleted and recreated.",
          )}
        </p>
      )}
      {catalog.state.status === "success" && (
        <label className="flex flex-col gap-1 text-xs">
          {translate("Available databases")}
          <select
            aria-label={translate("Available databases")}
            className="h-8 border bg-background px-2"
            disabled={!!busy}
            value={
              catalog.state.data.databases.includes(connection.database)
                ? connection.database
                : ""
            }
            onChange={(e) => update({ database: e.target.value })}
          >
            <option value="">{translate("Choose a database")}</option>
            {catalog.state.data.databases.map((db) => (
              <option key={db} value={db}>
                {db}
              </option>
            ))}
          </select>
          {catalog.state.data.elapsedMs !== undefined && (
            <span className="text-muted-foreground">
              {translate("Check time: {0} ms", [
                catalog.state.data.elapsedMs,
              ])}
            </span>
          )}
        </label>
      )}
      {catalog.state.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(catalog.state.error)}
        </p>
      )}
      {!connection.database.trim() && (
        <p className="workspace-action-hint">
          {translate("First choose or enter a database.")}
        </p>
      )}
      <div className="workspace-transfer-actions flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!canCatalog || !!busy}
          onClick={() => {
            void catalog.mutate({ dialect, connection }).catch(() => {});
          }}
        >
          {translate("Load database list")}
        </Button>
        <Button
          variant="outline"
          disabled={!valid || busy}
          onClick={() => {
            void test.mutate({ dialect, connection }).catch(() => {});
          }}
        >
          {translate("Test connection")}
        </Button>
        <Button
          className="ml-auto"
          disabled={!valid || busy || !ready}
          onClick={start}
        >
          {translate("Import")} → {name}
        </Button>
      </div>
      {recovery.restoring && (
        <p role="status" className="text-xs text-muted-foreground">{translate("Checking…")}</p>
      )}
      {recovery.error != null && (
        <p role="alert" className="text-xs text-destructive">{errorMessage(recovery.error)}</p>
      )}
      {recovery.missing && !job && (
        <p role="alert" className="text-xs text-destructive">{lostImportMessage()}</p>
      )}
      {(test.isPending || run.isPending || planState.status === "pending") && (
        <p className="text-xs text-muted-foreground">
          {translate("Checking data and connecting…")}
        </p>
      )}
      {test.state.status === "success" && (
        <p className="text-xs text-emerald-600">
          {name}: {test.state.data.serverVersion}
        </p>
      )}
      {test.state.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(test.state.error)}
        </p>
      )}
      {run.state.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(run.state.error)}
        </p>
      )}
      {planState.status === "error" && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(planState.error)}
        </p>
      )}
      <NativeSchemaInspector
        connection={{ engine: dialect, ...connection }}
        disabled={!!busy}
      />
      {plan?.key === planKey && plan.graph === graph && (
        <>
          <div className="max-h-64 overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th>{translate("Source file")}</th>
                  <th>{name}</th>
                  <th>{translate("Source rows")}</th>
                </tr>
              </thead>
              <tbody>
                {plan.data.tables.map((t) => (
                  <tr key={t.table} className="border-t">
                    <td className="py-2">{t.fileName}</td>
                    <td>
                      {t.table}
                      <div className="text-muted-foreground">
                        {t.columns
                          .map(
                            (c) =>
                              c.name +
                              ": " +
                              c.type +
                              (c.key ? " " + c.key : ""),
                          )
                          .join(", ")}
                      </div>
                    </td>
                    <td>{t.rowCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.data.warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-600">
              {w}
            </p>
          ))}
          {plan.data.quality.map((q, i) => (
            <p
              key={i}
              className={
                q.effect === "fail"
                  ? "text-xs text-destructive"
                  : "text-xs text-amber-600"
              }
            >
              {q.fileName}.{q.column}: {q.problem} ({q.count})
            </p>
          ))}
        </>
      )}
      {job && (
        <div className="flex flex-col gap-2 text-xs" role="status">
          <p>
            {job.database} · {job.state} · {job.progress.phase} ·{" "}
            {job.progress.table} · {job.progress.rowsDone}/
            {job.progress.rowsTotal}
          </p>
          {job.state === "running" && (
            <>
              <ProgressBar
                value={
                  job.progress.rowsTotal
                    ? job.progress.rowsDone
                    : job.progress.tableIndex
                }
                max={job.progress.rowsTotal || job.progress.tableCount}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={cancelling}
                onClick={cancel}
              >
                {cancelling ? translate("Stopping…") : translate("Stop")}
              </Button>
            </>
          )}
          {job.error && <p className="text-destructive">{job.error}</p>}
          {job.result?.tables.map((t) => (
            <p key={t.table}>
              {t.fileName} → {t.table}: {t.importedRows} (
              {translate("Source rows")}: {t.expectedRows})
            </p>
          ))}
        </div>
      )}
      {pollError != null && (
        <p role="alert" className="text-xs text-destructive">
          {translate("Lost connection to the import:")} {errorMessage(pollError)}{" "}
          {translate("— retrying…")}
        </p>
      )}
    </section>
  );
}
