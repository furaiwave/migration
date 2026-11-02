import { apiRequest, ApiError } from "@/client/client";
import type { ParseMultipleResult } from "@/api/api.types";
import { useApiMutation } from "./useApiMutation";

export interface ParseFilesInput {
    readonly files: readonly File[]
    readonly previewRows?: number
}

async function parseFiles(input: ParseFilesInput): Promise<ParseMultipleResult>{
    const form = new FormData()
    for(const file of input.files) form.append('files', file, file.name)
    if(input.previewRows !== undefined)
        form.append('previewRows', String(input.previewRows))
    return apiRequest('POST /dbf/parse-multiple', { body: form }) 
}

export function useParseFiles() {
    return useApiMutation<ParseFilesInput, ParseMultipleResult, ApiError>(parseFiles)
}