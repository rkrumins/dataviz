# Read-Path Performance Redesign (WS0–WS5)

How the graph read paths — canvas open/expand, aggregated edges, `/edges/between`,
top-level nodes, and trace — were re-engineered to hold sub-second server times and
never-504 semantics on multi-million-element graphs, over real network round-trips.

> **Status:** WS0–WS5 shipped on `feature/major-data-reload-refactor`. WS7 (saturation
> control, cache TTLs, transport) shipped. WS6 landed its resilience half; the canvas
> frontend adoption of the batched contract is deferred (see [Current status](#current-status--whats-deferred)).

---

## 1. Why this work exists

Reads that felt fine on a laptop were unusable in real deployments.

On the primary test graph — `perf-load-test-layered-lineage`, **2,083,217 nodes /
5,605,218 edges (7.7M elements)** — a single canvas settle produced, in plain Docker
Compose:

| Endpoint | Observed | |
|---|---|---|
| `/edges/aggregated` | 9.87s → 13.77s → 21.76s → **25.85s** | climbing under queue buildup |
| `/children-with-edges` | 4.7–11.2s | |
| `/edges/between` | 5.00s | |
| `/assignments/compute` | 4.81s | its own queries were LIMIT-100 trivial |
| `/trace/v2` | 5.18s (196 kB) | |

Two amplifiers compounded each other:

1. **A request storm.** One canvas gesture fanned out into a top-level read, then
   7+ `/edges/aggregated` calls (the whole visible set as both source *and* target),
   plus `/edges/between`, `/assignments/compute`, and a `/children-with-edges` per
   expand — all queued on the browser's 6 HTTP/1.1 connections. Eager browsing of a
   few 600-child containers produced **546 requests in 2.2 minutes**.
2. **Per-request backend cost that multiplies by RTT.** Production FalkorDB is
   external/managed; the service reaches it over a real hop, and the browser reaches
   the service over another. Every *sequential* round-trip pays full RTT twice. Trace
   alone was ≈40–80 round-trips, ~40–50 of them strictly sequential.

Under load the two combined into a **saturation cascade**: FalkorDB runs on
`THREAD_COUNT=4` workers; a handful of 10–26s queries occupied every worker, so
queued queries blew the 5s provider read budget and returned **503 at exactly 5.03s**
(`ProviderUnavailable`), which then tripped the shared frontend circuit breaker.

Decisively, the 10–26s reads happened on a **healthy** graph (`_AggMeta`
boundary / `stampVersion=2`, 595k cells, materialized that day) — proving the cost was
structural in the read path, not a stale-data artifact.

### Acceptance bars (server-side)

- Browse reads (open / expand / aggregated / top-nodes): **p95 < 300 ms warm, < 2 s cold** on 3M elements.
- `/trace/v2`: **< 3 s worst case**, truncated-200 semantics, **never 504**.
- Canvas usable **< 2 s** on slow networks.
- Headroom to 5–10M elements.

### The root-cause families

Everything below traces to one of these:

- **Per-request fixed tax** — work done *before* the first real query, once per request.
- **Full scans** — unlabeled `urn IN $list` anchors and untyped `[r]` patterns that
  the planner runs as All-Node-Scan / all-edge visits (FalkorDB labels are
  case-sensitive and this build has **no label-less URN index**).
- **Read-path synthesis** — containment-walking Cypher (`*0..16`) executed on every
  aggregated read to reconstruct roll-ups.
- **Round-trip amplification** — trace issuing dozens of sequential queries.
- **Saturation** — heavy queries starving FalkorDB's worker threads, surfacing as 503s.

---

## 2. WS0 — Slow-query telemetry & the index-support spike

**Commit:** `a5753de8`

**What it was.** A single `_guarded_timed` wrapper around every Cypher entry point
(`_ro_query` / `_proj_ro_query` / `_query`). It emits one WARNING when either DB
execution **or** semaphore-queue wait exceeds `FALKORDB_SLOW_QUERY_MS` (default 500 ms),
logging graph, op, `query_ms`, `queue_ms`, budget, rows, error class, and the first
80 chars of the query. `op=` labels are threaded from the ~10 hottest callers.

**Why.** You cannot fix what you cannot see. Critically, **`queue_ms` is measured
separately from `query_ms`** — queue time is the *saturation* signal (work waiting for
a worker slot), which the 5.03s 503 cascade had made completely invisible. Without
separating the two, a slow read and an overloaded DB look identical.

**How.** Monotonic timing around each query, threaded `op=` labels, WARNING-level
structured log so a line attributes to a read path without parsing Cypher.

**What it solves.** Turns every subsequent optimization into a measured before/after,
and makes saturation diagnosable. It also settled the key design gate (D1): on this
FalkorDB build (v4.16.0 / redis 8.2.2), a composite edge index on
`(r.sourceDepth, r.targetDepth)` **is** supported and used by EXPLAIN, but an unlabeled
`CREATE INDEX FOR (n) ON (n.urn)` is a **syntax error** — confirming the label-bucket
route (WS2) as the *only* seek path.

---

## 3. WS1 — Kill the per-request ontology-resolution tax

**Commit:** `b3a25524` · New file: `backend/app/services/resolved_ontology_cache.py`

**What it was.** A process-wide `(ResolvedOntology, SourceAlignment)` cache keyed by
`(workspace, data_source)`, invalidated by a Redis generation counter
(`ontgen:{ws}:{ds}`) with a 300s TTL backstop.

**Why.** `ContextEngine` is built fresh per request and eagerly re-resolved the
ontology *before its first real query*. Each read paid: provider introspection (worst
case a full-graph edge scan), `OntologyService.resolve` against Postgres, ~40
idempotent `CREATE INDEX` round-trips (`ensure_indices`), and `_apply_source_alignment`
— which even **wrote a drift row to Postgres on every read**. The old instance-level
300s cache died with the engine, so none of it amortized. This was the bulk of
`/assignments/compute`'s 4.8s and a fixed adder (×RTT) on every browse/trace.

**How.** On a cache hit, only the cheap in-memory provider injections run (containment/
lineage types, rules, entity levels, and the source-type aliases from the cached
alignment) — preserving both the *eager-configuration* contract (endpoints call
`engine.provider.*` directly and must never see `ProviderConfigurationError`) and the
*aliases-always-reset* contract. Introspection, the Postgres resolve, the DDL storm,
and the alignment write are skipped. Entries are stored under the generation observed
**before** resolving, so a racing bump is never served across. Redis-down degrades
cleanly to the old per-request behavior. Introspection now prefers
`CALL db.relationshipTypes()` (O(#types)) over the `MATCH ()-[r]->()` DISTINCT scan
(O(#edges), ~1s/million).

**Generation bumps** fire on ontology mutations, data-source ontology/projection
updates, and vocab-alignment confirmations.

**What it solves.** The fixed tax becomes **once per generation, per pod** — a single
Redis GET on the hot path. Every networked read drops ~40 serialized round-trips.

**Rider (latent correctness bug).** `compute_assignments` read `NodeQuery()`/
`EdgeQuery()` *defaults* — layer assignments were computed on an arbitrary **100**
nodes/edges of a multi-million-node graph. Now `request.urns` (the canvas's loaded set)
scopes the read exactly; absent that, a bounded read capped by `ASSIGNMENT_MAX_ELEMENTS`
(50k) with an explicit `truncated` flag. Never silently 100. (Also see `029d434d`,
which hardened this to never scan the whole graph.)

---

## 4. WS2 — Index-seekable, type-pruned reads

**Commits:** `eec317a4` (aggregated anchors) · `5d358640` (every other hot path) ·
`c8ff9391` (cache bootstrap) · `9a9e0e6f` (`/nodes/query`)

**What it was.** A `_label_buckets` helper that groups requested URNs by their node
label — via the warmed `{graph}:urn_labels` Redis cache, with one bulk Cypher for
misses — so every `urn IN $list` anchor becomes a set of **per-label URN-index seeks**
instead of one unlabeled full scan. Plus turning `type(r) IN $types` post-filters into
**pattern alternations** (`[r:HAS|CONTAINS]`) so hub traversals never visit other edge
classes.

**Why.** This build has no label-less URN index, so every unlabeled anchor was a full
node/relation scan with per-row `IN`-list membership. Live: a labeled seek is **0.16 ms**
vs an unlabeled scan **112 ms** (519k rows) — up to **700×**. On the 7.7M graph the
containment-profile query alone cost **4.5s per side**; the stored aggregated read
scanned all 595k `:AGGREGATED` relations against a 613-element list until it timed out;
`type(r) IN` post-filters visited every edge of hub nodes.

**How.** The label-bucket mechanism (`eec317a4`) was extended (`5d358640`) to every
remaining hot path:

- **children-with-edges** — label-seeked parent anchor; one typed Q1 replaces the
  single/multi branches (`[r:HAS|…]` + typed grandchild count); page-lineage typed and
  bucketed. A defensive Python re-sort protects the keyset cursor (FalkorDB may discard
  `ORDER BY` around an aggregating `RETURN` — see [gotchas](#appendix-falkordb-gotchas-encoded-here)).
- **get_edges / `/edges/between`** — one seeked sub-query per label bucket, gathered,
  typed via alias-mapped alternations.
- **get_nodes_batch / get_parent / `/nodes/query`** — label-seeked / bucketed.
- **top-level** — `ORDER BY` / keyset cursor on **bare** `n.displayName` (the old
  `toString()` wrapper defeated the displayName index); the engine now defaults the
  entity-type filter to the ontology vocabulary so the label-union page/count form
  always applies.
- **trace anchor helpers** — label-seeked focus anchors + typed containment
  alternations replacing `ALL(rel IN … WHERE type(rel) IN …)` post-filters.
- **depth indexes** — `ensure_indices` and the materializer now create the
  `:AGGREGATED (sourceDepth, targetDepth)` composite (+ singles), so the depth-keyed
  readers (WS3 Q3, trace drill) are index seeks.

URNs whose label can't be resolved fall into a bounded `""` residue bucket that keeps
the unlabeled pattern — correctness preserved, and the unit fakes exercise exactly that
path.

**What it solves.** Live EXPLAIN on the 7.7M graph: every rewritten shape now seeds
from **Node By Index Scan** (the unlabeled forms were All-Node-Scans measured at 310 ms
per lookup over 2M nodes). This is the single largest per-query win. `test_cypher_shapes.py`
pins the shapes so a regression to an unlabeled anchor fails CI.

---

## 5. WS3 — Aggregated reads that never walk containment

**Commit:** `6ffa3839` (reader) · trigger model later superseded by `110cd431` (see below)

**What it was.** The aggregated-edge reader (`get_aggregated_edges_between`) rebuilt so
it completes materialized cells **with zero containment walks in Cypher**, plus honest
freshness signals on the response.

**Why.** The 10–26s reads were on a *healthy* graph. Boundary-regime reads ran
`_profile` (per-node inbound `*1..16` path enumeration — 4.5s/side) plus `*0..16`
upward-resolution walks for leaf and mixed pairs on **every request**. Graphs with no
`_AggMeta` additionally paid a `LIMIT 1` conformance probe that scanned up to every
`:AGGREGATED` relation (2.0s over 1M cells) once per read. The walks — not the data —
were the cost.

**How.** Three walk-free substitutions:

- **leaf detection** = a single-hop child-count probe (no walk);
- **containment depth** = the node's own stamped incident cells
  (`_frontier_depths_from_stamps`, depth-index-backed since WS2);
- **upward resolution** (leaf far-endpoints, mixed pairs) = the Redis **ancestor-chain
  cache**, resolved in Python.

Regime dispatch happens without read-path probes: `_AggMeta` wins; a legacy Redis
marker is the only fallback; no marker → regime `unknown` → an exact typed raw mirror
served `stale:"unmaterialized"`. `boundary` + `stampVersion<2` → raw mirror served
`stale:"legacy_cells"`. The conformance probe survives **only** for write-hook regime
dispatch (a wrong guess there double-counts), cached 5 min.

Freshness is additive on `AggregatedEdgeResult`: `stale`, `staleReason`, `stampVersion`,
`regime` — old clients ignore them; the canvas surfaces them.

**Migration.** `backend/scripts/rematerialize_all_graphs.py` re-materializes every graph
with cells through the control plane (real, UI-visible, watchdogged jobs), idempotent
(skips `stampVersion>=2`), verifying `_AggMeta` + zero depth-null cells after each run.
Until re-materialized, a legacy graph serves **stale-but-honest**, never wrong.

**What it solves.** The structural 10–26s cost is gone for healthy *and* legacy graphs —
the reader is now cell-lookup + Python chain resolution, both index/cache-backed.

### The trigger-model evolution (important)

WS3 originally shipped a **widened read-path self-heal trigger**: any browse whose
result looked stale enqueued a re-materialization. In practice this became a storm — it
fired on `chain_cache_miss` (a *read-cache* condition nothing on the browse path
warmed), so browsing a healthy graph queued a multi-minute worker job every 5–15 min
that verified "no changes" and fired again (**10 `auto` jobs in 3 hours** in the job
table).

**`110cd431` removed the read-path trigger entirely.** Aggregation is now **event-driven
+ manual only**:

| Trigger source | Fires on |
|---|---|
| `onboarding` | data-source / model creation |
| `api` | merge / publish / import / revert projection (`projection_target` `on_rollups_stale`) |
| `purge` | after a purge |
| `manual` | control plane / aggregation API |

Read correctness is preserved without a trigger by making the ancestor-chain resolution
**read-through**: a cold cache computes the chain (bounded to the visible far endpoints)
and caches it, instead of dropping the pair and self-triggering (`110cd431`).

---

## 6. WS4 — Trace: bounded round-trip waves, engine headroom, never-504

**Commit:** `77e57ea7`

**What it was.** Trace restructured from ~40–80 sequential FalkorDB round-trips into a
handful of gathered waves, with a hard guarantee it truncates before the middleware
504s.

**Why.** The engine deadline **equalled** the middleware tier (60s == 60s), so the
truncated-200 raced the 504 and usually lost. And every sequential round-trip pays full
RTT against a remote DB.

**How.**

- **Anchor phase**: 5–7 sequential queries → **2 gathered waves** (root-anchor walk
  concurrent with the focus fetch; has-lineage probe gathered with the anchor fetch).
- **Ancestor-chain hydration**: the per-chunk *2-queries-per-ontology-label* sequential
  ladder → **one chain query per `urn→label` bucket, gathered** (same longest-path
  semantics; residue bucket keeps the unlabeled fallback).
- **`_frontier_depths_from_stamps`**: both directions × all buckets gathered.
- **Chain map computed once** in `trace_at_level` and **passed through** to
  `_fetch_containment_edges` (which used to re-fetch) — one Redis wave saved.
- **Hydration deadline guard**: <2s budget left → skip hydration, return the lineage
  skeleton as truncated-200 (`truncationReason=ancestors_failed`, already FE-handled).
- **Retry-at-focus bounded**: only when ≥40% budget remains **and** depth ≤ 5.
- **`TRACE_ENGINE_HEADROOM_SECS`** (default 10): engine budget = middleware tier −
  headroom (floor 5s), so the engine **always** truncates first.
- **`TraceRequest` depth** default 99 → 25, `le=100` (the BFS runs a query-wave per
  hop; 99 was pure risk).
- **`/trace/expand-batch`** routed through GraphCache + the shed lane (it previously
  bypassed the cache, re-running the whole fan-out on every re-expand).

**What it solves.** Trace round-trips collapse to a few waves; the never-504 invariant
holds (engine < middleware, guaranteed by construction and pinned in
`test_trace_waves.py`).

---

## 7. WS5 — Batched canvas contract (backend)

**Commit:** `809e79c3` · New: `backend/app/api/v1/endpoints/canvas.py`, `backend/app/models/canvas.py`

**What it was.** Two endpoints that collapse a canvas gesture into **one request each**:
`POST …/graph/canvas/bootstrap` (open) and `POST …/graph/canvas/expand`.

**Why.** To kill the open-time request storm — top-level, then 7+ per-visible-set
`/edges/aggregated` + `/edges/between` + `/assignments/compute` + per-expand children —
that queued on the browser's 6 connections and summed to the 15s+ networked load.

**How.**

- **bootstrap**: roots page (materialized-serve fast path when eligible, else the WS2
  live label-union read) then edges-among-roots + aggregated-among-roots **gathered** —
  one GraphCache entry, one payload, carrying WS3's freshness/regime block and the
  provider-health verdict.
- **expand**: children page + the aggregated **delta** — only the edges the new children
  introduce, both directions, against the rest of the visible set, with the
  just-expanded parent **excluded** from the aggregation set (invariant: its children
  represent it now; including it double-counts the containment roll-up).

It **composes existing engine methods** (no duplicated query logic) and reuses the same
scope / health / shed / branch-aware helpers, so LKG stale-fallback, gen-bump
invalidation, the `_bounded_compute` 429-shed lane, and draft-overlay construction all
apply unchanged. The per-purpose endpoints stay for drawers / admin / search. New
GraphCache endpoints `canvas-bootstrap` / `canvas-expand` (TTL 300s, gen-bumped).

**What it solves.** The backend contract for a one-request-per-gesture canvas exists and
is cache-routed and shed-protected. *(Frontend adoption is the deferred WS6 remainder.)*

---

## 8. Cross-cutting: cache isolation & correctness

**Commit:** `cb02c970`

**What it was.** Namespacing every provider-level Redis cache by **physical graph
identity** (`host:port:graph_name`), not `graph_name` alone.

**Why (directly the cross-tenant concern).** `GraphCache` and the resolved-ontology
cache were correctly scoped (`ws:ds:branch:gen`), but the **provider** caches
(`urn_labels`, ancestor chains, ontology/stats/regime markers, agg-membership) were
keyed by `graph_name` — which **defaults to the literal `nexus_lineage`** when unset,
while DB uniqueness is `(workspace, provider, graph_name)`. So the same `graph_name`
can name *different physical graphs* on different instances. On a shared
`CACHE_REDIS_URL` (the recommended prod setup) this leaked labels and ancestor trees
across tenants — and WS2's seeks would then **drop** nodes (wrong label) while WS3's
roll-ups would resolve against **another tenant's** containment. WS2/WS3 lean harder on
these caches, giving a pre-existing collision correctness teeth.

**How.** A `_cache_ns = host:port:graph_name` prefix on every provider cache key. Graph
*selection* still uses the bare `graph_name` (the namespace is a cache prefix only).
Also fixed under the same audit: a never-assigned `self.provider_id` (AttributeError
risk), TTL-less unbounded `urn_labels`/`ancestors` hashes (now a 7-day refresh so a
fleet of warmed 2M-node graphs can't wedge Redis at `maxmemory`), and the frontend
`useAggregatedLineage` module cache folding in `provider.scopeKey` (`ws:ds:branch`).

**What it solves.** Distinct instances stay distinct; the same physical graph
legitimately shares. Removes a silent cross-tenant correctness hazard that the WS2/WS3
caches would otherwise have amplified.

---

## 9. Current status & what's deferred

| Workstream | State |
|---|---|
| WS0 telemetry | ✅ shipped (`a5753de8`) |
| WS1 per-request tax | ✅ shipped (`b3a25524`, `029d434d`) |
| WS2 index-seek reads | ✅ shipped (`eec317a4`, `5d358640`, `c8ff9391`, `9a9e0e6f`) |
| WS3 no-walk aggregated | ✅ shipped (`6ffa3839`); trigger model updated (`110cd431`) |
| WS4 trace waves | ✅ shipped (`77e57ea7`) |
| WS5 canvas backend | ✅ shipped (`809e79c3`) |
| WS7 saturation / TTLs / transport | ✅ shipped (incl. cache isolation `cb02c970`) |
| **WS6 frontend** | ◐ **partial** |

**WS6 landed (`cf124542`):** per-endpoint-class circuit breaker keying
(`${ws}:${ds}:${endpointClass}`), bounded per-edge trace fallback, and the resolve-404
storm fix.

**WS6 remainder (deferred, high-risk):** the canvas frontend still uses the old
per-visible-set aggregated fan-out — it has **not** adopted the WS5 batched endpoints.
Remaining:

1. `RemoteGraphProvider.ts` — add `canvasBootstrap()` / `canvasExpand()` clients; thread
   `AbortSignal` so collapse/supersede cancels in-flight network.
2. `ContextViewCanvas.tsx` — initial load → `canvasBootstrap`; expand → `canvasExpand` +
   delta-merge; **delete** the aggregated re-fire effect (`prevAggregationKeyRef`) that
   fires N sequential `/aggregated` calls per visible-set change; collapse drops cells
   locally.
3. `useGraphHydration.ts` — expansion loader → `canvasExpand` + prefetch-ahead.

It is high-risk because `ContextViewCanvas` is a large, central component and rewiring
its data flow touches trace-gating, collapse/expand, delta-merge, and the hydration
status machine (which must never render a failed load as an empty canvas).

---

## 10. How to verify

- **Plan shapes** — `GRAPH.EXPLAIN` on the rewritten reads: no `All Node Scan`; depth
  filters index-seeked.
- **Timings** — `curl -w '%{time_total}'` p50/p95 (cold after a gen-bump, warm) for
  canvas-open, expand, `/edges/aggregated`, `/edges/between`, `/trace/v2`,
  `/trace/expand-batch`, `/assignments/compute`. Attribute with the WS0 slow-query lines.
- **Never-504** — trace at depth 25, 20 concurrent on 3M: zero 504/500; truncated-200s
  only.
- **Saturation** — replay eager browsing: shed requests return 429 + Retry-After (not
  503), no stuck spinners, no breaker blackout.
- **Suites** — per-file pytest in `synodic-dev-viz-service-1` (the read-path suites +
  the hooks/projector parity set); `test_cypher_shapes.py`, `test_trace_waves.py`,
  `test_canvas_endpoints.py`, `test_resolved_ontology_cache.py`,
  `test_provider_cache_namespacing.py`, `test_falkordb_slow_query_log.py`.

---

## Appendix: FalkorDB gotchas encoded here

- **No label-less URN index** on this build; labels are **case-sensitive**. Every hot
  anchor must be label-qualified (WS2) — an unlabeled `urn IN $list` is a full scan.
- **`ORDER BY` is silently discarded around an aggregating `RETURN`** — the top-level
  and children readers re-sort defensively in Python before deriving a keyset cursor,
  or pagination skips rows.
- **`THREAD_COUNT=4`** — a few heavy queries starve every worker; saturation must be
  shed as 429 *before* the DB (WS7), never surfaced as `ProviderUnavailable`/503.
- **Composite edge index** on `(r.sourceDepth, r.targetDepth)` **is** supported and used
  (WS0 spike); an unlabeled node-URN `CREATE INDEX` is a syntax error.
- **`graph_name` defaults to `nexus_lineage`** and is unique only per
  `(workspace, provider)` — provider caches must be namespaced by physical instance
  (`cb02c970`).
