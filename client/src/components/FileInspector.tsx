import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { HeaderInspector } from './HeaderInspector';
import { FieldSchemaTable } from './FieldSchemaTable';
import { RecordPreviewTable } from './RecordPreviewTable';
import type { DbfFilePreview } from "@/api/api.types";

type View = 'schema' | 'data';

interface FileInspectorProps {
  readonly file: DbfFilePreview;
}

export function FileInspector({ file }: FileInspectorProps) {
  const [view, setView] = useState<View>('schema');

  return (
    <div className="flex flex-col gap-4">
      <HeaderInspector header={file.header} encoding={file.encoding} memoFile={file.memoFile} liveRecords={file.totalRecords} />

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {view === 'schema' ? 'Field schema' : 'Record preview'}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {view === 'schema'
                ? `${file.header.fields.length} fields`
                : `${file.preview.length} of ${file.totalRecords.toLocaleString()} records`}
            </span>
          </h3>
          <div className="flex gap-1">
            <Button
              variant={view === 'schema' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView('schema')}
            >
              Schema
            </Button>
            <Button
              variant={view === 'data' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView('data')}
            >
              Data
            </Button>
          </div>
        </div>
        {view === 'schema' ? (
          <FieldSchemaTable fields={file.header.fields} />
        ) : (
          <RecordPreviewTable fields={file.header.fields} rows={file.preview} />
        )}
      </section>
    </div>
  );
}
