# The cluster window, and the names a graph can hold — 2026-09-15

A rebuild on the production cluster sat in Compute for ten to fifteen minutes and then
logged `Retry 1/3: UNBLOCKED force unblock from blocking operation, instance state changed
(master -> replica?)`, with `Provider ... idle for >900s - closing to reclaim its
connections` beside it. Three hours later the job failed, having re-run EXTRACT and COMPUTE
from zero each time. On a different source the job would not start at all: *"graph has
registered 65534 of the 65534 distinct property names FalkorDB allows a graph, and this
rebuild needs 9 it cannot register"*.

Those two reports have nothing to do with each other, and each was first read as the wrong
kind of problem — the first as slowness to wait out, the second as a limit to be raised.
Neither is. The first is a **budget sized against the wrong ceiling**: every write was allowed up to 600 seconds
because the server's `TIMEOUT_MAX` said so, while the *cluster* votes a silent master out
after 15. The second is an **ordering problem**: property-name ids are handed out
first-come-first-served and never freed, and nothing staked a claim on the platform's
behalf, so a source carrying ~65,000 metadata keys took every id before the first rollup
was ever written.

This documents what caused each, what changed at every layer, the values that moved, how
to roll it out, how to verify it, and what is deliberately *not* in this release.

**Several steps require operator action and will not take effect from a deploy alone** —
see [§8 Rollout](#8-rollout). In particular, one graph in production cannot be fixed by any
code in this release and has to be recreated.

Companions, each still authoritative for what it covers:

* [`AGGREGATION_PIPELINE.md`](AGGREGATION_PIPELINE.md) — the six stages, the query-budget
  derivation, the attribute-name ceiling and the recreate runbook. **The source of truth
  for the values in [§7](#7-values-that-changed).**
* [`PROPERTY_STORAGE.md`](PROPERTY_STORAGE.md) — the design that removes the ceiling
  rather than fencing it. A decision record; only its first slice is built.
* [`FALKORDB_DEPLOYMENT.md`](FALKORDB_DEPLOYMENT.md) — pod topology, `TIMEOUT_MAX`,
  `min-replicas-to-write`, the node-count rule.
* [`RELEASE_NOTES_2026-09-11_serving-views-at-scale.md`](RELEASE_NOTES_2026-09-11_serving-views-at-scale.md)
  — the previous release, whose read path and cache work this builds on.
* [`../CHANGELOG.md`](../CHANGELOG.md) — the per-change record. This document is the
  reasoning across all of them.

---

## 1. What was wrong

### 1.1 Every write budget was sized against the wrong ceiling

A rebuild's writes ran under a 60-second default, raisable to 600, and the pipeline's own
docstring explained why 600 was safe: *"the server clamps every query at its own
`TIMEOUT_MAX` anyway"*. That is true, and it is the right reasoning for a standalone
instance.

In cluster mode there are **two** limits and they mean different things:

| Limit | Bounds | Shipped value |
|---|---|---|
| `TIMEOUT_MAX` | how long **this server** will let a query run | 120,000 ms |
| `--cluster-node-timeout` | how long the **other masters** wait before voting this one out | 15,000 ms |

The binding constraint is the second, and it is eight times smaller. FalkorDB runs `GRAPH.*`
on a module thread pool and **blocks the client** for the query's duration, so a long write
is a blocked client in Redis's own sense — and Redis force-unblocks a blocked client when
the instance changes role. A write allowed to approach the failure-detector window races
the election and loses about as often as it wins: the replica is promoted, this master is
demoted part-way through the batch, and every blocked client gets
`-UNBLOCKED force unblock from blocking operation, instance state changed (master ->
replica?)` with **no pod having restarted**.

The two shipped numbers made this near-certain, and a 600-second write budget against a
15-second detector is not a slow query — it is a guaranteed failover under load.

### 1.2 The client did not know how long a failover takes

Everything the client does about a failover — how long a write waits out a demotion, the
`Retry-After` handed to a caller, the worker's failover park — derives from
`FALKORDB_CLUSTER_NODE_TIMEOUT_MS`. Nothing read it off the server, and it was set
**nowhere**: not in `viz-config`, not in the worker deployment, not in the cluster overlay.
So the client used its 3-second fallback while the shards ran `--cluster-node-timeout
15000`. Every compliant client went away and came back before the cluster had begun to
promote anything, and a rebuild spent all ten of its failover parks inside the window in
which there was never going to be an answer.

Worse, the branch that *handles* a demotion was itself too short to reach one: it retried
three times **with no wait at all**, never reading the backoff schedule its own cap came
from, then raised the raw error — so all three attempts landed on the same demoted node,
and the raw error spent a job retry. A retry re-runs EXTRACT and COMPUTE from zero, and the
attempt budget only resets when `processed_edges` passes its high-water mark, which a
from-zero re-run never does. One routine shard rotation became three hours of repeated work
and then a failed job.

And there was no redis-py class for `-UNBLOCKED`. It arrives as a bare `ResponseError`, and
`_is_role_changed_error` matched only on class **name** — so the one branch that fixes a
demotion in under a second was skipped for exactly the case it exists for.

### 1.3 The provider was reaped out from under a running job

`PROVIDER_CACHE_IDLE_TTL_SECS` defaults to 900 — which is where both the log line and the
fifteen minutes came from. "Idle" was measured from `_last_used`, stamped when a provider is
**checked out** and nowhere else, and a worker checks out once per job. So a run longer than
the TTL read as untouched since minute zero. `inflight_ops()` did not save it: that answers
"busy this instant", and **Compute is the one stage that issues no graph I/O at all** — it
is dict merges and set work over what EXTRACT already read. The provider has nothing in
flight for its whole duration, which is exactly what both this defect and §1.2 needed to
bite.

### 1.4 The graph ran out of property names, and the platform's names were not among them

FalkorDB numbers property names with a **16-bit id per graph**
(`typedef uint16_t AttributeID`, with `USHRT_MAX` and `USHRT_MAX-1` reserved), giving
**65,534** usable names, and it never frees one: ids are minted in
`GraphContext_FindOrAddAttribute`, the only removal is the undo-log rollback of a failed
query, and the RDB encoder saves every attribute key. Only `GRAPH.DELETE` discards the map —
a purge of the rollups frees nothing.

Since the native-fields change, both writers turned **every distinct user property key**
into one of those names, so search could see it. A source whose nodes carry thousands of
per-node metadata keys spent a 241k-node graph's entire id space on keys that appear once.
After that no rollup could be written and no index created, and the graph could only be
recreated.

The question that mattered was not "why did the rollups fail when the raw data landed
fine?" The raw data did not land *fine while* the rollups failed. **It landed first and took
every id.** Whoever writes first wins, permanently.

And nothing staked a claim on the platform's behalf. `ensure_indices` would register five of
the nine rollup names as a side effect of its edge-index DDL — but it is dispatched
fire-and-forget, so a bulk loader racing it wins, and its failures are collected and
swallowed by contract. All nine names missing in production is the evidence that it lost
that race.

### 1.5 Reconcile scanned the whole cube under the write lock

A rebuild on a graph holding 7.8M rollup edges sat in Reconcile until the master was
demoted. The `AGGREGATED(aggKey)` index was still building — FalkorDB populates indexes in
the background, and a graph read back off disk rebuilds every index the same way — and the
readiness wait gave up after sixty seconds and **proceeded anyway**. Every keyed delete was
then a full pass over the cube under the write lock, which is precisely what the cluster's
failure detector reads as a dead node.

### 1.6 A missing replica had the same answer as a sick one

A rebuild harms replication in two ways, neither of which needs a replica to be *away*: it
outruns one that is attached (`replica_lag`), or it writes through the fork that streams one
back. **Absence** had the same answer as both — hold, then fail the run when the hold
outlived its budget.

The shipped cluster overlay is 3 shards × (1 master + 1 replica). Every node drain, rolling
upgrade and OOM kill therefore took out the only replica a shard had, and every rebuild on
that shard held and then died with `MaterializationStoreUnstable`. The hold could not buy
what it claimed: a partial resync needs the master's backlog to still hold every byte
written while the replica was away — megabytes — and a rebuild writes past that in seconds.
**Every absence longer than a blip ends in a full resync whatever the run did meanwhile.**

### 1.7 Smaller things that cost a run or a page

* **The index DDL storm.** `ensure_indices` issues one `CREATE INDEX` per (label, property)
  pair — 128 for a twenty-type ontology — on the interactive read path. When the **node**
  refused rather than the statement (no in-sync replica, a dataset still loading, a shard
  mid-failover), all 128 failed, the success memo was never written, and the next cache miss
  ran the whole set again. It called `self._graph.query` directly, so the semaphore, the
  breaker and the admission controller applied to none of it, and nothing serialised
  concurrent readers.
* **Versioning reads were write-flagged.** `-NOREPLICAS Not enough good replicas to write`
  is a per-command refusal, and `GRAPH.QUERY` is write-flagged whatever the Cypher inside it
  says. `projection._q` only ever called `client.query`, so every reconcile count, the
  bootstrap copy's reads and `/graph/neighbors` — all pure `MATCH`/`RETURN` — were refused
  alongside the writes during an hour-long node restart, and the raw text reached the UI.
* **Cancel was not noticed during Compute.** Every other `_cancel_check` site sits on a
  query, and Compute issues none, so a Cancel was not seen until the stage *ended* — on a
  large cube, fifteen minutes of the UI showing a job the operator had already stopped, with
  the clock running.
* **A full-cube rebuild was sized for the wrong resource.** The accumulator is one dict
  entry per **distinct** rollup cell at roughly 100 bytes, and the cube grows as
  edges × depth², so a few million cells costs over a gigabyte. The memory-aware flush
  bounds that — *inside* the merge loops. The end of a run builds a second full copy of the
  key set to report and reconcile what it wrote, where no flush can fire, so the peak is not
  the flush line. At a 4Gi limit that peak OOM-killed the pod, losing the whole extract and
  compute.
* **Re-trigger could not reproduce a run that worked.** The dialog opens on configured
  defaults on purpose (replaying frozen tuning is how a graph that failed under bad settings
  kept failing under them) — but a run dialled in by hand then had to be re-entered knob by
  knob from a screenshot.

---

## 2. What changed — the cluster window

### 2.1 Every query budget derives from the failure detector

`cluster_query_ceiling_s()` returns **40% of the cluster's node timeout**, leaving the rest
of the window for the rollback, the reply and the pings that keep the node a master. At the
shipped 15,000 ms that is a **6-second ceiling on any single query**, with a 2-second floor.

`clamp_query_budget()` applies it at the boundary, so every query is bounded whoever set the
timeout: the pipeline's write batches, the bulk loader's, a `writeTimeoutS` raised on a
running job. **An operator cannot raise past it**, because a write that outlives the window
costs the shard its master and with it every other reader of that shard. A batch that needs
longer is aborted by the server, halved by the pressure ladder and re-issued — an ordinary
in-run retry where it used to be a failover.

It is applied in four places, which together cover every path that reaches a shard:

| Boundary | Covers |
|---|---|
| `FalkorDBProvider._query` | every write: pipeline batches, bulk loader, index DDL |
| `FalkorDBProvider._read_query` | every read, including EXTRACT's range scans |
| `FalkorDBProvider._proj_query` | the projection path |
| `versioning/projection._q` | the projector, which talks to the client directly and so never passed the provider boundary at all |

**Reads are clamped too, and the reason is not a write lock they do not take.**
`-UNBLOCKED` reaches whichever client is blocked when the role changes, so every second a
long read is in flight is a second in which a demotion caused by anything else surfaces as
this run's failure — and a long read still holds a module thread on a node whose main thread
has to keep answering the cluster bus. The scan ladder already narrows on a timeout, so the
clamp engages behaviour the pipeline has rather than introducing a new failure mode.

That also closes the Compute stage, which is the stage that was failing. Compute both reads
and writes: `_extract_and_compute` delegates to `_rollup_base`, which calls
`_maybe_overflow_flush`, which writes through the paced path whenever the pair cap or the
memory guard trips. A test now pins that call chain, because the chain is what makes the
clamp reach the phase — and an earlier version of that test asserted on the wrong function
and passed for the wrong reason.

### 2.2 The window is read from the node, not from an env var

A safety limit that disappears when a variable is missing is not a safety limit. The window
now comes from three sources, most authoritative first:

1. **What a node reported about itself.** Each provider reads `CONFIG GET
   cluster-node-timeout` from the node, beside the existing server-limit read and off the
   request path. The node cannot be wrong about its own configuration. The **smallest**
   window any node reports is kept, because the clamp has to hold for every shard the
   process talks to.
2. **The `FALKORDB_CLUSTER_NODE_TIMEOUT_MS` env mirror**, until a node answers.
3. **An assumed 15 s** when `FALKORDB_MODE` says cluster and neither has answered —
   announced once at `WARNING`, naming the value and the ceiling it implies.

No clamp at all now applies **only** to a standalone or sentinel deployment, where the
budget genuinely has no cluster to outlive.

The cluster overlay also declares `FALKORDB_CLUSTER_NODE_TIMEOUT_MS: "15000"`, and a test
parses the shard StatefulSets' own `--cluster-node-timeout` argument and fails if the two
disagree. That ConfigMap exists for values the application cannot read for itself; this one
it now can, and the declaration is the mirror that covers the gap before the first
`CONFIG GET` lands.

### 2.3 A demotion is waited out, not retried into

* `-UNBLOCKED` is matched **by message**, like `-LOADING` and `-NOREPLICAS`, on the verb
  alone so it stays narrow — nothing here issues `CLIENT UNBLOCK`.
* A **write** that meets a demotion now waits on the same ladder a refused connection gets —
  17.5 s in cluster mode, which is what `_retry_wall_clock` already budgets a write for. When
  that is spent it raises `ProviderFailingOver`, so the job **parks with its checkpoint**
  instead of spending a retry that would re-run EXTRACT and COMPUTE from zero.
* A **read** keeps the short path deliberately: `_retry_wall_clock` sizes its headroom off
  `read_only` and budgets a read for the transient window only, so an escalated ladder there
  would be cut short by the deadline and surface as `asyncio.TimeoutError`, which nothing
  reads as a failover. One re-resolve, then say what it is.
* The retry log carries the traceback and the exception type. `str(e)` alone is why a bare
  `ResponseError` could not be attributed to a call site at all.
* The idle reaper takes the **later** of the checkout stamp and the provider's last completed
  operation, and the worker ConfigMap raises `PROVIDER_CACHE_IDLE_TTL_SECS` to 7200. The code
  fix alone would not cover a Compute that exceeds the TTL with no graph ops at all; the
  config does. The web tier keeps 900 — it touches many sources briefly and wants the sockets
  back.

---

## 3. What changed — property names

### 3.1 The platform stakes its names before ingest can take them

Both writers now **reserve every platform-owned name before their first data write**. The
mechanism is the property that causes the problem: a name is registered by being written and
is never freed, so writing every platform name once and deleting the carrier reserves them
for the life of the graph.

* One `:_PropReserve` carrier node carries all of them and is deleted in the same pass.
  Labels and relationship types have their own id spaces, so the label costs no attribute id,
  and no node persists.
* The attribute map is **shared between node and edge properties**, so a node reserves the
  rollup *edge* names too.
* Durability is the engine's, not an assumption: ids are minted in
  `GraphContext_FindOrAddAttribute`, the only removal is the undo-log rollback of a failed
  query, and the RDB encoder serialises all attribute keys — so the reservation survives node
  deletion, restart and reload.
* **No latch.** The caller passes what the graph has registered and the reserve no-ops when
  that already covers the platform. A graph a full seed `DROP`ped, or one recreated out of
  band, reads back without them and is reserved again; a transient failure is retried on the
  next write rather than latched to a provider instance.

The reserve is the **union of four sets, 38 names**: the rollup-edge names (`aggKey`,
`weight`, `sourceEdgeTypes`, `sourceLevel`, `targetLevel`, `sourceDepth`, `targetDepth`,
`levelDigest`, `latestUpdate`, plus `urn` for dedicated projection mode), the `_AggMeta`
stamp names, the reserved node keys the read path depends on (`entityType`, `displayName`,
`qualifiedName`, `propertiesRaw`, `searchableText` and the rest), and four the review pass
found had no copy anywhere and were staked by nothing — `confidence`, `gvSeq`, `seq` and
`purgedAt`: the versioning projector's own rollup stamps, the raw edge confidence and the
purge stamp. Those last four are the identical failure shape, written long after a load has
spent the ids and covered by no pre-flight.

### 3.2 The pre-flight asks the one question that decides it

The first version refused any graph within a fixed 500-name margin of the ceiling —
including a graph that **already holds rollups written by this pipeline**, where every name
the run writes is registered and the rebuild would complete.

The pre-flight now reads the registered names and asks only: *can this graph register the
names this run must write?* Room is the ceiling less the count; the run refuses **only** when
the missing names outnumber the room, naming them and the room. A graph at the ceiling that
can still be rebuilt carries an `attribute_names_exhausted` advisory on its record instead,
saying how much room is left and whether the `_AggMeta` stamp can land. A drift test pins the
hand-kept name sets to the Cypher the pipeline actually issues and to the declared edge
indexes.

`attribute_limit` is a typed failure category — terminal, unresumable, with drawer guidance
and a fleet facet — and the store refusing a name mid-run (the index DDL, a rollup write) is
classified the same way instead of entering the pressure ladder. It is registered as a
**logical exception**: as a bare `RuntimeError` the circuit breaker counted it, so three
ingest attempts into a full graph would have opened the breaker and taken the data source
offline for reads, which work perfectly well on such a graph.

The usable ceiling is **65,534** names (ids 0..65,533), not 65,533; the constant and every
mention of it are corrected.

### 3.3 The budget bounds what data keys can take

`FALKORDB_NATIVE_PROPERTY_BUDGET` is how many distinct names one graph may hold natively.
Each write call reads the graph's registered names (`CALL db.propertyKeys()`, on the write
node) and admits its keys against what is left: a registered name stays native (a key's
storage form must never flip on a node once chosen), the source's identity and name
properties and the name fallbacks the read path checks are always native, and the rest are
admitted by **how many nodes carry them** until the budget is full.

The same rule runs in `save_custom_graph`, `create_node` and the versioning projector's apply
pass, so a direct-load graph and a versioned graph spend their ids the same way — and **the
graph itself is the only counter**, which makes a recreate correct by construction. A writer
that demotes keys says so once per call.

**The default goes from 8,000 to 50,000.** With the platform's names reserved, the budget no
longer protects the platform; its only remaining job is to stop a graph becoming
un-ingestable. A registered name on few nodes costs almost nothing — attribute sets are sized
by *present* attributes, not registered names — which makes a generous default strictly safer
than a tight one.

A graph store whose sources carry unusually wide key sets can set `nativePropertyBudget` on
its **provider** config, and both writers spend it instead of the fleet env.
**Not per data source**, which is where the first attempt put it: a data source is a lower
privilege than provider config, and every name the budget admits is permanent, so a
data-source-level setting would let that role pin a graph to a hundred names and make nearly
every key on it unsearchable for good. Both merge paths drop a data source's attempt to set
it, with the same guard and reasoning as `cacheConnection`. An unreadable value falls back to
the shipped default rather than to the clamp floor, because a typo that silently pins a graph
at a hundred names is the failure this prevents, not causes.

### 3.4 What a demoted key actually does — corrected

A key past the budget is **not** "silently dropped", and this was stated wrongly in code and
in two documents. It is stored as a value in `propertiesRaw` and **shown in the Properties
panel**; it is unreachable only by search, sort and predicates. The engine does not drop a
name either — it *refuses the write*. Both are now stated correctly everywhere.

### 3.5 The count is visible

The capacity card and chip show the attribute count from the last completed rebuild
(`N of 65,534 property names`); the drawer's technical block gains a **Property names** row;
`attribute_limit` has its own failure label ("Out of property names"), guidance and fleet
facet. The drawer guidance names the two recreate paths — **Data health → Rebuild** for a
versioned source, and `GRAPH.DELETE` + the loader + `signal_data_changed` for a direct load —
instead of Purge, which frees no name.

---

## 4. What changed — the rebuild pipeline

### 4.1 Reconcile waits for the index instead of scanning without it

Reconcile now asks `db.indexes()` what state the `aggKey` index is in. Above **100,000**
existing rollup edges it waits — and an absent index stops the run the same way a
still-building one does, with `MaterializationStoreUnstable` and the checkpoint kept, rather
than scanning. A small cube keeps the old behaviour of proceeding after a sixty-second wait.
The wait heartbeats, and `run_stats.index_wait_s` records it.

The budget for that wait is **what is left of the job's wall clock**, never less than one
hold. Waiting is always cheaper than the scan it replaces, the index builds at the provider's
pace, and a 20M-edge cube on a slow indexer is still a cube the provider can hold — so the
only bound worth having is the one the operator set for the whole job.

**A regression the clamp made reachable, and how it was caught.** `_count_aggregated`
answered `0` when the count did not return, documented as conservative because the write
budget then charges every cell as growth. The index gate reads the same number, and for it
`0` means "small cube, scanning is fine" — so an unknown count **disabled the gate**. That is
not hypothetical: counting twenty million relationships is itself a long query, it is longest
on exactly the graphs the gate protects, and the new 6-second ceiling makes it time out there
first. It now returns `None` for "did not answer": the write budget still reads that as zero
(conservative in its direction), the gate reads it as large (conservative in its own). A
genuine zero is still a reading, so a first build does not wait for an index with nothing to
build.

### 4.2 Memory is the binding constraint on a full cube

The production aggregation worker goes to **2Gi requests / 12Gi limits** (from 1Gi / 4Gi).
The nodes are highmem; this is cheap, and it raises the memory-aware flush point with it.
Raise it *before* forcing a full cube on a large source, not after.

The docs now also say what sizes a cube and what does not:

* The estimate is an upper bound on cells **produced**; every budget consumes cells
  **distinct**. A graph that compresses 50:1 estimates fifty times its real size, and
  `cell_ratio_observed` is what converts one into the other — no projection is worth acting
  on before a run has produced one.
* `maxCubeEdges` is **inert for a forced cube**: the forced branch returns before the ceiling
  is read.
* The estimator's `_anc_count` is a sum over parents, not a set union, so on a DAG it counts
  shared ancestors once per path and runs several times over the real cube.
* Leaf closures are memoised only to 400,000 nodes, past which they are re-walked per edge —
  a long compute that no flush, budget or hold catches, because it is neither memory nor I/O.
* `FALKORDB_CLUSTER_NODE_TIMEOUT_MS` is **none of these**. There is no value of it that makes
  a cube succeed or fail.

### 4.3 Cancel is noticed during Compute

Both merge loops already yielded every 1024 / 4096 pairs and simply never asked. They ask
now; the check reads a flag, and at that cadence it is free. It is also the one place a lost
write lease reaches the run.

### 4.4 An absent replica gets a grace, not a hold

Absence now gets a **five-minute grace**, after which the run carries on without it and
records `replicas_forgone`. Three things keep that honest:

* The grace is judged on how long the replicas have been **missing**, never on the age of
  the hold. An episode can begin as lag: a run holding twenty minutes for a replica that is
  *behind* would otherwise arrive at the grace already past it and forgive an absence it had
  watched for one turn — which is the incident, not a drain.
* Replicas fully back **re-arm** it. Forgiving one drain at minute ten must not leave the
  next four hours unprotected.
* An absence that follows this run pushing a replica half way to the limit the master drops
  it at is the rebuild's own doing and is **not forgiven at all** — it keeps the full bound
  and stops the run, exactly as before.

The resync itself is unchanged and is what makes the rest safe: a replica coming back appears
in `INFO replication` with a non-online state, which is a fork, and no knob waves a fork
through. `_hold_max_for` goes with it — `replica_lost` was its only exception, and the
exception existed solely so a rotation would not kill the run.

---

## 5. What changed — the read path and the operator's view

* **Versioning reads go out as `GRAPH.RO_QUERY`.** `_q` grows a `read_only` flag and the read
  call sites pass it. This is **not** a routing change: redis-py auto-routes only the commands
  in its own read table and no `GRAPH.*` command is in it, so these still go to the primary
  that owns the key and still read what the writes beside them just wrote. Two things stay
  write-flagged, each pinned by a test — the projector's pre-drop `RETURN 1` probe (only a
  write-flagged command proves the node will take the `DROP` that follows) and the bootstrap's
  phase-1 count (`GRAPH.QUERY` instantiates the graph key while counting, which is what leaves
  the later read-only phases a graph to read). The one real behavioural gap between the
  commands is closed: a read-only call that meets `Invalid graph operation on empty key`
  re-sends the **same statement** as `GRAPH.QUERY` — not a guessed empty result, because an
  aggregate answers `[[0]]`, not `[]`, and `falkor_counts` indexes it.
