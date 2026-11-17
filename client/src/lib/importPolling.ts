import { ApiError } from "@/client/client";
import { translate } from "@/i18n";
export const isMissingImportJob = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 404;
export const lostImportMessage = (): string =>
  translate(
    "The server no longer has this import status. Check the database before starting again.",
  );
