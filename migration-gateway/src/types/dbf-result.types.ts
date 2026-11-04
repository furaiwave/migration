import type { DbfFileTypeByte } from "./dbf-file-types.types";
import type { DbfFieldDescriptor } from "./dbf-field.types";
import type { DbfHeader } from "./dbf-header.types";
import type { EncodingSource } from "../addon";
import type { CdxTag } from "../cdx";

/** What was read from the table's .CDX. */
export interface DbfIndexInfo {
    readonly fileName: string
    readonly tags: readonly CdxTag[]
    /** Set when the file could not be read; the table itself is still usable. */
    readonly error: string | null
}

export interface DbfParseResult<
    TTypeByte extends DbfFileTypeByte = DbfFileTypeByte,
    TFields extends readonly DbfFieldDescriptor[] = readonly DbfFieldDescriptor[]
> {
    readonly header: DbfHeader<TTypeByte, TFields>
    readonly preview: ReadonlyArray<Readonly<Record<string, string | null>>>
    /** Live records, deleted ones excluded (header.recordCount counts them too). */
    readonly totalRecords: number
    readonly encoding: string
    /** From the code page mark, guessed from the text, or picked by the user. */
    readonly encodingSource: EncodingSource
    /** Uploaded .fpt/.dbt that holds this table's memo contents. */
    readonly memoFile: string | null
    /** Uploaded .cdx with the table's indexes. */
    readonly index: DbfIndexInfo | null
}
