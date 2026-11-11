import { Fragment } from "react";
import { RotateCcw } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { FieldTypeBadge } from "./FieldTypeBadge";
import { EditableCell, QualityTable } from "./MysqlPlanTables";
import { cn } from "@/lib/utils";
import { identifierError } from "@/lib/mysqlTypes";
import type {
    BsonType,
    MongoCollectionPlan,
    MongoExportPlan,
    MongoFieldPlan,
    MongoIndexPlan,
    MongoReferencePlan,
    MysqlColumnOverride,
    MysqlPlanOverrides,
    MysqlTableOverride,
} from "@/api/api.types";

const PK_AUTO = '__auto__'
const PK_NONE = '__none__'

const BSON_LABEL: Readonly<Record<BsonType, string>> = {
    string: 'рядок (string)',
    int: 'ціле (int)',
    long: 'ціле (long)',
    decimal: 'десяткове (decimal)',
    double: 'дробове (double)',
    date: 'дата (date)',
    bool: 'логічне (bool)',
    binData: 'двійкове (binData)',
}

const SOURCE_LABEL: Readonly<Record<MongoReferencePlan['source'], string>> = {
    auto_name: 'збіг назв',
    auto_fk: 'зовнішній ключ',
    manual: 'вручну',
}

interface PlanEdits {
    readonly overrides: MysqlPlanOverrides
    readonly onTable: (fileName: string, patch: MysqlTableOverride) => void
    readonly onColumn: (fileName: string, dbfField: string, patch: MysqlColumnOverride) => void
    readonly onReset: () => void
    /** Sync mode: show which collections are replaced by _id and which are reloaded. */
    readonly syncMode: boolean
}

interface MongoPlanTablesProps extends PlanEdits {
    readonly plan: MongoExportPlan
    readonly dataChecked: boolean
}

