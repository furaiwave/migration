import { RedisImportPanel } from './RedisImportPanel';
import { activateNativeEngine, getNativeTarget, subscribeNativeTarget } from '@/lib/nativeTarget';
import { useEffect } from 'react';
import { SqlImportPanel } from './SqlImportPanel';
import { translate } from '@/i18n';
import { useState } from "react";
import { cn } from "@/lib/utils";
import { MysqlExportPanel } from "./MysqlExportPanel";
import { MongoExportPanel } from "./MongoExportPanel";
import type { DbfRelationshipGraph } from "@/api/api.types";

type Target = 'mysql' | 'mongo' | 'postgres' | 'mssql' | 'redis'

const TARGETS: ReadonlyArray<{ value: Target; label: string; description: string }> = [
    { value: 'redis', label: 'Redis', description: '' },
    { value: 'postgres', label: 'PostgreSQL', description: '' },
    { value: 'mssql', label: 'MSSQL', description: '' },
    { value: 'mysql', label: 'MySQL', get description() { return translate("Таблиці з типами й зовнішніми ключами: дамп .sql (CREATE TABLE, INSERT, FOREIGN KEY, utf8mb4) або імпорт напряму.") } },
    { value: 'mongo', label: 'MongoDB', get description() { return translate("Колекції документів з BSON-типами, _id з первинного ключа й посиланнями між колекціями: скрипт mongosh або імпорт напряму.") } },
]

// Per-browser convenience; storage may be unavailable, and then MySQL is shown first.
const KEY = 'dbf-inspector:export-target'

function savedTarget(): Target {
    try {
        const value = localStorage.getItem(KEY);
        return TARGETS.some(t => t.value === value) ? value as Target : 'mysql'
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
        activateNativeEngine(next);
        setTarget(next)
        setOpened((s) => new Set(s).add(next))
        try { localStorage.setItem(KEY, next) } catch { /* storage unavailable */ }
    }

    useEffect(() => {
        const update = () => { const next = getNativeTarget().active; if (next) { setTarget(next); setOpened(s => new Set(s).add(next)); } };
        update(); return subscribeNativeTarget(update);
    }, []);

    return (
        <section className="flex flex-col gap-4">
            <div className="workspace-target-heading">
                <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-sm font-semibold">{translate("Експорт у")}</h2>
                    <select aria-label={translate('База даних')} value={target} onChange={e => choose(e.target.value as Target)} className="h-10 min-w-44 border border-input bg-background px-3 text-sm">
                        {TARGETS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </select>
                </div>
                <p className="text-xs text-muted-foreground">{TARGETS.find((t) => t.value === target)?.description}</p>
            </div>
            {opened.has('redis') && <div className={cn(target !== 'redis' && 'hidden')}><RedisImportPanel sessionId={sessionId} graph={graph} /></div>}
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
            {(['postgres', 'mssql'] as const).filter(d => opened.has(d)).map(d => <div key={d} className={cn(target !== d && 'hidden')}><SqlImportPanel dialect={d} sessionId={sessionId} graph={graph} /></div>)}
        </section>
    )
}
