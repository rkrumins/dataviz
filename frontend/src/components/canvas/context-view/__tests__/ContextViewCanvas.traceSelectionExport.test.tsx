/**
 * EXPORT FROM A TRACE, on the real canvas.
 *
 * A trace locks every edit, so the selection bar used to stay away for the whole trace: cards
 * could be selected and nothing could be done with them. Selecting cards in a trace now brings the
 * trace's own bar — trace from them, add them to the trace (traceMenu.harness.test) — and Export…,
 * which only reads, for one card as for several; Export… opens the Export dialog on them. A data
 * source without version control can't take the file back, so there Export… isn't offered.
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
  it('offers Export… beside the trace\'s own actions, none of browse\'s, and opens the dialog on them', async () => {
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
    // The trace's own bar, without Export….
    expect(within(bar()!).getByRole('button', { name: /Trace from here/ })).toBeTruthy()
    expect(within(bar()!).queryByRole('button', { name: 'Export…' })).toBeNull()
  }, 30000)
})
