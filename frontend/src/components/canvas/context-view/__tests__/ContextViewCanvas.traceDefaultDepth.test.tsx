/**
 * A NEW TRACE OPENS AT THE READER'S DEFAULT DEPTH, on the real canvas.
 *
 * Every trace used to open on all 25 hops it walks. Now it opens on the reader's default (My
 * preferences, or the depth control's "Make this my default"): one hop each way until they choose,
 * so a busy estate opens on what an entity feeds and what feeds it. The walk still holds every hop,
 * so going deeper costs no fetch.
 */
import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { twoSeedEstate } from '@/test/fixtures/traceEstates'
import { usePreferencesStore } from '@/store/preferences'

/** `orders` is fed by `ledger` (one hop), which is fed by `audit` (two). */
const estate = () => {
  const e = twoSeedEstate()
  return { ...e, seedModels: { orders: e.modelA, sales: e.modelB } }
}

/** The header's Depth chip: "Depth ↑1 ↓1". */
const depthChip = () => screen.getByRole('button', { name: /^depth/i }).textContent ?? ''

afterEach(() => usePreferencesStore.setState({ defaultTraceDepth: { up: 1, down: 1 } }))

describe('the depth a new trace opens at', () => {
  it('is one hop each way until the reader chooses — and going deeper costs no fetch', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTrace('orders')

    expect(depthChip()).toMatch(/Depth.*1.*1/)
    expect(h.visibleCardIds()).toContain('ledger')
    expect(h.visibleCardIds()).not.toContain('audit')

    const walked = h.providerCalls()
    await h.depthPreset(/all hops/i)
    expect(h.visibleCardIds()).toContain('audit')
    expect(h.providerCalls()).toBe(walked)
  }, 30000)

  it('is the reader’s own default once they have one', async () => {
    usePreferencesStore.setState({ defaultTraceDepth: { up: 25, down: 25 } })
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTrace('orders')

    expect(depthChip()).toMatch(/Depth.*25.*25/)
    expect(h.visibleCardIds()).toContain('audit')
  }, 30000)
})
