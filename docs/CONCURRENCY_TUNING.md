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
* `docs/UPGRADE_2026-09-10_graph-availability.md` (in the repository, not in-app) — the
  overrides an existing deployment must *remove* to get current defaults. An explicit
  override in a ConfigMap beats a new default silently, with no warning.

---

## 1. The ladder, and the one rule that governs it

A graph request passes through eight ceilings. Each is a separate queue.

| # | Ceiling | Code default | **As deployed** | Scope |
|---|---|---|---|---|
| 1 | ASGI request tier | 45s aggregation / 60s graph+trace / 120s versioning | same | per request |
| 2 | Per-source admission gate | `hard = GRAPH_READ pool − 4` = 16 | **12** | per **process**, per data source |
| 3 | `GRAPH_READ` DB session | `pool_size 10 + overflow 10` = 20 | **8 + 8 = 16** | per **process** |
| 4 | Provider semaphore | `PROVIDER_MAX_CONCURRENCY` = **8** (+16 waiters, 2s wait) | same | per **process**, per (provider, graph) |
| 5 | Provider query semaphore | `FALKORDB_QUERY_CONCURRENCY` = **20** | same (unset) | per **process** |
| 6 | Outbound socket pool | `FALKORDB_GRAPH_POOL_SIZE` = **24** | same (unset) | per **process**, **per node** |
| 7 | FalkorDB query threads | `THREAD_COUNT` **6** per node (cluster overlay) | same | per node |
| 8 | FalkorDB queue | `MAX_QUEUED_QUERIES` **150** per node | same | per node |

Two things this table does not show, both of which matter:

* **There is no ceiling above row 2.** Uvicorn is started without
  `--limit-concurrency` (`backend/Dockerfile.viz`), so the ASGI layer accepts
  everything and the first real gate a graph request meets is the admission gate.
  Non-graph endpoints meet no gate at all.
* **A cache hit bypasses rows 4–8 entirely.** The provider slot is taken only by the
  singleflight *leader* that actually computes, so all 144 admitted requests can be in
  flight holding zero provider slots. Cache hit rate is therefore the single largest
  lever on this page.

**Read that table's two value columns before anything else.** `viz-config.yaml` sets
`DB_GRAPH_READ_POOL_SIZE: "8"` and `DB_GRAPH_READ_POOL_MAX_OVERFLOW: "8"`, so the pool is
16 and the admission gate derives **12**, not the 16 a reader of the code alone would
assume. This is the trap in §4.1 happening to this very document: the deployed value wins,
silently, and no log line says so. Whenever you reason about capacity, reason about the
*right-hand* column — and confirm it with `kubectl get configmap viz-config -o yaml`
rather than from memory.

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
admitted graph requests   12 × 12                    = 144 in flight
concurrent FalkorDB calls 12 ×  8                    =  96 per provider
```

Against that, the store executes **far less than the whole cluster suggests**, and this
is the most important number on the page:

```
one data source → one graph key → ONE hash slot → ONE shard
read-only Cypher is routed to that shard's in-sync replicas (_replica_for,
falkordb_provider.py:2326) and round-robined across them — that shard's only

  today  (replicas: 2 = 1 master + 1 replica)   1 replica  × THREAD_COUNT 6 =  6 threads
  at nine pods (replicas: 3 = 1 master + 2)     2 replicas × THREAD_COUNT 6 = 12 threads

