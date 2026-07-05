/**
 * Branch-per-view scoping: a draft/edit branch is isolated per (workspace, data source,
 * VIEW) — the backend now resolves + filters drafts by `originating_view_id` (branch-per-view,
 * Tasks 1-2), so the frontend branch store must key its scope on viewId too. Switching the
 * active view must NOT show another view's draft (no cross-view leak), matching the existing
 * cross-data-source isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBranchStore, useEffectiveBranchId } from '../branchStore'
import type { ResolveResponse } from '@/services/versioningApiService'

const INITIAL_STATE = {
  workspaceId: null,
  dataSourceId: null,
  viewId: null,
  graphId: null,
  mainBranchId: null,
  mainHeadCommitSeq: 0,
  currentBranchId: null,
  originatingViewId: null,
  activeChangeSet: null,
  committedDiffHidden: false,
  mainEpoch: 0,
}

const resolveResponse = (over: Partial<ResolveResponse> = {}): ResolveResponse => ({
  graphId: 'g1',
  mainBranchId: 'br_main',
  mainHeadCommitSeq: 5,
  ...over,
})

const reset = () => useBranchStore.setState({ ...INITIAL_STATE })

describe('branchStore — per-view scoping', () => {
  beforeEach(reset)

  it('branchIdForScope differs for the same (ws, ds) across different views', () => {
    const { setResolved, switchToDraft, branchIdForScope } = useBranchStore.getState()
    setResolved({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1' }, resolveResponse())
    switchToDraft('br_v1', 'v1')

    expect(branchIdForScope('ws1', 'ds1', 'v1')).toBe('br_v1')
    // Same (ws, ds), a DIFFERENT view — must not see v1's branch.
    expect(branchIdForScope('ws1', 'ds1', 'v2')).toBeNull()
  })

  it('setResolved for view v2 does not return v1\'s branchId (clears on view switch)', () => {
    const { setResolved, switchToDraft } = useBranchStore.getState()
    setResolved({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1' }, resolveResponse())
    switchToDraft('br_v1', 'v1')
    expect(useBranchStore.getState().currentBranchId).toBe('br_v1')

    // Resolving for a DIFFERENT view on the SAME (ws, ds) — v2 has no draft of its own.
    setResolved({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v2' }, resolveResponse())
    expect(useBranchStore.getState().currentBranchId).toBeNull()
    expect(useBranchStore.getState().originatingViewId).toBeNull()
  })

  it('sameScope is false across views — re-resolving the SAME view preserves state, a DIFFERENT view clears it', () => {
    const { setResolved, switchToDraft } = useBranchStore.getState()
    setResolved({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1' }, resolveResponse())
    switchToDraft('br_v1', 'v1')

    // Re-resolving the SAME scope (same view) must NOT clear the active draft.
    setResolved({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1' }, resolveResponse({ mainHeadCommitSeq: 6 }))
    expect(useBranchStore.getState().currentBranchId).toBe('br_v1')
    expect(useBranchStore.getState().mainHeadCommitSeq).toBe(6)

    // Switching to a different view on the same data source clears it.
    setResolved({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v2' }, resolveResponse())
    expect(useBranchStore.getState().currentBranchId).toBeNull()
  })

  it('resuming a view adopts its own open draft from the resolve (myDraft), not Published', () => {
    const { setResolved } = useBranchStore.getState()
    // Enter v1 whose backend-resolved draft is br_v1 → the store must RESUME it (edit mode),
    // not silently drop it and open Published. This is the branch-per-view resume contract.
    setResolved(
      { workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1' },
      resolveResponse({ myDraft: { branchId: 'br_v1', originatingViewId: 'v1' } }),
    )
    expect(useBranchStore.getState().currentBranchId).toBe('br_v1')
    expect(useBranchStore.getState().originatingViewId).toBe('v1')
  })

  it('switching to a draft-less view opens Published; returning to the view resumes its draft', () => {
    const { setResolved } = useBranchStore.getState()
    const scope = (viewId: string) => ({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId })
    const v1Draft = resolveResponse({ myDraft: { branchId: 'br_v1', originatingViewId: 'v1' } })

    setResolved(scope('v1'), v1Draft)
    expect(useBranchStore.getState().currentBranchId).toBe('br_v1')

    // v2 has no draft of its own → Published (read) mode.
    setResolved(scope('v2'), resolveResponse())
    expect(useBranchStore.getState().currentBranchId).toBeNull()

    // Back to v1 → its unpublished draft is restored (this is what "not done" was: it was lost).
    setResolved(scope('v1'), v1Draft)
    expect(useBranchStore.getState().currentBranchId).toBe('br_v1')
  })

  it('a same-scope refetch does NOT override the user\'s explicit switch to Published', () => {
    const { setResolved, switchToMain } = useBranchStore.getState()
    const v1Draft = resolveResponse({ myDraft: { branchId: 'br_v1', originatingViewId: 'v1' } })
    setResolved({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1' }, v1Draft)
    expect(useBranchStore.getState().currentBranchId).toBe('br_v1')

    switchToMain() // user deliberately views Published while their draft stays open server-side
    expect(useBranchStore.getState().currentBranchId).toBeNull()

    // A background resolve refetch of the SAME view still reports the open draft — it must NOT
    // yank the user back into the draft (adoption happens only on a scope CHANGE).
    setResolved({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1' }, v1Draft)
    expect(useBranchStore.getState().currentBranchId).toBeNull()
  })

  it('useEffectiveBranchId returns the per-view branch only for its own view', () => {
    const { setResolved, switchToDraft } = useBranchStore.getState()
    setResolved({ workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1' }, resolveResponse())
    switchToDraft('br_v1', 'v1')

    const forV1 = renderHook(() => useEffectiveBranchId('ws1', 'ds1', 'v1'))
    expect(forV1.result.current).toBe('br_v1')

    const forV2 = renderHook(() => useEffectiveBranchId('ws1', 'ds1', 'v2'))
    expect(forV2.result.current).toBeNull()

    // Omitting viewId keeps the existing (ws, ds)-only contract for untouched callers.
    const noViewArg = renderHook(() => useEffectiveBranchId('ws1', 'ds1'))
    expect(noViewArg.result.current).toBe('br_v1')
  })
})
