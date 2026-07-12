import type { DbfFileTypeByte } from "./dbf-file-types.types";
import type { DbfFieldDescriptor } from "./dbf-field.types";
import type { DbfHeader } from "./dbf-header.types";

export interface DbfParseResult<
    TTypeByte extends DbfFileTypeByte = DbfFileTypeByte,
    TFields extends readonly DbfFieldDescriptor[] = readonly DbfFieldDescriptor[]
> {
    readonly header: DbfHeader<TTypeByte, TFields>
    readonly preview: ReadonlyArray<Readonly<Record<string, string>>>
    readonly totalRecords: number
}
