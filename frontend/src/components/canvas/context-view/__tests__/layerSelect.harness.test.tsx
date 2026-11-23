/**
 * "Select all in <Layer>" on the real canvas — from the layer's menu, from an
 * empty column's menu and from ⌘A in the column, one answer: every entity the
 * layer has loaded, inside folded containers too, minus what a search filter
 * has taken off the canvas. "Select everything" is every layer's, not every
 * node the store happens to hold.
 */
import { act, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore } from '@/store/canvas'
import { useSearchStore } from '@/store/searchStore'

// Everything the browse canvas loaded into the Warehouse layer — the two
// containers, folded, and all that is inside them.
const WAREHOUSE = ['INTERMEDIATE_T2', 'orders', 'orders.channel', 'orders.net', 'REPORTING', 'rpt', 'rpt.channel', 'rpt.gross']
const REPORT = ['tableau', 'cfo', 'aov', 'aov.channel', 'aov.avg']

const selected = () => [...useCanvasStore.getState().selectedNodeIds].sort()
const column = (layerId: string) => document.querySelector<HTMLElement>(`[data-layer-id="${layerId}"]`)!
const menuButton = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('[data-canvas-context-menu] button')]
  .find(b => label.test(b.textContent ?? ''))

async function choose(h: TraceCanvasHarness, label: RegExp) {
  const item = menuButton(label)
  if (!item) throw new Error(`the menu offers nothing like ${label}`)
  await act(async () => { fireEvent.click(item) })
  await h.settle()
}

afterEach(() => {
  useSearchStore.setState({ matchUrnSet: new Set(), ancestorMatchCounts: new Map(), canvasFilterMode: 'highlight' } as never)
})

describe('select all in a layer', () => {
  it('from the layer\'s menu: everything loaded in it, folded containers\' insides too', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    // The layer's name, in its header: a right-click there opens the layer's menu.
    const name = [...column('warehouse').querySelectorAll<HTMLElement>('*')]
      .find(el => el.childElementCount === 0 && el.textContent?.trim() === 'Warehouse')!
    await act(async () => { fireEvent.contextMenu(name) })
    await h.settle()
    await choose(h, /^Select all in Warehouse \(8\)$/)
    expect(selected()).toEqual([...WAREHOUSE].sort())
  }, 30000)

  it('⌘A in the column agrees, and an empty column\'s menu offers it beside everything', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    const scroller = column('warehouse').querySelector<HTMLElement>('.custom-scrollbar[tabindex="0"]')!
    await act(async () => { fireEvent.keyDown(scroller, { key: 'a', metaKey: true }) })
    await h.settle()
    expect(selected()).toEqual([...WAREHOUSE].sort())

    act(() => { useCanvasStore.getState().clearSelection() })
    await h.layerContextMenu()
    expect(menuButton(/^Select all in Warehouse \(8\)$/)).toBeTruthy()
    await choose(h, /^Select everything/)
    // Every layer's — and not `snowflake`, which the store holds and no layer places.
    expect(selected()).toEqual([...WAREHOUSE, ...REPORT].sort())
  }, 30000)

  it('leaves out what an Isolate search has taken off the canvas', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    act(() => {
      useSearchStore.setState({
        matchUrnSet: new Set(['orders.net']),
        ancestorMatchCounts: new Map([['INTERMEDIATE_T2', 1], ['orders', 1]]),
        canvasFilterMode: 'isolate',
      } as never)
    })
    await h.settle()
    await h.layerContextMenu()
    await choose(h, /^Select all in Warehouse \(3\)$/)
    expect(selected()).toEqual(['INTERMEDIATE_T2', 'orders', 'orders.net'])
  }, 30000)
})
