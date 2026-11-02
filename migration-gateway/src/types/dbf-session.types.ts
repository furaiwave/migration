import type { SessionId, FileName, DbfRelationship } from "./dbf-relationship.types";
import type { DbfParseResult } from "./dbf-result.types";
import type { MemoFormat } from "../memo";

export type ParsedFileMap = ReadonlyMap<FileName, DbfParseResult>
export interface MemoSource {
    readonly fileName: string
    readonly format: MemoFormat
    readonly buffer: Buffer
}

/** Raw uploaded bytes, kept so the full table can be exported later. */
export interface DbfSource {
    readonly dbf: Buffer
    readonly memo: MemoSource | null
}

export type SourceFileMap = ReadonlyMap<FileName, DbfSource>

export interface DbfSession {
    readonly id: SessionId
    readonly createdAt: Date
    readonly files: ParsedFileMap
    readonly sources: SourceFileMap
    readonly manualRels: readonly DbfRelationship[]
}