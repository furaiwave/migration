declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type DbfFieldOffset = Brand<number, 'DbfFieldOffset'>
export type DbfRecordCount = Brand<number, 'DbfrecoerdCount'>
export type DbfFilePath = Brand<string, 'DbfFilePath'>

/** '0' is Visual FoxPro's hidden _NullFlags field; '@' and 'O' are dBASE 7 Timestamp and Double. */
export type DbfFieldTypeCode =
    | 'C' | 'N' | 'F' | 'D' | 'T' | 'L' | 'M'
    | 'B' | 'G' | 'P' | 'Y' | 'I' | 'V' | 'Q' | '+'
    | '0' | '@' | 'O';

export type DbfFieldTypeToTs<T extends DbfFieldTypeCode> =
    T extends 'C' | 'V' | 'M' | 'G' | 'P' ? string :
    T extends 'N' | 'F' | 'B' | 'Y' | 'I' | '+' ? number :
    T extends 'D' | 'T' ? string :
    T extends 'L' ? boolean :
    never;

export interface DbfFieldDescriptor<
    TName extends string = string,
    TType extends DbfFieldTypeCode = DbfFieldTypeCode,
> {
    readonly name: TName
    readonly type: TType
    readonly length: number
    readonly decimalCount: number
    readonly offset: DbfFieldOffset
    /** Visual FoxPro: the field may hold NULL. */
    readonly nullable?: boolean
    /** Visual FoxPro system field (_NullFlags): bookkeeping, not data. */
    readonly system?: boolean
    /** Visual FoxPro: where this field's bits sit in _NullFlags (see addon.ts fieldBytes). */
    readonly nullFlags?: {
        readonly offset: number
        readonly nullBit?: number
        readonly varLengthBit?: number
    }
}

export type InferDbfRecord<T extends readonly DbfFieldDescriptor[]> = {
    [K in T[number] as K['name']]: DbfFieldTypeToTs<K['type']>
}