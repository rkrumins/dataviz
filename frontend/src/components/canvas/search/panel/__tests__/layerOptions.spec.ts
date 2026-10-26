/**
 * What the search offers from a view's own data: the entity types it holds
 * (most common first — "Everything of type …" always returns something) and
 * the layers a layer filter can name — the view's own, by name, in board
 * order; the stamps entities carry where the view has none.
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
    const view = [{ id: 'layer-raw', name: 'Raw', order: 1 }, { id: 'layer-gold', name: 'Gold', order: 2 },
                  { id: 'layer-src', name: ' Sources ', order: 0 }]

    const samples = (byKey: Record<string, unknown[]>) => (key: string) => byKey[key] ?? []

    it("offers the view's layers by name, in board order, whatever entities are stamped with", () => {
        const got = layerOptions(view, samples({ layerAssignment: ['layer-raw', 'bronze'] }))
        expect(got).toEqual([{ value: 'Sources', label: 'Sources' }, { value: 'Raw', label: 'Raw' },
                             { value: 'Gold', label: 'Gold' }])
    })

    it('offers a name two layers share by id, so a pick never names two', () => {
        const got = layerOptions([{ id: 'a', name: 'Staging' }, { id: 'b', name: 'staging' }, { id: 'c' }],
                                 samples({}))
        expect(got).toEqual([{ value: 'a', label: 'Staging (a)' }, { value: 'b', label: 'staging (b)' },
                             { value: 'c', label: 'c' }])
    })

    it('offers the stamps entities carry where the view has no layers', () => {
        const got = layerOptions([], samples({ layerAssignment: ['layer-raw', 'layer-gold', '', 'layer-raw'] }))
        expect(got).toEqual([{ value: 'layer-gold', label: 'layer-gold' }, { value: 'layer-raw', label: 'layer-raw' }])
    })

    it("never offers a user property that happens to be called 'layer'", () => {
        expect(layerOptions([], samples({ layer: ['gold', 'silver'] }))).toEqual([])
    })
})
