import { useMemo, useState } from "react";
import { translate } from "@/i18n";
import { Loader2, Search, Trash2 } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { cn } from "@/lib/utils";
import {
  filterRelationships,
  relationshipSymbol,
  RELATIONSHIPS_PER_PAGE,
  type RelationshipFilters,
} from "@/lib/relationships";
import type {
  DbfRelationship,
  GraphRelationship,
  RelationshipConfidence,
  RelationshipKind,
} from "@/api/api.types";

const KIND_META: Record<
  RelationshipKind,
  { label: string; className: string }
> = {
  auto_name: {
    get label() {
      return translate("name match");
    },
    className: "border-sky-500/30 text-sky-700 dark:text-sky-300",
  },
  auto_fk: {
    get label() {
      return translate("foreign key");
    },
    className: "border-amber-500/30 text-amber-700 dark:text-amber-300",
  },
  manual: {
    get label() {
      return translate("manual");
    },
    className: "border-emerald-500/30 text-emerald-700 dark:text-emerald-300",
  },
};

const CONFIDENCE_STYLE: Record<RelationshipConfidence, string> = {
  certain: "text-emerald-700 dark:text-emerald-400",
  high: "text-sky-700 dark:text-sky-400",
  medium: "text-amber-700 dark:text-amber-400",
  low: "text-muted-foreground",
};

const CONFIDENCE_LABEL: Record<RelationshipConfidence, string> = {
  get certain() {
    return translate("certain");
  },
  get high() {
    return translate("high");
  },
  get medium() {
    return translate("medium");
  },
  get low() {
    return translate("low");
  },
};

function relationshipDetail(rel: DbfRelationship): string {
  switch (rel.kind) {
    case "auto_name":
      return rel.matchedOn === "exact_name"
        ? translate("identical field name")
        : translate("normalized names match");
    case "auto_fk":
      return translate("inferred from {0}", [rel.inferredFrom]);
    case "manual":
      return rel.label ?? translate("manually added relationship");
    default: {
      const _never: never = rel;
      return _never;
    }
  }
}

interface RelationshipListProps {
  readonly relationships: readonly GraphRelationship[];
  readonly busyId: string | null;
  readonly disabled?: boolean;
  readonly onToggle: (rel: GraphRelationship, disabled: boolean) => void;
  readonly onDelete: (rel: GraphRelationship) => void;
}

