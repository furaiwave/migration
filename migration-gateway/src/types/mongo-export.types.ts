import type { DbfFieldTypeCode } from "./dbf-field.types";
import type { RelationshipKind } from "./dbf-relationship.types";
import type { MysqlExportOptions, MysqlQualityIssue, MysqlWriteMode } from "./mysql-export.types";

/**
 * Same options as the MySQL export: names, exclusions, primary key and switched-off .CDX tags carry
 * over; column types do not. foreignKeys = index the fields that reference another collection.
 */
export type MongoExportOptions = MysqlExportOptions

/** How a field's values are stored in BSON. */
export type BsonType = 'string' | 'int' | 'long' | 'decimal' | 'double' | 'date' | 'bool' | 'binData'

export interface MongoFieldPlan {
    readonly dbfField: string
    readonly dbfType: DbfFieldTypeCode
    readonly length: number
    readonly decimals: number
    readonly field: string
    readonly bsonType: BsonType
    /** The value is also the document's _id (the table's primary key). */
    readonly isId: boolean
    readonly excluded: boolean
    readonly note?: string
}

/** One .CDX tag, or one reference, as a MongoDB index. */
export interface MongoIndexPlan {
    /** .CDX tag, or null for an index that serves a reference. */
    readonly tag: string | null
    readonly expression: string | null
    readonly filter: string | null
    readonly name: string
    /** e.g. ["name", "date -1"]. */
    readonly keys: readonly string[]
    readonly unique: boolean
    /** primary: the tag is the _id. excluded: switched off by the user. */
    readonly status: 'create' | 'primary' | 'skip' | 'excluded'
    readonly note?: string
}

export interface MongoCollectionPlan {
    readonly fileName: string
    readonly collection: string
    readonly rowCount: number
    readonly deletedRows: number
    readonly deletedCollection: string | null
    /** Field whose value becomes _id, or null when MongoDB generates ObjectIds. */
    readonly idField: string | null
    /** How sync writes this collection: replaced by _id, or emptied and loaded again. */
    readonly sync: 'upsert' | 'reload'
    readonly indexFile: string | null
    readonly indexes: readonly MongoIndexPlan[]
    readonly encoding: string
    readonly memoFile: string | null
    readonly excluded: boolean
    readonly fields: readonly MongoFieldPlan[]
    readonly skippedFields: readonly string[]
}

/** A relationship as MongoDB keeps it: the child holds the parent's value; $lookup joins them. */
export interface MongoReferencePlan {
    readonly childCollection: string
    readonly childField: string
    readonly parentCollection: string
    /** "_id" when the parent field is the parent's primary key. */
    readonly parentField: string
    readonly source: RelationshipKind
    readonly status: 'create' | 'skip'
    readonly reason?: string
}

export interface MongoExportPlan {
    readonly database: string | null
    readonly collections: readonly MongoCollectionPlan[]
    readonly references: readonly MongoReferencePlan[]
    readonly quality: readonly MysqlQualityIssue[]
    readonly warnings: readonly string[]
}

export interface MongoConnectionInput {
    /** mongodb:// or mongodb+srv:// connection string. */
    readonly uri: string
}

export interface MongoConnectionInfo {
    readonly serverVersion: string
    readonly databases: readonly string[]
}

export interface MongoSyncCounts {
    readonly inserted: number
    readonly updated: number
    readonly unchanged: number
    readonly deleted: number
    readonly reloaded: boolean
}

export interface MongoImportResult {
    readonly database: string
    readonly serverVersion: string
    readonly durationMs: number
    readonly writeMode: MysqlWriteMode
    readonly syncDeletes: boolean
    readonly collections: readonly {
        readonly fileName: string
        readonly collection: string
        readonly role: 'table' | 'deleted'
        readonly expectedRows: number
        readonly importedRows: number
        readonly sync?: MongoSyncCounts
    }[]
    readonly indexesCreated: number
    readonly warnings: readonly string[]
}

export interface MongoImportProgress {
    readonly phase: 'collections' | 'indexes' | 'verifying'
    readonly collectionIndex: number
    readonly collectionCount: number
    readonly collection: string | null
    readonly collectionRowsDone: number
    readonly collectionRows: number
    readonly rowsDone: number
    readonly rowsTotal: number
    readonly indexesDone: number
    readonly indexesTotal: number
    readonly elapsedMs: number
}

export interface MongoImportStatus {
    readonly jobId: string
    readonly state: 'running' | 'done' | 'failed' | 'cancelled'
    readonly database: string
    readonly progress: MongoImportProgress
    readonly result?: MongoImportResult
    readonly error?: string
}
