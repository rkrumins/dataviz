# Native Canvas Trace — Overlay Rebuild (design)

**Date:** 2026-08-20 · **Branch:** `feature/native-canvas-trace` (== `main` @ b4acafe7) · **Status:** awaiting user review

## 0. The north star (user, verbatim)

> "Solidatus like where we can see the full Trace of the lineage end to end —
> just like as if we did it via Lineage Lens if we had gone through every
> single path."

Operational reading: **the data is the complete closure** (every path, both
directions, N hops — exactly what the Lens accumulates if you ⊕ every pill);
**the presentation is progressive** — you see the focus and what feeds it
directly, at the grain you are looking at, and every expand refines the
wires toward the finer items you just opened. Collapse rolls them back up.

## 1. Why the previous attempt (2026-08-18 → 20, reverted) failed

Evidence-backed, not self-flagellation — each item is a design constraint below.

| # | Failure | Root cause | Constraint it produces |
|---|---|---|---|
| 1 | Trace data fought six browse-mode subsystems in sequence (curated drop → lane; expansion ×4 rulings; collapse-prune deleted trace containment; `childCount` missing; projection drew bundles at field grain) | The walk model was **merged into `canvas.nodes`**, then every browse subsystem re-interpreted it under browse assumptions | **C1 — Overlay, never a store merge.** Trace owns its own view model end to end; the store is untouched; exit = drop the overlay. |
| 2 | "Open everything" ↔ "roll everything up" oscillation; screenshot: field-grain cards, bundle-grain wire | **Grain was never first-class** | **C2 — Every card and every wire carries an explicit grain**; wires are re-projected onto the nearest VISIBLE card with counts; expansion refines, collapse re-rolls. |
| 3 | "0 orphans" in a pipeline test vs 1,774 orphans live; a full-scan regression invisible on a 10-node estate | **No canvas-level harness; toy-estate live tests** | **C3 — Harness first**: `ContextViewCanvas` rendered with a stubbed provider on the user's estate shapes; scale-class changes certified on `solidatus-test-large`. |
| 4 | "Trace = filter" vs "trace = the Lens walk" never reconciled | Two models, one codebase | **C4 — One model: the Lens's.** Complete closure in memory, progressive presentation. |
| 5 | The per-anchor frontier lane + hands-free grants became an unattended 2,300-request march against a restarting backend | Engine reused the Lens's interactive fetch shape for whole-flow assembly; restarts mid-session | **C5 — Scale-shaped fetch** (coarse-first, escalation pages, bulk drains — all certified on the backup branch) and **no service restarts during the user's live session without telling them**. |

## 2. Rulings (user, 2026-08-20, binding)

