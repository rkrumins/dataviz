import { describe, it, expect, beforeEach } from 'vitest'

import { useReferenceModelStore } from '../referenceModelStore'
import type { ViewLayerConfig } from '@/types/schema'

const L1: ViewLayerConfig = { id: 'L1', name: 'Warehouse', order: 0, entityTypes: [] }

beforeEach(() => {
    useReferenceModelStore.setState({ layers: [L1], scopeFilter: null })
})

describe('referenceModelStore — buildAssignmentRequest (compute-request adapter)', () => {
    it('threads entityScope and adapts each canonical entry to EntityAssignmentConfig', () => {
        const req = useReferenceModelStore.getState().buildAssignmentRequest({
            assignments: {
                'urn:a': { layerId: 'L1', inheritsChildren: true, assignedBy: 'rule', assignedAt: '2026-01-01T00:00:00Z', logicalNodeId: 'ln1' },
            },
            entityScope: 'curated',
        })

        expect(req.entityScope).toBe('curated')
        expect(req.includeEdges).toBe(true)
        // Backend EntityAssignmentConfig required fields are all present.
        expect(req.assignments!['urn:a']).toEqual({
            entityId: 'urn:a',
            layerId: 'L1',
            logicalNodeId: 'ln1',
            inheritsChildren: true,
            priority: 1000,
            assignedBy: 'rule',
            assignedAt: '2026-01-01T00:00:00Z',
        })
    })

    it('fills defaults (assignedBy user, priority 1000, a timestamp) for a bare entry', () => {
        const req = useReferenceModelStore.getState().buildAssignmentRequest({
            assignments: { 'urn:b': { layerId: 'L1', inheritsChildren: true } },
            entityScope: 'all',
        })

        const cfg = req.assignments!['urn:b']
        expect(cfg.entityId).toBe('urn:b')
        expect(cfg.priority).toBe(1000)
        expect(cfg.assignedBy).toBe('user')
        expect(typeof cfg.assignedAt).toBe('string')
        expect(cfg.assignedAt.length).toBeGreaterThan(0)
    })

    it("collapses an 'import' provenance to 'user' (EntityAssignmentConfig has no 'import')", () => {
        const req = useReferenceModelStore.getState().buildAssignmentRequest({
            assignments: { 'urn:c': { layerId: 'L1', inheritsChildren: false, assignedBy: 'import' } },
            entityScope: 'curated',
        })
        expect(req.assignments!['urn:c'].assignedBy).toBe('user')
        expect(req.assignments!['urn:c'].inheritsChildren).toBe(false)
    })

    it('empty assignments → empty request map, scope threaded', () => {
        const req = useReferenceModelStore.getState().buildAssignmentRequest({ assignments: {}, entityScope: 'all' })
        expect(req.assignments).toEqual({})
        expect(req.entityScope).toBe('all')
    })
})
