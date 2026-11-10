import { Injectable } from "@nestjs/common";
import { transliterate } from "../translit";
import type { ParsedFileMap } from "../types/dbf-session.types";
import type { DbfRelationship, AutoNameRelationship, AutoFkRelationship, DbfRelationshipGraph, FileName, GraphRelationship } from "../types/dbf-relationship.types";
import { relationshipId } from "../types/dbf-relationship.types";
import type { DbfFieldDescriptor } from "../types/dbf-field.types";

const KEY_MARKERS = ['code', 'key', 'kod', 'nom', 'id'] as const

// ТАБ_НОМ and TAB_NOM name the same thing.
function normalizeName(s: string): string {
    return transliterate(s).replace(/[_\s-]/g, '')
}

function extractFkTarget(fieldName: string): string | null {
    const name = normalizeName(fieldName)
    for (const marker of KEY_MARKERS) {
        if (name.length <= marker.length) continue
        if (name.endsWith(marker)) return name.slice(0, -marker.length)
        if (name.startsWith(marker)) return name.slice(marker.length)
    }
    return null
}

// NOM/TABNOM/INDKOD remain candidates even when shared by many tables.
// MySQL export still verifies uniqueness and every referenced value.
function isIdentifierName(name: string): boolean {
    return KEY_MARKERS.includes(normalizeName(name) as typeof KEY_MARKERS[number]) ||
        extractFkTarget(name) !== null
}

const UNLINKABLE_TYPES: ReadonlySet<string> = new Set(['M', 'G', 'P', '0'])
const linkable = (field: DbfFieldDescriptor): boolean => !field.system && !UNLINKABLE_TYPES.has(field.type)

function fieldFamily(field: DbfFieldDescriptor): string {
    if (field.type === 'C' || field.type === 'V') return 'text'
    if (field.type === 'I' || field.type === '+' || (field.type === 'N' && field.decimalCount === 0)) return 'integer'
    return field.type
}

const compatible = (a: DbfFieldDescriptor, b: DbfFieldDescriptor): boolean => a.type === b.type || fieldFamily(a) === fieldFamily(b)

function relKey(r: {
    sourceFile: string, sourceField: string
    targetFile: string, targetField: string
}): string {
    return `${r.sourceFile}::${r.sourceField}::${r.targetFile}::${r.targetField}`
}

// Repeated descriptive fields (PRIM, SUMMA, DATE_IZM...) do not identify relationships.
const MAX_TABLES_PER_NAME_MATCH = 4

function reversed<T extends { sourceFile: string, sourceField: string, targetFile: string, targetField: string }>(r: T): T {
    return { ...r, sourceFile: r.targetFile, sourceField: r.targetField, targetFile: r.sourceFile, targetField: r.sourceField }
}

@Injectable()
export class DbfRelationshipService {
    private detectByName(files: ParsedFileMap): AutoNameRelationship[] {
        const results: AutoNameRelationship[] = []
        const entries = [...files.entries()]
        const spread = new Map<string, number>()
        for (const [, result] of entries) {
            const keys = result.header.fields.filter(linkable).map(f => `${normalizeName(f.name)}:${fieldFamily(f)}`)
            for (const key of new Set(keys)) spread.set(key, (spread.get(key) ?? 0) + 1)
        }

        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const [fileA, resultA] = entries[i]!
                const [fileB, resultB] = entries[j]!
                for (const fa of resultA.header.fields) {
                    if (!linkable(fa)) continue
                    if (!isIdentifierName(fa.name) &&
                        (spread.get(`${normalizeName(fa.name)}:${fieldFamily(fa)}`) ?? 0) > MAX_TABLES_PER_NAME_MATCH) continue
                    for (const fb of resultB.header.fields) {
                        if (!linkable(fb) || !compatible(fa, fb) || normalizeName(fa.name) !== normalizeName(fb.name)) continue
                        const exact = fa.name === fb.name
                        results.push({
                            kind: 'auto_name',
                            confidence: exact && fa.type === fb.type ? 'certain' : 'high',
                            sourceFile: fileA, sourceField: fa.name,
                            targetFile: fileB, targetField: fb.name,
                            matchedOn: exact ? 'exact_name' : 'normalized_name',
                        })
                    }
                }
            }
        }
        return results
    }

    private detectByKeyName(files: ParsedFileMap): AutoFkRelationship[] {
        const results: AutoFkRelationship[] = []
        const exact = new Map<string, Set<FileName>>()
        const singular = new Map<string, Set<FileName>>()
        const add = (lookup: Map<string, Set<FileName>>, name: string, file: FileName) => {
            const matches = lookup.get(name) ?? new Set<FileName>()
            matches.add(file)
            lookup.set(name, matches)
        }
        for (const [fileName] of files) {
            const base = fileName.replace(/\.dbf$/i, '')
            add(exact, normalizeName(base), fileName)
            // Singular aliases never replace an exact table name or resolve an ambiguity.
            if (/[sыиі]$/i.test(base)) add(singular, normalizeName(base.slice(0, -1)), fileName)
        }

        for (const [sourceFile, result] of files) {
            for (const field of result.header.fields) {
                if (!linkable(field)) continue
                const targetName = extractFkTarget(field.name)
                if (!targetName) continue
                const matches = exact.get(targetName) ?? singular.get(targetName)
                if (!matches || matches.size !== 1) continue
                const targetFile = [...matches][0]!
                if (targetFile === sourceFile) continue
                const fields = files.get(targetFile)!.header.fields.filter(f => linkable(f) && compatible(field, f))
                const sameName = fields.find(f => normalizeName(f.name) === normalizeName(field.name))
                const equivalent = fields.find(f => extractFkTarget(f.name) === targetName)
                const generic = ['id', 'code', 'kod', 'key', 'nom']
                    .map(name => fields.find(f => normalizeName(f.name) === name)).find(f => f !== undefined)
                const targetField = sameName ?? equivalent ?? generic
                if (!targetField) continue

                results.push({
                    kind: 'auto_fk',
                    confidence: targetField === sameName || targetField === equivalent || normalizeName(targetField.name) === 'id' ? 'high' : 'medium',
                    sourceFile, sourceField: field.name,
                    targetFile, targetField: targetField.name,
                    inferredFrom: field.name,
                })
            }
        }
        return results
    }

    private deduplicate(autoName: AutoNameRelationship[], autoFk: AutoFkRelationship[]): DbfRelationship[] {
        const fkKeys = new Set(autoFk.flatMap(r => [relKey(r), relKey(reversed(r))]))
        return [...autoName.filter(r => !fkKeys.has(relKey(r))), ...autoFk]
    }

    buildGraph(
        files: ParsedFileMap,
        manualRels: readonly DbfRelationship[] = [],
        disabled: ReadonlySet<string> = new Set(),
    ): DbfRelationshipGraph {
        const autoFk = this.detectByKeyName(files)
        const auto = this.deduplicate(this.detectByName(files), autoFk)
        const relationships: readonly GraphRelationship[] = [...auto, ...manualRels].map(r => {
            const id = relationshipId(r)
            return { ...r, id, disabled: disabled.has(id) }
        })

        return {
            relationships,
            stats: {
                autoName: auto.filter(r => r.kind === 'auto_name').length,
                autoFk: autoFk.length,
                manual: manualRels.length,
                total: relationships.length,
                disabled: relationships.filter(r => r.disabled).length,
            }
        }
    }
}
