import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { SqlDumpPanel } from "@/components/SqlDumpPanel";
import { WorkspaceHome } from "@/components/WorkspaceHome";
import { WorkspaceNavigation } from "@/components/WorkspaceNavigation";
import { useWorkspaceNavigation } from "@/hooks/useWorkspaceNavigation";
import { DatabaseMigrationPanel } from "@/components/DatabaseMigrationPanel";
import { hasDatabaseMigrationJob } from "@/lib/databaseMigration";
import { WorkspaceOverview } from "@/components/WorkspaceOverview";
import { DatabaseDiscovery } from "@/components/DatabaseDiscovery";
import { ActivityConsole } from "@/components/ActivityConsole";
import { translate, useLanguage } from "@/i18n";
import { LanguagePicker } from "@/components/LanguagePicker";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FileDropzone } from "@/components/FileDropzone";
import { FileTabs } from "@/components/FileTabs";
import { RelationshipsPanel } from "@/components/RelashionshipsPanel";
import { useParseFiles } from "@/hooks/useParseFiles";
import { useAddRelationship } from "@/hooks/useAddRelationship";
import type {
  ParseMultipleResult,
  DbfFilePreview,
  DbfRelationshipGraph,
  AddManualRelationshipInput,
} from "@/api/api.types";
import { ExportPanel } from "@/components/ExportPanel";
import { errorMessage } from "@/lib/errors";
import { apiRequest, ApiError, BUNDLED_APP, CLOUD_APP } from "@/client/client";
import { hasActiveImport, useHasActiveImport } from "@/lib/importActivity";
import { fileImportEngines } from "@/lib/fileImportJobs";
import { lastSession, rememberSession } from "@/lib/lastSession";

const SqlWorkspace = lazy(() => import("@/components/SqlWorkspace"));

