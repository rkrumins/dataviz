/**
 * Expand next level / all levels / collapse everything inside, on the real
 * canvas — from an entity's menu, the way a reader does it, against a browse
 * canvas that holds only its roots, so every level's first page is fetched
 * through the canvas's own loader. And during a trace: the trace's cards
 * only, nothing fetched, nothing written.
 */
import { act, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { useCanvasStore } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import { useNotificationStore } from '@/components/ui/notifications'

const ROOTS = ['snowflake', 'INTERMEDIATE_T2', 'REPORTING', 'tableau']

const menuItem = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('[data-canvas-context-menu] button')]
  .find(b => label.test((b.querySelector('span.block')?.textContent ?? b.textContent ?? '').trim()))
const cards = (h: TraceCanvasHarness) => h.visibleCardIds()

async function menuOn(h: TraceCanvasHarness, id: string) {
  const row = document.querySelector<HTMLElement>(`#${CSS.escape(`layer-node-${id}`)}`)
  if (!row) throw new Error(`no card ${id}`)
  await act(async () => { fireEvent.contextMenu(row) })
  await h.settle()
}
async function choose(h: TraceCanvasHarness, label: RegExp) {
  const item = menuItem(label)
  if (!item) throw new Error(`the menu offers nothing like ${label}`)
  await act(async () => { fireEvent.click(item) })
  await h.settle()
}

beforeEach(() => { usePreferencesStore.setState({ expandDepthMode: 'level' }) })
afterEach(() => { useNotificationStore.setState({ notifications: [] }) })

describe('expand from the menu', () => {
  it('a level per press, then every level, then everything inside collapses and is let go', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', browseHolds: ROOTS })
    expect(cards(h)).not.toContain('orders')

    await menuOn(h, 'INTERMEDIATE_T2')
    await choose(h, /^Expand next level$/)
    await waitFor(() => expect(cards(h)).toContain('orders'))
    expect(cards(h)).not.toContain('orders.channel')

    await menuOn(h, 'INTERMEDIATE_T2')
    await choose(h, /^Expand next level$/)
    await waitFor(() => expect(cards(h)).toContain('orders.channel'))

    // Collapse everything inside: the container stays open on its first level.
    await menuOn(h, 'INTERMEDIATE_T2')
    await choose(h, /^Collapse everything inside$/)
    expect(cards(h)).toContain('orders')
    expect(cards(h)).not.toContain('orders.channel')
    // …and what those rows had loaded is let go.
    expect(useCanvasStore.getState().nodes.some(n => n.id === 'orders.channel')).toBe(false)

    // With nothing open beneath it, the way back is the row itself: Collapse.
    await menuOn(h, 'INTERMEDIATE_T2')
    expect(menuItem(/^Collapse everything inside$/)).toBeUndefined()
    await choose(h, /^Collapse$/)
    expect(cards(h)).not.toContain('orders')

    // The switch on the row: every level, remembered.
    await menuOn(h, 'REPORTING')
    const allLevels = document.querySelector<HTMLButtonElement>('[data-canvas-context-menu] [role="switch"][aria-label="All levels"]')!
    expect(allLevels).toHaveAttribute('aria-checked', 'false')
    await act(async () => { fireEvent.click(allLevels) })
    await h.settle()
    expect(usePreferencesStore.getState().expandDepthMode).toBe('all')
    await choose(h, /^Expand all levels$/)
    await waitFor(() => expect(cards(h)).toEqual(expect.arrayContaining(['rpt', 'rpt.channel', 'rpt.gross'])))
    await waitFor(() => expect(useNotificationStore.getState().notifications.at(-1)?.message)
      .toBe('Opened everything inside “REPORTING” · 3 loaded'))
  }, 30000)

  it('⇧→ and ⇧← on a focused row do the same', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', browseHolds: ROOTS })
    const scroller = () => document.querySelector<HTMLElement>('[data-layer-id="warehouse"] .custom-scrollbar[tabindex="0"]')!
    // The column lets go of its focused row whenever its rows change, so each
    // press starts with ↓ onto the first row (INTERMEDIATE_T2), as a reader's would.
    const onFirstRow = async (key: string) => {
      await act(async () => { fireEvent.keyDown(scroller(), { key: 'ArrowDown' }) })
      await act(async () => { fireEvent.keyDown(scroller(), { key, shiftKey: true }) })
    }
    await onFirstRow('ArrowRight')
    await waitFor(() => expect(cards(h)).toContain('orders'))
    await onFirstRow('ArrowRight')
    await waitFor(() => expect(cards(h)).toContain('orders.net'))
    await onFirstRow('ArrowLeft')
    await h.settle()
    expect(cards(h)).toContain('orders')
    expect(cards(h)).not.toContain('orders.net')
  }, 30000)
})

describe('expand during a trace', () => {
  it('opens only what the trace holds, and fetches and writes nothing', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    const before = h.visibleCardIds()
    usePreferencesStore.setState({ expandDepthMode: 'all' })

    // The warehouse container is open on the trace; the dataset inside it is not.
    await menuOn(h, 'INTERMEDIATE_T2')
    await choose(h, /^Expand all levels$/)
    await waitFor(() => expect(h.visibleCardIds()).toEqual(expect.arrayContaining(['orders.channel', 'orders.net'])))
    expect(h.visibleCardIds().length).toBeGreaterThan(before.length)
    expect(h.storeWrites()).toBe(0)

    await menuOn(h, 'INTERMEDIATE_T2')
    await choose(h, /^Collapse everything inside$/)
    expect(h.visibleCardIds()).toContain('orders')
    expect(h.visibleCardIds()).not.toContain('orders.channel')
    expect(h.storeWrites()).toBe(0)
    expect(h.isTracing()).toBe(true)
  }, 30000)
})
