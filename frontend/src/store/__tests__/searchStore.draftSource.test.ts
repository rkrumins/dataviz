/**
 * What put the draft in its shape, when it wasn't its editor — kept with
 * the draft so the search that runs it can say where it came from.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import { useSearchStore } from '../searchStore'


const A: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }
const B: Predicate = { kind: 'tag', op: 'hasAny', values: ['Finance'] }

beforeEach(() => {
    useSearchStore.getState().clear()
})


describe('searchStore — where the draft came from', () => {
    it('keeps the source a change names, and clears it on an edit that names none', () => {
        useSearchStore.getState().commitDraft(A, 'ask')
        expect(useSearchStore.getState().draftSource).toBe('ask')

        useSearchStore.getState().commitDraft(B)
        expect(useSearchStore.getState().draftSource).toBeNull()
    })

    it('takes the source of a change that asks for the same shape again', () => {
        useSearchStore.getState().commitDraft(A, 'header')
        useSearchStore.getState().commitDraft(A, 'ask')
        expect(useSearchStore.getState().draftSource).toBe('ask')
        // An edit that changes nothing leaves it.
        useSearchStore.getState().commitDraft(A)
        expect(useSearchStore.getState().draftSource).toBe('ask')
    })

    it('clears it on undo, redo, a seed and a clear', () => {
        const store = useSearchStore.getState
        store().commitDraft(A, 'recipe')
        store().commitDraft(B, 'library')
        store().undo()
        expect(store().draftSource).toBeNull()
        store().commitDraft(B, 'library')
        store().undo()
        store().redo()
        expect(store().draftSource).toBeNull()

        store().commitDraft(A, 'results')
        store().seedDraftPredicate(B)
        expect(store().draftSource).toBeNull()

        store().commitDraft(A, 'results')
        store().clear({ undoable: true })
        expect(store().draftSource).toBeNull()
    })

    it('marks How it matches as a change made from the results', () => {
        useSearchStore.getState().showRoutes(B, A)
        expect(useSearchStore.getState().draftSource).toBe('results')
        expect(useSearchStore.getState().pendingRunSource).toBe('results')
    })
})
