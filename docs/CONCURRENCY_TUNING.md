# Concurrency, timeouts, and what to change when users complain

**Who this is for:** whoever is on call when the platform is slow, and whoever is
sizing it before that happens.

Every value here is a *ceiling on how much work can be in flight somewhere*. Get one
wrong and the platform does not usually break — it queues, and queueing is what users
experience as "the graph is slow" long before anything turns red. So the organising
question of this document is not "what does this variable do" but **"what does the
operator SEE, and which value caused it"**.

Two companions, both still authoritative for what they cover:

* [`FALKORDB_DEPLOYMENT.md`](FALKORDB_DEPLOYMENT.md) — the graph store itself: pod
  topology, the memory sizing formula, AOF, DR. **Do not re-derive memory sizing here**;
  §"Sizing: the ceilings share ONE budget" is the source of truth.
* [`UPGRADE_2026-09-10_graph-availability.md`](UPGRADE_2026-09-10_graph-availability.md)
  — the overrides an existing deployment must *remove* to get current defaults. An
  explicit override in a ConfigMap beats a new default silently, with no warning.

---

## 1. The ladder, and the one rule that governs it

A graph request passes through six ceilings. Each is a separate queue.

| # | Ceiling | Value | Scope |
|---|---|---|---|
| 1 | ASGI request tier | 45s aggregation / 60s graph+trace / 120s versioning | per request |
| 2 | Per-source admission gate | `hard = GRAPH_READ pool − 4` = **16** | per **process**, per data source |
| 3 | `GRAPH_READ` DB session | `pool_size 10 + overflow 10` = **20** | per **process** |
| 4 | Provider semaphore | `PROVIDER_MAX_CONCURRENCY` = **8** (+16 waiters, 2s wait) | per **process**, per (provider, graph) |
| 5 | FalkorDB query threads | `THREAD_COUNT` **6** per node | per node |
| 6 | FalkorDB queue | `MAX_QUEUED_QUERIES` **150** per node | per node |

**The rule: every outer deadline must outlast the one inside it.**

```
FalkorDB TIMEOUT (per query)  <  provider budget  <  ASGI tier  <  client  <  ingress
        clamped to TIMEOUT_MAX      e.g. 30s          45s          60s        180s
```

When this holds, the innermost layer that can *explain* the failure is the one that
fires, and the user gets a real message. When it is inverted, the outer layer cancels
first, the user gets an opaque 504 — and, worse, **the inner layer keeps working on a
result nobody will read**. FalkorDB serves from a small fixed thread pool, so abandoned
queries are the single most effective way to take the store down. Two of the incidents
behind this document were exactly that shape.

If you change any timeout, re-check the whole chain. `FALKORDB_AGGREGATED_READ_BUDGET_SECS`
is derived from the tier above it (0.8 ×) precisely so that it cannot drift out of order.

### What the fleet can actually present

Multiply the per-process numbers by processes, because **every in-process limit is
per gunicorn worker, not per pod and not per cluster**:

```
3 viz-service replicas × GUNICORN_WORKERS 4          = 12 worker processes
admitted graph requests   12 × 16                    = 192 in flight
concurrent FalkorDB calls 12 ×  8                    =  96 per provider
```

Against that, the store executes:

```
3 masters        × THREAD_COUNT 6                    =  18 threads
+ 6 replicas (9-pod rule) × 6, for read-only queries =  54 threads at best
queue depth      9 nodes × MAX_QUEUED_QUERIES 150    = 1350 queries
```

**The application tier can present roughly two to five times more concurrent work than
the graph store can execute.** That is not automatically wrong — the queue exists for
exactly this — but it does mean:

> **The binding constraint is FalkorDB query threads, not the web tier.**
> Adding viz-service replicas does not add graph capacity. It adds queue depth.

How many users that supports depends entirely on **mean query service time**, which is a
property of your data, not of this configuration:

```
users ≈ (threads ÷ mean_service_time) ÷ queries_per_user_per_second
```

A canvas open costs roughly ten queries, fanned out four at a time
(`VITE_HYDRATION_CONCURRENCY`). At one canvas open per user per 30s:

