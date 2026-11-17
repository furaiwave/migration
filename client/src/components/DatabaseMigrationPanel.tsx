import { useEffect, useState } from "react";
import { apiRequest, ApiError } from "@/client/client";
import type {
  Engine,
  MigrationConnection,
  MigrationObject,
  MigrationPlan,
  MigrationStatus,
  ObjectSelection,
} from "@/api/migration.types";
import { translate, useLanguage } from "@/i18n";
import { errorMessage } from "@/lib/errors";
import {
  savedMigrationJob as savedJob,
  rememberMigrationJob as rememberJob,
  forgetMigrationJob,
} from "@/lib/databaseMigration";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const engines: { value: Engine; label: string; port: number }[] = [
  { value: "mysql", label: "MySQL / MariaDB", port: 3306 },
  { value: "mongo", label: "MongoDB", port: 27017 },
  { value: "postgres", label: "PostgreSQL", port: 5432 },
  { value: "mssql", label: "Microsoft SQL Server", port: 1433 },
  { value: "redis", label: "Redis", port: 6379 },
];
const initialConnection = (): MigrationConnection => ({
  engine: "mysql",
  host: "127.0.0.1",
  port: 3306,
  user: "",
  password: "",
  database: "",
  encrypt: true,
  trustServerCertificate: false,
});