* **The index DDL sweep stops at the first statement the node refuses**, writes a short-lived
  backoff key beside the existing digest so the next reader in the window pays nothing, and
  admits one sweep per pod at a time with later arrivals **skipping** rather than queuing. The
  line between "the node refused" and "this statement failed" is the one `_replica_at_fault`
  already draws: a per-query memory ceiling and a *server*-aborted deadline are deterministic
  for that statement and keep running the set; the *client* deadline defers, because
  `_clamp_db_timeout_ms` puts the server's limit below it deliberately. The deferral is a
  `WARNING` — a graph reading unindexed for an hour has to be visible to whoever is paged.
* **Re-trigger can put the last run's settings back** — as a control, not a default.
  `overridesFromRun` reads what the run actually recorded and the dialog offers it beside a
  line saying why it is not already loaded. Rollup storage comes across too, because a run
  *forced* to full detail must come back forced rather than resolved against today's default.
  The control is absent when there is nothing to put back (a job from before the self-tuning
  pipeline, or one that never reached its first checkpoint), because a control that silently
  did nothing would be worse than none.
* **A manual trigger opens on Balanced** and states the replica acknowledgement. Nothing about
  what runs changes — Balanced's knobs *are* the server's environment defaults, and a trigger
  that sent no tuning at all ran exactly this. It deliberately does not write
  `materializeFinePairs` (that would overrule a fleet that had chosen Auto) and does not seed
  through a missing settings fetch (`undefined` means the defaults have not landed, and
  seeding then would become an explicit per-job override of the very globals it agrees with).

