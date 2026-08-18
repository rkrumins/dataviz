# Native Canvas Trace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trace runs natively in ContextViewCanvas: the full end-to-end lineage of the traced entity renders upfront, filtered to the flow, expanded, in assigned layers — powered by the existing closure full-walk engine.

**Architecture:** A pure delta-merge module (`traceWalkMerge`) converts walk-model growth into batched canvas-store writes under the legacy spine rules; a controller hook (`useCanvasTraceWalk`) owns the trace session around the existing `useLensWalk(urn, provider, 25, fullWalk=true)`; ContextViewCanvas feeds the walk's URN set to the existing dormant `useTraceFilteredHierarchy` and renders a slim `TraceWalkBar`. Exit purges recorded ids — expansion is *derived*, so restore is free.

**Tech Stack:** React 18 hooks, zustand (`useCanvasStore`), vitest + @testing-library/react. No backend changes.

**Spec:** `docs/superpowers/specs/2026-08-18-native-canvas-trace-design.md`

## Global Constraints

- Base branch: `feature/trace-full-walk` (the full-walk engine; commits `141ddb90..a36653cb`). Work in worktree `.claude/worktrees/native-canvas-trace`, branch `feature/native-canvas-trace`.
- TDD: every behavior gets a failing test first. Commit per task with **explicit file paths** (parallel sessions use broad `git add`).
- Perf gates (spec §7, verbatim): delta-merge of a 1,000-node model ≤ 50ms per wave; merging the same growth twice = zero store writes; exit of a 1,000-node trace ≤ 100ms.
- tsc error *set* must stay identical to base (61 pre-existing); zero new lint problems in touched files; full vitest suite green (1 known pre-existing `perf.test.tsx` teardown error).
- Never re-parent an existing canvas node (containment edges only to newly-merged targets). Never auto-retry a failed walk op.
- Do not touch: `useUnifiedTrace.ts` internals, the v2 API, `LineageLens.tsx` behavior shipped on the base branch (props may be consumed, not changed).

---

### Task 0: Worktree + docs

**Files:**
- Create: worktree `.claude/worktrees/native-canvas-trace` on branch `feature/native-canvas-trace` from `feature/trace-full-walk`
- Add: `docs/superpowers/specs/2026-08-18-native-canvas-trace-design.md`, `docs/superpowers/plans/2026-08-18-native-canvas-trace.md` (copy from main checkout — they are uncommitted there)

- [ ] **Step 1:** From the main repo: `git worktree add ".claude/worktrees/native-canvas-trace" -b feature/native-canvas-trace feature/trace-full-walk`, then enter it (EnterWorktree with `path`).
- [ ] **Step 2:** `ln -s "/Volumes/ASMT ASM246X Media/dataviz/frontend/node_modules" frontend/node_modules` (reuse installs; no new deps in this plan).
- [ ] **Step 3:** Copy the spec + this plan into `docs/superpowers/{specs,plans}/` in the worktree.
- [ ] **Step 4:** Baseline: `cd frontend && npx vitest run src/components/canvas/context-view src/hooks/__tests__/useLensWalk.test.ts` → expect all green (679 tests as of base).
- [ ] **Step 5:** Commit: `git add docs/superpowers/specs/2026-08-18-native-canvas-trace-design.md docs/superpowers/plans/2026-08-18-native-canvas-trace.md && git commit -m "docs: native canvas trace — spec and plan"`

---

### Task 1: `traceWalkMerge` — pure delta-merge + expansion derivation

**Files:**
- Create: `frontend/src/hooks/lib/traceWalkMerge.ts`
- Test: `frontend/src/hooks/lib/__tests__/traceWalkMerge.test.ts`

**Interfaces:**
- Consumes: `computeTraceMergeSpine({ participantUrns, containmentEdges, knownAssignedUrns })` from `@/hooks/lib/traceMergeSpine` (returns `{ spineUrns }`); `LensWalkModel` / `LensWalkNode` from `@/components/canvas/context-view/lens/closure-adapter`.
- Produces (used by Task 2):

