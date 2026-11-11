import { useState } from "react";
import { cn } from "@/lib/utils";
import { MysqlExportPanel } from "./MysqlExportPanel";
import { MongoExportPanel } from "./MongoExportPanel";
import type { DbfRelationshipGraph } from "@/api/api.types";

type Target = 'mysql' | 'mongo'

const TARGETS: ReadonlyArray<{ value: Target; label: string; description: string }> = [
    { value: 'mysql', label: 'MySQL', description: 'Таблиці з типами й зовнішніми ключами: дамп .sql (CREATE TABLE, INSERT, FOREIGN KEY, utf8mb4) або імпорт напряму.' },
    { value: 'mongo', label: 'MongoDB', description: 'Колекції документів з BSON-типами, _id з первинного ключа й посиланнями між колекціями: скрипт mongosh або імпорт напряму.' },
]

// Per-browser convenience; storage may be unavailable, and then MySQL is shown first.
const KEY = 'dbf-inspector:export-target'

function savedTarget(): Target {
    try {
        return localStorage.getItem(KEY) === 'mongo' ? 'mongo' : 'mysql'
    } catch {
        return 'mysql'
    }
}

interface ExportPanelProps {
    readonly sessionId: string
    readonly graph: DbfRelationshipGraph
}

export function ExportPanel({ sessionId, graph }: ExportPanelProps) {
    const [target, setTarget] = useState<Target>(savedTarget)
    // A panel once opened stays mounted, so switching back keeps its edits and connection.
    const [opened, setOpened] = useState<ReadonlySet<Target>>(() => new Set([target]))

    const choose = (next: Target) => {
        setTarget(next)
        setOpened((s) => new Set(s).add(next))
        try { localStorage.setItem(KEY, next) } catch { /* storage unavailable */ }
    }

    return (
        <section className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-3">
                    <h2 className="text-sm font-semibold">Експорт у</h2>
                    <div role="tablist" className="flex border">
                        {TARGETS.map((t) => (
                            <button
                                key={t.value}
                                role="tab"
                                aria-selected={target === t.value}
                                onClick={() => choose(t.value)}
                                className={cn(
                                    'px-3 py-1 text-xs font-medium transition-colors',
                                    target === t.value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
                                )}
                            >
                                {t.label}
                            </button>
                        ))}
                    </div>
                </div>
                <p className="text-xs text-muted-foreground">{TARGETS.find((t) => t.value === target)?.description}</p>
            </div>
            {opened.has('mysql') && (
                <div className={cn(target !== 'mysql' && 'hidden')}>
                    <MysqlExportPanel sessionId={sessionId} graph={graph} />
                </div>
            )}
            {opened.has('mongo') && (
                <div className={cn(target !== 'mongo' && 'hidden')}>
                    <MongoExportPanel sessionId={sessionId} graph={graph} />
                </div>
            )}
        </section>
    )
}
