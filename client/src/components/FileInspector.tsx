import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
      <HeaderInspector header={file.header} encoding={file.encoding} />

      <Card className="border-border/60">
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
          <CardTitle className="font-mono text-sm">
            {view === 'schema' ? 'Field schema' : 'Record preview'}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {view === 'schema'
                ? `${file.header.fields.length} fields`
                : `${file.preview.length} of ${file.totalRecords.toLocaleString()} records`}
            </span>
          </CardTitle>
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
        </CardHeader>
        <CardContent>
          {view === 'schema' ? (
            <FieldSchemaTable fields={file.header.fields} />
          ) : (
            <RecordPreviewTable fieldNames={file.fieldsNames} rows={file.preview} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}