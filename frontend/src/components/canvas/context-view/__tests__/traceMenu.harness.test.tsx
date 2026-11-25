/**
 * TRACING FROM INSIDE A TRACE, on the real canvas.
 *
 * A right-click during a trace used to do nothing at all — the menu returned
 * before it opened, after the browser's own menu had been suppressed — so the
 * one place a reader looks for "trace from here" was dead exactly while they
 * were reading a trace. Now the menu opens read-only, leads with the trace's
 * own actions, and says why there is nothing to edit; the selection bar offers
 * the same; and Shift+double-click re-roots. None of it writes the store.
 */
import { act, fireEvent } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'

/** The context menu on screen, portaled to the body. */
const menu = () => [...document.querySelectorAll('span')]
  .find(el => /^(Node|Edge|Canvas) Actions$/.test(el.textContent?.trim() ?? ''))
  ?.closest<HTMLElement>('.fixed') ?? null
/** Its items, by label, in order. */
const menuLabels = () => [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  .map(b => (b.querySelector('span.block')?.textContent ?? b.textContent ?? '').trim())
const menuItem = (label: string) => [...(menu()?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
  .find(b => (b.querySelector('span.block')?.textContent ?? b.textContent ?? '').trim() === label)

async function cardMenu(h: TraceCanvasHarness, id: string) {
  const row = document.querySelector<HTMLElement>(`#${CSS.escape(`layer-node-${id}`)}`)
  if (!row) throw new Error(`no card ${id}`)
  await act(async () => { fireEvent.contextMenu(row) })
  await h.settle()
}
async function choose(h: TraceCanvasHarness, label: string) {
  const item = menuItem(label)
  if (!item) throw new Error(`the menu offers no "${label}" (it has ${menuLabels().join(', ')})`)
  await act(async () => { fireEvent.click(item) })
  await h.settle()
}

describe('the menu during a trace', () => {
  it('opens on a trace card, leads with the trace, offers no edits, and says why', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft: true })
    // Control: in browse, on a draft, the menu edits.
    await cardMenu(h, 'tableau')
    expect(menuLabels()).toContain('View & Edit')
    expect(menuLabels()).toContain('Delete')
    expect(menuLabels()).toContain('Move to another parent…')
    h.pressEscape()
    await h.settle()

    await h.startTrace('cfo')
    await cardMenu(h, 'orders')
    expect(menuLabels().slice(0, 2)).toEqual(['Trace from here', 'Add to this trace'])
    expect(menuLabels()).toContain('View details')
    for (const write of ['View & Edit', 'Delete', 'Duplicate…', 'Add Child Entity', 'Connect To…', 'Link to…', 'Move to Layer', 'Move to another parent…']) {
      expect(menuLabels()).not.toContain(write)
    }
    expect(menu()).toHaveTextContent('Editing is paused while tracing')

    // Esc puts the menu away — only the menu: leaving the trace is a second press.
    h.pressEscape()
    await h.settle()
    expect(menu()).toBeNull()
    expect(h.isTracing()).toBe(true)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('Trace from here starts a new trace, and Back returns to the one before', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    expect(h.dockFocus()).toBe('cfo')

    await cardMenu(h, 'orders')
    await choose(h, 'Trace from here')
    expect(h.dockFocus()).toBe('orders')

    await h.historyBack()
    expect(h.dockFocus()).toBe('cfo')
    await h.historyForward()
    expect(h.dockFocus()).toBe('orders')
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('Add to this trace widens the trace on screen, and Remove narrows it again', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')

    await cardMenu(h, 'rpt')
    await choose(h, 'Add to this trace')
    expect(h.dockFocus()).toBe('2 entities')
    // Not a new trace: Back has nothing before it to return to.
    expect(document.querySelector<HTMLButtonElement>('[aria-label="Previous trace"]')?.disabled ?? true).toBe(true)

    // A starting point is offered for removal; the card it is not, for adding.
    await cardMenu(h, 'rpt')
    expect(menuLabels()).toContain('Remove from this trace')
    expect(menuLabels()).not.toContain('Add to this trace')
    await choose(h, 'Remove from this trace')
    expect(h.dockFocus()).toBe('cfo')
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('Exit trace in the menu ends the trace', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    await cardMenu(h, 'orders')
    const exit = [...(menu()?.querySelectorAll('button') ?? [])].find(b => b.textContent?.trim() === 'Exit trace')
    await act(async () => { fireEvent.click(exit!) })
    await h.settle()
    expect(h.isTracing()).toBe(false)
  }, 30000)
})

describe('re-rooting without the menu', () => {
  it('Shift+double-click on a trace card traces from it', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    const row = document.querySelector<HTMLElement>('#layer-node-orders')!
    await act(async () => { fireEvent.doubleClick(row, { shiftKey: true }) })
    await h.settle()
    expect(h.dockFocus()).toBe('orders')
    expect(h.storeWrites()).toBe(0)
  }, 30000)

  it('the selection bar offers Trace from here and Add to trace for a card picked on the trace', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', persona: 'business' })
    await h.startTrace('cfo')
    await h.clickCard('rpt')
    const bar = document.querySelector<HTMLElement>('[role="region"][aria-label="Selected entities"]')
    expect(bar).toBeTruthy()
    const add = [...bar!.querySelectorAll('button')].find(b => b.textContent?.includes('Add to trace'))
    await act(async () => { fireEvent.click(add!) })
    await h.settle()
    expect(h.dockFocus()).toBe('2 entities')
    expect(h.storeWrites()).toBe(0)
  }, 30000)
})
