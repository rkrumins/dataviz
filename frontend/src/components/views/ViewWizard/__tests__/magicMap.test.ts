/**
 * magicMap — the matcher must be generous enough to catch the real-world case
 * (a root literally named like the layer) and conservative enough that it never
 * bulk-places entities on a guess.
 */
import { describe, expect, it } from 'vitest'
import { suggestLayerMappings, normalizeTokens } from '../magicMap'

const layers = [
    { id: 'l-src', name: 'Source', entityTypes: [] },
    { id: 'l-stg', name: 'Staging', entityTypes: [] },
    { id: 'l-wh', name: 'Warehouse', entityTypes: [] },
]

describe('normalizeTokens', () => {
    it('splits camelCase, separators, and singularizes', () => {
        expect(normalizeTokens('StagingArea_v2')).toEqual(['staging', 'area', 'v2'])
        expect(normalizeTokens('staging-area')).toEqual(['staging', 'area'])
        expect(normalizeTokens('Applications')).toEqual(['application'])
    })
})

describe('suggestLayerMappings', () => {
    it('matches an exact name with high confidence', () => {
        const [s] = suggestLayerMappings(
            [{ urn: 'urn:1', name: 'Staging', type: 'Roots' }],
            layers,
        )
        expect(s).toMatchObject({ urn: 'urn:1', layerId: 'l-stg', confidence: 'high' })
    })

    it('matches case/separator variants ("staging_area" → Staging)', () => {
        const [s] = suggestLayerMappings(
            [{ urn: 'urn:1', name: 'staging_area', type: 'Roots' }],
            layers,
        )
        expect(s).toMatchObject({ layerId: 'l-stg', confidence: 'high' })
    })

    it('singularizes ("Warehouses" → Warehouse)', () => {
        const [s] = suggestLayerMappings(
            [{ urn: 'urn:1', name: 'Warehouses', type: 'Roots' }],
            layers,
        )
        expect(s).toMatchObject({ layerId: 'l-wh' })
    })

    it('boosts a layer that already declares the entity type', () => {
        const typed = [
            { id: 'l-a', name: 'Source', entityTypes: ['Roots'] },
            { id: 'l-b', name: 'Source', entityTypes: [] },
        ]
        const [s] = suggestLayerMappings(
            [{ urn: 'urn:1', name: 'Source', type: 'Roots' }],
            typed,
        )
        expect(s.layerId).toBe('l-a')
    })

    it('drops ambiguous ties rather than guessing', () => {
        const twins = [
            { id: 'l-a', name: 'Staging', entityTypes: [] },
            { id: 'l-b', name: 'Staging', entityTypes: [] },
        ]
        expect(suggestLayerMappings(
            [{ urn: 'urn:1', name: 'Staging', type: 'Roots' }],
            twins,
        )).toEqual([])
    })

    it('returns nothing when no name is close enough', () => {
        expect(suggestLayerMappings(
            [{ urn: 'urn:1', name: 'CRM System', type: 'Roots' }],
            layers,
        )).toEqual([])
    })

    it('returns nothing when there are no layers', () => {
        expect(suggestLayerMappings(
            [{ urn: 'urn:1', name: 'Staging', type: 'Roots' }],
            [],
        )).toEqual([])
    })

    it('maps a whole batch, one suggestion per matched entity', () => {
        const out = suggestLayerMappings(
            [
                { urn: 'urn:1', name: 'Staging', type: 'Roots' },
                { urn: 'urn:2', name: 'Source Systems', type: 'Roots' },
                { urn: 'urn:3', name: 'Totally Unrelated', type: 'Roots' },
            ],
            layers,
        )
        expect(out.map(s => [s.urn, s.layerId])).toEqual([
            ['urn:1', 'l-stg'],
            ['urn:2', 'l-src'],
        ])
    })
})
