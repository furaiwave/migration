import {
  memo,
  useMemo,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  Check,
  ChevronRight,
  Clock3,
  Database,
  FileCode2,
  FolderOpen,
  Loader2,
  Play,
  Plus,
  RefreshCw,
  Save,
  Square,
  Table2,
  Unplug,
  X,
} from "lucide-react";
import { apiRequest } from "@/client/client";
import type { NativeSchema } from "@/api/api.types";
import type {
  EditorConnection,
  EditorEngine,
  QueryReport,
} from "@/api/sql-editor.types";
import { translate, useLanguage } from "@/i18n";
import { getNativeTarget } from "@/lib/nativeTarget";
import { errorMessage } from "@/lib/errors";
import {
  downloadText,
  editorId,
  isEditorEngine,
  loadConnections,
  saveConnections,
  tableQuery,
} from "@/lib/sqlEditor";
import { isBinarySqlDump } from "@/lib/sqlDump";
import { SqlCodeEditor, type SqlCodeHandle } from "./SqlCodeEditor";
import { SqlResultGrid } from "./SqlResultGrid";
import { Button } from "./ui/button";
import "./sql-editor.css";

type QueryTab = {
  id: string;
  number: number;
  name?: string;
  sql: string;
  report?: QueryReport;
  connection?: string;
  stopped?: boolean;
};
type HistoryItem = {
  id: string;
  sql: string;
  label: string;
  elapsed: number;
  failed: boolean;
};
const ports: Record<EditorEngine, number> = {
  postgres: 5432,
  mysql: 3306,
  mssql: 1433,
};
function initialConnection(): EditorConnection {
  const target = getNativeTarget(),
    engine =
      target.active && isEditorEngine(target.active)
        ? target.active
        : "postgres";
  const server = target.servers[engine];
  return {
    engine,
    host: server?.host ?? "127.0.0.1",
    port: server?.port ?? ports[engine],
    user: "",
    password: "",
    database: "",
    encrypt: true,
    trustServerCertificate: false,
  };
}
function makeTab(
  number: number,
  sql = "SELECT 1 AS result;",
  name?: string,
): QueryTab {
  return { id: editorId(), number, sql, name };
}
const SqlTableTree = memo(function SqlTableTree({
  objects,
  busy,
  onBrowse,
}: {
  objects: NativeSchema["objects"];
  busy: boolean;
  onBrowse(object: NativeSchema["objects"][number]): void;
}) {
  useLanguage();
  return (
    <>
      {objects.map((object) => (
        <details key={JSON.stringify([object.schema, object.name])}>
          <summary>
            <Table2 size={13} />
            <span title={object.schema + "." + object.name}>
              {object.schema && object.schema + "."}
              {object.name}
            </span>
            <button
              disabled={busy}
              aria-label={translate("Browse table {0}", [object.name])}
              onClick={(e) => {
                e.preventDefault();
                onBrowse(object);
              }}
            >
              <Play size={12} />
            </button>
          </summary>
          {object.columns.map((column) => (
            <button
              key={column.ordinal}
              className="sql-tree-column"
              title={column.dataType}
              onClick={() =>
                navigator.clipboard?.writeText(column.name).catch(() => {})
              }
            >
              <ChevronRight size={11} />
              {column.name}
              <small>{column.dataType}</small>
            </button>
          ))}
        </details>
      ))}
    </>
  );
});

