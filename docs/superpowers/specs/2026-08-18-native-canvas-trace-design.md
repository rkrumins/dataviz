# Native Canvas Trace — design

**Date:** 2026-08-18
**Status:** approved in conversation; spec pending user review
**Depends on:** the Lens full-walk feature (branch `feature/trace-full-walk`,
commits `141ddb90..a36653cb`) — the closure walk engine this design reuses.

## 1. Mental model (user-ratified)

- **Lens** = interactive investigation: open a focal, walk and expand hop by
  hop (or Full flow mode when asked). A modal, its own board.
- **Trace** = the ContextViewCanvas itself shows, *upfront*, everything
  relevant to the traced entity: the full end-to-end lineage at the grain
  that carries it, every flow participant's containment expanded, laid out
  in the view's **assigned layers**, everything else filtered away.

The two coexist. Every trace affordance (header Trace button, node context
menu, shift+double-click, entity drawer) starts the native canvas trace.
"Open lens" and the Lens's One hop / Full flow toggle stay exactly as
shipped on `feature/trace-full-walk`.

## 2. Requirements

1. **Complete**: the trace shows all lineage reachable from the traced
   entity, both directions, to the ends of the flow — not one ontology
   level, not rollups-with-drilldowns. Depth 25 per request, frontiers
   followed to exhaustion.
2. **Upfront**: no interaction required to see the flow. Hops render as
   they land; the finished picture is the whole scope.
3. **In the canvas's idiom**: assigned layers decide columns (existing
   assignment chain: explicit → instance → view config → rules →
   inheritance); containment nests; canvas virtualization applies.
4. **Honest**: budget pauses, stalled steps, and participants hidden by the
   curated-view assignment rule are all *said* in the trace bar, never
   silent.
5. **Performant and scalable** — hard gates, not adjectives (§7).
6. **Restorable**: exiting trace returns the canvas to the exact pre-trace
   browse state.

## 3. Architecture

Five pieces; four run on existing, proven code.

### 3.1 Data — the closure walk engine (reused verbatim)

A new slim controller `useCanvasTraceWalk(provider)` owns the trace session:

- `start(urn)` / `exit()` / `isTracing` / `tracedUrn`
- internally mounts the existing `useLensWalk(tracedUrn, provider, 25,
  /*fullWalk*/ true)` — deep initial closure, frontier-following driver,
  1,000-node budget with `continueFullWalk`, `exhausted`/`budgetHit`/
  `stalled` statuses. No changes to the hook; no backend work.
- The walk model caches per focal for the session — re-tracing the same
  entity after exit is instant.

The budget is a *safety valve*, not a scope cut: "Keep walking" grants
another round until the flow is genuinely exhausted.

### 3.2 Delta-merge into the canvas store (the new core)

On each walk-model growth, merge only the delta (nodes/edges not yet
merged this session) through the exact rules the legacy `onTraceComplete`
path encodes — each exists because of a shipped bug:

- `computeTraceMergeSpine` filters **alien ancestors** (participants whose
  containment chain never reaches a view-known anchor contribute no spine).
- Only **hydrated** nodes (real displayName) become cards — no phantom
  boxes.
- Lineage edges only between **resolvable endpoints** (newly merged or
  already on canvas).
- Containment edges **never re-parent an existing node** (the HARD RULE
  protecting layer assignment).
- Every added node id and edge id is recorded in the session for exit.

Store writes are batched: one `addNodes` + one `addEdges` call per model
growth, never per entity.

### 3.3 Show upfront — filter + expansion

- `useTraceFilteredHierarchy` (existing, currently dormant) receives
  `isTracing` and the walk model's URN set as `traceNodes`; `drilldowns`
  stays empty (the closure model needs none). The canvas renders only the
  flow and its host containers.
- **Every flow participant's containment chain auto-expands** — a
  deliberate departure from the legacy "focus chain only" restraint. Safe
  now because the walk budget bounds the scope and the filter removes all
  non-flow siblings before layout.
- Unassigned participants in a curated view fall out of `nodesByLayer` per
  the existing deliberate rule (no fallback-column stamping). The trace
  bar counts them: *"42 in flow · 3 not shown (no layer assignment)"*.

### 3.4 Chrome — the trace bar

A slim bar on the canvas (not the legacy dock, whose performance sidecar
reads a never-mounted endpoint):

