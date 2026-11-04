import { apiRequest, ApiError } from "@/client/client";
import type { DbfRelationshipGraph } from "@/api/api.types";
import { useApiMutation } from "./useApiMutation";

export interface ToggleRelationshipInput {
    readonly sessionId: string
    readonly relationshipId: string
    readonly disabled: boolean
}

export interface DeleteRelationshipInput {
    readonly sessionId: string
    readonly relationshipId: string
}

async function toggleRelationship(input: ToggleRelationshipInput): Promise<DbfRelationshipGraph> {
    return apiRequest('PATCH /dbf/session/:id/relationship/:relId', {
        params: { id: input.sessionId, relId: input.relationshipId },
        body: { disabled: input.disabled },
    })
}

async function deleteRelationship(input: DeleteRelationshipInput): Promise<DbfRelationshipGraph> {
    return apiRequest('DELETE /dbf/session/:id/relationship/:relId', {
        params: { id: input.sessionId, relId: input.relationshipId },
    })
}

/** Switch a link on/off; disabled links are kept in the list but left out of the export. */
export function useToggleRelationship() {
    return useApiMutation<ToggleRelationshipInput, DbfRelationshipGraph, ApiError>(toggleRelationship)
}

/** Remove a link the user added by hand. */
export function useDeleteRelationship() {
    return useApiMutation<DeleteRelationshipInput, DbfRelationshipGraph, ApiError>(deleteRelationship)
}