queue behind them: MAX_QUEUED_QUERIES 150 per node
```

**Three shards spread data SOURCES across hardware. They do not widen a single source.**
Everyone looking at the same data source is served by the query threads of that source's
shard — six of them on the shape shipped today.

> **The binding constraint is the six (soon twelve) query threads on one shard's
> replicas.** Adding viz-service replicas does not add graph capacity — it adds queue
> depth. Adding *shards* only helps if your load is spread across several data sources.
> Going from `replicas: 2` to `replicas: 3` on the cluster StatefulSets **doubles read
> capacity per source**, which makes the 9-pod move a throughput change, not only a
> resilience one.

Against 6–12 threads the fleet can present 96 provider slots, and each HTTP request
issues one Cypher per label bucket. Once `slots_in_use × buckets ≥ 150` the store starts
answering `Max pending queries exceeded` — which the app now surfaces as a retryable 429
rather than a 500. With two label buckets that threshold is 75 slots; with three, 50.

How many users that supports depends entirely on **mean query service time**, which is a
property of your data, not of this configuration:

```
users ≈ (threads ÷ mean_service_time) ÷ queries_per_user_per_second
```

A cold canvas open of a 500-entity view with 5 entity types costs **~9 HTTP requests and
~55 Cypher queries** — `/nodes/query` ×5, `/edges/between`, `/nodes/degree` ×2 (each ×2
directions), `/edges/aggregated`, every one of them fanned out per label bucket. A warm
graph cache costs 0 Cypher but still holds 9 admission slots and 9 DB sessions.

At one cold open per user per 60s, against **6 threads** (today's shape):

| Mean Cypher time | Throughput | Cold opens/s | Users supported |
|---|---|---|---|
| 20 ms | 300 q/s | 5.5 | ~330 |
| 50 ms | 120 q/s | 2.2 | ~130 |
| 100 ms | 60 q/s | 1.1 | ~65 |

Double each row for the 9-pod shape. Cache hit rate moves it more than anything else on
this page — a warm open costs no Cypher at all.

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

---

## 5. Hypertuning: making it faster, in the order that works

This section is the playbook for "we need more throughput". It is ordered, and the order
matters — most performance work fails because someone pulls lever 6 while lever 1 is
still the constraint.

**The governing fact, from §1:** the application tier can present ~96 concurrent queries
per provider against **6 query threads** on the one shard replica serving that data
source. **The store is the constraint, and adding web capacity does not change that.** Every step below is either "make the store do less",
"make the store do it faster", or "make the app ask for less". In that order.

### Step 0 — Measure, or everything below is guesswork

You cannot tune what you have not measured, and exactly one number decides how many users
this supports: **mean query service time**.

```bash
# Per-node: how many queries ran, how long they took, how deep the queue got.
redis-cli -h <shard> GRAPH.INFO
redis-cli -h <shard> INFO commandstats      # calls + usec_per_call for GRAPH.QUERY / GRAPH.RO_QUERY
redis-cli -h <shard> SLOWLOG GET 25         # the tail that eats threads
```

Then the app's own view, which costs nothing and is already wired:

```bash
curl -s localhost:8080/health/deps | jq '.resilience'
```

Record: `usec_per_call`, the p99 from SLOWLOG, `breaker.deadline_timeouts_not_counted`,
`provider_manager.slots_shed_wait_timeout`, `provider_manager.graph_shed_over_share`.
Those five tell you which of the eight ceilings is actually binding.

### Step 1 — Stop doing avoidable work (free, biggest wins)

Nothing here costs capacity; it removes load.

| Lever | Effect | How to confirm it worked |
|---|---|---|
| Remove stale overrides (§4.1) | Often the whole problem | Values in `/health/deps` match the new defaults |
| Confirm the drift sweep is bounded | Was 3 full scans/source/60s on the read threads | `GRAPH.INFO` query count drops between sweeps |
| Retire unused `:AGGREGATED` edge indexes | Every edge write updates every index | `CALL db.indexes()` shows only the ones in `index_policy.py` |
| Let aggregation yield to reads | Jobs stretch pacing while users are starved | `resilience.read_pressure.signals_sent > 0` under load |
| Bound AOF rewrite (`--auto-aof-rewrite-percentage 80 --auto-aof-rewrite-min-size 256mb`) | Restart minutes instead of an hour | `INFO persistence` → `aof_current_size` stops growing unboundedly |

### Step 2 — Spread the load across nodes you already pay for

The 9-pod layout exists so reads do not all land on three masters.

* **Add the second replica.** The cluster StatefulSets ship `replicas: 2` (1 master +
  1 replica); `FALKORDB_DEPLOYMENT.md` §3 specifies `replicas: 3` (the 9-pod rule), and
  the 56Gi sizing budget already assumes two replicas per master. Reads round-robin
  across a shard's in-sync replicas, so this is a **2× read-throughput change per data
  source**, not only a resilience one. It is the single largest safe win available.
* Confirm read routing is actually offloading. If `GRAPH.INFO` shows the master busy and
  the replica idle, `_replica_for` is returning None — usually the settle window after a
  write, or a replica judged out of step — and every read is hitting the master.
* Check placement skew. One shard holding the busy data source means one shard doing the
  work regardless of how many nodes exist. Admin → Graph store shows per-shard memory.
  Sharding helps only when load is spread across *several* data sources.
* `cluster-require-full-coverage no` keeps two shards serving when one is down — verify it
  is still set.

### Step 3 — Give the store more threads (costs memory, needs care)

`THREAD_COUNT` is the read-concurrency ceiling. Raising it is the most direct lever and
the easiest to get wrong.

```
required container memory =
    1.25 × maxmemory
  + THREAD_COUNT × 1.3 × QUERY_MEM_CAPACITY
  + repl-backlog-size
  + replicas × replica-output-buffer-hard-limit
  + overhead (≈1Gi)
