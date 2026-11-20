import { translate } from "@/i18n";
import { useEffect, useRef, useState } from "react";
import { RelationshipList } from "./RelashionshipList";
import { AddRelationshipForm } from "./AddRelationshipList";
import {
  useDeleteRelationship,
  useToggleRelationship,
} from "@/hooks/useRelationshipActions";
import { errorMessage } from "@/lib/errors";
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
  readonly onAdd: (input: AddManualRelationshipInput) => Promise<void>;
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

  const updateLock = useRef(false);
  const activeSession = useRef<string | null>(sessionId);
  useEffect(() => {
    activeSession.current = sessionId;
    return () => {
      activeSession.current = null;
    };
  }, [sessionId]);
  const busy = busyId !== null || isAdding;
  const run = (
    rel: GraphRelationship,
    action: () => Promise<DbfRelationshipGraph>,
  ) => {
    if (updateLock.current || isAdding) return;
    updateLock.current = true;
    toggle.reset();
    remove.reset();
    setBusyId(rel.id);
    void action()
      .then((next) => {
        if (activeSession.current === sessionId) onGraphChange(next);
      })
      .catch(() => {
        /* surfaced via toggle/remove state */
      })
      .finally(() => {
        updateLock.current = false;
        setBusyId(null);
      });
  };
  const add = async (input: AddManualRelationshipInput) => {
    if (updateLock.current || isAdding)
      throw new Error("Relationship update already in progress");
    updateLock.current = true;
    toggle.reset();
    remove.reset();
    try {
      await onAdd(input);
    } finally {
      updateLock.current = false;
    }
  };

  const actionError =
    toggle.state.status === "error"
      ? errorMessage(toggle.state.error)
      : remove.state.status === "error"
        ? errorMessage(remove.state.error)
        : undefined;

  const { stats } = graph;
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">{translate("Relationships")}</h2>
        <p className="text-xs text-muted-foreground tabular-nums">
          {translate("total")} {stats.total} {translate("· by name")}{" "}
          {stats.autoName} {translate("· foreign keys")} {stats.autoFk}{" "}
          {translate("· manual")} {stats.manual}
          {stats.disabled > 0 && translate(" · disabled {0}", [stats.disabled])}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          "Name matches and inferred keys are suggestions. The export plan validates references.",
        )}
      </p>
      <RelationshipList
        relationships={graph.relationships}
        busyId={busyId}
        disabled={busy}
        onToggle={(rel, disabled) =>
          run(rel, () =>
            toggle.mutate({ sessionId, relationshipId: rel.id, disabled }),
          )
        }
        onDelete={(rel) =>
          run(rel, () => remove.mutate({ sessionId, relationshipId: rel.id }))
        }
      />
      {actionError && (
        <p role="alert" className="text-xs text-destructive">
          {actionError}
        </p>
      )}
      <AddRelationshipForm
        sessionId={sessionId}
        files={files}
        isPending={isAdding}
        disabled={busy}
        errorMessage={addError}
        onAdd={add}
      />
    </section>
  );
}
