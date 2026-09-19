import { describe, it, expect } from 'vitest'
import {
    deriveRootTypeCandidates,
    layersForRootTypes,
    layersForTopLevelEntities,
    ontologyLooksUngoverned,
} from '../autoLayers'
import type { HierarchyPreviewEntityType } from '../OntologyHierarchyPreview'
import type { ViewLayerConfig } from '@/types/schema'

/** Minimal ontology: Domain contains Platform contains Table. */
const ONTOLOGY: HierarchyPreviewEntityType[] = [
    { id: 'Domain', name: 'Domain', pluralName: 'Domains', visual: { icon: 'Boxes', color: '#111111' }, hierarchy: { level: 0, canContain: ['Platform'] } },
    { id: 'Platform', name: 'Platform', pluralName: 'Platforms', hierarchy: { level: 1, canContain: ['Table'] } },
    { id: 'Table', name: 'Table', pluralName: 'Tables', hierarchy: { level: 2, canContain: [] } },
]

describe('deriveRootTypeCandidates', () => {
    it('offers one candidate per declared root type', () => {
        const candidates = deriveRootTypeCandidates({
            entityTypes: ONTOLOGY,
            rootEntityTypes: ['Domain'],
        })
        expect(candidates).toHaveLength(1)
        expect(candidates[0]).toMatchObject({
            typeId: 'Domain',
            label: 'Domains',
            declaredByOntology: true,
            icon: 'Boxes',
            color: '#111111',
        })
        // Never observed in a scan that was never run.
        expect(candidates[0].observedCount).toBeUndefined()
    })

    it('offers every declared root when the ontology declares several', () => {
        const candidates = deriveRootTypeCandidates({
            entityTypes: [
                ...ONTOLOGY,
                { id: 'Root', name: 'Root', pluralName: 'Roots', hierarchy: { level: 0, canContain: [] } },
            ],
            rootEntityTypes: ['Domain', 'Root'],
        })
        expect(candidates.map(c => c.label)).toEqual(['Domains', 'Roots'])
    })

    it('writes the OBSERVED graph spelling, not the ontology casing', () => {
        // matchesRule compares entity types case-SENSITIVELY, so a layer built
        // from 'Domain' would never match a node labelled 'domain'.
        const candidates = deriveRootTypeCandidates({
            entityTypes: ONTOLOGY,
            rootEntityTypes: ['Domain'],
            observedTopLevel: [{ type: 'domain' }, { type: 'domain' }],
        })
        expect(candidates[0].typeId).toBe('domain')
        expect(candidates[0].observedCount).toBe(2)
        // The label still comes from the ontology, which knows the plural.
        expect(candidates[0].label).toBe('Domains')
    })

    it('keeps the most frequent spelling when the graph holds several', () => {
        const candidates = deriveRootTypeCandidates({
            entityTypes: ONTOLOGY,
            rootEntityTypes: ['Domain'],
            observedTopLevel: [{ type: 'domain' }, { type: 'Domain' }, { type: 'Domain' }],
        })
        expect(candidates[0].typeId).toBe('Domain')
        expect(candidates[0].observedCount).toBe(3)
    })

    it('offers an observed orphan-root type, flagged as not declared', () => {
        const candidates = deriveRootTypeCandidates({
            entityTypes: ONTOLOGY,
            rootEntityTypes: ['Domain'],
            // A Platform ingested without its Domain is structurally a root.
            observedTopLevel: [{ type: 'Domain' }, { type: 'Platform' }],
        })
        expect(candidates.map(c => [c.typeId, c.declaredByOntology])).toEqual([
            ['Domain', true],
            ['Platform', false],
        ])
    })

    it('sorts orphan types by how many were seen, then by name', () => {
        const candidates = deriveRootTypeCandidates({
            entityTypes: ONTOLOGY,
            rootEntityTypes: ['Domain'],
            observedTopLevel: [
                { type: 'Table' },
                { type: 'Platform' }, { type: 'Platform' },
            ],
        })
        expect(candidates.filter(c => !c.declaredByOntology).map(c => c.typeId)).toEqual(['Platform', 'Table'])
    })

    it('marks a type an existing layer already declares', () => {
        const existingLayers = [
            { id: 'l1', name: 'Mine', entityTypes: ['DOMAIN'], order: 0 },
        ] as ViewLayerConfig[]
        const candidates = deriveRootTypeCandidates({
            entityTypes: ONTOLOGY,
            rootEntityTypes: ['Domain'],
            existingLayers,
        })
        expect(candidates[0].coveredByLayerId).toBe('l1')
    })

    it('falls back to level 0 when the ontology declares no roots', () => {
        const candidates = deriveRootTypeCandidates({ entityTypes: ONTOLOGY })
        expect(candidates.map(c => c.typeId)).toEqual(['Domain'])
    })

    it('falls back to canContain-inversion when there are no levels either', () => {
        const noLevels: HierarchyPreviewEntityType[] = [
            { id: 'A', name: 'A', pluralName: 'As', hierarchy: { canContain: ['B'] } },
            { id: 'B', name: 'B', pluralName: 'Bs', hierarchy: { canContain: [] } },
        ]
        // Both carry level 0 implicitly, so tier 2 would return both; tier 2 wins
        // only when SOME type declares level 0 explicitly. Here nothing does, so
        // the shared builder's own precedence decides — A is never contained.
        const candidates = deriveRootTypeCandidates({ entityTypes: noLevels })
        expect(candidates.map(c => c.typeId)).toContain('A')
        expect(candidates.map(c => c.typeId)).not.toContain('B')
    })

    it('returns nothing when there is no usable hierarchy and nothing observed', () => {
        expect(deriveRootTypeCandidates({ entityTypes: [] })).toEqual([])
    })

    it('still offers observed types when the ontology has no spine at all', () => {
        const candidates = deriveRootTypeCandidates({
            entityTypes: [],
            observedTopLevel: [{ type: 'Mystery' }],
        })
        expect(candidates).toEqual([
            { typeId: 'Mystery', label: 'Mystery', observedCount: 1, declaredByOntology: false },
        ])
    })
})

