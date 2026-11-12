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
import { buildChangeSet } from '@/features/versioning/model/changeModel'

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
    s.openRevision({ seq: 12, headAtOpen: 40, message: 'Quarter close' })
    expect(useBranchStore.getState()).toMatchObject({
      revision: { seq: 12, message: 'Quarter close' }, currentBranchId: null,
    })
    useBranchStore.getState().closeRevision()
    expect(useBranchStore.getState().revision).toBeNull()
  })

  it('closes when a draft opens, when Published is chosen, and when the scope changes', () => {
    const s = useBranchStore.getState()
    s.openRevision({ seq: 12, headAtOpen: 40 })
    s.switchToDraft('br_1')
    expect(useBranchStore.getState().revision).toBeNull()

    useBranchStore.getState().openRevision({ seq: 12, headAtOpen: 40 })
    useBranchStore.getState().switchToMain()
    expect(useBranchStore.getState().revision).toBeNull()

    useBranchStore.getState().openRevision({ seq: 12, headAtOpen: 40 })
    useBranchStore.getState().setResolved(SCOPE, resolved)          // the same view, refetched
    expect(useBranchStore.getState().revision?.seq).toBe(12)
    useBranchStore.getState().setResolved({ ...SCOPE, viewId: 'v2' }, resolved)
    expect(useBranchStore.getState().revision).toBeNull()
  })

  it('reads in the scope it was opened in, and nowhere else', () => {
    useBranchStore.getState().openRevision({ seq: 7, headAtOpen: 40 })
    expect(renderHook(() => useEffectiveRevision('ws1', 'ds1', 'v1')).result.current).toBe(7)
    expect(renderHook(() => useEffectiveRevision('ws1', 'ds1')).result.current).toBe(7)
    expect(renderHook(() => useEffectiveRevision('ws1', 'ds1', 'v2')).result.current).toBeNull()
    expect(renderHook(() => useEffectiveRevision('ws1', 'ds2', 'v1')).result.current).toBeNull()
  })

  it('never clears the rings of the draft that is open, when a highlight changes or a revision closes', () => {
    const s = useBranchStore.getState()
    s.switchToDraft('br_1', 'v1')
    const draftRings = buildChangeSet([])
    useBranchStore.getState().setActiveChangeSet(draftRings)
    useBranchStore.getState().setHighlight(null)
    useBranchStore.getState().closeRevision()
    expect(useBranchStore.getState().activeChangeSet).toBe(draftRings)
    // On Published they were a comparison's, and go with it.
    useBranchStore.getState().switchToMain()
    useBranchStore.getState().setActiveChangeSet(buildChangeSet([]))
    useBranchStore.getState().setHighlight(null)
    expect(useBranchStore.getState().activeChangeSet).toBeNull()
  })

  it('keeps the head it opened at as Published moves on, until it is re-pinned to a newer one', () => {
    const s = useBranchStore.getState()
    s.setHighlight({ fromSeq: 3, toSeq: 12 })
    s.openRevision({ seq: 12, headAtOpen: 40 })
    const rings = buildChangeSet([])
    useBranchStore.getState().setActiveChangeSet(rings)
    useBranchStore.getState().setResolved(SCOPE, { ...resolved, mainHeadCommitSeq: 43 })    // a publish
    expect(useBranchStore.getState().revision?.headAtOpen).toBe(40)

    // Re-pinned, it is the same revision: its highlight and rings stay.
    useBranchStore.getState().repinRevision(43)
    expect(useBranchStore.getState()).toMatchObject({
      revision: { seq: 12, headAtOpen: 43 }, highlight: { fromSeq: 3, toSeq: 12 }, activeChangeSet: rings,
    })
    useBranchStore.getState().closeRevision()
    useBranchStore.getState().repinRevision(44)
    expect(useBranchStore.getState().revision).toBeNull()
  })

  it('keeps a highlight only while it shows the revision on the canvas', () => {
    const s = useBranchStore.getState()
    s.setHighlight({ fromSeq: 3, toSeq: 12 })
    s.openRevision({ seq: 12, headAtOpen: 40 })
    expect(useBranchStore.getState().highlight).toEqual({ fromSeq: 3, toSeq: 12 })
    useBranchStore.getState().openRevision({ seq: 20, headAtOpen: 40 })
    expect(useBranchStore.getState().highlight).toBeNull()
    useBranchStore.getState().setHighlight({ fromSeq: 3, toSeq: 20 })
    useBranchStore.getState().closeRevision()
    expect(useBranchStore.getState().highlight).toBeNull()
  })
})
