# Trace Overlay Rebuild — Stage 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the store-merging native canvas trace with a pure `TraceViewModel` overlay (typed grain, extracted placement, per-pair wire ledger) rendered by `ContextViewCanvas` in trace mode — verified by a canvas-level harness — without changing what the walk engine fetches.

**Architecture:** The walk model (`useLensWalk`, unchanged in this stage) feeds a pure view model built on the Lens's `buildLensSubgraph` + `projectLensEdges`. Placement reuses a resolver **extracted** from `useLayerAssignment`; `ContextViewCanvas` swaps `renderByLayer`/edges to the VM while tracing, keeps its own `traceExpansion` set, never writes the store, and exit drops the overlay. Fixes F1–F9, F16, F17 ship here. The data layer (coarse hop-1 rework, cherry-picks, driver phase machine) is Stage 2.

**Tech Stack:** TypeScript/React 18 (React Compiler lint rules enforced), Zustand, vitest + @testing-library/react (jsdom), React Flow canvas, Tailwind. Backend untouched in Stage 1.

**Spec:** `docs/superpowers/specs/2026-08-20-trace-overlay-design.md` (read §1–§3, §9–§12 before starting).

## Global Constraints

- The canvas store (`useCanvasStore`) is **never written** during a trace (spec C1, G1); a store-write spy is a harness gate.
- Wire max depth per direction is **25** (`TraceClosureRequest` `le=25`); fetch depth never exceeds it (F3).
- **Depth rule (§9.1):** fetch depth = monotone max requested in the session; view depth/direction = instant scope, no refetch; `retrace` is a no-op for view-only changes (F2).
- Every card and wire carries explicit **grain**; rollup edges are never re-projected; a pair draws raw / rollup / raw+residual per the ledger (§3.2 step 5).
- **No synthetic lane** (R3): a chain with no view-placeable ancestor is counted in `outsideView`, never drawn.
- `childCount` always graph-counted (server, Stage 2); the VM reads `data.childCount` and never `children.length` (F5).
- React rules: no synchronous `setState` inside effects (`react-hooks/set-state-in-effect`); derived state over reset effects; `useMemo` identity stable for unchanged lanes.
- tsc baseline on `main`: 61 errors — a task may not add one. ESLint: `frontend/src/components/canvas/context-view/ContextViewCanvas.tsx` baseline 65 problems — may not grow.
- Commit after every green task, explicit paths only, always `git diff --cached --stat` before `git commit`.
- Run the full frontend suite (`npx vitest run`) before each commit that touches `ContextViewCanvas.tsx`; name the failing file before calling any failure a flake.

---

## File map (Stage 1)

| File | Responsibility |
|---|---|
| `frontend/src/components/canvas/context-view/lens/closure-adapter.ts` (modify) | Typed edge grain on `LensWalkModel.lineageEdges` (`kind`, `weight`) |
| `frontend/src/hooks/lib/resolveRootLayer.ts` (create) | Pure root-layer resolver extracted from `useLayerAssignment` |
| `frontend/src/hooks/useLayerAssignment.ts` (modify) | Calls `resolveRootLayer`; behaviour byte-identical (parity test) |
| `frontend/src/hooks/lib/traceViewModel.ts` (create) | Pure VM: cards/lanes/visibility/counts + wires/ledger |
| `frontend/src/hooks/lib/traceWireLedger.ts` (create) | Per-pair ledger + grain rule (small, pure) |
| `frontend/src/hooks/useTraceOverlay.ts` (create) | React glue: `traceExpansion` state, memoised VM, exit |
| `frontend/src/hooks/useCanvasTraceWalk.ts` (modify) | Exposes the walk model only — store merge deleted |
| `frontend/src/components/canvas/context-view/ContextViewCanvas.tsx` (modify) | Trace-mode render swap, `toggleNode` gate, ESC, store-write guards, dock adapter contract |
| `frontend/src/components/canvas/context-view/FlatTreeItem.tsx` (modify) | Chevron/count from `childCount`/`onLineage` in trace (F5) |
| `frontend/src/hooks/lib/traceHistoryStack.ts` (modify) | Entry carries `traceExpansion` (F8) |
| `frontend/src/test/canvasHarness.tsx` (create) | Mounts the REAL `ContextViewCanvas` with stubbed provider + fixtures; canary; store-write spy |
| `frontend/src/test/fixtures/traceEstates.ts` (create) | CFO-dashboard estate, Roots⊃Node×3 and ×10 estates |
| Delete | `frontend/src/hooks/lib/traceWalkMerge.ts` + test; `traceExpansionUrns` usages; `useTraceFilteredHierarchy` bypass in trace mode |

---

### Task 1: Harness dependency + canary helper (F16)

**Files:**
- Modify: `frontend/package.json` (no change expected — `html-to-image` is declared but not installed)
- Create: `frontend/src/test/canary.ts`
- Test: `frontend/src/test/__tests__/canary.test.ts`

**Interfaces:**
- Produces: `export function expectTestsRan(min: number): void` — called in an `afterAll` by every harness file; throws if vitest's collected test count for the file is below `min`.

- [ ] **Step 1: Install the missing dependency and prove `LineageLens.test.tsx` loads**

Run: `cd frontend && npm install && npx vitest run src/components/canvas/context-view/__tests__/LineageLens.test.tsx 2>&1 | grep -E "Tests|Test Files"`
Expected: `Tests  N passed` with N > 0 (today it reports 0 tests silently).

- [ ] **Step 2: Write the failing canary test**

```ts
// frontend/src/test/__tests__/canary.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { expectTestsRan } from '../canary'

describe('canary', () => {
  it('runs', () => { expect(1).toBe(1) })
  afterAll(() => { expectTestsRan(1) })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/test/__tests__/canary.test.ts`
Expected: FAIL — `Cannot find module '../canary'`.

- [ ] **Step 4: Implement the canary**

```ts
// frontend/src/test/canary.ts
import { expect } from 'vitest'

let ran = 0
/** Register in `beforeEach` of a harness file: `beforeEach(() => countTest())`. */
export function countTest(): void { ran += 1 }
/** Fails the file if fewer than `min` tests executed — catches a module
 *  that silently failed to load (e.g. a missing dependency). */
export function expectTestsRan(min: number): void {
  expect(ran, `harness canary: only ${ran} tests ran (min ${min}) — did the module load?`).toBeGreaterThanOrEqual(min)
}
```

