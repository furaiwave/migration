import type { Engine } from "@/api/migration.types";

export interface StructureObject {
  schema: string;
  name: string;
  kind: "table" | "view" | "collection" | "keys";
  columns: {
    name: string;
    dataType: string;
    nullable: boolean;
    ordinal: number;
  }[];
}
export interface StructureReport {
  engine: Engine;
  database: string;
  objects: StructureObject[];
  truncated: boolean;
  elapsedMs: number;
}
export interface SchemaTreeNode {
  id: string;
  name: string;
  kind: "database" | "schema" | "column" | StructureObject["kind"];
  dataType?: string;
  nullable?: boolean;
  children: SchemaTreeNode[];
}
export interface VisibleSchemaNode {
  node: SchemaTreeNode;
  level: number;
  parentId?: string;
  position: number;
  siblings: number;
}

export function createSchemaTree(report: StructureReport): SchemaTreeNode {
  const root: SchemaTreeNode = {
    id: JSON.stringify(["database", report.database]),
    name: report.database,
    kind: "database",
    children: [],
  };
  const schemas = new Map<string, SchemaTreeNode>();
  const objects = [...report.objects].sort(
    (a, b) => a.schema.localeCompare(b.schema) || a.name.localeCompare(b.name),
  );
  for (const object of objects) {
    let parent = root;
    // MySQL's selected database is its schema; MongoDB and Redis have no SQL schema level.
    if (
      report.engine === "postgres" ||
      report.engine === "mssql" ||
      (report.engine === "mysql" &&
        object.schema &&
        object.schema !== report.database)
    ) {
      let schema = schemas.get(object.schema);
      if (!schema) {
        schema = {
          id: JSON.stringify(["schema", object.schema]),
          name: object.schema,
          kind: "schema",
          children: [],
        };
        schemas.set(object.schema, schema);
        root.children.push(schema);
      }
      parent = schema;
    }
    parent.children.push({
      id: JSON.stringify(["object", object.schema, object.name]),
      name: object.name,
      kind: object.kind,
      children: [...object.columns]
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((column) => ({
          id: JSON.stringify([
            "column",
            object.schema,
            object.name,
            column.name,
            column.ordinal,
          ]),
          name: column.name,
          kind: "column",
          dataType: column.dataType,
          nullable: column.nullable,
          children: [],
        })),
    });
  }
  return root;
}

export function filterSchemaTree(
  root: SchemaTreeNode,
  query: string,
): SchemaTreeNode | null {
  const term = query.trim().toLowerCase();
  const filter = (node: SchemaTreeNode): SchemaTreeNode | null => {
    if (
      !term ||
      node.name.toLowerCase().includes(term) ||
      node.dataType?.toLowerCase().includes(term)
    )
      return node;
    const children = node.children
      .map(filter)
      .filter((child): child is SchemaTreeNode => child !== null);
    return children.length ? { ...node, children } : null;
  };
  return filter(root);
}

export function visibleSchemaNodes(
  root: SchemaTreeNode | null,
  isExpanded: (id: string) => boolean,
): VisibleSchemaNode[] {
  if (!root) return [];
  const rows: VisibleSchemaNode[] = [];
  const visit = (
    node: SchemaTreeNode,
    level: number,
    position: number,
    siblings: number,
    parentId?: string,
  ) => {
    rows.push({ node, level, parentId, position, siblings });
    if (isExpanded(node.id))
      node.children.forEach((child, index) =>
        visit(child, level + 1, index + 1, node.children.length, node.id),
      );
  };
  visit(root, 1, 1, 1);
  return rows;
}

export function schemaBranchIds(root: SchemaTreeNode): string[] {
  return root.children.length
    ? [root.id, ...root.children.flatMap(schemaBranchIds)]
    : [];
}
