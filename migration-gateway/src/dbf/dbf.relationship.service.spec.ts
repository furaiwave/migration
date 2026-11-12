import { DbfRelationshipService } from './dbf.relationship.service'
import { MysqlExportService } from './mysql-export.service'
import { parseTable } from './dbf-parse'
import { toFileName, toSessionId, relationshipId } from '../types/dbf-relationship.types'
import type { DbfFieldDescriptor, DbfFieldTypeCode } from '../types/dbf-field.types'
import type { DbfParseResult } from '../types/dbf-result.types'
import type { DbfSession, ParsedFileMap } from '../types/dbf-session.types'
import type { MysqlExportOptions } from '../types/mysql-export.types'

function dbf(values: readonly string[]): Buffer {
    const buffer = Buffer.alloc(65 + values.length * 7 + 1, 0)
    buffer[0] = 0x03
    buffer.writeUInt32LE(values.length, 4)
    buffer.writeUInt16LE(65, 8)
    buffer.writeUInt16LE(7, 10)
    buffer.write('NOM', 32, 'ascii')
    buffer[43] = 'C'.charCodeAt(0)
    buffer[48] = 6
    buffer[64] = 0x0d
    values.forEach((value, i) => buffer.write(' ' + value.padEnd(6), 65 + i * 7, 'ascii'))
    buffer[buffer.length - 1] = 0x1a
    return buffer
}

function table(fields: readonly (readonly [string, DbfFieldTypeCode, boolean?])[]): DbfParseResult {
    const parsed = parseTable('test.dbf', dbf([]), null, null, 0, null)
    return {
        ...parsed,
        header: {
            ...parsed.header,
            fields: fields.map(([name, type, system]) => ({
                ...parsed.header.fields[0]!, name, type, system, decimalCount: 0,
            } satisfies DbfFieldDescriptor)),
        },
    }
}

function files(...entries: readonly (readonly [string, DbfParseResult])[]): ParsedFileMap {
    return new Map(entries.map(([name, result]) => [toFileName(name), result]))
}

