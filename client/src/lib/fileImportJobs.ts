import type { DatabaseEngine } from "./nativeTarget";
export type FileImportEngine = DatabaseEngine;
interface SavedImport {
  sessionId: string;
  engine: FileImportEngine;
  jobId: string;
}
const KEY = "dbf-inspector:file-import-jobs";
const engines: FileImportEngine[] = [
  "mysql",
  "mongo",
  "postgres",
  "mssql",
  "redis",
];
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
function read(): SavedImport[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .flatMap((value: unknown) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
          return [];
        const row = value as Record<string, unknown>;
        if (
          typeof row.sessionId !== "string" ||
          !identifier.test(row.sessionId) ||
          typeof row.jobId !== "string" ||
          !identifier.test(row.jobId) ||
          !engines.includes(row.engine as FileImportEngine)
        )
          return [];
        return [
          {
            sessionId: row.sessionId,
            engine: row.engine as FileImportEngine,
            jobId: row.jobId,
          },
        ];
      })
      .slice(-30);
  } catch {
    return [];
  }
}
function write(refs: SavedImport[]): void {
  try {
    const value = JSON.stringify(refs.slice(-30));
    if (localStorage.getItem(KEY) !== value) localStorage.setItem(KEY, value);
  } catch {
    /* Active operations remain available in memory. */
  }
}
export function savedFileImportJob(
  sessionId: string,
  engine: FileImportEngine,
): string | null {
  return (
    read()
      .filter((ref) => ref.sessionId === sessionId && ref.engine === engine)
      .at(-1)?.jobId ?? null
  );
}
export function fileImportEngines(
  sessionId: string | null,
): FileImportEngine[] {
  return [
    ...new Set(
      read()
        .filter((ref) => ref.sessionId === sessionId)
        .map((ref) => ref.engine),
    ),
  ];
}
export function trackStartedFileImport<
  T extends { jobId: string; state: string },
>(sessionId: string, engine: FileImportEngine, status: T): T {
  if (
    status.state === "running" &&
    identifier.test(sessionId) &&
    identifier.test(status.jobId)
  )
    write([
      ...read().filter(
        (ref) => ref.sessionId !== sessionId || ref.engine !== engine,
      ),
      { sessionId, engine, jobId: status.jobId },
    ]);
  return status;
}
export function forgetFileImportJob(
  sessionId: string,
  engine: FileImportEngine,
  jobId: string,
): void {
  const current = read();
  const remaining = current.filter(
    (ref) =>
      ref.sessionId !== sessionId ||
      ref.engine !== engine ||
      ref.jobId !== jobId,
  );
  if (remaining.length !== current.length) write(remaining);
}