```

> **The in-app guard counts replication.** `container_memory_needed()` takes the
> backlog and the per-replica output-buffer hard limit, and the Infrastructure → Memory
> headroom check passes what the node reports for both (read from its own `CONFIG`).
> On a node that will not answer `CONFIG GET` — a managed instance, an ACL without it —
> those terms read as zero and the guard is back to the single-instance rule; the
> numbers in the dialog say which was used. It did not count them until 2026-09-11,
> and approved 8 threads on a 56Gi shard that the manifest's own budget refused.

Worked, for the cluster overlay today (32gb maxmemory, 1GiB ceiling, 56Gi limit, 2
replicas per master, 1GiB backlog, 2GiB replica output buffer):

| THREAD_COUNT | Query memory | Needed (the guard's figure) | Fits in 56Gi? |
|---|---|---|---|
| 6 (current) | 7.8 | 53.8 | yes, 2.2 spare |
| 7 | 9.1 | 55.1 | yes, 0.9 spare — tight |
| 8 | 10.4 | 56.4 | **no** |

So on the current shape there is **one thread of headroom**, not four — and the last row
is the case the dialog used to approve. To go further you must
first lower `QUERY_MEM_CAPACITY`, lower `maxmemory`, or move to a larger machine —
**in that order of preference**, since the first two are reversible and the third is not.
Raising `THREAD_COUNT` without the memory trades a caught query error for an OOM-killed
pod, under exactly the load the change was meant to serve.

`THREAD_COUNT` must also stay ≤ the pod's CPU limit (currently 7), or the threads contend
for cores they do not have and each query gets slower — throughput falls while the number
on the dial goes up.

### Step 4 — Make the app ask for less, and shed sooner

Only once the store is as fast as it is going to get. Counter-intuitively, **lowering**
app concurrency can raise throughput: presenting 96 concurrent queries to 54 threads means
42 are queueing, and a queued query holds a `GRAPH_READ` session and a provider slot the
whole time it waits.

* `PROVIDER_MAX_CONCURRENCY` (8/worker → 96 fleet-wide). Bringing it nearer the store's
  real thread count converts slow 504s into fast 429s, which the canvas retries in place.
  **Do not change this without step 0** — shed too eagerly and normal canvas opens fail.
* `VITE_HYDRATION_CONCURRENCY` (4) is the browser-side fan-out per view. Lower means
  gentler bursts and a longer single-view load.
* `AGGREGATED_EDGE_PAGE_SIZE` controls how much one read asks for at once. Smaller pages
  hold a thread for less time each, at the cost of more round trips.

### Step 5 — Add capacity (last, because it is the only one that costs money)

* **More FalkorDB shards** is the only change that raises the ceiling in §1. It requires a
  reshard, which is not online for graph keys — plan it.
* **More viz-service replicas** raises the *presented* concurrency, not the served
  concurrency. It helps only if step 0 showed the web tier as the constraint (event-loop
  lag high, FalkorDB threads idle). Otherwise it deepens queues and makes latency worse.
* **Bigger FalkorDB nodes** buy `THREAD_COUNT` headroom via step 3's formula.

### What "done" looks like

Under target load, sustained:

* `breaker_opens` flat while `deadline_timeouts_not_counted` may rise — slow, not broken.
* `graph_shed_over_share` near zero — no source starving its neighbours.
* Aggregate p95 within the SLO in `loadtest/lib/slo.py` (< 500 ms), failure rate < 0.1%.
* FalkorDB `SLOWLOG` not growing a tail of multi-second queries.
* Memory stable well below `maxmemory` on every shard, with no eviction (there is none —
  `noeviction` means writes fail instead).

### The honest caveat

Every number in this section is arithmetic over configuration. **None of it has been
measured against a real cluster under real load.** The load-test harness in `loadtest/`
exists to settle that — `canvas_open` in particular models the hot path — and until it has
been run at target concurrency, treat §1's user-count table as a shape, not a promise.

## 6. Steady load: what one write batch costs, and the controls that keep it steady

A rebuild took a master and its replica down. The write governor (see the
replication section of `AGGREGATION_PIPELINE.md`) is what stops that happening
again; this section is about the layer under it — how much one write batch
costs the node, why "smaller and steadier" beats "larger and faster" for
everyone using the graph, and which knob does what. Everything here is read
from the code; the load-test harness has not yet measured it.

### What one apply batch is

One `GRAPH.QUERY`: `UNWIND $batch AS item MATCH (s {urn}) MATCH (t {urn}) MERGE
(s)-[r:AGGREGATED {aggKey}]->(t) SET r.weight, r.sourceEdgeTypes, r.sourceLevel,
r.targetLevel, r.sourceDepth, r.targetDepth, r.levelDigest, r.latestUpdate`,
with `$batch` carrying between 50 and `writeBatchMax` rows. Per row the node
does two index seeks (label + urn), one edge-index seek on `aggKey`, the merge,
eight property writes, and an update of every edge index those properties sit
in (`index_policy.declared_edge_indexes()`). The commit then appends the
batch's change log to the AOF and to every replica's output buffer
(`EFFECTS_THRESHOLD 0`, so a replica applies the log instead of re-running the
query), and `used_memory` grows by roughly `bytesPerEdge` per new edge.

### Why the batch size is what users feel

FalkorDB takes the graph's **write lock** at a write query's first mutation and
holds it until the query ends. While a batch runs, every read of that graph —
every canvas open, every trace — waits for it. The old sizer targeted 0.8–2.0 s
per batch and paced at a 50% duty cycle, so users of a graph being rebuilt saw
one- to two-second stalls half the time. The rows are the same either way; the
lock windows are not. Ten batches of 50 rows cost readers ten short waits; one
batch of 500 costs them one long one — and the fixed cost of a batch (a parsed,
plan-cached query, one round trip, one governor `INFO`, one `WAIT`) is
milliseconds. **Smaller batches at the same duty cycle are close to free for
the rebuild and much cheaper for readers.** That is the whole argument for
`writeBatchTargetS`, and why it defaults to 1.0 s rather than 2.0.

### The five controls, in the order they act

| | Control | Knob | What it decides |
| --- | --- | --- | --- |
| 1 | **Hold** | `AGGREGATION_HOLD_MAX_SECS`, `replicaAckMin` (0 waves the replica reasons through) | Nothing is written while the node is forked, missing the replicas the run started with, running a replica too far behind, or past the memory line. Bounded per hold; the run then stops for a person with its checkpoint. |
| 2 | **Ease** | derived from the same reading | Replicas half way to the drop limit, or the container's fork line within an eighth of the limit: half the batch ceiling, twice the pause, until the reading is back. The graded response that keeps 1 from being needed. |
| 3 | **Size** | `writeBatchMax` (500), `writeBatchTargetS` (1.0 s) | AIMD against the target: a batch that ran longer halves the next; five in a row under two fifths of it grow it by 100, never past the ceiling. After any hold, the next batch is half. |
| 4 | **Settle** | `replicaAckMin`, `replicaAckTimeoutMs` | The batch is done only when the query has returned AND the replicas have acknowledged it. The sizer judges the batch by the master's time or the wait, whichever was longer — never the sum, which would shrink batches behind a replica that is merely behind and starve the run; the pause is drawn on the master's time alone. |
| 5 | **Pause** | `writePacingRatio` (1.0) as a CEILING, `writePacingMinRatio` (0.25) as the floor, `writeMinGapMs` (100), `AGGREGATION_READ_PRESSURE_PACING_RATIO` (4.0) | `duration × ratio`, never below the minimum gap, never above 30 s. The governor's own reading picks where between floor and ceiling: a node with no fork, its replicas in sync and a quarter of its container free is written to at the floor. Stretched to the read-pressure ratio while the web tier reports readers starving (it takes the LARGER, so readers always win), doubled while eased. |

Across jobs: the per-endpoint write slots (`FALKORDB_ENDPOINT_WRITE_SLOTS`, 2)
bound how many rebuilds write to one node at once, and the per-node reservation
ledger keeps two rebuilds from both passing on the same headroom. A held run
holds no slot.

### What the job's progress shows

Every heartbeat carries the pace: rows in the last batch, seconds it took, the
acknowledgement wait, the pause after it, the ceiling and target in force, the
rolling duty cycle and rows per second over the last twenty batches, whether
the run is holding or eased and why, the replicas' lag and the container's
measured headroom. Job History shows it as a *Steady load* line on a running
job and keeps the batch record (`run_stats.pace`) and the easing count
(`run_stats.adapted.eases`) on the finished run. "Smaller batches" on a running
job halves `writeBatchMax` live; the sizer re-grows only toward the new ceiling.

### How long a rebuild takes, and why "too gentle" never finishes

Throughput is `batch_rows ÷ (batch_s × (1 + ratio))`. On a node with room to
spare the sizer sits at `writeBatchMax` and the ratio is the FLOOR, so 500 rows
taking 0.3 s at 0.25 is ~1,300 rows/s: a two-million-cell cube lands in about
twenty-five minutes, an eight-million-cell one in about an hour and forty. On a
node that is working, the ratio is the configured 1.0 and the same batches give
~830 rows/s. Both are the pipeline going as fast as the node's own reading says
is safe, which is the point: the ceiling applies when the node needs it.

What turns that into a day is a batch that stays SMALL while it stays SLOW —
the sizer halving on a signal a smaller batch cannot improve. Three such
signals used to reach it and no longer do: the replicas' acknowledgement wait
(a rate, imposed by the wait itself, never a reason to shrink), a governor hold
(a pause, after which the batch is halved once and re-grows), and read pressure
(a longer pause, not a smaller batch). What still shrinks a batch is the
master's own time past the target, which is the one thing a smaller batch
improves. If a run is crawling, the *Steady load* line says which: a long
`batch_s` is the master (dense hubs, a full node, a starved CPU), a long
`ack_s` is the replicas (`EFFECTS_THRESHOLD`, a slow replica), a long pause is
the ratio or an easing, and a hold names itself.

### Dense graphs, and the two ceilings that are not ceilings

A densely connected graph — half a million lineage edges over a few thousand
containers — is the case every arbitrary number gets wrong, because its cube
scales as edges × depth² and its cost is dominated by things that are not the
graph store at all.

* **The same ancestry, walked once.** A leaf's ancestor closure used to be
  evicted from the memo the moment it was computed, so the memo could never
  grow with leaf count. On a dense graph an endpoint shared by ten thousand
  lineage edges had its ancestry walked ten thousand times — the raw PAIRS are
  distinct even though the endpoints repeat. Closures and container rep-sets
  are now kept, bounded, so the walk is paid per node.
* **One pass over the edges, not two.** Forced full detail with no measured
  cell ratio cannot refuse on the estimate, so the pre-compute counting scan
  was a second full read of every lineage edge for a verdict nobody was allowed
  to act on. It is not dropped — the count is what MEASURES the ratio, and
  without it a source can never be calibrated — it is counted during the real
  extract scan instead, at two memoized lookups per edge.
* **The cube decision is two measurements, not a number.** `maxCubeEdges`
  defaulted to 8M and was what actually decided whether a graph got full
  detail. It now defaults to its bound and does not bind. Auto stores the full
  cube while the WRITE BUDGET says the owning shard can hold it and the APPLY
  PROJECTION (estimated cells ÷ the rate this source measured last run) says
  this job's wall clock can finish writing it. A fixed cell count answers
  neither for any particular graph: 8M cells is half an hour on a roomy node
  and a refusal on a full one.
* **A retry that wrote is not a failure to count.** A cube too large for one
  wall clock fails in the same shape every time, and the reconciliation breaker
  used to suspend the source after a handful of those — for converging. The
  marker reconciler now reads the last attempt's write count and clears the
  retry count when it is non-zero, so only attempts that achieved nothing count
  against the breaker.
* **Full detail is never truncated.** Only Auto degrades, and only to the
  depth-diagonal with the rest served on demand. Forced full detail stores
  every ancestor combination at any depth and any size; what stops it is the
  shard having no room, which is a refusal with the numbers, never a silent
  drop. A cube too large for one wall clock still converges: the run keeps its
  checkpoint, the reconcile pass rebuilds what exists, and the apply writes
  only what is still missing. The run says so up front — the advisory names the
  projected hours and the three ways to make it one run.

### Tuning it

* **Users see stalls while a rebuild runs** → lower `writeBatchTargetS` first
  (0.5 s), then `writeBatchMax`. Raising `writePacingRatio` lengthens the gaps
  but not the stalls; the lock window is the batch, not the pause.
* **The replicas keep falling behind** → the run already eases and then holds;
  the durable fix is `EFFECTS_THRESHOLD 0` so they apply a change log instead
  of re-running every batch, and a larger `client-output-buffer-limit replica`
  if they are being dropped. Both are in `FALKORDB_DEPLOYMENT.md`.
* **The rebuild is too slow and nobody is on the graph** → `writePacingRatio`
  0.25 and `writeBatchTargetS` 2.0 (the Performance profile); `writeMinGapMs`
  can go to 0. Never above `writeBatchMax` 2000: the `UNWIND` payload and the
  effects log per batch scale with it, and the 3 s socket timeout the ceiling
  was chosen against has not moved.
* **A fork every few minutes** → the AOF is rewriting too often; see the
  `auto-aof-rewrite-*` settings in `FALKORDB_DEPLOYMENT.md`. The run holds
  through each one and says so; the cost is time, not safety.
