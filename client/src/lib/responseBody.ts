import { LocalizedError } from '@/i18n';

export async function readApiBody(response: Response, download: boolean): Promise<unknown> {
  if (download) return response.blob();
  if ((response.headers.get('content-type') ?? '').toLowerCase().includes('application/json')) {
    try { return await response.json(); } catch { /* A proxy can also return a malformed JSON body. */ }
  }
  throw new LocalizedError('Неочікувана відповідь сервера. Перевірте налаштування API та проксі.');
}