| Mean service time | Throughput (54 threads) | Users supported |
|---|---|---|
| 50 ms | ~1080 q/s | ~3200 |
| 250 ms | ~215 q/s | ~650 |
| 500 ms | ~108 q/s | ~320 |
| 2 s | ~27 q/s | ~80 |

**Measure your service time before trusting any row of that table.** It is the one input
that decides the answer and the one nobody can derive from the manifests.

---

## 2. Troubleshooting by symptom

Start from what the user reports, not from a variable name.

### "The graph is slow, but nothing is failing"

The expected shape of healthy saturation. Work is queueing at ceiling 5 or 6.

1. `GRAPH.CONFIG GET THREAD_COUNT` on each master, and check the pod's CPU limit.
   The rule is `THREAD_COUNT = ceil(pod CPU limit)`. If threads are below cores, you
   are leaving capacity unused; raise both together.
2. Check `/health/deps` → `resilience.breaker`. The healthy shape under load is
   **`deadline_timeouts_not_counted` rising while `breaker_opens` stays flat** — slow,
   not broken.
3. If threads are saturated and CPU is not, the queries are I/O or memory bound, not
   CPU bound; raising `THREAD_COUNT` will not help. Look at query shape instead.

**Raising `THREAD_COUNT` costs memory.** Container memory must satisfy
`1.25 × maxmemory + THREAD_COUNT × 1.3 × QUERY_MEM_CAPACITY + overhead`. Raising threads
without raising the limit trades a caught query error for an OOM-killed pod, under
exactly the load the change was meant to serve. `THREAD_COUNT_ASSUMED` in
`graph_store_limits.py` must stay ≥ the highest shipped `THREAD_COUNT`; a test enforces it.

### "Graph service unavailable" — but FalkorDB is up

Almost always a signal being classified as an outage when it is not.

1. `/health/deps` → `resilience.breaker`. If `breaker_opens` is climbing, something is
   being counted that should not be. Only connection-class failures may count. Slow
   queries (`ProviderTimeout`), shedding (`ProviderBusy`), warm-up (`ProviderLoading`)
   and node rotation (`ProviderFailingOver`) are all registered as logical exceptions
   and must leave the breaker closed.
2. Check for stale overrides. `PROVIDER_PREFLIGHT_DEADLINE_S` pinned at the old `1.5`
   makes a healthy-but-loaded provider fail its own reachability probe.
   `PROVIDER_PREFLIGHT_AMBIGUOUS_MISSES` at `1` gates on a single slow probe.
3. A provider stuck unhealthy with a healthy store is a breaker that opened and has not
   probed back. `resetBreaker` clears it; the *cause* is step 1.

### "It says my data is gone" / "Start building" on a view that has data

A failed read being rendered as an empty one. This class of bug has appeared three
times; the invariant is **a read that failed is not a read that returned nothing**.

1. Confirm the store actually has the data (Admin → Graph store, or `GRAPH.QUERY` a count).
2. If it does, the failure is being swallowed somewhere into `[]`. Check logs for a
   warning at the read site — a swallowed exception nearly always logs before returning
   the empty list.

### Canvas opens time out on large views, every time

1. `FALKORDB_NODES_QUERY_TIMEOUT` pinned at the old `5` is the usual cause. The default
   is **20**; a type-shaped query sorts a whole label before paging and legitimately
   exceeds 5s on a large graph.
2. `HTTP_TIMEOUT_GRAPH_SECS` pinned at `15` kills `/edges/between` (40s budget)
   mid-flight. The default is **60**.
3. If neither is pinned, the view is genuinely too wide. The read ladder should be
   returning a *degraded partial* rather than nothing — if it is not, check that
   `FALKORDB_AGGREGATED_READ_BUDGET_SECS` still sits under `HTTP_TIMEOUT_AGGREGATION_SECS`.

### 429s during a normal canvas open

A burst being shed that should have been absorbed.

* `PROVIDER_SEMAPHORE_BUDGET_S` pinned at the old `0.25` sheds the tail of a normal
  ten-query fan-out even though each slot frees in ~100ms. The default is **2.0**.
* Occasional 429s under real load are correct behaviour — the canvas retries in place
  and a fast 429 is cheaper for everyone than a slow 504. Sustained 429s are not; they
  mean ceiling 4 is below what a single view needs.

