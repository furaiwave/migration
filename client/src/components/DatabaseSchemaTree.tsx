import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  ChevronRight,
  Columns3,
  Database,
  Eye,
  Folder,
  Layers,
  Search,
  Table2,
  KeyRound,
} from "lucide-react";
import { translate, useLanguage } from "@/i18n";
import {
  createSchemaTree,
  filterSchemaTree,
  schemaBranchIds,
  visibleSchemaNodes,
  type SchemaTreeNode,
  type StructureReport,
  type VisibleSchemaNode,
} from "@/lib/schemaTree";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

function nodeLabel(node: SchemaTreeNode): string {
  switch (node.kind) {
    case "database":
      return translate("Database");
    case "schema":
      return translate("Schema");
    case "table":
      return translate("Table");
    case "view":
      return translate("View");
    case "collection":
      return translate("Collection");
    case "keys":
      return translate("Keys");
    case "column":
      return translate("Column (mapping)");
  }
}
const icons = {
  database: Database,
  schema: Folder,
  table: Table2,
  view: Eye,
  collection: Layers,
  column: Columns3,
  keys: KeyRound,
};

export function DatabaseSchemaTree({ report }: { report: StructureReport }) {
  useLanguage();
  const root = useMemo(() => createSchemaTree(report), [report]);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(
    () =>
      new Set([
        root.id,
        ...root.children
          .filter((node) => node.kind === "schema")
          .map((node) => node.id),
      ]),
  );
  const [searchCollapsed, setSearchCollapsed] = useState<Set<string>>(
    () => new Set(),
  );
  const [focused, setFocused] = useState(root.id);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const searching = !!query.trim();
  const isExpanded = (id: string) =>
    searching ? !searchCollapsed.has(id) : expanded.has(id);
  const filtered = filterSchemaTree(root, query);
  const rows = visibleSchemaNodes(filtered, isExpanded);
  const tabStop = rows.some((row) => row.node.id === focused)
    ? focused
    : rows[0]?.node.id;
  const toggle = (id: string) => {
    const update = (current: Set<string>) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    };
    if (searching) setSearchCollapsed(update);
    else setExpanded(update);
  };
  const focus = (id?: string) => {
    if (!id) return;
    setFocused(id);
    buttons.current.get(id)?.focus();
  };
  const navigate = (
    event: KeyboardEvent<HTMLButtonElement>,
    row: VisibleSchemaNode,
    index: number,
  ) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focus(rows[index + 1]?.node.id);
        break;
      case "ArrowUp":
        event.preventDefault();
        focus(rows[index - 1]?.node.id);
        break;
      case "Home":
        event.preventDefault();
        focus(rows[0]?.node.id);
        break;
      case "End":
        event.preventDefault();
        focus(rows.at(-1)?.node.id);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (row.node.children.length) {
          if (!isExpanded(row.node.id)) toggle(row.node.id);
          else focus(rows[index + 1]?.node.id);
        }
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (row.node.children.length && isExpanded(row.node.id))
          toggle(row.node.id);
        else focus(row.parentId);
        break;
    }
  };
  const expandAll = () => {
    setExpanded(new Set(schemaBranchIds(root)));
    setSearchCollapsed(new Set());
  };
  const collapseAll = () => {
    setExpanded(new Set());
    setSearchCollapsed(new Set(schemaBranchIds(root)));
    setFocused(root.id);
  };
  return (
    <div className="schema-browser" data-database={report.database}>
      <div className="schema-browser-toolbar">
        <label className="schema-browser-search">
          <Search aria-hidden="true" className="size-3.5 shrink-0" />
          <Input
            type="search"
            aria-label={translate("Search schemas, tables and fields")}
            placeholder={translate("Search schemas, tables and fields")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSearchCollapsed(new Set());
            }}
          />
        </label>
        <div className="flex flex-wrap gap-1">
          <Button size="sm" variant="ghost" onClick={expandAll}>
            {translate("Expand all")}
          </Button>
          <Button size="sm" variant="ghost" onClick={collapseAll}>
            {translate("Collapse all")}
          </Button>
        </div>
      </div>
      <div className="schema-browser-scroll">
        {rows.length ? (
          <div
            role="tree"
            aria-label={
              translate("Database structure") + ": " + report.database
            }
          >
            {rows.map((row, index) => {
              const { node, level } = row;
              const branch = node.children.length > 0;
              const open = branch && isExpanded(node.id);
              const Icon = icons[node.kind];
              return (
                <button
                  key={node.id}
                  ref={(element) => {
                    if (element) buttons.current.set(node.id, element);
                    else buttons.current.delete(node.id);
                  }}
                  type="button"
                  role="treeitem"
                  aria-level={level}
                  aria-posinset={row.position}
                  aria-setsize={row.siblings}
                  aria-expanded={branch ? open : undefined}
                  aria-label={
                    (node.name || translate("Default schema")) +
                    ", " +
                    nodeLabel(node) +
                    (node.dataType ? ", " + node.dataType : "") +
                    (node.kind === "column"
                      ? node.nullable
                        ? ", NULL"
                        : ", NOT NULL"
                      : "")
                  }
                  tabIndex={tabStop === node.id ? 0 : -1}
                  className="schema-tree-row"
                  style={{ paddingInlineStart: 8 + (level - 1) * 18 }}
                  data-kind={node.kind}
                  data-name={node.name}
                  title={
                    node.name + (node.dataType ? " · " + node.dataType : "")
                  }
                  onFocus={() => setFocused(node.id)}
                  onClick={() => {
                    setFocused(node.id);
                    if (branch) toggle(node.id);
                  }}
                  onKeyDown={(event) => navigate(event, row, index)}
                >
                  <ChevronRight
                    aria-hidden="true"
                    className={
                      "schema-tree-chevron " +
                      (branch ? (open ? "is-open" : "") : "is-leaf")
                    }
                  />
                  <Icon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="schema-tree-name">
                    {node.name || translate("Default schema")}
                  </span>
                  <span className="schema-tree-type">
                    {node.dataType || nodeLabel(node)}
                  </span>
                  {branch && (
                    <span className="schema-tree-count" aria-hidden="true">
                      {node.children.length}
                    </span>
                  )}
                  {node.kind === "column" && (
                    <span className="schema-tree-null">
                      {node.nullable ? "NULL" : "NOT NULL"}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <p className="p-3 text-xs text-muted-foreground" role="status">
            {translate("No matching objects.")}
          </p>
        )}
      </div>
    </div>
  );
}
