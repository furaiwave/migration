import { useState } from 'react';
import { Database, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { FileDropzone } from '@/components/FileDropzone';
import { FileTabs } from '@/components/FileTabs';
import { RelationshipsPanel } from './components/RelashionshipsPanel';
import { useParseFiles } from '@/hooks/useParseFiles';
import { useAddRelationship } from '@/hooks/useAddRelationship';
import type {
  ParseMultipleResult,
  DbfRelationshipGraph,
  AddManualRelationshipInput,
} from '@/api/api.types';
import { ApiError } from '@/client/client';

// Turn an unknown error into a human sentence in the interface's own voice.
function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string | string[] } | null;
    const msg = body?.message;
    if (Array.isArray(msg)) return msg.join('; ');
    if (typeof msg === 'string') return msg;
    return `Request failed (${err.status}).`;
}
if (err instanceof Error) return err.message;
return 'Something went wrong.';
}

export default function App() {
const parse = useParseFiles();
const addRel = useAddRelationship();

// Parsed session lives here; the graph can be replaced as manual links are added.
const [session, setSession] = useState<ParseMultipleResult | null>(null);
const [graph, setGraph] = useState<DbfRelationshipGraph | null>(null);

const handleParse = (files: File[], previewRows: number) => {
  void parse.mutate({ files, previewRows }).then((result) => {
    setSession(result);
    setGraph(result.graph);
  }).catch(() => { /* surfaced via parse.state */ });
};

const handleAdd = (input: AddManualRelationshipInput) => {
  void addRel.mutate(input).then(setGraph).catch(() => { /* surfaced via addRel.state */ });
};

const reset = () => {
  parse.reset();
  addRel.reset();
  setSession(null);
  setGraph(null);
};

return (
  <div className="min-h-screen bg-background text-foreground">
    <header className="border-b border-border/60">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-2.5">
          <Database className="size-5 text-primary" />
          <div>
            <h1 className="font-mono text-sm font-semibold tracking-tight">dbf inspector</h1>
            <p className="text-xs text-muted-foreground">Read legacy .dbf tables before migrating to MySQL</p>
          </div>
        </div>
        {session && (
          <Button variant="outline" size="sm" onClick={reset}>
            <RotateCcw /> New session
          </Button>
        )}
      </div>
    </header>

    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-8">
      {!session ? (
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
            />
          )}
          <Separator />
          <FileTabs files={session.files} />
        </>
      )}
    </main>
  </div>
);
}