Update the test to call `countTest()` in a `beforeEach`.

- [ ] **Step 5: Run to verify it passes, then commit**

Run: `npx vitest run src/test/__tests__/canary.test.ts` → PASS.
```bash
git add frontend/src/test/canary.ts frontend/src/test/__tests__/canary.test.ts frontend/package-lock.json
git diff --cached --stat
git commit -m "test(harness): canary helper + restore html-to-image so lens suites actually run"
```

---

### Task 2: Typed edge grain in the walk model

**Files:**
- Modify: `frontend/src/components/canvas/context-view/lens/closure-adapter.ts`
- Modify: `frontend/src/components/canvas/context-view/lens/lens-subgraph.ts` (`LensEdgeLike` gains optional fields)
- Test: `frontend/src/components/canvas/context-view/lens/__tests__/closure-adapter.test.ts`

**Interfaces:**
- Produces on `LensEdgeLike`: `kind: 'raw' | 'rollup'` (derived: `edgeType.toUpperCase() === 'AGGREGATED'` ⇒ rollup) and `weight: number | null` (from `properties.weight ?? properties.count`, else null).
- `mergeClosures` preserves `kind`/`weight` through unions (last write wins).

- [ ] **Step 1: Failing test**

```ts
it('tags edges with grain: AGGREGATED → rollup with weight, others → raw', () => {
  const m = toLensClosure(base({
    edges: [
      { id: 'r1', sourceUrn: 'a', targetUrn: 'b', edgeType: 'TRANSFORMS' },
      { id: 'g1', sourceUrn: 'A', targetUrn: 'B', edgeType: 'AGGREGATED', properties: { weight: 7 } },
    ] as never,
  }), 'F')
  expect(m.lineageEdges.find(e => e.id === 'r1')).toMatchObject({ kind: 'raw', weight: null })
  expect(m.lineageEdges.find(e => e.id === 'g1')).toMatchObject({ kind: 'rollup', weight: 7 })
})
```

- [ ] **Step 2: Run → FAIL** (`kind` undefined).

- [ ] **Step 3: Implement**

In `lens-subgraph.ts`, extend the edge type:
```ts
export interface LensEdgeLike {
  id?: string; sourceUrn: string; targetUrn: string; edgeType?: string
  /** Grain of this edge: a raw hop, or a materialised rollup cell. */
  kind?: 'raw' | 'rollup'
  /** Rollup weight (flows summarised), null for raw or unknown. */
  weight?: number | null
}
```
In `closure-adapter.ts` `toLensClosure`:
```ts
lineageEdges: res.edges.map(e => {
  const props = (e as { properties?: Record<string, unknown> }).properties ?? {}
  const isRollup = String(e.edgeType ?? '').toUpperCase() === 'AGGREGATED'
  const w = props.weight ?? props.count
  return { ...e, kind: isRollup ? 'rollup' : 'raw', weight: typeof w === 'number' ? w : null }
}),
```

- [ ] **Step 4: Run adapter + lens suites → PASS.** `npx vitest run src/components/canvas/context-view/lens`

- [ ] **Step 5: Commit**
```bash
git add frontend/src/components/canvas/context-view/lens/closure-adapter.ts frontend/src/components/canvas/context-view/lens/lens-subgraph.ts frontend/src/components/canvas/context-view/lens/__tests__/closure-adapter.test.ts
git diff --cached --stat && git commit -m "feat(lens-adapter): typed edge grain (raw|rollup) with weight on the walk model"
```

---

### Task 3: Extract `resolveRootLayer()` from `useLayerAssignment` (placement parity)

**Files:**
- Create: `frontend/src/hooks/lib/resolveRootLayer.ts`
- Modify: `frontend/src/hooks/useLayerAssignment.ts:288-346` (root priority chain) — replace the inline chain with a call
- Test: `frontend/src/hooks/lib/__tests__/resolveRootLayer.test.ts`; all four existing `useLayerAssignment.*.test.ts` stay green (the parity proof)

**Interfaces:**
- Produces:
```ts
export interface RootLayerInputs {
  nodeId: string
  nodeUrn: string
  nodeLayerProp: string | undefined      // validated stamped layerAssignment (undefined if not a view layer)
  instanceAssignment: string | undefined
  explicitAssignment: string | undefined // referenceLayout.assignments[nodeId]?.layerId
  viewIsCurated: boolean
  branchCreated: boolean                 // urn ∈ branch-created delta
  backendAssignment: string | undefined  // effectiveAssignments.get(nodeId)?.layerId
  ruleAssignment: string | undefined
  inheritedLayerId: string | undefined
  unassignedFallbackLayerId: string | undefined  // open scope showUnassigned layer
}
export function resolveRootLayer(i: RootLayerInputs): string | undefined
```
Semantics copied verbatim from the hook: instance → explicit → (curated: stamped only if branchCreated, else undefined) → (open: backend → stamped → rule → inherited → fallback); `'__UNASSIGNED__'` ⇒ undefined.

- [ ] **Step 1: Failing tests (one per branch)**

```ts
import { resolveRootLayer } from '../resolveRootLayer'
const base = { nodeId: 'n', nodeUrn: 'n', nodeLayerProp: undefined, instanceAssignment: undefined,
  explicitAssignment: undefined, viewIsCurated: false, branchCreated: false, backendAssignment: undefined,
  ruleAssignment: undefined, inheritedLayerId: undefined, unassignedFallbackLayerId: undefined }
it('instance drag outranks everything', () => {
  expect(resolveRootLayer({ ...base, instanceAssignment: 'L9', explicitAssignment: 'L1' })).toBe('L9')
})
it('curated: rules NEVER place; stamped only for branch-created', () => {
  expect(resolveRootLayer({ ...base, viewIsCurated: true, ruleAssignment: 'L2', nodeLayerProp: 'L3' })).toBeUndefined()
  expect(resolveRootLayer({ ...base, viewIsCurated: true, nodeLayerProp: 'L3', branchCreated: true })).toBe('L3')
})
it('open scope: backend → stamped → rule → inherited → showUnassigned', () => {
  expect(resolveRootLayer({ ...base, backendAssignment: 'B', nodeLayerProp: 'S', ruleAssignment: 'R' })).toBe('B')
  expect(resolveRootLayer({ ...base, nodeLayerProp: 'S', ruleAssignment: 'R' })).toBe('S')
  expect(resolveRootLayer({ ...base, ruleAssignment: 'R', inheritedLayerId: 'I' })).toBe('R')
  expect(resolveRootLayer({ ...base, inheritedLayerId: 'I' })).toBe('I')
  expect(resolveRootLayer({ ...base, unassignedFallbackLayerId: 'U' })).toBe('U')
})
it('__UNASSIGNED__ sentinel resolves to undefined', () => {
  expect(resolveRootLayer({ ...base, explicitAssignment: '__UNASSIGNED__' })).toBeUndefined()
})
```

