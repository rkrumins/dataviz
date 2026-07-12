/**
 * The containment walk must terminate on the ontologies that actually exist —
 * the Solidatus one has a Node that contains a Node.
 */
import { describe, it, expect } from 'vitest'
import {
    buildHierarchyLevels,
    type HierarchyPreviewEntityType,
    type HierarchyPreviewRelationship,
} from '../OntologyHierarchyPreview'

const SOLIDATUS: HierarchyPreviewEntityType[] = [
    { id: 'Roots', name: 'Roots', hierarchy: { level: 0, canContain: ['Node'] } },
    { id: 'Node', name: 'Node', hierarchy: { level: 1, canContain: ['Node'] } },
]

const HAS: HierarchyPreviewRelationship = {
    id: 'HAS',
    name: 'HAS',
    isContainment: true,
    sourceTypes: ['Roots', 'Node'],
    targetTypes: ['Node'],
}

describe('buildHierarchyLevels', () => {
    it('terminates on a self-containing type and marks it', () => {
        const levels = buildHierarchyLevels(SOLIDATUS, [HAS], ['Roots'], ['HAS'])

        expect(levels).toHaveLength(2)
        expect(levels[0].types.map(t => t.id)).toEqual(['Roots'])
        expect(levels[1].types.map(t => t.id)).toEqual(['Node'])
        expect(levels[0].types[0].selfNesting).toBe(false)
        expect(levels[1].types[0].selfNesting).toBe(true)
        expect(levels[1].viaLabel).toBe('HAS')
    })

    it('walks a linear chain', () => {
        const types: HierarchyPreviewEntityType[] = [
            { id: 'system', name: 'System', hierarchy: { level: 0, canContain: ['table'] } },
            { id: 'table', name: 'Table', hierarchy: { level: 1, canContain: ['column'] } },
            { id: 'column', name: 'Column', hierarchy: { level: 2, canContain: [] } },
        ]
        const levels = buildHierarchyLevels(types, [], [], ['CONTAINS'])

        expect(levels.map(l => l.types.map(t => t.id))).toEqual([['system'], ['table'], ['column']])
        // Single containment edge type is used when no relationship matches.
        expect(levels[1].viaLabel).toBe('CONTAINS')
    })

    it('terminates on a mutual cycle instead of looping forever', () => {
        const types: HierarchyPreviewEntityType[] = [
            { id: 'a', name: 'A', hierarchy: { canContain: ['b'] } },
            { id: 'b', name: 'B', hierarchy: { canContain: ['a'] } },
        ]
        const levels = buildHierarchyLevels(types, [], [], [])

        // 'a' is the structural root (never contained… by anything but 'b', which
        // 'a' contains) — whatever the roots resolve to, each type is placed once.
        expect(levels.length).toBeLessThanOrEqual(2)
        const placed = levels.flatMap(l => l.types.map(t => t.id))
        expect(new Set(placed).size).toBe(placed.length)
    })

    it('reports a single level when nothing contains anything', () => {
        const types: HierarchyPreviewEntityType[] = [
            { id: 'a', name: 'A', hierarchy: { canContain: [] } },
            { id: 'b', name: 'B', hierarchy: { canContain: [] } },
        ]
        const levels = buildHierarchyLevels(types, [], [], [])

        expect(levels).toHaveLength(1)
        expect(levels[0].types.map(t => t.id)).toEqual(['a', 'b'])
    })

    it('prefers the schema roots, then level 0, then never-contained', () => {
        // Schema roots win outright.
        expect(buildHierarchyLevels(SOLIDATUS, [HAS], ['Node'], ['HAS'])[0].types[0].id).toBe('Node')

        // No schema roots → explicit level 0.
        expect(buildHierarchyLevels(SOLIDATUS, [HAS], [], ['HAS'])[0].types[0].id).toBe('Roots')

        // No levels either → types nothing else contains.
        const noLevels: HierarchyPreviewEntityType[] = [
            { id: 'top', name: 'Top', hierarchy: { canContain: ['leaf'] } },
            { id: 'leaf', name: 'Leaf', hierarchy: { canContain: [] } },
        ]
        expect(buildHierarchyLevels(noLevels, [], [], [])[0].types[0].id).toBe('top')
    })

    it('ignores canContain ids that are not real types', () => {
        const types: HierarchyPreviewEntityType[] = [
            { id: 'a', name: 'A', hierarchy: { level: 0, canContain: ['ghost'] } },
        ]
        const levels = buildHierarchyLevels(types, [], [], [])

        expect(levels).toHaveLength(1)
        expect(levels[0].types.map(t => t.id)).toEqual(['a'])
    })

    it('returns nothing for an empty ontology', () => {
        expect(buildHierarchyLevels([], [], [], [])).toEqual([])
    })
})
