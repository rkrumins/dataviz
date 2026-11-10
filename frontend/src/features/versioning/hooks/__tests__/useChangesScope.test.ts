/**
 * What a review lists, by where the canvas is: a draft's changes; at a past revision what changed
 * since it or what it changed; two revisions compared; on Published the latest revision. A choice
 * stands while the canvas offers it, and a scope the canvas can draw without moving in time is
 * highlighted while it is reviewed — and no longer once the review ends or moves on.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useBranchStore } from '@/store/branchStore'
import type { ReviewScope } from '@/store/reviewStore'
import { resolveScopes, useDrawScope, type ScopeOption } from '../useChangesScope'

const base = { branchId: null, revision: null, highlight: null, head: 42, chosen: null }
const labels = (r: { options: ScopeOption[] }) => r.options.map((o) => o.label)

describe('resolveScopes', () => {
  it("lists a draft's changes, and only those, while it is open", () => {
    const r = resolveScopes({ ...base, branchId: 'br_1', highlight: { fromSeq: 3, toSeq: 9 } })
    expect(labels(r)).toEqual(['This draft'])
    expect(r.current?.origin).toEqual({ branchId: 'br_1' })
  })

  it('lists the latest revision on Published, highlighting it to draw it', () => {
    const r = resolveScopes(base)
    expect(labels(r)).toEqual(['The latest revision · #42'])
    expect(r.current).toMatchObject({ scope: { kind: 'in', seq: 42 }, origin: { fromSeq: 41, toSeq: 42 },
      highlight: { fromSeq: 41, toSeq: 42 } })
    expect(resolveScopes({ ...base, head: 0 }).current).toBeNull()                 // nothing published yet
  })

  it('at a past revision, lists what changed since by default, or what it changed', () => {
    const r = resolveScopes({ ...base, revision: { seq: 12, headAtOpen: 40 } })
    expect(labels(r)).toEqual(['Since #12', 'Changed in #12'])
    expect(r.current).toMatchObject({ origin: { fromSeq: 12, toSeq: 40 } })
    expect(r.current?.highlight).toBeUndefined()        // drawing it would mean moving the canvas on
    expect(r.options[1]).toMatchObject({ origin: { fromSeq: 11, toSeq: 12 }, highlight: { fromSeq: 11, toSeq: 12 } })
    // At the head it opened at, nothing has changed since.
    expect(labels(resolveScopes({ ...base, revision: { seq: 40, headAtOpen: 40 } }))).toEqual(['Changed in #40'])
  })

  it('lists two revisions compared first, already drawn, and offers a single one as itself', () => {
    const r = resolveScopes({ ...base, highlight: { fromSeq: 3, toSeq: 42 } })
    expect(labels(r)).toEqual(['#3 → #42', 'The latest revision · #42'])
    expect(r.current).toMatchObject({ scope: { kind: 'between', fromSeq: 3, toSeq: 42 } })
    expect(r.current?.highlight).toBeUndefined()

    // What #12 changed, highlighted at #12, is "Changed in #12" — once.
    const one = resolveScopes({ ...base, revision: { seq: 12, headAtOpen: 40 }, highlight: { fromSeq: 11, toSeq: 12 } })
    expect(labels(one)).toEqual(['Changed in #12', 'Since #12'])
    expect(one.current?.highlight).toBeUndefined()
  })

  it('keeps a choice while it is offered, and falls back to the default when it is not', () => {
    const since: ReviewScope = { kind: 'since', seq: 12 }
    const atRevision = { ...base, revision: { seq: 12, headAtOpen: 40 } }
    expect(resolveScopes({ ...atRevision, chosen: { kind: 'in', seq: 12 } }).current?.label).toBe('Changed in #12')
    expect(resolveScopes({ ...base, chosen: since }).current?.label).toBe('The latest revision · #42')
  })
})

describe('useDrawScope', () => {
  const latest = resolveScopes(base).current!
  beforeEach(() => { useBranchStore.getState().reset() })

  it('highlights what it reviews where that draws it, and takes the highlight away when the review ends', () => {
    const { rerender } = renderHook(({ open }) => useDrawScope(latest, open), { initialProps: { open: true } })
    expect(useBranchStore.getState().highlight).toEqual({ fromSeq: 41, toSeq: 42 })

    rerender({ open: false })
    expect(useBranchStore.getState().highlight).toBeNull()
  })

  it('takes it away for a scope that needs none, and leaves a highlight someone else set', () => {
    const since = resolveScopes({ ...base, revision: { seq: 12, headAtOpen: 40 } }).current!
    const { rerender, unmount } = renderHook(({ current }) => useDrawScope(current, true),
      { initialProps: { current: latest } })
    rerender({ current: since })
    expect(useBranchStore.getState().highlight).toBeNull()

    rerender({ current: latest })
    act(() => useBranchStore.getState().setHighlight({ fromSeq: 3, toSeq: 9 }))   // History, say
    unmount()
    expect(useBranchStore.getState().highlight).toEqual({ fromSeq: 3, toSeq: 9 })
  })
})
