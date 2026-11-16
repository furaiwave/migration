import { useEffect, useRef, useSyncExternalStore } from "react";
export type DatabaseEngine = "mysql" | "mongo" | "postgres" | "mssql" | "redis";
export interface NativeServer {
  id: string;
  engine: DatabaseEngine;
  label: string;
  host: string;
  port: number;
  source: string;
  reachable: boolean;
  protocolConfirmed: boolean;
}
interface TargetState {
  active: DatabaseEngine | null;
  servers: Partial<Record<DatabaseEngine, NativeServer>>;
}
const KEY = "dbf-inspector:native-target";
const engines: DatabaseEngine[] = ["mysql", "mongo", "postgres", "mssql", "redis"];
function safeServer(value: unknown): NativeServer | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const s = value as Record<string, unknown>;
  if (
    !engines.includes(s.engine as DatabaseEngine) ||
    typeof s.host !== "string" ||
    !s.host.trim() ||
    s.host.length > 255 ||
    Array.from(s.host).some((c) => c.charCodeAt(0) < 32) ||
    typeof s.port !== "number" ||
    !Number.isInteger(s.port) ||
    s.port < 1 ||
    s.port > 65535 ||
    typeof s.id !== "string" ||
    typeof s.label !== "string"
  )
    return null;
  return {
    engine: s.engine as DatabaseEngine,
    host: s.host,
    port: s.port,
    id: s.id,
    label: s.label,
    source: typeof s.source === "string" ? s.source : "saved",
    reachable: s.reachable === true,
    protocolConfirmed: s.protocolConfirmed === true,
  };
}
function load(): TargetState {
  try {
    const stored = JSON.parse(
      localStorage.getItem(KEY) ?? "null",
    ) as TargetState | null;
    if (
      stored &&
      engines.includes(stored.active!) &&
      stored.servers &&
      typeof stored.servers === "object"
    ) {
      const servers: TargetState["servers"] = {};
      for (const engine of engines) {
        const server = safeServer(stored.servers[engine]);
        if (server?.engine === engine) servers[engine] = server;
      }
      return { active: stored.active, servers };
    }
  } catch {
    /* Storage may be unavailable. */
  }
  return { active: null, servers: {} };
}

let state = load();
const listeners = new Set<() => void>();
export const getNativeTarget = () => state;
export const subscribeNativeTarget = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export function selectNativeServer(server: NativeServer) {
  // Only non-secret endpoint metadata is persisted. Credentials stay in the form's memory.
  const safe = safeServer(server);
  if (!safe) return;
  state = {
    active: safe.engine,
    servers: { ...state.servers, [safe.engine]: safe },
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    localStorage.setItem("dbf-inspector:export-target", safe.engine);
  } catch {
    /* Keep selection in memory. */
  }
  listeners.forEach((fn) => fn());
}
export const useNativeTarget = () =>
  useSyncExternalStore(subscribeNativeTarget, getNativeTarget);
export function useNativeSelection(
  engine: DatabaseEngine,
  onSelect: (server: NativeServer) => void,
  busy: boolean,
) {
  const applied = useRef<string | null>(null);
  useEffect(() => {
    const update = () => {
      const selected = state.servers[engine];
      const endpoint = selected
        ? JSON.stringify([selected.engine, selected.host, selected.port])
        : null;
      if (selected && endpoint !== applied.current && !busy) {
        applied.current = endpoint;
        onSelect(selected);
      }
    };
    update();
    return subscribeNativeTarget(update);
  }, [engine, onSelect, busy]);
}

export function activateNativeEngine(engine: DatabaseEngine) {
  if (state.active === engine) return;
  state = { ...state, active: engine };
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* Keep selection in memory. */
  }
  listeners.forEach((fn) => fn());
}