export function RelationshipList({
  relationships,
  busyId,
  disabled = false,
  onToggle,
  onDelete,
}: RelationshipListProps) {
  const [filters, setFilters] = useState<RelationshipFilters>({
    query: "",
    kind: "all",
    state: "all",
    table: "all",
  });
  const [page, setPage] = useState(0);
  const update = (patch: Partial<RelationshipFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(0);
  };
  const tables = useMemo(
    () =>
      [
        ...new Set(
          relationships.flatMap((rel) => [rel.sourceFile, rel.targetFile]),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [relationships],
  );
  const matching = useMemo(
    () => filterRelationships(relationships, filters),
    [relationships, filters],
  );
  const pages = Math.max(
    1,
    Math.ceil(matching.length / RELATIONSHIPS_PER_PAGE),
  );
  const currentPage = Math.min(page, pages - 1);
  const offset = currentPage * RELATIONSHIPS_PER_PAGE;
  const rows = matching.slice(offset, offset + RELATIONSHIPS_PER_PAGE);
  const locked = disabled || busyId !== null;
  if (!relationships.length)
    return (
      <div className="relationship-empty">
        {translate("No relationships found yet. Add one manually below.")}
      </div>
    );
  return (
    <div className="relationship-browser">
      <div className="relationship-toolbar">
        <label className="relationship-search">
          <Search aria-hidden="true" className="size-3.5 shrink-0" />
          <Input
            type="search"
            value={filters.query}
            aria-label={translate("Search relationships")}
            placeholder={translate("Search relationships")}
            onChange={(event) => update({ query: event.target.value })}
          />
        </label>
        <select
          className="relationship-select"
          value={filters.table}
          aria-label={translate("Filter by table")}
          onChange={(event) => update({ table: event.target.value })}
        >
          <option value="all">{translate("All tables")}</option>
          {tables.map((table) => (
            <option key={table} value={table}>
              {table}
            </option>
          ))}
        </select>
        <select
          className="relationship-select"
          value={filters.kind}
          aria-label={translate("Relationship type")}
          onChange={(event) =>
            update({ kind: event.target.value as RelationshipFilters["kind"] })
          }
        >
          <option value="all">{translate("All relationship types")}</option>
          <option value="auto_name">{translate("name match")}</option>
          <option value="auto_fk">{translate("foreign key")}</option>
          <option value="manual">{translate("manual")}</option>
        </select>
        <select
          className="relationship-select"
          value={filters.state}
          aria-label={translate("Relationship state")}
          onChange={(event) =>
            update({
              state: event.target.value as RelationshipFilters["state"],
            })
          }
        >
          <option value="all">{translate("All states")}</option>
          <option value="active">{translate("Active")}</option>
          <option value="disabled">{translate("Disabled")}</option>
        </select>
      </div>
      <p className="text-xs text-muted-foreground" role="status">
        {translate("Showing {0}–{1} of {2} relationships", [
          matching.length ? offset + 1 : 0,
          offset + rows.length,
          matching.length,
        ])}
      </p>
      <div className="relationship-results" aria-busy={locked}>
        {!rows.length && (
          <p className="relationship-empty">
            {translate("No relationships match these filters.")}
          </p>
        )}
        {rows.map(({ relationship: rel, position }) => {
          const meta = KIND_META[rel.kind];
          const busy = busyId === rel.id;
          const symbol = relationshipSymbol(rel.kind);
          return (
            <article
              key={rel.id}
              className={cn("relationship-card", rel.disabled && "is-disabled")}
              data-relationship-id={rel.id}
              data-kind={rel.kind}
            >
              <div className="relationship-card-heading">
                <span className="relationship-number">#{position}</span>
                <label className="relationship-switch">
                  <input
                    type="checkbox"
                    checked={!rel.disabled}
                    disabled={locked}
                    aria-label={translate(
                      rel.kind === "auto_name"
                        ? "Use relationship {0}.{1} ↔ {2}.{3}"
                        : "Use relationship {0}.{1} → {2}.{3}",
                      [
                        rel.sourceFile,
                        rel.sourceField,
                        rel.targetFile,
                        rel.targetField,
                      ],
                    )}
                    onChange={(event) => onToggle(rel, !event.target.checked)}
                  />
                  <span>
                    {rel.disabled ? translate("Disabled") : translate("Active")}
                  </span>
                </label>
                <Badge variant="outline" className={meta.className}>
                  {meta.label}
                </Badge>
                {rel.kind !== "manual" && (
                  <span
                    className={cn(
                      "relationship-confidence",
                      CONFIDENCE_STYLE[rel.confidence],
                    )}
                  >
                    {translate("Confidence")}:{" "}
                    {CONFIDENCE_LABEL[rel.confidence]}
                  </span>
                )}
                {busy && (
                  <Loader2
                    aria-label={translate("Updating relationships…")}
                    className="size-3.5 animate-spin"
                  />
                )}
                {rel.kind === "manual" && (
                  <button
                    type="button"
                    className="relationship-delete"
                    disabled={locked}
                    onClick={() => onDelete(rel)}
                    aria-label={translate("Delete this relationship")}
                    title={translate("Delete this relationship")}
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </div>
              <div className="relationship-endpoints">
                <div className="relationship-endpoint" data-endpoint="source">
                  <span className="relationship-endpoint-label">
                    {translate("Source table")} / {translate("Source field")}
                  </span>
                  <code
                    className="relationship-table-name"
                    title={rel.sourceFile}
                  >
                    {rel.sourceFile}
                  </code>
                  <code className="relationship-field-name">
                    {rel.sourceField}
                  </code>
                </div>
                <span
                  className="relationship-direction"
                  aria-label={
                    rel.kind === "auto_name"
                      ? translate("Matched fields")
                      : translate("Source to target")
                  }
                >
                  {symbol}
                </span>
                <div className="relationship-endpoint" data-endpoint="target">
                  <span className="relationship-endpoint-label">
                    {translate("Target table")} / {translate("Target field")}
                  </span>
                  <code
                    className="relationship-table-name"
                    title={rel.targetFile}
                  >
                    {rel.targetFile}
                  </code>
                  <code className="relationship-field-name">
                    {rel.targetField}
                  </code>
                </div>
              </div>
              <p className="relationship-detail">{relationshipDetail(rel)}</p>
            </article>
          );
        })}
      </div>
      {pages > 1 && (
        <nav
          className="relationship-pagination"
          aria-label={translate("Relationship pages")}
        >
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            {translate("Previous")}
          </Button>
          <span>{translate("Page {0} of {1}", [currentPage + 1, pages])}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={currentPage >= pages - 1}
            onClick={() => setPage(currentPage + 1)}
          >
            {translate("Next")}
          </Button>
        </nav>
      )}
    </div>
  );
}
