declare const __brand: unique symbol
type Brand<T, B extends string> = T & { readonly [__brand]: B }

export type DbfFieldOffset = Brand<number, 'DbfFieldOffset'>
export type DbfRecordCount = Brand<number, 'DbfrecoerdCount'>
export type DbfFilePath = Brand<string, 'DbfFilePath'>

export type DbfFieldTypeCode =
    | 'C' | 'N' | 'F' | 'D' | 'T' | 'L' | 'M'
    | 'B' | 'G' | 'P' | 'Y' | 'I' | 'I' | 'V' | 'Q' | '+';

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
}

export type InferDbfRecord<T extends readonly DbfFieldDescriptor[]> = {
    [K in T[number] as K['name']]: DbfFieldTypeToTs<K['type']>
}