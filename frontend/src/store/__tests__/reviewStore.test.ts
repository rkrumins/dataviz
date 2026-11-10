/**
 * A review's state: starting one opens its list on what was asked for, never narrowed by an
 * earlier search; another scope starts its type afresh; ending it closes the list and keeps what
 * it showed, for the rail to open on again.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import { useReviewStore } from '../reviewStore'

const s = () => useReviewStore.getState()

beforeEach(() => {
  useReviewStore.setState({ available: true, listOpen: false, scope: null, operation: null, filter: {} })
})

describe('reviewStore', () => {
  it('starts on what was asked for, with nothing else narrowing it', () => {
    s().setFilter({ kind: 'edge', type: 'Table', q: 'orders' })
    s().startReview({ scope: { kind: 'since', seq: 12 }, operation: 'removed' })
    expect(s()).toMatchObject({ listOpen: true, scope: { kind: 'since', seq: 12 }, operation: 'removed' })
    expect(s().filter).toEqual({})

    s().startReview()
    expect(s()).toMatchObject({ scope: null, operation: null })
  })

  it('starts another scope on all its types, keeping the search', () => {
    s().setFilter({ type: 'Table', q: 'orders' })
    s().setScope({ kind: 'in', seq: 12 })
    expect(s().filter).toEqual({ type: undefined, q: 'orders' })
  })

  it('ends by closing the list, keeping what it showed', () => {
    s().startReview({ operation: 'added' })
    s().setFilter({ q: 'orders' })
    s().endReview()
    expect(s()).toMatchObject({ listOpen: false, operation: 'added', filter: { q: 'orders' } })
  })
})
