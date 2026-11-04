import { ApiError } from '@/client/client';

// Turn an unknown error into a human sentence in the interface's own voice.
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string | string[] } | null;
    const msg = body?.message;
    if (Array.isArray(msg)) return msg.join('; ');
    if (typeof msg === 'string') return msg;
    return `Запит не вдався (${err.status}).`;
  }
  if (err instanceof Error) return err.message;
  return 'Щось пішло не так.';
}
