/**
 * Result ownership.
 *
 * Two surfaces publish into one result slot on purpose — the Context
 * View header's find-in-view box and the Advanced Search rail — so the
 * canvas has one spotlight, one stepper, and one set of roll-up badges
 * no matter which box the user typed into.
 *
 * Sharing needs an owner. ``SearchMapPanel`` unmounts ``useAdvancedSearch``
 * every time the rail closes, and that hook's cleanup clears the slot.
 * Without ownership, closing the rail would silently blank results the
 * header owns while the user is still typing into it.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { useSearchStore } from '../searchStore'


/** What ``useAdvancedSearch.clearOwnResults`` does. Mirrored here rather
 *  than imported because the hook needs a React tree to mount; the rule
 *  under test is the store contract it depends on. */
function clearOwnResults(): void {
    if (useSearchStore.getState().resultSource === 'quick') return
    useSearchStore.getState().clear()
}

function publish(source?: 'quick' | 'advanced') {
    useSearchStore.getState().setResult({
        viewId: 'view-1',
        matchUrns: ['urn:a', 'urn:b'],
        queryHash: `hash-${source ?? 'default'}`,
        ...(source ? { source } : {}),
    })
}


describe('searchStore — result ownership', () => {
    beforeEach(() => {
        useSearchStore.getState().clear()
    })

    it('starts with no owner', () => {
        expect(useSearchStore.getState().resultSource).toBeNull()
    })

    it('defaults to the rail so existing callers are unaffected', () => {
        publish()
        expect(useSearchStore.getState().resultSource).toBe('advanced')
    })

    it('records the header as owner when it publishes', () => {
        publish('quick')
        expect(useSearchStore.getState().resultSource).toBe('quick')
    })

    it('drops the owner on clear', () => {
        publish('quick')
        useSearchStore.getState().clear()
        expect(useSearchStore.getState().resultSource).toBeNull()
    })

    it('drops the owner on clearSearchResults', () => {
        publish('advanced')
        useSearchStore.getState().clearSearchResults()
        expect(useSearchStore.getState().resultSource).toBeNull()
    })

    it('lets the rail clear results the rail published', () => {
        publish('advanced')
        clearOwnResults()
        expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
        expect(useSearchStore.getState().resultSource).toBeNull()
    })

    it('closing the rail leaves the header\'s results on screen', () => {
        publish('quick')
        clearOwnResults()   // the rail unmounting
        expect(useSearchStore.getState().matchUrnSet.size).toBe(2)
        expect(useSearchStore.getState().resultSource).toBe('quick')
    })

    it('hands ownership over when the other surface republishes', () => {
        publish('quick')
        publish('advanced')
        expect(useSearchStore.getState().resultSource).toBe('advanced')
        clearOwnResults()
        expect(useSearchStore.getState().matchUrnSet.size).toBe(0)
    })
})
