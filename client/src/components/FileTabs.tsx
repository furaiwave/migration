import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileInspector } from './FileInspector';
import type { DbfFilePreview, DbfRelationshipGraph } from "@/api/api.types";

interface FileTabsProps {
  readonly sessionId: string;
  readonly files: readonly DbfFilePreview[];
  readonly onFileChange: (file: DbfFilePreview, graph: DbfRelationshipGraph) => void;
}

export function FileTabs({ sessionId, files, onFileChange }: FileTabsProps) {
  if (files.length === 0) return null;

  return (
    <Tabs defaultValue={files[0]!.fileName} className="flex flex-col gap-4">
      {/* With dozens of tables the strip would push the content off screen; it scrolls instead. */}
      <TabsList className="flex h-auto! max-h-40 w-full flex-wrap justify-start gap-1 overflow-y-auto bg-transparent p-0">
        {files.map((f) => (
          <TabsTrigger
            key={f.fileName}
            value={f.fileName}
            className="rounded-md border border-border/50 bg-card/40 font-mono flex-none px-3 data-active:border-primary/50 data-active:bg-primary/10"
          >
            {f.fileName}
            <span className="ml-1.5 text-xs text-muted-foreground">{f.totalRecords.toLocaleString()}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {files.map((f) => (
        <TabsContent key={f.fileName} value={f.fileName} className="mt-0">
          <FileInspector sessionId={sessionId} file={f} onFileChange={onFileChange} />
        </TabsContent>
      ))}
    </Tabs>
  );
}