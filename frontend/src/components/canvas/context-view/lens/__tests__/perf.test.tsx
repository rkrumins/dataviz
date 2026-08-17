/**
 * Task 20, P0 — MEASURE BEFORE TOUCHING.
 *
 * Every optimization commit in this task (P1–P4) carries a number from
 * here, captured BEFORE that commit and re-captured after. Three
 * independent instruments, because they answer three different
 * questions jsdom and a real browser split between them:
 *
 *   1. React's own `<Profiler>` — commit count + `actualDuration` for
 *      the WHOLE board subtree, per interaction.
 *   2. The dev-gated render-count probe (`renderProbe.ts`) — of the
 *      board's N cards/edges, how many ACTUALLY re-rendered. This is
 *      the number that proves or disproves the fan-out claim: today
 *      `IsolationContext` broadcasts to every `useContext` consumer
 *      regardless of the memo comparators sitting beside them, so this
 *      count is expected to read ~N before P1 and a small fraction of N
 *      after.
 *   3. `performance.now()` directly around `buildFocusLayout`, outside
 *      React entirely — the pure-function rebuild cost jsdom CAN time
 *      accurately, unlike paint (see `lensHarness.tsx`'s `usePaintSampler`
 *      for the paint-side numbers, real-Chromium only).
 *
 * `walkDense` in the brief is `walkDensePills` here — the closest
 * existing fixture name; there is no fixture literally named `walkDense`.
 */
import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { FocusGraphView } from '../FocusGraphView'
import { buildFocusLayout, initialLensViewState } from '../focus-layout'
import type { LensWalkNode } from '../closure-adapter'
import { buildLensSubgraph } from '../lens-subgraph'
import { applyCondensation } from '../condensation'
import { WALK_FIXTURES } from '@/harness/lensFixtures'
import { buildWalk } from '@/harness/buildWalk'
import { renderCounts, resetRenderCounts } from '../renderProbe'

const noop = () => {}

/** Aggregates every `<Profiler onRender>` call in a window into one
 *  summary: how many commits, and how long React spent on them. */
function makeProfilerRecorder() {
  const commits: { phase: string; actualDuration: number }[] = []
  const onRender: ProfilerOnRenderCallback = (_id, phase, actualDuration) => {
    commits.push({ phase, actualDuration })
  }
  return {
    onRender,
    get commitCount() { return commits.length },
    get totalMs() { return commits.reduce((n, c) => n + c.actualDuration, 0) },
    reset() { commits.length = 0 },
  }
}

function renderBoard(fixtureName: string, profiler: ReturnType<typeof makeProfilerRecorder>) {
  const fixture = WALK_FIXTURES[fixtureName]
  if (!fixture) throw new Error(`Unknown fixture ${fixtureName}`)
  const built = buildWalk(fixture)
  const utils = render(
    <Profiler id="board" onRender={profiler.onRender}>
      <ReactFlowProvider>
        <FocusGraphView
          graph={built.graph}
          focalId={built.focalId}
          focalFetch="done"
          focalReach={built.reach}
          directionFilter={built.directionFilter}
          selectedId={built.selectedId}
          isolatedId={null}
          reducedMotion
          onSelect={noop}
          onFocus={noop}
          onToggleFrame={noop}
          onFrameScroll={noop}
          onFrameQuery={noop}
          onToggleFrameAll={noop}
          onRevealMore={noop}
          onExtend={noop}
          onPage={noop}
        />
      </ReactFlowProvider>
    </Profiler>,
  )
  return { ...utils, built }
}

/** Every `.react-flow__node` on the board, in DOM order — fixture-
 *  agnostic, so this does not need to know a fixture's own labels. */
const nodes = (container: HTMLElement) =>
  Array.from(container.querySelectorAll<HTMLElement>('.react-flow__node'))

