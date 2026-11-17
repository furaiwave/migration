import { useEffect, useState } from "react";
import { translate } from "@/i18n";
import { apiRequest } from "@/client/client";
import { useApiMutation } from "@/hooks/useApiMutation";
import { useNativeSelection } from "@/lib/nativeTarget";
import { mergeImportStatus } from "@/lib/importStatus";
import { isMissingImportJob, lostImportMessage } from "@/lib/importPolling";
import { errorMessage } from "@/lib/errors";
import type {
  DbfRelationshipGraph,
  RedisOptions,
  RedisPlan,
  RedisImportStatus,
} from "@/api/api.types";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { ProgressBar } from "./MysqlImportForm";
const testConnection = (uri: string) =>
  apiRequest("POST /dbf/native/test-connection", {
    body: { engine: "redis", uri },
  });
const prepare = ({
  sessionId,
  options,
}: {
  sessionId: string;
  options: RedisOptions;
}) =>
  apiRequest("POST /dbf/session/:id/redis/plan", {
    params: { id: sessionId },
    body: options,
  });
const begin = ({
  sessionId,
  options,
  uri,
}: {
  sessionId: string;
  options: RedisOptions;
  uri: string;
}) =>
  apiRequest("POST /dbf/session/:id/redis/import", {
    params: { id: sessionId },
    body: { ...options, uri },
  });