- [ ] **Step 2: Run → FAIL** (module missing).

- [ ] **Step 3: Implement the pure resolver**

```ts
// frontend/src/hooks/lib/resolveRootLayer.ts
export function resolveRootLayer(i: RootLayerInputs): string | undefined {
  let layer: string | undefined
  if (i.instanceAssignment) layer = i.instanceAssignment
  else if (i.explicitAssignment !== undefined) layer = i.explicitAssignment
  else if (i.viewIsCurated) layer = i.branchCreated ? i.nodeLayerProp : undefined
  else layer = i.backendAssignment ?? i.nodeLayerProp ?? i.ruleAssignment ?? i.inheritedLayerId ?? i.unassignedFallbackLayerId
  return layer === '__UNASSIGNED__' ? undefined : layer
}
```
(Keep the `RootLayerInputs` interface from the Interfaces block above in this file.)

- [ ] **Step 4: Replace the inline chain in `useLayerAssignment.ts`** — inside the traversal's root branch, build `RootLayerInputs` from the existing locals (`instanceAssignment?.layerId`, `explicitAssignments.get(nodeId)`, `viewIsCurated`, `branchCreatedDelta.has(nodeUrn)`, `effectiveAssignments.get(nodeId)?.layerId`, `ruleAssignments.get(nodeId)`, `inheritedLayerId`, `unassignedFallbackLayerId`, `nodeLayerId`) and set `myLayerId = resolveRootLayer(inputs)`. Remove the now-duplicated `if (myLayerId === '__UNASSIGNED__')` line only if the resolver covers it (it does).

- [ ] **Step 5: Run parity**

Run: `npx vitest run src/hooks/lib/__tests__/resolveRootLayer.test.ts src/hooks/__tests__/useLayerAssignment.unassigned.test.ts src/hooks/__tests__/useLayerAssignment.resolve.test.ts src/hooks/__tests__/useLayerAssignment.inherit.test.ts src/hooks/__tests__/useLayerAssignment.sort.test.ts`
Expected: all PASS (browse behaviour unchanged). `npx tsc --noEmit | grep -c "error TS"` → 61.

- [ ] **Step 6: Commit**
```bash
git add frontend/src/hooks/lib/resolveRootLayer.ts frontend/src/hooks/lib/__tests__/resolveRootLayer.test.ts frontend/src/hooks/useLayerAssignment.ts
git diff --cached --stat && git commit -m "refactor(layers): extract resolveRootLayer() — browse parity pinned by the existing suites"
```

---

### Task 4: Trace estates fixtures

**Files:**
- Create: `frontend/src/test/fixtures/traceEstates.ts`
- Test: `frontend/src/test/fixtures/__tests__/traceEstates.test.ts` (shape sanity)

**Interfaces:**
- Produces: `cfoEstate()`, `rootsNodeEstate(depth: 3 | 10)`, each returning `{ model: LensWalkModel; layers: ViewLayerConfig[]; assignments: Record<string, { layerId: string }>; knownNodes: LineageNode[] }` where `knownNodes` is the browse canvas content (the view == whole source: every container appears in `knownNodes` and is explicitly assigned).

- [ ] **Step 1: Write the CFO estate** (mirrors the user's screenshot)

```ts
// frontend/src/test/fixtures/traceEstates.ts
import type { LensWalkModel, LensWalkNode } from '@/components/canvas/context-view/lens/closure-adapter'
import type { ViewLayerConfig } from '@/types/schema'

const wn = (urn: string, type: string, childCount = 0): LensWalkNode => ({
  id: urn, type: 'default', position: { x: 0, y: 0 },
  data: { urn, label: urn, type, childCount }, urn, displayName: urn, entityType: type,
}) as unknown as LensWalkNode
const raw = (s: string, t: string) => ({ id: `r:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'TRANSFORMS', kind: 'raw' as const, weight: null })
const roll = (s: string, t: string, w: number) => ({ id: `g:${s}>${t}`, sourceUrn: s, targetUrn: t, edgeType: 'AGGREGATED', kind: 'rollup' as const, weight: w })
const has = (p: string, c: string) => ({ sourceUrn: p, targetUrn: c })

