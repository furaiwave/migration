import { Injectable } from "@nestjs/common";
import { transliterate } from "../translit";
import type { ParsedFileMap } from "../types/dbf-session.types";
import type { DbfRelationship, AutoNameRelationship, AutoFkRelationship, DbfRelationshipGraph, FileName, GraphRelationship } from "../types/dbf-relationship.types";
import { relationshipId } from "../types/dbf-relationship.types";
import type { DbfFieldDescriptor } from "../types/dbf-field.types";

const FK_SUFFIXES = ['_ID', '_CODE', '_KEY', 'ID', 'KEY'] as const

function extractFkTarget(fieldName: string): string | null {
    const upper = fieldName.toUpperCase()
    for(const suffix of FK_SUFFIXES){
        if(upper.endsWith(suffix) && upper.length > suffix.length)
            return upper.slice(0, upper.length - suffix.length)
    }
    return null
}

// Memo, picture and system fields (_NullFlags) never hold keys; two NOTES fields are not a link.
const UNLINKABLE_TYPES: ReadonlySet<string> = new Set(['M', 'G', 'P', '0'])
const linkable = (field: DbfFieldDescriptor): boolean => !field.system && !UNLINKABLE_TYPES.has(field.type)

// ТАБ_НОМ and TAB_NOM name the same thing: compare transliterated, without separators.
function normalizeName(s: string): string {
    return transliterate(s).replace(/[_\s-]/g, '')
}

function relKey(r: {
    sourceFile: string, sourceField: string
    targetFile: string, targetField: string
}): string {
    return `${r.sourceFile}::${r.sourceField}::${r.targetFile}::${r.targetField}`
}

/**
 * A field shared by this many tables or more (PRIM, SUMMA, DATE_IZM…) says nothing about how they relate;
 * linking every pair would produce n·(n−1)/2 links. Real keys like CLIENT_ID are still found by suffix.
 */
const MAX_TABLES_PER_NAME_MATCH = 4

function reversed<T extends { sourceFile: string, sourceField: string, targetFile: string, targetField: string }>(r: T): T {
    return { ...r, sourceFile: r.targetFile, sourceField: r.targetField, targetFile: r.sourceFile, targetField: r.sourceField }
}

@Injectable()
export class DbfRelationshipService {
    private detectByname(files: ParsedFileMap): AutoNameRelationship[]{
        const results: AutoNameRelationship[] = []
        const entries = [...files.entries()]

        // How many tables carry each (normalized name, type); too common names are not matched at all.
        const spread = new Map<string, number>()
        for(const [, result] of entries){
            for(const key of new Set(result.header.fields.map(f => `${normalizeName(f.name)}:${f.type}`)))
                spread.set(key, (spread.get(key) ?? 0) + 1)
        }
        const tooCommon = (name: string, type: string) => (spread.get(`${normalizeName(name)}:${type}`) ?? 0) > MAX_TABLES_PER_NAME_MATCH

        for(let i = 0; i < entries.length; i++){
            for(let j = i + 1; j < entries.length; j++){
                const[fileA, resultA] = entries[i]!
                const[fileB, resultB] = entries[j]!

                for(const fa of resultA.header.fields){
                    if(!linkable(fa) || tooCommon(fa.name, fa.type)) continue
                    for(const fb of resultB.header.fields){
                        if(!linkable(fb)) continue
                        if(fa.name === fb.name && fa.type === fb.type){
                            results.push({
                                kind: 'auto_name', confidence: 'certain',
                                sourceFile: fileA, sourceField: fa.name,
                                targetFile: fileB, targetField: fb.name,
                                matchedOn: 'exact_name',
                            })
                        } else if (
                            normalizeName(fa.name) === normalizeName(fb.name) && fa.type === fb.type
                        ) {
                            results.push({
                                kind: 'auto_name', confidence: 'high',
                                sourceFile: fileA, sourceField: fa.name,
                                targetFile: fileB, targetField: fb.name,
                                matchedOn: 'normalized_name'
                            })
                        }
                    }
                }
            }
        }
        return results
    }

    private detectByFkSuffix(files: ParsedFileMap): AutoFkRelationship[] {
        const results: AutoFkRelationship[] = []
        const entries = [...files.entries()]

        const lookup = new Map<string, FileName>()
        for(const[fileName] of entries){
            const base = fileName.replace(/\.dbf$/i, '').toUpperCase()
            lookup.set(base, fileName)
            // Plurals: CLIENTS → CLIENT, ОТДЕЛЫ → ОТДЕЛ, СОТРУДНИКИ → СОТРУДНИК
            if(/[SЫИ]$/.test(base)) lookup.set(base.slice(0, -1), fileName)
        }

        for(const[sourceFile, result] of entries){
            for(const field of result.header.fields){
                if(!linkable(field)) continue
                const targetName = extractFkTarget(field.name)
                if(!targetName) continue

                const targetFile = lookup.get(targetName) ?? lookup.get(targetName + 'S') ?? null

                if(!targetFile || targetFile === sourceFile) continue
                const targetResult = files.get(targetFile)
                if(!targetResult) continue

                // CLIENT_ID points at CLIENTS.CLIENT_ID when that exists, otherwise at CLIENTS.ID / CODE / KEY.
                const sameName = targetResult.header.fields.find(f => f.name === field.name)
                const generic = targetResult.header.fields.find(f => f.name === 'ID' || f.name === 'CODE' || f.name === 'KEY')
                const targetField = sameName ?? generic
                // No candidate column: claiming a link to a field that does not exist only misleads.
                if(!targetField) continue

                results.push({
                    kind: 'auto_fk',
                    confidence: targetField === sameName || targetField.name === 'ID' ? 'high' : 'medium',
                    sourceFile,
                    sourceField: field.name,
                    targetFile,
                    targetField: targetField.name,
                    inferredFrom: field.name
                })
            }
        }

        return results;
    }

    private dudeplicate(
        autoName: AutoNameRelationship[],
        autoFk: AutoFkRelationship[],
    ): DbfRelationship[] {
        // A name match is the same link as a suffix-inferred key in either direction; keep the key, it has the direction.
        const fkKeys = new Set(autoFk.flatMap(r => [relKey(r), relKey(reversed(r))]))
        const filtered = autoName.filter(r => !fkKeys.has(relKey(r)))
        return [...filtered, ...autoFk]
    }

    buildGraph(
        files: ParsedFileMap,
        manualRels: readonly DbfRelationship[] = [],
        disabled: ReadonlySet<string> = new Set(),
    ): DbfRelationshipGraph {
        const autoFk = this.detectByFkSuffix(files)
        const auto = this.dudeplicate(this.detectByname(files), autoFk)
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