/**
 * THE CANVAS GATE for the Stage 1 trace-overlay rebuild.
 *
 * Everything the view model proves in isolation, proved again where it
 * actually has to hold: on the real `ContextViewCanvas`, driven the way a
 * reader drives it — select the dashboard, press Trace Lineage, look.
 *
 * The claim in one line: a trace draws the focus's chain open, its partners
 * CLOSED with honest counts, one wire per flow at the grain the reader has
 * earned — and writes NOTHING to the canvas store, so leaving it puts the
 * canvas back exactly as it was.
 *
 * EXPECTED RED until the canvas swap (Task 8). The canvas still merges the
 * walk into the store and renders it through the browse hierarchy; this file
 * is what says when that has stopped.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { countTest, expectTestsRan } from '@/test/canary'

beforeEach(() => countTest())
afterAll(() => expectTestsRan(1))

describe('the trace overlay on the real canvas', () => {
  it('CFO trace: dashboard chain open, partners closed with counts, two rolled wires, zero store writes, exit restores', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')

    expect(h.visibleCardIds().sort()).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
    expect(h.chevron('INTERMEDIATE_T2')).toBe(true)
    // Grain: with the dashboard open, the raw hops re-anchor to the CHART the
    // reader has earned — not to the dashboard they already opened past — and
    // the authored container→dashboard rollups are covered by them, so they
    // are dropped rather than drawn a level apart. See traceViewModel.wires.
    expect(h.wires().map(w => `${w.source}>${w.target}`).sort()).toEqual(['INTERMEDIATE_T2>aov', 'REPORTING>aov'])
    expect(h.storeWrites()).toBe(0)

    const before = h.snapshotStore()
    h.pressEscape()
    expect(h.isTracing()).toBe(false)
    expect(h.snapshotStore()).toEqual(before)
  }, 30000)
})
