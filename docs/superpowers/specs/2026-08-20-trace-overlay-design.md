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
- R2 **Fetch**: coarse roots+1 picture first (instant), then the hands-free engine fills the **complete** leaf-grain closure in the background; expansions answer from memory; a lazy drill covers grains the model lacks; the ~25k-node ceiling asks once.
- R3 **Placement**: traced entities sit in their **real layers** (stamped assignment → the view's type rules); a trace-only lane appears only for roots the view genuinely has no rule for. Nothing is ever orphaned.
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

Fetch sequence per trace: `grain:'coarse'` page (roots+1, ~0.3s) → render → fine closure in background (escalation/bulk) → model complete → expansions from memory. A container whose finer grain is not yet in the model drills lazily (`expandAggregated` structural) while the capsule shows "refining".

### 3.2 `TraceViewModel` (pure; `frontend/src/hooks/lib/traceViewModel.ts`)
Inputs: `LensWalkModel`, `focusUrn`, `layers: ViewLayerConfig[]`, `assignments/rules` (the same inputs `useLayerAssignment` consumes), `traceExpansion: Set<urn>`, `showUp/showDown`, `depthUp/depthDown`, `hiddenTypes`.

Steps (each a pure function with its own tests):
1. **Participants & hops** — BFS hop distances from the focus subtree over `lineageEdges` (reuse `traceViewFilter`), direction/depth scoping; containers inherit min descendant distance.
2. **Trees** — build containment trees from `model.containmentEdges` for every participant chain up to its top-most root (full chains always: C1 ⇒ no spine/anchor rules needed; nothing can orphan).
3. **Placement** — run the layer rules over the trees' ROOTS (stamped → rules); unplaceable roots → `__trace_flow__` lane (R3).
4. **Visibility** — a card is visible iff every ancestor is in `traceExpansion`; **initial expansion = focus chain only** (R1). Each visible card carries `grain = depth` and `childCount` (from the model/graph).
5. **Wire projection** — every lineage edge maps each endpoint to its **nearest visible ancestor**; same-(src,dst) projections bundle with `count`; an edge whose projected endpoints coincide is dropped (internal to a closed card — shown as the card's "N on this lineage" count); edges leaving the scoped set are counted, not drawn. Grain of a wire = max(grain of its two projected ends). Coarse-only wires (from the rollup lane) are marked `coarse` so the overlay can use the existing dashed language.
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
- Direction toggles & depths scope the VIEW instantly, no refetch.
- Never orphaned: every visible card has a visible parent or is a lane root.

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
5. `solidatus-test-large` container: coarse picture ≤2s, background fill hands-free, no "On this lineage" pile (only genuinely rule-less roots), no orphans.

## 6. Risks & mitigations
- Coarse (rollup) wires vs fine wires double-drawing → VM draws fine wires only where the model holds them, coarse elsewhere (per projected pair), never both.
- `LayerColumn` assumes store-backed HierarchyNodes → adapter builds identical shapes; harness asserts chevrons/counts.
- Memory ceiling on giant flows → capsule asks once; VM never holds more than the model.
- Service restarts mid-session → announced, never silent (C5).

## 7. Build order (after spec approval → writing-plans)
1. Harness + fixtures (RED on today's canvas).
2. `TraceViewModel` pure functions (TDD against fixtures).
3. Canvas trace-mode render swap + `traceExpansion` + exit.
4. Cherry-pick the data layer from the backup branch; wire coarse-first + background fill + lazy drill.
5. Live certification on the three estates; capsule narration.
