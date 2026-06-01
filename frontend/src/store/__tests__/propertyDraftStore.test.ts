import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

import {
    usePropertyDraftStore, usePropertyCatalogOverlay, type PropertyOp,
} from '../propertyDraftStore'
import type { Predicate } from '@/types/search'


const PRED: Predicate = { kind: 'hasProperty', key: 'owner', negate: false }

function op(over: Partial<PropertyOp>): PropertyOp {
    return {
        id: Math.random().toString(36).slice(2),
        kind: 'set', key: 'owner', predicate: PRED, targetCount: 3,
        createdAt: '2026-01-01T00:00:00Z',
        ...over,
    }
}

beforeEach(() => usePropertyDraftStore.setState({ pendingOps: [] }))


describe('propertyDraftStore', () => {
    it('adds, removes and clears ops', () => {
        const s = usePropertyDraftStore.getState()
        s.addOp(op({ id: 'a' }))
        s.addOp(op({ id: 'b' }))
        expect(usePropertyDraftStore.getState().pendingOps.map((o) => o.id)).toEqual(['a', 'b'])

        usePropertyDraftStore.getState().removeOp('a')
        expect(usePropertyDraftStore.getState().pendingOps.map((o) => o.id)).toEqual(['b'])

        usePropertyDraftStore.getState().clearOps()
        expect(usePropertyDraftStore.getState().pendingOps).toEqual([])
    })

    it('overlay annotates each key with its op kinds + rename target', () => {
        usePropertyDraftStore.setState({
            pendingOps: [
                op({ id: '1', kind: 'set', key: 'owner' }),
                op({ id: '2', kind: 'remove', key: 'legacyTag' }),
                op({ id: '3', kind: 'rename', key: 'rowCount', newKey: 'row_count' }),
            ],
        })
        const { result } = renderHook(() => usePropertyCatalogOverlay())
        const m = result.current
        expect(m.get('owner')!.kinds.has('set')).toBe(true)
        expect(m.get('legacyTag')!.kinds.has('remove')).toBe(true)
        expect(m.get('rowCount')!.renameTo).toBe('row_count')
        expect(m.get('rowCount')!.count).toBe(1)
    })
})
