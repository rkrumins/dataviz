/**
 * THE BOARD MUST SAY IT, NOT JUST KNOW IT.
 *
 * The hook's own unit tests pin the decision and the wording. This file pins
 * the only thing that actually saved anyone: that the sentence reaches the
 * REAL canvas and is on screen next to the lineage that is missing. Driven
 * through the canvas harness rather than a mock, because the failure being
 * gated was precisely a signal that arrived, was carried all the way to the
 * component, and was then dropped on the floor by two consumers that both
 * hard-matched a different reason.
 *
 * WHAT THESE TESTS DO NOT CATCH — and it is a lot:
 *  • Layout, legibility and stacking. jsdom runs neither the ReactFlow
 *    viewport nor the column virtualizers, so nothing here proves the banner
 *    is visible, readable in either theme, or clear of the canvas's floating
 *    chrome. That is a real-browser check and stays one.
 *  • That the connections really are missing underneath it. The harness
 *    provider answers no aggregated edges either way.
 *  • The poll cadence and the recovery refetch — those are unit-tested in
 *    `src/hooks/__tests__/useProjectionCatchUp.test.ts` against the clock.
 */
import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getReadiness = vi.fn()
vi.mock('@/services/aggregationService', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...real,
    aggregationService: {
      ...(real.aggregationService as object),
      getReadiness: (...a: unknown[]) => {
        const p = Promise.resolve(getReadiness(...a))
        answers.push(p)
        return p
      },
    },
  }
})

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'

/** Every readiness promise the canvas has been handed, so a test can await
 *  the exact answer the hook awaited before asserting on what it did with it.
 *  Waiting on the CALL alone is recorded synchronously and proves nothing. */
let answers: Array<Promise<unknown>> = []

/**
 * Give the notice every chance to appear, then assert it did not.
 *
 * A negative assertion on this canvas is only worth something if the code
 * under test actually ran, and getting there takes two hops: the aggregated
 * fan-out is debounced 300 ms before the stale reason exists at all, and only
 * then does the hook poll readiness. Worse, OTHER canvas surfaces poll the
 * same endpoint on mount, so "a readiness answer arrived" is not evidence
 * that THIS hook asked for one. So: wait for the aggregated request that
 * carries the stale reason, then flush repeatedly — each round lets one more
 * await chain land — before looking. Proven to fail when the hook treats an
 * unknown reading as "behind".
 */
async function settleAfterStaleReason(h: { settle: () => Promise<void>; aggregatedGranularities: () => Array<string | null> }) {
  await waitFor(() => expect(h.aggregatedGranularities().length).toBeGreaterThan(0), { timeout: 6000 })
  for (let round = 0; round < 6; round++) {
    await act(async () => {
      await Promise.all(answers)
      await Promise.resolve()
    })
    await h.settle()
  }
}

const readiness = (over: Record<string, unknown> = {}) => ({
  dataSourceId: 'harness-ds',
  isReady: true,
  aggregationStatus: 'ready',
  canCreateViews: true,
  driftDetected: false,
  aggregationEdgeCount: 0,
  message: 'ok',
  ...over,
})

/** Mount the browse canvas with the rollup layer answering SHORT — the exact
 *  shape a source that has fallen behind produces. */
async function canvasWithShortRollups() {
  return renderCanvasWithTrace(cfoEstate(), {
    focus: 'cfo',
    dataSourceId: 'harness-ds',
    aggregatedExtra: { stale: true, staleReason: 'derive_hop_bound', truncated: true },
  })
}

beforeEach(() => {
  getReadiness.mockReset()
  // A DEFAULT ANSWER IS NOT OPTIONAL. This mock replaces readiness for the
  // WHOLE canvas, and the Data Loads panel polls it too — an unset mock hands
  // that component `undefined` and the mount dies in someone else's code for
  // a reason that has nothing to do with what is being tested here.
  answers = []
  getReadiness.mockResolvedValue(readiness())
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

describe('the canvas explains a source that is still catching up', () => {
  it('puts the explanation on the board, with how far behind', async () => {
    getReadiness.mockResolvedValue(
      readiness({ projectorCurrent: false, projectionCommitsBehind: 902 }),
    )
    const h = await canvasWithShortRollups()
    const notice = await waitFor(
      () => {
        const el = document.querySelector('[data-testid="lineage-catching-up"]')
        if (!el) throw new Error('no catching-up notice on the canvas')
        return el
      },
      { timeout: 6000 },
    )
    const text = notice.textContent ?? ''
    expect(text).toContain('Connections are still catching up')
    expect(text).toContain('about 902 recent changes behind')
    // It must not read as the reader's own mistake — that assumption is what
    // sent someone into the frontend for a day.
    expect(text).toContain('Nothing is wrong with your view')
    // Plain language: the internal vocabulary never reaches the board.
    for (const banned of ['projection', 'watermark', 'commit', 'rollup', 'aggregated']) {
      expect(text.toLowerCase()).not.toContain(banned)
    }
    await h.settle()
  })

  it('does not also tell the reader to narrow the selection', async () => {
    // The rollup layer reported `truncated`, which normally earns the
    // "Showing the largest relationships — narrow the selection to see more"
    // banner. Under a source that is behind, that advice is simply wrong:
    // narrowing cannot recover connections the source is not serving yet.
    getReadiness.mockResolvedValue(
      readiness({ projectorCurrent: false, projectionCommitsBehind: 5 }),
    )
    const h = await canvasWithShortRollups()
    await waitFor(
      () => {
        if (!document.querySelector('[data-testid="lineage-catching-up"]')) {
          throw new Error('no catching-up notice on the canvas')
        }
      },
      { timeout: 6000 },
    )
    expect(document.body.textContent ?? '').not.toContain('narrow the selection')
    await h.settle()
  })

  it('says nothing when the source is up to date', async () => {
    // Same short answer from the rollup layer — an ordinary cap, not a wedge.
    // The canvas must not accuse a healthy source of being behind.
    getReadiness.mockResolvedValue(
      readiness({ projectorCurrent: true, projectionCommitsBehind: 0 }),
    )
    const h = await canvasWithShortRollups()
    await settleAfterStaleReason(h)
    expect(document.querySelector('[data-testid="lineage-catching-up"]')).toBeNull()
  })

  it('says nothing when the reading is unknown', async () => {
    // Null is the answer for an unversioned source, a versioned graph pinned
    // to no graph target, and a store that could not be read. Unknown is not
    // healthy, but it is not a claim the board is allowed to make either.
    getReadiness.mockResolvedValue(
      readiness({ projectorCurrent: null, projectionCommitsBehind: null }),
    )
    const h = await canvasWithShortRollups()
    await settleAfterStaleReason(h)
    expect(document.querySelector('[data-testid="lineage-catching-up"]')).toBeNull()
  })

  it('says nothing when the rollup layer answered in full', async () => {
    // No stale reason at all: the wires on the board are the whole picture,
    // so there is nothing to explain and no notice to raise.
    //
    // This does NOT assert "no request was made". Readiness is polled by
    // other canvas surfaces on their own schedule, so a call count here would
    // be measuring them. That this hook issues no request on a healthy canvas
    // is pinned where it belongs, against the hook itself, in
    // `src/hooks/__tests__/useProjectionCatchUp.test.ts`.
    getReadiness.mockResolvedValue(
      readiness({ projectorCurrent: false, projectionCommitsBehind: 902 }),
    )
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      dataSourceId: 'harness-ds',
    })
    await h.settle()
    expect(document.querySelector('[data-testid="lineage-catching-up"]')).toBeNull()
  })
})
