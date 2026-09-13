/**
 * THE SILENCE THIS FILE GATES.
 *
 * A data source whose read cache trails its published history serves main
 * reads out of the version log, which carries none of the rolled-up
 * connections. The canvas drew the cards and almost none of the wires, said
 * nothing at all about it, and a reader spent a day looking for the bug in
 * the frontend. Everything below exists to make that condition impossible to
 * ship silently again: the prompt that starts the check, the reading that is
 * allowed to raise the notice, the readings that are NOT, the recovery, and
 * the exact words on the board.
 *
 * WHAT THESE TESTS DO NOT CATCH. They pin the decision and the copy, not the
 * pixels: nothing here proves the banner is legible, correctly placed, or
 * unobscured by the canvas's floating chrome. jsdom cannot run the ReactFlow
 * viewport or the column virtualizers, so layout and paint are out of reach
 * from any test in this repo — those remain a real-browser check.
 */
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getReadiness = vi.fn()
const invalidateAggregatedEdges = vi.fn()

vi.mock('@/services/aggregationService', () => ({
  aggregationService: { getReadiness: (...a: unknown[]) => getReadiness(...a) },
}))
vi.mock('@/hooks/useAggregatedLineage', () => ({
  invalidateAggregatedEdges: () => invalidateAggregatedEdges(),
}))

import {
  useProjectionCatchUp,
  shouldAskProjector,
  catchUpMessage,
  ROLLUP_INTEGRITY_REASONS,
} from '@/hooks/useProjectionCatchUp'

/** A readiness answer. Everything the hook does not read is omitted. */
const ready = (over: Record<string, unknown> = {}) => ({
  dataSourceId: 'ds-1',
  isReady: true,
  aggregationStatus: 'ready',
  ...over,
})

beforeEach(() => {
  getReadiness.mockReset()
  invalidateAggregatedEdges.mockReset()
  getReadiness.mockResolvedValue(ready())
})
afterEach(() => { vi.useRealTimers() })

describe('which stale reasons prompt the check', () => {
  it('prompts on every reason that means the answer came back short', () => {
    for (const reason of ROLLUP_INTEGRITY_REASONS) {
      expect(shouldAskProjector(reason)).toBe(true)
    }
    // The five the backend can actually emit on this path, spelled out so a
    // renamed constant cannot quietly shrink the set to nothing.
    expect([...ROLLUP_INTEGRITY_REASONS].sort()).toEqual([
      'degraded', 'derive_hop_bound', 'derive_scope_cap', 'legacy_cells', 'unmaterialized',
    ])
  })

  it('does NOT prompt on source_changed — a rebuild is not a source being behind', () => {
    // source_changed serves the PREVIOUS COMPLETE answer and owns its own
    // banner. Folding it in would make every ordinary rebuild accuse the
    // source of falling behind.
    expect(shouldAskProjector('source_changed')).toBe(false)
  })

  it('does not prompt on a fresh answer or an unknown reason', () => {
    expect(shouldAskProjector(null)).toBe(false)
    expect(shouldAskProjector(undefined)).toBe(false)
    expect(shouldAskProjector('')).toBe(false)
    expect(shouldAskProjector('something_new')).toBe(false)
  })
})

describe('the words on the board', () => {
  it('never uses the internal vocabulary', () => {
    // The canvas is an end-user surface. These five words are banned on it.
    for (const msg of [catchUpMessage(null), catchUpMessage(1), catchUpMessage(902)]) {
      for (const banned of ['projection', 'watermark', 'commit', 'rollup', 'AGGREGATED']) {
        expect(msg.toLowerCase()).not.toContain(banned.toLowerCase())
      }
    }
  })

  it('says it is not the reader’s doing, and that it clears itself', () => {
    // The failure mode was people assuming they had broken their own view.
    expect(catchUpMessage(null)).toContain('Nothing is wrong with your view')
    expect(catchUpMessage(null)).toContain('clears on its own')
  })

  it('quotes the concrete number when the wire gave one, and pluralises it', () => {
    expect(catchUpMessage(902)).toContain('about 902 recent changes behind')
    expect(catchUpMessage(1)).toContain('about 1 recent change behind')
  })

  it('falls back to a number-free sentence when the wire gave none', () => {
    // Null means "not said" — inventing a 0 here would read as "up to date".
    expect(catchUpMessage(null)).toContain('still being brought up to date')
    expect(catchUpMessage(null)).not.toMatch(/\d/)
    expect(catchUpMessage(0)).not.toMatch(/about 0/)
  })
})

