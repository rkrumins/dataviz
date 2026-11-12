/**
 * useRevisionGuard — a past revision the canvas can't draw is never drawn: one its plan says is too
 * far back closes, and History opens on its comparison with now. So does one Published moved too far
 * on from while it was open, which a graph read at it learns first (409 revision_too_far).
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { REVISION_TOO_FAR_EVENT } from '@/providers/RemoteGraphProvider'
import type { RevisionInfo } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { useVersioningPanelStore } from '@/store/versioningPanelStore'
import { useRevisionGuard } from '../useRevisionViewer'

const plan = (openable: boolean): { data: RevisionInfo; error: null } => ({
  data: {
    commit: {}, headSeq: 90, changedSince: openable ? 40 : 100_001, limit: 100_000, openable,
    reason: openable ? null : 'too_far',
  },
  error: null,
})

/** What the provider says when the server refuses a read at `asOfSeq` as too far back. */
const refusedAt = (asOfSeq: number) =>
  act(() => { window.dispatchEvent(new CustomEvent(REVISION_TOO_FAR_EVENT, { detail: { asOfSeq } })) })

const COMPARISON = { fromSeq: 12, toSeq: null, notice: 'too_far' }

beforeEach(() => {
  useBranchStore.getState().reset()
  useVersioningPanelStore.getState().clearRequest()
  useBranchStore.getState().openRevision({ seq: 12, headAtOpen: 90 })
})

describe('useRevisionGuard', () => {
  it('hands a revision its plan says is too far back over to its comparison with now', () => {
    renderHook(() => useRevisionGuard(12, plan(false)))
    expect(useBranchStore.getState().revision).toBeNull()
    expect(useVersioningPanelStore.getState()).toMatchObject({ requestedTab: 'history', requestedCompare: COMPARISON })
  })

  it('does the same when a graph read at the open revision is refused as too far back', () => {
    renderHook(() => useRevisionGuard(12, plan(true)))
    expect(useBranchStore.getState().revision?.seq).toBe(12)
    refusedAt(12)
    expect(useBranchStore.getState().revision).toBeNull()
    expect(useVersioningPanelStore.getState()).toMatchObject({ requestedTab: 'history', requestedCompare: COMPARISON })
  })

  it('leaves the open revision alone when the refused read was of another, or the view has gone', () => {
    const { unmount } = renderHook(() => useRevisionGuard(12, plan(true)))
    refusedAt(7)
    expect(useBranchStore.getState().revision?.seq).toBe(12)
    unmount()
    refusedAt(12)
    expect(useBranchStore.getState().revision?.seq).toBe(12)
    expect(useVersioningPanelStore.getState().requestedCompare).toBeNull()
  })
})
