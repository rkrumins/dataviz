/**
 * Clearing the query: the person's own Clear is one more undo step, so
 * Undo brings the query back; the panel closing or the View switching
 * forgets the history — there'd be nothing on screen to undo into.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import type { Predicate } from '@/types/search'

import { useSearchStore } from '../searchStore'


const PII: Predicate = { kind: 'tag', op: 'hasAny', values: ['PII'] }
const BOTH: Predicate = { kind: 'group', op: 'and', children: [PII, { kind: 'entityType', op: 'in', values: ['dataset'] }] }
const store = () => useSearchStore.getState()

beforeEach(() => store().clear())


describe('searchStore — clear', () => {
    it('keeps the query one Undo away when the person clears it', () => {
        store().commitDraft(PII)
        store().commitDraft(BOTH)
        store().clear({ undoable: true })
        expect(store().draftPredicate).toBeNull()

        store().undo()
        expect(store().draftPredicate).toEqual(BOTH)
        store().undo()
        expect(store().draftPredicate).toEqual(PII)
        store().redo()
        store().redo()
        expect(store().draftPredicate).toBeNull()
    })

    it('adds no step when there was no query to clear', () => {
        store().commitDraft(PII)
        store().commitDraft(null)
        const past = store().historyPast
        store().clear({ undoable: true })
        expect(store().historyPast).toBe(past)
    })

    it('forgets the history when the panel closes or the View changes', () => {
        store().commitDraft(PII)
        store().clear()
        expect(store().historyPast).toHaveLength(0)
        store().undo()
        expect(store().draftPredicate).toBeNull()
    })
})
