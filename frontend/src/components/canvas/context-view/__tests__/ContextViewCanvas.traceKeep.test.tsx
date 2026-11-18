/**
 * EXPORT & SAVE on the real canvas — a combined trace taken away as a file,
 * and kept in this browser with what it found.
 *
 * The file is the board's scope: every entity the trace shows, open or not,
 * on the sides being read. A saved trace is listed where traces are picked
 * up, re-exports without a walk, and — opened again — says what moved.
 */
import 'fake-indexeddb/auto'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { twoSeedEstate } from '@/test/fixtures/traceEstates'

const estate = () => {
  const e = twoSeedEstate()
  return { ...e, seedModels: { orders: e.modelA, sales: e.modelB } }
}

/** Every file the canvas hands the browser, as text. */
let files: string[] = []
beforeEach(() => {
  files = []
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    void (blob as Blob).text().then(t => files.push(t))
    return 'blob:harness'
  })
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

const openKeep = async () => {
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Export and save this trace' })) })
  return screen.getByRole('dialog', { name: 'Export and save this trace' })
}
const choose = async (panel: HTMLElement, what: string) => {
  await act(async () => { fireEvent.click(panel.querySelector<HTMLButtonElement>(`[data-keep="${what}"]`)!) })
}
const csvUrns = (text: string) => text.replace(/^﻿/, '').trim().split('\r\n').slice(1).map(l => l.split(',')[0])

describe('Export & save on a combined trace', () => {
  it('the CSV holds every entity the trace shows, open or not, and no host', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTraceMany(['orders', 'sales'])
    const panel = await openKeep()
    expect(panel.querySelector('[data-keep-holds]')?.textContent).toMatch(/What the trace shows/)

    await choose(panel, 'csv')
    await waitFor(() => expect(files).toHaveLength(1))
    const urns = csvUrns(files[0]!)
    for (const u of ['orders', 'sales', 'ledger.amt', 'audit.amt', 'dash.amt']) expect(urns).toContain(u)
    // Containers are paths, not rows.
    for (const host of ['RAW', 'FIN', 'MART']) expect(urns).not.toContain(host)
    // Closed cards are still in the file.
    expect(h.visibleCardIds()).not.toContain('audit.amt')
  }, 30000)

  it('the JSON carries the seeds, the question that found them and the flows', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTraceMany(['orders', 'sales'])
    await choose(await openKeep(), 'json')
    await waitFor(() => expect(files).toHaveLength(1))
    const doc = JSON.parse(files[0]!)
    expect(doc.meta.seeds.map((s: { urn: string }) => s.urn)).toEqual(['orders', 'sales'])
    expect(doc.spec).toMatchObject({ seeds: { urns: ['orders', 'sales'] }, expand: { upstream: 'all', downstream: 'all' } })
    expect(doc.edges.length).toBeGreaterThan(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('a saved trace is listed, re-exports with no walk, and survives a reload', async () => {
    const h = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await h.startTraceMany(['orders', 'sales'])
    let panel = await openKeep()
    await choose(panel, 'save')
    await waitFor(() => expect(panel.querySelector('[data-saved-trace]')).toBeTruthy())
    expect(panel.textContent).toMatch(/Saved ✓/)

    const calls = h.providerCalls()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download the saved results of 2 entities as CSV/ }))
    })
    await waitFor(() => expect(files).toHaveLength(1))
    expect(csvUrns(files[0]!)).toContain('dash.amt')
    expect(h.providerCalls()).toBe(calls)

    // A new visit: the list is read back from IndexedDB.
    cleanup()
    const again = await renderCanvasWithTrace(estate(), { focus: 'orders' })
    await again.startTrace('orders')
    panel = await openKeep()
    await waitFor(() => expect(panel.querySelector('[data-saved-trace]')).toBeTruthy())
  }, 30000)
})
