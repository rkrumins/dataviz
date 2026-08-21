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
 * GREEN since the canvas swap (Task 8): the canvas renders the overlay's
 * lanes and wires, and every path that used to grow the store during a trace
 * — the walk merge, expand-fetch, reveal, load-more — now yields to it. This
 * file is what keeps it that way.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { renderCanvasWithTrace } from '@/test/canvasHarness'
import { cfoEstate } from '@/test/fixtures/traceEstates'
import { countTest, expectTestsRan } from '@/test/canary'

beforeEach(() => countTest())
afterAll(() => expectTestsRan(17))

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
    // A trace keeps its wires bare — no count pills on the lines, ever.
    expect(document.querySelectorAll('[data-edge-badge]').length).toBe(0)
    // The cards carry the count instead, behind a dock setting that is ON by
    // default and can be switched off for a quieter board.
    expect(h.countPill('INTERMEDIATE_T2')).toBe('3 on this lineage')
    await h.setLineageCounts(false)
    expect(h.countPill('INTERMEDIATE_T2')).toBeNull()
    expect(h.chevron('INTERMEDIATE_T2')).toBe(true)   // the invitation stays
    await h.setLineageCounts(true)
    expect(h.countPill('INTERMEDIATE_T2')).toBe('3 on this lineage')
    expect(h.storeWrites()).toBe(0)

    const before = h.snapshotStore()
    h.pressEscape()
    expect(h.isTracing()).toBe(false)
    expect(h.snapshotStore()).toEqual(before)
  }, 30000)

  // The landing frame proves the trace never merged. This proves the reader
  // cannot MAKE it merge: opening a partner is a re-projection of the model
  // the session already holds, so it costs one level of cards and no fetch.
  it('expanding a closed partner reveals ONE level and still writes nothing', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    const before = h.snapshotStore()

    const toggle = document
      .querySelector<HTMLElement>('#layer-node-INTERMEDIATE_T2')
      ?.querySelector('button')
    expect(toggle).toBeTruthy()
    await act(async () => { fireEvent.click(toggle!) })
    await h.settle()

    // `orders` and nothing under it: R1 opens the way to things, never the
    // things themselves.
    expect(h.visibleCardIds().sort())
      .toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'orders', 'tableau'])
    expect(h.storeWrites()).toBe(0)
    expect(h.snapshotStore()).toEqual(before)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // CHILD SEARCH is the one browse action that could not be undone: it
  // `removeNodes`/`removeEdges` a parent's loaded children and `addGraph`s
  // the hits, recording nothing about what it dropped. Both halves are
  // checked here — the affordance is withdrawn, and the handler behind it
  // refuses anyway.
  it('child search is withdrawn during a trace, and refuses if reached', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })

    // Browse offers it, and opening the box is a normal browse interaction.
    expect(h.childSearchButton('tableau')).toBe(true)
    await h.openChildSearch('tableau')

    await h.startTrace('cfo')
    const before = h.snapshotStore()

    // The magnifier is gone from trace rows…
    expect(h.childSearchButton('tableau')).toBe(false)
    // …and the box opened before the trace is still mounted, so this really
    // does reach the canvas's handler — the exact keystroke path, no mock.
    expect(await h.typeChildSearch('orders')).toBe(true)

    expect(h.storeWrites()).toBe(0)
    expect(h.snapshotStore()).toEqual(before)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // A walk takes as long as it takes. The canvas must not empty out for the
  // duration and fill back in — the reader keeps the picture they had until
  // the trace has something real to replace it with.
  it('the walk never blanks the canvas: browse stays until the focus lands', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', deferTrace: true })
    const browse = h.visibleCardIds().sort()
    expect(browse).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'tableau'])

    await h.startTrace('cfo')
    // The session is open — the dock and its loading state are live…
    expect(h.isTracing()).toBe(true)
    // …and the canvas is still the browse canvas, unchanged.
    expect(h.visibleCardIds().sort()).toEqual(browse)

    await h.resolveTrace()
    expect(h.visibleCardIds().sort())
      .toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // Counts a reader can act on: the row says what is inside it on this
  // lineage, the column says what the whole lane contributes. Neither counts
  // rows — hosts are containers the flow passes through, never things on it.
  it('rows and columns report what is ON THIS LINEAGE, not what is loaded', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')

    // orders + its two columns sit inside INTERMEDIATE_T2 on this flow.
    expect(h.countPill('INTERMEDIATE_T2')).toBe('3 on this lineage')

    const lineageHeaders = h.headerTitles().filter(t => t.endsWith('on this lineage')).sort()
    // Warehouse: INTERMEDIATE_T2(3)+itself, REPORTING(2)+itself = 7.
    // Report: the four inside tableau — tableau itself is a HOST, so it is
    // not one of them.
    expect(lineageHeaders).toEqual(['4 on this lineage', '7 on this lineage'])
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // THE WALK WINDOW is the dangerous one: the reader is still looking at the
  // browse canvas, so every browse affordance still looks live, and a write
  // that lands here has nothing to undo it when the trace exits. The gates
  // key on the SESSION, not on whether the overlay has anything to draw yet.
  it('the canvas is already read-only while the walk runs', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', deferTrace: true })
    // Open a child-search box while still in browse, so it is reachable
    // during the walk — the trace cannot withdraw an affordance it has not
    // rendered yet, which is exactly why the handler has to refuse too.
    await h.openChildSearch('tableau')
    const before = h.snapshotStore()

    await h.startTrace('cfo')
    expect(h.isTracing()).toBe(true)

    // A browse chevron: a no-op, never a fall-through to the browse expand.
    await h.toggle('INTERMEDIATE_T2')
    // A submitted child search: refused.
    expect(await h.typeChildSearch('orders')).toBe(true)
    expect(h.storeWrites()).toBe(0)

    await h.resolveTrace()
    expect(h.visibleCardIds().sort())
      .toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
    expect(h.storeWrites()).toBe(0)

    h.pressEscape()
    expect(h.isTracing()).toBe(false)
    expect(h.snapshotStore()).toEqual(before)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // EDGE STAGING is the write with the longest fuse: arming a connection does
  // nothing observable, the next click resolves a target, and only then does
  // confirming stage a create_edge. The 'C' key reaches it with no affordance
  // to withdraw, so the refusal has to sit on the arm itself.
  //
  // This test only means something on a canvas where the flow WORKS, so the
  // harness opens a draft with edit mode on and the first leg proves it: in
  // browse the handle is there and the whole C → click → picker flow runs.
  it('edge staging refuses for the whole trace window — handle and C shortcut', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft: true, deferTrace: true })

    // Control: authoring is genuinely live here.
    expect(h.connectHandle('tableau')).toBe(true)
    const before = h.snapshotStore()

    await h.startTrace('cfo')

    // ── the walk window: columns still show browse, affordances must not ──
    expect(h.connectHandle('tableau')).toBe(false)
    await h.clickCard('tableau')
    await h.pressKey('c')
    await h.clickCard('INTERMEDIATE_T2')
    expect(h.connectPickerOpen()).toBe(false)
    expect(h.storeWrites()).toBe(0)

    // ── and once the trace is actually drawing ──
    await h.resolveTrace()
    expect(h.connectHandle('tableau')).toBe(false)
    await h.clickCard('tableau')
    await h.pressKey('c')
    await h.clickCard('INTERMEDIATE_T2')
    expect(h.connectPickerOpen()).toBe(false)
    expect(h.storeWrites()).toBe(0)

    h.pressEscape()
    expect(h.isTracing()).toBe(false)
    expect(h.snapshotStore()).toEqual(before)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // ── THE DOCK CONTRACT (Task 9) ────────────────────────────────────────
  //
  // The engine changed under the dock: one walk to exhaustion, and every
  // question after it answered from the model in hand. These four are what
  // stops the dock from quietly re-asking the network for what it has.

  // Direction and depth are SCOPE, not a request. Twenty of them in a row
  // must not cost a single fetch — and must still change the picture, or
  // "no fetch" would be trivially satisfied by a control that does nothing.
  it('twenty direction/depth changes: not one refetch, and the picture keeps up', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    const walked = h.providerCalls()
    expect(walked).toBeGreaterThan(0)
    const both = h.visibleCardIds().sort()

    for (let i = 0; i < 5; i++) {
      await h.setDirection('up')
      await h.setDirection('both')
      await h.setDirection('down')
      await h.setDirection('both')
    }
    expect(h.providerCalls()).toBe(walked)
    expect(h.visibleCardIds().sort()).toEqual(both)

    // …and it is genuinely answering: on this estate the dashboard's partners
    // are all UPSTREAM, so hiding that side leaves the focus chain alone on
    // screen — and coming back restores them.
    await h.setDirection('down')
    const downOnly = h.visibleCardIds().sort()
    expect(downOnly).not.toEqual(both)
    expect(downOnly).not.toContain('INTERMEDIATE_T2')
    await h.setDirection('both')
    expect(h.visibleCardIds().sort()).toEqual(both)
    expect(h.providerCalls()).toBe(walked)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // ONE DEPTH RULE. The walk fetched 25 hops and followed its frontiers to
  // exhaustion, so there is nothing above 25 to offer and nothing a depth
  // change could go and get.
  it('the depth control offers nothing above the walked ceiling, and costs no fetch', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    const walked = h.providerCalls()

    const depthChip = () => screen.getByRole('button', { name: /^depth/i }).textContent ?? ''

    await h.depthPreset(/direct/i)
    // Nothing on offer promises a hop the walk did not fetch.
    expect(h.depthPresetValues().length).toBeGreaterThan(0)
    expect(h.depthPresetValues().every(pair => pair.split('/').every(v => Number(v) <= 25))).toBe(true)
    // The change is live — and cost nothing. (This estate is one hop deep, so
    // depth 1 and depth 25 draw the same cards; what is under test here is
    // that the control moves the VIEW and never the network.)
    expect(depthChip()).toMatch(/1.*1/)
    expect(h.providerCalls()).toBe(walked)

    await h.depthPreset(/all hops/i)
    expect(depthChip()).toMatch(/25.*25/)
    expect(h.providerCalls()).toBe(walked)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // A control that cannot do anything is withdrawn, not left on screen for
  // the reader to trust.
  it('the Settings tab drops the edge-type filter and the hierarchy level', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    await h.openDockSettings()

    expect(screen.getByText(/upstream depth/i)).toBeInTheDocument()
    expect(screen.queryByText(/hierarchy level/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/edge types/i)).not.toBeInTheDocument()
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // HISTORY RESTORES THE PICTURE, not just the focus. Back used to re-open
  // the trace and let the seed decide what was open, which returns the
  // reader to a trace they never left.
  it('back and forward restore the exact picture, expansion and all', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')

    await h.toggle('INTERMEDIATE_T2')
    const opened = h.visibleCardIds().sort()
    expect(opened).toContain('orders')
    await h.flushExpansionRecord()

    // A second trace, so there is somewhere to come back FROM.
    h.pressEscape()
    await h.settle()
    await h.startTrace('REPORTING')
    const second = h.visibleCardIds().sort()
    expect(second).not.toEqual(opened)

    await h.historyBack()
    expect(h.visibleCardIds().sort()).toEqual(opened)

    await h.historyForward()
    expect(h.visibleCardIds().sort()).toEqual(second)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // THE DANGEROUS CASE for "a view control never fetches": a walk that did
  // NOT finish. `retrace` legitimately means `continueWalk` there, and
  // `continueFullWalk` grants budget on every call and re-arms failed
  // frontiers — so a depth slider still wired to "apply" would put a real
  // request behind a scrub. Keep walking is the notice's job, not the
  // slider's.
  it('a depth scrub costs nothing even on a stalled walk', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', stallWalk: true })
    await h.startTrace('cfo')
    // The initial closure, plus the frontier op that failed: the walk is now
    // sitting stalled, which is the only state where retrace does anything.
    const stalled = h.providerCalls()
    expect(stalled).toBeGreaterThan(1)

    await h.openDockSettings()
    await h.commitDockDepth(4)
    await h.commitDockDepth(9)

    expect(h.providerCalls()).toBe(stalled)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // The recorder is 250 ms behind the click, and Back is faster than that.
  // The picture belongs to the entry the reader is LEAVING, so it has to be
  // written before the cursor moves off it — not dropped.
  it('a toggle made just before navigating is kept, not lost to the debounce', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    h.pressEscape()
    await h.settle()
    await h.startTrace('REPORTING')

    await h.historyBack()
    const landed = h.visibleCardIds().sort()

    // Open a card and navigate away IMMEDIATELY — inside the debounce window.
    await h.toggle('INTERMEDIATE_T2')
    const opened = h.visibleCardIds().sort()
    expect(opened).not.toEqual(landed)
    await h.historyForward()

    await h.historyBack()
    expect(h.visibleCardIds().sort()).toEqual(opened)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // The "missing connections" chip counts BROWSE lineage the canvas could not
  // place. During a trace the projection was being handed the browse lineage
  // against the TRACE's node map, so every edge pointing outside the trace
  // picture read as unplaceable — a number the reader cannot act on, and a
  // console.warn per render behind it.
  it('the missing-connections chip reports browse, and says nothing during a trace', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    // Control: browse genuinely has one — snowflake feeds tableau, and the
    // curated view places snowflake nowhere.
    expect(h.missingConnections()).toBe(1)

    const warnedBefore = h.consoleWarnings().length
    await h.startTrace('cfo')

    // Absent, not zero-with-a-chip: the trace has nothing of its own to report.
    expect(h.missingConnections()).toBeNull()
    expect(h.consoleWarnings().slice(warnedBefore).filter(w => w.includes('useEdgeProjection'))).toEqual([])
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // Read-only has to be literal: the panels that hang off the canvas write to
  // the same places the canvas does — the layer menu rewrites the reference
  // layout, the drawer's Edit tab stages entity changes.
  it('the layer menu and the drawer offer no edits during a trace', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', draft: true })

    // Controls: both are live in browse.
    await h.layerContextMenu()
    expect(h.contextMenuOpen()).toBe(true)
    h.pressEscape()
    await h.openDrawer('tableau')
    expect(h.drawerEditTabs()).toBe(1)

    await h.startTrace('cfo')

    await h.layerContextMenu()
    expect(h.contextMenuOpen()).toBe(false)
    await h.openDrawer('tableau')
    expect(h.drawerEditTabs()).toBe(0)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // Leaving a trace has to leave NOTHING. An exit animation on the dock kept
  // it mounted at opacity 0 with pointer events on — an invisible bar across
  // the bottom of the canvas that swallowed clicks, still announcing the
  // trace to screen readers. (Found by the live browser probe; same stranded
  // -AnimatePresence class this codebase has hit before.)
  it('the dock leaves with the trace, not a frame later', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    expect(h.dockPresent()).toBe(true)

    h.pressEscape()
    await h.settle()
    expect(h.isTracing()).toBe(false)
    expect(h.dockPresent()).toBe(false)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // Escape is layered. With the depth popover open it means "close this",
  // not "throw away the trace I am reading" — the destructive reading of an
  // ambiguous key is the wrong one.
  it('Escape closes an open popover first, and only then the trace', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    await h.openDepthPopover()
    expect(h.depthPopoverOpen()).toBe(true)

    h.pressEscape()
    await h.settle()
    expect(h.depthPopoverOpen()).toBe(false)
    expect(h.isTracing()).toBe(true)      // the trace survives

    h.pressEscape()
    await h.settle()
    expect(h.isTracing()).toBe(false)     // …and the next one leaves it
    expect(h.dockPresent()).toBe(false)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)
})
