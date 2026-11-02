import type { DbfFileTypeByte } from "./dbf-file-types.types";
import type { DbfFieldDescriptor } from "./dbf-field.types";
import type { DbfHeader } from "./dbf-header.types";

export interface DbfParseResult<
    TTypeByte extends DbfFileTypeByte = DbfFileTypeByte,
    TFields extends readonly DbfFieldDescriptor[] = readonly DbfFieldDescriptor[]
> {
    readonly header: DbfHeader<TTypeByte, TFields>
    readonly preview: ReadonlyArray<Readonly<Record<string, string>>>
    /** Live records, deleted ones excluded (header.recordCount counts them too). */
    readonly totalRecords: number
    readonly encoding: string
    /** Uploaded .fpt/.dbt that holds this table's memo contents. */
    readonly memoFile: string | null
}