describe('DbfRelationshipService', () => {
    const service = new DbfRelationshipService()

    it.each(['NOM', 'TABNOM', 'INDKOD', 'CLIENT_ID', 'НОМ'])('keeps shared identifier %s in six tables', name => {
        const inputs = files(...Array.from({ length: 6 }, (_, i) => [`T${i}.DBF`, table([[name, 'C']])] as const))
        expect(service.buildGraph(inputs).stats.autoName).toBe(15)
    })

    it('still limits widespread descriptive fields', () => {
        const inputs = files(...Array.from({ length: 6 }, (_, i) => [`T${i}.DBF`, table([['SUMMA', 'N']])] as const))
        expect(service.buildGraph(inputs).relationships).toHaveLength(0)
    })

    it.each(['CLIENT_ID', 'ID_CLIENT', 'CLIENT_CODE', 'CODE_CLIENT', 'CLIENT_KOD', 'KOD_CLIENT', 'CLIENT_KEY'])(
        'finds the parent of %s', name => {
            const graph = service.buildGraph(files(
                ['ORDERS.DBF', table([[name, 'N']])],
                ['CLIENTS.DBF', table([['ID', 'I']])],
            ))
            expect(graph.relationships).toEqual([expect.objectContaining({
                kind: 'auto_fk', sourceFile: 'ORDERS.DBF', sourceField: name,
                targetFile: 'CLIENTS.DBF', targetField: 'ID',
            })])
        },
    )

    it('normalizes Cyrillic names, case and separators for key lookup', () => {
        const cyrillic = service.buildGraph(files(
            ['ORDERS.DBF', table([['КОД_ОТДЕЛ', 'C']])],
            ['от-делы.dbf', table([['КОД', 'V']])],
        ))
        expect(cyrillic.relationships).toEqual([expect.objectContaining({
            kind: 'auto_fk', targetFile: 'от-делы.dbf', targetField: 'КОД',
        })])
    })

    it('matches compatible storage types and preserves the original field names', () => {
        const graph = service.buildGraph(files(
            ['A.DBF', table([['TAB_NOM', 'C'], ['CLIENT_ID', 'N']])],
            ['B.DBF', table([['табном', 'V'], ['CLIENT_ID', '+']])],
        ))
        expect(graph.stats.autoName).toBe(2)
        expect(graph.relationships[0]).toMatchObject({ sourceField: 'TAB_NOM', targetField: 'табном' })
    })

    it('does not infer keys to incompatible, memo or system fields', () => {
        for (const parent of [table([['ID', 'C']]), table([['ID', 'M']]), table([['ID', 'N', true]])]) {
            expect(service.buildGraph(files(
                ['ORDERS.DBF', table([['CLIENT_ID', 'N']])], ['CLIENTS.DBF', parent],
            )).relationships).toHaveLength(0)
        }
    })

    it('prefers a compatible generic key when the same-named field is incompatible', () => {
        const graph = service.buildGraph(files(
            ['ORDERS.DBF', table([['CLIENT_ID', 'N']])],
            ['CLIENTS.DBF', table([['CLIENT_ID', 'C'], ['ID', 'I']])],
        ))
        expect(graph.relationships).toEqual([expect.objectContaining({ kind: 'auto_fk', targetField: 'ID' })])
    })

    it('prefers the exact table over a plural alias regardless of upload order', () => {
        for (const names of [['CLIENT.DBF', 'CLIENTS.DBF'], ['CLIENTS.DBF', 'CLIENT.DBF']]) {
            const graph = service.buildGraph(files(
                ['ORDERS.DBF', table([['CLIENT_ID', 'N']])],
                ...names.map(name => [name, table([['ID', 'N']])] as const),
            ))
            expect(graph.relationships.filter(r => r.kind === 'auto_fk')).toEqual([
                expect.objectContaining({ targetFile: 'CLIENT.DBF' }),
            ])
        }
    })

    it('does not choose an arbitrary table when normalized names collide', () => {
        const graph = service.buildGraph(files(
            ['ORDERS.DBF', table([['CLIENT_ID', 'N']])],
            ['CLI_ENT.DBF', table([['ID', 'N']])],
            ['CLIENT.DBF', table([['ID', 'N']])],
        ))
        expect(graph.stats.autoFk).toBe(0)
    })

    it('keeps one directional key when a name match describes the same pair', () => {
        const graph = service.buildGraph(files(
            ['CLIENTS.DBF', table([['CLIENT_ID', 'N']])],
            ['ORDERS.DBF', table([['CLIENT_ID', 'N']])],
        ))
        expect(graph.stats).toMatchObject({ autoFk: 1, autoName: 0, total: 1 })
        const id = relationshipId(graph.relationships[0]!)
        expect(service.buildGraph(files(
            ['CLIENTS.DBF', table([['CLIENT_ID', 'N']])],
            ['ORDERS.DBF', table([['CLIENT_ID', 'N']])],
        ), [], new Set([id])).relationships[0]!.disabled).toBe(true)
    })

    it('exports valid NOM references across six tables and rejects orphaned data', () => {
        const rows: readonly (readonly string[])[] = [
            ['1', '2', '3'], ['1', '1', '2'], ['2', '2', '3'],
            ['1', '3', '3'], ['1', '2', '2'], ['1', '9', '9'],
        ]
        const sources = new Map(rows.map((values, i) => [
            toFileName(`T${i}.DBF`), { dbf: dbf(values), memo: null, index: null },
        ]))
        const parsed = new Map([...sources].map(([name, source]) => [
            name, parseTable(name, source.dbf, null, null, 0, null),
        ]))
        const session: DbfSession = {
            id: toSessionId('test'), createdAt: new Date(), files: parsed, sources,
            manualRels: [], disabledRels: new Set(), encodings: new Map(), previewRows: 0,
        }
        const options: MysqlExportOptions = {
            includeData: true, foreignKeys: true, writeMode: 'replace', syncDeletes: false,
            keepDeleted: false, indexes: false, emptyStringsAsNull: true, orphansAsNull: true, overrides: {},
        }
        const graph = service.buildGraph(parsed)
        expect(graph.stats.autoName).toBe(15)
        const plan = new MysqlExportService().plan(session, graph.relationships, options)
        const created = plan.foreignKeys.filter(fk => fk.status === 'create')
        expect(created).toHaveLength(4)
        expect(created.every(fk => fk.parentTable === 't0' && fk.parentColumn === 'nom')).toBe(true)
        expect(created.some(fk => fk.childTable === 't5')).toBe(false)
        expect(plan.foreignKeys.some(fk => fk.childTable === 't5' && fk.status === 'skip')).toBe(true)
    })

    it('links a field named after a table to that table\'s key', () => {
        const graph = service.buildGraph(files(
            ['SOTR.DBF', table([['DOLGN', 'C']])],
            ['DOLGN.DBF', table([['KOD', 'C'], ['NAIM', 'C']])],
        ))
        expect(graph.relationships).toEqual([expect.objectContaining({
            kind: 'auto_fk', confidence: 'medium', sourceField: 'DOLGN', targetFile: 'DOLGN.DBF', targetField: 'KOD',
        })])
    })

    it('does not offer links between generic fields every table has', () => {
        const graph = service.buildGraph(files(
            ['PODR.DBF', table([['KOD', 'N'], ['NAIM', 'C']])],
            ['VIDOPL.DBF', table([['KOD', 'N'], ['NAIM', 'C']])],
        ))
        expect(graph.relationships).toHaveLength(0)
    })
})

