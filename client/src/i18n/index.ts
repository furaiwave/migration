import { useSyncExternalStore } from 'react';
import catalog from './messages.json';

export const LANGUAGES = [
  { code: 'uk', label: 'Українська' },
  { code: 'en', label: 'English' },
  { code: 'fr', label: 'Français' },
  { code: 'es', label: 'Español' },
  { code: 'pl', label: 'Polski' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'de', label: 'Deutsch' },
  { code: 'sv', label: 'Svenska' },
  { code: 'it', label: 'Italiano' },
] as const;

export type Language = (typeof LANGUAGES)[number]['code'];
const STORAGE_KEY = 'dbf-inspector:language';
const listeners = new Set<() => void>();
const messages: Readonly<Record<string, Readonly<Record<Exclude<Language, 'uk'>, string>>>> = catalog;

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some(({ code }) => code === value);
}

function savedLanguage(): Language | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isLanguage(saved) ? saved : null;
  } catch { return null; }
}

function browserLanguage(): Language {
  for (const candidate of navigator.languages ?? [navigator.language]) {
    const code = candidate.toLowerCase().split('-')[0];
    if (isLanguage(code)) return code;
  }
  return 'uk';
}

let language: Language = savedLanguage() ?? browserLanguage();
document.documentElement.lang = language;
export const getLanguage = (): Language => language;

function notify(next: Language): void {
  if (next === language) return;
  language = next;
  document.documentElement.lang = next;
  listeners.forEach((listener) => listener());
}

export function setLanguage(next: Language): void {
  if (!isLanguage(next)) return;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep the choice in memory. */ }
  notify(next);
}

window.addEventListener('storage', (event) => {
  if (event.key === STORAGE_KEY || event.key === null) notify(savedLanguage() ?? browserLanguage());
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage);
}

/** Translate UI messages only; placeholder values are left untouched. */
export function translate(source: string, values: readonly unknown[] = []): string {
  const message = language === 'uk' ? source : messages[source]?.[language] ?? source;
  return message.replace(/\{(\d+)\}/g, (placeholder, number: string) =>
    Number(number) < values.length ? String(values[Number(number)]) : placeholder);
}

/** Resolve the message when it is displayed, even after a language change. */
export class LocalizedError extends Error {
  constructor(source: string, values: readonly unknown[] = [], options?: ErrorOptions) {
    super(source, options);
    Object.defineProperty(this, 'message', { get: () => translate(source, values) });
  }
}
