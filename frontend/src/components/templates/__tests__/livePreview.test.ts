/**
 * The live preview's two decisions: which entity types to sample, and which
 * layer each sampled entity lands in — the wizard's placement, not a guess.
 */
import { describe, expect, it } from 'vitest'
import type { GraphNode } from '@/providers/GraphDataProvider'
import type { ViewLayerConfig } from '@/types/schema'
import { placeSample, sampleTypes } from '../livePreview'

const LAYERS: ViewLayerConfig[] = [
    { id: 'reports', name: 'Reports', entityTypes: ['Dashboard'], order: 1 },
    {
        id: 'sources', name: 'Sources', entityTypes: ['Table', 'View'], order: 0,
        rules: [{ id: 'r', entityTypes: ['Table', 'Topic'], priority: 1 }],
    },
    {
        id: 'domains', name: 'Domains', entityTypes: [], order: 2,
        logicalNodes: [{
            id: 'n', name: 'Finance', type: 'group',
            children: [{ id: 'm', name: 'Payments', type: 'group', rules: [{ id: 'r2', entityTypes: ['Domain'], priority: 1 }] }],
        }],
    },
]

function node(urn: string, entityType: string): GraphNode {
    return { urn, entityType, displayName: urn.split(':').pop()!, properties: {}, tags: [] }
}

describe('sampleTypes', () => {
    it('takes every type the layers collect, in layer order, once each', () => {
        expect(sampleTypes(LAYERS)).toEqual(['Table', 'View', 'Topic', 'Dashboard', 'Domain'])
    })

    it('stops at the most it may ask for', () => {
        expect(sampleTypes(LAYERS, 2)).toEqual(['Table', 'View'])
    })
})

describe('placeSample', () => {
    it('puts each entity in the layer its type places it in, and says what lands nowhere', () => {
        const { byLayer, unplaced } = placeSample(
            LAYERS,
            [node('urn:t:orders', 'Table'), node('urn:d:revenue', 'Dashboard'), node('urn:x:misc', 'Glossary')],
            false,
        )
        expect(byLayer.get('sources')?.map(n => n.displayName)).toEqual(['orders'])
        expect(byLayer.get('reports')?.map(n => n.displayName)).toEqual(['revenue'])
        expect(unplaced.map(n => n.displayName)).toEqual(['misc'])
    })
})
