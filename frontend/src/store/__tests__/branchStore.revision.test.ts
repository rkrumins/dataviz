/**
 * A past revision of Published, opened on the canvas: read-only, like checking out a commit. It is
 * of Published, so opening one leaves the draft you were in, and opening a draft — or going back to
 * Published — closes it. It belongs to the view it was opened in, and a highlight of two revisions
 * stays only while it shows the revision on the canvas.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBranchStore, useEffectiveRevision } from '../branchStore'
import type { ResolveResponse } from '@/services/versioningApiService'

const resolved: ResolveResponse = { graphId: 'g1', mainBranchId: 'br_main', mainHeadCommitSeq: 40 }
const SCOPE = { workspaceId: 'ws1', dataSourceId: 'ds1', viewId: 'v1' }

beforeEach(() => {
  useBranchStore.getState().reset()
  useBranchStore.getState().setResolved(SCOPE, resolved)
})

describe('branchStore — a past revision', () => {
  it('opens on Published, leaving the draft, and closes back to the graph as it is', () => {
    const s = useBranchStore.getState()
    s.switchToDraft('br_1', 'v1')
    s.openRevision({ seq: 12, message: 'Quarter close' })
    expect(useBranchStore.getState()).toMatchObject({
      revision: { seq: 12, message: 'Quarter close' }, currentBranchId: null,
    })
    useBranchStore.getState().closeRevision()
    expect(useBranchStore.getState().revision).toBeNull()
  })

  it('closes when a draft opens, when Published is chosen, and when the scope changes', () => {
    const s = useBranchStore.getState()
    s.openRevision({ seq: 12 })
    s.switchToDraft('br_1')
    expect(useBranchStore.getState().revision).toBeNull()

    useBranchStore.getState().openRevision({ seq: 12 })
    useBranchStore.getState().switchToMain()
    expect(useBranchStore.getState().revision).toBeNull()

    useBranchStore.getState().openRevision({ seq: 12 })
    useBranchStore.getState().setResolved(SCOPE, resolved)          // the same view, refetched
    expect(useBranchStore.getState().revision?.seq).toBe(12)
    useBranchStore.getState().setResolved({ ...SCOPE, viewId: 'v2' }, resolved)
    expect(useBranchStore.getState().revision).toBeNull()
  })

  it('reads in the scope it was opened in, and nowhere else', () => {
    useBranchStore.getState().openRevision({ seq: 7 })
    expect(renderHook(() => useEffectiveRevision('ws1', 'ds1', 'v1')).result.current).toBe(7)
    expect(renderHook(() => useEffectiveRevision('ws1', 'ds1')).result.current).toBe(7)
    expect(renderHook(() => useEffectiveRevision('ws1', 'ds1', 'v2')).result.current).toBeNull()
    expect(renderHook(() => useEffectiveRevision('ws1', 'ds2', 'v1')).result.current).toBeNull()
  })

  it('keeps a highlight only while it shows the revision on the canvas', () => {
    const s = useBranchStore.getState()
    s.setHighlight({ fromSeq: 3, toSeq: 12 })
    s.openRevision({ seq: 12 })
    expect(useBranchStore.getState().highlight).toEqual({ fromSeq: 3, toSeq: 12 })
    useBranchStore.getState().openRevision({ seq: 20 })
    expect(useBranchStore.getState().highlight).toBeNull()
    useBranchStore.getState().setHighlight({ fromSeq: 3, toSeq: 20 })
    useBranchStore.getState().closeRevision()
    expect(useBranchStore.getState().highlight).toBeNull()
  })
})
