/**
 * A review's state: starting one puts the navigator on the canvas, with the list beside it for
 * technical users or whoever chose to keep it; it starts on what was asked for, never narrowed by an
 * earlier search, at the first change. Another list starts at its top; another scope on all its
 * types. Ending it closes both and keeps what it showed.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import type { ChangeListRow } from '@/services/versioningApiService'
import { usePersonaStore } from '../persona'
import { useReviewStore } from '../reviewStore'

const s = () => useReviewStore.getState()
const row = (entityId: string): ChangeListRow => ({ entityId, kind: 'node', status: 'removed', structural: false })

beforeEach(() => {
  usePersonaStore.setState({ mode: 'business' })
  useReviewStore.setState({
    available: true, navigatorOpen: false, listOpen: false, listPreferred: null,
    scope: null, operation: null, filter: {}, current: null, position: 0, found: null,
  })
})

describe('reviewStore', () => {
  it('starts on what was asked for, at the first change, with nothing else narrowing it', () => {
    s().setFilter({ kind: 'edge', type: 'Table', q: 'orders' })
    s().visit(row('a'), 7)
    s().startReview({ scope: { kind: 'since', seq: 12 }, operation: 'removed' })
    expect(s()).toMatchObject({ navigatorOpen: true, scope: { kind: 'since', seq: 12 }, operation: 'removed', current: null, position: 0 })
    expect(s().filter).toEqual({})

    s().startReview()
    expect(s()).toMatchObject({ scope: null, operation: null })
  })

  it('opens the list beside the navigator for technical users, and remembers who chose otherwise', () => {
    s().startReview()
    expect(s().listOpen).toBe(false)                                   // business: the navigator alone
    usePersonaStore.setState({ mode: 'technical' })
    s().startReview()
    expect(s().listOpen).toBe(true)

    s().toggleList()                                                   // closed by choice
    s().endReview()
    s().startReview()
    expect(s()).toMatchObject({ listOpen: false, listPreferred: false })
  })

  it('visits a change, and counts each visit so the same one can be found again', () => {
    s().visit(row('a'), 3)
    const visits = s().visits
    s().visit(row('a'), 3)
    expect(s()).toMatchObject({ current: { entityId: 'a' }, position: 3, visits: visits + 1 })
  })

  it('starts another list at its top: another operation, filter or scope', () => {
    for (const change of [
      () => s().setOperation('added'),
      () => s().setFilter({ q: 'orders' }),
      () => s().setScope({ kind: 'in', seq: 12 }),
    ]) {
      s().visit(row('a'), 5)
      s().setFound('found')
      change()
      expect(s()).toMatchObject({ current: null, position: 0, found: null })
    }
  })

  it('starts another scope on all its types, keeping the search', () => {
    s().setFilter({ type: 'Table', q: 'orders' })
    s().setScope({ kind: 'in', seq: 12 })
    expect(s().filter).toEqual({ type: undefined, q: 'orders' })
  })

  it('ends by closing the navigator and the list, keeping what it showed', () => {
    s().startReview({ operation: 'added' })
    s().setFilter({ q: 'orders' })
    s().endReview()
    expect(s()).toMatchObject({ navigatorOpen: false, listOpen: false, current: null, operation: 'added', filter: { q: 'orders' } })
  })
})