export default function SqlWorkspace() {
  useLanguage();
  const [form, setForm] = useState(initialConnection);
  const [connected, setConnected] = useState<EditorConnection | null>(null);
  const [schema, setSchema] = useState<NativeSchema | null>(null);
  const [databases, setDatabases] = useState<string[]>([]);
  const [profiles, setProfiles] = useState(loadConnections);
  const [connecting, setConnecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [tabs, setTabs] = useState<QueryTab[]>(() => [makeTab(1)]);
  const [active, setActive] = useState(() => tabs[0].id);
  const [resultIndex, setResultIndex] = useState(0);
  const [limit, setLimit] = useState(1000);
  const [search, setSearch] = useState("");
  const deferred = useDeferredValue(search);
  const [side, setSide] = useState<"schema" | "history">("schema");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const editor = useRef<SqlCodeHandle>(null);
  const file = useRef<HTMLInputElement>(null);
  const sequence = useRef(1);
  const run = useRef<{
    id: string;
    tab: string;
    controller: AbortController;
  } | null>(null);
  const metadata = useRef<AbortController | null>(null);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];
  const live = tabs.find((tab) => tab.id === busy);
  useEffect(
    () => () => {
      const pending = run.current;
      run.current = null;
      pending?.controller.abort();
      metadata.current?.abort();
      metadata.current = null;
    },
    [],
  );
  const stop = () => {
    run.current?.controller.abort();
  };
  const disconnect = () => {
    stop();
    metadata.current?.abort();
    metadata.current = null;
    setConnected(null);
    setSchema(null);
    setConnecting(false);
    setDatabases([]);
  };
  const change = (patch: Partial<EditorConnection>) => {
    disconnect();
    setForm((value) => ({ ...value, ...patch }));
    setError("");
  };
  const connect = async (catalog = false) => {
    if (run.current) return;
    metadata.current?.abort();
    const controller = new AbortController();
    metadata.current = controller;
    const connection = { ...form };
    setConnecting(true);
    setError("");
    try {
      if (catalog) {
        const data = await apiRequest("POST /dbf/native/catalog", {
          body: connection,
          signal: controller.signal,
        });
        if (metadata.current === controller) setDatabases([...data.databases]);
      } else {
        const data = await apiRequest("POST /dbf/native/inspect", {
          body: connection,
          signal: controller.signal,
        });
        if (metadata.current === controller) {
          setConnected(connection);
          setSchema(data);
          setSide("schema");
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(errorMessage(e));
    } finally {
      if (metadata.current === controller) {
        metadata.current = null;
        setConnecting(false);
      }
    }
  };
  const newTab = useCallback((sql?: string, name?: string) => {
    const tab = makeTab(++sequence.current, sql, name);
    setTabs((value) => [...value, tab]);
    setActive(tab.id);
    setResultIndex(0);
    return tab;
  }, []);
  const execute = useCallback(
    async (sql: string, tabId: string) => {
      if (run.current) return;
      if (!connected) {
        setError("Connect to a database to run SQL");
        return;
      }
      if (!sql.trim()) {
        setError("Enter SQL before running a query");
        return;
      }
      if (new TextEncoder().encode(sql).length > 196608) {
        setError("SQL must contain between 1 and 196608 bytes");
        return;
      }
      const operation = {
        id: editorId(),
        tab: tabId,
        controller: new AbortController(),
      };
      run.current = operation;
      setBusy(tabId);
      setError("");
      setResultIndex(0);
      const label =
        connected.database + " @ " + connected.host + ":" + connected.port;
      setTabs((value) =>
        value.map((tab) =>
          tab.id === tabId
            ? { ...tab, report: undefined, connection: label, stopped: false }
            : tab,
        ),
      );
      try {
        const report = await apiRequest("POST /dbf/native/query", {
          body: { connection: { ...connected }, sql, maxRows: limit },
          signal: operation.controller.signal,
        });
        if (run.current !== operation || operation.controller.signal.aborted)
          return;
        setTabs((value) =>
          value.map((tab) =>
            tab.id === tabId ? { ...tab, report, connection: label } : tab,
          ),
        );
        setHistory((value) =>
          [
            {
              id: operation.id,
              sql,
              label,
              elapsed: report.elapsedMs,
              failed: !!report.error,
            },
            ...value,
          ].slice(0, 30),
        );
      } catch (e) {
        if (run.current !== operation) return;
        if (operation.controller.signal.aborted)
          setTabs((value) =>
            value.map((tab) =>
              tab.id === tabId ? { ...tab, stopped: true } : tab,
            ),
          );
        else setError(errorMessage(e));
      } finally {
        if (run.current === operation) {
          run.current = null;
          setBusy(null);
        }
      }
    },
    [connected, limit],
  );
  const onRun = (sql: string) => {
    void execute(sql, current.id);
  };
  const updateSql = useCallback(
    (id: string, sql: string) =>
      setTabs((value) =>
        value.map((tab) => (tab.id === id ? { ...tab, sql } : tab)),
      ),
    [],
  );
  const closeTab = (id: string) => {
    if (run.current?.tab === id) stop();
    const next = tabs.filter((tab) => tab.id !== id);
    if (!next.length) next.push(makeTab(++sequence.current));
    setTabs(next);
    if (active === id) {
      setActive(next[0].id);
      setResultIndex(0);
    }
  };
  const browse = useCallback(
    (object: NativeSchema["objects"][number]) => {
      if (!connected || run.current) return;
      const tab = newTab(
        tableQuery(connected.engine, object.schema, object.name, limit),
        object.name,
      );
      void execute(tab.sql, tab.id);
    },
    [connected, limit, execute, newTab],
  );
  const saveProfile = () => {
    const { password: omitted, ...connection } = form;
    void omitted;
    const label = form.database + " @ " + form.host + ":" + form.port;
    const existing = profiles.find(
      (p) => JSON.stringify(p.connection) === JSON.stringify(connection),
    );
    const profile = {
      id: existing?.id ?? editorId(),
      label,
      connection,
    };
    const next = [
      profile,
      ...profiles.filter((p) => p.id !== profile.id),
    ].slice(0, 30);
    setProfiles(next);
    saveConnections(next);
  };
  const openFile = async (input: File | undefined) => {
    if (!input) return;
    try {
      if (input.size > 2 * 1024 * 1024)
        throw new Error("Use a UTF-8 SQL file up to 2 MB.");
      const buffer = await input.arrayBuffer();
      if (isBinarySqlDump(new Uint8Array(buffer)))
        throw new Error("Use a UTF-8 SQL file up to 2 MB.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      newTab(text, input.name);
      setError("");
    } catch {
      setError("Use a UTF-8 SQL file up to 2 MB.");
    }
  };
  const objects = useMemo(
    () =>
      schema?.objects.filter((object) =>
        (object.schema + "." + object.name)
          .toLowerCase()
          .includes(deferred.toLowerCase()),
      ) ?? [],
    [schema, deferred],
  );
  const result = current.report?.sets[resultIndex];
  const tabTitle = (tab: QueryTab) =>
    tab.name ?? translate("Query {0}", [tab.number]);
  const running = busy !== null;
  return (
    <section className="sql-workspace" aria-label={translate("SQL workspace")}>
      <header className="sql-workspace-heading workspace-intro">
        <div>
          <span className="workspace-brand-mark shrink-0">
            <Database size={18} />
          </span>
          <div>
            <h2>{translate("SQL editor")}</h2>
            <p className="workspace-description">
              {connected
                ? connected.database + " @ " + connected.host
                : translate("Write SQL, explore tables, inspect results.")}
            </p>
          </div>
        </div>
        <span className="sql-connection-status workspace-status">
          {connected ? (
            <Check size={13} />
          ) : (
            <span className="workspace-status-dot" />
          )}
          {translate(connected ? "Connected" : "Not connected")}
        </span>
      </header>
      {error && (
        <p className="sql-error" role="alert">
          {translate(error)}
        </p>
      )}
      <div className="sql-workspace-layout">
        <aside className="sql-sidebar">
          <details className="sql-connection-form" open={!connected}>
            <summary>
              <Database size={14} />
              {translate("Connection")}
            </summary>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void connect();
              }}
            >
              {!!profiles.length && (
                <label>
                  {translate("Saved connections")}
                  <select
                    aria-label={translate("Saved connections")}
                    defaultValue=""
                    disabled={running || connecting}
                    onChange={(e) => {
                      const profile = profiles.find(
                        (p) => p.id === e.target.value,
                      );
                      if (profile) {
                        disconnect();
                        setForm({ ...profile.connection, password: "" });
                        setError("");
                      }
                    }}
                  >
                    <option value="">{translate("Choose a connection")}</option>
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <fieldset disabled={running || connecting}>
                <label>
                  {translate("Database")}
                  <select
                    value={form.engine}
                    onChange={(e) => {
                      const engine = e.target.value as EditorEngine;
                      change({
                        engine,
                        port: ports[engine],
                        password: "",
                        database: "",
                      });
                    }}
                  >
                    <option value="postgres">PostgreSQL</option>
                    <option value="mysql">MySQL / MariaDB</option>
                    <option value="mssql">SQL Server</option>
                  </select>
                </label>
                <div className="sql-host-fields">
                  <label>
                    {translate("Host")}
                    <input
                      autoComplete="off"
                      required
                      value={form.host}
                      onChange={(e) => change({ host: e.target.value })}
                    />
                  </label>
                  <label>
                    {translate("Port")}
                    <input
                      type="number"
                      required
                      min="1"
                      max="65535"
                      value={form.port || ""}
                      onChange={(e) => change({ port: Number(e.target.value) })}
                    />
                  </label>
                </div>
                <label>
                  {translate("User")}
                  <input
                    autoComplete="off"
                    required
                    value={form.user}
                    onChange={(e) => change({ user: e.target.value })}
                  />
                </label>
                <label>
                  {translate("Password")}
                  <input
                    type="password"
                    autoComplete="off"
                    value={form.password}
                    onChange={(e) => change({ password: e.target.value })}
                  />
                </label>
                <label>
                  {translate("Database name")}
                  <input
                    autoComplete="off"
                    list="sql-editor-databases"
                    required
                    value={form.database}
                    onChange={(e) => change({ database: e.target.value })}
                  />
                </label>
                <datalist id="sql-editor-databases">
                  {databases.map((name) => (
                    <option key={name} value={name} />
                  ))}
                </datalist>
                <label className="sql-checkbox">
                  <input
                    type="checkbox"
                    checked={form.encrypt}
                    onChange={(e) => change({ encrypt: e.target.checked })}
                  />
                  TLS
                </label>
                {form.encrypt && (
                  <label className="sql-checkbox">
                    <input
                      type="checkbox"
                      checked={form.trustServerCertificate}
                      onChange={(e) =>
                        change({ trustServerCertificate: e.target.checked })
                      }
                    />
                    {translate("Trust server certificate")}
                  </label>
                )}
                <div className="sql-connect-actions">
                  <Button type="submit" disabled={connecting}>
                    <Play />
                    {translate("Connect")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    title={translate("Save connection")}
                    aria-label={translate("Save connection")}
                    onClick={saveProfile}
                  >
                    <Save />
                  </Button>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => void connect(true)}
                >
                  {translate("Load database list")}
                </Button>
              </fieldset>
              {connecting && (
                <p role="status">
                  <Loader2 className="animate-spin" size={14} />
                  {translate("Connecting…")}
                </p>
              )}
            </form>
          </details>
          <div className="sql-schema-heading">
            <div role="group" aria-label={translate("Explorer")}>
              <button
                className={side === "schema" ? "is-active" : ""}
                onClick={() => setSide("schema")}
              >
                {translate("Tables")}
              </button>
              <button
                className={side === "history" ? "is-active" : ""}
                onClick={() => setSide("history")}
              >
                <Clock3 size={12} />
                {translate("History")}
              </button>
            </div>
            {connected && (
              <Button
                size="icon-sm"
                variant="ghost"
                disabled={running || connecting}
                aria-label={translate("Refresh structure")}
                onClick={() => void connect()}
              >
                <RefreshCw size={14} />
              </Button>
            )}
          </div>
          {side === "schema" ? (
            <>
              <input
                className="sql-table-search"
                type="search"
                aria-label={translate("Filter tables")}
                placeholder={translate("Filter tables")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <div className="sql-object-tree">
                <SqlTableTree
                  objects={objects}
                  busy={running}
                  onBrowse={browse}
                />
                {!objects.length && (
                  <p className="sql-sidebar-hint">
                    {translate(
                      connected
                        ? "No matching tables."
                        : "Connect to load database structure",
                    )}
                  </p>
                )}
              </div>
              {schema?.truncated && (
                <p className="sql-notice">
                  {translate(
                    "The structure is partial because of the report size limit.",
                  )}
                </p>
              )}
            </>
          ) : (
            <div className="sql-history">
              {history.map((item) => (
                <button key={item.id} onClick={() => newTab(item.sql)}>
                  <FileCode2 size={13} />
                  <span>
                    {item.sql.slice(0, 120)}
                    <small>
                      {item.label} · {item.elapsed} ms
                    </small>
                  </span>
                </button>
              ))}
              {!history.length && (
                <p className="sql-sidebar-hint">
                  {translate("Query history appears here")}
                </p>
              )}
            </div>
          )}
          {connected && (
            <Button
              variant="ghost"
              size="sm"
              disabled={connecting}
              onClick={disconnect}
            >
              <Unplug />
              {translate("Disconnect")}
            </Button>
          )}
          <p className="sql-sidebar-hint">
            {translate("Passwords and query history stay in memory.")}
          </p>
        </aside>
        <div className="sql-editor-main">
          <div
            className="sql-tab-bar"
            role="tablist"
            aria-label={translate("Query tabs")}
          >
            {tabs.map((tab) => (
              <div
                className={
                  "sql-query-tab " + (current.id === tab.id ? "is-active" : "")
                }
                key={tab.id}
              >
                <button
                  role="tab"
                  aria-selected={current.id === tab.id}
                  aria-controls="sql-query-panel"
                  id={"sql-tab-" + tab.id}
                  onClick={() => {
                    setActive(tab.id);
                    setResultIndex(0);
                  }}
                >
                  <FileCode2 size={13} />
                  {tabTitle(tab)}
                  {busy === tab.id && (
                    <Loader2 size={12} className="animate-spin" />
                  )}
                </button>
                <button
                  aria-label={translate("Close query {0}", [tabTitle(tab)])}
                  onClick={() => closeTab(tab.id)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={translate("New query")}
              onClick={() => newTab()}
            >
              <Plus />
            </Button>
          </div>
          <div className="sql-query-toolbar">
            <Button
              disabled={!connected || running || connecting}
              onClick={() => onRun(editor.current?.getSql() ?? current.sql)}
            >
              <Play />
              {translate("Run SQL")}
              <kbd>Ctrl ↵</kbd>
            </Button>
            {running && (
              <Button variant="destructive" onClick={stop}>
                <Square />
                {translate("Stop")}
              </Button>
            )}
            <label>
              {translate("Row limit")}
              <select
                aria-label={translate("Row limit")}
                value={limit}
                disabled={running}
                onChange={(e) => setLimit(Number(e.target.value))}
              >
                <option>100</option>
                <option>500</option>
                <option>1000</option>
                <option>5000</option>
              </select>
            </label>
            <span className="sql-toolbar-spacer" />
            <input
              type="file"
              ref={file}
              accept=".sql,.txt"
              className="hidden"
              aria-label={translate("Open SQL file")}
              onChange={(e) => {
                void openFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={translate("Open SQL file")}
              title={translate("Open SQL file")}
              onClick={() => file.current?.click()}
            >
              <FolderOpen />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={translate("Save SQL file")}
              title={translate("Save SQL file")}
              onClick={() =>
                downloadText(
                  (
                    current.name?.replace(/[<>:"/\\|?*]/g, "_") ??
                    "query-" + current.number
                  ).replace(/\.sql$/i, "") + ".sql",
                  current.sql,
                  "application/sql;charset=utf-8",
                )
              }
            >
              <Save />
            </Button>
          </div>
          <div
            role="tabpanel"
            id="sql-query-panel"
            aria-labelledby={"sql-tab-" + current.id}
          >
            <SqlCodeEditor
              ref={editor}
              tabId={current.id}
              code={current.sql}
              tabIds={tabs.map((tab) => tab.id).join("|")}
              engine={connected?.engine ?? form.engine}
              schema={schema}
              onChange={updateSql}
              onRun={onRun}
            />
          </div>
          <div className="sql-editor-footnote">
            {translate(
              "Ctrl+Enter runs the selection or the whole script. Each run uses a new connection; submit transactions as one script.",
            )}
          </div>
          <div className="sql-result-heading">
            <h3>{translate("Query results")}</h3>
            {current.report && (
              <span>
                {current.report.elapsedMs} ms · {current.connection}
              </span>
            )}
            {running && (
              <span role="status">
                <Loader2 size={13} className="animate-spin" />
                {translate("Running query")} {live ? tabTitle(live) : ""}
              </span>
            )}
          </div>
          {current.stopped && (
            <p className="sql-notice">
              {translate(
                "Request stopped. Check the database before repeating writes.",
              )}
            </p>
          )}
          {current.report?.error && (
            <p className="sql-error" role="alert">
              {translate(current.report.error.message)}
              {current.report.error.code && <> · {current.report.error.code}</>}
              {current.report.error.position && (
                <>
                  {" "}
                  · {translate("Position")}: {current.report.error.position}
                </>
              )}
            </p>
          )}
          {!!current.report?.sets.length && (
            <div className="sql-result-tabs">
              {current.report.sets.map((set, index) => (
                <button
                  key={index}
                  aria-pressed={resultIndex === index}
                  onClick={() => setResultIndex(index)}
                >
                  {translate("Result {0}", [index + 1])}{" "}
                  <span>
                    {set.columns.length
                      ? set.rows.length
                      : (set.affectedRows ?? "OK")}
                  </span>
                </button>
              ))}
            </div>
          )}
          {result ? (
            <SqlResultGrid
              key={
                current.id + ":" + resultIndex + ":" + current.report?.elapsedMs
              }
              result={result}
            />
          ) : (
            !running &&
            !current.report?.error && (
              <div className="sql-results-placeholder">
                <Table2 size={26} />
                <p>{translate("Run a query to see results")}</p>
                <small>
                  {translate("Only the visible rows and columns are rendered.")}
                </small>
              </div>
            )
          )}
          {current.report?.truncated && (
            <p className="sql-notice">
              {translate(
                "The result limit was reached. Add a WHERE clause or increase the row limit.",
              )}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
