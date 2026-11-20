import { useEffect, useSyncExternalStore } from "react";
const active = new Set<symbol>();
const listeners = new Set<() => void>();
export const hasActiveImport = () => active.size > 0;
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function useHasActiveImport() {
  return useSyncExternalStore(subscribe, hasActiveImport, () => false);
}
export function useImportActivity(running: boolean) {
  useEffect(() => {
    if (!running) return;
    const token = Symbol();
    active.add(token);
    notify();
    return () => {
      active.delete(token);
      notify();
    };
  }, [running]);
}