export function cfoEstate() {
  // Report lane: Tableau ⊃ CFO Revenue Dashboard ⊃ {AOV by Channel ⊃ {channel, avg_order_value}}
  // Warehouse lane: INTERMEDIATE_T2 ⊃ int_clean_orders_t2 ⊃ {channel, net_revenue}; REPORTING ⊃ rpt_monthly_revenue ⊃ {channel, gross_profit}
  const nodes = [
    wn('tableau', 'dataPlatform', 1), wn('cfo', 'dashboard', 1), wn('aov', 'chart', 2), wn('aov.channel', 'schemaField'), wn('aov.avg', 'schemaField'),
    wn('INTERMEDIATE_T2', 'container', 1), wn('orders', 'dataset', 2), wn('orders.channel', 'schemaField'), wn('orders.net', 'schemaField'),
    wn('REPORTING', 'container', 1), wn('rpt', 'dataset', 2), wn('rpt.channel', 'schemaField'), wn('rpt.gross', 'schemaField'),
    wn('snowflake', 'dataPlatform', 2),
  ]
  const containmentEdges = [
    has('tableau', 'cfo'), has('cfo', 'aov'), has('aov', 'aov.channel'), has('aov', 'aov.avg'),
    has('snowflake', 'INTERMEDIATE_T2'), has('snowflake', 'REPORTING'),
    has('INTERMEDIATE_T2', 'orders'), has('orders', 'orders.channel'), has('orders', 'orders.net'),
    has('REPORTING', 'rpt'), has('rpt', 'rpt.channel'), has('rpt', 'rpt.gross'),
  ]
  const lineageEdges = [
    raw('orders.channel', 'aov.channel'), raw('orders.net', 'aov.avg'), raw('rpt.gross', 'aov.avg'),
    roll('orders', 'aov', 2), roll('rpt', 'aov', 1), roll('INTERMEDIATE_T2', 'cfo', 2), roll('REPORTING', 'cfo', 1),
  ]
  const model: LensWalkModel = {
    focusUrn: 'cfo', nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(['orders.channel', 'orders.net', 'rpt.gross', 'orders', 'rpt', 'INTERMEDIATE_T2', 'REPORTING']),
    downstreamUrns: new Set(), frontierUp: [], frontierDown: [], truncated: false, truncationReason: null,
    seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [
    { id: 'warehouse', name: 'Warehouse', order: 0, entityTypes: ['container'] },
    { id: 'report', name: 'Report', order: 1, entityTypes: ['dataPlatform'] },
  ]
  // The VIEW anchors at the container (not the platform) for the warehouse side — the screenshot's truth.
  const assignments = { INTERMEDIATE_T2: { layerId: 'warehouse' }, REPORTING: { layerId: 'warehouse' }, tableau: { layerId: 'report' } }
  return { model, layers, assignments }
}

export function rootsNodeEstate(depth: 3 | 10) {
  // Roots ⊃ Node ⊃ … ⊃ Node (depth levels) with lineage at the deepest level between two sibling chains.
  const nodes: LensWalkNode[] = [wn('ROOT', 'Roots', 2)]
  const containmentEdges: Array<{ sourceUrn: string; targetUrn: string }> = []
  for (const chain of ['a', 'b']) {
    let parent = 'ROOT'
    for (let d = 1; d <= depth; d++) {
      const urn = `${chain}${d}`
      nodes.push(wn(urn, 'Node', d < depth ? 1 : 0))
      containmentEdges.push(has(parent, urn)); parent = urn
    }
  }
  const lineageEdges = [raw(`a${depth}`, `b${depth}`)]
  const model: LensWalkModel = {
    focusUrn: `a${Math.max(1, depth - 1)}`, nodes, lineageEdges, containmentEdges,
    upstreamUrns: new Set(), downstreamUrns: new Set([`b${depth}`]), frontierUp: [], frontierDown: [],
    truncated: false, truncationReason: null, seedTruncated: false, seedCursor: null,
  }
  const layers: ViewLayerConfig[] = [{ id: 'roots', name: 'Roots', order: 0, entityTypes: ['Roots'] }]
  return { model, layers, assignments: { ROOT: { layerId: 'roots' } } }
}
```

- [ ] **Step 2: Sanity test + run + commit**

```ts
it('estates are well-formed (every containment target exists; focus present)', () => {
  for (const e of [cfoEstate(), rootsNodeEstate(3), rootsNodeEstate(10)]) {
    const ids = new Set(e.model.nodes.map(n => n.urn))
    for (const c of e.model.containmentEdges) { expect(ids.has(c.sourceUrn)).toBe(true); expect(ids.has(c.targetUrn)).toBe(true) }
    expect(ids.has(e.model.focusUrn)).toBe(true)
  }
})
```
```bash
git add frontend/src/test/fixtures/traceEstates.ts frontend/src/test/fixtures/__tests__/traceEstates.test.ts
git diff --cached --stat && git commit -m "test(trace): estate fixtures — CFO dashboard (screenshot shape) and Roots⊃Node chains at depth 3/10"
```

---

### Task 5: `TraceViewModel` — cards, lanes, visibility, counts (no wires yet)

**Files:**
- Create: `frontend/src/hooks/lib/traceViewModel.ts`
- Test: `frontend/src/hooks/lib/__tests__/traceViewModel.cards.test.ts`

**Interfaces:**
- Consumes: `buildLensSubgraph(input)` (`lens-subgraph.ts:133`) — input `LensSubgraphInput { focusUrn, nodes, lineageEdges, containmentEdges, frontierUp, frontierDown }`, returns `LensSubgraph { focusUrn, nodes: Map<string, LensSubgraphNode>, roots: string[], lineageEdges }`; each `LensSubgraphNode` has `urn, node (the LensWalkNode: entityType, displayName, data.childCount), parent: string|null, children: string[], depth, isLeaf, up, down, isFocus, hopUp: number|null, hopDown: number|null, degreeUp, degreeDown`. Access is `sg.nodes.get(urn)`. Also `resolveRootLayer` (Task 3).
- Produces:
```ts
export interface TraceCard {
  id: string; urn: string; label: string; type: string
  parentId: string | null; depth: number
  childCount: number          // graph-counted (data.childCount)
  onLineage: number           // lineage-bearing descendants incl. self
  expanded: boolean
  hop: number | null          // min lineage hop from the focus subtree (null = host only)
  role: 'focus' | 'up' | 'down' | 'both' | 'host'
}
export interface TraceLane { layerId: string; roots: TraceCard[]; cards: Map<string, TraceCard>; childrenOf: Map<string, string[]> }
export interface TraceViewInputs {
  model: LensWalkModel; focusUrn: string; layers: ViewLayerConfig[]
  assignments: Record<string, { layerId: string }>; viewIsCurated: boolean
  traceExpansion: ReadonlySet<string>; showUpstream: boolean; showDownstream: boolean
  depthUp: number; depthDown: number   // ≥ 25 ⇒ unlimited
}
export interface TraceView { lanes: TraceLane[]; visible: Set<string>; outsideView: number; counts: { up: number; down: number } }
export function buildTraceView(i: TraceViewInputs): TraceView
/** Adapter for LayerColumn: each lane → HierarchyNode trees (id, data: {...card.node.data, childCount, onLineage, traceRole}, children). */
export function lanesToHierarchy(lanes: TraceLane[]): Array<{ layerId: string; nodes: HierarchyNode[] }>
```
(`HierarchyNode` is the canvas's existing tree type — import it from where `useTraceFilteredHierarchy` imports it.)
Rules: (1) participants & hops from the subgraph over **raw** edges only; rollup-only hop-1 partners get hop 1; (2) for each participant, climb `parent` to the highest ancestor `resolveRootLayer` places (inputs from `assignments`/`layers` rules by `entityTypes`); ancestors above are dropped; no placeable ancestor ⇒ chain counted in `outsideView`; (3) a card is visible iff it is a lane root or every ancestor ∈ `traceExpansion`; the initial expansion is the caller's responsibility (Task 7 seeds the focus chain); (4) direction/depth scope: a card is in scope iff (role allowed by toggles) and (hop ≤ depth for its direction) or it hosts an in-scope descendant; (5) lanes sorted by `layers.order`, roots by label, children by label — deterministic.

- [ ] **Step 1: Failing tests (CFO estate)**

```ts
import { buildTraceView } from '../traceViewModel'
import { cfoEstate } from '@/test/fixtures/traceEstates'
const view = (expansion: string[], over = {}) => {
  const e = cfoEstate()
  return buildTraceView({ model: e.model, focusUrn: 'cfo', layers: e.layers, assignments: e.assignments, viewIsCurated: true,
    traceExpansion: new Set(expansion), showUpstream: true, showDownstream: true, depthUp: 25, depthDown: 25, ...over })
}
it('anchors chains at the VIEW-placed ancestor, never the graph root; nothing outside the view', () => {
  const v = view(['tableau', 'cfo'])
  const lanes = Object.fromEntries(v.lanes.map(l => [l.layerId, l.roots.map(r => r.id).sort()]))
  expect(lanes.warehouse).toEqual(['INTERMEDIATE_T2', 'REPORTING'])   // snowflake (platform) is chrome
  expect(lanes.report).toEqual(['tableau'])
  expect(v.outsideView).toBe(0)
})
it('R1: focus chain open, direct partners CLOSED with honest counts', () => {
  const v = view(['tableau', 'cfo'])
  expect(v.visible.has('aov')).toBe(true)           // inside the open dashboard
  expect(v.visible.has('orders')).toBe(false)       // INTERMEDIATE_T2 is closed
  const t2 = v.lanes.find(l => l.layerId === 'warehouse')!.cards.get('INTERMEDIATE_T2')!
  expect(t2.expanded).toBe(false); expect(t2.childCount).toBe(1); expect(t2.onLineage).toBe(3)  // orders + 2 fields
})
it('expanding a partner reveals one level, closed', () => {
  const v = view(['tableau', 'cfo', 'INTERMEDIATE_T2'])
  expect(v.visible.has('orders')).toBe(true)
  expect(v.visible.has('orders.channel')).toBe(false)
})
it('direction scope hides a whole branch incl. hosts; depth scopes hops', () => {
  const v = view(['tableau', 'cfo'], { showUpstream: false })
  expect(v.lanes.find(l => l.layerId === 'warehouse')?.roots ?? []).toHaveLength(0)
})
it('is deterministic', () => { expect(JSON.stringify(view(['tableau']).lanes.map(l => l.roots.map(r => r.id)))).toBe(JSON.stringify(view(['tableau']).lanes.map(l => l.roots.map(r => r.id)))) })
```

- [ ] **Step 2: Run → FAIL** (module missing).

- [ ] **Step 3: Implement `buildTraceView`** (≈150 lines). Skeleton:

```ts
export function buildTraceView(i: TraceViewInputs): TraceView {
  const sg = buildLensSubgraph({ focusUrn: i.focusUrn, nodes: i.model.nodes,
    lineageEdges: i.model.lineageEdges.filter(e => e.kind !== 'rollup'), containmentEdges: i.model.containmentEdges,
    frontierUp: i.model.frontierUp, frontierDown: i.model.frontierDown })
  const parent = (u: string) => sg.nodes.get(u)?.parent ?? null
  const rollupPartners = new Set<string>()          // hop-1 partners known only through rollups
  for (const e of i.model.lineageEdges) if (e.kind === 'rollup') {
    if (e.sourceUrn === i.focusUrn) rollupPartners.add(e.targetUrn)
    if (e.targetUrn === i.focusUrn) rollupPartners.add(e.sourceUrn)
  }
  const roleOf = (u: string): TraceCard['role'] => {
    const n = sg.nodes.get(u)!
    if (n.isFocus) return 'focus'
    const up = n.hopUp !== null || i.model.upstreamUrns.has(u)
    const down = n.hopDown !== null || i.model.downstreamUrns.has(u)
    return up && down ? 'both' : up ? 'up' : down ? 'down' : 'host'
  }
  const hopOf = (u: string): number | null => {
    const n = sg.nodes.get(u)!
    const hops = [n.hopUp, n.hopDown].filter((h): h is number => h !== null)
    if (hops.length) return Math.min(...hops)
    return rollupPartners.has(u) ? 1 : null
  }
  const participants = [...sg.nodes.keys()].filter(u => roleOf(u) !== 'host')
  const ruleFor = (type: string) => i.layers.find(l => l.entityTypes.includes(type))?.id
  const placed = new Map<string, string>()   // anchor urn → layerId
  let outsideView = 0
  for (const p of participants) {
    let anchor: string | null = null; let cur: string | null = p
    while (cur) {
      const n = sg.nodes.get(cur)!
      const layer = resolveRootLayer({ nodeId: cur, nodeUrn: cur, nodeLayerProp: undefined,
        instanceAssignment: undefined, explicitAssignment: i.assignments[cur]?.layerId, viewIsCurated: i.viewIsCurated,
        branchCreated: false, backendAssignment: undefined, ruleAssignment: ruleFor(n.node.entityType ?? ''), inheritedLayerId: undefined,
        unassignedFallbackLayerId: undefined })
      if (layer) { anchor = cur; placed.set(cur, layer) }     // keep climbing: HIGHEST placed wins
      cur = parent(cur)
    }
    if (!anchor) outsideView += 1
  }
  // build cards under each anchor (subtree of the anchor restricted to participants + their ancestors up to the anchor)
  // visibility: root or all ancestors expanded; scope by toggles/depth; counts; lanes sorted.
  return { lanes, visible, outsideView, counts }
}
```
Write it fully; every helper pure; no React imports.

- [ ] **Step 4: Run → PASS.** Also run the Roots⊃Node estate at depth 10 in a second test: with the full chain expanded, every level is visible and `childCount` is preserved at every level.

- [ ] **Step 5: Commit**
```bash
git add frontend/src/hooks/lib/traceViewModel.ts frontend/src/hooks/lib/__tests__/traceViewModel.cards.test.ts
git diff --cached --stat && git commit -m "feat(trace): TraceViewModel — cards, lanes, view-anchored placement, visibility, counts"
```

---

### Task 6: Wires — grain rule + per-pair ledger

**Files:**
- Create: `frontend/src/hooks/lib/traceWireLedger.ts`
- Modify: `frontend/src/hooks/lib/traceViewModel.ts` (add `wires`)
- Test: `frontend/src/hooks/lib/__tests__/traceViewModel.wires.test.ts`

**Interfaces:**
- Consumes: `projectLensEdges(sg, population, visible)` (`lens-subgraph.ts:505`) → `ProjectedLensEdge[]` with `{ sourceUrn, targetUrn, weight /* raw hops bundled */, isLeafEdge, edgeTypeNorm }`; it draws each raw hop between the nearest VISIBLE ancestors of its endpoints, hides hops internal to one collapsed container, and only draws hops whose BOTH endpoints are in `population`. Pass `population` = every urn in `i.model.nodes`, `visible` = `TraceView.visible`. Build `sg` from **raw** edges only (Task 5 already does) so rollups are never re-projected.
- Produces:
```ts
export interface TraceWire { id: string; source: string; target: string; edgeCount: number; isBundled: boolean
  kind: 'raw' | 'rollup' | 'residual'; complete: boolean }
export type PairState = 'complete' | 'partial' | 'none'
export function pairKey(src: string, dst: string): string          // `${src}>${dst}`
export interface PairLedger { state(src: string, dst: string): PairState; rawCount(src: string, dst: string): number }
export function buildLedger(model: LensWalkModel, completePairs: ReadonlySet<string>): PairLedger
```
`TraceView.wires: TraceWire[]` added. Grain rule per visible pair: raw evidence per pair = `projectLensEdges(...)` bundles keyed `${sourceUrn}>${targetUrn}` (`edgeCount = weight`, `kind: 'raw'`, `isBundled = !isLeafEdge`); rollup edges draw only when BOTH `sourceUrn` and `targetUrn` ARE visible cards (a rollup is never re-anchored); if the pair has raw evidence and ledger = `complete` ⇒ raw only; `none` ⇒ rollup (`edgeCount = weight ?? 1`); `partial` ⇒ raw + one `residual` wire with `edgeCount = weight − rawCount` (≥1). In Stage 1 `completePairs` = all pairs (the model is the fine closure); Stage 2's driver feeds the real ledger.

- [ ] **Step 1: Failing tests**

```ts
it('closed partners: rollup wires at card grain with weights; no raw leaks', () => {
  const v = view(['tableau', 'cfo'])
  const w = v.wires.map(x => `${x.source}>${x.target}:${x.kind}:${x.edgeCount}`).sort()
  expect(w).toEqual(['INTERMEDIATE_T2>cfo:rollup:2', 'REPORTING>cfo:rollup:1'].sort())
})
it('opening both sides refines to raw field wires and drops the rollup for that pair', () => {
  const v = view(['tableau', 'cfo', 'aov', 'INTERMEDIATE_T2', 'orders'])
  const kinds = new Set(v.wires.filter(x => x.source.startsWith('orders')).map(x => x.kind))
  expect(kinds).toEqual(new Set(['raw']))
  expect(v.wires.some(x => x.source === 'orders.channel' && x.target === 'aov.channel')).toBe(true)
})
it('partial pair: raw + residual W−R', () => {
  const e = cfoEstate()
  const v = buildTraceView({ ...inputs(e, ['tableau','cfo','aov','INTERMEDIATE_T2','orders']), completePairs: new Set() })
  const res = v.wires.find(x => x.kind === 'residual')
  expect(res).toBeTruthy()
})
it('count parity: Σ raw wire counts == raw edges between visible-scoped endpoints', () => { /* compute both sides and compare */ })
it('no wire is ancestor↔descendant and every endpoint is a visible card', () => { /* assert */ })
```
(`completePairs` becomes an optional field on `TraceViewInputs`, default = all pairs.)

- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement ledger + wires** (pure; emit the overlay's `bundle-*` id convention: `bundle:${source}>${target}:${kind}`).
- [ ] **Step 4: Run → PASS** (both wires and cards suites).
- [ ] **Step 5: Commit** `feat(trace): wire projection with grain rule and per-pair ledger (raw / rollup / residual)`.

---

### Task 7: `useTraceOverlay` + canvas harness (store-write spy, canary)

**Files:**
- Create: `frontend/src/hooks/useTraceOverlay.ts`
- Create: `frontend/src/test/canvasHarness.tsx`
- Test: `frontend/src/components/canvas/context-view/__tests__/traceCanvas.harness.test.tsx`

**Interfaces:**
- Produces:
```ts
export interface TraceOverlay {
  active: boolean
  view: TraceView | null
  traceExpansion: ReadonlySet<string>
  toggle(id: string): void                  // flip expansion (no fetch in Stage 1)
  expandPath(ids: readonly string[]): void  // reveal/search: open a chain
  exit(): void
}
export function useTraceOverlay(args: { model: LensWalkModel | null; focusUrn: string | null; layers: ViewLayerConfig[];
  assignments: Record<string, { layerId: string }>; viewIsCurated: boolean; showUpstream: boolean; showDownstream: boolean;
  depthUp: number; depthDown: number }): TraceOverlay
```
Seeds `traceExpansion` with the focus's ancestor chain + focus **when `focusUrn` changes** — implemented as DERIVED state (`useState` keyed by focus via the "state-from-props" reset pattern: store `{ forFocus, set }` and recompute when `forFocus !== focusUrn` during render), never as a reset effect. `view` is `useMemo(buildTraceView, [...])`.

Harness (`canvasHarness.tsx`): `renderCanvasWithTrace(estate, { focus })` mounts the REAL `ContextViewCanvas` with a provider stub whose `traceClosure` returns the estate model as ONE response (frontiers empty) and whose other reads serve `knownNodes`; installs a **store-write spy** (`useCanvasStore.subscribe` counting state changes to `nodes`/`edges` after trace start); exposes `snapshotStore()`; registers the canary. If mounting the full canvas proves infeasible in jsdom within this task (ResizeObserver/React Flow measured nodes — see memory: controlled nodes MUST carry `measured`), the harness mounts the trace-mode subtree (`LayerColumn`s + overlay) with the same props — document which, and the VM tests remain the primary gate.

- [ ] **Step 1: Failing harness test**

```tsx
it('CFO trace: dashboard chain open, partners closed with counts, two rolled wires, zero store writes, exit restores', async () => {
  const h = await renderCanvasWithTrace(cfoEstate(), { focus: 'cfo' })
  await h.startTrace('cfo')
  expect(h.visibleCardIds().sort()).toEqual(['INTERMEDIATE_T2', 'REPORTING', 'aov', 'cfo', 'tableau'])
  expect(h.chevron('INTERMEDIATE_T2')).toBe(true)
  expect(h.wires().map(w => `${w.source}>${w.target}`).sort()).toEqual(['INTERMEDIATE_T2>cfo', 'REPORTING>cfo'])
  expect(h.storeWrites()).toBe(0)
  const before = h.snapshotStore()
  h.pressEscape()
  expect(h.isTracing()).toBe(false)
  expect(h.snapshotStore()).toEqual(before)
})
```

- [ ] **Step 2: Run → FAIL** (harness module missing).

- [ ] **Step 3: Implement `useTraceOverlay`**

```ts
// frontend/src/hooks/useTraceOverlay.ts
import { useCallback, useMemo, useState } from 'react'
import { buildTraceView, type TraceView } from './lib/traceViewModel'
import { buildLensSubgraph, focusAncestorChain } from '@/components/canvas/context-view/lens/lens-subgraph'
// (args/TraceOverlay types from the Interfaces block above)
export function useTraceOverlay(a: UseTraceOverlayArgs): TraceOverlay {
  // Derived state keyed by focus: when the focus changes, the expansion is
  // re-seeded DURING RENDER (React "adjusting state on prop change"), never
  // in an effect — react-hooks/set-state-in-effect is enforced.
  const [exp, setExp] = useState<{ forFocus: string | null; set: Set<string> }>({ forFocus: null, set: new Set() })
  const seeded = useMemo(() => {
    if (!a.model || !a.focusUrn) return new Set<string>()
    const sg = buildLensSubgraph({ focusUrn: a.focusUrn, nodes: a.model.nodes, lineageEdges: [], containmentEdges: a.model.containmentEdges, frontierUp: [], frontierDown: [] })
    return new Set([...focusAncestorChain(sg), a.focusUrn])
  }, [a.model, a.focusUrn])
  if (exp.forFocus !== a.focusUrn) setExp({ forFocus: a.focusUrn, set: seeded })
  const traceExpansion = exp.forFocus === a.focusUrn ? exp.set : seeded

  const view = useMemo<TraceView | null>(() => (a.model && a.focusUrn
    ? buildTraceView({ model: a.model, focusUrn: a.focusUrn, layers: a.layers, assignments: a.assignments, viewIsCurated: a.viewIsCurated,
        traceExpansion, showUpstream: a.showUpstream, showDownstream: a.showDownstream, depthUp: a.depthUp, depthDown: a.depthDown })
    : null), [a.model, a.focusUrn, a.layers, a.assignments, a.viewIsCurated, traceExpansion, a.showUpstream, a.showDownstream, a.depthUp, a.depthDown])

  const toggle = useCallback((id: string) => setExp(p => { const s = new Set(p.set); s.has(id) ? s.delete(id) : s.add(id); return { ...p, set: s } }), [])
  const expandPath = useCallback((ids: readonly string[]) => setExp(p => ({ ...p, set: new Set([...p.set, ...ids]) })), [])
  const exit = useCallback(() => setExp({ forFocus: null, set: new Set() }), [])
  return { active: !!a.focusUrn && !!a.model, view, traceExpansion, toggle, expandPath, exit }
}
```
(`focusAncestorChain(sg)` at `lens-subgraph.ts:293` returns `Set<string>` of ancestor urns, focus excluded.)

- [ ] **Step 4: Implement the harness** (`renderCanvasWithTrace`, `startTrace`, `visibleCardIds`, `chevron`, `wires`, `storeWrites`, `snapshotStore`, `pressEscape`, `isTracing`). The store-write spy:

```ts
const writes = { count: 0 }
const unsub = useCanvasStore.subscribe((s, prev) => { if (s.nodes !== prev.nodes || s.edges !== prev.edges) writes.count += 1 })
```
Reset `writes.count = 0` after `startTrace` resolves the initial closure so browse hydration writes are excluded.

- [ ] **Step 5: Run the harness test** — it stays RED until Task 8 swaps the canvas (expected). Commit the hook and harness now, with the harness test file included:

```bash
git add frontend/src/hooks/useTraceOverlay.ts frontend/src/test/canvasHarness.tsx frontend/src/components/canvas/context-view/__tests__/traceCanvas.harness.test.tsx
git diff --cached --stat && git commit -m "feat(trace): useTraceOverlay + canvas harness (store-write spy, canary) — red until the canvas swap"
```

---

### Task 8: Canvas trace-mode swap (F1, F5, F9, F17) + delete the store merge

**Files:**
- Modify: `frontend/src/components/canvas/context-view/ContextViewCanvas.tsx` — trace sections (`canvasTrace`, `traceActive`, `renderByLayer`, `expandedForRender`, `traceVisibleUrns`, `toggleNode`, `onExitTrace`, reveal/search hooks)
- Modify: `frontend/src/hooks/useCanvasTraceWalk.ts` — remove the store merge effect and `exit` store removals; keep `start/exit/walkEntry/fullWalkStatus/continueWalk/retryWalk/tracedUrn`
- Modify: `frontend/src/components/canvas/context-view/FlatTreeItem.tsx:169,195` — in trace mode count/chevron from `data.childCount` / `data.onLineage`
- Delete: `frontend/src/hooks/lib/traceWalkMerge.ts`, its test; `traceExpansionUrns` imports
- Test: Task 7's harness test goes GREEN; `canvasTraceWalkSeam.test.tsx` journeys re-hosted (store untouched now)

Steps (each a commit-able slice):
- [ ] **8a** `useCanvasTraceWalk`: delete the merge effect, `sessionRef`, `addedEdgeIds`; `exit` only clears `tracedUrn`. Update `useCanvasTraceWalk.test.ts` to assert the store is untouched. Run → green. Commit `refactor(trace): walk controller no longer merges into the store`.
- [ ] **8b** `ContextViewCanvas` swap. The seams (line numbers on `main` b4acafe7):

```ts
// L1573 — after `const canvasTrace = useCanvasTraceWalk(provider)`
const overlay = useTraceOverlay({
  model: traceModel, focusUrn: canvasTrace.tracedUrn, layers: viewLayers, assignments: explicitLayerAssignments,
  viewIsCurated, showUpstream: traceShowUpstream, showDownstream: traceShowDownstream,
  depthUp: traceDepthUp, depthDown: traceDepthDown,
})
// (`viewLayers`, `explicitLayerAssignments`, `viewIsCurated` are the values already passed to useLayerAssignment — reuse those identifiers.)

// L1690-1717 — DELETE `traceVisibleUrns` and `expandedForRender`; trace visibility now lives in overlay.view.

// L1867 — useTraceFilteredHierarchy: pass `isTracing: false` (the VM already scoped); after it:
const renderByLayer = overlay.active && overlay.view
  ? lanesToHierarchy(overlay.view.lanes)          // pure adapter in traceViewModel.ts: TraceLane → { layerId, nodes: HierarchyNode[] }
  : browseByLayer

// L3108 — useEdgeProjection: keep for browse; in trace mode:
const visibleLineageEdges = overlay.active && overlay.view
  ? overlay.view.wires.map(w => ({ id: w.id, source: w.source, target: w.target, edgeCount: w.edgeCount, isBundled: w.isBundled, kind: w.kind }))
  : browseVisibleLineageEdges
// Remove the `traceAddedEdgeIds` prop and the trace-bundling block from the useEdgeProjection call.

// L2856 — toggleNode: FIRST statement
if (overlay.active) { overlay.toggle(nodeId); return }

// L1674 — exit: overlay.exit() then canvasTrace.exit(). Also: ESC handler (F1) →
useEffect(() => {
  if (!overlay.active) return
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onExitTrace() }
  window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
}, [overlay.active, onExitTrace])