- traced entity name + live counts (nodes / flows / hidden-unassigned)
- walking spinner → "full flow drawn"
- `budgetHit` → amber "flow continues past N nodes" + **Keep walking**
- `stalled` → amber "part of the flow could not be walked" + **Try again**
- **Exit trace**

Entry wiring: `openTraceLens(nodeId)` call sites become
`startCanvasTrace(nodeId)`; everything Lens-side stays as shipped.

### 3.5 Exit — full restore

Session snapshot taken at `start(urn)`: the expansion set (and selection).
`exit()`:

1. remove trace-added edges, then trace-added **nodes** (unlike legacy,
   which leaked merged nodes into browse forever),
2. restore the snapshotted expansion set (legacy collapsed everything),
3. reset circuit breakers (kept from legacy exit),
4. keep the walk model cache (session-scoped) for instant re-trace.

Result: browse state deep-equals pre-trace state.

## 4. Data flow

```
Trace click
  → useCanvasTraceWalk.start(urn)          [snapshot browse state]
  → useLensWalk fullWalk driver            [depth-25 closure + frontier waves]
  → per model growth:
      delta-merge (spine rules, batched)   [store: +nodes +edges, ids recorded]
      expansion set ∪= flow containment chains
  → useTraceFilteredHierarchy(traceNodes = model URNs)
  → layers via existing assignment chain → layout → render
Exit
  → purge recorded ids → restore snapshot → breakers reset
```

Browse-mode machinery already gates on `isTracing` (aggregated-edge effect,
auto-expand children effect) — those gates are reused as-is.

## 5. Error and edge cases

- **Versioned branches**: `/trace/closure` 501s until the parallel
  session's `VersionedBranchProvider.trace_closure` lands. The trace bar
  shows the walk error state with retry; no crash. (Known gap, owned
  elsewhere.)
- **Feature flag**: the same `require_trace` flag gates the button and the
  endpoint — coherent on/off.
- **Trace while mid-hydration**: the closure engine fetches server-side and
  does not depend on canvas hydration (the legacy toast guard is not
  needed); merging is store-additive and safe at any hydration phase.
- **Traced node not on canvas / not assigned**: the trace still runs; the
  focus merges like any participant. If the focus itself is unassigned in
  a curated view, the trace bar's hidden-count includes it and says so.
- **Re-trace of a different node while tracing**: exits the current session
  (full restore) then starts the new one.

## 6. Out of scope

- Deleting the legacy `/trace/v2` machinery (`useUnifiedTrace`, the dock,
  dead v2 router) — the parallel session's cleanup pass, sequenced after.
- `VersionedBranchProvider.trace_closure` (parallel session).
- Any backend change.
- Share links for canvas traces; matrix views for huge containers.

## 7. Performance and scale — hard gates

Principles: fetch is bounded by the walk budget; store churn is bounded by
delta-merging; render is bounded by the trace filter + existing canvas
virtualization; derived sets are memoized (context set, expansion delta).

Measured gates before completion:

1. **Merge cost**: delta-merge of a 1,000-node model completes in ≤ 50ms
   per growth wave (unit perf test, `perf.test.tsx` pattern).
2. **No re-churn**: merging the same model growth twice is a no-op — zero
   store writes (unit test on the session bookkeeping).
3. **Render fan-out**: with a 500+-node trace on the harness, one hover /
   selection re-renders O(affected) nodes, not the board — measured with
   the real-browser `__renderCounts` probe (the green-suite-blind defect
   class from 2026-08-18).
4. **Live scale**: on `nexus_lineage`, trace a hub entity — time from click
   to "full flow drawn" recorded; budget strip appears at the cap; canvas
   stays interactive (pan/zoom/scroll) while frontier waves land.
5. **Exit cost**: exit of a 1,000-node trace restores browse in ≤ 100ms.

## 8. Verification

- **Unit**: delta-merge adapter (spine rules, batching, idempotence,
  id bookkeeping); expansion-set derivation; trace bar states.
- **Seam** (the `lensSeam` pattern — real hook + real filter + real merge,
  stubbed provider): journey test *"a trace draws the whole flow upfront,
  filtered and expanded, with zero clicks; exit restores byte-identical
  browse state"*; budget journey *"cap → Keep walking → exhausted"*.
- **Existing suites stay green**; tsc error set identical to base; zero new
  lint problems.
- **Live acceptance** on `nexus_lineage`: dataset-level trace end-to-end at
  column grain; hub trace with budget; exit/re-trace; unassigned-count
  honesty in a curated view.
