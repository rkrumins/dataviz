import { describe, it, expect, beforeEach } from 'vitest'

import { useSearchStore } from '../searchStore'
import type { Predicate } from '@/types/search'


const P: Predicate = { kind: 'hasProperty', key: 'owner', negate: false }

beforeEach(() => {
    useSearchStore.setState({ pendingRunPredicate: null, draftPredicate: null })
})


describe('searchStore — open-in-Advanced-Search bridge', () => {
    it('requestSearchRun seeds the draft (visible/editable) and flags a run', () => {
        useSearchStore.getState().requestSearchRun(P)
        const s = useSearchStore.getState()
        expect(s.draftPredicate).toEqual(P)        // loaded into the builder
        expect(s.pendingRunPredicate).toEqual(P)   // panel will run it
    })

    it('consumePendingRun returns the predicate once, then null', () => {
        useSearchStore.getState().requestSearchRun(P)
        expect(useSearchStore.getState().consumePendingRun()).toEqual(P)
        expect(useSearchStore.getState().pendingRunPredicate).toBeNull()
        expect(useSearchStore.getState().consumePendingRun()).toBeNull()
    })
})
