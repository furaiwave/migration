import { translate } from '@/i18n';
import { ApiError } from '@/client/client';

// Turn an unknown error into a human sentence in the interface's own voice.
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { message?: string | string[] } | null;
    const msg = body?.message;
    if (Array.isArray(msg)) return msg.join('; ');
    if (typeof msg === 'string') return msg;
    return translate("Запит не вдався ({0}).", [err.status]);
  }
  if (err instanceof Error) return err.message;
  return translate("Щось пішло не так.");
}
