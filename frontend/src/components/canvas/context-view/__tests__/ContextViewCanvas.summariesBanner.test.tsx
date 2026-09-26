/**
 * What the board says when the connections between collapsed items are not
 * all there, on the real canvas.
 *
 *  - The source has no summaries yet, or only old ones: ONE plain banner
 *    about summaries, and no button.
 *  - A read could not summarise all of them (a branch's derived roll-ups hit
 *    a bound, or part of the read failed): the same slot, saying so. Not
 *    "narrow the selection", which cannot help.
 *  - "Narrow the selection" only for a cap on the answer's size.
 *
 * No data source is given, so the catching-up check never runs: these are
 * the cases it cannot explain (ContextViewCanvas.catchingUp covers it).
 */
import { waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useAuthStore } from '@/store/auth'

beforeEach(() => {
  useAuthStore.setState({ permissions: { global: ['system:admin'], ws: {} } } as never)
})

const banners = () => [...document.querySelectorAll('[data-testid="canvas-summaries-banner"]')]

async function canvasAnswering(extra: Record<string, unknown>) {
  const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', aggregatedExtra: extra })
  await waitFor(() => expect(h.aggregatedGranularities().length).toBeGreaterThan(0), { timeout: 6000 })
  return h
}

describe('summaries the source has not built', () => {
  it.each(['unmaterialized', 'legacy_cells'])('%s: one plain banner about summaries', async (reason) => {
    const h = await canvasAnswering({ stale: true, staleReason: reason })

    await waitFor(() => expect(banners()).toHaveLength(1), { timeout: 6000 })
    await h.settle()
    expect(banners()).toHaveLength(1)
    expect(banners()[0].textContent).toBe(
      'Connections between collapsed items haven’t been summarised for this source yet — open an item to see the connections inside it.',
    )
    expect(banners()[0].querySelector('button')).toBeNull()
  }, 20_000)
})

describe('summaries a read could not finish', () => {
  it.each(['derive_scope_cap', 'derive_hop_bound', 'degraded'])('%s: says so in the same slot, and not "narrow the selection"', async (reason) => {
    const h = await canvasAnswering({ stale: true, staleReason: reason, truncated: true })

    await waitFor(() => expect(banners()).toHaveLength(1), { timeout: 6000 })
    await h.settle()
    expect(banners()[0].textContent).toBe(
      'Some connections between collapsed items could not be summarised — open an item to see them.',
    )
    expect(document.body.textContent ?? '').not.toContain('narrow the selection')
  }, 20_000)
})

describe('an answer cut at its size cap', () => {
  it('says to narrow the selection, and nothing about summaries', async () => {
    const h = await canvasAnswering({ truncated: true })

    await waitFor(() => expect(document.body.textContent ?? '').toContain('narrow the selection'), { timeout: 6000 })
    await h.settle()
    expect(banners()).toHaveLength(0)
  }, 20_000)
})
