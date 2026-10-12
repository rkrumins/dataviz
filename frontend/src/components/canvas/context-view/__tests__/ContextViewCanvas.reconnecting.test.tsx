/**
 * A NODE RESTARTING IS A SENTENCE ON THE BOARD, NOT AN ERROR WALL.
 *
 * When one graph store node goes away — a pod rotation, a promotion — the
 * answer on screen is the last good one and a fresh one is seconds away.
 * What every user of that graph used to get instead was "Provider XYZ
 * unavailable: Circuit open; will probe downstream again in ~28s", for 30s
 * at a time, over data the browser already had.
 *
 * So the board keeps its rollups, says what is happening in plain words,
 * and asks again by itself. Driven through the canvas harness like the
 * read-pressure banner, because the reason travels a long way to get here.
 */
import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const getReadiness = vi.fn()
vi.mock('@/services/aggregationService', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>()
  return {
    ...real,
    aggregationService: {
      ...(real.aggregationService as object),
      getReadiness: (...a: unknown[]) => Promise.resolve(getReadiness(...a)),
    },
  }
})

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'

const readiness = () => ({
  dataSourceId: 'harness-ds',
  isReady: true,
  aggregationStatus: 'ready',
  canCreateViews: true,
  driftDetected: false,
  aggregationEdgeCount: 0,
  message: 'ok',
})

const banner = () => waitFor(
  () => {
    const el = document.querySelector('[data-testid="canvas-provider-reconnecting-banner"]')
    if (!el) throw new Error('no reconnecting banner on the canvas')
    return el
  },
  { timeout: 6000 },
)

beforeEach(() => {
  getReadiness.mockReset()
  getReadiness.mockResolvedValue(readiness())
})

describe('the canvas while a graph store node is being replaced', () => {
  it('says it is reconnecting, keeps the answer, and promises no work of the user', async () => {
    await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      dataSourceId: 'harness-ds',
      aggregatedExtra: { stale: true, staleReason: 'failing_over' },
    })

    const text = (await banner()).textContent ?? ''
    expect(text).toContain('Reconnecting to the graph store')
    expect(text).toContain('restarting')
    expect(text).toContain('retrying automatically')
    // Never the breaker's words, and never a Retry button: it comes back.
    expect(document.body.textContent ?? '').not.toContain('Circuit open')
    expect(document.body.textContent ?? '')
      .not.toContain('The graph provider for this view is unavailable')
  })

  it('does not raise the read-pressure banner — nothing refused this read', async () => {
    await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      dataSourceId: 'harness-ds',
      aggregatedExtra: { stale: true, staleReason: 'failing_over' },
    })
    await banner()
    expect(document.querySelector('[data-testid="canvas-read-pressure-banner"]'))
      .toBeNull()
  })

  it('stays quiet when the store answered normally', async () => {
    await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', dataSourceId: 'harness-ds' })
    await waitFor(() => expect(document.body.textContent ?? '').not.toBe(''))
    expect(document.querySelector('[data-testid="canvas-provider-reconnecting-banner"]'))
      .toBeNull()
  })
})
