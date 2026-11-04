// Remembers the open session so a page reload comes back to it. Per-browser convenience only:
// storage may be unavailable (private mode, blocked site data), and then nothing is remembered.
const KEY = 'dbf-inspector:last-session'

export function rememberSession(id: string | null): void {
    try {
        if (id) localStorage.setItem(KEY, id)
        else localStorage.removeItem(KEY)
    } catch { /* storage unavailable */ }
}

export function lastSession(): string | null {
    try {
        return localStorage.getItem(KEY)
    } catch {
        return null
    }
}