// L3041-3043 — collapse branch: `if (overlay.active) return` is already guaranteed by the toggleNode gate; delete the `removeEdgesByNodeIds(subtreeIds, canvasTrace.addedEdgeIds)` line.
// L466-474 legacy `exitTrace` (useUnifiedTrace) untouched in Stage 1 (Stage 4 retires it).
```
F9: `revealNode`/search-result/auto-scroll call sites that today `setExpandedNodes` → when `overlay.active`, compute the containment chain from `overlay.view` (card `parentId` walk) and call `overlay.expandPath(chain)` instead. F17: add `if (overlay.active) return` at the top of `onNodeDoubleClick`, `loadMoreChildren`, `onReorderNodes`, `onNodeDragStop`, `onConnect`.

Run: the harness → green; `npx vitest run`; `npx tsc --noEmit | grep -c "error TS"` → 61; `npx eslint src/components/canvas/context-view/ContextViewCanvas.tsx | tail -1` → ≤ 65 problems. Commit:
```bash
git add frontend/src/components/canvas/context-view/ContextViewCanvas.tsx frontend/src/hooks/lib/traceViewModel.ts frontend/src/components/canvas/context-view/__tests__/traceCanvas.harness.test.tsx
git diff --cached --stat && git commit -m "feat(trace): canvas renders the trace overlay — store untouched, ESC exits"
```
- [ ] **8c** `FlatTreeItem` F5 + `LayerColumn` trace-mode header "N on this lineage" from `data.onLineage`. Harness asserts chevrons + count text. Commit.
- [ ] **8d** Delete `traceWalkMerge.ts` + test; re-host the seam journeys (budget/hands-free/exhausted; upstream-only hides hosts; depth-1 view instant; exit restores) in the harness file. Commit `chore(trace): remove the store-merge path`.

---

### Task 9: Dock adapter contract + history (F2, F3, F4, F7, F8)

**Files:**
- Modify: `ContextViewCanvas.tsx` `dockTrace` adapter (`config/setConfig` intercepts, `retrace`, `truncated` mapping) and `TraceDepthControl` props; `frontend/src/components/canvas/trace/TraceDockControls.tsx` (hide `lineageEdgeTypes`/level when `nativeMode`); `frontend/src/hooks/lib/traceHistoryStack.ts` (+`traceExpansion: string[]` on the view)
- Test: `traceHistoryStack.test.ts` (+exact-picture restore), harness (20 direction toggles ⇒ 0 provider calls; depth preset 50 ⇒ request depth 25 — Stage 1 asserts the VIEW cap since fetch is unchanged), dock test (controls hidden in native mode)

- [ ] Steps: failing tests → implement: depth values > 25 are view-only and labelled; dock arrows set view toggles only; `retrace` → no-op when only view fields changed; `outsideView` rendered in the dock overview strip; history entry `view.traceExpansion` saved on every toggle (debounced 250 ms) and restored on back/forward/resume. Commit `feat(trace): dock adapter contract — one depth rule, no retrace on view changes, exact-picture history`.

---

## Stage gate (before Stage 2)

- [ ] Full frontend suite green; tsc 61; ContextViewCanvas eslint ≤ 65; harness canary ≥ 8 tests.
- [ ] Live check on the dev stack (no service restarts needed — Stage 1 is frontend-only): trace CFO Revenue Dashboard on `nexus_lineage` → R1 picture; expand `int_clean_orders_t2` → field wires; collapse → rolled; ESC exits; browse layout unchanged after exit.
- [ ] User sign-off. Then write `2026-08-2x-trace-overlay-stage2.md` (data layer: cherry-picks F10/F18/F19/F20, focus-anchored coarse hop-1 with weight F11, label-bucketed `_edges_between_sets_once` F12, driver phase machine/abort/LRU F13/F14, request-count capsule), Stage 3 (scale: row windowing F6, incremental VM, 25k fixture, real-browser probe), Stage 4 (legacy `useUnifiedTrace` retirement, certification script in repo, docs).
