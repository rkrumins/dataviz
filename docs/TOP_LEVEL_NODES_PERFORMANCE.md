# Top-Level Nodes: Performance Architecture & Timeout Ladder

How `/graph/nodes/top-level` serves 2-3M+ node graphs without timing out,
what each cache layer does, and which knobs tune it. Written alongside the
fix for the recurring "~17s failure claiming a 30s timeout" incident; the
root-cause chain is documented at the end because every knob below exists
to prevent one of its links.

## The endpoint

"Top-level" is defined **structurally**: a node with no incoming containment
edge (containment types come from the ontology bound to the data source).
Computing it live requires touching every node's incoming adjacency — O(N)
per query, seconds-to-minutes on multi-million-node graphs. The architecture
therefore moves that work off the request path; a user request should only
ever pay O(page).

## Serving layers (fastest first)

1. **Redis GraphCache** (`graph_cache.py`, `ENDPOINT_TOP_LEVEL`, TTL 600s,
   generation-keyed). Populated by real requests and by the cache warmer
   after every stats poll. Singleflight + last-known-good stale fallback.
2. **Postgres-materialized payload** (`top_level_cache.py`). The insights
   service materializes a displayName-sorted window of top-level nodes
   (default 1000, `TOP_LEVEL_MATERIALIZE_LIMIT`) into
   `DataSourceStatsORM.top_level_nodes` for graphs at/above
   `STATS_POLL_LARGE_THRESHOLD` (100k nodes). Both collection lanes build
   it: the frequent counts lane AND the deep profile lane — a freshly
   profiled data source is servable immediately.
   - When the payload is **complete** (`truncated: false`, i.e. the graph's
     entire top-level set fits in the window — the common shape, since
     top-level means domains/platforms), it also serves **filtered**
     requests (`searchQuery`/`entityTypes`) by filtering in-process.
     Search-as-you-type never touches FalkorDB on such graphs.
   - Truncated payloads (top-level set larger than the window) serve only
     unfiltered pages inside the window; everything else falls back live.
3. **Redis count side-cache** (`get_top_level_count`/`set_top_level_count`).
   The total count is cached separately, keyed by filters only (no
   cursor/limit), so paging through N pages pays for at most ONE live
   count scan. Seeded by materialization; invalidated by the same
   generation bump as the response cache.
