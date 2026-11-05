/**
 * useRevisionDeepLink — the graph as it was is a link: `?rev=<seq>` opens that revision once the
 * view is resolved; the open revision is written back as `?rev=`, and closing it clears the param.
 * A seq at or past the head, or one that isn't a number, names nothing and is dropped. A revision is
 * of Published, so a `?branch=` beside it goes.
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

const base = { enabled: true, headSeq: 40, revisionSeq: null, scopeViewId: 'v1', activeViewId: 'v1' }

describe('useRevisionDeepLink', () => {
  it('opens the revision a link names, and drops a draft beside it', () => {
    const openRevision = vi.fn()
    renderHook(() => useRevisionDeepLink({ ...base, openRevision }), { wrapper: at('/views/v1?rev=12&branch=br_1') })
    expect(openRevision).toHaveBeenCalledWith({ seq: 12 })
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
})