describe('P0 — perf harness (Task 20)', () => {
  afterEach(() => cleanup())

  describe('(a) one isolate→clear hover toggle', () => {
    for (const fixtureName of ['walkDensePills', 'walkSharedPlatform']) {
      it(`${fixtureName}: hover-intent settle, then mouse-leave`, () => {
        vi.useFakeTimers()
        try {
          resetRenderCounts()
          const profiler = makeProfilerRecorder()
          const { container } = renderBoard(fixtureName, profiler)
          const board = nodes(container)
          expect(board.length).toBeGreaterThan(1)

          profiler.reset()
          resetRenderCounts()
          act(() => { fireEvent.mouseEnter(board[0]) })
          act(() => { vi.advanceTimersByTime(250) })
          const isolateCommits = profiler.commitCount
          const isolateMs = profiler.totalMs
          const isolateRenders = new Map(renderCounts)

          profiler.reset()
          resetRenderCounts()
          act(() => { fireEvent.mouseLeave(board[0]) })
          const clearCommits = profiler.commitCount
          const clearMs = profiler.totalMs
          const clearRenders = new Map(renderCounts)

          const totalCards = board.length
          const isolateReRendered = [...isolateRenders.values()].reduce((n, v) => n + v, 0)
          const clearReRendered = [...clearRenders.values()].reduce((n, v) => n + v, 0)

          console.log(
            `[P0-a] ${fixtureName} boardNodes=${totalCards} `
            + `isolate: commits=${isolateCommits} ms=${isolateMs.toFixed(2)} reRendered=${isolateReRendered} (${JSON.stringify(Object.fromEntries(isolateRenders))}) `
            + `clear: commits=${clearCommits} ms=${clearMs.toFixed(2)} reRendered=${clearReRendered} (${JSON.stringify(Object.fromEntries(clearRenders))})`,
          )

          // Not a pass/fail budget yet (P0 is measurement) — only that the
          // toggle actually produced a commit, so a silently-broken
          // instrument cannot report a hollow zero.
          expect(isolateCommits).toBeGreaterThan(0)
        } finally {
          vi.useRealTimers()
        }
      })
    }
  })

  describe('(b) a pointer sweep across 10 cards', () => {
    it('walkWideHub: 10 sequential hover-intent targets', () => {
      vi.useFakeTimers()
      try {
        const profiler = makeProfilerRecorder()
        const { container } = renderBoard('walkWideHub', profiler)
        const board = nodes(container)
        expect(board.length).toBeGreaterThanOrEqual(10)
        const targets = board.slice(0, 10)

        profiler.reset()
        resetRenderCounts()
        // A SWEEP: the pointer keeps moving before intent settles on any
        // one card but the last — mirrors "crossing the board on the way
        // somewhere else," which HOVER_INTENT_MS exists to absorb.
        for (const t of targets) {
          act(() => { fireEvent.mouseEnter(t) })
          act(() => { vi.advanceTimersByTime(50) })
          act(() => { fireEvent.mouseLeave(t) })
        }
        // Settle on the last one, then clear it — the brief's exact
        // shape: "a continuous sweep ... fires ≤1 isolation + 1 clear,
        // never N", pinned as ≤2 store notifications.
        act(() => { fireEvent.mouseEnter(targets[targets.length - 1]) })
        act(() => { vi.advanceTimersByTime(250) })
        act(() => { fireEvent.mouseLeave(targets[targets.length - 1]) })

        const totalRendered = [...renderCounts.values()].reduce((n, v) => n + v, 0)
        const storeNotifications = renderCounts.get('ConeStore.notify') ?? 0
        console.log(
          `[P0-b] walkWideHub boardNodes=${board.length} sweepCommits=${profiler.commitCount} `
          + `sweepMs=${profiler.totalMs.toFixed(2)} totalComponentRenders=${totalRendered} `
          + `storeNotifications=${storeNotifications} `
          + `(${JSON.stringify(Object.fromEntries(renderCounts))})`,
        )
        expect(profiler.commitCount).toBeGreaterThan(0)
        // THE budget: a sweep across 10 cards fires at most one isolation
        // and one clear at the store — never one per card swept.
        expect(storeNotifications).toBeLessThanOrEqual(2)
      } finally {
        vi.useRealTimers()
      }
    })

    /**
     * The P1 claim in its clearest form: switching the ANCHOR while
     * isolation STAYS active. `walkWideHub`'s 40 downstream reports are
     * independent siblings of F — each report's own cone is {report, F},
     * so moving from one to another should touch only those two cards on
     * EACH side of the switch, never the other 38 reports (whose
     * on-cone/off-cone answer does not change — they were off-cone before
     * the switch and stay off-cone after it).
     */
    it('walkWideHub: switching anchors while isolation stays on touches only what changed', () => {
      vi.useFakeTimers()
      try {
        resetRenderCounts()
        const profiler = makeProfilerRecorder()
        const { container } = renderBoard('walkWideHub', profiler)
        const reports = nodes(container).filter(n => /report_\d+/.test(n.textContent ?? ''))
        expect(reports.length).toBeGreaterThanOrEqual(2)
        const [reportA, reportB] = reports

        act(() => { fireEvent.mouseEnter(reportA) })
        act(() => { vi.advanceTimersByTime(250) })

        profiler.reset()
        resetRenderCounts()
        // Straight from A to B, never releasing isolation in between.
        act(() => { fireEvent.mouseEnter(reportB) })
        act(() => { vi.advanceTimersByTime(250) })

        const switchRenders = new Map(renderCounts)
        const totalRendered = [...switchRenders.values()].reduce((n, v) => n + v, 0)
        console.log(
          `[P1] walkWideHub anchor-switch (isolation stays on): reportCount=${reports.length} `
          + `commits=${profiler.commitCount} ms=${profiler.totalMs.toFixed(2)} `
          + `totalComponentRenders=${totalRendered} (${JSON.stringify(Object.fromEntries(switchRenders))})`,
        )
        // Far fewer than the whole board (151 nodes) — the fix's actual
        // point: an anchor switch touches a handful of cards, not the
        // board. A generous ceiling (30) so this cannot flake on an
        // unrelated re-render while still catching a regression back to
        // whole-board fan-out.
        expect(totalRendered).toBeLessThan(30)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('(d) buildFocusLayout rebuild wall-time', () => {
    /**
     * P3's budget, this task's own words: "≤ ~50ms per rebuild in jsdom
     * at those fixtures." A ≥4× multiplier (the brief's own floor) so
     * ordinary CI variance cannot flake this — it is a REGRESSION guard
     * against buildFocusLayout getting an order of magnitude slower, not
     * a tight budget assertion; the tight number is the one printed to
     * the console and carried into the report.
     */
    const REBUILD_BUDGET_MS = 50
    const REGRESSION_CEILING_MS = REBUILD_BUDGET_MS * 4
    for (const fixtureName of ['walkLongChain', 'walkWideHub']) {
      it(`${fixtureName}: repeated rebuild, same view state`, () => {
        const fixture = WALK_FIXTURES[fixtureName]
        const sg = buildLensSubgraph(fixture.model)
        const base = initialLensViewState(sg)
        const view = fixture.script ? fixture.script(base) : base
        const input = {
          sg, view, query: '', hiddenTypes: new Set<string>(),
          extendStatus: fixture.extendStatus ?? new Map(),
          childrenAll: fixture.childrenAll ?? new Map(),
          childrenAllStatus: new Map(),
          walkStatus: 'done' as const,
          directionFilter: fixture.directionFilter,
        }
        // Warm up (JIT) — untimed.
        const warm = buildFocusLayout(input)

        const N = 20
        const samples: number[] = []
        for (let i = 0; i < N; i++) {
          const start = performance.now()
          buildFocusLayout(input)
          samples.push(performance.now() - start)
        }
        const avg = samples.reduce((a, b) => a + b, 0) / N
        const max = Math.max(...samples)
        console.log(`[P0-d] ${fixtureName} cards=${warm.cards.length} edges=${warm.edges.length} avgMs=${avg.toFixed(3)} maxMs=${max.toFixed(3)}`)
        expect(avg).toBeGreaterThan(0)
        // THE P3 regression guard — a generous ceiling, not the target.
        expect(avg).toBeLessThan(REGRESSION_CEILING_MS)
      })
    }
  })

  /**
   * T28 R3 — THE WINDOW NEVER FOLDS; THE BOARD JUST GROWS. `applyHopWindow`
   * (T23 R1) is gone — nothing narrows what React Flow has to draw
   * anymore, so an UNBOUNDED-WIDTH `walkLongChain` — every hop drawn as
   * its own card, condensation's own runs unfolded too (its default
   * condensed state is not "unbounded", it is the OTHER feature this
   * board still has) — is the new worst case for the pipeline's own
   * rebuild cost. Replaces the deleted "(T23 R1) window move wall-time"
   * block: that measured the window's OWN pass in isolation; this
   * measures the pipeline it used to sit inside (`buildFocusLayout` →
   * condensation), now the last two stages before the board renders, at
   * full width — against T20's own budget verbatim, per the brief's own
   * instruction ("must hit T20's budgets, not a new number").
   */
  describe('(T28 R3) full-width rebuild wall-time — walkLongChain, no window', () => {
    // T20 P3's own numbers verbatim — see the (d) block above for the
    // rationale (a 4× regression guard, not a tight budget assertion).
    const REGRESSION_CEILING_MS = 50 * 4
    it('buildFocusLayout + applyCondensation, every hop unfolded, repeated rebuild', () => {
      const fixture = WALK_FIXTURES.walkLongChain
      const sg = buildLensSubgraph(fixture.model)
      const base = initialLensViewState(sg)
      const scripted = fixture.script ? fixture.script(base) : base

      // Discover every run condensation folds by default (empty
      // `condensedOpen`), from the connectors its OWN output states —
      // not a hardcoded id guess, which would silently stop meaning
      // anything the moment the fixture's own branch points changed.
      const foldedByDefault = applyCondensation(
        buildFocusLayout({
          sg, query: '', hiddenTypes: new Set<string>(),
          extendStatus: fixture.extendStatus ?? new Map(),
          childrenAll: fixture.childrenAll ?? new Map(),
          childrenAllStatus: new Map(),
          walkStatus: 'done' as const,
          directionFilter: fixture.directionFilter,
          view: scripted,
        }),
        scripted.condensedOpen,
      )
      const connectorIds = foldedByDefault.edges
        .map(e => e.condensed?.connectorId)
        .filter((id): id is string => id != null)
      expect(connectorIds.length).toBeGreaterThan(0)   // the premise: SOMETHING folds by default here

      // Unbounded width: every one of those runs held open — the same
      // per-focal edit a reader clicking every connector chip would
      // produce, just built directly rather than via N clicks.
      const view = { ...scripted, condensedOpen: new Set(connectorIds) }
      const input = {
        sg, view, query: '', hiddenTypes: new Set<string>(),
        extendStatus: fixture.extendStatus ?? new Map(),
        childrenAll: fixture.childrenAll ?? new Map(),
        childrenAllStatus: new Map(),
        walkStatus: 'done' as const,
        directionFilter: fixture.directionFilter,
      }
      const rebuild = () => applyCondensation(buildFocusLayout(input), view.condensedOpen)

      // Warm up (JIT) — untimed.
      const warm = rebuild()
      // Confirms the "unbounded width" premise this test exists to time:
      // no connector edge survives — every run this fixture ever folds
      // is unfolded, and every model node is its own top-level card.
      expect(warm.edges.some(e => e.condensed != null)).toBe(false)
      expect(warm.cards.filter(c => !c.frameId).length).toBe(fixture.model.nodes.length)

      const N = 20
      const samples: number[] = []
      for (let i = 0; i < N; i++) {
        const start = performance.now()
        rebuild()
        samples.push(performance.now() - start)
      }
      const avg = samples.reduce((a, b) => a + b, 0) / N
      const max = Math.max(...samples)
      console.log(`[T28-R3] walkLongChain full-width rebuild cards=${warm.cards.length} edges=${warm.edges.length} avgMs=${avg.toFixed(3)} maxMs=${max.toFixed(3)}`)
      expect(avg).toBeGreaterThan(0)
      expect(avg).toBeLessThan(REGRESSION_CEILING_MS)
    })
  })

  /**
   * IN-FRAME ROUTING — the arrangement and lane passes run inside
   * `buildFocusLayout`, on a container far denser than anything the
   * canonical fixtures hold: fifty tables in one warehouse with ~200
   * flows between them, which is the "expand a database and it shows
   * numerous edges between tables" case this work exists for.
   *
   * Both passes are near-linear (Kahn layering; interval colouring over
   * row spans), so the point of the number is that they stay that way —
   * held to T20 P3's own budget verbatim, not to a new one.
   */
  describe('(in-frame routing) a dense container rebuild stays inside T20\'s budget', () => {
    const REGRESSION_CEILING_MS = 50 * 4
    it('50 tables in one warehouse, repeated rebuild', () => {
      const TABLES = 50
      const wnode = (urn: string, type: string): LensWalkNode => ({
        id: urn, type: 'generic', position: { x: 0, y: 0 },
        data: { urn, label: urn, type }, urn, displayName: urn, entityType: type,
      }) as unknown as LensWalkNode
      const nodes: LensWalkNode[] = [wnode('RPT', 'dataset'), wnode('WH', 'container')]
      const lineageEdges: Array<{ id: string; sourceUrn: string; targetUrn: string; edgeType: string }> = []
      const containmentEdges: Array<{ sourceUrn: string; targetUrn: string }> = []
      const reveal: Array<[string, number]> = [['in:RPT', 1]]
      for (let i = 0; i < TABLES; i++) {
        const urn = `t${i}`
        nodes.push(wnode(urn, 'dataset'))
        containmentEdges.push({ sourceUrn: 'WH', targetUrn: urn })
        reveal.push([`in:${urn}`, 1])
        // A chain plus three shortcut hops per table — the shape a real
        // warehouse has, and ~4 flows per table rather than 1.
        for (const k of [1, 2, 3, 5]) {
          if (i + k < TABLES) lineageEdges.push({ id: `h${i}-${k}`, sourceUrn: urn, targetUrn: `t${i + k}`, edgeType: 'DERIVES_FROM' })
        }
      }
      lineageEdges.push({ id: 'hout', sourceUrn: `t${TABLES - 1}`, targetUrn: 'RPT', edgeType: 'DERIVES_FROM' })

      const sg = buildLensSubgraph({ focusUrn: 'RPT', nodes, lineageEdges, containmentEdges })
      const base = initialLensViewState(sg)
      const view = {
        ...base,
        revealed: new Map([...base.revealed, ...reveal]),
        expandedContainment: new Set([...base.expandedContainment, 'WH']),
      }
      const input = {
        sg, view, query: '', hiddenTypes: new Set<string>(),
        extendStatus: new Map(), childrenAll: new Map(), childrenAllStatus: new Map(),
        walkStatus: 'done' as const,
      }

      const warm = buildFocusLayout(input)
      const frame = warm.cards.find(c => c.nodeId === 'WH')!
      // The premise: this really is the dense case, and it really did
      // route it — not a budget met by having nothing to do.
      //
      // A frame draws ONE WINDOW of rows however many it holds, so the
      // wires it can ever draw are bounded by that window even here. The
      // passes still SEE all fifty tables' hops (`internalHopsOf` scans
      // every projected bundle), which is the part this times.
      const internal = warm.edges.filter(e => e.sameAncestorFrame === frame.id)
      expect(internal.length).toBeGreaterThan(12)
      expect(internal.every(e => e.inFrameLane != null)).toBe(true)
      expect(frame.gutterLanes).toBeGreaterThan(0)

      const N = 20
      const samples: number[] = []
      for (let i = 0; i < N; i++) {
        const start = performance.now()
        buildFocusLayout(input)
        samples.push(performance.now() - start)
      }
      const avg = samples.reduce((a, b) => a + b, 0) / N
      const max = Math.max(...samples)
      console.log(`[in-frame] dense container rebuild flows=${internal.length} lanes=${frame.gutterLanes} cards=${warm.cards.length} avgMs=${avg.toFixed(3)} maxMs=${max.toFixed(3)}`)
      expect(avg).toBeLessThan(REGRESSION_CEILING_MS)
    })
  })

  /**
   * DRAGGING A CARD paints where the pointer is, and costs one card.
   *
   * The `nodes` prop is controlled from the built layout, so React Flow
   * is re-seeded from it on every render and a drag it is not told about
   * is painted straight back — reported as "I am not getting an
   * indication that it is actually being moved and only when I release
   * it I see that it was moved". Telling it (`onNodesChange`) is the
   * fix; the number that matters is what a drag FRAME costs on a board
   * with a lot of cards, which is what this measures.
   */
  describe('(drag) a live drag re-renders the card that moved, not the board', () => {
    it('walkWideHub: one drag frame touches one card', () => {
      const profiler = makeProfilerRecorder()
      const { container } = renderBoard('walkWideHub', profiler)
      const board = nodes(container)
      expect(board.length).toBeGreaterThan(10)

      profiler.reset()
      resetRenderCounts()
      // One frame of a drag, as React Flow reports it: a position change
      // for exactly the node under the pointer.
      const target = board[0]
      act(() => {
        fireEvent.mouseDown(target, { clientX: 0, clientY: 0, button: 0 })
        fireEvent.mouseMove(target, { clientX: 40, clientY: 24 })
      })
      const rendered = [...renderCounts.entries()].filter(([k]) => k.startsWith('FocusNode'))
      const total = rendered.reduce((n, [, v]) => n + v, 0)
      console.log(
        `[drag] walkWideHub boardNodes=${board.length} commits=${profiler.commitCount} `
        + `ms=${profiler.totalMs.toFixed(2)} cardRenders=${total}`,
      )
      // THE BUDGET: a drag frame must not re-render the board. jsdom has
      // no layout so React Flow's own pointer maths may not fire at all
      // here — the claim this can honestly make is the ceiling, not that
      // the drag happened.
      expect(total).toBeLessThan(board.length)
    })
  })

  /**
   * Task 20, P4 — React Flow render hygiene. `nodeTypes`/`edgeTypes` are
   * verified module-level constants by inspection (`NODE_TYPES`/
   * `EDGE_TYPES` in FocusGraphView.tsx, outside any component); no
   * `defaultEdgeOptions` prop is used at all, so there is nothing there
   * to destabilize. This is the one claim worth PROVING rather than
   * reading: a selection change (peek open/close) must re-render only
   * the cards whose OWN `selected` flag flipped, not the board.
   */
  describe('(P4) selection changes touch only the affected cards', () => {
    it('walkWideHub: selecting a different report re-renders two cards, not the board', () => {
      const profiler = makeProfilerRecorder()
      const fixture = WALK_FIXTURES.walkWideHub
      const built = buildWalk(fixture)
      const { rerender, container } = render(
        <Profiler id="board" onRender={profiler.onRender}>
          <ReactFlowProvider>
            <FocusGraphView
              graph={built.graph}
              focalId={built.focalId}
              focalFetch="done"
              focalReach={built.reach}
              directionFilter={built.directionFilter}
              selectedId={null}
              isolatedId={null}
              reducedMotion
              onSelect={noop}
              onFocus={noop}
              onToggleFrame={noop}
              onFrameScroll={noop}
              onFrameQuery={noop}
              onToggleFrameAll={noop}
              onRevealMore={noop}
              onExtend={noop}
              onPage={noop}
            />
          </ReactFlowProvider>
        </Profiler>,
      )
      const board = nodes(container)
      expect(board.length).toBeGreaterThan(10)

      profiler.reset()
      resetRenderCounts()
      // A peek open — the SAME props FocusGraphView would get from a
      // parent that just set `view.selection`.
      rerender(
        <Profiler id="board" onRender={profiler.onRender}>
          <ReactFlowProvider>
            <FocusGraphView
              graph={built.graph}
              focalId={built.focalId}
              focalFetch="done"
              focalReach={built.reach}
              directionFilter={built.directionFilter}
              selectedId="dn000"
              isolatedId={null}
              reducedMotion
              onSelect={noop}
              onFocus={noop}
              onToggleFrame={noop}
              onFrameScroll={noop}
              onFrameQuery={noop}
              onToggleFrameAll={noop}
              onRevealMore={noop}
              onExtend={noop}
              onPage={noop}
            />
          </ReactFlowProvider>
        </Profiler>,
      )
      const totalRendered = [...renderCounts.values()].reduce((n, v) => n + v, 0)
      console.log(
        `[P4] walkWideHub select dn000: boardNodes=${board.length} commits=${profiler.commitCount} `
        + `ms=${profiler.totalMs.toFixed(2)} totalComponentRenders=${totalRendered} `
        + `(${JSON.stringify(Object.fromEntries(renderCounts))})`,
      )
      // Exactly the one card that GAINED `selected` — nothing else has a
      // reason to. A generous ceiling (10, not 1) so this does not flake
      // on an unrelated re-render while still catching the board-wide
      // fan-out this test exists to rule out.
      expect(totalRendered).toBeLessThan(10)
    })
  })

  /**
   * Fix round 1 (T21) — a real regression review caught: THE TRAIL's
   * `trailUrns` used to sit inside the shared `CardCtx` object every
   * card's memo comparator closes over. `markAnchor` (LineageLens.tsx)
   * makes a fresh `Set` the FIRST time an extend/page click reaches a
   * new urn, so `ctx` became a fresh object on that click, and
   * `a.ctx === b.ctx` failed for EVERY card on the board — the exact
   * P1 regression this suite exists to catch, undisclosed until this
   * pin. `TrailStore` (the same `useSyncExternalStore` pattern as
   * `ConeStore`) is the fix; this is its guard.
   */
  describe('(fix round 1) THE TRAIL marks a card without touching the board', () => {
    it('walkWideHub: trailUrns growing by one urn re-renders only the newly-marked card', () => {
      const profiler = makeProfilerRecorder()
      const fixture = WALK_FIXTURES.walkWideHub
      const built = buildWalk(fixture)
      const boardProps = {
        graph: built.graph,
        focalId: built.focalId,
        focalFetch: 'done' as const,
        focalReach: built.reach,
        directionFilter: built.directionFilter,
        selectedId: null,
        isolatedId: null,
        reducedMotion: true,
        onSelect: noop,
        onFocus: noop,
        onToggleFrame: noop,
        onFrameScroll: noop,
        onFrameQuery: noop,
        onToggleFrameAll: noop,
        onRevealMore: noop,
        onExtend: noop,
        onPage: noop,
      }
      const { rerender, container } = render(
        <Profiler id="board" onRender={profiler.onRender}>
          <ReactFlowProvider>
            <FocusGraphView {...boardProps} trailUrns={new Set()} />
          </ReactFlowProvider>
        </Profiler>,
      )
      const board = nodes(container)
      expect(board.length).toBeGreaterThan(10)
      // A real, drawn urn — the same shape `markAnchor` grows `trailUrns`
      // by, one urn at a time, on an extend/page click.
      const targetUrn = built.graph.cards.find(c => c.nodeId != null)!.nodeId!

      profiler.reset()
      resetRenderCounts()
      // The SAME props FocusGraphView would get from a parent whose
      // `extendAnchors` just grew by one urn — nothing else changes.
      rerender(
        <Profiler id="board" onRender={profiler.onRender}>
          <ReactFlowProvider>
            <FocusGraphView {...boardProps} trailUrns={new Set([targetUrn])} />
          </ReactFlowProvider>
        </Profiler>,
      )
      const totalRendered = [...renderCounts.values()].reduce((n, v) => n + v, 0)
      console.log(
        `[fix-round-1] walkWideHub trail mark: boardNodes=${board.length} commits=${profiler.commitCount} `
        + `ms=${profiler.totalMs.toFixed(2)} totalComponentRenders=${totalRendered} `
        + `(${JSON.stringify(Object.fromEntries(renderCounts))})`,
      )
      // Exactly the one card that GAINED the mark — nothing else has a
      // reason to. A generous ceiling (10, not 1), matching the (P4)
      // pin beside it; BEFORE the fix this read board.length (151).
      expect(totalRendered).toBeLessThan(10)
    })
  })

  /**
   * T27 fix round 1 measured, fix round 2 fixed — code review caught an
   * unmeasured deviation: T27 unified every card-like kind onto one
   * `FocusNode`, whose fiber now persists across a kind flip and so must
   * call the SAME hooks every render regardless of branch — including
   * what read the keyboard row cursor, which only frame/row cards used
   * to read.
   *
   * BEFORE (fix round 1, `RowCursorContext` — a plain `React.Context`):
   * 149 of 151 board nodes re-rendered on a single `ArrowDown` —
   * essentially the whole board, the exact broadcast-Provider pattern
   * Task 20 P1 eliminated for hover/isolation (`ConeStore`) and fix-
   * round-1 (T21) eliminated for the trail (`TrailStore`), reintroduced
   * here by this task's own hooks-rules constraint and hit by a gesture
   * users repeat rapidly (held arrow keys) — contradicts the project's
   * own performance bar, so review escalated it from "disclose" to "fix
   * now" once the measurement came back.
   *
   * AFTER (fix round 2, `RowCursorStore` — a `useSyncExternalStore`
   * selector keyed by frame + row id, the same pattern as `ConeStore`/
   * `TrailStore`): a row-to-row move re-renders exactly the row LEAVING
   * the cursor and the row ENTERING it — everything else's selector
   * returns the same primitive it did last time, so React never re-runs
   * it. Pinned as a REAL budget now, not a measurement instrument: the
   * FIRST ArrowDown from a cold cursor (nothing to leave) touches one
   * node; the SECOND — a genuine A→B move, the steady-state "holding the
   * key down" case — touches at most a small, fixed handful, never
   * anything close to the board's own size.
   */
  describe('(T27 fix round 2) row-cursor arrow-key move touches only what changed', () => {
    it('walkWideHub: moving the cursor inside one open frame re-renders only the affected rows', () => {
      resetRenderCounts()
      const profiler = makeProfilerRecorder()
      const { container } = renderBoard('walkWideHub', profiler)
      const board = nodes(container)
      // `sys00`..`sys11` are open containers (rows visible by default,
      // same as every other partner frame); each owns one listbox.
      const listbox = container.querySelector('[role="listbox"]')
      expect(listbox).not.toBeNull()

      // First move: cold cursor, nothing to leave — one row gains it.
      profiler.reset()
      resetRenderCounts()
      act(() => { fireEvent.keyDown(listbox!, { key: 'ArrowDown' }) })
      const firstMove = [...renderCounts.values()].reduce((n, v) => n + v, 0)

      // Second move: a genuine row-to-row transition — the steady-state
      // shape of a reader holding the key down. Exactly this is what
      // BEFORE this fix touched 149 of 151 board nodes.
      profiler.reset()
      resetRenderCounts()
      act(() => { fireEvent.keyDown(listbox!, { key: 'ArrowDown' }) })
      const secondMove = [...renderCounts.values()].reduce((n, v) => n + v, 0)

      console.log(
        `[T27-fix-round-2] walkWideHub row-cursor ArrowDown×2: boardNodes=${board.length} `
        + `commits=${profiler.commitCount} ms=${profiler.totalMs.toFixed(2)} `
        + `firstMove=${firstMove} secondMove=${secondMove} (${JSON.stringify(Object.fromEntries(renderCounts))})`,
      )
      // A generous ceiling (5, not 2) so this cannot flake on an
      // unrelated re-render while still catching a regression back to
      // anything resembling board-wide fan-out (151, or even 30).
      expect(firstMove).toBeGreaterThan(0)
      expect(firstMove).toBeLessThan(5)
      expect(secondMove).toBeGreaterThan(0)
      expect(secondMove).toBeLessThan(5)
    })
  })

  describe('(e) initial mount', () => {
    it('walkSharedPlatform: mount-phase actualDuration', () => {
      const profiler = makeProfilerRecorder()
      const start = performance.now()
      renderBoard('walkSharedPlatform', profiler)
      const wallMs = performance.now() - start
      const mountCommit = profiler.commitCount > 0
        ? { phase: 'mount', ms: profiler.totalMs }
        : null
      console.log(`[P0-e] walkSharedPlatform wallMs=${wallMs.toFixed(2)} profiler=${JSON.stringify(mountCommit)}`)
      expect(mountCommit).not.toBeNull()
    })
  })
})
