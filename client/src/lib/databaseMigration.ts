import type { MigrationStatus } from "@/api/migration.types";

export function mergeMigrationStatus(
  current: MigrationStatus | null,
  incoming: MigrationStatus,
): MigrationStatus | null {
  if (!current || current.id !== incoming.id || current.state !== "running")
    return current;
  return incoming;
}

const JOB_KEY = "dbf-inspector:database-migration-job";
export function savedMigrationJob(): string | null {
  try {
    return localStorage.getItem(JOB_KEY);
  } catch {
    return null;
  }
}
export function rememberMigrationJob(id: string) {
  try {
    localStorage.setItem(JOB_KEY, id);
  } catch {
    /* In-memory operation remains available. */
  }
}
export function forgetMigrationJob() {
  try {
    localStorage.removeItem(JOB_KEY);
  } catch {
    /* Storage unavailable. */
  }
}
export function hasDatabaseMigrationJob() {
  return savedMigrationJob() !== null;
}
