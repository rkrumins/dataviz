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
import { cfoEstate, coarseThenFineEstate } from '@/test/fixtures/traceEstates'
import { decodeTraceShare, encodeTraceShare } from '@/hooks/lib/traceShareCodec'
import { countTest, expectTestsRan } from '@/test/canary'

beforeEach(() => countTest())
afterAll(() => expectTestsRan(25))

describe('the trace overlay on the real canvas', () => {
  it('CFO trace: dashboard chain open, partners closed with counts, two rolled wires, zero store writes, exit restores', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')

    // D1 (2026-08-21): the dashboard's lineage lives on its chart's columns,
    // whose partners are the two DATASETS — so the warehouse containers are
    // hosts on the way to them (open) and the datasets are the partner
    // cards, closed with their counts.
    expect(h.visibleCardIds().sort()).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'orders', 'rpt', 'tableau'])
    expect(h.chevron('orders')).toBe(true)
    // Grain: with the dashboard open, the raw hops re-anchor to the CHART the
    // reader has earned — not to the dashboard they already opened past — and
    // to the closed DATASETS on the other end; the authored container rollups
    // are covered by them, so they are dropped rather than drawn a level
    // apart. See traceViewModel.wires.
    expect(h.wires().map(w => `${w.source}>${w.target}`).sort()).toEqual(['orders>aov', 'rpt>aov'])
    // A trace keeps its wires bare — no count pills on the lines, ever.
    expect(document.querySelectorAll('[data-edge-badge]').length).toBe(0)
    // The cards carry the count instead, behind a dock setting that is ON by
    // default and can be switched off for a quieter board.
    expect(h.countPill('orders')).toBe('2 on this lineage')
    await h.setLineageCounts(false)
    expect(h.countPill('orders')).toBeNull()
    expect(h.chevron('orders')).toBe(true)   // the invitation stays
    await h.setLineageCounts(true)
    expect(h.countPill('orders')).toBe('2 on this lineage')
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
      .querySelector<HTMLElement>('#layer-node-orders')
      ?.querySelector('button')
    expect(toggle).toBeTruthy()
    await act(async () => { fireEvent.click(toggle!) })
    await h.settle()

    // `orders`'s two columns and nothing else: R1 opens the way to things,
    // never the things themselves — the reader opened this one.
    expect(h.visibleCardIds().sort())
      .toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'orders', 'orders.channel', 'orders.net', 'rpt', 'tableau'])
    expect(h.storeWrites()).toBe(0)
    expect(h.snapshotStore()).toEqual(before)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // SEARCH is the action that used to be un-undoable: the per-node child
  // search `removeNodes`/`removeEdges`'d a parent's loaded children and
  // `addGraph`'d the hits, recording nothing about what it dropped. It is
  // gone, and its replacement — the header's find-in-view box — holds its
  // results in hook state and never touches the canvas store. Pinned in
  // browse AND mid-trace, because a search that wrote during a walk would
  // have nothing to undo it on exit.
  it('searching never writes to the canvas store, in browse or in a trace', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    const before = h.snapshotStore()

    expect(await h.typeInFind('orders')).toBe(true)
    expect(h.storeWrites()).toBe(0)

    await h.startTrace('cfo')
    expect(await h.typeInFind('tableau')).toBe(true)

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
      .toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'orders', 'rpt', 'tableau'])
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  /**
   * THE CAPSULE (D4, 2026-08-21). The session opens on the click and the
   * overlay only draws once the model holds the focus; between the two the
   * board used to sit silent under trace chrome and read as broken. The
   * capsule narrates from the first click, leaves by itself one beat after
   * the flow completes, and Cancel mid-walk leaves the trace with the
   * pre-trace store untouched.
   */
  it('the capsule narrates from the first click and leaves one beat after the flow completes', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', deferTrace: true })
    const before = h.snapshotStore()
    await h.startTrace('cfo')
    const capsule = () => document.querySelector<HTMLElement>('[data-trace-phase]')
    expect(capsule()?.dataset.tracePhase).toBe('loading')
    expect(capsule()?.textContent).toMatch(/finding the focus/i)

    await h.resolveTrace()
    // The flow is small and lands complete in one response: one beat of
    // "Complete", then gone — the dock owns the permanent numbers.
    expect(capsule()?.dataset.tracePhase).toBe('done')
    await act(async () => { await new Promise(r => setTimeout(r, 700)) })
    expect(capsule()).toBeNull()
    expect(h.isTracing()).toBe(true)
    expect(h.storeWrites()).toBe(0)
    expect(h.snapshotStore()).toEqual(before)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('Cancel on the capsule mid-walk leaves the trace, store untouched', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo', deferTrace: true })
    const before = h.snapshotStore()
    await h.startTrace('cfo')
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[data-trace-phase] button')].find(b => /cancel/i.test(b.textContent ?? ''))
    expect(cancel).toBeTruthy()
    await act(async () => { fireEvent.click(cancel!) })
    await h.settle()
    expect(h.isTracing()).toBe(false)
    expect(document.querySelector('[data-trace-phase]')).toBeNull()
    expect(h.snapshotStore()).toEqual(before)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  /**
   * THE COARSE FIRST PAINT (Part G, 2026-08-21). The cells land before a raw
   * hop does: the partner tables sit closed under their open database with
   * "≈N flows" pills, the department and database are hosts, and nothing
   * is written to the store. When the fine page lands the same cards carry
   * the raw counts and the "≈" is gone.
   */
  it('the coarse page paints the partner tables with ≈ counts under their hosts; the fine page refines them in place', async () => {
    const h = await renderCanvasWithTrace(coarseThenFineEstate(), { focus: 'orders', deferFine: true })
    const before = h.snapshotStore()
    await h.startTrace('orders')
    await h.settle()
    // Drawing from the cells alone.
    expect(h.isTracing()).toBe(true)
    expect(h.visibleCardIds().sort()).toEqual(['balances', 'dept', 'journal', 'ledger_db', 'orders', 'orders_db'])
    expect(h.countPill('journal')).toBe('≈30 flows')
    expect(h.countPill('balances')).toBe('≈10 flows')
    // No rows have landed yet, so the chevron — which opens only onto
    // contributing children — is still inert; it wakes with the fine page.
    expect(h.chevron('journal')).toBe(false)
    expect(h.wires().map(w => `${w.source}>${w.target}`).sort()).toEqual(['orders>balances', 'orders>journal'])
    expect(h.storeWrites()).toBe(0)

    await h.resolveTrace()
    expect(h.chevron('journal')).toBe(true)
    expect(h.countPill('journal')).toBe('2 on this lineage')
    expect(h.countPill('balances')).toBe('1 on this lineage')
    // Raw-backed now, and landing at the finest visible grain: the focus's
    // own columns (open as rows) feed the two closed tables.
    expect([...new Set(h.wires().map(w => w.target))].sort()).toEqual(['balances', 'journal'])
    expect(h.wires().every(w => w.source.startsWith('orders.c'))).toBe(true)
    expect(h.storeWrites()).toBe(0)
    expect(h.snapshotStore()).toEqual(before)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // Counts a reader can act on: the row says what is inside it on this
  // lineage, the column says what the whole lane contributes. Neither counts
  // rows — hosts are containers the flow passes through, never things on it.
  it('rows and columns report what is ON THIS LINEAGE, not what is loaded', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')

    // orders's two columns sit on this flow; rpt's one.
    expect(h.countPill('orders')).toBe('2 on this lineage')
    expect(h.countPill('rpt')).toBe('1 on this lineage')

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
    const before = h.snapshotStore()

    await h.startTrace('cfo')
    expect(h.isTracing()).toBe(true)

    // A browse chevron: a no-op, never a fall-through to the browse expand.
    await h.toggle('INTERMEDIATE_T2')
    expect(h.storeWrites()).toBe(0)

    await h.resolveTrace()
    expect(h.visibleCardIds().sort())
      .toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'orders', 'rpt', 'tableau'])
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

    await h.toggle('orders')
    const opened = h.visibleCardIds().sort()
    expect(opened).toContain('orders.channel')
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

  // THE READER'S FIRST QUESTION about a partner is "what IS that?" — and the
  // trace draws partners the browse canvas never loaded, because the walk
  // found them and the overlay never writes them to the store. The drawer
  // resolved its entity from the store alone, so 26 of 28 cards on a live
  // board opened nothing at all, however many times they were clicked
  // (measured 2026-08-22 on the dev stack).
  it('a partner card the browse canvas never loaded opens its details', async () => {
    // What a real canvas holds before a trace: the lane roots, and the
    // dashboard the reader expanded to and selected. NOT its partners.
    const h = await renderCanvasWithTrace(cfoEstate(), {
      focus: 'cfo',
      browseHolds: ['snowflake', 'tableau', 'cfo', 'INTERMEDIATE_T2', 'REPORTING'],
    })
    await h.startTrace('cfo')

    // `orders` is on the board — and is not something the store has ever seen.
    expect(h.visibleCardIds()).toContain('orders')
    expect(h.snapshotStore().nodes).not.toContain('orders')

    await h.clickCard('orders')
    expect(h.drawerEntity()).toBe('orders')
    // Read-only, like everything else during a trace, and still no writes.
    expect(h.drawerEditTabs()).toBe(0)
    expect(h.storeWrites()).toBe(0)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // TRACE HISTORY OUTLIVES THE PAGE, so it cannot be labelled from what the
  // page happens to have loaded: after a reload the canvas holds its lane
  // roots and nothing else, and the launcher read `intermediate_t2_17d10688`
  // — URN tails where names belong. And its CURRENT entry — the one a reload
  // leaves the cursor on, the top row, the trace the reader most likely
  // wants back — did nothing at all when clicked, because moving the cursor
  // to where it already is is not a move.
  it('the history names an entity the canvas never loaded, and its current entry still resumes', async () => {
    // The dashboard has a real name, spelled nothing like its urn — so a
    // label of "cfo" can only have come from the urn, and one of "CFO
    // Revenue Dashboard" can only have come from the data source.
    const base = cfoEstate()
    const estate = {
      ...base,
      model: {
        ...base.model,
        nodes: base.model.nodes.map(n => (n.urn === 'cfo' ? { ...n, displayName: 'CFO Revenue Dashboard' } : n)),
      },
    }
    // Browse holds the lane roots. NOT the dashboard: the reader traced it
    // from a search hit, or came back to the view after a reload.
    const h = await renderCanvasWithTrace(estate, {
      focus: 'cfo',
      browseHolds: ['snowflake', 'tableau', 'INTERMEDIATE_T2', 'REPORTING'],
    })
    await h.startTrace('cfo')
    h.pressEscape()
    await h.settle()
    expect(h.isTracing()).toBe(false)

    await h.openTraceHistory()
    expect(h.traceHistoryLabels()).toEqual(['CFO Revenue Dashboard'])
    const lookups = h.nameLookups()

    // The entry under the cursor is exactly the one a reload offers first.
    await h.resumeTraceHistory('CFO Revenue Dashboard')
    expect(h.isTracing()).toBe(true)

    // And a name, once known, is never asked for again. (The launcher lives
    // where "Trace Lineage" does, so it is only on offer outside a trace.)
    h.pressEscape()
    await h.settle()
    await h.openTraceHistory()
    expect(h.traceHistoryLabels()).toEqual(['CFO Revenue Dashboard'])
    expect(h.nameLookups()).toBe(lookups)
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // A TRACE IS A FINDING, and findings get handed on. The link carries what
  // the history entry carries — focus, sides, hop limits, open cards — so
  // the recipient lands on the same picture without a single click.
  it('a shared link opens the trace it names, with the sender\'s picture', async () => {
    const token = encodeTraceShare({
      urn: 'cfo',
      label: 'CFO Revenue Dashboard',
      up: true,
      down: false,
      depthUp: 3,
      depthDown: 25,
      open: ['orders'],
    })
    // The recipient's canvas holds its lane roots and nothing else — they
    // have never opened this dashboard; the link is how they meet it.
    const base = cfoEstate()
    const estate = {
      ...base,
      model: {
        ...base.model,
        nodes: base.model.nodes.map(n => (n.urn === 'cfo' ? { ...n, displayName: 'CFO Revenue Dashboard' } : n)),
      },
    }
    const h = await renderCanvasWithTrace(estate, {
      focus: 'cfo',
      search: `?trace=${token}`,
      browseHolds: ['snowflake', 'tableau', 'INTERMEDIATE_T2', 'REPORTING'],
    })

    // Nobody clicked anything: the link traced.
    await h.waitForCard('cfo')
    expect(h.isTracing()).toBe(true)
    expect(h.direction()).toBe('up')
    // And it says what it is tracing — never the urn the link carried.
    expect(h.dockFocus()).toBe('CFO Revenue Dashboard')
    // The sender had `orders` open, so its columns are on the recipient's
    // board too — the picture, not just the question.
    expect(h.visibleCardIds()).toContain('orders.channel')
    // The token is consumed: a refresh, or this URL pasted onward, is clean.
    expect(window.location.search).toBe('')

    // And it joins the recipient's own history, so it survives that strip.
    h.pressEscape()
    await h.settle()
    await h.openTraceHistory()
    expect(h.traceHistoryLabels()).toContain('CFO Revenue Dashboard')
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  it('a link the sender writes says what it carries, and carries what it says', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    await h.setDirection('up')
    await h.openShare()

    // The popover states the finding BEFORE the copy, not after it.
    expect(h.shareSummary()).toMatch(/Root cause/)
    expect(h.shareSummary()).toMatch(/cfo/)

    const withPicture = decodeTraceShare(new URL(await h.copyShareLink()).searchParams.get('trace') ?? '')
    expect(withPicture).toMatchObject({ urn: 'cfo', up: true, down: false })
    expect(withPicture!.open.length).toBeGreaterThan(0)

    // Switched off, the same link is the plain question — "open it as it draws".
    await h.toggleSharePicture()
    const plain = decodeTraceShare(new URL(await h.copyShareLink()).searchParams.get('trace') ?? '')
    expect(plain).toMatchObject({ urn: 'cfo', up: true, down: false, open: [] })
    expect(h.consoleErrors()).toEqual([])
  }, 30000)

  // The launcher is a list of findings, so each row can be handed over
  // without being opened first — the trace you want to send is often not the
  // one you are looking at.
  it('a history row hands over its own trace, without opening it', async () => {
    const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
    await h.startTrace('cfo')
    // Open a partner, so this entry has a picture worth carrying.
    await h.toggle('orders')
    await h.flushExpansionRecord()
    h.pressEscape()
    await h.settle()

    await h.openTraceHistory()
    const link = await h.shareTraceHistory('cfo')

    // Sharing a row is not opening it: the panel stays put and no trace runs.
    expect(h.isTracing()).toBe(false)
    // And the confirmation reaches a screen reader, not just the eye.
    expect(document.querySelector('[role="menu"][aria-label="Trace history"] [role="status"]')?.textContent?.trim())
      .toBe('Link copied')
    const shared = decodeTraceShare(new URL(link).searchParams.get('trace') ?? '')
    expect(shared).toMatchObject({ urn: 'cfo', up: true, down: true })
    // The picture it carries is the one that entry recorded.
    expect(shared!.open).toContain('orders')
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
