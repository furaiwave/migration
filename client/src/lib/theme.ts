import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'dbf-inspector:theme';
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set<() => void>();

function isTheme(value: unknown): value is Theme {
  return value === 'light' || value === 'dark';
}

function savedTheme(): Theme | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return isTheme(saved) ? saved : null;
  } catch { return null; }
}

let preference = savedTheme();
let theme: Theme = preference ?? (darkQuery.matches ? 'dark' : 'light');

function applyTheme(): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  // Native inputs, select menus and scrollbars should follow the chosen theme too.
  document.documentElement.style.colorScheme = theme;
}

function updateTheme(): void {
  const next = preference ?? (darkQuery.matches ? 'dark' : 'light');
  if (next === theme) return;
  theme = next;
  applyTheme();
  listeners.forEach((listener) => listener());
}

// Apply before React renders, including when reopening a saved session.
applyTheme();
darkQuery.addEventListener('change', updateTheme);
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY && event.key !== null) return;
  preference = savedTheme();
  updateTheme();
});

export function setTheme(next: Theme): void {
  if (!isTheme(next)) return;
  preference = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Keep the choice in memory. */ }
  updateTheme();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const getTheme = (): Theme => theme;

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme);
}