export default function App() {
  useLanguage();
  const importing = useHasActiveImport();
  const [migrating, setMigrating] = useState(
    () =>
      hasDatabaseMigrationJob() &&
      fileImportEngines(lastSession()).length === 0,
  );
  const parse = useParseFiles();
  const navigationLocked = migrating || importing || parse.isPending;
  const {
    page,
    databaseMode,
    databaseOpened,
    editorOpened,
    dumpOpened,
    navigate,
    revealDatabaseJob,
  } = useWorkspaceNavigation(navigationLocked);
  const handleMigrationBusy = useCallback(
    (busy: boolean, activeJob: boolean) => {
      setMigrating(busy);
      if (activeJob) revealDatabaseJob();
    },
    [revealDatabaseJob],
  );
  const addRel = useAddRelationship();

  // Parsed session lives here; the graph can be replaced as manual links are added.
  const [session, setSession] = useState<ParseMultipleResult | null>(null);
  const activeSession = useRef<string | null>(null);
  const sessionGeneration = useRef(0);
  useEffect(() => {
    activeSession.current = session?.sessionId ?? null;
  }, [session?.sessionId]);
  const [graph, setGraph] = useState<DbfRelationshipGraph | null>(null);
  // A reload reopens the last session; the server keeps it on disk for a day.
  const [restoring, setRestoring] = useState(() => lastSession() !== null);
  // The last session could not be reached (backend down or restarting) — it is not lost.
  const [restoreError, setRestoreError] = useState<Error | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  useEffect(() => {
    const id = lastSession();
    if (!id) return;
    let disposed = false;
    const generation = sessionGeneration.current;
    const current = () => !disposed && generation === sessionGeneration.current;
    apiRequest("GET /dbf/session/:id", { params: { id } })
      .then((result) => {
        if (!current()) return;
        activeSession.current = result.sessionId;
        setSession(result);
        setGraph(result.graph);
        setRestoreError(null);
      })
      .catch((err) => {
        if (!current()) return;
        // Forget it only when the server says it is gone.
        if (err instanceof ApiError && err.status === 404) {
          rememberSession(null);
          setRestoreError(null);
        } else {
          setRestoreError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .finally(() => {
        if (current()) setRestoring(false);
      });
    return () => {
      disposed = true;
    };
  }, [restoreAttempt]);

  const handleParse = (files: File[], previewRows: number) => {
    const generation = ++sessionGeneration.current;
    setRestoring(false);
    setRestoreError(null);
    void parse
      .mutate({ files, previewRows })
      .then((result) => {
        if (generation !== sessionGeneration.current) return;
        activeSession.current = result.sessionId;
        setSession(result);
        setGraph(result.graph);
        rememberSession(result.sessionId);
      })
      .catch(() => {
        /* surfaced via parse.state */
      });
  };

  const handleAdd = async (
    input: AddManualRelationshipInput,
  ): Promise<void> => {
    const next = await addRel.mutate(input);
    if (activeSession.current === input.sessionId) setGraph(next);
  };

  // A table re-read with another encoding: swap it in, the graph may have changed with its field names.
  const handleFileChange = (
    file: DbfFilePreview,
    nextGraph: DbfRelationshipGraph,
    sessionId: string,
  ) => {
    if (activeSession.current !== sessionId) return;
    setSession(
      (s) =>
        s && {
          ...s,
          files: s.files.map((f) => (f.fileName === file.fileName ? file : f)),
        },
    );
    setGraph(nextGraph);
  };

  const reset = () => {
    if (hasActiveImport()) return;
    sessionGeneration.current++;
    activeSession.current = null;
    setRestoring(false);
    setRestoreError(null);
    // Free the uploaded files on the server; a failure only means the session already expired.
    if (session) {
      void apiRequest("DELETE /dbf/session/:id", {
        params: { id: session.sessionId },
      }).catch(() => {});
    }
    rememberSession(null);
    parse.reset();
    addRel.reset();
    setSession(null);
    setGraph(null);
  };

  return (
    <div className="workspace-shell flex min-h-svh w-full flex-col bg-background text-foreground">
      <header className="workspace-topbar">
        <div className="workspace-topbar-inner">
          <div className="flex items-center gap-2.5">
            <span className="workspace-brand-mark">
              <img src="/favicon.svg" alt="" className="size-5" />
            </span>
            <div>
              <h1 className="font-mono text-sm font-semibold tracking-tight">
                Data Migrator
              </h1>
              <p className="text-xs text-muted-foreground">
                {translate("Data migration")}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LanguagePicker />
            <ThemeToggle />
            {session && (
              <Button
                variant="outline"
                size="sm"
                disabled={importing}
                onClick={reset}
              >
                <RotateCcw /> {translate("New session")}
              </Button>
            )}
          </div>
        </div>
        <WorkspaceNavigation
          page={page}
          locked={navigationLocked}
          onNavigate={navigate}
        />
      </header>

      <main className="workspace-main">
        {page === "home" && (
          <WorkspaceHome locked={navigationLocked} onNavigate={navigate} />
        )}
        <div hidden={page !== "transfer" && page !== "upgrade"}>
          {databaseOpened && (
            <DatabaseMigrationPanel
              mode={databaseMode}
              onModeChange={navigate}
              onBusy={handleMigrationBusy}
            />
          )}
        </div>
        <div hidden={page !== "editor"}>
          {editorOpened && (
            <Suspense
              fallback={<p role="status">{translate("Loading editor…")}</p>}
            >
              <SqlWorkspace />
            </Suspense>
          )}
        </div>
        <div hidden={page !== "dump"}>{dumpOpened && <SqlDumpPanel />}</div>
        <div hidden={page !== "files"}>
          <WorkspaceOverview
            session={session}
            graph={graph}
            working={restoring || parse.isPending}
          />
          <div className="workspace-grid">
            <aside id="destination" className="workspace-sidebar">
              <DatabaseDiscovery />
            </aside>
            <div className="workspace-content">
              {restoring && !session ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />{" "}
                  {translate("Opening the last session…")}{" "}
                </p>
              ) : restoreError && !session ? (
                <div className="flex flex-col items-start gap-3 border border-destructive/40 p-4 text-sm">
                  <p className="text-destructive">
                    {translate("Could not open the last session:")}{" "}
                    {errorMessage(restoreError)}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {CLOUD_APP ? (
                      <>
                        {translate(
                          "Sessions stay on the server for one day. Check your connection and retry, or upload the files again.",
                        )}
                      </>
                    ) : BUNDLED_APP ? (
                      <>
                        {translate(
                          "Sessions stay on the server for 24 hours. Restart Data Migrator and try again.",
                        )}
                      </>
                    ) : (
                      <>
                        {translate(
                          "Sessions stay on the server for 24 hours. Start the backend (",
                        )}
                        <code className="bg-muted px-1">npm run start:dev</code>{" "}
                        {translate("in migration-gateway) and try again.")}
                      </>
                    )}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => {
                        setRestoring(true);
                        setRestoreAttempt((n) => n + 1);
                      }}
                    >
                      <RotateCcw /> {translate("Try again")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        rememberSession(null);
                        setRestoreError(null);
                      }}
                    >
                      {translate("Start a new session")}
                    </Button>
                  </div>
                </div>
              ) : !session ? (
                <section id="source" className="workspace-card">
                  <div className="workspace-section-heading">
                    <span className="workspace-step-index">02</span>
                    <div>
                      <h2>{translate("Source data")}</h2>
                      <p>
                        {translate(
                          "Add table files together with their memo files and indexes.",
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="workspace-card-body">
                    <FileDropzone
                      isPending={parse.isPending}
                      errorMessage={
                        parse.state.status === "error"
                          ? errorMessage(parse.state.error)
                          : undefined
                      }
                      onSubmit={handleParse}
                    />
                  </div>
                </section>
              ) : (
                <>
                  <section id="source" className="workspace-card">
                    <div className="workspace-section-heading">
                      <span className="workspace-step-index">02</span>
                      <div>
                        <h2>{translate("Source data")}</h2>
                        <p>
                          {translate(
                            "Review encoding, columns and sample records.",
                          )}
                        </p>
                      </div>
                      <span className="workspace-section-tag">
                        {translate("Tables")}: {session.files.length}
                      </span>
                    </div>
                    <div className="workspace-card-body">
                      <FileTabs
                        key={session.sessionId}
                        sessionId={session.sessionId}
                        files={session.files}
                        onFileChange={(file, nextGraph) =>
                          handleFileChange(file, nextGraph, session.sessionId)
                        }
                      />
                    </div>
                  </section>
                  {graph && (
                    <section id="review" className="workspace-card">
                      <div className="workspace-section-heading">
                        <span className="workspace-step-index">03</span>
                        <div>
                          <h2>{translate("Verification")}</h2>
                          <p>
                            {translate(
                              "Review relationships between tables before transferring.",
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="workspace-card-body">
                        <RelationshipsPanel
                          sessionId={session.sessionId}
                          files={session.files}
                          graph={graph}
                          isAdding={addRel.isPending}
                          addError={
                            addRel.state.status === "error"
                              ? errorMessage(addRel.state.error)
                              : undefined
                          }
                          onAdd={handleAdd}
                          onGraphChange={setGraph}
                        />
                      </div>
                    </section>
                  )}
                  {graph && (
                    <section id="transfer" className="workspace-card">
                      <div className="workspace-section-heading">
                        <span className="workspace-step-index">04</span>
                        <div>
                          <h2>{translate("Transfer")}</h2>
                          <p>
                            {translate(
                              "Choose a DBMS, review the plan and start the import.",
                            )}
                          </p>
                        </div>
                      </div>
                      <div className="workspace-card-body">
                        <ExportPanel
                          key={session.sessionId}
                          sessionId={session.sessionId}
                          graph={graph}
                        />
                      </div>
                    </section>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </main>
      <ActivityConsole />
    </div>
  );
}
