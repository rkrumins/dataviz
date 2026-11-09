/**
 * useRevisionDeepLink — the graph as it was is a link: `?rev=<seq>` opens that revision once the
 * view is resolved; the open revision is written back as `?rev=`, and closing it clears the param.
 * A seq at or past the head, or one that isn't a number, names nothing and is dropped. A revision is
 * of Published, so a `?branch=` beside it goes. An `&hl=` beside it is read once: the comparison it
 * names is highlighted on the revision opened (on Published, at the head), and the param goes; one
 * without a revision, or not before it, is dropped unread.
 */
import React from 'react'
import { renderHook } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'

import { useRevisionDeepLink } from '../useRevisionDeepLink'

const probe = { search: '' }
const at = (initial: string) =>
  function Wrapper({ children }: { children: React.ReactNode }) {
    function LocationProbe() {
      probe.search = useLocation().search
      return null
    }
    return (
      <MemoryRouter initialEntries={[initial]}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    )
  }

const base = { enabled: true, headSeq: 40, revisionSeq: null, scopeViewId: 'v1', activeViewId: 'v1', setHighlight: () => {} }

describe('useRevisionDeepLink', () => {
  it('opens the revision a link names, at the head it was opened at, and drops a draft beside it', () => {
    const openRevision = vi.fn()
    renderHook(() => useRevisionDeepLink({ ...base, openRevision }), { wrapper: at('/views/v1?rev=12&branch=br_1') })
    expect(openRevision).toHaveBeenCalledWith({ seq: 12, headAtOpen: 40 })
    expect(probe.search).toBe('?rev=12')
  })

  it('waits for the view to be resolved, and for the preview', () => {
    const openRevision = vi.fn()
    renderHook(() => useRevisionDeepLink({ ...base, activeViewId: 'v2', openRevision }), { wrapper: at('/views/v2?rev=12') })
    renderHook(() => useRevisionDeepLink({ ...base, enabled: false, openRevision }), { wrapper: at('/views/v1?rev=12') })
    renderHook(() => useRevisionDeepLink({ ...base, headSeq: null, openRevision }), { wrapper: at('/views/v1?rev=12') })
    expect(openRevision).not.toHaveBeenCalled()
  })

  it.each(['40', '41', 'abc', '-3', '1.5'])('drops ?rev=%s, which names no past revision', (rev) => {
    const openRevision = vi.fn()
    renderHook(() => useRevisionDeepLink({ ...base, openRevision }), { wrapper: at(`/views/v1?rev=${rev}`) })
    expect(openRevision).not.toHaveBeenCalled()
    expect(probe.search).toBe('')
  })

  it('writes the open revision into the link, and clears it once the revision closes', () => {
    const openRevision = vi.fn()
    const { rerender } = renderHook(
      ({ revisionSeq }: { revisionSeq: number | null }) => useRevisionDeepLink({ ...base, revisionSeq, openRevision }),
      { wrapper: at('/views/v1'), initialProps: { revisionSeq: 7 as number | null } },
    )
    expect(probe.search).toBe('?rev=7')
    rerender({ revisionSeq: null })
    expect(probe.search).toBe('')
    expect(openRevision).not.toHaveBeenCalled()
  })

  it('highlights the comparison a link names on the revision it opens, once, and drops it from the link', () => {
    const openRevision = vi.fn()
    const setHighlight = vi.fn()
    const { rerender } = renderHook(
      ({ revisionSeq }: { revisionSeq: number | null }) =>
        useRevisionDeepLink({ ...base, revisionSeq, openRevision, setHighlight }),
      { wrapper: at('/views/v1?rev=12&hl=3&branch=br_1'), initialProps: { revisionSeq: null as number | null } },
    )
    expect(openRevision).toHaveBeenCalledWith({ seq: 12, headAtOpen: 40 })
    expect(setHighlight).toHaveBeenCalledWith({ fromSeq: 3, toSeq: 12 })
    expect(openRevision.mock.invocationCallOrder[0]).toBeLessThan(setHighlight.mock.invocationCallOrder[0])
    expect(probe.search).toBe('?rev=12')
    rerender({ revisionSeq: 12 })
    expect(setHighlight).toHaveBeenCalledTimes(1)
    expect(probe.search).toBe('?rev=12')
  })

  it('reads it once even when another revision was open, which the link replaces', () => {
    const setHighlight = vi.fn()
    const { rerender } = renderHook(
      ({ revisionSeq }: { revisionSeq: number | null }) =>
        useRevisionDeepLink({ ...base, revisionSeq, openRevision: vi.fn(), setHighlight }),
      { wrapper: at('/views/v1?rev=8&hl=3'), initialProps: { revisionSeq: 5 as number | null } },
    )
    rerender({ revisionSeq: 8 })
    expect(setHighlight).toHaveBeenCalledTimes(1)
    expect(setHighlight).toHaveBeenCalledWith({ fromSeq: 3, toSeq: 8 })
    expect(probe.search).toBe('?rev=8')
  })

  it('highlights a link at the head on Published as it is', () => {
    const openRevision = vi.fn()
    const setHighlight = vi.fn()
    renderHook(() => useRevisionDeepLink({ ...base, openRevision, setHighlight }), { wrapper: at('/views/v1?rev=40&hl=3') })
    expect(setHighlight).toHaveBeenCalledWith({ fromSeq: 3, toSeq: 40 })
    expect(openRevision).not.toHaveBeenCalled()
    expect(probe.search).toBe('')
  })

  it('ignores a highlight without a revision, and drops it', () => {
    const openRevision = vi.fn()
    const setHighlight = vi.fn()
    renderHook(() => useRevisionDeepLink({ ...base, openRevision, setHighlight }), { wrapper: at('/views/v1?hl=3') })
    expect(setHighlight).not.toHaveBeenCalled()
    expect(openRevision).not.toHaveBeenCalled()
    expect(probe.search).toBe('')
  })

  it.each(['12', '20', 'abc', '-1'])('opens the revision but drops &hl=%s, which names no earlier revision', (hl) => {
    const openRevision = vi.fn()
    const setHighlight = vi.fn()
    renderHook(() => useRevisionDeepLink({ ...base, openRevision, setHighlight }), { wrapper: at(`/views/v1?rev=12&hl=${hl}`) })
    expect(openRevision).toHaveBeenCalledWith({ seq: 12, headAtOpen: 40 })
    expect(setHighlight).not.toHaveBeenCalled()
    expect(probe.search).toBe('?rev=12')
  })

  it('drops a highlight beside a revision that names nothing', () => {
    const setHighlight = vi.fn()
    renderHook(() => useRevisionDeepLink({ ...base, openRevision: vi.fn(), setHighlight }), { wrapper: at('/views/v1?rev=41&hl=3') })
    expect(setHighlight).not.toHaveBeenCalled()
    expect(probe.search).toBe('')
  })

  it('leaves a highlight in the link while the link waits', () => {
    const setHighlight = vi.fn()
    renderHook(() => useRevisionDeepLink({ ...base, enabled: false, openRevision: vi.fn(), setHighlight }),
      { wrapper: at('/views/v1?rev=12&hl=3') })
    expect(setHighlight).not.toHaveBeenCalled()
    expect(probe.search).toBe('?rev=12&hl=3')
  })
})
