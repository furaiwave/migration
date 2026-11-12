import { translate, getLanguage } from '@/i18n';
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiRequest } from '@/client/client';
import { ENCODINGS, ENCODING_SOURCE_LABEL } from '@/lib/encodings';
import { errorMessage } from '@/lib/errors';
import { plural } from '@/lib/plural';
import { HeaderInspector } from './HeaderInspector';
import { FieldSchemaTable } from './FieldSchemaTable';
import { RecordPreviewTable } from './RecordPreviewTable';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import type { DbfFilePreview, DbfIndexInfo, DbfRelationshipGraph } from "@/api/api.types";

type View = 'schema' | 'data';

interface FileInspectorProps {
  readonly sessionId: string;
  readonly file: DbfFilePreview;
  /** The table was re-read with another encoding; field names and the links built on them may change. */
  readonly onFileChange: (file: DbfFilePreview, graph: DbfRelationshipGraph) => void;
}

export function FileInspector({ sessionId, file, onFileChange }: FileInspectorProps) {
  const [view, setView] = useState<View>('schema');

  return (
    <div className="flex flex-col gap-4">
      <EncodingPicker sessionId={sessionId} file={file} onFileChange={onFileChange} />
      <HeaderInspector header={file.header} encoding={file.encoding} memoFile={file.memoFile} liveRecords={file.totalRecords} />
      {file.index && <IndexTags index={file.index} />}

      <section className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">
            {view === 'schema' ? translate("Структура полів") : translate("Перегляд записів")}
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {view === 'schema'
                ? `${file.header.fields.length} ${plural(file.header.fields.length, translate("поле"), translate("поля"), translate("полів"))}`
                : translate("{0} з {1} {2}", [file.preview.length, file.totalRecords.toLocaleString(getLanguage()), plural(file.totalRecords, translate("запису"), translate("записів"), translate("записів"))])}
            </span>
          </h3>
          <div className="flex gap-1">
            <Button
              variant={view === 'schema' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView('schema')}
            >
              {translate("Структура")}
            </Button>
            <Button
              variant={view === 'data' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setView('data')}
            >
              {translate("Дані")}
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

/** Tags read from the table's .CDX; the MySQL plan shows what becomes of each. */
function IndexTags({ index }: { index: DbfIndexInfo }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">
        {translate("Індекси")}
        <span className="ml-2 text-xs font-normal text-muted-foreground">
          {index.fileName} · {index.tags.length} {plural(index.tags.length, translate("тег"), translate("теги"), translate("тегів"))}
        </span>
      </h3>
      {index.error ? (
        <p className="text-xs text-destructive">{translate("Не вдалося прочитати")} {index.fileName}: {index.error}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{translate("Тег")}</TableHead>
              <TableHead>{translate("Вираз ключа")}</TableHead>
              <TableHead>{translate("Фільтр (FOR)")}</TableHead>
              <TableHead>{translate("Вид")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {index.tags.map((t) => (
              <TableRow key={t.name}>
                <TableCell className="font-medium">{t.name}</TableCell>
                <TableCell className="font-mono text-xs">{t.expression}</TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">{t.filter ?? '—'}</TableCell>
                <TableCell className="text-muted-foreground">
                  {[t.candidate && translate("кандидат"), t.unique && translate("унікальний"), t.descending && translate("спадний")].filter(Boolean).join(', ') || translate("звичайний")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

/** Re-reads the table with the chosen encoding, so a wrong guess shows up here rather than in MySQL. */
function EncodingPicker({ sessionId, file, onFileChange }: FileInspectorProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const value = file.encodingSource === 'manual' ? file.encoding : '';
  const items = ENCODINGS.map((e) =>
    e.value === '' && file.encodingSource !== 'manual'
      ? { value: '', label: translate("Автоматично — {0}, {1}", [file.encoding, ENCODING_SOURCE_LABEL[file.encodingSource]]) }
      : { value: e.value, label: e.label },
  );

  const choose = (encoding: string) => {
    setPending(true);
    setError(null);
    apiRequest('PATCH /dbf/session/:id/file/:fileName/encoding', {
      params: { id: sessionId, fileName: file.fileName },
      body: { encoding: encoding || null },
    })
      .then(({ file: next, graph }) => onFileChange(next, graph))
      .catch((err) => setError(err instanceof Error ? err : new Error(String(err))))
      .finally(() => setPending(false));
  };

  return (
    <div className="flex flex-wrap items-center gap-3 text-xs">
      <span className="font-semibold">{translate("Кодування тексту")}</span>
      <Select items={items} value={value} onValueChange={(v) => choose(v ?? '')} disabled={pending}>
        <SelectTrigger size="sm" className="min-w-72">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {pending && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
      <span className="text-muted-foreground">
        {file.encodingSource === 'detected'
          ? translate("{0}, тому кодування визначено за текстом — перевірте вкладку «Дані»; якщо літери неправильні, виберіть інше кодування.", [file.header.codePage === 0
              ? translate("У файлі немає позначки кодової сторінки")
              : translate("Позначка кодової сторінки (0x{0}) невідома або не відповідає тексту", [file.header.codePage.toString(16).toUpperCase()])])
          : translate("Це кодування використовується для назв полів, перегляду та експорту в MySQL.")}
      </span>
      {error && <span className="text-destructive">{errorMessage(error)}</span>}
    </div>
  );
}