```ts
export interface TraceWalkMergeSession {
  readonly mergedNodeIds: ReadonlySet<string>
  readonly mergedEdgeIds: ReadonlySet<string>
}
export function emptyTraceWalkMergeSession(): TraceWalkMergeSession
export interface TraceWalkMergeDelta {
  nodes: Array<{ id: string; type: 'default'; position: { x: number; y: number }; data: Record<string, unknown> }>
  edges: Array<{ id: string; source: string; target: string; data: { edgeType: string; relationship: string } }>
}
export function computeTraceWalkDelta(opts: {
  model: LensWalkModel
  session: TraceWalkMergeSession
  /** urns/ids already on the canvas (store node ids) — the spine's anchors. */
  knownUrns: ReadonlySet<string>
}): { delta: TraceWalkMergeDelta; session: TraceWalkMergeSession }
/** Containment ancestors of every model participant (child→parent walked
 *  from model.containmentEdges, 32-hop cycle guard) ∪ every participant
 *  that is itself a containment parent. */
export function traceExpansionUrns(model: LensWalkModel): Set<string>
```

Rules `computeTraceWalkDelta` must encode (each is a legacy shipped-bug rule — see `ContextViewCanvas.tsx` `onTraceComplete` block ~`:300-437`):
1. participants = model node urns ∪ `model.upstreamUrns` ∪ `model.downstreamUrns`; spine via `computeTraceMergeSpine` with `knownAssignedUrns = knownUrns` and `containmentEdges: model.containmentEdges`.
2. mergeable node = (participant ∨ spine) ∧ ¬known ∧ ¬already in `session.mergedNodeIds` ∧ hydrated (`(displayName ?? '').trim().length > 0`).
3. node mapping: `{ id: n.urn, type: 'default', position: {x:0,y:0}, data: n.data }` (LensWalkNode.data is already canvas-shaped via `toCanvasNode`).
4. lineage edge mergeable = both endpoints resolvable (mergeable-now ∨ known ∨ previously merged) ∧ edge id not in `session.mergedEdgeIds`; edge id = `e.id ?? \`tw:${e.sourceUrn}>${e.targetUrn}:${e.edgeType ?? ''}\``; mapping `{ id, source: sourceUrn, target: targetUrn, data: { edgeType, relationship: edgeType } }`.
5. containment edge mergeable = target is a **newly-merged-this-call** node ∧ source resolvable (HARD RULE: never re-parent an existing node); id = `e.id ?? \`twc:${sourceUrn}>${targetUrn}\``, `edgeType: 'CONTAINS'` when the model edge has none.
6. Pure + idempotent: returned session = old session ∪ this delta's ids; calling again with the same model returns an empty delta and the same-content session.

