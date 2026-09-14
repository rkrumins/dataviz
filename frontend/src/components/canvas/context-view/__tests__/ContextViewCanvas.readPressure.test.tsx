/**
 * THE BOARD MUST SAY WHICH LIMIT, NOT JUST "SHOWING THE LARGEST".
 *
 * When the graph store refuses part of a read at its per-query memory
 * ceiling or time limit — after the read narrowed its pages and batches as
 * far as it goes — the canvas must say so in those words, must not fall back
 * to the generic "narrow the selection" advice alone, must not ask the
 * projector whether the source is behind (it is not), and must give a system
 * administrator the way to the node's limits. Driven through the canvas
 * harness, like the catching-up notice, because the signal travels a long
 * way before it reaches the board.
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
import { useAuthStore } from '@/store/auth'

const readiness = () => ({
  dataSourceId: 'harness-ds',
  isReady: true,
  aggregationStatus: 'ready',
  canCreateViews: true,
  driftDetected: false,
  aggregationEdgeCount: 0,
  message: 'ok',
})

async function canvasUnderPressure(kind: 'query_memory' | 'timeout') {
  return renderCanvasWithTrace(cfoEstate(), {
    focus: 'cfo',
    dataSourceId: 'harness-ds',
    aggregatedExtra: {
      stale: true, staleReason: kind, truncated: true,
      degradedDetail: { kind, narrowedPages: 3, degradedBatches: 1, endpoint: '10.0.0.1:6379', queryMemCapacity: 536_870_912 },
    },
  })
}

const banner = () => waitFor(
  () => {
    const el = document.querySelector('[data-testid="canvas-read-pressure-banner"]')
    if (!el) throw new Error('no read-pressure banner on the canvas')
    return el
  },
  { timeout: 6000 },
)

beforeEach(() => {
  getReadiness.mockReset()
  getReadiness.mockResolvedValue(readiness())
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

describe('the canvas says when the graph store refused part of a read', () => {
  it('names the per-query memory limit and links an administrator to the node’s limits', async () => {
    const h = await canvasUnderPressure('query_memory')
    const el = await banner()
    const text = el.textContent ?? ''
    expect(text).toContain('refused part of this read at its per-query memory limit')
    expect(text).toContain('showing what it could read after narrowing')
    expect(text).toContain('raise the per-query limit on the store')
    expect(document.querySelector('[data-testid="canvas-read-pressure-link"]'))
      .toHaveAttribute('href', '/admin/graph-store?limits=10.0.0.1%3A6379')
    // The generic truncation advice yields to the specific one …
    expect(document.body.textContent ?? '').not.toContain('Showing the largest relationships')
    // … and the projector is not asked: nothing is behind.
    expect(getReadiness).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ staleReason: expect.anything() }))
    expect(document.querySelector('[data-testid="lineage-catching-up"]')).toBeNull()
    await h.settle()
  })

  it('says a timeout is a timeout, and offers no link to a non-admin', async () => {
    useAuthStore.setState({ permissions: { global: [], ws: {} } } as never)
    const h = await canvasUnderPressure('timeout')
    const el = await banner()
    expect(el.textContent ?? '').toContain('timed out on part of this read')
    expect(el.textContent ?? '').toContain('raise the query time cap')
    expect(document.querySelector('[data-testid="canvas-read-pressure-link"]')).toBeNull()
    await h.settle()
  })
})
