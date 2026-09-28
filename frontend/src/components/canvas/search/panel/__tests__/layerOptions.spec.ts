/**
 * What the search offers from a view's own data: the entity types it holds
 * (most common first — "Everything of type …" always returns something) and
 * the layers a layer filter can match (``layerAssignment`` only).
 */
import { describe, expect, it } from 'vitest'

import { entityTypesInView, layerOptions } from '../layerOptions'


describe('entityTypesInView', () => {
    it('offers the types the data holds, most common first', () => {
        const labels = { domain: { sampled: 6 }, schemaField: { sampled: 200 },
                         dataset: { sampled: 44 }, pipeline: { sampled: 0 } }
        expect(entityTypesInView(labels, ['pipeline', 'report'])).toEqual(
            ['schemaField', 'dataset', 'domain'])
    })

    it("falls back to the ontology's types until discovery answers", () => {
        expect(entityTypesInView(null, ['a', 'b'])).toEqual(['a', 'b'])
        expect(entityTypesInView({ x: { sampled: 0 } }, ['a'])).toEqual(['a'])
    })
})


describe('layerOptions', () => {
    const view = [{ id: 'layer-gold', name: 'Gold' }, { id: 'layer-raw', name: 'Raw' }]

    const samples = (byKey: Record<string, unknown[]>) => (key: string) => byKey[key] ?? []

    it("names the layers entities are assigned to from the view's layers", () => {
        const got = layerOptions(view, samples({ layerAssignment: ['layer-raw', 'layer-gold', '', 'layer-raw'] }))
        expect(got).toEqual([{ value: 'layer-gold', label: 'Gold' }, { value: 'layer-raw', label: 'Raw' }])
    })

    it("never offers a user property that happens to be called 'layer'", () => {
        // The layer filter matches layerAssignment alone: "In the gold layer"
        // here would match nothing.
        const got = layerOptions(view, samples({ layer: ['gold', 'silver'] }))
        expect(got).toEqual([{ value: 'layer-gold', label: 'Gold' }, { value: 'layer-raw', label: 'Raw' }])
    })
})
