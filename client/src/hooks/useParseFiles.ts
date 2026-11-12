import { LocalizedError } from '@/i18n';
import { apiRequest } from "@/client/client";
import type { ParseMultipleResult } from "@/api/api.types";
import { useApiMutation } from "./useApiMutation";

export interface ParseFilesInput {
    readonly files: readonly File[]
    readonly previewRows?: number
}

async function parseFiles(input: ParseFilesInput): Promise<ParseMultipleResult>{
    const form = new FormData()
    for (const file of input.files) {
        // A DBF changed/locked by another program can make fetch fail before it reaches the API.
        // Read just one byte so validation does not copy large tables into browser memory.
        try {
            await file.slice(0, 1).arrayBuffer()
        } catch (cause) {
            throw new LocalizedError("Не вдалося прочитати файл «{0}». Він міг змінитися після вибору або бути недоступним. Закрийте програму, яка його змінює, приберіть файл зі списку й виберіть його знову.", [file.name], { cause })
        }
        form.append('files', file, file.name)
    }
    if(input.previewRows !== undefined)
        form.append('previewRows', String(input.previewRows))
    return apiRequest('POST /dbf/parse-multiple', { body: form }) 
}

export function useParseFiles() {
    return useApiMutation<ParseFilesInput, ParseMultipleResult, Error>(parseFiles)
}