---

## 6. The property-storage decision, and what is NOT shipped

A budget on how many keys become schema **fences** the problem; it does not remove it.
[`PROPERTY_STORAGE.md`](PROPERTY_STORAGE.md) records the design that removes it: the complete
user property bag lives in a Postgres side index (one LIST partition per physical graph, an
expression GIN over a case-folded copy) and, unchanged, in the node's `propertiesRaw` display
copy. The graph keeps topology and a **constant** set of attribute names; predicates on any
key are answered in Postgres and enter FalkorDB as per-label URN seeks. The document weighs
the four architectures a design panel produced and states the invariant, the storage layout,
the write-ordering contract, routing, the read path per capability, the exclusion hooks, the
migration modes (a graph at the ceiling flips with **zero graph writes**), the cost model at a
million nodes, what is honestly lost, the five phases, and what an operator should stop
believing.

**Phase 1 slice A is built and wired to nothing:** the `propidx` schema (Alembic revision plus
an ORM mirror that deliberately keeps its own metadata, because the parent is partitioned and
its GIN indexes an expression over the schema's own `ci()` function, so `create_all` can never
produce it), and `PostgresPropertyIndex` — identity, digest, partition-per-graph, the unnest
upsert with a content-hash skip guard, the epoch sweep, the load lifecycle, and the read side
a predicate router will use.

