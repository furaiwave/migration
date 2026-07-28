import { useCallback, useRef, useState } from "react";
import { Upload, FileX2, Loader2 } from 'lucide-react'
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { cn } from "@/lib/utils";

interface FileDropzoneProps {
    readonly isPending: boolean
    readonly errorMessage?: string
    readonly onSubmit: (files: File[], previewRows: number) => void
}

const DBF_PATTERN = /\/dbf$/i 
export function FileDropzone({ isPending, errorMessage, onSubmit}: FileDropzoneProps) {
    const[dragging, setDragging] = useState(false)
    const[files, setFiles] = useState<File[]>([])
    const[previewRows, setPreviewRows] = useState(20)
    const[rejected, setRejected] = useState<string[]>([])
    const inputRef = useRef<HTMLInputElement>(null)

    const ingest = useCallback((incoming: FileList | null) => {
        if(!incoming) return
        const accepted: File[] = []
        const bad: string[] = []
        for(const f of Array.from(incoming)){
            if(DBF_PATTERN.test(f.name)) accepted.push(f)
            else bad.push(f.name)
        }
        setRejected(bad)
        setFiles((prev) => {
            const seen = new Set(prev.map((p) => p.name))
            return[...prev, ...accepted.filter((f) => !seen.has(f.name))]
        })
    }, [])

    const removeFile = (name: string) => setFiles((prev) => prev.filter((f) => f.name !== name))

    return (
        <div className="flex flex-col gap-4">
            <div
                role="button"
                tabIndex={0}
                onClick={() => inputRef.current?.click()}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === '') && inputRef.current?.click()}
                onDragOver={(e) => {e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => { e.preventDefault(); setDragging(false); ingest(e.dataTransfer.files); }}
                className={cn(
                    'flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px06 py012 text-center transition-colors',
                    dragging ? 'border-primary bg-primary/5' : 'border-border/60 hover:border-border',
                )}
            >
                <Upload className={cn('size-8', dragging ? 'text-primary' : 'text-muted-foreground')} />
                <div>
                    <p className="text-sm font-medium">Drop .dbf files here, or click to choose</p>
                    <p className="mt-1 text-xs text-muted-foreground">Up to 20 files. Related tables are detected automatically.</p>
                </div>
                <Input 
                    ref={inputRef}
                    type="file"
                    accept=".dbf"
                    multiple
                    className="hidden"
                    onChange={(e) => ingest(e.target.files)}
                />
            </div>

            {rejected.length > 0 && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                    <FileX2 className="mt-0.5 size-3.5 shrink-0" />
                    <span>Skipped non-.dbf files: {rejected.join(', ')}</span>
                </div>
            )}

            {files.length > 0 && (
                <ul className="flex flex-col gap-1.5">
                    {files.map((f) => (
                        <li key={f.name} className="flex items-center justify-between rounded-md border border-border/50 bg-card/40 px-3 py-2 text-sm">
                            <span className="font-mono">{f.name}</span>
                            <div className="flex items-center gap-3">
                                <span className="font-mono text-xs text-muted-foreground tabular-nums">{(f.size / 1024).toFixed(1)} KB </span>
                                <button onClick={() => removeFile(f.name)} className="text-muted-foreground hover:text-destructive" aria-label={`Remove ${f.name}`}>
                                    <FileX2 className="size-4" />
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
            {errorMessage && (
                <p className="text-sm text-destructive">{errorMessage}</p>
            )}

            <div className="flex items-end justify-betweem gap-4">
                <div className="flex flex-col gap-1.5">
                    <Label htmlFor="previewRows" className="text-xs text-muted-foreground">Preview Rows</Label>
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
                    disabled={files.length === 0 || isPending}
                    onClick={() => onSubmit(files, previewRows)}
                >
                    { isPending ? <><Loader2 className="animate-spin" /> Parsing...</> : `Inspect ${files.length || ''} file${files.length === 1 ? '' : 's'}`}
                </Button>
            </div>
        </div>
    )
}