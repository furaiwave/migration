import type { GraphRelationship, RelationshipKind } from "@/api/api.types";

export interface RelationshipFilters {
  query: string;
  kind: "all" | RelationshipKind;
  state: "all" | "active" | "disabled";
  table: string;
}
export const RELATIONSHIPS_PER_PAGE = 50;
export function relationshipSymbol(kind: RelationshipKind): string {
  return kind === "auto_name" ? "↔" : "→";
}
export function filterRelationships(
  relationships: readonly GraphRelationship[],
  filters: RelationshipFilters,
) {
  const query = filters.query.trim().toLowerCase();
  return relationships.flatMap((relationship, index) => {
    if (filters.kind !== "all" && relationship.kind !== filters.kind) return [];
    if (filters.state === "active" && relationship.disabled) return [];
    if (filters.state === "disabled" && !relationship.disabled) return [];
    if (
      filters.table !== "all" &&
      relationship.sourceFile !== filters.table &&
      relationship.targetFile !== filters.table
    )
      return [];
    const detail =
      relationship.kind === "manual"
        ? relationship.label
        : relationship.kind === "auto_fk"
          ? relationship.inferredFrom
          : undefined;
    const text = [
      relationship.sourceFile,
      relationship.sourceField,
      relationship.targetFile,
      relationship.targetField,
      detail,
    ]
      .join(" ")
      .toLowerCase();
    if (query && !text.includes(query)) return [];
    return [{ relationship, position: index + 1 }];
  });
}
