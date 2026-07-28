import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RelationshipList } from './RelashionshipList';
import { AddRelationshipForm } from './AddRelationshipList';
import type {
    DbfFilePreview,
    DbfRelationshipGraph,
    AddManualRelationshipInput,
} from "@/api/api.types";

function StatPill({ label, value }: { label: string; value: number }) {
    return (
        <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-lg tabular-nums text-foreground">{value}</span>
            <span className="text-xs uppercase tracking-wider text-muted-foreground">{label}</span>
        </div>
    );
}

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
  return (
    <Card className="border-border/60">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="font-mono text-sm">Relationships</CardTitle>
          <div className="flex gap-5">
            <StatPill label="name" value={graph.stats.autoName} />
            <StatPill label="fk" value={graph.stats.autoFk} />
            <StatPill label="manual" value={graph.stats.manual} />
            <StatPill label="total" value={graph.stats.total} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <RelationshipList relationships={graph.relationships} />
        <AddRelationshipForm
          sessionId={sessionId}
          files={files}
          isPending={isAdding}
          errorMessage={addError}
          onAdd={onAdd}
        />
      </CardContent>
    </Card>
  );
}