describe('what the hook asks, and what it is willing to claim', () => {
  it('issues NO request at all on a healthy canvas', async () => {
    const { result } = renderHook(() => useProjectionCatchUp('ds-1', null))
    await act(async () => { await Promise.resolve() })
    expect(getReadiness).not.toHaveBeenCalled()
    expect(result.current.catchingUp).toBe(false)
  })

  it('issues no request while a rebuild is running', async () => {
    renderHook(() => useProjectionCatchUp('ds-1', 'source_changed'))
    await act(async () => { await Promise.resolve() })
    expect(getReadiness).not.toHaveBeenCalled()
  })

  it('raises the notice on an affirmative false, carrying the number', async () => {
    getReadiness.mockResolvedValue(ready({ projectorCurrent: false, projectionCommitsBehind: 902 }))
    const { result } = renderHook(() => useProjectionCatchUp('ds-1', 'derive_hop_bound'))
    await waitFor(() => expect(result.current.catchingUp).toBe(true))
    expect(result.current.commitsBehind).toBe(902)
  })

  /**
   * Raise the notice for real, THEN change the answer. Waiting on
   * `getReadiness` having been CALLED is not enough and was the bug in the
   * first draft of this file: the call is recorded synchronously, so the
   * assertion ran against the hook's initial `false` and passed no matter
   * what the hook did with the response. Every silence test below therefore
   * starts from an observed `true` — which proves the readings really are
   * being consumed — and asserts that the new answer puts it back down.
   */
  async function raisedThenAnswering(over: Record<string, unknown>) {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getReadiness.mockResolvedValue(ready({ projectorCurrent: false, projectionCommitsBehind: 3 }))
    const { result } = renderHook(() => useProjectionCatchUp('ds-1', 'degraded', 1000))
    await waitFor(() => expect(result.current.catchingUp).toBe(true))
    getReadiness.mockResolvedValue(ready(over))
    await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
    return result
  }

  it('stays silent on NULL — unknown is not behind, and not up to date either', async () => {
    // Null is the reading for an unversioned source, for a versioned graph
    // pinned to no graph target, and for a store that could not be read.
    // Accusing any of those of being behind would be a false alarm on a
    // healthy board — so a raised notice must come straight back down.
    const result = await raisedThenAnswering({ projectorCurrent: null, projectionCommitsBehind: null })
    await waitFor(() => expect(result.current.catchingUp).toBe(false))
    expect(result.current.commitsBehind).toBeNull()
  })

  it('stays silent when the source is current', async () => {
    const result = await raisedThenAnswering({ projectorCurrent: true, projectionCommitsBehind: 0 })
    await waitFor(() => expect(result.current.catchingUp).toBe(false))
    expect(result.current.commitsBehind).toBeNull()
  })

  it('asks nothing when there is no data source to ask about', async () => {
    renderHook(() => useProjectionCatchUp(null, 'degraded'))
    await act(async () => { await Promise.resolve() })
    expect(getReadiness).not.toHaveBeenCalled()
  })

  it('drops the cached short answer once when the source catches up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getReadiness.mockResolvedValue(ready({ projectorCurrent: false, projectionCommitsBehind: 5 }))
    const { result } = renderHook(() => useProjectionCatchUp('ds-1', 'degraded', 1000))
    await waitFor(() => expect(result.current.catchingUp).toBe(true))
    // While it is still behind, nothing is invalidated — a poll that dropped
    // the cache every tick would refetch the canvas forever.
    expect(invalidateAggregatedEdges).not.toHaveBeenCalled()

    getReadiness.mockResolvedValue(ready({ projectorCurrent: true, projectionCommitsBehind: 0 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
    await waitFor(() => expect(result.current.catchingUp).toBe(false))
    // Exactly once, on the edge: the canvas is holding rollups it cached
    // during the wedge and would serve them for the full TTL otherwise.
    expect(invalidateAggregatedEdges).toHaveBeenCalledTimes(1)
  })

  it('gives up after three consecutive failures instead of hammering readiness', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    getReadiness.mockRejectedValue(new Error('403'))
    renderHook(() => useProjectionCatchUp('ds-1', 'degraded', 1000))
    await waitFor(() => expect(getReadiness).toHaveBeenCalledTimes(1))
    await act(async () => { await vi.advanceTimersByTimeAsync(3500) })
    const settled = getReadiness.mock.calls.length
    expect(settled).toBeLessThanOrEqual(3)
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(getReadiness).toHaveBeenCalledTimes(settled)
  })
})
