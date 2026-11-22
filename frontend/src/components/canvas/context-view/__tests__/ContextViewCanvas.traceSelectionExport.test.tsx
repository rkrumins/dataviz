/**
 * EXPORT FROM A TRACE, on the real canvas.
 *
 * A trace locks every edit, and its cards have no context menu, so the selection bar used to stay
 * away for the whole trace: cards could be selected and nothing could be done with them. Export
 * only reads, so it stays on offer: selecting cards in a trace brings the bar back with Export…
 * (and Clear) alone, for one card as for several, and Export… opens the Export dialog on them.
 * A data source without version control can't take the file back, so there it isn't offered.
 */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { twoSeedEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore } from '@/store/canvas'

const estate = () => {
  const e = twoSeedEstate()
  return { ...e, seedModels: { orders: e.modelA, sales: e.modelB } }
}

const bar = () => screen.queryByRole('region', { name: 'Selected entities' })

describe('export from a trace', () => {
  it('offers Export… alone for the cards selected in a trace, and opens the dialog on them', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders', versioned: true, dataSourceId: 'harness-ds' })
    await h.startTrace('orders')
    expect(bar()).toBeNull()

    act(() => { useCanvasStore.getState().selectNode('ledger') })
    await h.settle()
    const region = bar()!
    expect(within(region).getByText('ledger')).toBeTruthy()
    expect(within(region).getByRole('button', { name: 'Export…' })).toBeTruthy()
    for (const name of [/Trace all/, /Focus all/, /Link/, /Narrow/, /Compare/, /Details/]) {
      expect(within(region).queryByRole('button', { name })).toBeNull()
    }

    act(() => { useCanvasStore.getState().selectNode('orders', true) })
    await h.settle()
    await act(async () => { fireEvent.click(within(bar()!).getByRole('button', { name: 'Export…' })) })
    await h.settle()
    const dialog = screen.getByRole('dialog', { name: 'Export data' })
    expect(within(dialog).getByText('2 selected entities')).toBeTruthy()
    expect(h.storeWrites()).toBe(0)
  }, 30000)

  it('is not offered where the file could not come back: no version control', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTrace('orders')
    act(() => { useCanvasStore.getState().selectNode('ledger') })
    await h.settle()
    expect(bar()).toBeNull()
  }, 30000)
})
