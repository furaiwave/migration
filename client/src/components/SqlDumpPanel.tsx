import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ArrowDown, Upload } from "lucide-react";
import { translate } from "@/i18n";
import { cn } from "@/lib/utils";
import type { DumpDialect, DumpSchema, DumpTable } from "@/lib/sqlDump";
import { Button } from "./ui/button";

export function SqlDumpPanel() {
  const [schema, setSchema] = useState<DumpSchema | null>(null);
  const [fileName, setFileName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const worker = useRef<Worker | null>(null);
  const uploaded = useRef<File | null>(null);
  const picker = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dialect, setDialect] = useState<DumpDialect | "auto">("auto");

  const stopWorker = () => {
    const task = worker.current;
    worker.current = null;
    task?.terminate();
  };
  useEffect(() => () => {
    const task = worker.current;
    worker.current = null;
    task?.terminate();
  }, []);

  const reset = () => {
    stopWorker();
    uploaded.current = null;
    setSchema(null);
    setDragging(false);
    setError("");
    setFileName("");
    setBusy(false);
    setSelected("");
    setQuery("");
  };
  const load = (file?: File, format = dialect) => {
    if (!file) return;
    reset();
    uploaded.current = file;
    setFileName(file.name);
    setBusy(true);
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error("The SQL dump exceeds the 50 MB limit. Export the schema without data.");
      const task = new Worker(new URL("../lib/sqlDump.worker.ts", import.meta.url), { type: "module" });
      worker.current = task;
      const fail = () => {
        if (worker.current !== task) return;
        setError("Could not read SQL dump.");
        setBusy(false);
        stopWorker();
      };
      task.onmessage = (event: MessageEvent<{ schema?: DumpSchema; error?: string }>) => {
        if (worker.current !== task) return;
        if (event.data.schema) setSchema(event.data.schema);
        else setError(event.data.error ?? "Could not read SQL dump.");
        setBusy(false);
        stopWorker();
      };
      task.onerror = event => { event.preventDefault(); fail(); };
      task.onmessageerror = fail;
      task.postMessage({ file, dialect: format });
    } catch (e) {
      stopWorker();
      setError(e instanceof Error ? e.message : "Could not read SQL dump.");
      setBusy(false);
    }
  };
  const select = (table: string) => {
    setSelected(table);
    setQuery("");
  };
  const view = useMemo(() => {
    if (!schema) return { tables: [], links: [], foreignColumns: new Map<string, Set<string>>(), names: new Set<string>() };
    const needle = query.trim().toLowerCase();
    const matches = new Set(schema.tables.filter(table => table.name.toLowerCase().includes(needle)).map(table => table.name));
    const links = schema.links.filter(link =>
      (!selected || (!link.fromMissing && link.from === selected) || (!link.toMissing && link.to === selected)) &&
      (!needle || (!link.fromMissing && matches.has(link.from)) || (!link.toMissing && matches.has(link.to))),
    );
    const visible = new Set<string>(selected ? [selected] : matches);
    for (const link of links) {
      if (!link.fromMissing) visible.add(link.from);
      if (!link.toMissing) visible.add(link.to);
    }
    const foreignColumns = new Map<string, Set<string>>();
    for (const link of schema.links) {
      if (link.fromMissing) continue;
      const columns = foreignColumns.get(link.from) ?? new Set<string>();
      link.columns.forEach(column => columns.add(column));
      foreignColumns.set(link.from, columns);
    }
    return {
      tables: schema.tables.filter(table => visible.has(table.name)),
      links,
      foreignColumns,
      names: new Set(schema.tables.map(table => table.name)),
    };
  }, [schema, selected, query]);

  return <section className="flex min-w-0 flex-col gap-4">
    <header className="workspace-intro">
      <div>
        <h2>{translate("SQL dump")}</h2>
        <p className="workspace-description">{translate("Open a plain-text PostgreSQL, MySQL or SQLite dump (.sql, UTF-8, up to 50 MB). The file stays in your browser; SQL is never executed.")}</p>
      </div>
    </header>
    <label className="flex flex-wrap items-center gap-3 text-sm">
      {translate("Format")}
      <select className="h-9 border bg-background px-3" value={dialect} disabled={busy} onChange={e => {
        const format = e.target.value as DumpDialect | "auto";
        setDialect(format);
        if (uploaded.current) load(uploaded.current, format);
      }}>
        <option value="auto">{translate("Automatic")}</option>
        <option value="postgres">PostgreSQL</option>
        <option value="mysql">MySQL / MariaDB</option>
        <option value="sqlite">SQLite</option>
      </select>
    </label>
    <div
      className={cn(
        "workspace-dump-upload flex items-center gap-4 border border-dashed px-5 transition-colors focus-within:border-primary",
        schema ? "flex-wrap py-4" : "min-h-60 flex-col justify-center py-8",
        dragging ? "border-primary bg-primary/5" : "border-border/60 bg-card hover:border-border",
      )}
      aria-busy={busy}
      onDragEnter={e => { e.preventDefault(); if (!busy) setDragging(true); }}
      onDragOver={e => { e.preventDefault(); if (!busy) setDragging(true); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={e => { e.preventDefault(); setDragging(false); if (!busy) load(e.dataTransfer.files[0]); }}
    >
      <Upload aria-hidden="true" className={cn("shrink-0 text-muted-foreground", schema ? "size-5" : "size-8")} />
      <input ref={picker} className="hidden" type="file" accept=".sql,.txt,text/plain,application/sql" aria-label={translate("Upload SQL dump")} disabled={busy} onChange={e => { load(e.target.files?.[0]); e.target.value = ""; }} />
      <Button disabled={busy} onClick={() => picker.current?.click()}>{translate("Upload SQL dump")}</Button>
      <span className="text-xs text-muted-foreground">.sql / UTF-8 / 50 MB</span>
    </div>
    {busy && <div className="flex items-center gap-3">
      <p role="status">{translate("Reading SQL dump\u2026")}</p>
      <Button size="sm" variant="outline" onClick={reset}>{translate("Cancel")}</Button>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{translate(error)}</p>}
    {schema && <>
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <strong className="break-all">{fileName}</strong>
        <span>{translate("Tables")}: {schema.tables.length}</span>
        <span>{translate("Foreign keys")}: {schema.links.length}</span>
        <Button variant="outline" size="sm" onClick={reset}>{translate("Clear")}</Button>
      </div>
      <p className="text-xs text-muted-foreground">{translate("Only declared foreign keys are shown. Dumps without constraints may have no links. This is a schema preview, not a full SQL validator.")}</p>
      <label className="flex flex-wrap items-center gap-3 text-sm">
        {translate("Filter tables")}
        <input type="search" className="h-9 border bg-background px-3" value={query} onChange={e => { setQuery(e.target.value); setSelected(""); }} />
      </label>
      <RelationshipDiagram tables={view.tables} links={view.links} selected={selected} select={select} />
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
        <div className="grid min-w-0 content-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {view.tables.map(table => <article key={table.name} className={"min-w-0 overflow-hidden border bg-card " + (selected === table.name ? "border-primary" : "")}>
            <button className="w-full break-all bg-muted p-3 text-left font-mono text-sm font-semibold" aria-pressed={selected === table.name} onClick={() => select(selected === table.name ? "" : table.name)}>{table.name}</button>
            <ul className="max-h-72 overflow-auto p-3 text-xs">
              {table.columns.map((column, i) => <li key={i} className="flex justify-between gap-3 py-1">
                <span className="break-all font-mono">
                  {column.primary && <strong title={translate("Primary key")}>PK </strong>}
                  {view.foreignColumns.get(table.name)?.has(column.name) && <strong title={translate("Foreign key")}>FK </strong>}
                  {column.name}
                </span>
                <span className="break-all text-right text-muted-foreground">{column.type}</span>
              </li>)}
            </ul>
          </article>)}
          {!view.tables.length && <p className="text-sm">{translate("No matching tables.")}</p>}
        </div>
        <aside className="flex min-w-0 flex-col gap-3 border bg-card p-4">
          <h3 className="font-semibold">{translate("Table relationships")}</h3>
          {(selected || query) && <Button size="sm" variant="outline" onClick={() => select("")}>{translate("Show all relationships")}</Button>}
          <p className="text-xs text-muted-foreground">{translate("Select a table to see its incoming and outgoing links. Arrows point from the foreign key to the referenced key.")}</p>
          {view.links.map((link, i) => <div key={i} className="break-all border bg-muted/30 p-3 font-mono text-xs">
            {!link.fromMissing && view.names.has(link.from)
              ? <button className="text-left underline" onClick={() => select(link.from)}>{link.from}</button>
              : <span>{link.from}</span>} ({link.columns.join(", ")})
            {link.fromMissing && <p className="mt-2 font-sans text-muted-foreground">{translate("Source table is not included in this dump.")}</p>}
            <ArrowDown aria-hidden="true" className="my-2 size-4" />
            <span className="sr-only">{translate("References")}</span>
            {!link.toMissing && view.names.has(link.to)
              ? <button className="text-left underline" onClick={() => select(link.to)}>{link.to}</button>
              : <span>{link.to}</span>} ({link.references.join(", ") || translate("Primary key")})
            {(link.toMissing || !view.names.has(link.to)) && <p className="mt-2 font-sans text-muted-foreground">{translate("Referenced table is not included in this dump.")}</p>}
          </div>)}
          {!view.links.length && <p className="text-sm text-muted-foreground">{translate("No declared foreign keys found for this selection.")}</p>}
        </aside>
      </div>
    </>}
  </section>;
}

