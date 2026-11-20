import type { MouseEvent } from "react";
import { hasDatabaseMigrationJob } from "./databaseMigration";
import { fileImportEngines } from "./fileImportJobs";
import { lastSession } from "./lastSession";
import type { MigrationMode } from "@/api/migration.types";

export type WorkspacePage =
  | "home"
  | "files"
  | "transfer"
  | "upgrade"
  | "editor"
  | "dump";
const pages: readonly WorkspacePage[] = [
  "home",
  "files",
  "transfer",
  "upgrade",
  "editor",
  "dump",
];
const MODE_KEY = "dbf-inspector:database-workspace-mode";
export function requestedWorkspacePage(): WorkspacePage | null {
  const value = new URL(window.location.href).searchParams.get("view");
  return pages.includes(value as WorkspacePage)
    ? (value as WorkspacePage)
    : null;
}
export function workspaceHref(page: WorkspacePage): string {
  const url = new URL(window.location.href);
  url.searchParams.set("view", page);
  url.hash = "";
  return url.pathname + url.search;
}
export function savedDatabaseMode(): MigrationMode {
  try {
    return localStorage.getItem(MODE_KEY) === "upgrade"
      ? "upgrade"
      : "transfer";
  } catch {
    return "transfer";
  }
}
export function rememberDatabaseMode(mode: MigrationMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* Storage unavailable. */
  }
}
export function initialWorkspaceNavigation(): {
  page: WorkspacePage;
  databaseMode: MigrationMode;
  databaseOpened: boolean;
  editorOpened: boolean;
  dumpOpened: boolean;
} {
  const fileJob = fileImportEngines(lastSession()).length > 0;
  const rememberedMode = savedDatabaseMode();
  const page: WorkspacePage = fileJob
    ? "files"
    : (requestedWorkspacePage() ??
      (hasDatabaseMigrationJob()
        ? rememberedMode
        : lastSession()
          ? "files"
          : "home"));
  return {
    page,
    editorOpened: page === "editor",
    dumpOpened: page === "dump",
    databaseMode:
      page === "upgrade" || page === "transfer" ? page : rememberedMode,
    databaseOpened:
      page === "transfer" ||
      page === "upgrade" ||
      (!fileJob && hasDatabaseMigrationJob()),
  };
}

export function followWorkspaceLink(
  event: MouseEvent<HTMLAnchorElement>,
  page: WorkspacePage,
  locked: boolean,
  navigate: (page: WorkspacePage) => void,
): void {
  if (locked) {
    event.preventDefault();
    return;
  }
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigate(page);
}
