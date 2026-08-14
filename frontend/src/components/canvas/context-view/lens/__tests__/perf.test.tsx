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
import { buildLensSubgraph } from '../lens-subgraph'
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
