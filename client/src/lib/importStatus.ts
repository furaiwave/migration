// Concurrent polling and cancellation must never revive a finished or replaced job.
export function mergeImportStatus<T extends { readonly jobId: string; readonly state: string }>(
  current: T | null,
  incoming: T,
): T | null {
  if (!current || current.jobId !== incoming.jobId || current.state !== "running") return current;
  return incoming;
}
