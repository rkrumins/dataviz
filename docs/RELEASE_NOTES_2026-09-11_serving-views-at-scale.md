# Serving views at scale — 2026-09-11

Opening a view on a large graph took ten seconds or more, every time, for every user. A
rebuild running in the background could make the whole environment unresponsive. When a
node rotated, users were told their data was gone. And the operator had no way to see any
of it: the app drew three nodes of a nine-node cluster and had no number for how much of
the store's capacity anything was using.

This documents what caused each of those, what changed at every layer, the values that
moved, how to roll it out, how to verify it, and how to turn each piece off.

**Every behaviour change ships with an environment knob and a default. Nothing requires
configuration** — but read [§7 Rollout](#7-rollout) first: several changes are in
manifests and ConfigMaps that only take effect when re-applied, and an existing override
beats a new default silently.

Companions, each still authoritative for what it covers:

* [`CONCURRENCY_TUNING.md`](CONCURRENCY_TUNING.md) — the eight ceilings, what the operator
  sees when one is wrong, and the hypertuning playbook. **The source of truth for every
  value in [§6](#6-values-that-changed).**
* [`FALKORDB_DEPLOYMENT.md`](FALKORDB_DEPLOYMENT.md) — pod topology, the memory sizing
  formula, AOF, DR.
* [`guide/GRAPH_STORE_TOPOLOGY.md`](guide/GRAPH_STORE_TOPOLOGY.md) — the Admin → Graph
  store page, for the person reading it.
* [`guide/ROLLUP_CAPACITY.md`](guide/ROLLUP_CAPACITY.md) — rebuild capacity and the
  controls that govern it.
* [`../CHANGELOG.md`](../CHANGELOG.md) — the per-change record. This document is the
  reasoning across all of them.

---

## 1. What was wrong

Five problems, each with a different mechanism, all arriving as "the platform is slow" or
"my data is gone".

### 1.1 The rebuild pipeline could take the store down

The aggregation scheduler woke every 60 seconds and fingerprinted **every** scheduled
source, with no "due" predicate despite its own docstring claiming one — so a source
scheduled daily was scanned every minute. Each fingerprint was three unbounded scans
(`MATCH (n)`, `MATCH ()-[r]->()`, and a scan of every node carrying tags, which the code's
own comment called "the silent killer on large graphs").

The client abandoned each probe after 5 seconds; the server kept burning a query thread
for up to 30. FalkorDB serves from a small fixed `THREAD_COUNT`, so a handful of sources
was enough to hold every thread on scans nobody was waiting for — at which point the node
answers nothing, for everyone, not just for aggregation.

And a probe that failed returned `""`, which `fingerprints_match` reads as drift. So every
failure to *measure* the graph was read as a reason to *rebuild* it. Load begat load.

On top of the trigger, each run paid a large fixed tax whether or not anything changed:
~131 serial `CREATE INDEX` statements (three of them issued three times per run from three
call sites), a full re-extract, two cube counts, an `aggKey IS NULL` heal probe, and — for
any source whose identity property was not `urn` — a write pass over the entire node ID
space before the admission controller was even attached.

### 1.2 The store's own shape was invisible

On a nine-node cluster the app showed three. The Infrastructure probe counted masters from
the environment's own topology, and the capacity card read only nodes that owned an
aggregated graph, so every replica was absent. **A node missing from a list is
indistinguishable from a node that does not exist** — which made every capacity number on
the page wrong in a direction nobody could see.

There was also a phantom store: the connection named by `FALKORDB_HOST` was swept, counted
into fleet totals, and presented as something an operator had no way to act on.

### 1.3 The read path could not use the replicas

Read-only Cypher went to masters. A shard's replicas existed for failover and did no work,
so the read capacity of a data source was one node's `THREAD_COUNT` — while two-thirds of
the hardware idled.

When the read router was later given replicas, two gates still kept them idle:

* The **read-settle window** was 30 seconds. Every process that wrote to a graph sent
  *all* its reads of that graph to the master for the next 30 seconds — so on an
  edit-heavy workload the replicas answered almost nothing.
* The in-step check that decides whether a replica is fresh enough measured what it
  claimed only after it was fixed; before that it could clear a replica that was behind.

### 1.4 The cache could not hold

The response cache existed and was, in practice, empty. Three independent defects:

1. **The negative-TTL inversion.** `_is_incomplete_result` treated any `truncated` flag as
   degraded, including a deterministic budget cut — so page one of every wide focus, and
   every capped aggregate, was cached for 5 seconds instead of the full TTL. **Big graphs
   switched their own cache off**, which is exactly backwards: the bigger the graph, the
   more it needed the cache.
2. **A dead label warmer.** The urn→label cache was filled only by a warmup path that no
   longer ran, so the read side missed every time.
3. **A stampede at every cold key.** The in-process singleflight coalesced callers inside
   one worker. The fleet runs twelve. A cold view meant twelve identical computes arriving
   at one shard at the same moment — the moment it was least able to absorb them.

And a fourth, structural: TTLs were 900 seconds, so an unchanged graph re-paid the full
provider cost every fifteen minutes for identical bytes.

### 1.5 Signals that were not outages were read as outages

A shed request (`ProviderBusy`), a store still reading its dataset in (`ProviderLoading`),
and a node rotating (`ProviderFailingOver`) were each, somewhere in the stack, converted
into either an outage banner or — worse — a 200 carrying a snapshot up to a day old. A 200
hides the one fact the client needs to act on: the canvas never retries, because as far as
it can tell it got an answer.

---

## 2. What changed — the read path

### 2.1 Reads are served by a shard's in-sync replicas

`GRAPH.RO_QUERY` is routed to the replicas of the shard that owns the graph, round-robined
per call, so concurrent reads spread across them. Two gates decide whether a replica may
answer:

* **In step.** `_replicas_in_step` measures the bytes a replica still owes the replication
  stream against `FALKORDB_REPLICA_READ_MAX_LAG_BYTES` (8 MiB). The verdict is sampled at
  most every `_REPLICA_SAMPLE_S` (5s) so the check itself is not a load source.
* **Read-your-own-writes.** A process that has written to a graph pins its own reads of
  that graph to the master for `FALKORDB_REPLICA_READ_SETTLE_S`.

**The settle window is now 10 seconds, down from 30.** It is a backstop behind the in-step
check, and what it has to cover is that check's own staleness — one sample period. Ten
seconds is two of them: five of possible sample age plus five of slack, against
replication lag that is milliseconds on this deployment (`EFFECTS_THRESHOLD 0`,
`appendfsync everysec`). Thirty was six sample periods, chosen before the in-step check
existed to back it up.

`GET /admin/graph-store/providers/{id}` reports the share of each provider's reads the
replicas answered — and how often one fell back to its master — so this is verifiable
rather than assumed.

> **What this does and does not buy.** One data source is one graph key, one hash slot,
> one shard. Sharding spreads data *sources*; it does not widen a single source. Going
> from `replicas: 2` to `replicas: 3` **doubles the read capacity of every source** (6
> query threads → 12). Adding viz-service pods adds queue depth, not graph capacity.

### 2.2 The view cache actually caches

Four changes, in the order they matter:

**A deterministic cut is not a degraded answer.** `_is_incomplete_result` now asks whether
the truncation had a *reason the request determines* — `max_nodes`, `degree_cap`,
`orphan`, `truncated` — or whether a probe gave up part way (`degraded_detail`, an
unprobed frontier). The first is the whole answer to that request and gets the full TTL;
only the second gets the 5-second negative window. This is the single change that stopped
large graphs disabling their own cache.

**TTLs are an hour, not fifteen minutes.** `children`, `aggregated`, `top-level`,
`layer-assignment`, `canvas-bootstrap` and `canvas-expand` all default to 3600s.
Freshness on this platform is an *event*, not a clock: every write bumps the scope's
generation, which changes the cache key, which invalidates instantly. The TTL is the
backstop against drift the platform cannot see — not the freshness mechanism. Trace
endpoints stay at 300s; they are cursor-shaped and cheap to recompute.

**One process in the fleet computes a cold key.** The pod-leaders elect one of themselves
through the bus (a single `SET NX` on the cache role). The winner computes; the losers
watch the cache key and take its answer. Every part fails **open** — no bus, a dead
leader, an expired wait all end in "compute it yourself", which is exactly the prior
behaviour. A leader that *sheds* releases its election without writing, and followers
notice the election is over rather than waiting out the full window for an answer that is
never coming.

**An expiry is not evidence that the answer moved.** The last-known-good mirror is now
stamped with the generation it was computed at. On a miss, the cache asks for it *at the
current generation*: a match means nothing has been written since, so a recompute would
return identical bytes — promote the mirror back under the primary key and serve it, with
no provider work at all. No match (a rebuild landed) means decline and compute, because
serving it there would show users the pre-rebuild graph at the moment they asked for the
new one.

Promoting never rewrites the mirror, so **no answer can outlive `GRAPH_CACHE_LKG_TTL_S`
(24h) from when it was actually computed**, however many times it is promoted. That is the
hard bound on drift the platform cannot see. Mirrors written before the stamp existed
carry no generation to compare and are never promoted; they remain the outage fallback,
where an out-of-date snapshot still beats an error.

Net effect on a view that nobody writes to: **one compute, ever, per 24 hours** — instead
of one per 15 minutes per worker process.

### 2.3 The cache is measured, and an operator can rebuild it

Hit ratio is recorded per endpoint per data source in five-minute buckets (two hours of
history) and surfaced in Admin → Graph store, naming each endpoint by what the user did
rather than by its route. The ratio is `hit / (hit + miss + stale)`:

* a **stale** serve kept the user moving but the provider could not answer — folding it in
  would make an outage read as a cache win;
* a **bypass** (endpoint disabled, or Redis unreachable) is not a cache outcome at all and
  must not dilute the denominator;
* a **promotion** ([§2.2](#22-the-view-cache-actually-caches)) counts as a hit, because it
  is one: no provider work, no wait, and the generation says it is the current answer.

`POST /admin/graph-store/cache/refresh` rebuilds a source's cached views — per view or all of them — behind
the system-admin guard.

### 2.4 One wall clock for the read ladder

The aggregated-edge read narrows under pressure (halving the page, splitting URN batches)
rather than dropping rows. Every rung used to get its own timeout, so a ladder of five
rungs could spend five times the budget the caller was prepared to wait for.
`FALKORDB_AGGREGATED_READ_BUDGET_SECS` is now **one deadline for the whole ladder**,
derived as 0.8 × the ASGI tier above it so it cannot drift out of order, with
`FALKORDB_AGGREGATED_READ_MIN_ATTEMPT_SECS` guaranteeing each attempt is worth starting.
When the read must cut, it says which limit cut it.

---

## 3. What changed — the rebuild pipeline

### 3.1 The drift check stopped scanning every graph three times a minute

The scheduler's query gained the "due" predicate its docstring already promised, so a
source scheduled daily is fingerprinted daily. The fingerprint probe now runs under a
budget the *server* honours, not only the client, so an abandoned probe stops consuming a
query thread. And a probe that fails is reported as a failure to measure rather than as
drift, so a struggling store no longer schedules rebuilds against itself.

### 3.2 Index DDL is issued once per graph, not once per job

`ensure_indices` is guarded by a marker (`FALKORDB_INDEX_MARKER_TTL_S`), so the ~131
statements are paid once rather than on every run of every job. Four `:AGGREGATED` edge
indices that no query could enter through were retired: every read of `:AGGREGATED` in the
product is node-anchored, and FalkorDB can only use an edge index when the edge is the
plan's entry point. They held one index document per aggregated edge and were updated on
every edge write, for nothing. The retirement is enforced by a test, because nothing in
the codebase had ever issued `DROP INDEX`.

### 3.3 Rebuilds are budgeted against the shard that will hold them

Before a rebuild writes, it asks the owning shard what it can take: measured memory
headroom, not a guess. A racing pair of rebuilds onto one node reserve against a shared
ledger, so the second one cannot approve growth the first has already claimed. The run
records what it ran with and what it adapted to under pressure, and remembers per source
what it learned — so the next run starts where the last one ended up rather than
rediscovering the same ceiling.

Under pressure the ladder is **never terminal**: every scan path narrows rather than
failing, and the worker flushes on real process memory rather than on a row count.

### 3.4 Automation can be paused, stopped and resumed, and it holds

Holds are enforced at all three gates (scheduler tick, dispatch, and the in-flight poller),
per provider and fleet-wide, and survive a replica restart. Every automatic retry is
bounded, and "③ Act" is a real stop rather than a pause that resumes itself. The UI says
what each switch will do *before* it does it, and the canvas banner says why a hold
persists.

### 3.5 A rebuild never writes through a fork, and its load is steady

A rebuild took a master and its replica down, and every safety value it had was watching
the wrong number. The write budget measured `used_memory` against `maxmemory`; what killed
the node was the container limit, reached by RSS plus a fork's copy-on-write under full
write load. The chain, in order: batches went out as fast as the master took them; a
replica fell behind, overflowed its output buffer and was dropped; the gate read "no
replicas attached" as the topology's problem and wrote on at full speed; the replica
reconnected and asked for a full resync, so the master forked under that load; the
rebuild dirtied nearly every page the child held a copy of, the container limit was
reached and the master was killed; its replica flushed the whole dataset to follow the
promotion and stopped answering its probe. An hour of AOF replay per node.

Every step but the first was visible in one `INFO`. So the shard reading now carries the
whole node — RSS, fragmentation, BGSAVE and AOF-rewrite state, attached replicas, how many
are still receiving a full resync, how far the furthest is behind, what replication holds,
the two limits the master drops a replica at, and the container limit the pod is killed at
— and **before every write batch the pipeline reads it and holds** while the node is
outside the envelope a rebuild may write inside: a fork in flight, fewer replicas than the
run started with, a replica further behind than a quarter of its drop limit, or RSS past
what the container could survive a fork at. Each is true of the node now and false a
little later, so it is a hold, not a refusal; each is bounded per hold
(`AGGREGATION_HOLD_MAX_SECS`, 30 min), after which the run stops for a person with its
checkpoint intact. The write budget also counts the container now: a container sized
below the deployment guide's rule (which now counts replication buffers — the ~5 GiB it
used to leave out) governs before `maxmemory` does, and the refusal says so.

Under the governor the load is **steady**. A write batch holds the graph's write lock
from its first mutation to its end, so one batch is the longest stall every reader of that
graph sees — and the sizer used to aim for 0.8–2.0 s of it, half the time. It now aims for
`writeBatchTargetS` (1.0 s) under a ceiling of `writeBatchMax` (500 rows), both fleet-wide,
per job and live on a running job ("Smaller batches" halves the ceiling), and a batch is
*settled* before the next — the node read, the query returned, the replicas acknowledged —
then paused for `duration × writePacingRatio`, never less than `writeMinGapMs` (100 ms) so
fast small batches never run back to back. Short of a hold the run *eases*: replicas half
way to the drop limit, or the container's fork line within an eighth of the limit, halve
the ceiling and double the pause until the reading is back. The job's progress carries all
of it live — batch rows, seconds per batch, the pause, the rolling duty cycle and rate,
whether the run is holding or eased and why, the replicas' lag and the container's
measured headroom — as a *Steady load* line on the running job, and the run record keeps
the batch figures and every hold by reason. `docs/CONCURRENCY_TUNING.md` §6 is the load
model behind it.

---

## 4. What changed — the operator's view

### 4.1 Admin → Graph store

One snapshot of the whole fleet: every master and every replica of every graph store, the
shard each belongs to, the replica line beneath each master naming the master it follows,
its link status and how far behind it is, and what lives on each node. A master with no
replica standing behind it says so — that is the shard that cannot be promoted out of
trouble. A master that is not answering says its replicas are carrying the reads.

Grouping is settled by asking the nodes (overlapping cluster node ids, or the same Redis
run id off a cluster), not by comparing connection strings — so two provider rows naming
one cluster by different seeds fold onto one card, and the fleet totals count the store
once. There is no default graph store: every graph the page accounts for belongs to a
provider's store.

The sweep never runs inside a request, is bounded by `GRAPH_STORE_TOPOLOGY_DEADLINE_S`,
and will not queue behind a store that is down.

### 4.2 Every limit is readable and settable from the UI

`THREAD_COUNT`, `TIMEOUT_MAX` and `QUERY_MEM_CAPACITY` are read per node and settable at
runtime behind the container memory guard, with the clamp following the node rather than a
fleet-wide assumption. Capacity appears where rebuilds are actually decided, not only on
an infrastructure page.

### 4.3 A node rotation is a pause, not an outage

A shard being replaced reports as `ProviderFailingOver` and reaches the client as a
retryable pause with `Retry-After`. Reads continue from the replicas while the master is
away, the attempt survives a node restart in place, and the frontend retries instead of
rendering an empty graph.

---

## 5. Fixes

| Fix | Symptom it caused |
|---|---|
| A deterministic truncation is not a degraded result | Large graphs cached nothing; every wide view re-read on a 5s cycle |
| The urn→label cache is filled from the read side | Every read missed the label cache and re-derived labels |
| A shed leader resolves its singleflight future before re-raising | Followers on `asyncio.shield` hung until their request tier fired, 45–60s later |
| A shed leader's followers re-raise flow control instead of recomputing | One shed request became N concurrent computes of the same key |
| The breaker proxy is signature-transparent (`functools.wraps`) | Budget-aware provider methods silently lost their budget through the proxy |
| `ProviderBusy` / `ProviderLoading` are not an outage fallback | A shed or warming store returned a 200 carrying day-old data; the canvas never retried |
| `ProviderFailingOver` classified in the exception handler | A node rotation rendered as "your data is gone" |
| A failed read is not an empty read | Views with data showed "Start building" |
| `ensure_indices` tolerates a half-built provider | A rebuild raised instead of building its indices |
| An unread graph inventory is not an empty one | Graphs the sweep could not read were reported as absent |
| The fleet memory figure counts masters, not the deployment | Capacity numbers were wrong by the replica count |
| Replication memory counted in the container sizing rule | The sizing rule approved a `THREAD_COUNT` that would OOM |
| The reconnecting banner's promise is true, and the page bounds what it mounts | The banner said it would recover and then did not |
| "Where does this live" answers from every graph | The answer was drawn from the page's first 2000 rows |
| The Defaults dialog mounts only while open | Work done on every render of a page nobody had opened |

---

## 6. Values that changed

Every value below is documented in full — what it ceilings, what the operator sees when it
is wrong, and what to change instead — in
[`CONCURRENCY_TUNING.md`](CONCURRENCY_TUNING.md). **That document is authoritative; this
table is an index into it.**

### 6.1 Capacity and concurrency

| Value | Was | Now | Why |
|---|---|---|---|
| `THREAD_COUNT` (base/helm) | 4 | **8** | Read concurrency per node. Requires `cpu 8` / `memory 14Gi` together. |
| `THREAD_COUNT_ASSUMED` | 4 | **8** | The memory guard's fallback. Too low under-books and approves an OOM. |
| `PROVIDER_SEMAPHORE_BUDGET_S` | 0.25 | **2.0** | A slot frees in ~100ms; 250ms shed the tail of a view's own burst. |
| `PROVIDER_SLOT_MAX_WAITERS` | — | **16** | Bounds the queue, so waiting for a slot cannot drain the DB pool. |
| `EFFECTS_THRESHOLD` | — | **0** | Replicate writes as effects — required for replica reads. |

### 6.2 Timeouts

| Value | Was | Now | Why |
|---|---|---|---|
| `FALKORDB_NODES_QUERY_TIMEOUT` | 5 | **20** | A type-shaped query sorts a whole label before paging. |
| `HTTP_TIMEOUT_GRAPH_SECS` | 15 | **60** | Must outlast the 40s `/edges/between` budget. |
| `PROVIDER_PREFLIGHT_DEADLINE_S` | 1.5 | **2.5** | A loaded provider must not fail its own reachability probe. |
| `FALKORDB_AGGREGATED_READ_BUDGET_SECS` | per-rung | **0.8 × tier** | One wall clock for the whole ladder. |
| `FALKORDB_REPLICA_READ_SETTLE_S` | 30 | **10** | Two sample periods of the in-step check, not six. |

> **The rule that governs all of them:** every outer deadline must outlast the one inside
> it — `FalkorDB TIMEOUT < provider budget < ASGI tier < client < ingress`. When it is
> inverted, the outer layer cancels first, the user gets an opaque 504, and the inner
> layer keeps working on a result nobody will read. Abandoned queries against a small
> fixed thread pool are the single most effective way to take the store down.

### 6.3 Cache

| Value | Was | Now | Why |
|---|---|---|---|
| `GRAPH_CACHE_CHILDREN_TTL_S` | 900 | **3600** | Invalidation is by generation bump; the TTL is a backstop. |
| `GRAPH_CACHE_AGGREGATED_TTL_S` | 900 | **3600** | ” |
| `GRAPH_CACHE_TOP_LEVEL_TTL_S` | 900 | **3600** | ” |
| `GRAPH_CACHE_LAYER_ASSIGNMENT_TTL_S` | 900 | **3600** | ” |
| `GRAPH_CACHE_CANVAS_BOOTSTRAP_TTL_S` | 900 | **3600** | ” |
| `GRAPH_CACHE_CANVAS_EXPAND_TTL_S` | 900 | **3600** | ” |
| `GRAPH_CACHE_TRACE*_TTL_S` | 300 | 300 | Unchanged — cursor-shaped and cheap to recompute. |
| `GRAPH_CACHE_LKG_TTL_S` | 86400 | 86400 | Unchanged — but now also the **hard ceiling on a promoted answer's age**. |
| `GRAPH_CACHE_NEGATIVE_TTL_S` | 5 | 5 | Unchanged — but now reaches far fewer results ([§2.2](#22-the-view-cache-actually-caches)). |

New knobs, all defaulting on:

| Knob | Default | What turning it off restores |
|---|---|---|
| `GRAPH_CACHE_CROSS_PROCESS_SINGLEFLIGHT` | `1` | Every process computes its own copy of a cold key. |
| `GRAPH_CACHE_LEADER_TTL_S` | `60` (5–600) | How long one leader may hold the election. Must exceed the slowest legitimate compute. |
| `GRAPH_CACHE_LEADER_WAIT_S` | `10` (1–60) | How long a follower watches before computing its own. Shorter than every ASGI tier by design. |
| `GRAPH_CACHE_PROMOTE_UNCHANGED` | `1` | Every TTL expiry is a full recompute, even with no write since. |

### 6.4 Store and topology

| Knob | Default | What it bounds |
|---|---|---|
| `FALKORDB_READ_FROM_REPLICAS` | on | Replica reads entirely. Off sends every read to masters. |
| `FALKORDB_REPLICA_READ_MAX_LAG_BYTES` | 8 MiB | How far behind a replica may be and still answer. |
| `FALKORDB_LABEL_WARMUP_COOLDOWN_S` | 900 | How often a provider re-warms its urn→label cache. |
| `FALKORDB_INDEX_MARKER_TTL_S` | — | How long an "indices exist" marker suppresses re-issuing the DDL. |
| `GRAPH_STORE_TOPOLOGY_CACHE_TTL_S` | — | How long a fleet snapshot is reused. |
| `GRAPH_STORE_TOPOLOGY_DEADLINE_S` | — | The sweep's wall clock. It never runs inside a request. |

---

### 6.5 Rebuild holds and pacing

| Value | Was | Now | Why |
|---|---|---|---|
| Write batch target (`AGGREGATION_WRITE_BATCH_TARGET_S`) | 0.8–2.0 s, fixed in code | **1.0 s**, a knob | The batch is the lock window readers wait for; the same rows in shorter batches cost them less. |
| Write batch ceiling (`AGGREGATION_WRITE_BATCH_MAX`) | 500, fixed in code | **500**, a knob, lowerable live | "Smaller batches" on a running job does less per batch instead of waiting longer between them. |
| `AGGREGATION_WRITE_MIN_GAP_MS` | — | **100** | The pause is a share of the batch's duration; fast small batches ran back to back. |
| `AGGREGATION_HOLD_MAX_SECS` | — | **1800** | One hold's bound; a node not recovering on its own is not one to write into. |
| `AGGREGATION_FORK_COW_PCT` | — | **125** | The fork allowance the container line and budget are drawn with — valid only because writes now hold through a fork. |
| `AGGREGATION_REPLICA_LAG_HOLD_BYTES` | — | derived (¼ of the replica output-buffer hard limit, or ½ the backlog) | The master must never drop a replica because of a rebuild. |
| Replica gate on "no replicas attached" | wrote on | **holds** when the run started with replicas | A replica that vanished mid-run vanished because of the run; its return is a fork. |
| Container sizing rule | `1.25 × maxmemory + threads × 1.3 × cap + overhead` | **+ repl-backlog-size + replicas × replica output-buffer hard limit** | ~5 GiB the rule left out on a cluster. |

## 7. Rollout

Ordered. Steps 1–2 change infrastructure and must land before the values that depend on
them.

1. **Re-apply the FalkorDB manifests.** `THREAD_COUNT 8` requires `cpu 8` / `memory 14Gi`
   on the same pod — applying the thread count alone trades a caught query error for an
   OOM kill under exactly the load it was meant to serve. `EFFECTS_THRESHOLD 0` is
   required before replica reads are correct.
2. **Check `replicas:` on the cluster StatefulSets.** `replicas: 3` (1 master + 2) doubles
   per-source read capacity against `replicas: 2`. This is a throughput change, not only a
   resilience one.
3. **Remove stale overrides from `viz-config`.** An explicit ConfigMap value beats a new
   default silently, with no log line. The ones that most often survive an upgrade and
   undo the fix:
   `FALKORDB_NODES_QUERY_TIMEOUT=5`, `HTTP_TIMEOUT_GRAPH_SECS=15`,
   `PROVIDER_SEMAPHORE_BUDGET_S=0.25`, `PROVIDER_PREFLIGHT_DEADLINE_S=1.5`,
   `GRAPH_CACHE_*_TTL_S=900`, `FALKORDB_REPLICA_READ_SETTLE_S=30`.
   `kubectl get configmap viz-config -o yaml` — read it, do not recall it.
4. **Confirm the pool spelling.** `DB_GRAPH_READ_POOL_SIZE` and
   `DB_GRAPH_READ_POOL_MAX_OVERFLOW` size the admission gate
   (`hard = pool − 4`). A misspelling leaves the pool at the code default and the gate
   sizes itself from a number nobody chose. A test now parses the manifests and fails if
   the ConfigMap and the documented ceilings disagree.
5. **Deploy the backend image**, then the frontend.
6. **Run one rebuild** on a non-critical source and watch Admin → Graph store.
7. **Drop the retired edge indexes, when convenient.** This release stops *creating* four
   `:AGGREGATED` edge indexes no query could ever enter through — but nothing in Redis
   expires an index, and no code path anywhere issues `DROP INDEX`. **A graph that already
   has them keeps them after this upgrade**, holding one index document per aggregated
   edge, updated on every edge write and rebuilt from scratch every time the graph is read
   back off disk. Deploying does not reclaim that; this step does:

   ```
   # Dry run — the default. Lists what is there and what would go. Changes nothing.
   python backend/scripts/cleanup_graph_indices.py --all-shards

   # Drop them
   python backend/scripts/cleanup_graph_indices.py --all-shards --apply
   ```

   Only the exact `(relationship, property)` pairs this product has RETIRED are ever
   dropped — node indexes, the `aggKey` index, the two composites and anything somebody
   else made are left alone, and the script says so rather than assuming. It is
   cluster-aware: each graph is worked on the node that owns it. **Safe to defer** — it
   costs memory and write amplification, not correctness — but until it runs, the index
   half of this release has not landed.

Nothing in steps 3–7 needs a maintenance window. Step 1 is a StatefulSet roll; the app
treats a rotating node as a pause ([§4.3](#43-a-node-rotation-is-a-pause-not-an-outage)).

---

## 8. Verifying it worked

Each row is a thing to look at and the shape that means it is working.

| Look at | Healthy shape |
|---|---|
| Admin → Graph store | Every node of the cluster, not a subset. Each master with its replica line beneath it. |
| Admin → Graph store → cache health | Hit ratio climbing over the first hour and then staying high. A view opened twice should show the second open as a hit. |
| `GET /admin/graph-store/providers/{id}` → `reads` | `replicaReads` climbing against `masterReads`. All-master means a gate is closed — check the settle window and `FALKORDB_READ_FROM_REPLICAS`. |
| `/health/deps` → `resilience.breaker` | `deadline_timeouts_not_counted` rising while `breaker_opens` stays flat. That is slow, not broken — the healthy shape under load. |
| `/health/deps` → `resilience.read_pressure` | `signals_sent` non-zero while a rebuild runs and users are reading. Zero here with starved users means the listener did not register. |
| `GRAPH.INFO` / `INFO commandstats` per node | `usec_per_call` for `GRAPH.RO_QUERY` on the replicas, not only on the master. |
| A cold view open, timed | Seconds on the first open of a source; sub-second on every open after, for up to 24h with no write. |

**The one number to measure before trusting any capacity claim** is mean Cypher service
time. It decides how many users the deployment supports and nobody can derive it from the
manifests — see `CONCURRENCY_TUNING.md` §5 Step 0.

---

## 9. Turning each piece off

Every change is reversible with an environment variable and a restart. Nothing requires a
rollback of the image.

| To restore | Set |
|---|---|
| Masters answer every read | `FALKORDB_READ_FROM_REPLICAS=0` |
| Every process computes its own cold key | `GRAPH_CACHE_CROSS_PROCESS_SINGLEFLIGHT=0` |
| Every TTL expiry is a full recompute | `GRAPH_CACHE_PROMOTE_UNCHANGED=0` |
| Fifteen-minute view TTLs | `GRAPH_CACHE_*_TTL_S=900` |
| No last-known-good fallback at all | `GRAPH_CACHE_LKG_TTL_S=0` |
| The previous settle behaviour | `FALKORDB_REPLICA_READ_SETTLE_S=30` |
| A specific cached endpoint off | `GRAPH_CACHE_ENABLED_<ENDPOINT>=0` (e.g. `GRAPH_CACHE_ENABLED_CANVAS_BOOTSTRAP`) |
| The previous batch shape (0.8–2.0 s batches, no minimum gap) | `AGGREGATION_WRITE_BATCH_TARGET_S=2.0`, `AGGREGATION_WRITE_MIN_GAP_MS=0` |
| No replica reasons in the write governor (a fork and the memory line cannot be turned off) | `replicaAckMin` 0 on the job, or `AGGREGATION_REPLICA_ACK_MIN=0` |
| A longer hold before a run stops for a person | `AGGREGATION_HOLD_MAX_SECS` up to 21600 |

---

## 10. Known limitations

* **Mean Cypher service time is still unmeasured on this deployment.** Every user-count
  figure in `CONCURRENCY_TUNING.md` is parameterised on it, and the load-test harness
  cannot produce it: it fires each request once and counts a non-200 as a failure, so it
  under-measures by roughly 3× and cannot reproduce retry amplification at all.
* **The HPA scales on CPU**, which saturation of the graph store does not move. It also
  crosses `MAX_QUEUED_QUERIES` at the fifth pod. Scaling out the web tier past that point
  adds queue depth against the same query threads.
* **AOF rewrite bounds exist only in `docker-compose.yml`.** Every k8s manifest runs the
  Redis defaults, so a node restart replays a full incremental AOF — minutes per GB
  against ~74 MB/s for a base bulk load. Adding
  `--auto-aof-rewrite-percentage 80 --auto-aof-rewrite-min-size 256mb` to the manifests is
  the single highest-value change for restart time and is **not** in this release.
* **`container_memory_needed()` omits the replication terms** (~5 GiB), so it will approve
  a `THREAD_COUNT` on a 56Gi shard that the manifest budget refuses. Two tests pin the
  discrepancy; the formula has not been changed, because changing it would move a number
  operators have already sized against.
* **Promotion extends an answer's life to 24 hours when nothing bumps the generation.**
  For a graph the platform owns this is exact: every write bumps it. For a graph written
  to from outside, the generation moves when the change is *noticed* — a
  `POST /aggregation/data-sources/{id}/source-changed` signal from the loader, or the next
  drift check. The drift check now honours the schedule ([§3.1](#31-the-drift-check-stopped-scanning-every-graph-three-times-a-minute)),
  so on a daily source that window is up to a day, where the 15-minute TTL used to re-read
  within fifteen minutes regardless. **Loaders that write FalkorDB directly should call
  `source-changed`** — that is what it is for, and it converges everything else too (stale
  marker, content caches, rebuild). Where that is not possible, lower
  `GRAPH_CACHE_LKG_TTL_S` for the deployment rather than setting
  `GRAPH_CACHE_PROMOTE_UNCHANGED=0`, which also gives up the promotion on graphs we do own.
