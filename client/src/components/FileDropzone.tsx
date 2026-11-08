import { useCallback, useRef, useState } from "react";
import { Upload, FileX2, FolderOpen, Loader2, Trash2 } from 'lucide-react'
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { cn } from "@/lib/utils";
import { plural } from "@/lib/plural";

interface FileDropzoneProps {
    readonly isPending: boolean
    readonly errorMessage?: string
    readonly onSubmit: (files: File[], previewRows: number) => void
}

// Tables plus their memo files (.fpt FoxPro, .dbt dBASE) and index files (.cdx), matched by name on the server.
const DBF_PATTERN = /\.(dbf|fpt|dbt|cdx)$/i
const TABLE_PATTERN = /\.dbf$/i
const INDEX_PATTERN = /\.cdx$/i

const kindOf = (name: string): string =>
    TABLE_PATTERN.test(name) ? 'таблиця' : INDEX_PATTERN.test(name) ? 'індекс' : 'memo'
// Matches the server limit; memo and index files do not count as tables.
const MAX_TABLES = 30

const baseName = (name: string): string => name.replace(/\.[^.]+$/, '').toUpperCase()
const extensionOf = (name: string): string => /\.[^.]+$/.exec(name)?.[0].toLowerCase() ?? '(без розширення)'

function formatSize(bytes: number): string {
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`
    return `${(bytes / 1024 / 1024).toFixed(1)} МБ`
}

/** Every file in a dropped folder, subfolders included. Plain file drops pass straight through. */
async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
    const entries = Array.from(dataTransfer.items)
        .map((item) => item.webkitGetAsEntry?.())
        .filter((e): e is FileSystemEntry => e != null)
    if (entries.length === 0) return Array.from(dataTransfer.files)

    const files: File[] = []
    const walk = async (entry: FileSystemEntry): Promise<void> => {
        if (entry.isFile) {
            files.push(await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject)))
        } else if (entry.isDirectory) {
            const reader = (entry as FileSystemDirectoryEntry).createReader()
            // readEntries hands out a directory in batches (about 100 at a time) until it returns none.
            for (;;) {
                const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
                if (batch.length === 0) break
                for (const child of batch) await walk(child)
            }
        }
    }
    for (const entry of entries) await walk(entry)
    return files
}

interface Notice {
    readonly skipped: string | null
    readonly duplicates: readonly string[]
}

export function FileDropzone({ isPending, errorMessage, onSubmit}: FileDropzoneProps) {
    const[dragging, setDragging] = useState(false)
    const[reading, setReading] = useState(false)
    const[files, setFiles] = useState<File[]>([])
    const[previewRows, setPreviewRows] = useState(20)
    const[notice, setNotice] = useState<Notice>({ skipped: null, duplicates: [] })
    const inputRef = useRef<HTMLInputElement>(null)
    const folderRef = useRef<HTMLInputElement>(null)

    const ingest = useCallback((incoming: readonly File[]) => {
        const accepted = incoming.filter((f) => DBF_PATTERN.test(f.name))
        const others = incoming.filter((f) => !DBF_PATTERN.test(f.name))

        // A folder of an old system is full of .cdx/.idx/.txt — summarise by type instead of listing them.
        const byExtension = new Map<string, number>()
        for (const f of others) byExtension.set(extensionOf(f.name), (byExtension.get(extensionOf(f.name)) ?? 0) + 1)
        const skipped = others.length === 0 ? null
            : `Пропущено ${others.length} ${plural(others.length, 'інший файл', 'інші файли', 'інших файлів')}: ` +
              [...byExtension.entries()].sort((a, b) => b[1] - a[1]).map(([ext, n]) => `${ext} ×${n}`).join(', ')

        const seen = new Set(files.map((p) => p.name.toUpperCase()))
        const duplicates: string[] = []
        const added: File[] = []
        for (const f of accepted) {
            const key = f.name.toUpperCase()
            // Tables are keyed by name on the server; two CLIENTS.DBF from different folders cannot share a session.
            if (seen.has(key)) duplicates.push(f.webkitRelativePath || f.name)
            else {
                seen.add(key)
                added.push(f)
            }
        }
        setFiles([...files, ...added])
        setNotice({ skipped, duplicates })
    }, [files])

    const readDrop = (dataTransfer: DataTransfer) => {
        setReading(true)
        void filesFromDrop(dataTransfer).then(ingest).finally(() => setReading(false))
    }

    const removeFile = (name: string) => setFiles((prev) => prev.filter((f) => f.name !== name))

    const tables = files.filter((f) => TABLE_PATTERN.test(f.name))
    const tableBases = new Set(tables.map((f) => baseName(f.name)))
    // Memo and index files are only useful next to their table; the server would refuse the whole upload otherwise.
    const orphans = files.filter((f) => !TABLE_PATTERN.test(f.name) && !tableBases.has(baseName(f.name)))
    const toSend = files.filter((f) => !orphans.includes(f))
    const sideFiles = toSend.length - tables.length
    const totalSize = toSend.reduce((n, f) => n + f.size, 0)
    const tooMany = tables.length > MAX_TABLES

    return (
        <div className="flex flex-col gap-4">
            <div
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => {
                    if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
                        e.preventDefault()
                        inputRef.current?.click()
                    }
                }}
                onDragOver={(e) => {e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); readDrop(e.dataTransfer); }}
                className={cn(
                    'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors',
                    dragging ? 'border-primary bg-primary/5' : 'border-border/60 hover:border-border',
                )}
            >
                {reading
                    ? <Loader2 className="size-8 animate-spin text-muted-foreground" />
                    : <Upload className={cn('size-8', dragging ? 'text-primary' : 'text-muted-foreground')} />}
                <div>
                    <p className="text-sm font-medium">Перетягніть сюди папку бази даних або файли .dbf (разом із memo-файлами .fpt/.dbt та індексами .cdx) чи натисніть, щоб вибрати файли</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        Вкладені папки теж читаються, інші файли пропускаються. До {MAX_TABLES} таблиць; зв'язки між таблицями визначаються автоматично.
                    </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }}
                    >
                        <Upload /> Вибрати файли
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); folderRef.current?.click() }}
                    >
                        <FolderOpen /> Вибрати папку
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                    «Вибрати файли» показує файли .dbf, .fpt, .dbt та .cdx. У вікні «Вибрати папку» видно лише папки — файли з них буде додано автоматично.
                </p>
                <input
                    ref={inputRef}
                    type="file"
                    accept=".dbf,.fpt,.dbt,.cdx"
                    aria-label="Вибрати файли бази даних"
                    multiple
                    className="hidden"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => { ingest(Array.from(e.target.files ?? [])); e.target.value = '' }}
                />
                <input
                    // webkitdirectory is not in React's prop types; set it on the element instead.
                    ref={(el) => { folderRef.current = el; if (el) el.webkitdirectory = true }}
                    type="file"
                    multiple
                    className="hidden"
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => { ingest(Array.from(e.target.files ?? [])); e.target.value = '' }}
                />
            </div>

            {(notice.skipped || notice.duplicates.length > 0 || orphans.length > 0) && (
                <div className="flex flex-col gap-1 border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                    {notice.skipped && <span>{notice.skipped}.</span>}
                    {notice.duplicates.length > 0 && (
                        <span>
                            Пропущено {notice.duplicates.length} {plural(notice.duplicates.length, 'файл', 'файли', 'файлів')} з назвою, яка вже є в списку
                            (таблиці зіставляються за назвою): {notice.duplicates.slice(0, 5).join(', ')}{notice.duplicates.length > 5 ? ', …' : ''}
                        </span>
                    )}
                    {orphans.length > 0 && (
                        <span>Не надсилаються — memo- та індексні файли без свого .dbf: {orphans.map((f) => f.name).join(', ')}</span>
                    )}
                </div>
            )}

            {files.length > 0 && (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-muted-foreground tabular-nums">
                            {tables.length} {plural(tables.length, 'таблиця', 'таблиці', 'таблиць')}
                            {sideFiles > 0 && ` + ${sideFiles} ${plural(sideFiles, 'memo/індексний файл', 'memo/індексні файли', 'memo/індексних файлів')}`}
                            {' · '}{formatSize(totalSize)}
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => { setFiles([]); setNotice({ skipped: null, duplicates: [] }) }}>
                            <Trash2 /> Очистити
                        </Button>
                    </div>
                    <Table containerClassName="max-h-72">
                        <TableHeader>
                            <TableRow>
                                <TableHead>Файл</TableHead>
                                <TableHead>Тип</TableHead>
                                <TableHead>Папка</TableHead>
                                <TableHead className="text-right">Розмір</TableHead>
                                <TableHead className="w-12" />
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {files.map((f) => (
                                <TableRow key={f.name} className={cn(orphans.includes(f) && 'text-muted-foreground line-through')}>
                                    <TableCell className="font-medium">{f.name}</TableCell>
                                    <TableCell className="text-muted-foreground">{kindOf(f.name)}</TableCell>
                                    <TableCell className="text-muted-foreground">
                                        {f.webkitRelativePath ? f.webkitRelativePath.slice(0, -f.name.length - 1) || '.' : '—'}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">{formatSize(f.size)}</TableCell>
                                    <TableCell className="text-center">
                                        <button onClick={() => removeFile(f.name)} className="text-muted-foreground hover:text-destructive" aria-label={`Прибрати ${f.name}`}>
                                            <FileX2 className="size-3.5" />
                                        </button>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </div>
            )}
            {tooMany && (
                <p className="text-sm text-destructive">Таблиць: {tables.length} — не більше {MAX_TABLES} в одній сесії. Приберіть частину або розділіть папку.</p>
            )}
            {errorMessage && (
                <p className="text-sm text-destructive">{errorMessage}</p>
            )}

            <div className="flex items-end justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="previewRows" className="text-xs text-muted-foreground">Рядків у перегляді</Label>
                    <Input
                        id="previewRows"
                        type="number"
                        min={0}
                        max={500}
                        value={previewRows}
                        onChange={(e) => setPreviewRows(Math.max(0, Math.min(500, Number(e.target.value))))}
                        className="w-28 font-mono tabular-nums"
                    />
                </div>
                <Button
                    disabled={tables.length === 0 || tooMany || isPending}
                    onClick={() => onSubmit(toSend, previewRows)}
                >
                    { isPending
                        ? <><Loader2 className="animate-spin" /> Завантаження й читання…</>
                        : tables.length > 0 ? `Відкрити ${tables.length} ${plural(tables.length, 'таблицю', 'таблиці', 'таблиць')}` : 'Відкрити таблиці'}
                </Button>
            </div>
        </div>
    )
}
