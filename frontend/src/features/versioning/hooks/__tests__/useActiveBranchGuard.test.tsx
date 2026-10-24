/**
 * useActiveBranchGuard — the client must never keep a dead branch as its editing scope.
 *
 * The dangerous failure here is the FALSE eviction: throwing someone out of a live draft because
 * its status was not known yet. So the "does NOT evict" cases matter at least as much as the
 * eviction itself. The status is the active branch's own, read from that one branch (its freshness),
 * not from a list of every draft ever made.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { useActiveBranchGuard } from '../useActiveBranchGuard'
import { useBranchStore } from '@/store/branchStore'

const BASE = {
  enabled: true,
  currentBranchId: 'br_1',
  unsavedCount: 0,
}

beforeEach(() => {
  useBranchStore.setState({ currentBranchId: 'br_1', originatingViewId: null, activeChangeSet: null })
})

const onMain = () => useBranchStore.getState().currentBranchId === null

describe('useActiveBranchGuard', () => {
  it('evicts to Published when the active branch has been merged', () => {
    const onEvict = vi.fn()
    renderHook(() =>
      useActiveBranchGuard({ ...BASE, status: 'merged', onEvict }),
    )
    expect(onMain()).toBe(true)
    expect(onEvict).toHaveBeenCalledWith({ branchId: 'br_1', status: 'merged', hadUnsavedEdits: false })
  })

  it('evicts when the branch was abandoned (discarded elsewhere)', () => {
    renderHook(() => useActiveBranchGuard({ ...BASE, status: 'abandoned' }))
    expect(onMain()).toBe(true)
  })

  it('reports unsaved edits so the surface can warn instead of silently dropping them', () => {
    const onEvict = vi.fn()
    renderHook(() =>
      useActiveBranchGuard({
        ...BASE, unsavedCount: 3, status: 'merged', onEvict,
      }),
    )
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ hadUnsavedEdits: true }))
  })

  it('does NOT evict while the branch is open', () => {
    renderHook(() => useActiveBranchGuard({ ...BASE, status: 'open' }))
    expect(onMain()).toBe(false)
  })

  it('does NOT evict while the branch is being published — a failed publish hands it back', () => {
    renderHook(() => useActiveBranchGuard({ ...BASE, status: 'publishing' }))
    expect(onMain()).toBe(false)
  })

  it('does NOT evict before the branch\'s status is known (unread, or a read that failed)', () => {
    renderHook(() => useActiveBranchGuard({ ...BASE, status: undefined }))
    expect(onMain()).toBe(false)
  })

  it('is inert when disabled, and on Published (no active branch)', () => {
    renderHook(() =>
      useActiveBranchGuard({ ...BASE, enabled: false, status: 'merged' }),
    )
    expect(onMain()).toBe(false)

    useBranchStore.setState({ currentBranchId: null })
    const onEvict = vi.fn()
    renderHook(() =>
      useActiveBranchGuard({
        ...BASE, currentBranchId: null, status: 'merged', onEvict,
      }),
    )
    expect(onEvict).not.toHaveBeenCalled()
  })

  it('fires onEvict once, not on every re-render', () => {
    const onEvict = vi.fn()
    const { rerender } = renderHook(
      (p: { status: string }) => useActiveBranchGuard({ ...BASE, status: p.status, onEvict }),
      { initialProps: { status: 'merged' } },
    )
    rerender({ status: 'merged' })   // a re-render, same status
    expect(onEvict).toHaveBeenCalledTimes(1)
  })
})
