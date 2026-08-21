# Trace Overlay Rebuild — Stage 2 (Data Layer at Scale) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Stage 1 overlay complete at scale — every upstream and downstream hop loaded hands-free, containment always shipped, chevrons graph-counted — so a trace with 1,000+ participants on the 1.23M-node graph nests, expands and drills exactly like the CFO demo.

**Architecture:** Stage 1's overlay (`buildTraceView` + `useTraceOverlay` + the read-only canvas) is untouched in shape; this stage fixes what it is fed. The backend closure (`FalkorDBProvider.trace_closure`) ships graph-counted `childCount` and a containment chain that never comes back empty; `useLensWalk`'s full-walk driver runs to exhaustion without budget pedalling (auto-grants, escalation pages, bulk frontier drains); a loading capsule narrates the walk over the browse picture until the focus lands. Each task is salvaged from the proven backup branch `backup/native-canvas-trace-2026-08-20` and re-certified live.

**Tech Stack:** Python 3.12 FastAPI + FalkorDB (backend, bind-mounted with gunicorn `--reload` — no restarts needed), React 18/TS + vitest (frontend). Live graph: the largest data source on the dev stack (1.23M nodes; `solidatus-test-large`), plus `Nexus Lineage` for the small-graph regression.

**Spec:** `docs/superpowers/specs/2026-08-20-trace-overlay-design.md` §8 (budgets), §9 (integration), §11 F10–F20. **Stage 1 record:** `docs/superpowers/plans/2026-08-20-trace-overlay-stage1.md`; memory `trace-overlay-stage1-shipped-2026-08-21`.

## Global Constraints

- Stage 1 invariants hold: the canvas store (`nodes`/`edges`) is never written during a trace; draw sites key on `overlay.active`, write gates on `traceActive`; wires = `projectLensEdges` over the walk model (Lens parity tests stay green).
- **No user-facing budget pedalling**: the walk runs hands-free to the hard ceiling (`TRACE_MAX_NODES_HARD`); "Keep walking" exists only AT the ceiling (F19).
- **Containment never empty**: a closure with ≥1 participant and configured containment types ships the full ancestor chains or reports `truncationReason` naming the failure — never a silent `[]` (F18).
- `childCount` on every closure node is counted from the graph (`count(child)` over the configured containment types), never read from the property (F20).
- Backend work is live-verified against the large graph with timings in the report: coarse/fine closure latency, request count to a complete walk, containment edges vs participants.
- Cherry-picks: `git cherry-pick -x <sha>` where it applies cleanly; when it conflicts with Stage 1, salvage ONLY the named files/hunks and drop store-merge era code (`useCanvasTraceWalk` merge bits, `traceExpansionUrns`, `addedEdgeIds`, layer-lane retention in `useLayerAssignment`).
- Backend tests run per-file inside `synodic-dev-viz-service-1` (memory `dataviz-backend-test-harness`); frontend full suite green before each commit touching `useLensWalk.ts`/`ContextViewCanvas.tsx`; tsc 61; canvas eslint ≤ 65.
- No docker restarts (both tiers hot-reload); never commit `.env.dev`; explicit-path commits with inline `-m "$(printf …)"`; name any failing test.

---

## File map

| File | Responsibility |
|---|---|
| `backend/app/providers/falkordb_provider.py` (modify) | graph-counted childCount in `get_nodes_batch`/`get_node`; containment ALWAYS ships (chunked pair-fetch + chain synthesis); closure hydration |
| `backend/app/services/context_engine.py` (modify) | escalation lane (`TRACE_MAX_NODES_HARD`, page sizes) |
| `backend/app/providers/versioned_branch_provider.py`, `draft_overlay_provider.py` (modify) | versioned/draft closure (501 closed) |
| `frontend/src/hooks/useLensWalk.ts` (modify) | hands-free full walk: auto-grants to the ceiling, escalation pages, bulk frontier drains |
| `frontend/src/components/canvas/context-view/lens/closure-adapter.ts` (modify) | merge contract for bulk drains / escalation (`replaceFrontier`, `clearFrontierRoots`) |
| `frontend/src/components/canvas/context-view/TraceWalkIndicator.tsx` (create) | the capsule: narrates the walk over the browse picture until the focus lands; Cancel / Try again |
| `frontend/src/components/canvas/context-view/ContextViewCanvas.tsx` (modify) | mounts the capsule; no other trace changes |
| `scripts/trace_live_probe.py` (create) | live certification: closure timings + containment/childCount parity on a named source |

