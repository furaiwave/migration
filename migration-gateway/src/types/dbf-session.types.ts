import type { SessionId, FileName, DbfRelationship } from "./dbf-relationship.types";
import type { DbfParseResult } from "./dbf-result.types";
import type { MemoFormat } from "../memo";

export type ParsedFileMap = ReadonlyMap<FileName, DbfParseResult>
export interface MemoSource {
    readonly fileName: string
    readonly format: MemoFormat
    readonly buffer: Buffer
}

/** A table's structural index file (CLIENTS.CDX next to CLIENTS.DBF). */
export interface IndexSource {
    readonly fileName: string
    readonly buffer: Buffer
}

/** Raw uploaded bytes, kept so the full table can be exported later. */
export interface DbfSource {
    readonly dbf: Buffer
    readonly memo: MemoSource | null
    readonly index: IndexSource | null
}

export type SourceFileMap = ReadonlyMap<FileName, DbfSource>

export interface DbfSession {
    readonly id: SessionId
    readonly createdAt: Date
    readonly files: ParsedFileMap
    readonly sources: SourceFileMap
    readonly manualRels: readonly DbfRelationship[]
    /** Ids (see relationshipId) of links the user switched off. */
    readonly disabledRels: ReadonlySet<string>
    /** Encodings the user picked per table; tables not listed use the code page mark or detection. */
    readonly encodings: ReadonlyMap<FileName, string>
    /** Preview size chosen at upload, reused when a table is re-read. */
    readonly previewRows: number
}