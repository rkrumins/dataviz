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
import { cfoEstate, rootsNodeEstate } from '@/test/fixtures/traceEstates'
import { countTest, expectTestsRan } from '@/test/canary'

beforeEach(() => countTest())
afterAll(() => expectTestsRan(27))

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
  // NOT finish. Here the first coarse answer reports a half-read anchor and
  // the page behind it fails, so the session sits with a picture on screen
  // and an error beside it — the one state where `retrace` still means
  // something. A depth slider wired to "apply" would put a real request
  // behind a scrub; it must not.
  it('a depth scrub costs nothing even on a walk that did not finish', async () => {
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

// ── THE LAZY ENGINE, END TO END ─────────────────────────────────────────
//
// The tests above hand the canvas an estate that arrived in one response —
// which is what a coarse response IS for an estate one hop wide, and what the
// Stage 1 gates were written against. These drive the REAL contract instead
// (`lazy: true`): the server answers `grain:'coarse'` with the card-grain
// picture and one drill per card the reader opens, and nothing else is ever
// fetched. It is the claim of the whole rebuild, on the real canvas: the
// first paint is small, opening a card costs exactly one request, and the
// wires refine to the grain the reader has earned.
describe('the lazy trace engine on the real canvas', () => {
  it('R1 first paint: one request, the focus open over its contents, partners closed', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', lazy: true, holdWalk: true })
    await h.startTrace('cfo')

    // The focus's chain and its own contents; the partners at the grain the
    // rollup lane states them, CLOSED. Nothing inside them has been fetched
    // — `orders` and `rpt` are not here, and neither are any columns.
    expect(h.visibleCardIds().sort()).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
    // ONE request bought the picture. (The background walk is finishing the
    // flow behind it — that is `paintCalls` vs `providerCalls`.)
    expect(h.paintCalls()).toBe(1)
    // The invitation is still there: the lineage runs THROUGH these cards, so
    // the graph says there is something inside worth opening.
    expect(h.chevron('INTERMEDIATE_T2')).toBe(true)
    expect(h.chevron('REPORTING')).toBe(true)
    // And the wires are the coarse statement — container to dashboard.
    expect(h.wires().map(w => `${w.source}>${w.target}`).sort())
      .toEqual(['INTERMEDIATE_T2>cfo', 'REPORTING>cfo'])
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('expanding a partner costs exactly ONE request, and the wires refine a grain', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', lazy: true, holdWalk: true })
    await h.startTrace('cfo')
    const painted = h.paintCalls()

    await h.toggle('INTERMEDIATE_T2')

    expect(h.paintCalls()).toBeLessThanOrEqual(painted + 1)
    expect(h.visibleCardIds()).toContain('orders')
    // The wire that ended at the dashboard now lands on the dataset, and the
    // coarse statement it summarised is retired against it — one flow, one
    // line, at the finest grain the reader has earned. REPORTING is still
    // closed, so its own statement is untouched.
    expect(h.wires().map(w => `${w.source}>${w.target}`).sort())
      .toEqual(['REPORTING>cfo', 'orders>aov'])
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('collapse keeps what was fetched — re-opening costs nothing', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', lazy: true, holdWalk: true })
    await h.startTrace('cfo')
    await h.toggle('INTERMEDIATE_T2')
    const drilled = h.paintCalls()

    await h.toggle('INTERMEDIATE_T2')
    expect(h.visibleCardIds()).not.toContain('orders')
    await h.toggle('INTERMEDIATE_T2')

    expect(h.visibleCardIds()).toContain('orders')
    expect(h.paintCalls()).toBe(drilled)        // a card is drilled once, ever
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('one drill per level, down to the raw hops', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', lazy: true, holdWalk: true })
    await h.startTrace('cfo')
    expect(h.paintCalls()).toBe(1)

    await h.toggle('INTERMEDIATE_T2')          // → orders
    await h.toggle('orders')                   // → its columns, and the RAW hops
    // At most one request per level the reader opened — and none at all for a
    // level the background walk had already reached.
    expect(h.paintCalls()).toBeLessThanOrEqual(3)

    expect(h.visibleCardIds()).toContain('orders.channel')
    // The finest grain on screen: the reader has earned the column-to-column
    // hops, and the two coarser statements about the same flow are gone.
    expect(h.wires().map(w => `${w.source}>${w.target}`).sort())
      .toEqual(['REPORTING>cfo', 'orders.channel>aov', 'orders.net>aov'])
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('a partner`s chain arrives with the paint, so walking down it is free', async () => {
    // Roots ⊃ a1 ⊃ … ⊃ a10, flow only at the bottom, no rollup lane: coarse
    // falls back to a raw depth-1 closure around the focus subtree — and the
    // partner it finds ships with its WHOLE ancestor chain, because a partner
    // the client cannot place is a partner it drops. So every link in that
    // chain is already in hand, and opening one costs nothing at all.
    const h = await renderCanvasWithTrace(rootsNodeEstate(10), { focus: 'a9', lazy: true, holdWalk: true })
    await h.startTrace('a9')
    expect(h.paintCalls()).toBe(1)

    // The partner is represented at the FOCUS's own depth (`a9` is nine deep,
    // so the card is `b9`) and the hosts above it opened with the paint — so
    // walking down the chain the reader can see costs nothing. The rule
    // itself is pinned on the pure overlay, where the row list is not
    // subject to the column's virtualiser.
    const before = h.visibleCardIds()
    expect(before).toContain('b1')
    await h.toggle('b1')
    await h.toggle('b1')
    expect(h.visibleCardIds().sort()).toEqual(before.sort())

    expect(h.paintCalls()).toBe(1)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)
})

// ── AND THEN THE WALK LANDS ─────────────────────────────────────────────
//
// The coarse paint is the first frame, not the answer. The user's ruling is
// that a trace covers the ENTIRE walk — so with the background walk left to
// run, the board must arrive at the same picture the eager engine drew, with
// the raw column-grain hops in it and the counts no longer qualified.
describe('the background walk finishes the flow', () => {
  it('the board arrives at the whole lineage, hands-free', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', lazy: true })
    await h.startTrace('cfo')

    // Same cards the eager engine drew, from a coarse paint plus a walk.
    expect(h.visibleCardIds().sort()).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
    // And the wires refine to the column-grain flows the coarse picture could
    // only summarise. The pill counts the PARTICIPANTS the walk found inside
    // the card — its two feeding columns; `orders` itself carries no raw hop,
    // so it hosts them rather than being one of them.
    expect(h.countPill('INTERMEDIATE_T2')).toBe('2 on this lineage')
    expect(h.wires().map(w => `${w.source}>${w.target}`).sort())
      .toEqual(['INTERMEDIATE_T2>aov', 'REPORTING>aov'])
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // THE CHEVRON RULE, both halves. Before its contents are known a card that
  // the graph says has children invites the reader in; once they ARE known,
  // `onLineage` is the whole truth and a card with nothing on this lineage
  // inside it stops pretending.
  it('a card with unknown contents still invites the reader in', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', lazy: true, holdWalk: true })
    await h.startTrace('cfo')
    // Nothing inside REPORTING has been fetched, so there is nothing honest to
    // count — and the chevron still offers, because the graph says there IS
    // something in there and clicking is what goes and gets it.
    expect(h.chevron('REPORTING')).toBe(true)
    expect(h.countPill('REPORTING')).toBeNull()
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // THE HARD GATE from the live probe: pages merge into the MODEL, and
  // nothing opens. A background walk that moved the reader's expansion would
  // be the board rearranging itself under them while they read it. (One
  // harness per test — the harness owns module-level spies, so a second mount
  // in the same test leaves both canvases in the DOM.)
  it('the walk changes the model, never the picture', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', lazy: true })
    await h.startTrace('cfo')

    // Exactly the rows the coarse paint put up — asserted against the R1
    // picture the `holdWalk` test above pins, so the two cannot drift.
    expect(h.visibleCardIds().sort())
      .toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
    // The partners the reader has not opened are still closed: their contents
    // arrived in the model and stayed out of the picture.
    expect(h.visibleCardIds()).not.toContain('orders')
    expect(h.visibleCardIds()).not.toContain('rpt')
    // The wires ARE allowed to refine — that is the walk's whole point — but
    // only between cards that are on screen.
    const onScreen = new Set(h.visibleCardIds())
    for (const wire of h.wires()) {
      expect(onScreen.has(wire.source), `wire from off-screen ${wire.source}`).toBe(true)
      expect(onScreen.has(wire.target), `wire to off-screen ${wire.target}`).toBe(true)
    }
    expect(h.wires().length).toBeGreaterThan(0)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // EXIT RESTORES THE WIRES, not only the rows. The live probe caught two
  // container rollup wires from the trace showing up in BROWSE after Escape
  // (and one baseline wire lost) — rows were exact, wires were not, which is
  // a Stage 1 regression the row-only assertion could not see. The store spy
  // runs across the WHOLE journey here: paint, walk to exhaustion, and exit.
  it('exit restores the browse wires exactly, not just the rows', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', lazy: true })
    const browseRows = h.visibleCardIds().sort()
    const browseWires = h.wires().map(w => `${w.source}>${w.target}`).sort()
    const browseStore = h.snapshotStore()

    await h.startTrace('cfo')          // coarse paint AND the walk to exhaustion
    expect(h.storeWrites()).toBe(0)

    h.pressEscape()
    await h.settle()

    expect(h.isTracing()).toBe(false)
    expect(h.visibleCardIds().sort()).toEqual(browseRows)
    expect(h.wires().map(w => `${w.source}>${w.target}`).sort()).toEqual(browseWires)
    expect(h.snapshotStore()).toEqual(browseStore)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('and once its contents are known the count is the honest one', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', lazy: true })
    await h.startTrace('cfo')
    expect(h.chevron('REPORTING')).toBe(true)
    // The single column inside REPORTING that feeds this flow.
    expect(h.countPill('REPORTING')).toBe('1 on this lineage')
    expect(h.consoleErrors()).toEqual([])
  }, 30000)
})
