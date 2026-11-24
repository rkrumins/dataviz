/**
 * AN ENTITY'S DETAILS FROM THE TRACE DOCK, in every view.
 *
 * The Business view opens details on request, and during a trace its only
 * request — the selection bar's Details — stood aside whenever the selection
 * WAS the traced entity, on the assumption that the dock offered Details. It
 * didn't: its focus chip only named the entity. So a Business reader who
 * traced a dashboard could not read about that dashboard without leaving the
 * trace or knowing the right-click. The chip now opens the details and each
 * row of a combined trace's list does too — so no selection bar repeats them
 * for the traced entity, taking height from the columns.
 */
import { describe, expect, it } from 'vitest'
import { act, fireEvent, screen, within } from '@testing-library/react'

import { renderCanvasWithTrace, type TraceCanvasHarness } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { encodeTraceShare } from '@/hooks/lib/traceShareCodec'
import { useCanvasStore } from '@/store/canvas'

const selectionBar = () => document.querySelector<HTMLElement>('[role="region"][aria-label="Selected entities"]')

async function click(h: TraceCanvasHarness, el: HTMLElement) {
  await act(async () => { fireEvent.click(el) })
  await h.settle()
}

async function closeDrawer(h: TraceCanvasHarness) {
  await act(async () => { useCanvasStore.setState({ drawerNodeId: null }) })
  await h.settle()
}

describe('details from the trace dock', () => {
  it('Business: the focus chip opens the traced entity, which a click does not', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', persona: 'business' })
    await h.startTrace('cfo')
    expect(h.drawerEntity()).toBeNull()

    await click(h, screen.getByRole('button', { name: 'Open details for cfo' }))
    expect(h.drawerEntity()).toBe('cfo')
    expect(h.isTracing()).toBe(true)
    expect(h.storeWrites()).toBe(0)
  }, 30000)

  it('Business: no bar repeats the chip for the traced entity', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', persona: 'business' })
    await h.startTrace('cfo')
    // The dock's chip reads the traced entity; a bar saying the same would only
    // take height from the columns.
    expect(selectionBar()).toBeNull()
    expect(screen.getByRole('button', { name: 'Open details for cfo' })).toBeTruthy()
  }, 30000)

  it('Technical: the chip opens the details the trace put away; no bar for the traced entity', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', persona: 'technical' })
    await h.startTrace('cfo')
    // Entering a trace collapses the drawer, so the flow opens unobstructed.
    expect(h.drawerEntity()).toBeNull()
    // A click opens details here, so the bar has nothing to add for one entity.
    expect(selectionBar()).toBeNull()

    await click(h, screen.getByRole('button', { name: 'Open details for cfo' }))
    expect(h.drawerEntity()).toBe('cfo')
    await closeDrawer(h)
    await click(h, screen.getByRole('button', { name: 'Open details for cfo' }))
    expect(h.drawerEntity()).toBe('cfo')
  }, 30000)

  it('a combined trace: each seed in the list opens its own details', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', persona: 'business' })
    await h.startTraceMany(['orders', 'rpt'])
    expect(h.dockFocus()).toBe('2 entities')

    await click(h, screen.getByRole('button', { name: /tracing 2 entities/i }))
    const list = screen.getByRole('dialog', { name: 'Traced entities' })
    await click(h, within(list).getByRole('button', { name: 'Open details for rpt' }))
    expect(h.drawerEntity()).toBe('rpt')
    // The selection the trace started from is left as it was.
    expect(useCanvasStore.getState().selectedNodeIds).toEqual(['orders', 'rpt'])
    expect(h.isTracing()).toBe(true)
  }, 30000)

  it('a traced entity the canvas never loaded opens from what the walk holds', async () => {
    const token = encodeTraceShare({ urn: 'cfo', label: 'cfo', up: true, down: false, depthUp: 3, depthDown: 25, open: [] })
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      persona: 'business',
      search: `?trace=${token}`,
      browseHolds: ['snowflake', 'tableau', 'INTERMEDIATE_T2', 'REPORTING'],
    })
    await h.waitForCard('cfo')
    expect(useCanvasStore.getState().nodes.some(n => n.id === 'cfo')).toBe(false)

    await click(h, screen.getByRole('button', { name: 'Open details for cfo' }))
    expect(h.drawerEntity()).toBe('cfo')
  }, 30000)
})
