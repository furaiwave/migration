import { useState } from 'react';
import { RelationshipList } from './RelashionshipList';
import { AddRelationshipForm } from './AddRelationshipList';
import { useDeleteRelationship, useToggleRelationship } from '@/hooks/useRelationshipActions';
import { errorMessage } from '@/lib/errors';
import type {
    DbfFilePreview,
    DbfRelationshipGraph,
    AddManualRelationshipInput,
    GraphRelationship,
} from "@/api/api.types";

interface RelationshipsPanelProps {
    readonly sessionId: string;
    readonly files: readonly DbfFilePreview[];
    readonly graph: DbfRelationshipGraph;
    readonly isAdding: boolean;
    readonly addError?: string;
    readonly onAdd: (input: AddManualRelationshipInput) => void;
    /** A toggle or delete came back with the updated graph. */
    readonly onGraphChange: (graph: DbfRelationshipGraph) => void;
}

export function RelationshipsPanel({
  sessionId,
  files,
  graph,
  isAdding,
  addError,
  onAdd,
  onGraphChange,
}: RelationshipsPanelProps) {
  const toggle = useToggleRelationship();
  const remove = useDeleteRelationship();
  const [busyId, setBusyId] = useState<string | null>(null);

  const run = (rel: GraphRelationship, action: Promise<DbfRelationshipGraph>) => {
    setBusyId(rel.id);
    void action
      .then(onGraphChange)
      .catch(() => { /* surfaced via toggle/remove state */ })
      .finally(() => setBusyId(null));
  };

  const actionError =
    toggle.state.status === 'error' ? errorMessage(toggle.state.error)
    : remove.state.status === 'error' ? errorMessage(remove.state.error)
    : undefined;

  const { stats } = graph;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Зв'язки</h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          усього {stats.total} · за назвою {stats.autoName} · зовнішніх ключів {stats.autoFk} · вручну {stats.manual}
          {stats.disabled > 0 && ` · вимкнено ${stats.disabled}`}
        </p>
      </div>
      <RelationshipList
        relationships={graph.relationships}
        busyId={busyId}
        onToggle={(rel, disabled) => run(rel, toggle.mutate({ sessionId, relationshipId: rel.id, disabled }))}
        onDelete={(rel) => run(rel, remove.mutate({ sessionId, relationshipId: rel.id }))}
      />
      {actionError && <p className="text-xs text-destructive">{actionError}</p>}
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