### One data source is slow and now everything is slow

The bulkhead is not doing its job. Every graph request holds a `GRAPH_READ` session
across its outbound call, and that pool is shared by all data sources.

* Check `/health/deps` → `resilience.provider_manager` for `graph_shed_over_share`.
* `PROVIDER_SOURCE_RESERVED` (default `pool // 8` = 2) is the share each source can
  always take. With many sources and a small pool, raise the pool rather than the reserve.
* Verify `DB_GRAPH_READ_POOL_MAX_OVERFLOW` is spelled correctly in your ConfigMap —
  a misspelling leaves the pool at the code default and the admission gate sizes itself
  from a number you did not choose.

### Aggregation runs make the platform unusable

1. Confirm read-pressure signalling is live: `/health/deps` → `resilience.read_pressure`.
   `signals_sent` should be non-zero while users are being starved. If it is zero and
   users *are* starved, the listener did not register — check startup logs for
   "read-pressure signal not registered".
2. `AGGREGATION_READ_PRESSURE_PACING_RATIO` (default 4.0) is the yield. The larger of it
   and the job's own pacing ratio wins, so a job set to "no pacing" still yields.
3. If jobs still dominate, the contention is writes, not pacing: check the write lease
   and the per-endpoint write slots, and whether several sources are rebuilding onto the
   same shard at once.

### A node restart takes an hour

This is AOF incremental replay, not RDB load. The repo's own measurement puts base AOF
bulk-load at ~74 MB/s (13 GB ≈ 3 min) against incremental replay at minutes per GB.

* `--auto-aof-rewrite-percentage 80 --auto-aof-rewrite-min-size 256mb` bound the
  incremental. **Currently these exist only in `docker-compose.yml`** — every k8s
  manifest runs the Redis default. Adding them is the single highest-value change for
  restart time.
* During the window, the node answers `-LOADING`. That is `ProviderLoading`, which must
  reach the client as "starting up", not as an outage and not as a stale 200.

---

## 3. Values that changed recently, and why

| Value | Was | Now | Why it matters |
|---|---|---|---|
| `THREAD_COUNT` (base/helm) | 4 | **8** | Read concurrency. Requires cpu 8 / memory 14Gi together. |
| `THREAD_COUNT_ASSUMED` | 4 | **8** | The memory guard's fallback. Too low under-books and approves an OOM. |
| `FALKORDB_NODES_QUERY_TIMEOUT` | 5 | **20** | Canvas hydration on large views. |
| `HTTP_TIMEOUT_GRAPH_SECS` | 15 | **60** | Must outlast the 40s `/edges/between` budget. |
| `PROVIDER_SEMAPHORE_BUDGET_S` | 0.25 | **2.0** | Absorb a canvas open's burst instead of shedding its tail. |
| `PROVIDER_PREFLIGHT_DEADLINE_S` | 1.5 | **2.5** | A loaded provider must not fail its own probe. |
| `PROVIDER_SLOT_MAX_WAITERS` | — | **16** | Bounds the queue so waiting cannot drain the DB pool. |
| `FALKORDB_AGGREGATED_READ_BUDGET_SECS` | — | **0.8 × tier** | One wall clock for the whole read ladder, not one per rung. |
| `EFFECTS_THRESHOLD` | — | **0** | Replicate writes as effects; required for the replication behaviour in §5aa. |

---

## 4. Before you change anything

1. **Check for an existing override first.** A ConfigMap value beats a new default
   silently. Most "the fix did not work" reports are this.
2. **Change one ceiling at a time**, and know which queue you are moving work into.
   Raising a ceiling never removes a queue; it relocates it.
3. **Re-check the timeout ordering** after any timeout change (§1).
4. **Re-check the memory formula** after any `THREAD_COUNT` or `QUERY_MEM_CAPACITY`
   change — see `FALKORDB_DEPLOYMENT.md` §"Sizing".
5. **Watch `/health/deps` → `resilience`** for a release, not just the logs. The counters
   are there to make a change verifiable: timeouts rising with `breaker_opens` flat is
   the healthy shape.
