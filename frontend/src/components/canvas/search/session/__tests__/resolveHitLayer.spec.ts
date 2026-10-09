/**
 * Tests for the pure helper that picks which layer column a search hit
 * badges under — walks ``[...ancestorPath, hit]`` from the root, taking
 * the first URN with an assignment entry (see resolveHitLayer.ts).
 */
import { describe, expect, it } from 'vitest'

import type { LayerAssignmentEntry, ViewLayerConfig } from '@/types/schema'
import type { AncestorRef } from '@/types/search'

import { resolveHitLayer } from '../resolveHitLayer'


function ancestor(urn: string, entityType: string): AncestorRef {
    return { urn, entityType, displayName: urn } as AncestorRef
}

function layer(id: string, entityTypes: string[] = []): ViewLayerConfig {
    return { id, name: id, entityTypes, order: 0 }
}

function entry(layerId: string, inheritsChildren: boolean = true): LayerAssignmentEntry {
    return { layerId, inheritsChildren }
}


describe('resolveHitLayer', () => {
    it('a root assignment inherits down through unassigned intermediates to a hit three levels deep', () => {
        const hit = { urn: 'hit-1', entityType: 'dataset' }
        const ancestorPath: AncestorRef[] = [
            ancestor('root', 'domain'),
            ancestor('mid1', 'schema'),
            ancestor('mid2', 'table'),
        ]
        const assignments: Record<string, LayerAssignmentEntry> = {
            root: entry('L1'),
        }
        expect(resolveHitLayer(hit, ancestorPath, assignments, [layer('L1')])).toBe('L1')
    })

    it('an ancestor entry with inheritsChildren:false is skipped — curated view falls through to "not on this canvas"', () => {
        const hit = { urn: 'hit-2', entityType: 'dataset' }
        const ancestorPath: AncestorRef[] = [ancestor('root', 'domain')]
        const assignments: Record<string, LayerAssignmentEntry> = {
            root: entry('L1', false),
        }
        expect(resolveHitLayer(hit, ancestorPath, assignments, [layer('L1')])).toBeNull()
    })

    it('the hit\'s own inheritsChildren:false entry still applies — the carve-out is for ANCESTORS only', () => {
        const hit = { urn: 'hit-2b', entityType: 'dataset' }
        const ancestorPath: AncestorRef[] = [ancestor('root', 'domain')]
        const assignments: Record<string, LayerAssignmentEntry> = {
            'hit-2b': entry('L2', false),
        }
        expect(resolveHitLayer(hit, ancestorPath, assignments, [layer('L2')])).toBe('L2')
    })

    it('an open view (no assignments at all) falls back to the layer whose entityTypes includes the top-level ancestor\'s type', () => {
        const hit = { urn: 'hit-3', entityType: 'dataset' }
        const ancestorPath: AncestorRef[] = [ancestor('root', 'domain')]
        const layers = [layer('L1', ['domain']), layer('L2', ['dataset'])]
        // Falls back by the TOP-LEVEL node's type ('domain'), not the hit's own type.
        expect(resolveHitLayer(hit, ancestorPath, {}, layers)).toBe('L1')
    })

    it('a curated view (non-empty assignments) with nothing matching the hit\'s chain resolves to null', () => {
        const hit = { urn: 'hit-4', entityType: 'dataset' }
        const ancestorPath: AncestorRef[] = [ancestor('root-other', 'domain')]
        const assignments: Record<string, LayerAssignmentEntry> = {
            'unrelated-urn': entry('L1'),
        }
        expect(resolveHitLayer(hit, ancestorPath, assignments, [layer('L1')])).toBeNull()
    })
})