---

### Task 1: Backend — graph-counted childCount + containment always ships + versioned closure

**Files:** `backend/app/providers/falkordb_provider.py`, `backend/tests/test_falkordb_trace_structural.py`, `backend/app/providers/versioned_branch_provider.py`, `backend/app/providers/draft_overlay_provider.py`, `backend/tests/test_versioned_branch_trace_closure.py`; Create `scripts/trace_live_probe.py`.
**Interfaces:** Produces: every `GraphNode` returned by `get_nodes_batch`/`get_node`/`trace_closure` carries `childCount: int` counted over the configured containment types; `TraceClosureResult.containmentEdges` non-empty whenever participants have ancestors; `truncationReason ∈ {null,'max_nodes','timeout','ancestors_failed','nodes_failed'}` and `'ancestors_failed'` is reported ONLY on a real provider failure, never on the deadline guard.

- [ ] **Step 1: Cherry-pick in order** `git cherry-pick -x 7c36a4d5 0f6bac43 0d7a9f02 41556de3` (stop at the first conflict; resolve keeping the backup's intent; never drop a test).
- [ ] **Step 2: Read the result** — in `trace_closure` the containment step must no longer `if (deadline - now) < 2.0: ancestors_failed`; it must run the chunked pair-fetch with its own per-chunk timeout and synthesise chains; `get_nodes_batch` must `count(child)` per node (one query per batch, not per node).
- [ ] **Step 3: Backend tests** (inside the viz container, per file): `test_falkordb_trace_structural.py`, `test_trace_closure_wire_contract.py`, `test_versioned_branch_trace_closure.py`; plus any test the cherry-picks touched. Name pre-existing failures per the memory's known-fails list.
- [ ] **Step 4: Live probe script** `scripts/trace_live_probe.py`: logs in with `.env.dev` admin creds (never printed), resolves the named source's workspace/view, POSTs `/trace/closure` for a given urn with `direction=both`, depths 25, and prints: nodes, edges, containmentEdges, participants with ancestors vs containment coverage, `childCount>0` count among container-typed nodes, `truncationReason`, elapsed ms. Run it on `Nexus Lineage` (CFO dashboard) AND on the large source (a container with 1,000+ lineage) and paste both outputs in the report.
- [ ] **Step 5: Commit** the cherry-picks (they keep their own messages, `-x` appends origin) + `test(trace): live closure probe script`.

### Task 2: Lazy trace engine — coarse first paint, drill on expand, no caps (USER RULING 2026-08-21)

**Ruling that replaces the original Task 2:** "We cannot be applying limits for this and make it lazy loaded so we fetch the upstream/downstream entity and their containments. Can be expanded lazily or do it on the fly." Therefore: the first paint fetches ONLY the focus, its containment chain, and its direct upstream/downstream partners at the VIEW's anchor grain (with their containment); opening a card fetches THAT card's contributing children on the fly; nothing is fetched that nobody opened; no total node cap anywhere — every request is a cursor-paged page that the driver follows to exhaustion automatically. The hands-free full walk (`useLensWalk` fullWalk) stays available for the Lens and as an OPTIONAL background completion, never as the trace's first paint.

**Files:** `backend/app/providers/falkordb_provider.py` (salvage `trace_closure_coarse` from `9a284230`+`9474c113` — index-anchored, sub-second on 1.23M — and make it FOCUS-anchored per spec F11: the focus subtree is hop 0; partners = the nearest card at each partner's view-placeable grain, with rollup weights where AGGREGATED exists and a raw depth-1 closure where it does not, e.g. the Roots/Node pipeline); `backend/app/services/context_engine.py` + `backend/common/models/graph.py` (`grain: 'coarse'|'fine'`, and a `drill` request: `seed_urns=[card]`, one level of contributing children + their edges to KNOWN cards + containment, cursor-paged); `frontend/src/providers/GraphDataProvider.ts` + `RemoteGraphProvider.ts` (the two calls); create `frontend/src/hooks/useTraceDriver.ts` (phase machine `idle → coarse → ready`, `drill(cardUrn)` on expand with an in-flight set + LRU of completed drills, `AbortController` per trace, cursor following, `mergeClosures` into ONE walk model, `completePairs` = pairs whose BOTH cones have been drilled to leaf grain); `useCanvasTraceWalk.ts` switches from `useLensWalk(fullWalk)` to the driver (keep `start/exit/retry`, expose `walkEntry.model`, `status`, `phase`, `inFlight`); `useTraceOverlay.ts` calls `driver.drill(id)` from `toggle(id)` when the card is opened and its contents are not yet loaded (the card's `childCount>0` and no drill recorded); tests for each.
**Interfaces:** `provider.traceClosure({ grain:'coarse', urn, direction:'both', … })` → `TraceClosureResult` whose nodes include the focus subtree, its ancestors, hop-1 partner cards and THEIR ancestors, edges = rollups (kind 'rollup', weight) or raw hops, `frontierUp/Down` carry cursors for more partners; `provider.traceClosure({ seedUrns:[card], drill:true, … })` → children of `card` that carry lineage + their edges to cards already in the model (the client passes `knownUrns`? NO — the server returns edges whose other endpoint is the focus subtree or a hop-1 partner at any grain; the client's projection re-anchors) + containment; `useTraceDriver(tracedUrn, provider)` → `{ model, phase, status, error, inFlight: ReadonlySet<string>, drill(urn): Promise<void>, retry(), abort() }`.
**Semantics the VM already supports:** the coarse result draws at card grain (rollups where raw is absent — Stage 1's grain rule); a drill adds raw hops + finer cards; the ledger flips the pair to `complete` once both endpoints' cones are leaf-drilled; the dock counts read `Σ rollup weights` as "≥ N" until fully drilled (copy: "1,203+ upstream").

- [ ] **Step 1 (backend):** salvage + refocus the coarse walk; add the drill request; wire contract tests (`test_trace_closure_wire_contract.py`: coarse returns focus chain + partners + containment with ZERO raw hops beyond hop 1 on an AGGREGATED estate; raw depth-1 fallback on a rollup-less estate; drill returns only the card's contributing children; cursors page; no `max_nodes` truncation ever — only cursors). Run per file in the container; `docker kill --signal=HUP synodic-dev-viz-service-1` (the image has no `kill`) and re-probe over HTTP. Live numbers on the four probe targets: coarse first page ms, drill ms, pages to exhaustion.
- [ ] **Step 2 (frontend driver + hook):** TDD `useTraceDriver` with a fake provider: coarse → ready; drill merges and marks pairs complete; abort on exit cancels in-flight; a failed drill → `status:'error'` → `retry`; cursor pages followed automatically; the SAME model instance identity is preserved across unrelated renders. Then `useCanvasTraceWalk` swap, `useTraceOverlay.toggle` → `drill`, harness: the CFO estate through the driver (provider stub answers coarse + drill) — R1 picture first, expanding INTERMEDIATE_T2 issues ONE drill and refines the wires; store writes 0; `providerCalls()` exactly 1 + 1.
- [ ] **Step 3:** full suite, tsc 61, eslint; commits per step.

### Task 3: The capsule — the board narrates while a trace computes

**Files:** create `TraceWalkIndicator.tsx` (+ test) from `18b21dfd`/`946d016e`; `ContextViewCanvas.tsx` mount; `globals.css` keyframes.
**Interfaces:** Consumes `canvasTrace.walkEntry.status`, `fullWalkStatus.phase/grants/ceiling`, `overlay.active`, `overlay.view.counts`. Produces a fixed capsule over the canvas: phases "Finding the focus… / Mapping the flow (N nodes, M requests) / Drawing" while `!overlay.active || walking`; `Cancel` → `exitCanvasTrace`; `Try again` on error → `retryWalk`; `Keep walking` only at the ceiling; auto-dismisses 600 ms after `phase==='done'`. No store writes; no setState in effects (derive from props).

- [ ] Steps: salvage the component + test (adapt props: the old one read the store-merge counts — read `overlay.view.counts` and `fullWalkStatus` instead); mount in the canvas under the header; harness: capsule present during the walk window, gone after landing, `Cancel` exits with a clean store snapshot. Commit.

### Task 4: Live certification at scale (stage gate)

- [ ] Run `scripts/trace_live_probe.py` on the large source: containment coverage = 100% of participants-with-ancestors; `childCount>0` on every container that has children; total requests to a complete walk; time to first paint and to complete.
- [ ] Real-browser probe (reuse the Stage 1 CDP recipe): trace the 1,000+ container → chevrons on every container/dataset with lineage children; expand two levels down and one level up; wires refine at each level; ESC restores; 0 console errors; record timings.
- [ ] User sign-off → Stage 3 (coarse hop-1 first paint F11 if the fine walk's first paint exceeds the 2 s budget at scale; incremental VM; row windowing F6; 25k fixture).
