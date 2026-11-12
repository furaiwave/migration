import { translate, useLanguage } from '@/i18n';
import { LanguagePicker } from '@/components/LanguagePicker';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useEffect, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { FileDropzone } from '@/components/FileDropzone';
import { FileTabs } from '@/components/FileTabs';
import { RelationshipsPanel } from '@/components/RelashionshipsPanel';
import { useParseFiles } from '@/hooks/useParseFiles';
import { useAddRelationship } from '@/hooks/useAddRelationship';
import type {
  ParseMultipleResult,
  DbfFilePreview,
  DbfRelationshipGraph,
  AddManualRelationshipInput,
} from '@/api/api.types';
import { ExportPanel } from '@/components/ExportPanel';
import { errorMessage } from '@/lib/errors';
import { apiRequest, ApiError, BUNDLED_APP } from '@/client/client';
import { lastSession, rememberSession } from '@/lib/lastSession';

export default function App() {
  useLanguage();
  const parse = useParseFiles();
  const addRel = useAddRelationship();

  // Parsed session lives here; the graph can be replaced as manual links are added.
  const [session, setSession] = useState<ParseMultipleResult | null>(null);
  const [graph, setGraph] = useState<DbfRelationshipGraph | null>(null);
  // A reload reopens the last session; the server keeps it on disk for a day.
  const [restoring, setRestoring] = useState(() => lastSession() !== null);
  // The last session could not be reached (backend down or restarting) — it is not lost.
  const [restoreError, setRestoreError] = useState<Error | null>(null);
  const [restoreAttempt, setRestoreAttempt] = useState(0);

  useEffect(() => {
    const id = lastSession();
    if (!id) return;
    apiRequest('GET /dbf/session/:id', { params: { id } })
      .then((result) => {
        setSession(result);
        setGraph(result.graph);
        setRestoreError(null);
      })
      .catch((err) => {
        // Forget it only when the server says it is gone.
        if (err instanceof ApiError && err.status === 404) {
          rememberSession(null);
          setRestoreError(null);
        } else {
          setRestoreError(err instanceof Error ? err : new Error(String(err)));
        }
      })
      .finally(() => setRestoring(false));
  }, [restoreAttempt]);

  const handleParse = (files: File[], previewRows: number) => {
    void parse.mutate({ files, previewRows }).then((result) => {
      setSession(result);
      setGraph(result.graph);
      rememberSession(result.sessionId);
    }).catch(() => { /* surfaced via parse.state */ });
  };

  const handleAdd = (input: AddManualRelationshipInput) => {
    void addRel.mutate(input).then(setGraph).catch(() => { /* surfaced via addRel.state */ });
  };

  // A table re-read with another encoding: swap it in, the graph may have changed with its field names.
  const handleFileChange = (file: DbfFilePreview, nextGraph: DbfRelationshipGraph) => {
    setSession((s) => s && { ...s, files: s.files.map((f) => (f.fileName === file.fileName ? file : f)) });
    setGraph(nextGraph);
  };

  const reset = () => {
    // Free the uploaded files on the server; a failure only means the session already expired.
    if (session) {
      void apiRequest('DELETE /dbf/session/:id', { params: { id: session.sessionId } }).catch(() => {});
    }
    rememberSession(null);
    parse.reset();
    addRel.reset();
    setSession(null);
    setGraph(null);
  };

  return (
    <div className="flex min-h-svh w-full flex-col bg-background text-foreground">
      <header className="border-b">
        <div className="flex w-full flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-2.5">
            <img src="/favicon.svg" alt="" className="size-6" />
            <div>
              <h1 className="text-sm font-semibold tracking-tight">dbf inspector</h1>
              <p className="text-xs text-muted-foreground">{translate("Перегляд старих таблиць .dbf перед перенесенням у MySQL або MongoDB")}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <LanguagePicker />
            <ThemeToggle />
            {session && (
              <Button variant="outline" size="sm" onClick={reset}>
                <RotateCcw /> {translate("Нова сесія")}
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="flex w-full flex-1 flex-col gap-6 px-6 py-6">
        {restoring && !session ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> {translate("Відкриваю останню сесію…")}
          </p>
        ) : restoreError && !session ? (
          <div className="flex flex-col items-start gap-3 border border-destructive/40 p-4 text-sm">
            <p className="text-destructive">
              {translate("Не вдалося відкрити останню сесію:")} {errorMessage(restoreError)}
            </p>
            <p className="text-xs text-muted-foreground">
              {BUNDLED_APP ? (
                <>{translate("Сесія зберігається на сервері добу. Перезапустіть програму dbf inspector і спробуйте ще раз.")}</>
              ) : (
                <>{translate("Сесія зберігається на сервері добу. Запустіть бекенд (")}<code className="bg-muted px-1">npm run start:dev</code>  {translate("у migration-gateway) і спробуйте ще раз.")}</>
              )}
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => { setRestoring(true); setRestoreAttempt((n) => n + 1); }}>
                <RotateCcw /> {translate("Спробувати ще раз")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => { rememberSession(null); setRestoreError(null); }}>
                {translate("Почати нову сесію")}
              </Button>
            </div>
          </div>
        ) : !session ? (
          <FileDropzone
            isPending={parse.isPending}
            errorMessage={parse.state.status === 'error' ? errorMessage(parse.state.error) : undefined}
            onSubmit={handleParse}
          />
        ) : (
          <>
            {graph && (
              <RelationshipsPanel
                sessionId={session.sessionId}
                files={session.files}
                graph={graph}
                isAdding={addRel.isPending}
                addError={addRel.state.status === 'error' ? errorMessage(addRel.state.error) : undefined}
                onAdd={handleAdd}
                onGraphChange={setGraph}
              />
            )}
            <Separator />
            {graph && <ExportPanel sessionId={session.sessionId} graph={graph} />}
            <Separator />
            <FileTabs sessionId={session.sessionId} files={session.files} onFileChange={handleFileChange} />
          </>
        )}
      </main>
    </div>
  );
}