4. **Live FalkorDB** (`get_top_level_or_orphan_nodes`) — the fallback for
   branch reads, truncated-payload filters, and cold starts. Two queries:
   - **Page query**: keyset-paginated, budget
     `FALKORDB_TOP_LEVEL_QUERY_TIMEOUT` (default 30s). A timeout here is
     fatal for the request (GraphCache's stale fallback catches it) and the
     error names the budget that fired.
   - **Count query**: full-scan, **best-effort**, budget
     `FALKORDB_TOP_LEVEL_COUNT_TIMEOUT` (default 5s). A timeout degrades to
     `totalCount: null` — the page still returns; pagination is driven by
     `hasMore` (page-size derived), never by the count.

## The timeout ladder

Every layer's budget must exceed the layer below it, so the innermost
accurate error always wins the race:

| Layer | Knob | Default |
|---|---|---|
| nginx proxy read | `proxy_read_timeout` | 180s |
| gunicorn worker | `GUNICORN_TIMEOUT` | 120s |
| ASGI graph tier | `HTTP_TIMEOUT_GRAPH_SECS` | 60s |
| Frontend abort | `VITE_TIMEOUT_TOP_LEVEL_MS` | 45s |
| FalkorDB page query | `FALKORDB_TOP_LEVEL_QUERY_TIMEOUT` | 30s |
| FalkorDB count query | `FALKORDB_TOP_LEVEL_COUNT_TIMEOUT` | 5s (best-effort) |

Backend worst case ≈ 35s + overhead < the 45s client abort — the backend
always loses the race and surfaces its own, accurate error. The frontend
abort message states the actual client budget; the backend page-timeout
error states the provider budget and graph.

### The server-side cap: `FALKORDB_SERVER_TIMEOUT_MAX_MS`

FalkorDB is launched with `TIMEOUT_MAX` in `FALKORDB_ARGS` (base deploys:
180000ms; the production-cluster overlay: 120000ms). The server **rejects**
— never runs — any query whose per-query `TIMEOUT` parameter exceeds it:

> The query TIMEOUT parameter value cannot exceed the TIMEOUT_MAX
> configuration parameter

The backend clamps every server-side timeout it sends to
`FALKORDB_SERVER_TIMEOUT_MAX_MS` (default 180000). **This value must equal
the deployed `TIMEOUT_MAX`** — it is wired in:

- `docker-compose.yml` — every FalkorDB-consuming service
- `deploy/k8s/base/configmaps/common-config.yaml` (180000) and the
  `production-cluster` overlay patch (120000)
- Helm: `config.falkordb.serverTimeoutMaxMs` → the shared `dataviz-config`
  ConfigMap

A generous client budget (the insights materialization's 600s
`STATS_POLL_TIMEOUT_LARGE_SECS`) now degrades to "run for up to
TIMEOUT_MAX" instead of instant rejection.

### Socket timeout floor

`FALKORDB_SOCKET_TIMEOUT` (per-tier: viz 10 / worker 60 / controlplane 5)
is a hang-net for black-holed TCP connections — but the redis client
applies it to each `read_response`, and a long Cypher query sends no bytes
until it completes. The provider therefore **floors the graph-pool socket
timeout above the server cap** (`TIMEOUT_MAX/1000 + 15s`), so the hang-net
can never kill a legitimately long query mid-flight. Tight hang detection
is preserved by the per-call `asyncio.wait_for` budgets, which bound every
call regardless of socket state. The configured per-tier values still apply
to non-graph pools.

## Insights-service knobs

| Knob | Default | Meaning |
|---|---|---|
| `STATS_POLL_LARGE_THRESHOLD` | 100000 | Node count at/above which the top-level payload is materialized |
| `TOP_LEVEL_MATERIALIZE_LIMIT` | 1000 | Nodes per materialization window (complete window ⇒ filtered serving; 8MB payload safety cap applies) |
| `TOP_LEVEL_SERVE_MIN_NODES` | = threshold | Serve-gate floor; lower it to serve materialized pages for mid-size graphs |
| `TOP_LEVEL_SERVE_MATERIALIZED` | true | Kill switch for the materialized serve path |
| `CACHE_PREWARM_MAX_NODE_COUNT` | 500000 | Gates ONLY the aggregated/children warm fan-out; the top-level warm runs for any size (it reads the materialized payload, not FalkorDB) |
| `PROVIDER_INSTANTIATION_TIMEOUT_SECS` | 10 | Provider connect+preflight budget; raise if the instantiation breaker trips under FalkorDB load (`breaker=... fails=N/M` log) |

Observability: `top_level_cache.serve ds=... outcome=...` logs every serve
decision (`hit`, `stale_hit`, `miss_small`, `miss_no_payload`,
`miss_filtered_truncated`, `miss_beyond_window`, ...). A sustained rate of
`miss_filtered_truncated` / `miss_beyond_window` means your graphs have
top-level sets larger than the materialize window — raise
`TOP_LEVEL_MATERIALIZE_LIMIT`, or if that hits the 8MB payload cap, that is
the trigger to move the payload into a dedicated Postgres table
(deliberately not built yet).

## The incident this fixes (root-cause chain)

Symptom: on 2-3M+ node graphs the ViewWizard Assignment Step failed after
~17s with a misleading "timeout after 30s" error, repeatedly, while the
data eventually loaded; logs showed `falkordb slow ro`, provider
instantiation breaker failures, and "TIMEOUT parameter value cannot exceed
TIMEOUT_MAX".

1. The insights materialization passed its 600s budget as the per-query
   `TIMEOUT` → FalkorDB rejected it (600000 > `TIMEOUT_MAX` 180000) → the
   materialized payload **never existed** → every request fell back live.
2. The live path ran the full-graph O(N) count scan on every request,
   sharing the page query's 15s budget → the count blew it at ~15s (+
   overhead ≈ the observed 17s) and 5xx'd the whole request.
3. The timeout ladder was inverted (client 30s ≤ backend 2×15s) and the
   "30s" in the surfaced message was the client config, never the limit
   that actually fired; the backend's timeout serialized to an empty
   string (`str(asyncio.TimeoutError())`).
4. The cache warmer skipped graphs >500k nodes entirely, and its top-level
   step queried FalkorDB live — so Redis was never pre-warmed for exactly
   the graphs that needed it.
5. The pinned single Cypher thread made provider instantiation exceed its
   10s budget → the instantiation breaker noise (`breaker=closed
   fails=N/M`).

Each layer above maps 1:1 to a link in this chain.