Three defects a review pass against a live Postgres 16 found, each of which would have shipped
silently:

1. The asyncpg dialect installs a jsonb decoder, so values arrive **already decoded**. Decoding
   them again crashed on every string-valued property and silently retyped any string that
   happened to parse as JSON. The unit doubles had encoded the wrong driver contract, so they
   agreed with the bug.
2. The landed GIN is over an **expression**, so an existence predicate written against the raw
   column cannot use it. Both read paths full-scanned the partition.
3. `physical_graph_key` recomputed the graph identity from raw config rather than resolving it
   the way the provider does, so localhost and an unset host filed rows under keys nothing
   reads back.

**Slices B and C are paused, on my recommendation**, and this is the honest part of the
release. Slice B stops the writers registering data keys; slice C routes undeclared-key
predicates through the side index. Together they are a large change to the read path, and the
evidence for needing them is currently **one source**. The reservation in [§3.1](#31-the-platform-stakes-its-names-before-ingest-can-take-them)
plus the budget in [§3.3](#33-the-budget-bounds-what-data-keys-can-take) make a graph
un-exhaustible in practice: the platform's names can no longer be taken, and a data key set
would have to exceed 50,000 distinct names on one graph to matter at all. Before building the
rest, check `db.propertyKeys()` on the other sources — if nothing else is near the ceiling,
E+ is over-engineering for a problem a recreate and a budget already solve. The design record
stands either way; it is cheaper to have written it than to re-derive it.

---

## 7. Values that changed

### 7.1 Query budgets

| Value | Was | Now | Why |
|---|---|---|---|
| Write budget ceiling | 600 s (`TIMEOUT_MAX`) | **0.4 × cluster-node-timeout** (6 s at 15,000 ms), floor 2 s | The other masters vote a silent one out long before the server abandons a query. |
| Read / scan budget ceiling | 600 s | **same derived ceiling** | `-UNBLOCKED` reaches a blocked reader too, and a long read holds a module thread. |
| Projector query budget | 60 s default, 170 s max | **same derived ceiling** | It writes rollup deltas and node batches on the same hot path; the provider boundary never saw it. |
| `FALKORDB_CLUSTER_NODE_TIMEOUT_MS` | unset everywhere (3 s fallback) | **15000**, declared in the cluster overlay and read from the node | Every failover wait, park and `Retry-After` derives from it. |
| Standalone / sentinel | unclamped | **unclamped** | No detector to lose a race against. |

> **The rule:** the operator's `writeTimeoutS` and `scanTimeoutS` still bound a query from
> above, and the derived ceiling bounds *them*. Nothing can be raised past it, on purpose.

### 7.2 Property names

| Value | Was | Now | Why |
|---|---|---|---|
| Usable attribute names | documented 65,533 | **65,534** (ids 0..65,533) | The constant was off by one; corrected everywhere. |
| `FALKORDB_NATIVE_PROPERTY_BUDGET` | — (unbounded), then 8,000 | **50,000** (clamped 100–60,000) | With the platform's names reserved the budget only has to keep a graph ingestable; a registered name on few nodes costs almost nothing. |
| Pre-flight refusal margin | fixed 500 names | **exact** — refuse only when the missing names outnumber the room | A graph holding this pipeline's own rollups was being refused a rebuild it would have completed. |
| Advisory threshold | — | **100** names of room | So a graph at the ceiling is known before the next name it cannot register turns up. |
| Platform names reserved | 0 (5 by accident, via fire-and-forget DDL) | **38** — the union of the rollup-edge names, the `_AggMeta` stamp, the reserved node keys and the projector/raw stamps | Ids are first-come and never freed; schema must be staked before data. |
| `nativePropertyBudget` override | — | **provider config only** | A data source is a lower privilege, and every admitted name is permanent. |

### 7.3 Rebuild capacity and holds

| Value | Was | Now | Why |
|---|---|---|---|
| `PROVIDER_CACHE_IDLE_TTL_SECS` (worker) | 900 (web default) | **7200** | A worker holds one provider for a whole job, and Compute is minutes with no graph I/O. |
| Aggregation worker memory (production) | 1Gi req / 4Gi limit | **2Gi / 12Gi** | The end-of-run key-set copy is the peak, and no flush fires there. |
| Index gate threshold | — | **100,000** existing rollup edges | Below it, a scan without the index is cheaper than waiting. |
| Index wait budget | 60 s, then proceed | **the rest of the job's wall clock**, floor one hold | Waiting is always cheaper than the scan it replaces. |
| Replica-absence grace | 0 (hold, then fail) | **300 s**, then carry on and record `replicas_forgone` | Every absence past a blip ends in a full resync whatever the run does. |
| `_hold_max_for` per-reason exception | `replica_lost` exempt | **one bound for every reason** | The exception existed only so a rotation would not kill the run; the grace does that now. |
| `FALKORDB_INDEX_BACKOFF_S` | — | **120** | How long one node's refusal suppresses the DDL sweep, fleet-wide. |

New `run_stats` fields: `attribute_names`, `attribute_names_room`, `index_wait_s`,
`write_timeout_s`, `replicas_forgone`.

---

## 8. Rollout

Ordered. Steps 1 and 2 are the two that **will not happen from a deploy alone**.

1. **Confirm `TIMEOUT_MAX` is configured on every shard.** FalkorDB honours a per-query
   timeout on **writes** only when `TIMEOUT_MAX` is set; without it the server keeps executing
   after the client gives up, still holding the write lock — and then the derived ceiling
   bounds only what the client waits for, not what the node does. This is the one prerequisite
   the clamp cannot check for itself.
2. **Apply the cluster ConfigMap, and check the shards agree.**
   `FALKORDB_CLUSTER_NODE_TIMEOUT_MS: "15000"` must equal the shards' own
   `--cluster-node-timeout`. A test now fails the build if the overlay and the StatefulSets
   disagree, but a hand-edited ConfigMap in a live namespace is outside its reach —
   `kubectl get configmap viz-config -o yaml` and read it. **Raise both together or neither.**
   If the deployment runs a *different* node timeout, set this to that value: the clamp is a
   share of whatever is real, not of 15,000.
3. **Apply the worker ConfigMap** for `PROVIDER_CACHE_IDLE_TTL_SECS: "7200"`. Worker only —
   do **not** add it to `viz-config`.
4. **Apply the production resource patch** for the aggregation worker's 12Gi limit, then
   confirm the node pool can still schedule it.
5. **Deploy the backend image**, then the frontend.
6. **Recreate the graph that is at the ceiling.** No code in this release can fix it: ids are
   never freed, and a purge frees none.
   * Versioned source → **Data health → Rebuild**. It drops the graph, re-seeds from the
     version store under the budget, and queues the rollups.
   * Direct load → `GRAPH.DELETE` on the shard that owns it, run the loader again, then
     `signal_data_changed`.

   The second ingest spends its ids differently *because* of the budget and the reservation,
   so the recreate is correct by construction rather than by hope. The runbook is in
   `AGGREGATION_PIPELINE.md`.
7. **Run one rebuild** on a non-critical source and watch Admin → Graph store.

Nothing in this release requires the `propidx` schema. The Alembic revision creates it; no
code imports it on any request path.

---

## 9. Verifying it worked

* **The clamp is on.** A completed run's `run_stats.write_timeout_s` reads **6.0** on the
  cluster (not 60, not 600). If it reads the configured value instead, the process has not
  established a cluster window — look for the `assuming 15s` warning, and check
  `FALKORDB_MODE`.
* **The window came from the node.** That warning should appear **once per process at most**,
  and not at all once a `CONFIG GET` has answered. Seeing it steadily means the shards are not
  answering `CONFIG GET cluster-node-timeout`.
* **A shard rotation no longer fails a run.** Drain one FalkorDB pod during a rebuild. Expect
  the run to **park** (`ProviderFailingOver`, checkpoint kept) and resume — not
  `Retry 1/3: UNBLOCKED ...`, and not a from-zero EXTRACT.
* **A long Compute no longer loses its provider.** No `idle for >900s - closing` line against
  a running job.
* **The names are staked.** On a freshly created graph, before any source data is loaded,
  `CALL db.propertyKeys()` returns the platform's names and no `:_PropReserve` node exists.
* **The pre-flight is exact.** A graph holding this pipeline's own rollups near the ceiling
  must **rebuild**, carrying an `attribute_names_exhausted` advisory — not refuse. A graph
  with genuinely no room must refuse terminally, naming the missing names and the room, and
  must **not** open the circuit breaker: reads on that source keep working.
* **The count is on screen.** The capacity block shows `N of 65,534 property names`, and the
  drawer's technical block has the Property names row.
* **Reconcile waits.** On a cube above 100,000 edges with the index still building,
  `run_stats.index_wait_s` is non-zero and the master is not demoted.
* **Suites.** Backend CI-required: `cd backend && <venv>/bin/python -m pytest -q -m "not
  integration" $(grep -vE '^\s*(#|$)' tests/ci-required-files.txt)` — **2361 passed, 3
  skipped** at the time of writing. Frontend Freshness: **262 passed / 20 files**.

---

## 10. Turning each piece off

| Piece | How to disable | What comes back |
|---|---|---|
| The derived query ceiling | Unset `FALKORDB_MODE=cluster`, or run standalone/sentinel | Budgets bounded only by `writeTimeoutS` / `scanTimeoutS` and `TIMEOUT_MAX`. **Not recommended on a cluster** — this is the failover. |
| The assumed 15 s window | Set `FALKORDB_CLUSTER_NODE_TIMEOUT_MS` to the real value | The warning stops; the clamp is measured rather than assumed. |
| The native property budget | Raise `FALKORDB_NATIVE_PROPERTY_BUDGET` (max 60,000), or set `nativePropertyBudget` on the provider | More data keys become native names. Permanent once spent. |
| The platform reservation | No knob, by design | It is 38 names on a 65,534-name budget and the run cannot complete without them. |
| The index gate | No knob | Below 100,000 edges it does not engage; above it, the alternative is the scan that demoted the master. |
| The replica-absence grace | No knob | Five minutes, then `replicas_forgone`. A run-caused absence is never forgiven. |
| Re-trigger's "use last run's settings" | Do not press it | The dialog's configured defaults, as before. |

---

## 11. Known limitations

* **One production graph is still at 65,534/65,534** and no code here fixes it. It has to be
  recreated ([§8 step 6](#8-rollout)).
* **`backend/scripts/migrate_native_properties.py` bypasses the budget.** It writes native
  properties without consulting `_admit_native_keys`, so running it on a graph near the
  ceiling can still exhaust it. Not fixed in this release.
* **`backend/tests/integration/test_property_index_live.py` runs nowhere in CI.** It needs a
  live Postgres 16 via `PROPIDX_TEST_DATABASE_URL`. It is the suite that found all three
  `property_index.py` defects, which is the argument for wiring it up.
* **`propidx` is dead weight until slices B and C land.** The schema is created and the client
  is complete and tested; nothing calls it. If the evidence says E+ is not needed, the
  revision and both modules should be removed rather than left as a half-built path.
* **The estimator still over-counts on a DAG.** `_anc_count` sums over parents instead of
  unioning, and leaf closures stop being memoised at 400,000 nodes. Both are documented; the
  fix is not in this release.
* **A pre-existing failure, unrelated to this work:**
  `tests/test_type_change_roundtrip.py::test_projector_leaves_stale_duplicate_node_on_entity_type_change`.
  It is not in `ci-required-files.txt`.

---

## 12. What was corrected while this was being built

Recorded because each correction changed a conclusion, not just a line of code.

* **"The raw data lands fine but the aggregated edges fail" was the wrong frame.** There is no
  asymmetry between the two writers. The raw data landed *first* and took every id; the
  rollups failed because they came second. That reframing is what produced the reservation in
  [§3.1](#31-the-platform-stakes-its-names-before-ingest-can-take-them) instead of another
  retry.
* **The clamp disabled the index gate I had added two commits earlier** — see
  [§4.1](#41-reconcile-waits-for-the-index-instead-of-scanning-without-it). A shared `0`
  meaning "unknown" to one caller and "empty" to another. Caught by asking what the gate reads,
  not by a test.
* **A test asserted on the wrong function and passed for the wrong reason.** It checked that
  `_extract_and_compute` calls `_maybe_overflow_flush`; the real chain goes through
  `_rollup_base`. The test now pins the actual chain, because that chain is the argument that
  the clamp reaches Compute.
* **Two proposals were refuted rather than implemented.** Replacing the apply-stage `MERGE`
  with `CREATE` is unsafe — three independent re-issue paths would produce duplicate parallel
  edges at full weight. Deferring the index creation to after the bulk load does nothing: the
  indexes come from `ensure_indices` on connect, not from the pipeline.
* **The per-source budget override was built at the wrong privilege level first**, and would
  have let a `workspace:datasource:manage` caller pin a graph to 100 native names permanently.
* **The terminal refusal was a bare `RuntimeError`**, which the circuit breaker counted.
* **"Silently drops" was wrong** in code and both documents — see
  [§3.4](#34-what-a-demoted-key-actually-does--corrected).
