import { useMemo, useState } from "react";
import { Plus, Loader2 } from "lucide-react";
import { Button } from "./ui/button";
import { Label } from "./ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import type { DbfFilePreview, AddManualRelationshipInput } from "@/api/api.types";

interface AddRelationshipFormProps {
    readonly sessionId: string
    readonly files: readonly DbfFilePreview[]
    readonly isPending: boolean
    readonly errorMessage?: string
    readonly onAdd: (input: AddManualRelationshipInput) => void
}

interface Endpoint {
    file: string
    field: string
}

const EMPTY: Endpoint = { file: '', field: '' }

export function AddRelationshipForm({
    sessionId,
    files,
    isPending,
    errorMessage,
    onAdd,
}: AddRelationshipFormProps){
    const[source, setSource] = useState<Endpoint>(EMPTY)
    const[target, setTarget] = useState<Endpoint>(EMPTY)

    const fieldsOf = useMemo(() => {
        const map = new Map<string, readonly string[]>()
        for(const f of files) map.set(f.fileName, f.fieldsNames)
        return map
    }, [files])

    const canSubmit = 
        source.file !== '' &&  source.field !== '' && 
        target.file !== '' && target.field !== '' && 
        !(source.file === target.file && source.field === target.field)

    const submit = () => {
        if(!canSubmit) return
        onAdd({
            sessionId,
            sourceFile: source.file,
            sourceField: source.field,
            targetFile: target.file,
            targetField: source.field
        })
        setSource(EMPTY)
        setTarget(EMPTY)
    }

    const renderPoint = (
        label: string,
        value: Endpoint,
        set: (e: Endpoint) => void
    ) => (
        <div className="flex flex-1 flex-col gap-2">
            <Label className="text-xs text-muted-foreground">{label}</Label>
            <div className="flex gap-2">
                <Select
                    value={value.file}
                    onValueChange={(file) => set({ file: file ?? '', field: '' })}
                >
                    <SelectTrigger className="font-mono">
                        <SelectValue placeholder="Table"/>
                    </SelectTrigger>
                    <SelectContent>
                        {files.map((f) => (
                            <SelectItem key={f.fileName} value={f.fileName} className="font-mono">{f.fileName}</SelectItem>
                        ))}
                    </SelectContent>
                </Select>
                <Select
                    value={value.field}
                    onValueChange={(field) => set({ ...value, field: field ?? '' })}
                    disabled={value.file === ''}
                >
                    <SelectTrigger className="font-mono">
                        <SelectValue placeholder="Field" />
                    </SelectTrigger>
                    <SelectContent>
                        {(fieldsOf.get(value.file) ?? []).map((name) => (<SelectItem key={name} value={name} className="font-mono">{name}</SelectItem>))}
                    </SelectContent>
                </Select>
            </div>
        </div>
    )

    return(
        <div className="flex flex-col gap-3 rounded-md border border-border/50 bg-card/30 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                {renderPoint('Source', source, setSource)}
                <span className="hidden pb-2.5 text-muted-foreground sm:block">→</span>
                {renderPoint('Target', target, setTarget)}
                <Button disabled={!canSubmit || isPending} onClick={submit} className={"sm:mb-0"}>
                    {isPending ? <Loader2 className="animate-spin" /> : <Plus />}
                    Link
                </Button>
            </div>
            {errorMessage && <p className="text-sm text-destructive">{errorMessage}</p>}
        </div>
    )
}