declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type SessionId = Brand<string, 'SessionId'>
export type FileName = Brand<string, 'FileName'>
export function toSessionId(s: string): SessionId { return s as SessionId }
export function toFileName(s: string): FileName { return s as FileName }
export type RelationshipConfidence = 'certain' | 'high' | 'medium' | 'low' 

export interface AutoNameRelationship {
    readonly kind: 'auto_name'
    readonly confidence: RelationshipConfidence
    readonly sourceFile: FileName
    readonly sourceField: string
    readonly targetFile: FileName
    readonly targetField: string
    readonly matchedOn: 'exact_name' | 'normalized_name'
}

export interface AutoFkRelationship {
    readonly kind: 'auto_fk'
    readonly confidence: RelationshipConfidence
    readonly sourceFile: FileName
    readonly sourceField: string
    readonly targetFile: FileName
    readonly targetField: string
    readonly inferredFrom: string
}

export interface ManualRelationship {
    readonly kind: 'manual'
    readonly sourceFile: FileName
    readonly sourceField: string
    readonly targetFile: FileName
    readonly targetField: string
    readonly label?: string
}

export type DbfRelationship = AutoNameRelationship | AutoFkRelationship | ManualRelationship

export type RelationshipKind = DbfRelationship['kind']

export function exhaustiveRelationshipCheck(r: never): never {
    throw new Error(`Unhandled relationship: ${JSON.stringify(r)}`)
}

/** Stable handle for one relationship; the kind is part of it so a manual link and an auto match stay apart. */
export function relationshipId(r: Pick<DbfRelationship, 'kind' | 'sourceFile' | 'sourceField' | 'targetFile' | 'targetField'>): string {
    return `${r.kind}:${r.sourceFile}.${r.sourceField}->${r.targetFile}.${r.targetField}`
}

/** A relationship as the graph reports it: with its id and whether the user switched it off. */
export type GraphRelationship = DbfRelationship & {
    readonly id: string
    /** Disabled links stay listed but are left out of the MySQL export. */
    readonly disabled: boolean
}

export interface DbfRelationshipGraph {
    readonly relationships: readonly GraphRelationship[]
    readonly stats: {
        readonly autoName: number
        readonly autoFk: number
        readonly manual: number
        readonly total: number
        readonly disabled: number
    }
}

export interface AddManualRelationShipDto {
    readonly sessionId: SessionId
    readonly sourceFile: FileName
    readonly sourceField: string
    readonly targetFile: FileName
    readonly targetField: string
    readonly label?: string
}