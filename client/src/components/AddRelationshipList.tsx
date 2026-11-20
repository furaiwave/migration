import { translate } from "@/i18n";
import { useMemo, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import type {
  DbfFilePreview,
  AddManualRelationshipInput,
} from "@/api/api.types";

interface AddRelationshipFormProps {
  readonly sessionId: string;
  readonly files: readonly DbfFilePreview[];
  readonly isPending: boolean;
  readonly disabled?: boolean;
  readonly errorMessage?: string;
  readonly onAdd: (input: AddManualRelationshipInput) => Promise<void>;
}
interface Endpoint {
  file: string;
  field: string;
}
const EMPTY: Endpoint = { file: "", field: "" };

export function AddRelationshipForm({
  sessionId,
  files,
  isPending,
  disabled = false,
  errorMessage,
  onAdd,
}: AddRelationshipFormProps) {
  const [source, setSource] = useState<Endpoint>(EMPTY);
  const [target, setTarget] = useState<Endpoint>(EMPTY);
  const fieldsOf = useMemo(
    () =>
      new Map<string, readonly string[]>(
        files.map((file) => [file.fileName, file.fieldsNames]),
      ),
    [files],
  );
  const locked = disabled || isPending;
  const canSubmit =
    fieldsOf.get(source.file)?.includes(source.field) &&
    fieldsOf.get(target.file)?.includes(target.field) &&
    !(source.file === target.file && source.field === target.field);
  const submit = () => {
    if (!canSubmit || locked) return;
    void onAdd({
      sessionId,
      sourceFile: source.file,
      sourceField: source.field,
      targetFile: target.file,
      targetField: target.field,
    })
      .then(() => {
        setSource(EMPTY);
        setTarget(EMPTY);
      })
      .catch(() => {
        /* The request error is displayed below; preserve endpoints for a retry. */
      });
  };
  const point = (
    side: "source" | "target",
    value: Endpoint,
    set: (next: Endpoint) => void,
  ) => (
    <fieldset disabled={locked} className="relationship-input-group">
      <legend>
        {side === "source" ? translate("Source") : translate("Target")}
      </legend>
      <label>
        <span>
          {side === "source"
            ? translate("Source table")
            : translate("Target table")}
        </span>
        <select
          className="relationship-select"
          aria-label={
            side === "source"
              ? translate("Source table")
              : translate("Target table")
          }
          value={value.file}
          title={value.file}
          onChange={(event) => set({ file: event.target.value, field: "" })}
        >
          <option value="">{translate("Table")}</option>
          {files.map((file) => (
            <option key={file.fileName} value={file.fileName}>
              {file.fileName}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>
          {side === "source"
            ? translate("Source field")
            : translate("Target field")}
        </span>
        <select
          className="relationship-select"
          aria-label={
            side === "source"
              ? translate("Source field")
              : translate("Target field")
          }
          value={value.field}
          title={value.field}
          disabled={!value.file}
          onChange={(event) => set({ ...value, field: event.target.value })}
        >
          <option value="">{translate("Field")}</option>
          {(fieldsOf.get(value.file) ?? []).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
  return (
    <div className="relationship-add">
      <div className="relationship-add-grid">
        {point("source", source, setSource)}
        <span className="relationship-add-arrow" aria-hidden="true">
          →
        </span>
        {point("target", target, setTarget)}
        <Button disabled={locked || !canSubmit} onClick={submit}>
          {isPending ? <Loader2 className="animate-spin" /> : <Plus />}
          {translate("Link")}
        </Button>
      </div>
      {errorMessage && (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
