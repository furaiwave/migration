import type { DbfFileTypeByte, DbfFileTypeName, DbfHasMemo, DbfTableFlags } from "./dbf-file-types.types";
import type { DbfFieldDescriptor, DbfRecordCount } from "./dbf-field.types";

export interface DbfLastUpdate { 
    readonly year: number
    readonly month: number
    readonly day: number
}

export interface DbfHeader<
    TTypeByte extends DbfFileTypeByte = DbfFileTypeByte,
    TFields extends readonly DbfFieldDescriptor[] = readonly DbfFieldDescriptor[]
> {
    readonly typeByte: TTypeByte
    readonly typeName: DbfFileTypeName
    readonly hasMemo: DbfHasMemo<TTypeByte>
    readonly lastUpdate: DbfLastUpdate
    readonly recordCount: DbfRecordCount
    readonly firstRecordOffset: number
    readonly recordLength: number
    readonly tableFlags: DbfTableFlags
    readonly codePage: number
    readonly fields: TFields
}