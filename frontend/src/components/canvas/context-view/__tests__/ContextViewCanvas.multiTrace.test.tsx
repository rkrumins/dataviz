/**
 * A COMBINED TRACE on the real canvas — several entities traced as one.
 *
 * The walk layer always fetched every seed; what went wrong was the picture:
 * only the first seed was drawn as a focus, the others fell back to plain
 * hosts with no wires, and their partners vanished. Here two tables whose
 * lineage never meets are traced together, and BOTH sides have to be on the
 * board — each seed a focus row, each seed's partners a card, each seed's
 * flows a wire. Narrowing the trace from the dock re-draws what is already
 * in hand: no fetch.
 */
import { act, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { twoSeedEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore } from '@/store/canvas'

/** Each seed answers with its OWN walk, as the server walks each on its own. */
const estate = () => {
  const e = twoSeedEstate()
  return { ...e, seedModels: { orders: e.modelA, sales: e.modelB } }
}

const focusRows = () =>
  [...document.querySelectorAll<HTMLElement>('[data-trace-focus="true"]')]
    .map(row => row.id.replace(/^layer-node-/, ''))
    .sort()

const wireKeys = (h: { wires(): Array<{ source: string; target: string }> }) =>
  h.wires().map(w => `${w.source}>${w.target}`).sort()

describe('a combined trace of two entities', () => {
  it('draws both seeds as focus rows, both seeds’ partners, and both seeds’ wires', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTraceMany(['orders', 'sales'])

    expect(focusRows()).toEqual(['orders', 'sales'])
    // A's upstream (ledger, and audit one further) and B's downstream (dash,
    // and crm known only by its roll-up cell) — every one of them a card.
    const cards = h.visibleCardIds()
    for (const partner of ['ledger', 'audit', 'dash', 'crm']) expect(cards).toContain(partner)
    // Wires on each seed's side, not just the first's.
    expect(wireKeys(h)).toEqual(['audit>ledger', 'ledger>orders.amt', 'sales.amt>dash', 'sales>crm'])
    // The dock names the trace for what it is, and offers no link that
    // would carry only the first seed.
    expect(h.dockFocus()).toBe('2 entities')
    expect(screen.getByRole('button', { name: /tracing 2 entities/i })).toBeTruthy()
    expect(document.querySelector('[aria-label="Share this trace"]')).toBeNull()
    expect(h.storeWrites()).toBe(0)
  }, 30000)

  it('T with two entities selected traces both of them', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    act(() => {
      useCanvasStore.getState().selectNode('orders')
      useCanvasStore.getState().selectNode('sales', true)
    })
    await h.settle()

    await h.pressKey('t')
    await h.waitForCard('dash')

    expect(h.isTracing()).toBe(true)
    expect(focusRows()).toEqual(['orders', 'sales'])
    expect(h.visibleCardIds()).toContain('ledger')
    expect(h.dockFocus()).toBe('2 entities')
  }, 30000)

  it('removing a seed from the dock narrows the trace with no fetch', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTraceMany(['orders', 'sales'])
    const calls = h.providerCalls()

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /tracing 2 entities/i })) })
    await h.settle()
    const list = screen.getByRole('dialog', { name: 'Traced entities' })
    expect(list.textContent).toContain('orders')
    expect(list.textContent).toContain('sales')

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Remove sales from the trace' })) })
    await h.settle()

    expect(h.providerCalls()).toBe(calls)
    expect(h.isTracing()).toBe(true)
    expect(focusRows()).toEqual(['orders'])
    const cards = h.visibleCardIds()
    expect(cards).toContain('ledger')
    expect(cards).not.toContain('sales')
    expect(cards).not.toContain('dash')
    expect(wireKeys(h)).toEqual(['audit>ledger', 'ledger>orders.amt'])
    // One seed left is an ordinary trace: named, and its list gone with it.
    expect(h.dockFocus()).toBe('orders')
    expect(screen.queryByRole('dialog', { name: 'Traced entities' })).toBeNull()
    expect(h.storeWrites()).toBe(0)
  }, 30000)

  it('Back to a combined trace re-traces every seed of it', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTraceMany(['orders', 'sales'])
    h.pressEscape()
    await h.settle()
    await h.startTrace('orders')
    expect(focusRows()).toEqual(['orders'])

    await h.historyBack()
    await h.waitForCard('dash')
    expect(focusRows()).toEqual(['orders', 'sales'])
    expect(h.dockFocus()).toBe('2 entities')
  }, 30000)

  it('a different seed set on the same first seed opens as its own trace, not the last one’s picture', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTraceMany(['orders', 'sales'])
    h.pressEscape()
    await h.settle()
    await h.startTrace('orders')
    // The reader opens a partner on the one-seed trace…
    await h.toggle('ledger')
    expect(h.visibleCardIds()).toContain('ledger.amt')

    // …and Back to the combined trace, which was never expanded, opens it
    // as it opened: partners closed, whatever the last trace had open.
    await h.historyBack()
    await h.waitForCard('dash')
    expect(focusRows()).toEqual(['orders', 'sales'])
    expect(h.visibleCardIds()).toContain('ledger')
    expect(h.visibleCardIds()).not.toContain('ledger.amt')
  }, 30000)

  it('the trace history offers no link for a combined entry, which no link can carry', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTraceMany(['orders', 'sales'])
    h.pressEscape()
    await h.settle()
    await h.startTrace('orders')
    h.pressEscape()
    await h.settle()

    await h.openTraceHistory()
    const rows = [...document.querySelectorAll<HTMLElement>('[data-history-row]')].map(row => ({
      label: row.querySelector('[data-history-resume]')?.textContent ?? '',
      share: !!row.querySelector('[data-history-share]'),
    }))
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.label.includes('+ 1 more'))?.share).toBe(false)
    expect(rows.find(r => !r.label.includes('+ 1 more'))?.share).toBe(true)
  }, 30000)

  it('Escape closes the seed list first, then leaves the trace', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    const before = h.snapshotStore()
    await h.startTraceMany(['orders', 'sales'])

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /tracing 2 entities/i })) })
    await h.settle()
    expect(screen.getByRole('dialog', { name: 'Traced entities' })).toBeTruthy()

    h.pressEscape()
    await h.settle()
    expect(screen.queryByRole('dialog', { name: 'Traced entities' })).toBeNull()
    expect(h.isTracing()).toBe(true)

    h.pressEscape()
    await h.settle()
    expect(h.isTracing()).toBe(false)
    expect(h.snapshotStore()).toEqual(before)
  }, 30000)
})