- R1 **Initial picture** for a container focus: the focus's own chain open; its **direct** feeders/consumers as **closed cards at their own grain** with rolled wires and honest counts. Nothing else auto-opens.
- R2 **Fetch (revised per architecture review)**: a **focus-anchored coarse hop-1** first (the rollup edges incident to the focus's own card at the VIEW's anchor grain — "what feeds this item directly", instant), then the hands-free engine fills the **complete** leaf-grain closure in the background; expansions answer from memory; a lazy drill covers grains the model lacks; the ~25k-node ceiling asks once. The old roots+1 walk anchored at the graph ROOT is withdrawn: for a dashboard inside Tableau it returned *Tableau's* lineage, at a chrome grain the view cannot draw.
- R3 **Placement (revised 22:15)**: **there is NO trace lane.** Everything traced is already in the view (the user's test view == the whole data source); a synthetic "unmapped" layer is a non-realistic artefact. Each traced chain is anchored at the **highest node the view itself places** (explicit assignment, stamped assignment, or a layer rule) — exactly where browse would put it — and ancestors above that anchor are not drawn (they are chrome, as in browse). A chain with no placeable node at ANY level is genuinely outside the view: it is COUNTED in the existing "outside this view" chip, never drawn in a fake lane. On a view that equals its source that count must be zero — if it is not, that is a placement bug to surface, not to hide.
- R4 **Harness first.**
- Standing: recursive Node⊃Node⊃Node containment; `childCount` counted from the graph, never the property; no "Keep walking" pedaling inside the ceiling; the capsule narrates; collapse is visual and re-rolls wires.

## 3. Architecture

```
                 ┌────────────────────────────────────────────────────────┐
  /trace/closure │  WALK ENGINE  (useLensWalk, fullWalk, grain-adaptive)   │  complete closure model
  (coarse, then  │  coarse roots+1 → escalation 2k/6k/10k → bulk drains   │  (LensWalkModel: nodes,
   fine pages)   │  hands-free to ceiling · lazy drill on demand           │   lineage edges, containment)
                 └──────────────────────────┬─────────────────────────────┘
                                            ▼
                 ┌────────────────────────────────────────────────────────┐
                 │  TraceViewModel  (PURE)                                 │
                 │  in:  model, focus, view layers+rules, traceExpansion,  │
                 │       direction toggles, hop depths, hiddenTypes        │
                 │  out: lanes[{layerId, roots: CardTree}], wires[],        │
                 │       focusId, counts, hiddenByLayer, laneRoots          │
                 └──────────────────────────┬─────────────────────────────┘
                                            ▼
                 ┌────────────────────────────────────────────────────────┐
                 │  ContextViewCanvas (trace mode)                          │
                 │  renderByLayer ← vm.lanes   edges ← vm.wires             │
                 │  toggle/collapse ← traceExpansion (NOT expandedNodes)    │
                 │  exit ← drop overlay; store never touched               │
                 └────────────────────────────────────────────────────────┘
```

### 3.1 Data layer (salvaged, certified — `backup/native-canvas-trace-2026-08-20`)
Cherry-pick, not re-derive: hands-free engine auto-grants (`bcac85a7`), escalation lane + `TRACE_MAX_NODES_HARD` (`bb6bd866`), bulk frontier drain (`10c05fd2`), containment chunking + chain synthesis (`0d7a9f02`), index-anchored coarse walk (`9a284230`+`9474c113`), structural drill (`d5d03550`), `childCount` from the graph (`0f6bac43`+`7c36a4d5`), versioned closure (`41556de3`), AGGREGATED-only vocabulary rescue (`583f858f`). **Not salvaged:** anything that wrote into `canvas.nodes` or `useLayerAssignment`'s curated branch (the lane fallback inside placement, `traceExpansionUrns`, store merge in `useCanvasTraceWalk`).

Fetch sequence per trace — an explicit **phase machine** in the driver (coarse → fine → complete | ceiling): (1) `grain:'coarse'` request `{urn: focus, anchorDepth|anchorTypes from the view}` — hop-1 rollup partners of the focus's card at the view's anchor grain, **with `weight`** (~0.3s) → render; (2) fine closure in background (escalation/bulk), merges **coalesced** (≤1 per frame), **AbortController** cancels server work on exit/re-focus, per-focal model cache is an **LRU(3)**; (3) model complete, or the ceiling asks once. Deeper hops come ONLY from the fine walk (rollup transitivity ≠ leaf transitivity — a coarse BFS past hop 1 admits paths that do not exist at leaf grain). A container whose finer grain is not yet in the model drills lazily (`expandAggregated` structural) while the capsule shows "refining"; drills merge into the MODEL with their pair ledger entry.

### 3.2 `TraceViewModel` (pure; `frontend/src/hooks/lib/traceViewModel.ts`)
Inputs: `LensWalkModel`, `focusUrn`, `layers: ViewLayerConfig[]`, `assignments/rules` (the same inputs `useLayerAssignment` consumes), `traceExpansion: Set<urn>`, `showUp/showDown`, `depthUp/depthDown`, `hiddenTypes`.

Steps (each a pure function with its own tests):
1. **Participants & hops** — **consume `buildLensSubgraph`** (parent/children/depth/hopUp/hopDown/degrees) so parity with the Lens is structural, not asserted; `traceViewFilter` becomes a thin predicate over the subgraph (its own BFS is deleted). Hops and depth scoping run over **raw edges only**; a rollup-only hop-1 partner gets hop 1.
2. **Trees** — build containment trees from `model.containmentEdges` for every participant chain up to its top-most root (full chains always: C1 ⇒ no spine/anchor rules needed; nothing can orphan).
3. **Placement** — **extract `resolveRootLayer()` from `useLayerAssignment`** (never re-implement it): the real chain is instanceAssignment → explicit → *curated scope: rules never place, stamped only for branch-created* → open scope: backend `effectiveAssignments` → stamped → rule → inherit → `showUnassigned` layer (a view-configured lane — honoured, not "synthetic"), plus HARD-RULE child inheritance and `inheritsChildren:false`. For each chain, the highest ancestor that resolver places is the lane root; ancestors above are chrome. A **placement-parity test** runs browse's `useLayerAssignment` on the same fixture and compares `nodeLayerMap` per traced node. That node becomes the lane root; ancestors above it are dropped from the tree (chrome). A chain with no placeable node is counted as outside-the-view, not drawn (R3). **Why the old lane filled up despite full view coverage:** the previous design anchored at the graph's absolute top-most root (e.g. the platform), which the view never assigns — browse anchors at the container below it.
4. **Visibility** — a card is visible iff every ancestor is in `traceExpansion`; **initial expansion = focus chain only** (R1). Each visible card carries `grain = depth` and `childCount` (from the model/graph).
5. **Wire projection — the GRAIN RULE.** The model's edges are **typed**: `{kind:'raw'} | {kind:'rollup', srcDepth, tgtDepth, weight}` (no mixed list — the engine filters rollups out of the fine closure precisely to avoid the "5 in / 4 out" double count, and the worker materialises a rollup cell per level PAIR, so one flow appears as root↔root, root↔child, child↔root, child↔child). **Raw** edges re-project via `projectLensEdges` (nearest visible ancestor, directional bundling, `isLeafEdge`), dropping ancestor↔descendant projections and coincident endpoints (those become the card's "N on this lineage" count). **Rollup** edges are NEVER re-projected: drawn only when both endpoints ARE the visible cards. A **per-pair ledger** `{pairKey → complete | partial}` (fed by the driver and drills) decides, per visible pair: raw wires when complete; rollup wire when no raw evidence; raw wires **plus a residual rollup wire `W − R`** when partial (browse's `isResidual` semantics). Wires emit the overlay's existing `bundle-*` shape: node-ID endpoints, `edgeCount`, `isBundled`, `isAggregated`/coarse styling. Rollup counts are "≈W" while aggregation stamps are stale; raw always wins.
6. **Counts** — per card: on-this-lineage descendants; per lane: roots; global: up/down participants, hiddenByLayer (type-chip hidden).

Determinism: same inputs → identical output (sorted by urn); idempotent across model growth (a grown model only ADDS).

### 3.3 Rendering (ContextViewCanvas, trace mode)
- `renderByLayer` ← `vm.lanes` (HierarchyNode-shaped cards so `LayerColumn` renders unchanged: chevrons from `childCount`, counts in the header).
- `visibleLineageEdges` ← `vm.wires` (bypass `useEdgeProjection` in trace mode; the overlay's bundling/coarse styling reads `count`/`coarse`).
- `toggleNode` in trace mode mutates **`traceExpansion` only** (no `loadChildren`, no store writes, no prune); if the model lacks the card's finer grain, request a lazy drill and merge into the MODEL (not the store).
- Capsule states: coarse drawn → "refining in background N nodes · M flows" → complete; ceiling → asks once.
- Exit: `traceExpansion` cleared, overlay dropped; the browse canvas is exactly as it was.

### 3.4 Interaction invariants (tests)
- Expand refines: wires touching the opened card re-project one grain finer; the parent-grain bundle disappears.
- Collapse re-rolls: the exact inverse; nothing removed from any model.
- Recursive Node⊃Node⊃Node: each level keeps its chevron; expansion to any depth; wires follow.
- Direction toggles & depths scope the VIEW instantly, no refetch (see §9.1 for the single depth rule).
- Never orphaned: every visible card has a visible parent or is the lane root the VIEW placed; no synthetic lane exists.

## 4. Harness first (R4) — `frontend/src/components/canvas/context-view/__tests__/traceCanvas.harness.test.tsx`
Renders the REAL `ContextViewCanvas` with a stubbed provider and three fixtures shaped from the user's estates:
- **nexus / CFO Revenue Dashboard**: Tableau ⊃ dashboard ⊃ charts ⊃ fields; Warehouse datasets ⊃ fields; field→field lineage. Assert R1 picture: dashboard chain open, `int_clean_orders_t2`/`rpt_monthly_revenue` as closed cards with "N on this lineage", ONE rolled wire each; expand a dataset → field-grain wires to the dashboard's fields; collapse → re-rolled.
- **pipeline / Roots⊃Node⊃Node⊃Node**: chevrons at every level; 3 expansions deep; wires refine each time.
- **big-flow shape**: 2,000-node model; render budget (≤ 200ms view-model, board paints) and zero orphans.
Scale-class changes are additionally certified live on `solidatus-test-large` (probe script kept in `backend/scripts/`, not `/tmp`).

## 5. Acceptance (user validates live)
1. Trace CFO Revenue Dashboard → ≤1s: dashboard open, direct feeders closed with counts and rolled wires, nothing else open.
2. Expand `int_clean_orders_t2` → its fields appear; wires now point field→(chart field or dashboard, whichever is visible); collapse → back.
3. Expand the dashboard's charts → wires refine to chart fields; every visible wire has lineage beneath it; none missing (count parity with the Lens on the same focus).
4. Node⊃Node⊃Node estate: 3+ levels expandable, chevrons everywhere, wires at every grain.
5. `solidatus-test-large` container: coarse picture ≤2s, background fill hands-free, **no synthetic lane at all**; every traced card in the layer browse would show it in; "outside this view" count == 0 on a full-coverage view.

## 6. Risks & mitigations
- Coarse (rollup) wires vs fine wires double-drawing → VM draws fine wires only where the model holds them, coarse elsewhere (per projected pair), never both.
- `LayerColumn` assumes store-backed HierarchyNodes → adapter builds identical shapes; harness asserts chevrons/counts.
- Placement anchor mismatch (graph root vs view-assigned grain) → harness fixture mirrors the screenshot: platform ⊃ container ⊃ dataset ⊃ field with the VIEW assigning the container; assert the container is the lane root and the platform is not drawn.
- Memory ceiling on giant flows → capsule asks once; VM never holds more than the model.
- Service restarts mid-session → announced, never silent (C5).

## 7. Build order (after spec approval → writing-plans)
1. Harness + fixtures (RED on today's canvas).
2. `TraceViewModel` pure functions (TDD against fixtures).
3. Canvas trace-mode render swap + `traceExpansion` + exit.
4. Cherry-pick the data layer from the backup branch; wire coarse-first + background fill + lazy drill.
5. Live certification on the three estates; capsule narration.

## 8. Scale & performance (millions of nodes/edges) — binding budgets

Every number below was either measured this week on `solidatus-test-large`
(1.23M nodes / 1.17M raw + 1.23M rollup edges) or is a budget the harness and
the live probe must prove. "Complete" always means **complete at every grain
you are looking at** — never "every leaf in RAM".

### 8.1 The scale principle
A trace on a million-node graph never loads the graph. It loads three things:
1. the **coarse picture** — the flow at roots+1 from the materialised rollup
   lane: small on ANY graph (measured: 443 nodes / 9,017 rollup edges /
   423 containment, **296 ms warm, 1.85 s cold**);
2. the **fine closure** — the focus's complete leaf-grain lineage, filled in
   the background, hands-free, **bounded by a memory ceiling** (~25k nodes);
3. **on-demand grain** — when you open a card whose finer grain is not in
   the model (huge flows past the ceiling), ONE structural drill fetches
   exactly that slice (measured: **254 ms**, 46 nodes / 434 edges / 44
   containment for a root-pair).
So completeness is guaranteed per visible grain, and the client's memory is
proportional to what you have looked at, not to the graph.

### 8.2 Server budgets (all index-anchored; a full scan is a bug)
| Path | Mechanism | Budget |
|---|---|---|
| Coarse hop-1 (focus-anchored, view anchor grain) | label-bucketed, rollup lane, ships `weight` | ≤ 2 s cold, ≤ 0.5 s warm (measured roots+1 variant: 1.85 s / 296 ms) |
| Fine closure page | escalation pages 2k → 6k → 10k (`TRACE_MAX_NODES_HARD`), excludes keep known nodes off the wire | ≤ 2 s per page (measured 1.9 s @ 6k) |
| Frontier tail | bulk drains, 200 seeds/request, per direction | ≤ 24 requests per 2,300 anchors (12 per direction; was 2,300) |
| Containment | 400-pair chunks + chain synthesis on timeout | **never empty**; ≤ 2 s per chunk |
| Drill on expand | structural `expandAggregated`, `nextLevel:null`; `_edges_between_sets_once` must be label-bucketed (it anchors with an unlabeled `urn IN` today) | ≤ 300 ms (measured 254 ms on the rollup path; raw fallback uncertified) |
| `childCount` | live `count(child)` per batch, label-bucketed | included in the batch query; never the property |
| Cache | redis 300 s + LKG keyed on the full request | repeat traces serve in ms |
Hard rule: no per-anchor request storms; the capsule counts requests and the
harness asserts the request count per journey.

### 8.3 Client model & view-model budgets
- **Model**: deduped maps keyed by urn (nodes, parent pointer, children list,
  edges by endpoint). At the 25k ceiling ≈ 40–60 MB. Background merges are
  **coalesced** (≤ 1 merge per 200 ms / per animation frame) so the board never
  re-renders per response; view-model recompute runs in a chunked idle task
  (no main-thread task > 50 ms during fill).
- **TraceViewModel is incremental.** Expansion/collapse changes are local: only
  the toggled subtree's visibility and only the wires touching it are
  re-projected (edges indexed by endpoint; nearest-visible-ancestor memoised
  per expansion version; bundles keyed `(srcVisible, dstVisible)`). Budget:
  **≤ 16 ms** per expand/collapse on a 25k-node model. Unchanged lanes keep
  their object identity (structural sharing) so `LayerColumn` memos hold.
- **Direction/depth scoping** cuts both the VIEW and the FETCH: a depth-3
  trace walks to depth 3, not 25.

### 8.4 Rendering budgets
- Cards: `LayerColumn`'s row virtualisation stays in force. Row windowing at 8 with "N more" is a **new `LayerColumn` change** scoped in the plan (no such window exists today; trace currently suppresses load-more at `LayerColumn.tsx:437`).
- Wires: projected onto visible cards and **bundled with counts**; the overlay
  never draws more than the viewport's wires (viewport culling on both cards
  and wires; hit-testing already degrades past `HIT_DENSITY_LIMIT`). Data is
  never dropped to meet a draw budget — it is bundled.
- Frame budget: expand/collapse paints within one frame after the ≤ 16 ms VM
  step; the coarse picture paints ≤ 2 s cold / ≤ 0.5 s warm after the click on the 1.23M graph (one number everywhere).

### 8.5 Expand / collapse / focus semantics at scale
- **Expand**: if the model holds the finer grain → pure VM refinement, no
  request; else ONE drill, the card shows a refining row, the capsule says
  "refining"; wires re-project to the newly visible cards the moment the
  slice lands. Recursive Node⊃Node⊃Node: unbounded depth via parent pointers;
  chevrons from graph-counted `childCount` at every level.
- **Collapse**: pure re-roll, no request, nothing removed from the model —
  re-expand is instant. Collapsing the traced entity itself never removes it.
- **Focus (re-anchor)**: a new session served from the per-focus walk cache;
  trail/history unchanged. Switching direction presets flips the VIEW only.
- **Exit**: drop the overlay; O(1).

### 8.6 Harness & certification additions (perf is a test, not a hope)
- Harness fixtures gain a **25k-node synthetic flow** (wide + deep, recursive
  containment): assert VM cold ≤ 200 ms, expand/collapse ≤ 16 ms, zero
  orphans, bundle counts equal the underlying edge counts (parity).
- Request-count assertions per journey (coarse=1, escalations≤3, bulk≤12,
  expand-in-model=0, expand-lazy=1).
- Live certification script `backend/scripts/certify_trace.py` (kept in the
  repo): coarse / fine / drill timings on `solidatus-test-large` and the
  Roots⊃Node estate; run before any scale-class merge.
- Long-task monitor in the harness during background fill (no task > 50 ms).

### 8.7 Acceptance additions
6. On `solidatus-test-large`: trace a layer → coarse picture ≤ 2 s cold; background
   fill proceeds with the board fully interactive; expanding any container
   refines its wires in ≤ 300 ms (lazy) or instantly (in-model); collapsing
   re-rolls instantly; the capsule's request count stays ≤ 16 for the whole
   session; memory stays under the ceiling with the capsule asking once past it.
7. Wire parity with the Lens **for raw-derived wires**: Σ wire counts per pair == raw edges in the scoped model, never exceeding it where raw and rollup coexist; rollup wires are labelled as such and never drawn where raw evidence for that pair is complete.


## 9. Integration contract (from the independent integration audit, 2026-08-20)

The audit enumerated every existing trace integration; the rebuild must keep
each one working. Evidence is in the audit report; the contract is below.

### 9.1 ONE depth/direction rule
- Wire max is 25 per direction (`TraceClosureRequest` `le=25`). The header
  `TraceDepthControl` presets (25/50/100, max 100) and the dock sliders (max
  50) are **capped at 25** for fetch; values above 25 are view-only and the
  control says so ("25 = everything the source can walk").
- **Fetch depth = monotone max requested in the session**; the model only
  grows. **View depth/direction = scope, instant, no refetch.** Raising view
  depth past the fetched depth triggers exactly one deeper fetch.
- Dock direction arrows today zero the other side's depth and call `retrace`
  → `continueWalk` (a budget grant per toggle — a storm vector). Under the
  overlay: depth 0 means **hidden**, never a fetch parameter; `retrace` is a
  **no-op for view-only changes**. The seam pin "depth-1 view is instant,
  without a refetch" stays.
- History entries gain `traceExpansion` (and focus) so back/forward/resume
  restore the **exact picture**, not just the view scope.

### 9.2 Dock adapter contract (`dockTrace`)
- `setConfig` depth/direction → VM only. `lineageEdgeTypes` / hierarchy
  `level` controls are **dead today in native mode**: either wire
  `lineageEdgeTypes` into the walk request (a refetch) or hide both controls
  in native mode — decision: **hide in v1, ticket the edge-type filter**.
- Counts/statistics: define and label as **scoped** (after direction/depth)
  — today they are model-wide while the view is scoped; the overview must
  not disagree with the board.
- Truncation notice + "Reduce depth & retrace": map to the ceiling state
  ("asks once"); the action reduces VIEW depth and never calls
  `continueWalk` below the ceiling. `TraceDockPerformance` is fed the
  capsule's request count and timings instead of "unavailable".
- Drilldown breadcrumb/tab: the lazy structural drill merges into the
  **trace model**, never into the legacy `drilldowns` map (or the breadcrumb
  returns). `beginTrace` side effects stay: flow master-switch on, drawer
  closed once, drawer re-openable.
- `TraceBottomDock` prop changes stay backward-compatible: `GraphCanvas` and
  `HierarchyCanvas` still host the dock over the legacy `useUnifiedTrace`.
- **ESC exits the trace.** Today `onExitTrace` is wired to the legacy
  `exitTrace` (returns false when the legacy hook is idle) — already broken;
  wire it to overlay exit and pin it.

### 9.3 Rendering adapter contract
- `FlatTreeItem` in trace mode uses `children.length` for its count/chevron
  (`FlatTreeItem.tsx:169,195`): a CLOSED VM card with no materialised
  children would render **no chevron and 0** — the R1 picture would silently
  fail. The adapter supplies graph-counted `childCount` and an
  "N on this lineage" count; the `isTracing ? children.length` branch goes.
- `LayerColumn` suppresses "N more" in trace (`LayerColumn.tsx:437`) while
  §8.4 requires row windowing: the overlay **re-enables windowing at 8** with
  the window bound by the VM (not by store children).
- Overlay wire shape: `source`/`target` are **node IDs** (via `urnToIdMap`),
  bundles carry `edgeCount` + `isBundled` (the overlay's existing fields, not
  `count`), and `coarse` renders with the existing dashed/animated language
  (`stroke-dasharray` at `LineageFlowOverlay.tsx:1523`). `nativeTraceResult`
  keeps ID-keyed `upstreamNodes`/`downstreamNodes` for cyan/amber/glow/dim.
- Reveal-on-canvas, header search and focus auto-scroll write
  `expandedNodes`/`loadChildren` today; in trace mode they **target
  `traceExpansion` and VM cards** (`traceFocusId` for auto-scroll), or
  "nothing happens" in trace.

### 9.4 The "outside this view" count
The existing chip is **per-selected-node and suppressed during trace** — it
cannot serve R3. The VM exposes `outsideView` (chains with no placeable node)
and the capsule/dock surface it; on a full-coverage view it must read 0 and a
non-zero value is a defect to investigate, never hidden.

### 9.5 Draft & versioned parity (acceptance)
`draft_overlay_provider.trace_closure` lacks the `seed_cursor` kwarg the
engine passes (TypeError on paging today); `versioned_branch_provider` has no
`trace_closure` (501). Both get the same coarse/fine/seed-cursor/grain
journeys as FalkorDB (the fixes exist on the backup branch — `41556de3`).

### 9.6 Tests: rewrite vs keep
- **Rewrite** (they pin the store-merge the overlay removes):
  `useCanvasTraceWalk.test.ts`, `traceWalkMerge.test.ts`
  (`computeTraceWalkDelta`, `traceExpansionUrns`), `canvasTraceWalkSeam`
  cases 1–3 and 6. Their **journeys** port to the new harness: budget →
  hands-free → exhausted; upstream-only hides hosts; depth-1 view instant;
  exit restores.
- **Keep**: `traceViewFilter.test.ts` (VM step 1 reuses it),
  `traceHistoryStack.test.ts` (extended for `traceExpansion`),
  `TraceHistoryPanel.test.tsx`, `traceMergeSpine.test.ts` (legacy hosts).


## 10. Architecture-review resolutions (independent greenfield review, 2026-08-20)

Verdict received: **overlay architecture right; three blocking defects in the
grain/fetch model** — each resolved inline above and summarised here so the
plan cannot lose them.

1. **Coarse fetch was anchored on the graph ROOT** (`trace_closure_coarse`
   climbs to the root and seeds root+children) → for a dashboard in Tableau it
   returns Tableau's lineage, undrawable at chrome grain. **Resolved**:
   focus-anchored hop-1 at the view's anchor grain (R2, §3.1); deeper hops
   fine-only.
2. **Chrome-grain rollups cannot be projected DOWN** (platform↔platform has
   no visible ancestor under a dataset-anchored view). **Resolved** by (1)
   and by the rule that rollup edges are never re-projected.
3. **Grain not first-class at the edge level** (one mixed `lineageEdges`
   list; hop BFS, parity and bundling over mixed grains). **Resolved**: typed
   edges, raw-only BFS, per-pair ledger with residual `W−R` (§3.2 step 5),
   `weight` shipped by the coarse walk.

Reuse rulings adopted: VM consumes `buildLensSubgraph` + `projectLensEdges`;
`focus-layout` NOT used (borrow `holdsThings`, count-honesty, `boundaryHops`);
`useEdgeProjection`'s bidirectional-collapse / reverse-flow / hover-delegation
passes extracted as pure functions shared with browse, projection bypassed;
`resolveRootLayer()` extracted from `useLayerAssignment`; `traceWalkMerge`,
`traceMergeSpine`, the `useCanvasTraceWalk` store merge and
`traceExpansionUrns` deleted; `useTraceFilteredHierarchy` bypassed until
`useUnifiedTrace` is retired. **New engine**: only the `TraceViewModel`
(placement, lanes, grain rule, ledger) — no new walk, projection or layout.

Driver adaptations (the coarse response's empty frontier currently reads as
`exhausted`, so "fine fill in background" has no path today): explicit
coarse→fine phase machine; coalesced merges; `AbortController` on exit and
re-focus; per-focal LRU(3); request-count capsule; note that
`excludeUrns.slice(0,2000)` re-ships hydration past 2k known nodes and the
cache key includes `excludeUrns` so continuations never hit redis — accepted
for v1, ticketed.

Store-write guards: every `LayerColumn`/canvas callback that can write the
store must be trace-gated and listed in the plan — double-click, search-
children, load-more, reorder, drag, edge connect (the auto-drill effects are
gated; the others are not today).

### 10.1 Harness gates (added)
- **Canary**: the harness module must report ≥ N tests run (`LineageLens.test.tsx`
  silently runs 0 today because `html-to-image` is not installed).
- **Store-write spy**: zero `useCanvasStore` writes during a trace; store
  snapshot byte-identical after exit.
- **Count parity per pair and per grain**: Σ wire counts == raw edges in the
  scoped model; never both raw and rollup for a complete pair.
- **Topology**: every wire's endpoints are visible cards, none
  ancestor↔descendant; every visible card's parent is visible or it is a lane
  root.
- **Placement parity** vs browse's `useLayerAssignment` on the same fixture.
- **DOM chevrons** for containers with graph-counted `childCount`.
- **Real-browser probe** (CDP recipe; `&perf=1` reducedMotion trap;
  `window.__renderCounts()`) on the CFO fixture for paint, long tasks and
  render fan-out — jsdom cannot paint wires, so VM-level assertions are
  necessary but not sufficient.

## 11. In-scope fixes (user ruling 2026-08-20: fix them in THIS build, not tickets)

Every defect the two reviews surfaced ships in this build with a pin.

| # | Defect (evidence) | Fix in this build | Pin |
|---|---|---|---|
| F1 | ESC never exits the native trace (`onExitTrace` → idle legacy `exitTrace`) | `onExitTrace` → overlay exit | harness: ESC ends trace, store snapshot identical |
| F2 | Dock direction arrows zero depth + `retrace`→`continueWalk` (storm vector) | adapter: depth 0 = hidden; `retrace` no-op for view changes | harness: 20 toggles → 0 requests |
| F3 | Header presets 50/100 + dock slider 50 exceed wire `le=25` | cap fetch at 25; >25 view-only, labelled | unit: request depth never > 25 |
| F4 | Dead dock controls (`lineageEdgeTypes`, level) in native mode | hidden in native mode (edge-type filter as a follow-up ticket is the ONLY deferral, explicitly) | dock test |
| F5 | `FlatTreeItem` trace count/chevron from `children.length` | graph-counted `childCount` + "N on this lineage" | harness DOM chevrons |
| F6 | `LayerColumn` suppresses "N more" in trace; no 8-row window | VM-bounded window at 8 with "N more" | harness: 1,000-child container mounts ≤ 8 rows |
| F7 | "outside this view" chip per-selection & suppressed | VM `outsideView` surfaced in capsule/dock | harness: == 0 on full-coverage fixture |
| F8 | History lacks `traceExpansion` | entry carries `traceExpansion` + focus | traceHistoryStack test: exact picture restore |
| F9 | Reveal / search / focus auto-scroll write `expandedNodes` in trace | route to `traceExpansion` + VM cards | harness |
| F10 | Drafts: `seed_cursor` TypeError; versioned: 501 | cherry-pick `41556de3`; add `grain` passthrough | backend suites + live |
| F11 | Coarse walk anchored at graph root; drops `weight` | focus-anchored hop-1 at view anchor; ships `weight` | live test on CFO-shaped estate |
| F12 | `_edges_between_sets_once` unlabeled `urn IN` scan | label-bucket it | live certification (raw fallback timed) |
| F13 | Coarse response reads `exhausted` → no fine fill | driver phase machine | hook tests |
| F14 | No abort on exit/re-focus; unbounded focal cache | `AbortController`; LRU(3) | hook tests |
| F15 | `excludeUrns.slice(0,2000)` re-ships hydration; cache key includes excludes | keep v1 (documented); measure re-ship bytes in certification | — |
| F16 | Harness/module canary (`LineageLens.test.tsx` runs 0 tests; `html-to-image` missing) | install the dep (`npm i html-to-image@1.11.13`) + canary assertion in every harness file | canary |
| F17 | Store-writing `LayerColumn` callbacks not trace-gated (dbl-click, search-children, load-more, reorder, drag, connect) | gate all, listed | store-write spy |
| F18 | `childCount` from the property (drift) | cherry-pick `0f6bac43` + `7c36a4d5` | backend tests |
| F19 | Containment pair-fetch 2 s timeout → empty | cherry-pick `0d7a9f02` | live |
| F20 | AGGREGATED-only sources blank | cherry-pick `583f858f` | wire test |

## 12. Non-regression guarantees for the canvas (binding)

- **G1 Layout untouched.** Browse layout, node positions, column order, and
  the store are byte-identical before and after a trace (store snapshot +
  `nodeLayerMap` parity pins). Trace mode reads the store; it never writes.
- **G2 Containment at any depth.** Harness fixtures at depth 1, 3 and 10
  (recursive Node⊃…⊃Node): every level keeps its chevron (graph-counted),
  expands lazily, collapses visually, and wires re-project at every level.
- **G3 Lazy load is correct and bounded.** Expanding a card never fetches
  more than that card's slice; expand-in-model = 0 requests; expand-lazy =
  exactly 1 drill; collapse = 0 requests; re-expand = 0 requests.
- **G4 End-to-end for the traced node.** For whatever node is traced, the
  scoped model holds its complete closure (to the ceiling), and every path
  the Lens would walk is represented by a wire at some visible grain — the
  parity gate (§8.7 #7) enforces it per pair.
- **G5 Performance budgets are tests** (§8.6) and scale-class changes are
  certified live on `solidatus-test-large` before merge.
