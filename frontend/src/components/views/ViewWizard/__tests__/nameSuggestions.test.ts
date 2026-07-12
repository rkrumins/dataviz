import { describe, it, expect } from 'vitest'
import { buildNameSuggestions, deriveRootTypes, type SuggestionEntityType } from '../nameSuggestions'

const types: SuggestionEntityType[] = [
    { id: 'system', name: 'System', pluralName: 'Systems', hierarchy: { level: 0, canContain: ['table'] } },
    { id: 'table', name: 'Table', pluralName: 'Tables', hierarchy: { level: 1, canContain: ['column'] } },
    { id: 'column', name: 'Column', pluralName: 'Columns', hierarchy: { level: 2, canContain: [] } },
]

describe('deriveRootTypes', () => {
    it('prefers explicit level 0 types', () => {
        expect(deriveRootTypes(types).map(t => t.id)).toEqual(['system'])
    })

    it('falls back to types never contained by others', () => {
        const noLevels: SuggestionEntityType[] = [
            { id: 'a', name: 'A', hierarchy: { canContain: ['b'] } },
            { id: 'b', name: 'B', hierarchy: { canContain: [] } },
        ]
        expect(deriveRootTypes(noLevels).map(t => t.id)).toEqual(['a'])
    })

    it('falls back to the first two types when hierarchy is uninformative', () => {
        const flat: SuggestionEntityType[] = [
            { id: 'a', name: 'A', hierarchy: { canContain: ['b'] } },
            { id: 'b', name: 'B', hierarchy: { canContain: ['a'] } },
        ]
        expect(deriveRootTypes(flat).map(t => t.id)).toEqual(['a', 'b'])
        expect(deriveRootTypes([])).toEqual([])
    })
})

describe('buildNameSuggestions', () => {
    it('leads with data source + workspace for existing-data scopes', () => {
        const out = buildNameSuggestions(
            { workspaceName: 'Finance', dataSourceLabel: 'Core DWH' },
            types,
        )
        expect(out[0]).toBe('Core DWH Lineage')
        expect(out[1]).toBe('Finance Overview')
        expect(out).toContain('Systems Landscape')
        expect(out).toContain('System to Table Flow')
        expect(out.length).toBeLessThanOrEqual(6)
    })

    it('uses the ontology (not a data source) for blank scopes', () => {
        const out = buildNameSuggestions(
            { workspaceName: 'Finance', dataSourceLabel: 'Banking', ontologyName: 'Banking', isBlank: true },
            [],
        )
        expect(out[0]).toBe('Finance Overview')
        expect(out).toContain('Banking Model')
        expect(out.every(s => !s.endsWith('Lineage'))).toBe(true)
    })

    it('skips generic fallback labels and dedupes case-insensitively', () => {
        const out = buildNameSuggestions(
            { workspaceName: 'Unknown', dataSourceLabel: 'Data Source' },
            [{ id: 'impact', name: 'Impact Analysis' }],
        )
        expect(out).not.toContain('Data Source Lineage')
        expect(out).not.toContain('Unknown Overview')
        // 'Impact Analysis Landscape' from the root type is distinct, but the
        // evergreen 'Impact Analysis' itself must appear only once.
        expect(out.filter(s => s === 'Impact Analysis')).toHaveLength(1)
    })

    it('still returns evergreen suggestions with no scope at all', () => {
        const out = buildNameSuggestions(undefined, [])
        expect(out).toEqual(['Impact Analysis', 'Source to Target'])
    })
})
