import { ApiError } from "@/client/client";
import { translate } from "@/i18n";
export const isMissingImportJob = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;
export const lostImportMessage = (): string =>
  translate(
    "Сервер більше не має статусу цього імпорту. Перевірте стан бази перед повторним запуском.",
  );
