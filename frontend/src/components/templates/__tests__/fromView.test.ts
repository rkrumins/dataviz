/**
 * A Context View's layers as a template keeps them: the structure travels, and
 * nothing that names an entity of that view's graph does.
 */
import { describe, expect, it } from 'vitest'
import type { ViewLayerConfig } from '@/types/schema'
import { layersOfViewConfig, templateLayers } from '../fromView'

describe('templateLayers', () => {
    it('strips anchors, hand placements and exact-URN rules, at any depth', () => {
        const layers = [{
            id: 'l1', name: 'Domains', entityTypes: ['domain'], order: 0, color: '#111111', showUnassigned: true,
            anchorUrn: 'urn:li:domain:finance',
            templateLayerId: 'medallion-bronze',
            entityAssignments: [{ entityId: 'urn:li:dataset:1', layerId: 'l1' }],
            rules: [
                { id: 'exact', urnPattern: 'urn:li:dataset:1', priority: 1 },
                { id: 'shape', urnPattern: 'urn:li:dataset:*', priority: 1 },
                { id: 'typed', entityTypes: ['dataset'], priority: 1 },
            ],
            logicalNodes: [{
                id: 'g', name: 'Group', type: 'group',
                rules: [{ id: 'g-exact', urnPattern: 'urn:li:dataset:2', priority: 1 }],
                children: [{ id: 'c', name: 'Child', type: 'group', rules: [{ id: 'c-exact', urnPattern: 'urn:li:x', priority: 1 }] }],
            }],
        }] as unknown as ViewLayerConfig[]

        const [kept] = templateLayers(layers)
        expect(kept).not.toHaveProperty('anchorUrn')
        expect(kept).not.toHaveProperty('entityAssignments')
        expect(kept).not.toHaveProperty('templateLayerId')
        expect(kept.rules?.map(r => r.id)).toEqual(['shape', 'typed'])
        expect(kept.logicalNodes?.[0].rules).toEqual([])
        expect(kept.logicalNodes?.[0].children?.[0].rules).toEqual([])
        expect(kept.showUnassigned).toBe(true)
        // The view's own layers are untouched.
        expect(layers[0].anchorUrn).toBe('urn:li:domain:finance')
    })
})

describe('layersOfViewConfig', () => {
    it('reads the canonical and the legacy spelling, and nothing else', () => {
        const layer = { id: 'l', name: 'L', entityTypes: [], order: 0 }
        expect(layersOfViewConfig({ layout: { referenceLayout: { layers: [layer] } } })).toEqual([layer])
        expect(layersOfViewConfig({ referenceLayout: { layers: [layer] } })).toEqual([layer])
        expect(layersOfViewConfig({})).toEqual([])
        expect(layersOfViewConfig(undefined)).toEqual([])
    })
})
