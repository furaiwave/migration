import { useCallback, useEffect, useState } from "react";
import { hasActiveImport } from "@/lib/importActivity";
import {
  initialWorkspaceNavigation,
  rememberDatabaseMode,
  requestedWorkspacePage,
  workspaceHref,
  type WorkspacePage,
} from "@/lib/workspaceNavigation";

export function useWorkspaceNavigation(locked: boolean) {
  const [state, setState] = useState(initialWorkspaceNavigation);
  const apply = useCallback(
    (page: WorkspacePage, history: "push" | "replace" | "none") => {
      if (page === "transfer" || page === "upgrade") rememberDatabaseMode(page);
      setState((current) => ({
        page,
        databaseMode:
          page === "transfer" || page === "upgrade"
            ? page
            : current.databaseMode,
        databaseOpened:
          current.databaseOpened || page === "transfer" || page === "upgrade",
      }));
      if (history !== "none") {
        const changedPage = requestedWorkspacePage() !== page;
        const href = workspaceHref(page);
        if (
          window.location.pathname +
            window.location.search +
            window.location.hash !==
          href
        )
          window.history[history === "push" ? "pushState" : "replaceState"](
            null,
            "",
            href,
          );
        if (changedPage) window.scrollTo(0, 0);
      }
    },
    [],
  );
  const navigate = useCallback(
    (page: WorkspacePage) => {
      if (locked || hasActiveImport()) return;
      apply(page, "push");
    },
    [locked, apply],
  );
  const revealDatabaseJob = useCallback(() => {
    apply(state.databaseMode, "replace");
  }, [state.databaseMode, apply]);

  useEffect(() => {
    // Make restored jobs and legacy entry URLs bookmarkable without losing section anchors.
    if (requestedWorkspacePage() !== state.page)
      window.history.replaceState(
        null,
        "",
        workspaceHref(state.page) + window.location.hash,
      );
  }, [state.page]);
  useEffect(() => {
    const pop = () => {
      const next = requestedWorkspacePage() ?? "home";
      if (next === state.page) return;
      if (locked || hasActiveImport()) {
        window.history.replaceState(null, "", workspaceHref(state.page));
        return;
      }
      apply(next, "none");
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [state.page, locked, apply]);

  return { ...state, navigate, revealDatabaseJob };
}
