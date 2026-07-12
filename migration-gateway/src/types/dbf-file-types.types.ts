export const DBF_FILE_TYPES = {
    0x02: 'FoxBASE',
    0x03: 'FoxBASEPlus_dBASEIII_noMemo',
    0x30: 'VisualFoxPro',
    0x31: 'VisualFoxzPro_AutoIncrement',
    0x32: 'VisualFoxPro_VarcharVarbinary',
    0x43: 'dBASEIV_SQL_noMemo',
    0x63: 'dBASEIV_SQL_system_noMemo',
    0x83: 'FoxBASEPlus_dBASEIII_withMemo',
    0x8B: 'dBASEIV_SQL_withMemo',
    0xCB: 'dBASEIV_SQL_withMemo',
    0xF5: 'FoxPro2x_withMemo',
    0xE5: 'HiPreSix_SMT',
    0xFB: 'FoxBASE1'
} as const satisfies Record<number, string>

export type DbfFileTypeByte = keyof typeof DBF_FILE_TYPES
export type DbfFileTypeName = (typeof DBF_FILE_TYPES)[DbfFileTypeByte]

export type DbfHasMemo<T extends DbfFileTypeByte> = T extends 0x83 | 0x8B | 0xCB | 0xF5 | 0xE5 ? true : false

export interface DbfTableFlags {
    readonly hasStructuralCdx: boolean
    readonly hasMemoField: boolean
    readonly isDatabase: boolean
}