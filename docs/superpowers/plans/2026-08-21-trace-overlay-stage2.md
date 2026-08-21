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

### Task 2: Engine — hands-free full walk (auto-grants, escalation, bulk drains)

**Files:** `frontend/src/hooks/useLensWalk.ts`, `frontend/src/hooks/__tests__/useLensWalk.test.ts`, `frontend/src/components/canvas/context-view/lens/closure-adapter.ts` + test, `backend/app/services/context_engine.py` + `backend/tests/test_trace_closure_wire_contract.py` (the escalation-lane half of `bb6bd866`).
**Interfaces:** Consumes Task 1. Produces: `FullWalkStatus` gains `{ phase: 'seeding'|'walking'|'done'|'ceiling'|'error', grants, ceiling }`; `fullWalkFor(urn).budgetHit` is true ONLY at `TRACE_MAX_NODES_HARD`; `continueFullWalk` re-arms only at the ceiling or after an error; `mergeClosures(model, res, { replaceFrontier, clearFrontierRoots })` per the backup contract.

- [ ] **Step 1:** `git cherry-pick -x bb6bd866` (escalation: backend + `closure-adapter` + `useLensWalk`); resolve conflicts keeping Stage 1's `kind`/`weight` grain fields.
- [ ] **Step 2:** Salvage from `bcac85a7` ONLY `useLensWalk.ts` + its test hunks (`FULL_WALK_AUTO_GRANTS`, hands-free grants to the ceiling); DROP the `useCanvasTraceWalk.ts` and `useLayerAssignment*` hunks (store-merge era). Same for `10c05fd2`: take `useLensWalk.ts`/`closure-adapter.ts` + tests (bulk frontier draining, 200 seeds per request); DROP the `ContextViewCanvas.tsx` hunk (visual-only collapse is already how the overlay works).
- [ ] **Step 3: Tests** — `useLensWalk.test.ts`: a 3,000-participant fake walks to completion with zero `continueFullWalk` calls and ≤ 24 requests; stops at the ceiling with `phase:'ceiling'`; a failed frontier op → `phase:'error'` → `retry` resumes. Harness: `traceCanvas.harness.test.tsx` journey "budget → hands-free → exhausted" updated to the new statuses (no Keep-walking inside the ceiling); dock: truncation notice shows "Keep walking" only when `phase === 'ceiling'`.
- [ ] **Step 4:** Full suite, tsc 61, eslint; commit per salvaged commit (keep the originals' subjects with `(salvaged)`).

### Task 3: The capsule — the board narrates while a trace computes

**Files:** create `TraceWalkIndicator.tsx` (+ test) from `18b21dfd`/`946d016e`; `ContextViewCanvas.tsx` mount; `globals.css` keyframes.
**Interfaces:** Consumes `canvasTrace.walkEntry.status`, `fullWalkStatus.phase/grants/ceiling`, `overlay.active`, `overlay.view.counts`. Produces a fixed capsule over the canvas: phases "Finding the focus… / Mapping the flow (N nodes, M requests) / Drawing" while `!overlay.active || walking`; `Cancel` → `exitCanvasTrace`; `Try again` on error → `retryWalk`; `Keep walking` only at the ceiling; auto-dismisses 600 ms after `phase==='done'`. No store writes; no setState in effects (derive from props).

- [ ] Steps: salvage the component + test (adapt props: the old one read the store-merge counts — read `overlay.view.counts` and `fullWalkStatus` instead); mount in the canvas under the header; harness: capsule present during the walk window, gone after landing, `Cancel` exits with a clean store snapshot. Commit.

### Task 4: Live certification at scale (stage gate)

- [ ] Run `scripts/trace_live_probe.py` on the large source: containment coverage = 100% of participants-with-ancestors; `childCount>0` on every container that has children; total requests to a complete walk; time to first paint and to complete.
- [ ] Real-browser probe (reuse the Stage 1 CDP recipe): trace the 1,000+ container → chevrons on every container/dataset with lineage children; expand two levels down and one level up; wires refine at each level; ESC restores; 0 console errors; record timings.
- [ ] User sign-off → Stage 3 (coarse hop-1 first paint F11 if the fine walk's first paint exceeds the 2 s budget at scale; incremental VM; row windowing F6; 25k fixture).