export function MongoPlanTables({ plan, dataChecked, ...edits }: MongoPlanTablesProps) {
    // An edit undone leaves its key behind with an undefined value; that is not an edit.
    const hasEdits = Object.values(edits.overrides).some((t) =>
        Object.entries(t).some(([key, v]) => v !== undefined &&
            (key !== 'columns' || Object.values(v as object).some((c) => Object.values(c as object).some((x) => x !== undefined)))))

    return (
        <div className="flex flex-col gap-5">
            <QualityTable
                engine="MongoDB"
                quality={plan.quality}
                rows={plan.collections.filter((c) => !c.excluded).reduce((n, c) => n + c.rowCount, 0)}
                dataChecked={dataChecked}
            />

            <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold">
                        Колекції й поля
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                            одна таблиця — одна колекція, один запис — один документ · назви редагуються прямо тут · порожньо = автоматично
                        </span>
                    </h3>
                    {hasEdits && (
                        <Button variant="outline" size="sm" onClick={edits.onReset}>
                            <RotateCcw /> Скинути всі зміни
                        </Button>
                    )}
                </div>
                <Table containerClassName="max-h-[70vh]">
                    <TableHeader>
                        <TableRow>
                            <TableHead className="w-12 text-center" title="Експортувати це поле">Вкл.</TableHead>
                            <TableHead>Поле DBF</TableHead>
                            <TableHead>Тип DBF</TableHead>
                            <TableHead>Поле документа</TableHead>
                            <TableHead>Тип BSON</TableHead>
                            <TableHead>Примітка</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {plan.collections.map((c) => (
                            <Fragment key={c.fileName}>
                                <CollectionRow collection={c} {...edits} />
                                {!c.excluded && c.fields.map((f) => (
                                    <FieldRow key={f.dbfField} collection={c} field={f} {...edits} />
                                ))}
                            </Fragment>
                        ))}
                    </TableBody>
                </Table>
            </div>

            <ReferenceTable references={plan.references} />
            <IndexTable plan={plan} {...edits} />

            {plan.warnings.length > 0 && (
                <div className="flex flex-col gap-2">
                    <h3 className="text-sm font-semibold">Попередження</h3>
                    <Table>
                        <TableBody>
                            {plan.warnings.map((w) => (
                                <TableRow key={w}>
                                    <TableCell className="whitespace-normal text-amber-700 dark:text-amber-300">{w}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}
        </div>
    )
}

// ---------------------------------------------------------------- collections and fields

function CollectionRow({ collection: c, overrides, onTable, syncMode }: { collection: MongoCollectionPlan } & PlanEdits) {
    const override = overrides[c.fileName] ?? {}
    const included = c.fields.filter((f) => !f.excluded)
    const idValue = override.primaryKey === undefined ? PK_AUTO : override.primaryKey === null ? PK_NONE : override.primaryKey
    const idItems = [
        { value: PK_AUTO, label: c.idField ? `автоматично (${c.idField})` : 'автоматично' },
        { value: PK_NONE, label: 'ObjectId — без ключа' },
        ...included.map((f) => ({ value: f.dbfField, label: f.field })),
    ]

    return (
        <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableCell className="text-center">
                <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer accent-primary align-middle"
                    checked={!override.exclude}
                    aria-label={`Експортувати ${c.fileName}`}
                    onChange={(e) => onTable(c.fileName, { exclude: e.target.checked ? undefined : true })}
                />
            </TableCell>
            <TableCell colSpan={5}>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                    <span className="font-semibold">{c.fileName} →</span>
                    <EditableCell
                        value={override.name ?? ''}
                        placeholder={c.collection}
                        validate={identifierError}
                        onCommit={(name) => onTable(c.fileName, { name: name || undefined })}
                        disabled={c.excluded}
                        edited={override.name !== undefined}
                        className="w-48"
                    />
                    {c.excluded ? (
                        <span className="text-muted-foreground">не входить в експорт</span>
                    ) : (
                        <>
                            <span className="flex items-center gap-2 text-muted-foreground" title="Значення цього поля стає _id документа">
                                _id
                                <Select
                                    items={idItems}
                                    value={idValue}
                                    onValueChange={(v) => onTable(c.fileName, {
                                        primaryKey: v === PK_AUTO || v === null ? undefined : v === PK_NONE ? null : v,
                                    })}
                                >
                                    <SelectTrigger size="sm" className="min-w-40">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {idItems.map((i) => <SelectItem key={i.value} value={i.value}>{i.label}</SelectItem>)}
                                    </SelectContent>
                                </Select>
                            </span>
                            <span className="font-normal text-muted-foreground">
                                полів: {included.length} з {c.fields.length} · документів: {c.rowCount.toLocaleString()} · {c.encoding}
                                {c.deletedRows > 0 && (c.deletedCollection
                                    ? ` · видалених: ${c.deletedRows.toLocaleString()} → ${c.deletedCollection}`
                                    : ` · видалених: ${c.deletedRows.toLocaleString()} (пропускаються)`)}
                                {c.memoFile && ` · memo ${c.memoFile}`}
                                {c.indexFile && ` · індекси ${c.indexFile}`}
                                {syncMode && c.sync === 'reload' && ' · без _id з ключа: синхронізація завантажує колекцію заново'}
                                {c.skippedFields.length > 0 && ` · не переносяться: ${c.skippedFields.join(', ')}`}
                            </span>
                        </>
                    )}
                </div>
            </TableCell>
        </TableRow>
    )
}

function FieldRow({ collection: c, field: f, overrides, onColumn }: { collection: MongoCollectionPlan; field: MongoFieldPlan } & PlanEdits) {
    const override = overrides[c.fileName]?.columns?.[f.dbfField] ?? {}

    return (
        <TableRow className={cn(f.excluded && 'text-muted-foreground')}>
            <TableCell className="text-center">
                <input
                    type="checkbox"
                    className="size-3.5 cursor-pointer accent-primary align-middle"
                    checked={!f.excluded}
                    aria-label={`Експортувати ${c.fileName}.${f.dbfField}`}
                    onChange={(e) => onColumn(c.fileName, f.dbfField, { exclude: e.target.checked ? undefined : true })}
                />
            </TableCell>
            <TableCell className={cn(f.excluded && 'line-through')}>{f.dbfField}</TableCell>
            <TableCell>
                <span className="flex items-center gap-2">
                    <FieldTypeBadge type={f.dbfType} showLabel />
                    <span className="tabular-nums text-muted-foreground">
                        ({f.length}{f.decimals > 0 ? `,${f.decimals}` : ''})
                    </span>
                </span>
            </TableCell>
            <TableCell>
                <span className="flex items-center gap-2">
                    <EditableCell
                        value={override.name ?? ''}
                        placeholder={f.field}
                        validate={identifierError}
                        onCommit={(name) => onColumn(c.fileName, f.dbfField, { name: name || undefined })}
                        disabled={f.excluded}
                        edited={override.name !== undefined}
                    />
                    {f.isId && <Badge variant="outline" className="border-sky-500/30 text-sky-700 dark:text-sky-300">+ _id</Badge>}
                </span>
            </TableCell>
            <TableCell className="text-muted-foreground">{f.excluded ? '' : BSON_LABEL[f.bsonType]}</TableCell>
            <TableCell className="text-muted-foreground">{f.excluded ? 'не експортується' : f.note ?? ''}</TableCell>
        </TableRow>
    )
}

// ---------------------------------------------------------------- references

function ReferenceTable({ references }: { references: readonly MongoReferencePlan[] }) {
    const created = references.filter((r) => r.status === 'create').length
    return (
        <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
                Посилання між колекціями
                <span className="ml-2 font-normal text-muted-foreground">
                    дочірній документ зберігає значення батьківського; з'єднуються через $lookup · перевірено: {created}, пропущено: {references.length - created}
                </span>
            </h3>
            {references.length === 0 ? (
                <div className="flex h-16 items-center justify-center border border-dashed text-xs text-muted-foreground">
                    Немає зв'язків між таблицями.
                </div>
            ) : (
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>Статус</TableHead>
                            <TableHead>Дочірнє поле</TableHead>
                            <TableHead className="w-10 text-center">→</TableHead>
                            <TableHead>Батьківське поле</TableHead>
                            <TableHead>Як знайдено</TableHead>
                            <TableHead>Причина</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {references.map((r, i) => (
                            <TableRow key={`${r.childCollection}.${r.childField}-${r.parentCollection}.${r.parentField}-${i}`}>
                                <TableCell>
                                    {r.status === 'create'
                                        ? <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-300">посилання</Badge>
                                        : <Badge variant="outline" className="border-amber-500/30 text-amber-700 dark:text-amber-300">пропустити</Badge>}
                                </TableCell>
                                <TableCell>{r.childCollection}.{r.childField}</TableCell>
                                <TableCell className="text-center text-muted-foreground">→</TableCell>
                                <TableCell>{r.parentCollection}.{r.parentField}</TableCell>
                                <TableCell className="text-muted-foreground">{SOURCE_LABEL[r.source]}</TableCell>
                                <TableCell className={cn('whitespace-normal', r.status === 'skip' && 'text-muted-foreground')}>
                                    {r.status === 'create' ? 'кожне значення знайдено в батьківській колекції' : r.reason}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            )}
        </div>
    )
}

// ---------------------------------------------------------------- indexes

const INDEX_STATUS: Readonly<Record<MongoIndexPlan['status'], { label: string; className: string }>> = {
    create: { label: 'створити', className: 'border-emerald-500/30 text-emerald-700 dark:text-emerald-300' },
    primary: { label: '_id', className: 'border-sky-500/30 text-sky-700 dark:text-sky-300' },
    skip: { label: 'пропустити', className: 'border-amber-500/30 text-amber-700 dark:text-amber-300' },
    excluded: { label: 'вимкнено', className: 'text-muted-foreground' },
}

function IndexTable({ plan, overrides, onTable }: { plan: MongoExportPlan } & PlanEdits) {
    const rows = plan.collections.filter((c) => !c.excluded).flatMap((c) => c.indexes.map((ix) => ({ c, ix })))
    if (rows.length === 0) return null
    const created = rows.filter((r) => r.ix.status === 'create').length

    const toggle = (fileName: string, tag: string, on: boolean) => {
        const current = overrides[fileName]?.excludedIndexes ?? []
        const next = on ? current.filter((t) => t !== tag) : [...current, tag]
        onTable(fileName, { excludedIndexes: next.length > 0 ? next : undefined })
    }

    return (
        <div className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
                Індекси
                <span className="ml-2 font-normal text-muted-foreground">
                    з тегів .CDX і для посилань · буде створено: {created}, не буде: {rows.length - created}
                </span>
            </h3>
            <Table containerClassName="max-h-[50vh]">
                <TableHeader>
                    <TableRow>
                        <TableHead className="w-12 text-center">Вкл.</TableHead>
                        <TableHead>Статус</TableHead>
                        <TableHead>Колекція</TableHead>
                        <TableHead>Звідки</TableHead>
                        <TableHead>Вираз FoxPro</TableHead>
                        <TableHead>Індекс MongoDB</TableHead>
                        <TableHead>Примітка</TableHead>
                    </TableRow>
                </TableHeader>
                <TableBody>
                    {rows.map(({ c, ix }, i) => {
                        const status = INDEX_STATUS[ix.status]
                        const tag = ix.tag
                        const switchable = tag !== null && (ix.status === 'create' || ix.status === 'excluded')
                        return (
                            <TableRow key={`${c.fileName}.${tag ?? ix.name}-${i}`} className={cn(ix.status === 'skip' || ix.status === 'excluded' ? 'text-muted-foreground' : undefined)}>
                                <TableCell className="text-center">
                                    <input
                                        type="checkbox"
                                        className="size-3.5 cursor-pointer accent-primary align-middle disabled:cursor-default"
                                        checked={ix.status === 'create' || ix.status === 'primary'}
                                        disabled={!switchable}
                                        aria-label={`Створити індекс ${tag ?? ix.name} у ${c.collection}`}
                                        onChange={(e) => tag !== null && toggle(c.fileName, tag, e.target.checked)}
                                    />
                                </TableCell>
                                <TableCell><Badge variant="outline" className={status.className}>{status.label}</Badge></TableCell>
                                <TableCell>{c.collection}</TableCell>
                                <TableCell className="font-medium">{tag ? `тег ${tag}` : 'посилання'}</TableCell>
                                <TableCell className="font-mono text-xs">
                                    {ix.expression ?? '—'}
                                    {ix.filter && <span className="text-muted-foreground"> FOR {ix.filter}</span>}
                                </TableCell>
                                <TableCell>
                                    {ix.status === 'create'
                                        ? <>{ix.name} <span className="text-muted-foreground">({ix.keys.join(', ')}){ix.unique && ' унікальний'}</span></>
                                        : ix.keys.length > 0 ? <span className="text-muted-foreground">({ix.keys.join(', ')})</span> : '—'}
                                </TableCell>
                                <TableCell className="whitespace-normal text-muted-foreground">{ix.note ?? ''}</TableCell>
                            </TableRow>
                        )
                    })}
                </TableBody>
            </Table>
        </div>
    )
}