describe('ontologyLooksUngoverned', () => {
    it('is true when every type reports as a root', () => {
        const candidates = deriveRootTypeCandidates({
            entityTypes: ONTOLOGY,
            rootEntityTypes: ['Domain', 'Platform', 'Table'],
        })
        expect(ontologyLooksUngoverned(candidates, ONTOLOGY.length)).toBe(true)
    })

    it('is false for a real hierarchy', () => {
        const candidates = deriveRootTypeCandidates({
            entityTypes: ONTOLOGY,
            rootEntityTypes: ['Domain'],
        })
        expect(ontologyLooksUngoverned(candidates, ONTOLOGY.length)).toBe(false)
    })

    it('is false for a single-type ontology, which is not evidence of anything', () => {
        const one: HierarchyPreviewEntityType[] = [{ id: 'Only', name: 'Only', pluralName: 'Onlys' }]
        const candidates = deriveRootTypeCandidates({ entityTypes: one, rootEntityTypes: ['Only'] })
        expect(ontologyLooksUngoverned(candidates, 1)).toBe(false)
    })
})

describe('layersForRootTypes', () => {
    const candidates = deriveRootTypeCandidates({
        entityTypes: [
            ...ONTOLOGY,
            { id: 'Root', name: 'Root', pluralName: 'Roots', hierarchy: { level: 0, canContain: [] } },
        ],
        rootEntityTypes: ['Domain', 'Root'],
    })

    it('builds one rule-driven layer per candidate', () => {
        const layers = layersForRootTypes(candidates)
        expect(layers).toHaveLength(2)
        expect(layers[0]).toMatchObject({ name: 'Domains', entityTypes: ['Domain'], order: 0, sequence: 0 })
        expect(layers[1]).toMatchObject({ name: 'Roots', entityTypes: ['Root'], order: 1, sequence: 1 })
    })

    it('mints unique layer ids', () => {
        const layers = layersForRootTypes(candidates)
        expect(new Set(layers.map(l => l.id)).size).toBe(layers.length)
    })

    it('continues numbering after existing layers so they survive', () => {
        const layers = layersForRootTypes(candidates, 3)
        expect(layers.map(l => l.order)).toEqual([3, 4])
        expect(layers.map(l => l.sequence)).toEqual([3, 4])
    })

    it("prefers the entity type's own color, falling back to the palette", () => {
        const layers = layersForRootTypes(candidates)
        expect(layers[0].color).toBe('#111111')   // Domain declares one
        expect(layers[1].color).toBeTruthy()      // Root does not — palette
        expect(layers[1].color).not.toBe('#111111')
    })

    it('writes no assignments — placement is the type rule', () => {
        // The shape itself is the assertion: this function returns layers only.
        expect(layersForRootTypes(candidates).every(l => !('entityAssignments' in l))).toBe(true)
    })
})

describe('layersForTopLevelEntities', () => {
    const entities = [
        { urn: 'urn:a', name: 'Finance', type: 'Domain' },
        { urn: 'urn:b', name: 'Risk', type: 'Domain' },
    ]

    it('builds one layer per entity, named after the entity', () => {
        const { layers } = layersForTopLevelEntities(entities)
        expect(layers.map(l => l.name)).toEqual(['Finance', 'Risk'])
        expect(layers.map(l => l.order)).toEqual([0, 1])
        expect(layers.map(l => l.sequence)).toEqual([0, 1])
    })

    it('writes ONE inheriting assignment per entity, so the subtree follows', () => {
        const { layers, assignments } = layersForTopLevelEntities(entities)
        expect(Object.keys(assignments)).toEqual(['urn:a', 'urn:b'])
        expect(assignments['urn:a']).toMatchObject({
            layerId: layers[0].id,
            inheritsChildren: true,
            assignedBy: 'rule',
        })
        expect(assignments['urn:b'].layerId).toBe(layers[1].id)
    })

    it('leaves entityTypes empty so siblings of the same type are not dragged in', () => {
        const { layers } = layersForTopLevelEntities(entities)
        expect(layers.every(l => l.entityTypes.length === 0)).toBe(true)
    })

    it('continues numbering after existing layers', () => {
        const { layers } = layersForTopLevelEntities(entities, 2)
        expect(layers.map(l => l.order)).toEqual([2, 3])
    })

    it('handles an empty selection', () => {
        expect(layersForTopLevelEntities([])).toEqual({ layers: [], assignments: {} })
    })
})
