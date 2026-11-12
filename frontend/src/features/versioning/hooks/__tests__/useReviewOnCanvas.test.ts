/**
 * A review on the canvas: its scope is drawn where a highlight can draw it, and each change it
 * visits is found in turn — one at a time, the outcome said, and a visit overtaken by the next
 * stopped without its outcome standing.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ChangeListRow } from '@/services/versioningApiService'
import { useBranchStore } from '@/store/branchStore'
import { useReviewStore } from '@/store/reviewStore'
import type { LocateOutcome } from '../../canvas/useLocateChange'
import { useReviewOnCanvas } from '../useReviewOnCanvas'

const row = (entityId: string): ChangeListRow => ({ entityId, kind: 'node', status: 'removed', structural: false })

beforeEach(() => {
  useBranchStore.getState().reset()
  useBranchStore.setState({ workspaceId: 'ws', dataSourceId: 'ds', viewId: 'v', graphId: 'g', mainHeadCommitSeq: 42 })
  useReviewStore.setState({ navigatorOpen: true, listOpen: false, scope: null, operation: null, filter: {}, current: null, position: 0, found: null })
})

describe('useReviewOnCanvas', () => {
  it('draws the latest revision while it is reviewed, and finds the change visited', async () => {
    const locate = vi.fn(async (): Promise<LocateOutcome> => 'found')
    renderHook(() => useReviewOnCanvas('v', locate))
    expect(useBranchStore.getState().highlight).toEqual({ fromSeq: 41, toSeq: 42 })

    await act(async () => { useReviewStore.getState().visit(row('a'), 0) })
    expect(locate).toHaveBeenCalledWith(row('a'), expect.any(Function))
    expect(useReviewStore.getState().found).toBe('found')
  })

  it('finds visits in turn, and lets the last one say how it went', async () => {
    let first!: (o: LocateOutcome) => void
    const wanted: Array<() => boolean> = []
    const locate = vi.fn((r: ChangeListRow, stillWanted: () => boolean) => {
      wanted.push(stillWanted)
      return r.entityId === 'a' ? new Promise<LocateOutcome>((resolve) => { first = resolve }) : Promise.resolve<LocateOutcome>('nearby')
    })
    renderHook(() => useReviewOnCanvas('v', locate))

    await act(async () => { useReviewStore.getState().visit(row('a'), 0) })
    expect(useReviewStore.getState().found).toBe('looking')
    await act(async () => { useReviewStore.getState().visit(row('b'), 1) })
    expect(locate).toHaveBeenCalledTimes(1)                                       // b waits for a
    expect(wanted[0]()).toBe(false)                                               // a has been overtaken

    await act(async () => { first('found') })
    expect(locate.mock.calls.map((c) => c[0].entityId)).toEqual(['a', 'b'])
    expect(useReviewStore.getState().found).toBe('nearby')                        // b's, not a's
  })
})
