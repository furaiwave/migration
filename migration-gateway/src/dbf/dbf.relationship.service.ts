import { Injectable } from "@nestjs/common";
import type { ParsedFileMap } from "../types/dbf-session.types";
import type { DbfRelationship, AutoNameRelationship, AutoFkRelationship, DbfRelationshipGraph, FileName } from "../types/dbf-relationship.types";

const FK_SUFFIXES = ['_ID', '_CODE', '_KEY', 'ID', 'KEY'] as const

function extractFkTarget(fieldName: string): string | null {
    const upper = fieldName.toUpperCase()
    for(const suffix of FK_SUFFIXES){
        if(upper.endsWith(suffix) && upper.length > suffix.length)
            return upper.slice(0, upper.length - suffix.length)
    }
    return null
}

function normalizeName(s: string): string {
    return s.toUpperCase().replace(/[_\s-]/g, '')
}

function relKey(r: {
    sourceFile: string, sourceField: string
    targetFile: string, targetField: string
}): string {
    return `${r.sourceFile}::${r.sourceField}::${r.targetFile}::${r.targetField}`
}

@Injectable()
export class DbfRelationshipService {
    private detectByname(files: ParsedFileMap): AutoNameRelationship[]{
        const results: AutoNameRelationship[] = []
        const entries = [...files.entries()]

        for(let i = 0; i < entries.length; i++){
            for(let j = i + 1; j < entries.length; j++){
                const[fileA, resultA] = entries[i]!
                const[fileB, resultB] = entries[j]!

                for(const fa of resultA.header.fields){
                    for(const fb of resultB.header.fields){
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
            if(base.endsWith('S')) lookup.set(base.slice(0, -1), fileName)
        }

        for(const[sourceFile, result] of entries){
            for(const field of result.header.fields){
                const targetName = extractFkTarget(field.name)
                if(!targetName) continue

                const targetFile = lookup.get(targetName) ?? lookup.get(targetName + 'S') ?? null

                if(!targetFile || targetFile === sourceFile) continue
                const targetResult = files.get(targetFile)
                if(!targetResult) continue

                const targetField = targetResult.header.fields.find(f => f.name === 'ID' || f.name === 'CODE' || f.name === 'KEY')

                results.push({
                    kind: 'auto_fk',
                    confidence: targetField?.name === 'ID' ? 'high' : 'medium',
                    sourceFile,
                    sourceField: field.name,
                    targetFile,
                    targetField: targetField?.name ?? 'ID',
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
        const fkKeys = new Set(autoFk.map(relKey))
        const filtered = autoName.filter(r => !fkKeys.has(relKey(r)))
        return [...filtered, ...autoFk]
    }

    buildGraph(
        files: ParsedFileMap,
        manualRels: readonly DbfRelationship[] = []
    ): DbfRelationshipGraph {
        const autoName = this.detectByname(files)
        const autoFk = this.detectByFkSuffix(files)
        const auto = this.dudeplicate(autoName, autoFk)
        const relationships: readonly DbfRelationship[] = [...auto, ...manualRels]

        return {
            relationships,
            stats: {
                autoName: autoName.length,
                autoFk: autoFk.length,
                manual: manualRels.length,
                total: relationships.length
            }
        }
    }
}