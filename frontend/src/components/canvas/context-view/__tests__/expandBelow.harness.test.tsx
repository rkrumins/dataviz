/**
 * Expand next level / all levels / collapse everything inside, on the real
 * canvas — from an entity's menu, the way a reader does it, against a browse
 * canvas that holds only its roots, so every level's first page is fetched
 * through the canvas's own loader. And during a trace: the trace's cards
 * only, nothing fetched, nothing written. And a run paused at a checkpoint:
 * its choices, wherever it was started from, and what a trace does to it.
 */
import { act, fireEvent, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { renderCanvasWithTrace, type TraceCanvasHarness, type TraceEstate } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import type { LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import { useCanvasStore } from '@/store/canvas'
import { usePreferencesStore } from '@/store/preferences'
import { useNotificationStore } from '@/components/ui/notifications'

const ROOTS = ['snowflake', 'INTERMEDIATE_T2', 'REPORTING', 'tableau']

const menuItem = (label: RegExp) => [...document.querySelectorAll<HTMLButtonElement>('[data-canvas-context-menu] button')]
  .find(b => label.test((b.querySelector('span.block')?.textContent ?? b.textContent ?? '').trim()))
const cards = (h: TraceCanvasHarness) => h.visibleCardIds()
const messages = () => useNotificationStore.getState().notifications.map(n => n.message)
/** The run's prompt at a checkpoint, while it is up. */
const prompt = () => useNotificationStore.getState().notifications.find(n => n.paused)
const selectionBar = () => document.querySelector<HTMLElement>('[role="region"][aria-label="Selected entities"]')

/** Past a checkpoint: WH ⊃ 25 schemas ⊃ 100 tables each, and LAKE ⊃ one schema of 3. */
function warehouseEstate(): TraceEstate {
  const wn = (urn: string, type: string, childCount = 0) => ({
    id: urn, type: 'default', position: { x: 0, y: 0 },
    data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
  }) as unknown as LensWalkNode
  const nodes = [wn('WH', 'container', 25), wn('LAKE', 'container', 1), wn('lake.s', 'dataset', 3)]
  const containmentEdges = [{ sourceUrn: 'LAKE', targetUrn: 'lake.s' }]
  for (let i = 0; i < 25; i++) {
    const schema = `s${String(i).padStart(2, '0')}`
    nodes.push(wn(schema, 'dataset', 100))
    containmentEdges.push({ sourceUrn: 'WH', targetUrn: schema })
    for (let j = 0; j < 100; j++) {
      nodes.push(wn(`${schema}.t${j}`, 'schemaField'))
      containmentEdges.push({ sourceUrn: schema, targetUrn: `${schema}.t${j}` })
    }
  }
  for (let k = 0; k < 3; k++) {
    nodes.push(wn(`lake.s.t${k}`, 'schemaField'))
    containmentEdges.push({ sourceUrn: 'lake.s', targetUrn: `lake.s.t${k}` })
  }
  return {
    model: {
      focusUrn: 's00', nodes, lineageEdges: [], containmentEdges,
      upstreamUrns: new Set(), downstreamUrns: new Set(), frontierUp: [], frontierDown: [],
      truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
    },
    layers: [{ id: 'warehouse', name: 'Warehouse', order: 0, entityTypes: ['container'] }],
    assignments: { WH: { layerId: 'warehouse' }, LAKE: { layerId: 'warehouse' } },
  }
}

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

describe('a run paused at a checkpoint', () => {
  it('asks: more, everything or stop — and closed, the menu and the selection bar on its rows still offer that', async () => {
    const h = await renderCanvasWithTrace(warehouseEstate(), { focus: 's00', browseHolds: ['WH', 'LAKE'] })
    usePreferencesStore.setState({ expandDepthMode: 'all' })
    act(() => {
      useCanvasStore.getState().selectNode('WH')
      useCanvasStore.getState().selectNode('LAKE', true)
    })
    await h.settle()
    await menuOn(h, 'WH')
    await choose(h, /^Expand all levels$/)
    await waitFor(() => expect(prompt()).toBeDefined(), { timeout: 15000 })
    // The roots' 26, then twenty schemas' 2,000; five schemas and the lake's are still closed.
    expect(prompt()).toMatchObject({
      message: 'Paused opening 2 entities\u00a0· 2,026 loaded so far',
      detail: '6 containers still to open at level 2',
      action: { label: 'Load 2,000 more' }, secondaryAction: { label: 'Load everything' }, tertiaryAction: { label: 'Stop here' },
    })

    // Its ✕: still paused, and offered where it was started.
    act(() => useNotificationStore.getState().remove(prompt()!.id))
    await h.settle()
    await menuOn(h, 'LAKE')
    expect(menuItem(/^Load 2,000 more$/)).toBeDefined()
    expect(menuItem(/^Load everything$/)).toBeDefined()
    expect(menuItem(/^Stop here$/)).toBeDefined()
    expect(menuItem(/^Expand all levels$/)).toBeUndefined()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    const bar = within(selectionBar()!).getByRole('group', { name: 'Paused opening 2 entities\u00a0· 2,026 loaded so far' })
    await act(async () => { fireEvent.click(within(bar).getByRole('button', { name: 'Load everything' })) })
    // The five schemas left and the lake's, with no checkpoint between: the run's 2,529 in all.
    await waitFor(() => expect(messages()).toContain('Opened everything inside 2 entities · 2,529 loaded'), { timeout: 15000 })
    expect(prompt()).toBeUndefined()
    const held = new Set(useCanvasStore.getState().nodes.map(n => n.id))
    expect(['s24.t99', 'lake.s.t2'].every(id => held.has(id))).toBe(true)
  }, 60000)

  it('on other rows the menu and the bar are their own, and their Expand replaces the paused run', async () => {
    const h = await renderCanvasWithTrace(warehouseEstate(), { focus: 's00', browseHolds: ['WH', 'LAKE'] })
    usePreferencesStore.setState({ expandDepthMode: 'all' })
    await menuOn(h, 'WH')
    await choose(h, /^Expand all levels$/)
    await waitFor(() => expect(prompt()?.message).toBe('Paused opening “WH”\u00a0· 2,025 loaded so far'), { timeout: 15000 })
    expect(prompt()!.detail).toBe('5 containers still to open at level 2')

    await menuOn(h, 'LAKE')
    expect(menuItem(/^Load 2,000 more$/)).toBeUndefined()
    await choose(h, /^Expand all levels$/)
    expect(messages()).toContain('Stopped opening “WH” · 2,025 loaded')
    await waitFor(() => expect(messages()).toContain('Opened everything inside “LAKE” · 4 loaded'), { timeout: 15000 })
    expect(prompt()).toBeUndefined()
  }, 60000)

  it('a trace ends it — the trace\'s menu and bar are the trace\'s own', async () => {
    const h = await renderCanvasWithTrace(warehouseEstate(), { focus: 's00', browseHolds: ['WH', 'LAKE'] })
    usePreferencesStore.setState({ expandDepthMode: 'all' })
    await menuOn(h, 'WH')
    await choose(h, /^Expand all levels$/)
    await waitFor(() => expect(prompt()).toBeDefined(), { timeout: 15000 })

    await h.startTrace('s00')
    expect(prompt()).toBeUndefined()
    expect(messages()).toContain('Stopped opening “WH” · 2,025 loaded')
    await menuOn(h, 'WH')
    expect(menuItem(/^Load 2,000 more$/)).toBeUndefined()
    expect(menuItem(/^Stop opening$/)).toBeUndefined()
    expect(menuItem(/^(Expand all levels|Collapse everything inside|Collapse)$/)).toBeDefined()
    await act(async () => { fireEvent.keyDown(document, { key: 'Escape' }) })
    // Held in the trace, WH's bar offers the trace's own Expand and Collapse.
    act(() => { useCanvasStore.getState().selectNode('WH') })
    await h.settle()
    const bar = within(selectionBar()!)
    expect(bar.queryByRole('button', { name: 'Load 2,000 more' })).toBeNull()
    expect(bar.getByRole('group', { name: 'Open what is inside' })).toBeInTheDocument()
    expect(h.storeWrites()).toBe(0)
  }, 60000)
})