type Position = { x: number; y: number };
function relationshipPath(from: Position, to: Position): string {
  if (from === to) return "M " + (from.x + 200) + " " + from.y + " C " + (from.x + 200) + " " + (from.y - 30) + ", " + (from.x + 285) + " " + (from.y - 30) + ", " + (from.x + 250) + " " + (from.y + 35);
  if (from.x === to.x) return "M " + (from.x + 250) + " " + (from.y + 35) + " C " + (from.x + 295) + " " + (from.y + 35) + ", " + (to.x + 295) + " " + (to.y + 35) + ", " + (to.x + 250) + " " + (to.y + 35);
  const right = to.x > from.x;
  const start = from.x + (right ? 250 : 0);
  const end = to.x + (right ? 0 : 250);
  const bend = right ? 50 : -50;
  return "M " + start + " " + (from.y + 35) + " C " + (start + bend) + " " + (from.y + 35) + ", " + (end - bend) + " " + (to.y + 35) + ", " + end + " " + (to.y + 35);
}

function RelationshipDiagram({ tables, links, selected, select }: {
  tables: DumpTable[];
  links: DumpSchema["links"];
  selected: string;
  select: (name: string) => void;
}) {
  const marker = useId().replaceAll(":", "");
  const positions = new Map(tables.map((table, i) => [table.name, { x: 45 + (i % 3) * 330, y: 35 + Math.floor(i / 3) * 150 }]));
  return <div className="max-h-[460px] min-w-0 overflow-auto border bg-muted/10">
    <svg width={Math.max(340, Math.min(3, tables.length) * 330 + 10)} height={Math.max(140, Math.ceil(tables.length / 3) * 150)} role="group" aria-label={translate("Table relationships")}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
      {links.map((link, i) => {
        if (link.fromMissing || link.toMissing) return null;
        const from = positions.get(link.from), to = positions.get(link.to);
        if (!from || !to) return null;
        return <path key={i} d={relationshipPath(from, to)} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.6" markerEnd={"url(#" + marker + ")"}>
          <title>{link.from + " (" + link.columns.join(", ") + ") \u2192 " + link.to + " (" + link.references.join(", ") + ")"}</title>
        </path>;
      })}
      {tables.map(table => {
        const position = positions.get(table.name)!;
        const keys = table.columns.filter(column => column.primary).map(column => column.name).join(", ");
        return <g key={table.name} role="button" tabIndex={0} aria-pressed={selected === table.name} aria-label={table.name} onClick={() => select(selected === table.name ? "" : table.name)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(selected === table.name ? "" : table.name); } }} className="cursor-pointer">
          <title>{table.name}</title>
          <rect x={position.x} y={position.y} width="250" height="70" className="fill-background" stroke="currentColor" strokeWidth={selected === table.name ? 3 : 1} />
          <text x={position.x + 12} y={position.y + 27} fill="currentColor" fontSize="13" fontFamily="monospace">{table.name.length > 28 ? table.name.slice(0, 25) + "\u2026" : table.name}</text>
          <text x={position.x + 12} y={position.y + 52} fill="currentColor" fontSize="11" opacity="0.65">{keys ? "PK: " + (keys.length > 28 ? keys.slice(0, 25) + "\u2026" : keys) : table.columns.length + " " + translate("Fields")}</text>
        </g>;
      })}
    </svg>
  </div>;
}
