import { RelationshipList } from './RelashionshipList';
import { AddRelationshipForm } from './AddRelationshipList';
import type {
    DbfFilePreview,
    DbfRelationshipGraph,
    AddManualRelationshipInput,
} from "@/api/api.types";

interface RelationshipsPanelProps {
    readonly sessionId: string;
    readonly files: readonly DbfFilePreview[];
    readonly graph: DbfRelationshipGraph;
    readonly isAdding: boolean;
    readonly addError?: string;
    readonly onAdd: (input: AddManualRelationshipInput) => void;
}

export function RelationshipsPanel({
  sessionId,
  files,
  graph,
  isAdding,
  addError,
  onAdd,
}: RelationshipsPanelProps) {
  const { stats } = graph;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Relationships</h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          {stats.total} total · {stats.autoName} by name · {stats.autoFk} foreign key · {stats.manual} manual
        </p>
      </div>
      <RelationshipList relationships={graph.relationships} />
      <AddRelationshipForm
        sessionId={sessionId}
        files={files}
        isPending={isAdding}
        errorMessage={addError}
        onAdd={onAdd}
      />
    </section>
  );
}
