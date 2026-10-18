/**
 * How a layout template fits a view's semantic layer: types take the target's
 * own spelling or are reported, rules that could never match are dropped
 * rather than left to match everything, and the new view owns fresh layer ids.
 */
import { describe, expect, it } from 'vitest'
import type { ViewLayerConfig } from '@/types/schema'
import { fitTemplate } from '../templateFit'

const LAYERS: ViewLayerConfig[] = [
    { id: 'a', name: 'Domains', entityTypes: ['domain', 'bounded-context'], order: 0, color: '#123456' },
    {
        id: 'b', name: 'Products', entityTypes: ['DATASET', 'dataset', 'table'], order: 1,
        rules: [
            { id: 'r1', entityTypes: ['table'], priority: 1 },              // every type unknown → dropped
            { id: 'r2', entityTypes: ['dataset', 'table'], priority: 1 },   // narrowed to what exists
            { id: 'r3', tags: ['pii'], priority: 1 },                       // no types: kept as is
        ],
        logicalNodes: [{
            id: 'g', name: 'Group', type: 'group',
            children: [{ id: 'c', name: 'Child', type: 'group', rules: [{ id: 'r4', entityTypes: ['table'], priority: 1 }] }],
        }],
    },
    { id: 'c', name: 'By hand', entityTypes: [], order: 2 },
]

describe('fitTemplate', () => {
    it("resolves types to the semantic layer's spelling and reports the rest", () => {
        const fit = fitTemplate(LAYERS, ['Dataset', 'System'])
        expect(fit.layers.map(l => l.entityTypes)).toEqual([[], ['Dataset'], []])
        expect(fit.typedLayers).toBe(2)
        expect(fit.matchedLayers).toBe(1)
        expect(fit.unmatchedTypes).toEqual(['bounded-context', 'domain', 'table'])
    })

    it('drops a rule that could only ever match unknown types, at any depth', () => {
        const [, products] = fitTemplate(LAYERS, ['Dataset']).layers
        expect(products.rules).toEqual([
            { id: 'r2', entityTypes: ['Dataset'], priority: 1 },
            { id: 'r3', tags: ['pii'], priority: 1 },
        ])
        expect(products.logicalNodes?.[0].children?.[0].rules).toEqual([])
    })

    it('keeps every other field, mints fresh ids and renumbers the order', () => {
        const fit = fitTemplate(LAYERS, ['Dataset'])
        expect(fit.layers.map(l => l.name)).toEqual(['Domains', 'Products', 'By hand'])
        expect(fit.layers[0].color).toBe('#123456')
        expect(fit.layers.map(l => l.order)).toEqual([0, 1, 2])
        expect(fit.layers.map(l => l.id)).not.toContain('a')
        expect(new Set(fit.layers.map(l => l.id)).size).toBe(3)
    })

    it('remembers the template layer each column came from, for its later versions', () => {
        const fit = fitTemplate(LAYERS, null)
        expect(fit.layers.map(l => l.templateLayerId)).toEqual(LAYERS.map(l => l.id))
    })

    it('keeps the types as they are when the semantic layer is not known', () => {
        const fit = fitTemplate(LAYERS, null)
        expect(fit.layers[0].entityTypes).toEqual(['domain', 'bounded-context'])
        expect(fit.unmatchedTypes).toEqual([])
        expect(fit.matchedLayers).toBe(fit.typedLayers)
    })
})