- [ ] **Step 1: Write failing tests** (fixture kit mirrors `useLensWalk.test.ts`'s `walkModel` helper — hand-authored `LensWalkModel`s):

```ts
// tests, one behavior each:
it('merges hydrated participants and their spine, skipping known urns', …)
it('drops unhydrated nodes and never emits containment edges to them', …)
it('never re-parents: containment edge to an already-known target is dropped', …)
it('lineage edges resolve against known ∪ newly-merged ∪ previously-merged', …)
it('is idempotent: same model twice → empty delta, zero new ids', …)
it('delta-merges: a grown model only emits what the session lacks', …)
it('traceExpansionUrns: ancestors of every participant, cycle-safe', …)
it('PERF GATE: 1,000-node model delta computes in ≤ 50ms', …)  // build model with Array.from; assert performance.now() elapsed
```

- [ ] **Step 2:** `npx vitest run src/hooks/lib/__tests__/traceWalkMerge.test.ts` → all FAIL (module missing).
- [ ] **Step 3:** Implement `traceWalkMerge.ts` per the rules above (≈120 lines; no React imports — pure).
- [ ] **Step 4:** Re-run → all PASS.
- [ ] **Step 5:** Commit: `git add frontend/src/hooks/lib/traceWalkMerge.ts frontend/src/hooks/lib/__tests__/traceWalkMerge.test.ts && git commit -m "feat(trace): pure delta-merge of a closure walk model into canvas shapes"`

---

### Task 2: `useCanvasTraceWalk` — the session controller

**Files:**
- Create: `frontend/src/hooks/useCanvasTraceWalk.ts`
- Test: `frontend/src/hooks/__tests__/useCanvasTraceWalk.test.ts`

**Interfaces:**
- Consumes: `useLensWalk(focusUrn, provider, 25, true)` (from `@/hooks/useLensWalk` — returns `{ walkFor, retry, fullWalkFor, continueFullWalk }`); Task 1's module; `useCanvasStore` actions `addNodes/addEdges/removeNodes/removeEdges` (store at `@/store/canvas`).
- Produces (used by Tasks 3–5):

```ts
export interface CanvasTraceWalk {
  isTracing: boolean
  tracedUrn: string | null
  start: (urn: string) => void      // re-trace of another urn exits first
  exit: () => void                  // purge merged edges THEN nodes; clear session
  walkEntry: WalkEntry | null       // status/error/model for bar + counts
  fullWalkStatus: FullWalkStatus | null
  continueWalk: () => void          // budget grant / stalled re-arm
  retryWalk: () => void             // failed INITIAL fetch
  traceNodeUrns: ReadonlySet<string>  // model urns ∪ upstream ∪ downstream (memo; EMPTY when not tracing)
  expansionUrns: ReadonlySet<string>  // traceExpansionUrns(model) (memo; EMPTY when not tracing)
  addedEdgeIds: ReadonlySet<string>   // STABLE Set instance, contents grow per merge wave
}
export function useCanvasTraceWalk(provider: GraphDataProvider | null): CanvasTraceWalk
```

Implementation notes:
- `const [tracedUrn, setTracedUrn] = useState<string | null>(null)`; `useLensWalk(tracedUrn, provider, 25, true)` (passing null closes the walk session — its own cache-clear semantics apply).
- Merge effect (store writes are external-store writes — legal in effects): on `[tracedUrn, walkEntry?.model]` change, read `knownUrns = new Set(useCanvasStore.getState().nodes.map(n => n.id))`, run `computeTraceWalkDelta` against `sessionRef.current`; if delta non-empty: ONE `addNodes(delta.nodes)` + ONE `addEdges(delta.edges)`, update `sessionRef.current`, add edge ids into the stable `addedEdgeIds` set. Document the stability contract: the canvas re-renders on every store write, so readers always see fresh contents; identity is deliberately stable.
- `exit()`: `removeEdges([...session.mergedEdgeIds])` then `removeNodes([...session.mergedNodeIds])` (order: edges first), reset session ref, `addedEdgeIds.clear()`, `setTracedUrn(null)`.
- `start(urn)`: if `tracedUrn && tracedUrn !== urn` call `exit()` first, then `setTracedUrn(urn)`.
- `traceNodeUrns`/`expansionUrns`: `useMemo` over `walkEntry?.model` — pure derivation, no state writes (the lesson from the Lens `layoutView`).

- [ ] **Step 1: Write failing tests** (renderHook + fake provider returning closure fixtures, REAL `useCanvasStore` — snapshot `useCanvasStore.getState()` nodes/edges before, `setState` restore in afterEach):

```ts
it('start → walk lands → store gains the flow nodes and edges, batched', …)
it('a second wave merges only the delta (store counts grow by exactly the new)', …)
it('exit removes exactly what the trace added — store deep-equals pre-trace', …)
it('re-trace of a different urn exits the old session first', …)
it('traceNodeUrns and expansionUrns derive from the model; empty when idle', …)
it('addedEdgeIds carries every merged edge id (stable instance)', …)
it('PERF GATE: exit of a 1,000-node trace ≤ 100ms', …)
```

- [ ] **Step 2:** Run → FAIL (module missing).
- [ ] **Step 3:** Implement (≈130 lines).
- [ ] **Step 4:** Run task tests + `npx vitest run src/hooks/__tests__/useLensWalk.test.ts` (engine untouched) → PASS.
- [ ] **Step 5:** Commit: `git add frontend/src/hooks/useCanvasTraceWalk.ts frontend/src/hooks/__tests__/useCanvasTraceWalk.test.ts && git commit -m "feat(trace): canvas trace session controller on the closure full-walk engine"`

---

### Task 3: `TraceWalkBar` — canvas chrome

**Files:**
- Create: `frontend/src/components/canvas/context-view/TraceWalkBar.tsx`
- Test: `frontend/src/components/canvas/context-view/__tests__/TraceWalkBar.test.tsx`

**Interfaces:**
- Consumes: `FullWalkStatus`, `LensWalkStatus` types from `@/hooks/useLensWalk`.
- Produces:

```ts
export interface TraceWalkBarProps {
  tracedName: string
  nodeCount: number
  flowCount: number           // lineage edges in the model
  hiddenCount: number         // participants not rendered (no layer assignment)
  walkStatus: LensWalkStatus  // 'loading' | 'done' | 'error' | 'unsupported'
  walkError: string | null
  status: FullWalkStatus | null
  onKeepWalking: () => void
  onRetry: () => void
  onExit: () => void
}
export function TraceWalkBar(props: TraceWalkBarProps): JSX.Element
```

Copy chrome idioms from `LineageLens.tsx`'s narration strips (amber `border-amber-500/25 bg-amber-500/[0.06]` pattern) and the canvas banner at `ContextViewCanvas.tsx` (aggregation-truncation banner). States, one behavior per test:
- walking → spinner + `Tracing {name} · {nodeCount} nodes · {flowCount} flows`
- `status.exhausted` → `Full flow · {nodeCount} nodes · {flowCount} flows`
- `hiddenCount > 0` → append `· {hiddenCount} not shown (no layer assignment)`
- `status.budgetHit` → amber `The flow continues past {nodeCount} nodes` + button **Keep walking** → `onKeepWalking`
- `status.stalled` → amber `Part of the flow could not be walked` + button **Try again** → `onKeepWalking`
- `walkStatus === 'error'` → amber walkError + button **Retry** → `onRetry`
- always: button **Exit trace** → `onExit`

- [ ] **Step 1:** Write the failing tests (render with props, assert text/roles, fireEvent the three buttons).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `git add frontend/src/components/canvas/context-view/TraceWalkBar.tsx frontend/src/components/canvas/context-view/__tests__/TraceWalkBar.test.tsx && git commit -m "feat(trace): the trace bar says where the walk stands"`

---

### Task 4: ContextViewCanvas wiring

**Files:**
- Modify: `frontend/src/components/canvas/context-view/ContextViewCanvas.tsx`

**Interfaces:** Consumes Tasks 1–3. No new exports.

All line anchors are as of base `a36653cb`; re-grep before editing.

- [ ] **Step 1:** Mount the controller near the lens block (~`:3080`): `const canvasTrace = useCanvasTraceWalk(provider)` and `const traceActive = canvasTrace.isTracing`. Wire the forward refs there: `startTraceRef.current = (nodeId) => canvasTrace.start(displayMap.get(nodeId)?.urn ?? nodeId)` (same for `toggleTraceRef`) — replacing the `openTraceLens` assignments. Keep `openLensAt`/`openLens` and the `lensFullWalk` toggle exactly as shipped; delete the now-orphaned `openTraceLens`.
- [ ] **Step 2:** Repoint the remaining entries to the same `startCanvasTrace` lambda: header `onStartTrace` (~`:3515`), `traceActive={canvasTrace.isTracing}`, `onExitTrace={() => { canvasTrace.exit(); resetAllCircuitBreakers() }}`; EntityDrawer `onTraceUp/onTraceDown/onFullTrace` (~`:4231`); CanvasContextMenu `onTraceNode` (~`:4290`); TraceBottomDock `onJumpToUrn` (~`:3559`).
- [ ] **Step 3:** Feed the filter (~`:1573-1583`): `isTracing: traceActive`, `traceNodes: canvasTrace.traceNodeUrns`, `drilldowns: EMPTY_DRILLDOWNS` (a module-level `new Map()`), and `expandedNodes: expandedForRender` where

```ts
const expandedForRender = useMemo(() => (
  traceActive && canvasTrace.expansionUrns.size > 0
    ? new Set([...expandedNodes, ...canvasTrace.expansionUrns])
    : expandedNodes
), [traceActive, expandedNodes, canvasTrace.expansionUrns])
```

- [ ] **Step 4:** Swap the render/gate reads from the dormant legacy object to `traceActive`: `renderByLayer/renderFlat/renderMap` (~`:1587-1589`), `browseBundleEnabled = !traceActive` (~`:2807`), the aggregation-effect gate (~`:2101/:2131` dep), the auto-expand-children gate (~`:2156/:2175` dep), the dock-collapse effect (~`:1190`), node-sort gating (~`:2020`). Projection (~`:2812-2828`): `isTracing: traceActive`, `traceContextSet` (unchanged — filter output), `traceAddedEdgeIds: canvasTrace.addedEdgeIds`, `traceFocusLevel: undefined` (closure is level-free; expanded parents render leaf edges, collapsed parents bundle). `useEdgeProjection`'s `expandedNodes` input also becomes `expandedForRender`. Leave every other `trace.*` reference (dormant machinery) untouched.
- [ ] **Step 5:** Render the bar next to the aggregation-truncation banner (~`:3570`):

```tsx
{traceActive && (
  <TraceWalkBar
    tracedName={displayMap.get(canvasTrace.tracedUrn ?? '')?.name ?? canvasTrace.tracedUrn ?? ''}
    nodeCount={canvasTrace.walkEntry?.model.nodes.length ?? 0}
    flowCount={canvasTrace.walkEntry?.model.lineageEdges.length ?? 0}
    hiddenCount={hiddenTraceCount}
    walkStatus={canvasTrace.walkEntry?.status ?? 'loading'}
    walkError={canvasTrace.walkEntry?.error ?? null}
    status={canvasTrace.fullWalkStatus}
    onKeepWalking={canvasTrace.continueWalk}
    onRetry={canvasTrace.retryWalk}
    onExit={() => { canvasTrace.exit(); resetAllCircuitBreakers() }}
  />
)}
```

with `const hiddenTraceCount = useMemo(() => (traceActive ? [...canvasTrace.traceNodeUrns].filter(u => !renderMap.has(u) && !renderMap.has(urnToIdMap.get(u) ?? '')).length : 0), [traceActive, canvasTrace.traceNodeUrns, renderMap, urnToIdMap])`.

- [ ] **Step 6:** Verify: `npx tsc --noEmit` (error set = base's 61, diff the sorted set), `npx eslint` on the file (≤ base count, zero new rules), `npx vitest run src/components/canvas/context-view` → green.
- [ ] **Step 7:** Commit: `git add frontend/src/components/canvas/context-view/ContextViewCanvas.tsx && git commit -m "feat(trace): the canvas is the trace surface — full flow upfront, filtered, in layers"`

---

### Task 5: Canvas trace seam test

**Files:**
- Create: `frontend/src/components/canvas/context-view/__tests__/canvasTraceWalkSeam.test.tsx`

**Interfaces:** Consumes Tasks 1–2 + real `useCanvasStore` + real `useTraceFilteredHierarchy`. Mirrors the canvas block the way `lensSeam.test.tsx` mirrors the lens block (that file is the pattern — copy its fixture kit style and its closure-response builders).

Journeys (each its own test):

```ts
it('a trace draws the whole flow upfront with zero interactions: store holds every hop, filter keeps only the flow + ancestors, expansionUrns covers every participant chain', …)
it('budget journey: cap → budgetHit → continueWalk → exhausted, store complete', …)
it('exit restores: store nodes/edges deep-equal the pre-trace snapshot; filter returns pass-through', …)
it('a participant whose chain reaches no known anchor is spine-dropped and never merged (curated-view honesty)', …)
```

Harness shape: a small component calling `useCanvasTraceWalk(provider)` + `useTraceFilteredHierarchy({ …hierarchy fixture…, isTracing, traceNodes, drilldowns: new Map(), expandedNodes: expansionUrns })`, with a hierarchy fixture built from a handful of `HierarchyNode`s (see `useTraceFilteredHierarchy.ts` types) and a fake provider serving a 3-hop closure chain (initial + two frontier responses, `useLensWalk.test.ts` fixture style).

- [ ] **Step 1:** Write the four failing tests. **Step 2:** Run → FAIL (file wiring). **Step 3:** Wire the harness until they pass — production code changes only if a test exposes a real defect (fix in the owning module with its own unit test first). **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `git add frontend/src/components/canvas/context-view/__tests__/canvasTraceWalkSeam.test.tsx && git commit -m "test(trace): the canvas trace seam — full flow upfront, honest scope, clean exit"`

---

### Task 6: Full verification + live handoff

- [ ] **Step 1:** Full sweep in the worktree: `npx vitest run` (green; 1 known perf.test.tsx teardown error), `npx tsc --noEmit` sorted-set diff vs base = empty, `npx eslint` touched files, `npx vite build` exit 0.
- [ ] **Step 2:** Perf gates recap — confirm the three unit perf gates from Tasks 1–2 pass on repeat runs (not flaky).
- [ ] **Step 3:** Land for live testing: from the main checkout, fast-forward `feature/native-canvas-trace` is already the worktree branch — switch the main checkout to it (`git checkout feature/native-canvas-trace`), restart `synodic-dev-frontend-1`, verify served modules (`curl -s localhost:5173/src/hooks/useCanvasTraceWalk.ts | grep -c useCanvasTraceWalk` ≥ 1).
- [ ] **Step 4:** Hand the user the live checklist: dataset trace end-to-end at column grain in assigned layers; hub trace → budget strip → Keep walking; exit → browse state intact; curated view → hidden-count honesty; Lens "Open lens" + Full flow toggle unchanged; render fan-out spot-check with `window.__renderCounts()` if the harness route is used.