export function RedisImportPanel({
  sessionId,
  graph,
}: {
  sessionId: string;
  graph: DbfRelationshipGraph;
}) {
  const [uri, setUri] = useState("redis://localhost:6379/0");
  const [options, setOptions] = useState<RedisOptions>({
    prefix: "data",
    writeMode: "new",
    ttlSeconds: 0,
    keepDeleted: false,
  });
  const test = useApiMutation(testConnection);
  const planRun = useApiMutation(prepare);
  const run = useApiMutation(begin);
  const { mutate: loadPlan } = planRun;
  const [plan, setPlan] = useState<{
    key: string;
    graph: DbfRelationshipGraph;
    data: RedisPlan;
  } | null>(null);
  const [job, setJob] = useState<RedisImportStatus | null>(null);
  const [pollError, setPollError] = useState<unknown>(null);
  const [cancelling, setCancelling] = useState(false);
  const busy = test.isPending || run.isPending || job?.state === "running";
  useNativeSelection(
    "redis",
    (server) => {
      setUri(
        "redis://" +
          (server.host.includes(":") ? "[" + server.host + "]" : server.host) +
          ":" +
          server.port +
          "/0",
      );
      test.reset();
    },
    !!busy,
  );
  const key = JSON.stringify([sessionId, options]);
  const valid =
    /^[A-Za-z0-9_-]{1,64}$/.test(options.prefix) &&
    Number.isInteger(options.ttlSeconds) &&
    options.ttlSeconds >= 0 &&
    options.ttlSeconds <= 2147483647;
  useEffect(() => {
    if (!valid) return;
    let active = true;
    const timer = setTimeout(() => {
      void loadPlan({ sessionId, options: JSON.parse(key)[1] as RedisOptions })
        .then((data) => {
          if (active) setPlan({ key, graph, data });
        })
        .catch(() => {});
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [key, graph, sessionId, loadPlan, valid]);
  useEffect(() => {
    if (!job || job.state !== "running") return;
    let active = true;
    const timer = setTimeout(() => {
      void apiRequest("GET /dbf/redis/import/:jobId", {
        params: { jobId: job.jobId },
      })
        .then((next) => {
          if (active) {
            setJob((current) => mergeImportStatus(current, next));
            setPollError(null);
          }
        })
        .catch((err) => {
          if (!active) return;
          if (isMissingImportJob(err)) {
            setJob((current) =>
              mergeImportStatus(current, {
                ...job,
                state: "failed",
                error: lostImportMessage(),
              }),
            );
            setPollError(null);
          } else {
            setPollError(err);
            setJob((current) => mergeImportStatus(current, { ...job }));
          }
        });
    }, 500);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [job]);
  const current =
    plan?.key === key &&
    plan.graph === graph &&
    planRun.state.status === "success"
      ? plan.data
      : null;
  const ready =
    valid &&
    !!current &&
    !current.quality.some((q) => q.effect === "fail") &&
    /^rediss?:\/\/\S+$/.test(uri);
  const start = () => {
    setJob(null);
    setPollError(null);
    setCancelling(false);
    void run
      .mutate({ sessionId, options, uri })
      .then(setJob)
      .catch(() => {});
  };
  const cancel = () => {
    if (!job) return;
    setCancelling(true);
    void apiRequest("DELETE /dbf/redis/import/:jobId", {
      params: { jobId: job.jobId },
    })
      .then((next) => setJob((current) => mergeImportStatus(current, next)))
      .catch((err) => {
        setPollError(err);
        setCancelling(false);
      });
  };
  return (
    <section className="flex flex-col gap-4 border p-4">
      <h3 className="text-sm font-semibold">Redis</h3>
      <p className="text-xs text-muted-foreground">
        {translate("Redis: one source record → one hash.")}
      </p>
      <p className="text-xs text-muted-foreground">
        {translate(
          "Numbers and dates stay exact as text; NULL is JSON null, other values are JSON strings.",
        )}
      </p>
      <fieldset className="workspace-fieldset" disabled={!!busy}>
        <legend>{translate("Database connection")}</legend>
        <label className="flex flex-col gap-1 text-xs">
          Redis URI (redis:// / rediss://)
          <Input
            type="password"
            autoComplete="off"
            value={uri}
            onChange={(e) => {
              setUri(e.target.value);
              test.reset();
              run.reset();
            }}
            aria-label="Redis URI"
          />
        </label>
      </fieldset>
      <fieldset className="workspace-fieldset" disabled={!!busy}>
        <legend>{translate("Transfer options")}</legend>
        <div className="workspace-import-options">
          <label className="flex flex-col gap-1 text-xs">
            {translate("Key prefix")}
            <Input
              value={options.prefix}
              maxLength={64}
              pattern="[A-Za-z0-9_-]{1,64}"
              onChange={(e) =>
                setOptions((o) => ({ ...o, prefix: e.target.value }))
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {translate("TTL in seconds (0 — no expiry)")}
            <Input
              type="number"
              min={0}
              max={2147483647}
              value={options.ttlSeconds}
              onChange={(e) =>
                setOptions((o) => ({
                  ...o,
                  ttlSeconds: Number(e.target.value),
                }))
              }
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {translate("Import mode")}
            <select
              className="h-8 border bg-background px-2"
              value={options.writeMode}
              onChange={(e) =>
                setOptions((o) => ({
                  ...o,
                  writeMode: e.target.value as RedisOptions["writeMode"],
                }))
              }
            >
              <option value="new">
                {translate("New keys only (skip existing)")}
              </option>
              <option value="update">
                {translate("Update fields in existing hashes")}
              </option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={options.keepDeleted}
              onChange={(e) =>
                setOptions((o) => ({ ...o, keepDeleted: e.target.checked }))
              }
            />
            {translate("Keep deleted records in <table>_deleted")}
          </label>
        </div>
      </fieldset>
      <p className="text-xs text-amber-600">
        {translate(
          "Written keys are not rolled back. Updates preserve other hash fields; TTL applies to the entire key.",
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={!!busy || !/^rediss?:\/\/\S+$/.test(uri)}
          onClick={() => {
            void test.mutate(uri).catch(() => {});
          }}
        >
          {translate("Test connection")}
        </Button>
        <Button disabled={!!busy || !ready} onClick={start}>
          {translate("Import")} → Redis
        </Button>
      </div>
      {test.state.status === "success" && (
        <p className="text-xs text-emerald-600">
          {test.state.data.serverVersion}
        </p>
      )}
      {[test.state, planRun.state, run.state].map((state, i) =>
        state.status === "error" ? (
          <p key={i} role="alert" className="text-xs text-destructive">
            {errorMessage(state.error)}
          </p>
        ) : null,
      )}
      {planRun.isPending && (
        <p className="text-xs text-muted-foreground">
          {translate("Checking…")}
        </p>
      )}
      {current && (
        <>
          <div className="overflow-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr>
                  <th>{translate("Source file")}</th>
                  <th>Redis hash</th>
                  <th>{translate("Source rows")}</th>
                </tr>
              </thead>
              <tbody>
                {current.tables.map((t) => (
                  <tr key={t.table} className="border-t">
                    <td className="py-2">{t.fileName}</td>
                    <td>
                      <code>
                        {options.prefix}:{t.table}:
                        {t.keyMode === "primary"
                          ? "pk:<SHA256>"
                          : "row:<recno>"}
                      </code>
                      <p className="text-muted-foreground">
                        {t.columns
                          .map((c) => c.name + ": " + c.kind)
                          .join(", ")}
                      </p>
                      {t.keyMode === "record" && (
                        <p className="text-amber-600">
                          {translate(
                            "No primary key: keys depend on the source record number.",
                          )}
                        </p>
                      )}
                    </td>
                    <td>
                      {t.rowCount}
                      {t.deletedTable ? " + " + t.deletedRows : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {current.warnings.map((w, i) => (
            <p key={i} className="text-xs text-amber-600">
              {w}
            </p>
          ))}
          {current.quality.map((q, i) => (
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
        <div role="status" className="flex flex-col gap-2 text-xs">
          <p>
            {job.state} · {job.progress.table} · {job.progress.rowsDone}/
            {job.progress.rowsTotal}
          </p>
          {job.state === "running" && (
            <>
              <ProgressBar
                value={job.progress.rowsDone}
                max={job.progress.rowsTotal}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={cancel}
                disabled={cancelling}
              >
                {cancelling ? translate("Stopping…") : translate("Stop")}
              </Button>
            </>
          )}
          {job.error && <p className="text-destructive">{job.error}</p>}
          {job.result?.tables.map((t) => (
            <p key={t.table}>
              {t.fileName} → {t.table}:{" "}
              {translate("Written: {0}; skipped: {1}.", [
                t.importedRows,
                t.skippedRows,
              ])}
            </p>
          ))}
        </div>
      )}
      {pollError != null && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(pollError)} {translate("— retrying…")}
        </p>
      )}
    </section>
  );
}
