import type { MysqlImportStatus, MongoImportStatus, ParseMultipleResult, MysqlExportPlan, MongoExportPlan } from '@/api/api.types';
export interface LogEntry { time: string; type: string; source: string; level: 'INFO' | 'DONE' | 'WARNING' | 'ERROR'; message: string }
const KEY = 'dbf-inspector:activity-log';
const LIMIT = 2000;
function load(): LogEntry[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    if (Array.isArray(data)) return data.filter((e): e is LogEntry => e && ['time','type','source','message'].every(k => typeof e[k] === 'string') && ['INFO','DONE','WARNING','ERROR'].includes(e.level)).slice(-LIMIT);
  } catch { /* Storage unavailable. */ }
  return [];
}
let entries = load();
let storageFailed = false;
const listeners = new Set<() => void>();
export const getLog = () => entries;
export const subscribeLog = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const clean = (s: string) => Array.from(s, c => c.charCodeAt(0) < 32 || c === '[' || c === ']' ? ' ' : c).join('');
export const formatLog = (e: LogEntry) => '[' + [e.time, e.type, e.source, e.level + ': ' + e.message].map(clean).join('][') + ']';
function publish() {
  try { localStorage.setItem(KEY, JSON.stringify(entries)); }
  catch {
    if (!storageFailed) {
      storageFailed = true;
      entries = [...entries, { time: new Date().toISOString(), type: 'LOG', source: 'application', level: 'WARNING' as const, message: 'Storage unavailable; download log before closing.' }].slice(-LIMIT);
    }
  }
  listeners.forEach(fn => fn());
}
export function logActivity(type: string, source: string, level: LogEntry['level'], message: string) {
  entries = [...entries, { time: new Date().toISOString(), type, source, level, message }].slice(-LIMIT);
  publish();
}
export function clearLog() { entries = []; publish(); }
export function downloadLog() {
  const url = URL.createObjectURL(new Blob([entries.map(formatLog).join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url;
  a.download = 'migration-' + new Date().toISOString().replace(/[:.]/g, '-') + '.log'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const jobs = new Map<string, string>();
const jobSources = new Map<string, Map<string, string>>();
const sources = new Map<string, Map<string, string>>();
export function observeResult(route: string, data: unknown, sessionId?: string) {
  if (route.endsWith('/export') && sessionId) {
    const type = route.includes('/redis/') ? 'REDIS' : (route.includes('/mysql/') || route.includes('/sql/')) ? 'SQL' : 'JS';
    const map = sources.get(sessionId);
    if (map) for (const source of new Set(map.values())) logActivity(type, source, 'DONE', 'Export received');
  }
  if (!data || typeof data !== 'object') return;
  if (route === 'POST /dbf/parse-multiple') for (const f of (data as ParseMultipleResult).files) {
    logActivity('DBF', f.fileName, 'DONE', 'Read ' + f.totalRecords + ' records; encoding ' + f.encoding);
    if (f.memoFile) logActivity(f.memoFile.split('.').pop()!.toUpperCase(), f.memoFile, 'DONE', 'Memo attached to ' + f.fileName);
    if (f.index) logActivity('CDX', f.index.fileName, f.index.error ? 'WARNING' : 'DONE', f.index.error ?? 'Index read');
  }
  if (route.endsWith('/plan')) {
    const plan = data as MysqlExportPlan & MongoExportPlan;
    const map = new Map<string, string>();
    for (const t of ((plan.tables ?? plan.collections ?? []) as readonly (MysqlExportPlan["tables"][number] | MongoExportPlan["collections"][number])[])) {
      const name = 'table' in t ? t.table : t.collection;
      if (!t.excluded) map.set(name, t.fileName);
      const deleted = 'deletedTable' in t ? t.deletedTable : t.deletedCollection;
      if (deleted && !t.excluded) map.set(deleted, t.fileName);
      logActivity('DBF', t.fileName, t.excluded ? 'WARNING' : 'INFO', t.excluded ? 'Excluded from export' : 'Planned conversion to ' + name);
    }
    if (sessionId) { if (sources.size >= 30) sources.delete(sources.keys().next().value!); sources.set(sessionId, map); }
    for (const w of plan.warnings) logActivity('DBF', sessionId ?? 'plan', 'WARNING', w);
    for (const q of plan.quality) logActivity('DBF', q.fileName, 'WARNING', q.column + ': ' + q.problem + ' (' + q.count + ')');
  }
  if ('jobId' in data) {
    const job = data as MysqlImportStatus | MongoImportStatus;
    const p = job.progress;
    const name = 'table' in p ? p.table : p.collection;
    const rows = 'tableRowsDone' in p ? p.tableRowsDone : p.collectionRowsDone;
    const signature = [job.state, p.phase, name, rows, p.rowsDone].join(':');
    if (jobs.get(job.jobId) === signature) return;
    if (jobs.size >= 100) { const oldest = jobs.keys().next().value!; jobs.delete(oldest); jobSources.delete(oldest); }
    jobs.set(job.jobId, signature);
    if (sessionId && sources.has(sessionId)) jobSources.set(job.jobId, sources.get(sessionId)!);
    const source = (name && jobSources.get(job.jobId)?.get(name)) || name || job.database;
    const type = (route.includes('/mysql/') || route.includes('/sql/')) ? 'SQL' : 'JS';
    logActivity(type, source, job.state === 'done' ? 'DONE' : job.state === 'failed' ? 'ERROR' : job.state === 'cancelled' ? 'WARNING' : 'INFO',
      [job.state, p.phase, name ?? '-', rows + ' records', 'total ' + p.rowsDone + '/' + p.rowsTotal].join('; '));
    if (job.result) {
      const result = job.result as NonNullable<MysqlImportStatus['result']> & NonNullable<MongoImportStatus['result']>;
      for (const t of ((result.tables ?? result.collections ?? []) as readonly (NonNullable<MysqlImportStatus["result"]>["tables"][number] | NonNullable<MongoImportStatus["result"]>["collections"][number])[])) logActivity('DBF', t.fileName, 'DONE', 'Imported into ' + ('table' in t ? t.table : t.collection) + '; ' + t.importedRows + ' records' + ('skippedRows' in t ? '; ' + String(t.skippedRows) + ' skipped' : ''));
      for (const w of result.warnings) logActivity(type, job.database, 'WARNING', w);
    }
    // Detailed database errors can include credentials or source data. The operation panel displays them.
    if (job.error) logActivity(type, source, job.state === 'cancelled' ? 'WARNING' : 'ERROR', 'Import ' + job.state + '; see operation details');
  }
}
