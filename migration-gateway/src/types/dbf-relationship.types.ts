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

export interface DbfRelationshipGraph {
    readonly relationships: readonly DbfRelationship[]
    readonly stats: {
        readonly autoName: number
        readonly autoFk: number
        readonly manual: number
        readonly total: number
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