import { translate, getLanguage } from '@/i18n';
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
const SOURCE_FILE_PATTERN = /\.(dbf|fpt|dbt|cdx)$/i
const TABLE_PATTERN = /\.dbf$/i
const INDEX_PATTERN = /\.cdx$/i

const kindOf = (name: string): string =>
    TABLE_PATTERN.test(name) ? translate("table (subject)") : INDEX_PATTERN.test(name) ? translate("index") : 'memo'
// Matches the server limit; memo and index files do not count as tables.
const MAX_TABLES = 30

const baseName = (name: string): string => name.replace(/\.[^.]+$/, '').toUpperCase()
const extensionOf = (name: string): string => /\.[^.]+$/.exec(name)?.[0].toLowerCase() ?? translate("(no extension)")

function formatSize(bytes: number): string {
    if (bytes < 1024 * 1024) return translate("{0} KB", [(bytes / 1024).toLocaleString(getLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })])
    return translate("{0} MB", [(bytes / 1024 / 1024).toLocaleString(getLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })])
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
    readonly skipped: readonly File[]
    readonly duplicates: readonly string[]
}

export function FileDropzone({ isPending, errorMessage, onSubmit}: FileDropzoneProps) {
    const[dragging, setDragging] = useState(false)
    const[reading, setReading] = useState(false)
    const[files, setFiles] = useState<File[]>([])
    const[previewRows, setPreviewRows] = useState(20)
    const[notice, setNotice] = useState<Notice>({ skipped: [], duplicates: [] })
    const inputRef = useRef<HTMLInputElement>(null)
    const folderRef = useRef<HTMLInputElement>(null)

    const ingest = useCallback((incoming: readonly File[]) => {
        const accepted = incoming.filter((f) => SOURCE_FILE_PATTERN.test(f.name))
        const others = incoming.filter((f) => !SOURCE_FILE_PATTERN.test(f.name))

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
        setNotice({ skipped: others, duplicates })
    }, [files])

    const readDrop = (dataTransfer: DataTransfer) => {
        setReading(true)
        void filesFromDrop(dataTransfer).then(ingest).finally(() => setReading(false))
    }

    // A folder of an old system is full of .cdx/.idx/.txt — summarise by type instead of listing them.
    const byExtension = new Map<string, number>()
    for (const f of notice.skipped) byExtension.set(extensionOf(f.name), (byExtension.get(extensionOf(f.name)) ?? 0) + 1)
    const skipped = notice.skipped.length === 0 ? null
        : translate("Skipped {0} {1}: ", [notice.skipped.length, plural(notice.skipped.length, translate("other file"), translate("other files (few)"), translate("other files (many)"))]) +
          [...byExtension.entries()].sort((a, b) => b[1] - a[1]).map(([ext, n]) => `${ext} ×${n}`).join(', ')

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
                    'workspace-dropzone flex cursor-pointer flex-col items-center justify-center gap-4 border border-dashed px-5 py-10 text-center transition-colors',
                    dragging ? 'border-primary bg-primary/5' : 'border-border/60 hover:border-border',
                )}
            >
                {reading
                    ? <Loader2 className="size-8 animate-spin text-muted-foreground" />
                    : <Upload className={cn('size-8', dragging ? 'text-primary' : 'text-muted-foreground')} />}
                <div>
                    <p className="text-sm font-medium">{translate("Drop a database folder or table files here (with memo and index files), or click to choose files")}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                        {translate("Subfolders are included; other files are skipped. Up to")} {MAX_TABLES} {translate("tables; relationships are detected automatically.")}
                    </p>
                </div>
                <div className="flex flex-wrap justify-center gap-2">
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); inputRef.current?.click() }}
                    >
                        <Upload /> {translate("Choose files")}
                    </Button>
                    <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => { e.stopPropagation(); folderRef.current?.click() }}
                    >
                        <FolderOpen /> {translate("Choose folder")}
                    </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                    {translate("“Choose files” shows table, memo and index files. “Choose folder” shows folders only; their files are added automatically.")}
                </p>
                <input
                    ref={inputRef}
                    type="file"
                    accept=".dbf,.fpt,.dbt,.cdx"
                    aria-label={translate("Choose database files")}
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

            {(skipped || notice.duplicates.length > 0 || orphans.length > 0) && (
                <div className="flex flex-col gap-1 border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                    {skipped && <span>{skipped}.</span>}
                    {notice.duplicates.length > 0 && (
                        <span>
                            {translate("Skipped")} {notice.duplicates.length} {plural(notice.duplicates.length, translate("file"), translate("files (few)"), translate("files (many)"))} {translate("with a name already in the list (tables are matched by name):")} {notice.duplicates.slice(0, 5).join(', ')}{notice.duplicates.length > 5 ? ', …' : ''}
                        </span>
                    )}
                    {orphans.length > 0 && (
                        <span>{translate("Not uploaded — memo/index files without their table:")} {orphans.map((f) => f.name).join(', ')}</span>
                    )}
                </div>
            )}

            {files.length > 0 && (
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-muted-foreground tabular-nums">
                            {tables.length} {plural(tables.length, translate("table (subject)"), translate("tables (few)"), translate("tables (many)"))}
                            {sideFiles > 0 && ` + ${sideFiles} ${plural(sideFiles, translate("memo/index file"), translate("memo/index files (few)"), translate("memo/index files (many)"))}`}
                            {' · '}{formatSize(totalSize)}
                        </span>
                        <Button variant="ghost" size="sm" onClick={() => { setFiles([]); setNotice({ skipped: [], duplicates: [] }) }}>
                            <Trash2 /> {translate("Clear")}
                        </Button>
                    </div>
                    <Table containerClassName="max-h-72">
                        <TableHeader>
                            <TableRow>
                                <TableHead>{translate("File")}</TableHead>
                                <TableHead>{translate("Type")}</TableHead>
                                <TableHead>{translate("Folder")}</TableHead>
                                <TableHead className="text-right">{translate("Size")}</TableHead>
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
                                        <button onClick={() => removeFile(f.name)} className="text-muted-foreground hover:text-destructive" aria-label={translate("Remove {0}", [f.name])}>
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
                <p className="text-sm text-destructive">{translate("Tables:")} {tables.length} {translate("— maximum")} {MAX_TABLES} {translate("per session. Remove some tables or split the folder.")}</p>
            )}
            {errorMessage && (
                <p className="text-sm text-destructive">{errorMessage}</p>
            )}

            <div className="workspace-upload-actions flex flex-wrap items-end justify-between gap-4">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="previewRows" className="text-xs text-muted-foreground">{translate("Preview rows")}</Label>
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
                        ? <><Loader2 className="animate-spin" /> {translate("Uploading and reading…")}</>
                        : tables.length > 0 ? translate("Open {0} {1}", [tables.length, plural(tables.length, translate("table (object)"), translate("tables (few)"), translate("tables (many)"))]) : translate("Open tables")}
                </Button>
            </div>
        </div>
    )
}
