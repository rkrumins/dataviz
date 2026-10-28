import { describe, it, expect, beforeEach } from 'vitest'

import { useSearchStore } from '../searchStore'
import type { Predicate } from '@/types/search'


const P: Predicate = { kind: 'hasProperty', key: 'owner', negate: false }

beforeEach(() => {
    useSearchStore.setState({ pendingRunPredicate: null, pendingRunSource: null, draftPredicate: null })
})


describe('searchStore — open-in-Advanced-Search bridge', () => {
    it('requestSearchRun seeds the draft (visible/editable) and flags a run', () => {
        useSearchStore.getState().requestSearchRun(P, 'property-manager')
        const s = useSearchStore.getState()
        expect(s.draftPredicate).toEqual(P)        // loaded into the builder
        expect(s.pendingRunPredicate).toEqual(P)   // panel will run it
        // …and says where it came from, for the run's telemetry.
        expect(s.draftSource).toBe('property-manager')
        expect(s.pendingRunSource).toBe('property-manager')
    })

    it('consumePendingRun returns the predicate once, then null', () => {
        useSearchStore.getState().requestSearchRun(P, 'right-click')
        expect(useSearchStore.getState().consumePendingRun()).toEqual(P)
        expect(useSearchStore.getState().pendingRunPredicate).toBeNull()
        expect(useSearchStore.getState().pendingRunSource).toBeNull()
        expect(useSearchStore.getState().consumePendingRun()).toBeNull()
    })
})
