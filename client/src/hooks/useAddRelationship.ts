import { apiRequest, ApiError } from "@/client/client";
import type { AddManualRelationshipInput, DbfRelationshipGraph } from "@/api/api.types";
import { useApiMutation } from "./useApiMutation";

async function addRelationship(
    input: AddManualRelationshipInput
): Promise<DbfRelationshipGraph>{
    return apiRequest('POST /dbf/session/relationship', { body: input })
}

export function useAddRelationshiop(){
    return useApiMutation<AddManualRelationshipInput, DbfRelationshipGraph, ApiError>(
        addRelationship,
    )
}