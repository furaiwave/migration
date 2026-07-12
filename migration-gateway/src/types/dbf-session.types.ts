import type { SessionId, FileName, DbfRelationship } from "./dbf-relationship.types";
import type { DbfParseResult } from "./dbf-result.types";

export type ParsedFileMap = ReadonlyMap<FileName, DbfParseResult>

export interface DbfSession {
    readonly id: SessionId
    readonly createdAt: Date
    readonly files: ParsedFileMap
    readonly manualRels: readonly DbfRelationship[]
}