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
export const DEFAULT_LANGUAGE: Language = 'en';
// Start existing installations in English too; later explicit language choices remain persistent.
const STORAGE_KEY = 'dbf-inspector:language:v2';
const listeners = new Set<() => void>();
const messages: Readonly<Record<string, Readonly<Record<Language, string>>>> = catalog;

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some(({ code }) => code === value);
}

function savedLanguage(): Language | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isLanguage(saved) ? saved : null;
  } catch { return null; }
}

let language: Language = savedLanguage() ?? DEFAULT_LANGUAGE;
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
  if (event.key === STORAGE_KEY || event.key === null) notify(savedLanguage() ?? DEFAULT_LANGUAGE);
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
  const message = messages[source]?.[language] ?? source;
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
