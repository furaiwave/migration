import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { FileInspector } from './FileInspector';
import type { DbfFilePreview } from "@/api/api.types";

interface FileTabsProps {
  readonly files: readonly DbfFilePreview[];
}

export function FileTabs({ files }: FileTabsProps) {
  if (files.length === 0) return null;

  return (
    <Tabs defaultValue={files[0]!.fileName} className="flex flex-col gap-4">
      <TabsList className="flex h-auto w-full flex-wrap justify-start gap-1 bg-transparent p-0">
        {files.map((f) => (
          <TabsTrigger
            key={f.fileName}
            value={f.fileName}
            className="rounded-md border border-border/50 bg-card/40 font-mono data-[state=active]:border-primary/50 data-[state=active]:bg-primary/10"
          >
            {f.fileName}
            <span className="ml-1.5 text-xs text-muted-foreground">{f.totalRecords.toLocaleString()}</span>
          </TabsTrigger>
        ))}
      </TabsList>
      {files.map((f) => (
        <TabsContent key={f.fileName} value={f.fileName} className="mt-0">
          <FileInspector file={f} />
        </TabsContent>
      ))}
    </Tabs>
  );
}