function ConnectionForm({
  title,
  value,
  disabled,
  onChange,
}: {
  title: string;
  value: MigrationConnection;
  disabled: boolean;
  onChange(value: MigrationConnection): void;
}) {
  const change = (field: Partial<MigrationConnection>) =>
    onChange({ ...value, ...field });
  const uri = value.engine === "mongo" || value.engine === "redis";
  return (
    <fieldset
      disabled={disabled}
      className="flex min-w-0 flex-col gap-3 border p-4"
    >
      <legend className="px-1 text-sm font-semibold">{title}</legend>
      <label className="flex flex-col gap-1 text-xs">
        {translate("Database")}
        <select
          className="h-10 border bg-background px-2 text-sm"
          value={value.engine}
          onChange={(event) => {
            const engine = event.target.value as Engine;
            onChange({
              ...initialConnection(),
              engine,
              port: engines.find((item) => item.value === engine)!.port,
              database: engine === "redis" ? "0" : "",
              uri:
                engine === "redis"
                  ? "redis://127.0.0.1:6379/0"
                  : engine === "mongo"
                    ? "mongodb://127.0.0.1:27017"
                    : undefined,
            });
          }}
        >
          {engines.map((engine) => (
            <option key={engine.value} value={engine.value}>
              {engine.label}
            </option>
          ))}
        </select>
      </label>
      {uri ? (
        <label className="flex flex-col gap-1 text-xs">
          URI
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value.uri ?? ""}
            onChange={(event) => change({ uri: event.target.value })}
          />
        </label>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_6rem] gap-2">
            <label className="flex flex-col gap-1 text-xs">
              {translate("Host")}
              <Input
                value={value.host ?? ""}
                onChange={(event) => change({ host: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {translate("Port")}
              <Input
                type="number"
                min={1}
                max={65535}
                value={value.port ?? ""}
                onChange={(event) =>
                  change({ port: Number(event.target.value) })
                }
              />
            </label>
          </div>
          <label className="flex flex-col gap-1 text-xs">
            {translate("User")}
            <Input
              autoComplete="off"
              value={value.user ?? ""}
              onChange={(event) => change({ user: event.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            {translate("Password")}
            <Input
              type="password"
              autoComplete="off"
              value={value.password ?? ""}
              onChange={(event) => change({ password: event.target.value })}
            />
          </label>
        </>
      )}
      <label className="flex flex-col gap-1 text-xs">
        {translate("Database name")}
        <Input
          value={value.database}
          onChange={(event) => change({ database: event.target.value })}
        />
      </label>
      {!uri && (
        <div className="flex flex-col gap-2 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.encrypt ?? false}
              onChange={(event) => change({ encrypt: event.target.checked })}
            />
            TLS
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={value.trustServerCertificate ?? false}
              onChange={(event) =>
                change({ trustServerCertificate: event.target.checked })
              }
            />
            {translate("Trust server certificate")}
          </label>
        </div>
      )}
    </fieldset>
  );
}

export function DatabaseMigrationPanel({
  onBusy,
}: {
  onBusy(value: boolean): void;
}) {
  useLanguage();
  const [source, setSource] = useState(initialConnection);
  const [target, setTarget] = useState(initialConnection);
  const [objects, setObjects] = useState<MigrationObject[] | null>(null);
  const [selected, setSelected] = useState<ObjectSelection[]>([]);
  const [schema, setSchema] = useState("");
  const [prefix, setPrefix] = useState("migration");
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [jobId, setJobId] = useState(savedJob);
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [now, setNow] = useState(Date.now);
  const running = !!jobId && (!status || status.state === "running");
  const locked = pending || running;
  const expired = !!plan && Date.parse(plan.expiresAt) <= now;

  useEffect(() => {
    onBusy(locked);
  }, [locked, onBusy]);
  useEffect(() => {
    if (!plan) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [plan]);
  useEffect(() => {
    if (!jobId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await apiRequest("GET /dbf/migration/jobs/:id", {
          params: { id: jobId },
        });
        if (disposed) return;
        setStatus(result);
        setPollError(null);
        if (result.state === "running")
          timer = setTimeout(() => {
            void poll();
          }, 900);
      } catch (cause) {
        if (disposed) return;
        setPollError(errorMessage(cause));
        if (cause instanceof ApiError && cause.status === 404) {
          setJobId(null);
          setStatus(null);
          forgetMigrationJob();
        } else
          timer = setTimeout(() => {
            void poll();
          }, 5000);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [jobId, pollAttempt]);

  const invalidate = () => {
    setPlan(null);
    setAccepted(false);
    setError(null);
  };
  const loadObjects = async () => {
    setPending(true);
    invalidate();
    setObjects(null);
    setSelected([]);
    try {
      setObjects(
        (await apiRequest("POST /dbf/migration/catalog", { body: source }))
          .objects,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const buildPlan = async () => {
    setPending(true);
    invalidate();
    try {
      const result = await apiRequest("POST /dbf/migration/plan", {
        body: {
          source,
          target,
          objects: selected,
          targetSchema: schema || undefined,
          redisPrefix: prefix,
        },
      });
      setNow(Date.now());
      setPlan(result);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const start = async () => {
    if (!plan) return;
    setPending(true);
    setError(null);
    try {
      const result = await apiRequest("POST /dbf/migration/plan/:id/start", {
        params: { id: plan.id },
      });
      rememberJob(result.id);
      setStatus(result);
      setJobId(result.id);
      setPlan(null);
      setPollError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const cancel = async () => {
    if (!jobId) return;
    try {
      setStatus(
        await apiRequest("DELETE /dbf/migration/jobs/:id", {
          params: { id: jobId },
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <section id="database-migration" className="flex flex-col gap-5">
      <div className="workspace-intro">
        <div>
          <p className="workspace-eyebrow">DATABASE / MIGRATION WORKSPACE</p>
          <h2>{translate("Between databases")}</h2>
          <p className="workspace-description">
            {translate(
              "Choose a source and destination, review the plan and migrate your data.",
            )}
          </p>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <ConnectionForm
          title={translate("Source")}
          value={source}
          disabled={locked}
          onChange={(value) => {
            setSource(value);
            setObjects(null);
            setSelected([]);
            invalidate();
          }}
        />
        <ConnectionForm
          title={translate("Destination")}
          value={target}
          disabled={locked}
          onChange={(value) => {
            setTarget(value);
            setSchema("");
            invalidate();
          }}
        />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Button
          disabled={locked}
          variant="outline"
          onClick={() => {
            void loadObjects();
          }}
        >
          {translate("Load structure")}
        </Button>
        {["postgres", "mssql"].includes(target.engine) && (
          <label className="flex flex-col gap-1 text-xs">
            {translate("Destination schema")}
            <Input
              disabled={locked}
              placeholder={target.engine === "postgres" ? "public" : "dbo"}
              value={schema}
              onChange={(event) => {
                setSchema(event.target.value);
                invalidate();
              }}
            />
          </label>
        )}
        {target.engine === "redis" && (
          <label className="flex flex-col gap-1 text-xs">
            {translate("Key prefix")}
            <Input
              disabled={locked}
              value={prefix}
              onChange={(event) => {
                setPrefix(event.target.value);
                invalidate();
              }}
            />
          </label>
        )}
        {pending && (
          <span role="status" className="text-xs">
            {translate("Uploading and reading…")}
          </span>
        )}
      </div>
      {objects && (
        <section className="workspace-card">
          <div className="workspace-section-heading">
            <div>
              <h2>{translate("Objects to migrate")}</h2>
              <p>{translate("Select up to 200 objects.")}</p>
            </div>
          </div>
          <div className="workspace-card-body flex flex-col gap-3">
            {!objects.length && <p>{translate("No objects found.")}</p>}
            {objects.length > 0 && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  disabled={locked || objects.length > 200}
                  checked={selected.length === objects.length}
                  onChange={(event) => {
                    setSelected(
                      event.target.checked
                        ? objects.map((object) => ({
                            sourceId: object.id,
                            targetName: object.name,
                          }))
                        : [],
                    );
                    invalidate();
                  }}
                />
                {translate("Select all")}
              </label>
            )}
            <div className="max-h-96 overflow-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className="p-2">{translate("Source")}</th>
                    <th className="p-2">{translate("Destination name")}</th>
                  </tr>
                </thead>
                <tbody>
                  {objects.map((object) => {
                    const selection = selected.find(
                      (item) => item.sourceId === object.id,
                    );
                    return (
                      <tr key={object.id} className="border-t">
                        <td className="p-2">
                          <label className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              disabled={
                                locked || (!selection && selected.length >= 200)
                              }
                              checked={!!selection}
                              onChange={(event) => {
                                setSelected(
                                  event.target.checked
                                    ? [
                                        ...selected,
                                        {
                                          sourceId: object.id,
                                          targetName: object.name,
                                        },
                                      ]
                                    : selected.filter(
                                        (item) => item.sourceId !== object.id,
                                      ),
                                );
                                invalidate();
                              }}
                            />
                            {object.schema ? object.schema + "." : ""}
                            {object.name}
                          </label>
                        </td>
                        <td className="p-2">
                          <Input
                            aria-label={
                              translate("Destination name") +
                              ": " +
                              object.name
                            }
                            disabled={locked || !selection}
                            value={selection?.targetName ?? object.name}
                            onChange={(event) => {
                              setSelected(
                                selected.map((item) =>
                                  item.sourceId === object.id
                                    ? {
                                        ...item,
                                        targetName: event.target.value,
                                      }
                                    : item,
                                ),
                              );
                              invalidate();
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Button
              className="self-start"
              disabled={locked || !selected.length}
              onClick={() => {
                void buildPlan();
              }}
            >
              {translate("Build plan")}
            </Button>
          </div>
        </section>
      )}
      {plan && (
        <section id="review" className="workspace-card">
          <div className="workspace-section-heading">
            <div>
              <h2>{translate("Migration plan")}</h2>
              <p>
                {translate("Plan valid until {0}", [
                  new Date(plan.expiresAt).toLocaleTimeString(),
                ])}
              </p>
            </div>
          </div>
          <div className="workspace-card-body flex flex-col gap-4">
            {plan.objects.map((object) => (
              <details key={object.source.id} className="border p-3">
                <summary className="cursor-pointer text-sm">
                  {object.source.schema ? object.source.schema + "." : ""}
                  {object.source.name} →{" "}
                  {object.targetSchema ? object.targetSchema + "." : ""}
                  {object.targetName}
                </summary>
                <table className="mt-3 w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className="p-1">{translate("Field name")}</th>
                      <th className="p-1">{translate("Destination type")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {object.columns.map((column) => (
                      <tr key={column.name} className="border-t">
                        <td className="p-1">{column.name}</td>
                        <td className="p-1">{column.targetType}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            ))}
            <ul className="list-disc space-y-2 pl-5 text-xs text-muted-foreground">
              {plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                disabled={locked || expired}
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              {translate("I have reviewed the plan and warnings")}
            </label>
            {expired && (
              <p className="text-xs text-destructive">
                {translate("Plan expired. Build a new plan.")}
              </p>
            )}
            <Button
              className="self-start"
              disabled={locked || !accepted || expired}
              onClick={() => {
                void start();
              }}
            >
              {translate("Start migration")}
            </Button>
          </div>
        </section>
      )}
      {(status || running || pollError) && (
        <section className="workspace-card" aria-live="polite">
          <div className="workspace-section-heading">
            <h2>{translate("Status")}</h2>
          </div>
          <div className="workspace-card-body flex flex-col gap-3">
            {status && (
              <>
                <p className="text-sm font-semibold">
                  {translate(
                    status.state === "done"
                      ? "Migration completed"
                      : status.state === "failed"
                        ? "Migration failed"
                        : status.state === "cancelled"
                          ? "Migration cancelled"
                          : "Migration running",
                  )}
                </p>
                <p className="text-xs">{status.object}</p>
                <p className="font-mono text-xs">
                  {translate(
                    "Read: {0} · written: {1} · skipped: {2}",
                    [status.read, status.written, status.skipped],
                  )}
                </p>
                {status.error && (
                  <p className="text-xs text-destructive">{status.error}</p>
                )}
                {status.state !== "running" && (
                  <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                    {status.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
            {running && (
              <Button
                className="self-start"
                variant="outline"
                disabled={status?.phase === "committing"}
                onClick={() => {
                  void cancel();
                }}
              >
                {translate("Stop")}
              </Button>
            )}
            {pollError && (
              <div
                role="alert"
                className="flex flex-col items-start gap-2 text-xs text-destructive"
              >
                <p>{pollError}</p>
                <Button
                  variant="outline"
                  onClick={() => setPollAttempt((value) => value + 1)}
                >
                  {translate("Try again")}
                </Button>
              </div>
            )}
          </div>
        </section>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
