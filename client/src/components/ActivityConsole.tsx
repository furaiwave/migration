import { translate } from "@/i18n";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronUp, Terminal } from "lucide-react";
import {
  clearLog,
  downloadLog,
  formatLog,
  getLog,
  subscribeLog,
  type LogEntry,
} from "@/lib/activityLog";
import { Button } from "@/components/ui/button";
export function ActivityConsole() {
  const entries = useSyncExternalStore(subscribeLog, getLog);
  const [open, setOpen] = useState(false);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState<LogEntry["level"] | "ALL">("ALL");
  const viewport = useRef<HTMLDivElement>(null);
  const visible =
    filter === "ALL"
      ? entries
      : entries.filter((entry) => entry.level === filter);
  const latest = entries.at(-1);
  const errors = entries.filter((entry) => entry.level === "ERROR").length;
  const warnings = entries.filter((entry) => entry.level === "WARNING").length;
  useEffect(() => {
    if (follow && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [entries, follow, filter, open]);
  return (
    <section
      className="workspace-console"
      data-open={open}
      aria-label={translate("Консоль міграції")}
    >
      <div className="workspace-console-bar">
        <button
          type="button"
          className="workspace-console-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-controls="migration-console-output"
          aria-label={
            open ? translate("Згорнути журнал") : translate("Розгорнути журнал")
          }
        >
          <Terminal size={15} />
          <span>{translate("Консоль міграції")}</span>
          <span className="workspace-log-count">{entries.length}</span>
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </button>
        <p
          className="workspace-console-latest"
          title={latest ? formatLog(latest) : undefined}
        >
          {latest ? (
            <>
              <span
                className={
                  "workspace-log-level level-" + latest.level.toLowerCase()
                }
              >
                {latest.level}
              </span>
              <span className="truncate">
                {latest.source} · {latest.message}
              </span>
            </>
          ) : (
            translate("Події з’являться після початку роботи.")
          )}
        </p>
        <div className="workspace-console-counters">
          <span className={warnings ? "text-amber-600" : ""}>
            WARNING <b>{warnings}</b>
          </span>
          <span className={errors ? "text-red-500" : ""}>
            ERROR <b>{errors}</b>
          </span>
        </div>
      </div>
      <div id="migration-console-output" hidden={!open}>
        <div className="workspace-console-tools">
          <div className="workspace-log-filters">
            {(["ALL", "INFO", "DONE", "WARNING", "ERROR"] as const).map(
              (level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={filter === level}
                  onClick={() => setFilter(level)}
                >
                  {level === "ALL" ? translate("Усі події") : level}
                </button>
              ),
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={follow}
                onChange={(event) => setFollow(event.target.checked)}
              />
              {translate("Автопрокрутка")}
            </label>
            <Button
              size="sm"
              variant="outline"
              disabled={!entries.length}
              onClick={downloadLog}
            >
              {translate("Завантажити .log")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!entries.length}
              onClick={clearLog}
            >
              {translate("Очистити журнал")}
            </Button>
          </div>
        </div>
        <div
          ref={viewport}
          role="log"
          aria-live="off"
          tabIndex={0}
          className="workspace-log-viewport"
        >
          {visible.length ? (
            visible.map((entry, index) => (
              <div
                key={index}
                className={
                  "workspace-log-line level-" + entry.level.toLowerCase()
                }
              >
                {formatLog(entry)}
              </div>
            ))
          ) : (
            <p className="text-zinc-500">
              {entries.length
                ? translate("Немає подій для цього фільтра.")
                : translate("Події з’являться після початку роботи.")}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}