/** A dBASE III table of character fields: [name, length] each, rows as text. */
function charTable(fields: readonly (readonly [string, number])[], rows: readonly (readonly string[])[]): Buffer {
    const headerLength = 32 + fields.length * 32 + 1
    const recordLength = 1 + fields.reduce((n, [, len]) => n + len, 0)
    const buffer = Buffer.alloc(headerLength + rows.length * recordLength + 1, 0x20)
    buffer.fill(0, 0, headerLength)
    buffer[0] = 0x03
    buffer.writeUInt32LE(rows.length, 4)
    buffer.writeUInt16LE(headerLength, 8)
    buffer.writeUInt16LE(recordLength, 10)
    fields.forEach(([name, len], i) => {
        buffer.write(name, 32 + i * 32, 'ascii')
        buffer[32 + i * 32 + 11] = 'C'.charCodeAt(0)
        buffer[32 + i * 32 + 16] = len
    })
    buffer[headerLength - 1] = 0x0d
    rows.forEach((row, r) => {
        let at = headerLength + r * recordLength + 1
        row.forEach((value, i) => {
            buffer.write(value, at, 'ascii')
            at += fields[i]![1]
        })
    })
    buffer[buffer.length - 1] = 0x1a
    return buffer
}

describe('MysqlExportService links with values missing from the parent', () => {
    const relationships = new DbfRelationshipService()
    const options: MysqlExportOptions = {
        includeData: true, foreignKeys: true, writeMode: 'replace', syncDeletes: false,
        keepDeleted: false, indexes: false, emptyStringsAsNull: true, orphansAsNull: true, overrides: {},
    }

    // 20 staff; department "0" means "not set" (2 rows) and department 9 was deleted long ago (1 row).
    function session(): DbfSession {
        const staff = Array.from({ length: 20 }, (_, i) => [String(i + 1), i === 3 || i === 7 ? '0' : i === 11 ? '9' : String(i % 3 + 1)])
        const sources = new Map([
            [toFileName('PODR.DBF'), { dbf: charTable([['KOD', 3], ['NAIM', 10]], [['1', 'A'], ['2', 'B'], ['3', 'C']]), memo: null, index: null }],
            [toFileName('SOTR.DBF'), { dbf: charTable([['TAB_NOM', 4], ['KOD_PODR', 3]], staff), memo: null, index: null }],
        ])
        const parsed = new Map([...sources].map(([name, s]) => [name, parseTable(name, s.dbf, null, null, 0, null)]))
        return {
            id: toSessionId('orphans'), createdAt: new Date(), files: parsed, sources,
            manualRels: [], disabledRels: new Set(), encodings: new Map(), previewRows: 0,
        }
    }

    it('creates the key and writes the missing values as NULL, reporting them', () => {
        const s = session()
        const plan = new MysqlExportService().plan(s, relationships.buildGraph(s.files).relationships, options)
        expect(plan.foreignKeys).toEqual([expect.objectContaining({
            childTable: 'sotr', childColumn: 'kod_podr', parentTable: 'podr', parentColumn: 'kod', status: 'create',
            orphans: { values: 2, rows: 3, examples: ['0', '9'] },
        })])
        expect(plan.quality).toEqual([expect.objectContaining({
            table: 'sotr', column: 'kod_podr', effect: 'null', count: 3, examples: ['0', '9'],
        })])
    })

    it('puts NULL in the dump where the parent row is missing, the other values unchanged', async () => {
        const s = session()
        let sql = ''
        for await (const chunk of new MysqlExportService().exportSql(s, relationships.buildGraph(s.files).relationships, options)) sql += chunk
        expect(sql).toContain("('4', NULL)")
        expect(sql).toContain("('12', NULL)")
        expect(sql).toContain("('1', '1')")
        expect(sql).toContain("('2', '2')")
        expect(sql).toMatch(/ADD CONSTRAINT `fk_sotr_kod_podr` FOREIGN KEY \(`kod_podr`\) REFERENCES `podr` \(`kod`\)/)
    })

    it('leaves the link out, saying how to keep it, when the option is off', () => {
        const s = session()
        const plan = new MysqlExportService().plan(s, relationships.buildGraph(s.files).relationships, { ...options, orphansAsNull: false })
        expect(plan.foreignKeys).toEqual([expect.objectContaining({ status: 'skip', reason: expect.stringContaining('Значення без відповідника → NULL') })])
        expect(plan.quality).toHaveLength(0)
    })
})
