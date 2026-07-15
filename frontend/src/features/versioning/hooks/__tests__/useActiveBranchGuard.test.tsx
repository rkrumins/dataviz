/**
 * useActiveBranchGuard — the client must never keep a dead branch as its editing scope.
 *
 * The dangerous failure here is the FALSE eviction: throwing someone out of a live draft because
 * the branches list was momentarily stale or view-scoped. So the "does NOT evict" cases matter at
 * least as much as the eviction itself.
 */
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { useActiveBranchGuard } from '../useActiveBranchGuard'
import { useBranchStore } from '@/store/branchStore'
import type { Branch } from '@/services/versioningApiService'

const branch = (branchId: string, status: string, kind = 'draft'): Branch =>
  ({ branchId, status, kind, name: branchId, baseCommitSeq: 1 } as unknown as Branch)

const BASE = {
  enabled: true,
  listRefreshing: false,
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
      useActiveBranchGuard({ ...BASE, branches: [branch('br_1', 'merged')], onEvict }),
    )
    expect(onMain()).toBe(true)
    expect(onEvict).toHaveBeenCalledWith({ branchId: 'br_1', status: 'merged', hadUnsavedEdits: false })
  })

  it('evicts when the branch was abandoned (discarded elsewhere)', () => {
    renderHook(() => useActiveBranchGuard({ ...BASE, branches: [branch('br_1', 'abandoned')] }))
    expect(onMain()).toBe(true)
  })

  it('reports unsaved edits so the surface can warn instead of silently dropping them', () => {
    const onEvict = vi.fn()
    renderHook(() =>
      useActiveBranchGuard({
        ...BASE, unsavedCount: 3, branches: [branch('br_1', 'merged')], onEvict,
      }),
    )
    expect(onEvict).toHaveBeenCalledWith(expect.objectContaining({ hadUnsavedEdits: true }))
  })

  it('does NOT evict while the branch is open', () => {
    renderHook(() => useActiveBranchGuard({ ...BASE, branches: [branch('br_1', 'open')] }))
    expect(onMain()).toBe(false)
  })

  it('does NOT evict on a stale list mid-refetch — a just-opened draft is not in it yet', () => {
    renderHook(() =>
      useActiveBranchGuard({ ...BASE, listRefreshing: true, branches: [branch('br_1', 'merged')] }),
    )
    expect(onMain()).toBe(false)
  })

  it('does NOT evict when the branch is merely ABSENT from the list (ambiguous, not dead)', () => {
    // A view-scoped slice, a permission edge, or a list that simply hasn't caught up. Ejecting here
    // would throw people out of drafts they had just opened.
    renderHook(() => useActiveBranchGuard({ ...BASE, branches: [branch('br_other', 'open')] }))
    expect(onMain()).toBe(false)
  })

  it('does NOT evict before the list has loaded at all', () => {
    renderHook(() => useActiveBranchGuard({ ...BASE, branches: undefined }))
    expect(onMain()).toBe(false)
  })

  it('is inert when disabled, and on Published (no active branch)', () => {
    renderHook(() =>
      useActiveBranchGuard({ ...BASE, enabled: false, branches: [branch('br_1', 'merged')] }),
    )
    expect(onMain()).toBe(false)

    useBranchStore.setState({ currentBranchId: null })
    const onEvict = vi.fn()
    renderHook(() =>
      useActiveBranchGuard({
        ...BASE, currentBranchId: null, branches: [branch('br_1', 'merged')], onEvict,
      }),
    )
    expect(onEvict).not.toHaveBeenCalled()
  })

  it('fires onEvict once, not on every re-render', () => {
    const onEvict = vi.fn()
    const { rerender } = renderHook(
      (p: { branches: Branch[] }) => useActiveBranchGuard({ ...BASE, branches: p.branches, onEvict }),
      { initialProps: { branches: [branch('br_1', 'merged')] } },
    )
    rerender({ branches: [branch('br_1', 'merged')] })   // new array identity, same data
    expect(onEvict).toHaveBeenCalledTimes(1)
  })
})
