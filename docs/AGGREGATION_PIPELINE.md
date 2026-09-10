# Aggregation Materialization Pipeline

How `:AGGREGATED` rollup edges are computed and written to FalkorDB, and
how the system protects the graph provider while doing it. This replaces
the three legacy strategies (wipe-first bulk rebuild, epoch-swept
streaming rebuild, cursor-paged MERGE loop) with a single resumable
pipeline: **EXTRACT → COMPUTE → RECONCILE → APPLY**
(`backend/app/providers/falkordb_materialize.py`).

**Who it's for:** backend engineers working on aggregation, and operators
tuning or debugging materialization jobs on large graphs.

**What you'll find here:** the aggregation semantics and the structural
materialization boundary, the four pipeline phases, the resume model,
provider-protection controls, the full tuning knob reference, and the
completeness contract.

```mermaid
graph LR
    subgraph Extract["1 · EXTRACT (read-only)"]
        E["ID-range partition scans<br/>containment + lineage edges"]
    end
    subgraph Compute["2 · COMPUTE (pure Python)"]
        C["Ancestor-chain dict walks<br/>bottom-up pair weights<br/>(zero FalkorDB load)"]
    end
    subgraph Reconcile["3 · RECONCILE"]
        R["Range-scan current :AGGREGATED<br/>delete stale (guarded)<br/>update changed in place"]
    end
    subgraph Apply["4 · APPLY"]
        A["MERGE missing pairs<br/>sorted-key order (resume cursor)<br/>label+urn node match"]
    end

    E --> C --> R --> A
    A -.->|"crash / cancel → resume<br/>v3:{run_start}:{phase}:{pos}"| E

```

> **Note:** The pipeline is **resumable and non-destructive by design**. RECONCILE guards deletes with `latestUpdate < run_start`, and there is **no epoch sweep** — a failed or resumed run can never wipe good edges.

## Semantics

Given an ontology hierarchy (e.g. `Domain ⊃ Application ⊃ Database ⊃
Table ⊃ Column`), each lineage edge between two leaf nodes produces
`:AGGREGATED` edges for the **full cross-product of both ancestor
chains** — column→table, table→table, table→database, domain→domain, and
every other combination — weighted by the number of underlying lineage
edges and stamped with `sourceLevel`/`targetLevel` from the ontology's
entity-type levels. Containment and lineage edge types are the
ontology-resolved sets frozen onto the job row at trigger time; the
worker re-validates the ontology fingerprint before running.

**Materialization modes (FULL CUBE by default).** The shipped default
(`AGGREGATION_MATERIALIZE_FINE_PAIRS=true`) always stores the FULL CUBE:
every ancestor combination (column→table, table→table, column→domain, …)
physically exists, so every canvas granularity and expansion answers from
storage alone. That is the point of the default — boundary mode has a
caveat on SELF-NESTING types, where the on-demand reader still reasons in
ontology type levels and mixed-granularity drill answers can come back
incomplete (depth-aware on-demand reads are the tracked follow-up).

The cost is stated plainly because it is real: a FORCED cube is checked
against the WRITE BUDGET **before it starts** — the same up-front estimate
Auto runs, an upper bound with `AGGREGATION_ESTIMATE_MARGIN_PCT` of slack,
against the free memory of the shard that owns the graph — and a graph
that cannot fit is refused with nothing computed and nothing written. The
exact count is checked again after COMPUTE and before every overflow wave,
so a shard that fills up mid-run (another graph landing on it) still fails
the job loudly rather than filling the shard; that late refusal is the one
case that leaves a partial cube over the previous generation's cells,
which the next successful rebuild reconciles.

`auto` is the mode that degrades instead of failing: it ESTIMATES the full
ancestor cross-product volume up front (one counting scan: Σ ancestors(src)+1
× ancestors(tgt)+1 — a conservative upper bound), stores the cube when it fits
`AGGREGATION_MAX_CUBE_EDGES` **and** the owning shard has room for it, and
falls back to the structural boundary below otherwise, so it can never pick a
cube that exceeds the budget. `false` forces the boundary. Operators move a whole fleet between these from Ingestion →
Freshness → Automation (③ Act → Advanced) without a redeploy; a single run is
set in the trigger dialog's Rollup storage control.

**The STRUCTURAL materialization boundary (the scale contract):**
only CANONICAL DEPTH-BRIDGED pairs are materialized: a node is a
container because it HAS CONTAINMENT CHILDREN (never because of its
ontology type — a self-nesting type like ``Node ⊃ Node ⊃ Node`` rolls
up at every nesting depth), and for each raw lineage edge and each
containment DEPTH d, the pair is each side's deepest container ancestor
at depth ≤ d. On graphs whose types encode the hierarchy
(domain ⊃ table ⊃ column) depth ≡ type level and the output is
identical to the previous level-based selection. Ontology type levels
survive as the ``sourceLevel``/``targetLevel`` STAMPS the read path
filters on (omitted when a label has no mapped level). On aligned chains that is exactly the
same-level diagonal — table→table, database→database, domain→domain. On
RAGGED chains (a column hanging directly under a domain, skipping
levels) it is the mixed-level cell the canvas shows at that granularity
(table→domain) — the cell a pure level-equality filter would silently
drop. Cross-level raw lineage (a raw table→database edge) falls out of
the same rule. Each raw edge contributes at most one pair per level,
and the per-level pair sets shrink monotonically going up the hierarchy
(database→database pairs are a quotient of table→table pairs), so this
is the minimal spanning set. Everything else is computed ON DEMAND by
`get_aggregated_edges_between`:

* pairs involving LEAF nodes (column→table, column→domain,
  column→column) — raw lineage fan-out from the requested leaf nodes
  plus `*0..k` upward containment walks (these scale as edges × depth
  if materialized; observed: 1.17M edges → 5.6M pairs → FalkorDB OOM);
* MIXED-LEVEL container pairs (table→domain, domain→table) — anchored
  on the finer endpoint's materialized canonical `:AGGREGATED` cells
  (far side at-or-below the finer level: each raw edge appears in
  exactly one such cell per anchored endpoint), with the coarser
  endpoint resolved by a STRICT upward walk. The derived sum is
  therefore disjoint from any directly-materialized canonical cell for
  the same pair (whose edges resolve AT the coarser endpoint), and the
  read path ADDS the two — exact weights even on doubly-ragged graphs.
  (Materializing these instead would scale with raw-edge count × depth²
  level combinations; observed: still 2.33M pairs on the same graph
  after only the leaf cut.)

All reads are index-driven and bounded by the visible set —
milliseconds even 8 levels deep on multi-million-edge graphs. Same
answers, same response shape. Trace is unaffected: trace-at-level reads
same-level cells (still materialized) and already uses raw edges at the
finest level. The write budget fails a job loudly — terminally, no
retries, with every number a person needs in the error — rather than ever
letting a result OOM the shared instance.

**The budget is MEASURED from the shard that owns the graph.** A FalkorDB
graph key lives entirely on one node — Redis Cluster does NOT split a
graph, so sharding scales the *number* of graphs you can host, not the
size of any one, and running on a cluster gives a single large graph zero
extra headroom (`backend/app/providers/falkordb_connection.py` module
docstring). So before it writes, the pipeline reads `INFO memory` on that
one shard — the projection graph's shard in dedicated mode — through the
client it already holds, and allows the write when the NEW edges fit
under a reserve:

```
allowed_growth = (maxmemory - reserve_pct% x maxmemory - used_memory - held_by_other_rebuilds) / bytes_per_edge
```

Only growth is charged (edges the graph already holds are re-written in
place), and the reading is fresh at every check: the up-front estimate,
the exact count after COMPUTE, and each overflow wave. Adding memory to a
shard is therefore visible to the very next rebuild. The refusal names the
shard, the edges and bytes needed, what was free of what `maxmemory`, the
shortfall and the ways out, and `run_stats.write_budget` records the same
decision on success (`governed_by: shard`). Read the shard yourself with
`redis-cli -h <shard> INFO memory` — the same two numbers.

Three operator limits sit on top, resolved per-job tuning → Ingestion →
Freshness → Defaults → env, like every other knob: **`shardReservePct`**
(`AGGREGATION_SHARD_RESERVE_PCT`, 20) is how much of the shard must stay
free for live queries and every other graph on it; **`bytesPerEdge`**
(`AGGREGATION_BYTES_PER_EDGE`, 512) overrides what one edge is assumed to
cost — a planning figure until a fresh rebuild with material growth has
CALIBRATED it from the shard's own before/after usage, per graph, which
the next rebuild of that graph then uses; and **`maxMaterializedEdges`**
is an OPTIONAL explicit ceiling on the total, layered over the measured
budget for a graph you want held BELOW what its shard could take. No
preset sets it — a ceiling on the job wins over the measurement, which is
exactly how a pinned 25M made adding shard memory change nothing.

When the shard cannot be measured — no `maxmemory` configured (the five
`deploy/topologies/docker-compose.falkordb-*.yml` files), or the read
timed out — the budget degrades to the static count rule: the explicit
ceiling if set, else `AGGREGATION_MAX_MATERIALIZED_EDGES` (25M, ~12.5GB
at the default bytes/edge), and the message says that the static cap
governed and why.

Because keyslot placement is deterministic rather than load-aware, the
case to watch is two graphs landing on the same shard. Two rebuilds racing
onto one shard cannot both pass on the same headroom: a rebuild that passes
a budget check enters what it still has to write in the node's reservation
ledger (`agg:reserve:{node}` on the job-bus Redis, beside the write lease
in `admission.py` — the whole growth before the apply, one wave for an
overflow flush, the remainder at each mid-apply recheck, released with the
lease), and every other rebuild's budget subtracts it as used memory until
the writes land or the job ends. The ledger fails open like the rest of
admission. Still monitor per-shard `used_memory` and rebalance by moving a
graph, per [Infrastructure: Launch Scale](/docs/infra-launch-scale) §7.4.

Under `noeviction` a full shard fails writes for every graph on it, and
with `cluster-require-full-coverage no` the rest of the cluster keeps
serving, so that failure is partial and confusing rather than obvious —
which is why the budget refuses BEFORE the shard fills, not at the cap.

**The apply re-measures.** The post-compute check answered for the whole
result at one instant; a multi-million-edge APPLY can run for a long time
while another graph's rebuild lands on the same shard. Every
`AGGREGATION_BUDGET_RECHECK_EDGES` first-touch edges written, the pipeline
re-reads the shard and refuses — with the numbers, and with "mid-apply
recheck" in the message — when the REMAINDER would not fit. The refusal
comes after the chunk's checkpoint, so the job can be resumed from its
cursor once memory is freed; `run_stats.budget_rechecks` counts them.

**Rollup storage per source.** A source can be pinned to Auto (or Full
detail) on its own, from the drawer's ③ Act, before its first build if need
be; the override is resolved into the job's frozen tuning at trigger time,
so automation and manual rebuilds honour it alike and a per-job request
still wins. The freshness row and doc carry the resolved value and where it
came from (`rollupStorageOverride` / `resolvedRollupStorage` /
`rollupStorageSource`).

### The capacity API

What the budget measures, for people: `GET /api/v1/admin/aggregation/capacity`
lists EVERY master of every graph store — with or without sources on it — and
places each aggregated source on one by hashing its rollup key (the projection
graph in dedicated mode). Per node: used, `maxmemory`, the reserve, what
running rebuilds hold in its ledger, what is free after both, how many more
rollup edges that is at the fleet bytes-per-edge, and the sources on the
shard with their footprint and what their last run learned. `GET /api/v1/admin/data-sources/{id}/capacity`
adds the pre-flight: the pipeline's own verdict on the last run's cube
estimate against the live reading (Full detail fits / short by / unknown
until a first run; Auto is never refused). Both are ingestion-read like the
settings GET and are served in-process in every mode — they read the graph
store topology snapshot the web tier builds for itself
(`services/graph_store`, `GRAPH_STORE_TOPOLOGY_*`), so capacity dials nothing
of its own. Placement is arithmetic over that snapshot rather than a
per-source provider resolution, which is why every master now appears, the
row order never moves, and a failed refresh keeps the last good figures with
`stale`/`lastError` set instead of blanking the card. Anything that cannot be
placed is reported with a coarse reason; nothing raises; the assembly is
cached for `AGGREGATION_CAPACITY_CACHE_TTL_S`. The Freshness page's capacity
card, the drawer's Capacity block, the re-trigger fit check, the Defaults
dialog's what-if and the Infrastructure page's memory headroom all read it —
and **Admin → Graph store** is the full view behind them, with the replicas
and the graphs per shard the capacity rows do not carry. `AGGREGATION_MATERIALIZE_FINE_PAIRS=
true` restores the legacy full cube (budget-guarded); jobs without an
ontology level map — or with a SINGLE-LEVEL map (no container types) —
fall back to it automatically. An empty graph completes as a clean
no-op; a non-empty graph whose labels match no non-leaf ontology label
fails terminally (`MaterializationPreconditionFailed`, no retry burn)
instead of wiping. Coverage is verified by an exhaustive cross-product
matrix test (`test_full_cross_product_matrix_six_levels`): every
source-level × target-level combination on a 6-level hierarchy answers
exactly from canonical cells + on-demand derivation.

**Storage-regime gate.** The mixed-level derivation is exact ONLY
against canonical cells — run against a legacy/fine full cube it would
double-count every mixed weight. The pipeline stamps the regime
(`{graph}:agg:regime` = `boundary`/`fine`) into Redis on completion;
the reader gates the derivation on it, falling back to a cached graph
probe for non-conforming rows (NULL `aggKey`/`sourceLevel`). Unknown or
legacy state degrades to stored-only mixed answers (the original
behavior) — so the post-upgrade transition window and the fine-pairs
escape hatch can never inflate weights; they heal at the first
boundary-mode run. Incremental writers stay canonical too: the
versioning projector derives the same canonical selection from the
ontology level map (level-stamped, digest-stamped), and the write hook
alias-translates observed label spellings before level lookup. The
delete hook mirrors the write hook (shared chain/level resolution and
canonical selection) and only ever DECREMENTS: a pair is touched only
when SREM proves this edge's id was tracked in its `agg_members` set,
via the `AGGREGATED(aggKey)` index seek (weight 0 deletes the cell).
Untracked pairs — anything only the batch pipeline wrote, or after a
Redis flush — are deliberately left for the next reconcile; the old
SCARD-based overwrite/empty-set-delete could destroy pipeline-computed
cells (one raw deletion collapsing a 12,000-weight rollup).

Endpoints whose label is OUTSIDE the ontology (messy ingests) are
served as raw anchors (exact edges + upward rollups) rather than
dropped. Residual known gap: a mapped→unmapped pair whose raw edge
lands strictly BELOW the unmapped node is not derivable without
enumerating the unmapped subtree.

## Phases

1. **EXTRACT** (read-only): containment and lineage edges are scanned
   with fixed **ID-range partitions** (`WHERE ID(r) >= lo AND ID(r) <
   hi`, no ORDER BY/LIMIT) — tens of queries per edge type instead of the
   legacy thousands of sorted re-scans (which were O(E²) end-to-end and
   the main reason multi-million-edge graphs took hours).
2. **COMPUTE** (pure Python, zero FalkorDB load): ancestor chains are
   dict walks over the extracted child→parent map; pair weights are
   aggregated bottom-up through the ancestor lattice. Deterministic —
   a crashed run just recomputes (minutes). Memory is bounded by
   `AGGREGATION_MAX_PENDING_PAIRS` and, under a cgroup limit, by the
   memory-aware flush (`AGGREGATION_FLUSH_MEM_PCT` of the limit, once
   `AGGREGATION_FLUSH_MIN_PAIRS` are pending); either triggers an early
   flush with first-touch-overwrite semantics that keeps weights exact.
3. **RECONCILE**: the current `:AGGREGATED` set is range-scanned once;
   stale edges are deleted precisely (guarded by `latestUpdate <
   run_start`, so edges written during the run — by overflow flushes, a
   prior attempt, or `on_lineage_edge_written` — are never deleted),
   changed edges are updated in place. There is **no epoch sweep**: a
   failed or resumed run can never wipe good edges.
4. **APPLY**: missing pairs are MERGE-created in sorted-key order
   (deterministic resume cursor), with nodes matched by **label+urn**
   (per-label URN index seek) in both projection modes.

> **Caution: no ID-equality under UNWIND.** FalkorDB does not drive
> ``WHERE ID(n) = x`` from a NodeByIdSeek inside an UNWIND — it scans all
> nodes per row (observed: 30s+ per 5k-row batch on a 500k-node graph,
> producing a timeout/quiesce/retry loop). The pipeline therefore resolves
> node IDs → (urn, label) through a lazily-built, range-scanned **node
> directory** (one bounded pass; only loaded when a write/delete actually
> needs it), writes via label+urn MERGE, and deletes via the aggKey edge
> index. Internal IDs are used only in range predicates
> (``ID(x) >= lo AND ID(x) < hi``), which are cheap filters.

In steady state a re-run after small source changes writes only the
diff — near-zero load. Full recompute *is* the incremental strategy.

## Resume

The job cursor is `v3:{run_start_ms}:{phase}:{pos}` and is persisted from
the **first checkpoint**, before any graph work. Resume rules:

* `aggregate` phase (or a legacy/garbage cursor): restart from zero —
  cheap by design. Legacy `v2:` cursors from in-flight jobs at upgrade
  time resume as clean fresh runs **without wiping** existing edges; the
  first RECONCILE also cleans up any stale generations left by the old
  epoch machinery.
* `reconcile`: EXTRACT+COMPUTE re-run (deterministic), then the scan
  continues from its recorded range lower bound.
* `apply`: EXTRACT+COMPUTE and the full RECONCILE re-run; the rebuilt
  `existing` set already excludes everything the prior attempt wrote, so
  apply writes exactly the still-missing pairs. The recorded position is
  progress display only — fast-forwarding past it would skip pairs that
  are new since the crashed attempt. All writes are idempotent.

## Provider protection

* **Server-side query kill**: every deploy manifest now sets
  `TIMEOUT_MAX` (FalkorDB ignores per-query timeouts on *write* queries
  without it), `TIMEOUT_DEFAULT`, `MAX_QUEUED_QUERIES`,
  `QUERY_MEM_CAPACITY` (overridable as `FALKORDB_QUERY_MEM_CAPACITY`; size
  it WITH the container limit, never alone), and — critically —
  `OMP_THREAD_COUNT 1`
  (unbounded per-query OpenMP threads on a big node under a small cgroup
  quota were the main cause of the 150% CPU spikes). `TIMEOUT_MAX` and
  `QUERY_MEM_CAPACITY` can also be changed at runtime from Infrastructure →
  Memory headroom (`services/aggregation/graph_store_limits.py`: read,
  validate against the container formula, `GRAPH.CONFIG SET`, verify, tell
  the providers) — until the next restart. See
  `docs/FALKORDB_DEPLOYMENT.md` for sizing rules.
* **Distributed admission control**
  (`backend/app/services/aggregation/admission.py`, on the job-bus
  Redis): a per-graph write lease (one materializing job per graph across
  all pods) and a per-endpoint write-slot semaphore
  (`FALKORDB_ENDPOINT_WRITE_SLOTS`, default 2) so an HPA-scaled worker
  fleet cannot stampede one FalkorDB, and a per-node reservation ledger
  (`agg:reserve:{node}`: what each running rebuild has been allowed to
  write but the node's `used_memory` does not show yet, subtracted from
  every other rebuild's write budget so two rebuilds cannot both pass on
  the same headroom). Fails **open** to the per-process limits if Redis
  is down.
* **Pacing**: every write sub-batch is AIMD-sized (shrinks on latency
  creep) and followed by `duration × AGGREGATION_WRITE_PACING_RATIO`
  sleep (default 1.0 → ≤ ~50% write duty cycle), on top of the existing
  per-process write semaphore and latency-quiesce circuit. The ratio is a
  sleep multiplier, so RAISING it slows the job down and LOWERING it
  speeds it up — 0.5 → ≤ ~66%, 0.25 → ≤ ~80%, 0 → no sleep at all.
* **Progress-aware watchdog** (worker): a job is killed only when it
  makes no forward progress for `AGGREGATION_STALL_TIMEOUT_SECS`
  (default 10800 — 3h, the same window every UI trigger path sends
  explicitly as `timeoutSecs`) or exceeds `AGGREGATION_JOB_MAX_WALL_SECS`
  (default 86400). The old fixed 2-hour kill (which terminated healthy
  3-hour jobs mid-flight) is gone; `job.timeout_secs` overrides the stall
  window per job. The default matters because only the MACHINE paths leave
  that column NULL — reconciliation drift and first builds, the cron drift
  sweep, the stale-marker reconciler, Refresh rollups, the projector heal
  hook — so at 900 they were the only rebuilds being killed for going
  quiet, on exactly the graphs large enough to do it. Both windows are
  re-read from the job row while it runs (`PATCH …/jobs/{id}/limits`), so
  an operator can give a running job more time without cancelling it.
* **The pressure ladder**: every per-query refusal the graph store can
  make — the memory ceiling (`QUERY_MEM_CAPACITY`) and the per-query
  timeout, whether the client deadline or the server's own *Query timed
  out* — is absorbed by reading less per query: the first event of a run
  pins wave concurrency to 1; a RECONCILE scan switches to the keys-only
  two-pass strategy under `AGGREGATION_RECONCILE_KEYS_ONLY_WIDTH`; the
  sticky scan width halves down to `AGGREGATION_SCAN_SHRINK_FLOOR` (default
  one row) and re-grows after sustained successes, never straight back into
  a width that failed; write and delete batches halve the same way. At the
  narrowest width a timeout is retried with backoff and heartbeats
  (`AGGREGATION_SCAN_TIMEOUT_RETRIES`) and only then raised as
  `MaterializationScanTimedOut` — a `TimeoutError` the worker treats as an
  outage (resumable from the checkpoint); a memory refusal on a single row
  is the one terminal outcome. What a run learned is persisted per source
  (`data_source_state.observed_tuning`) and seeds the next run's ladder
  where it is stricter than the knobs (`ignoreObserved` opts out).

### Replication backpressure, outage holds, and failing-over reads

Three behaviours keep a rebuild from taking a shard down, and keep users from
seeing it as an outage when a node is replaced anyway.

- **The replica gate.** After every apply/delete batch the pipeline asks the
  master how many replicas have acknowledged (`WAIT replicaAckMin
  replicaAckTimeoutMs`). Acknowledged: the wait time joins the write's latency,
  so a replica-bound shard shrinks batches and paces itself exactly like a slow
  master. Not acknowledged: the run HOLDS — heartbeating, re-reading
  replication state, retrying — bounded only by the job's stall window, and
  releasable live by setting `replicaAckMin` to 0. A master with no replicas
  attached never waits. The run records `replica_waits`, `replica_wait_s`,
  `replica_holds` and `replica_max_lag_bytes`, and warns at the start when a
  master has replicas and an `EFFECTS_THRESHOLD` above 0 (see
  `FALKORDB_DEPLOYMENT.md` §5aa — that is the setting that decides whether a
  replica applies a change log or re-runs your whole batch).
- **The outage hold.** A refused connection is not pressure: narrowing a query
  does not help a node that is not there. Any connection fault inside the
  ladder becomes a wait — heartbeat, backoff, re-resolve the owner (which finds
  a promoted replica), then the SAME operation at the SAME width from the same
  checkpoint — bounded by `AGGREGATION_STORE_OUTAGE_HOLD_S`. Past that the run
  fails with `MaterializationStoreUnreachable`, whose message names the node,
  how long it waited and what to check; the worker reports it as
  `reason: "connection"` and the job resumes from its checkpoint.
- **Failing-over reads.** When a cluster node stops answering, the provider
  reports `ProviderFailingOver` — a logical exception the circuit breaker never
  counts, so a routine pod rotation can no longer answer every user with
  "Circuit open" for a reset window. A read gives up after one topology
  re-resolve (and for the next couple of seconds is answered from a short memo
  without dialling the dead address, so a hundred concurrent readers cost one
  socket); the API maps it to 503 `PROVIDER_FAILING_OVER` with `Retry-After: 3`
  and the endpoint; the canvas serves its last good document with
  `staleReason: "failing_over"` behind a "Reconnecting" line and retries
  itself. Writes still spend the whole failover window, because the rebuild is
  the one caller that should keep trying.

## Tuning

Resolution order per knob: **job `tuning` (frozen at trigger) → the
source's Rollup storage override (`rollup_storage` on its state row, set
from the drawer's ③ Act; the one per-source knob) → stored global defaults
(`GET/PUT /api/v1/admin/aggregation/settings`, editable in the Defaults
dialog, which shows every knob's live env default and where each value
came from) → env var → code default.** Per-job
overrides ride the trigger/resume APIs (`tuning` object with camelCase
fields mirroring the env vars below plus `extractConcurrency`); the
control plane freezes the merged dict onto the job row so workers stay
stateless. `batch_size` is deprecated (accepted, ignored by the
pipeline).

| Env var | Default | Meaning |
|---|---|---|
| `AGGREGATION_SCAN_RANGE_WIDTH` | 200000 | Edge-ID range width per scan query. Cappable live on a running job (Job History → Adjust this run → Halve scans) |
| `AGGREGATION_MAX_PENDING_PAIRS` | 50000000 | In-memory pair cap before overflow flush — the flush-free ceiling, not the memory wall |
| `AGGREGATION_FLUSH_MEM_PCT` | 60 | Memory-aware flush: share of the worker's cgroup memory limit at which the accumulator (and the extract base map) flushes early, whatever the count (30-90). Defaults as `flushMemPct`. Fail-open when RSS or the limit cannot be read |
| `AGGREGATION_FLUSH_MIN_PAIRS` | 100000 | Pairs the accumulator must hold before a memory-aware flush fires (10k-50M) |
| `AGGREGATION_APPLY_CHUNK` | 20000 | Keys resolved+written per apply chunk |
| `AGGREGATION_DELETE_CHUNK` | 10000 | Stale edges deleted per query |
| `AGGREGATION_WRITE_PACING_RATIO` | 1.0 | Sleep-after-write ratio — HIGHER is gentler and slower (1.0 → ≤ ~50% duty cycle); 0 disables pacing. Changeable live on a running job (Pace ×2 / ×4), from the next write |
| `FALKORDB_SCAN_RANGE_TIMEOUT` | 30 | Per-scan-query budget (s). Per-job / Defaults as `scanTimeoutS` (5-600); the server caps any query at its `TIMEOUT_MAX`, read from the node (`FALKORDB_SERVER_TIMEOUT_MAX_MS` is the fallback until then; raisable at runtime from Infrastructure → Memory headroom). Raisable on a running job |
| `FALKORDB_BULK_CREATE_TIMEOUT_S` | 60 | Per-query budget for the pipeline's write and delete batches (s). Per-job / Defaults as `writeTimeoutS` (5-600), capped by the server like the scan budget. Raisable on a running job |
| `AGGREGATION_SCAN_SHRINK_FLOOR` | 1 | Narrowest range width the pressure ladder descends to. Per-job / Defaults as `scanShrinkFloor`. At 1 the only terminal outcome is a single row larger than `QUERY_MEM_CAPACITY`; a floor-width timeout is retried with backoff and then reported as an outage (resumable) |
| `AGGREGATION_SCAN_TIMEOUT_RETRIES` | 6 | Backoff retries (2s, 4s … 60s + jitter, heartbeating between) a floor-width scan gets before the run raises `MaterializationScanTimedOut` (0-20) |
| `AGGREGATION_RECONCILE_KEYS_ONLY_WIDTH` | 5000 | Width at or below which a RECONCILE scan under pressure switches to the keys-only two-pass strategy instead of halving (1-5M) |
| `AGGREGATION_MATERIALIZE_LEAF_PAIRS` | false | Restore leaf↔leaf mirror pairs (legacy mode only) |
| `AGGREGATION_MATERIALIZE_FINE_PAIRS` | true | Rollup storage. `true` (shipped default) always stores the full cube — leaf-involving and mixed-level pairs included — and FAILS above the write budget; `auto` picks cube-vs-boundary by estimate and degrades instead; `false` forces the boundary. Per-job as `materializeFinePairs`, fleet-wide from Ingestion → Freshness → Automation (③ Act → Advanced) |
| `AGGREGATION_SHARD_RESERVE_PCT` | 20 | Write budget: share of the owning shard's `maxmemory` a rebuild must leave free. New rollup edges are allowed while they fit under it (0-90). Per-job / Defaults as `shardReservePct` |
| `AGGREGATION_BYTES_PER_EDGE` | 512 | Write budget: bytes one stored `:AGGREGATED` edge is assumed to cost until a fresh rebuild has calibrated the figure for that graph (64-16384). Per-job / Defaults as `bytesPerEdge`, which also overrides the calibrated value |
| `AGGREGATION_ESTIMATE_MARGIN_PCT` | 25 | Write budget: slack applied to the pre-write UPPER-BOUND estimate (and to the static cap) so a loose estimate does not refuse a cube the exact post-compute check would pass (0-100). Fleet-wide from Defaults as `estimateMarginPct` |
| `AGGREGATION_MAX_MATERIALIZED_EDGES` | 25000000 | Static edge cap, in force ONLY when the owning shard cannot be measured (no `maxmemory`, or the `INFO` read failed). Per-job / Defaults as `maxMaterializedEdges` it is instead an optional explicit ceiling layered over the measured budget; no preset sets it. Bound 500M |
| `AGGREGATION_MAX_CUBE_EDGES` | 8000000 | Ceiling on the AUTO-mode full-cube estimate (10k-50M). Deliberately separate from the write budget: sharing them meant raising the backstop silently turned `auto` into full-cube. Fleet-wide from Defaults as `maxCubeEdges` (the run warns when it sits above an explicit edge ceiling); not per-job |
| `AGGREGATION_BUDGET_RECHECK_EDGES` | 1000000 | Write budget: how many first-touch edges APPLY writes between re-reads of the owning shard. A shard that fills up mid-run (another graph landing on it) is refused loudly after a checkpoint — resumable from the cursor — instead of at its cap (100k-100M) |
| `AGGREGATION_CAPACITY_CACHE_TTL_S` | 10 | Capacity API: how long one fleet sweep is served to every viewer before the next |
| `GRAPH_STORE_TOPOLOGY_CACHE_TTL_S` | 30 | How long one reading of every node is served to every viewer (and to the capacity API) before the next |
| `GRAPH_STORE_TOPOLOGY_DEADLINE_S` | 8 | Deadline for reading all nodes concurrently; a node not read in time is reported as unreachable with that reason, never dropped |
| `AGGREGATION_REPLICA_ACK_MIN` | 1 | Replicas of the write node that must acknowledge each rollup batch before the next is sent (0-5). 0 disables the gate. Per-job / Defaults as `replicaAckMin`, and raisable or clearable on a RUNNING job |
| `AGGREGATION_REPLICA_ACK_TIMEOUT_MS` | 5000 | How long one acknowledgement wait may block before the run holds, re-reads replication state and retries (500-60000). Per-job / Defaults as `replicaAckTimeoutMs` |
| `AGGREGATION_STORE_OUTAGE_HOLD_S` | 900 | How long one run waits out a graph store node that is not answering before giving up and keeping its checkpoint (30-7200) |
| `AGGREGATION_CAPACITY_MAX_SOURCES` | 500 | Capacity API: sources per sweep, largest first; the response says when it was truncated |
| `FALKORDB_ENDPOINT_WRITE_SLOTS` | 2 | Cross-pod write budget per endpoint |
| `AGGREGATION_EXTRACT_CONCURRENCY` | 1 | Concurrent read-only range scans (waves). Cappable live on a running job (Serial reads), from the next wave |
| `AGGREGATION_STALL_TIMEOUT_SECS` | 10800 | Watchdog stall window. The job's `timeoutSecs` wins; a job that sends none (the machine paths: reconciliation, Refresh rollups, the projector heal hook) takes the fleet Defaults' `stallTimeoutSecs`, then this. Bound 7 days. Keep below `2 × AGGREGATION_JOB_TIMEOUT_SECS`. Raisable on a running job |
| `AGGREGATION_JOB_MAX_WALL_SECS` | 86400 | Watchdog wall-clock safety net; per-job / Defaults as `maxWallSecs` (1h-7d), never lower than the job's stall window. Raisable on a running job |
| `AGGREGATION_MEM_HIGH_WATER_PCT` | 75 | Worker defers new claims above this RSS/limit % |
| `AGGREGATION_LARGE_JOB_EDGE_THRESHOLD` | 500000 | Edge count classifying a job as "large" |
| `AGGREGATION_MAX_LARGE_JOBS_PER_WORKER` | 1 | Large jobs one worker may hold concurrently |
| `AGGREGATION_PENDING_NO_WORKER_SECS` | 900 | Reconciler fails pending rows this old when NO worker is registered (worker-less config detector) |
| `AGGREGATION_PENDING_TIMEOUT_SECS` | 21600 | Reconciler backstop for pending rows never picked up (lost dispatch) |

## Worker fleet

Each worker heartbeats a TTL'd registry entry (`agg:worker:{id}` on the
job-bus Redis) with its active jobs, large-job count, RSS vs cgroup
limit, and drain state. `GET /api/v1/admin/aggregation/workers` returns
the fleet plus job-stream depth (the right signal for queue-based HPA);
the workspace aggregation dashboard renders it as the Workers panel.
Before executing a delivered job, a worker applies the **memory-aware
claim policy** — draining, RSS above the high-water mark, or a second
"large" job (estimated edges over the threshold) are deferred by
re-enqueueing the job for an idle sibling, so one pod's big jobs can
never OOM-stack while another idles. SIGTERM flips drain (no new
claims; running jobs checkpoint and hand over via exec-lock expiry).
Every job records `worker_id` and a `run_stats` document: at the first
checkpoint, `effective_tuning` (every knob's value and its source — `job`,
`hint`, `env` — plus the stall window, wall clock and retries) and, as the
ladder engages, `adapted` (current and narrowest scan width, shrinks, the
concurrency and reconcile strategy in force, write batch / delete chunk,
timeout retries, the last pressure events, `from_last_run`); on success the
per-phase durations, writes/deletes, the write budget, `query_mem_capacity`
and the final `adapted` are merged over it. Job History's *Run settings*
disclosure renders it for every status; the `adapted` scalars also ride the
live progress events (`adapted_*`).

Memory budget per large job at 2M nodes / 5M edges: child→parent map
~200MB + accumulator ~250MB + ID cache ~125MB ≈ under 1GB; worker pods
ship with a 4Gi limit. This is WORKER memory, not graph memory — it is
unaffected by FalkorDB's topology. Note the accumulator is bounded by the
PAIRS a graph actually produces, not by `AGGREGATION_MAX_PENDING_PAIRS` —
the cap is only the early-flush trigger. At the 50M default the cap is far
above the 4Gi budget (~50M pairs is ~5GB packed), so on its own it would
not fire before the pod's memory limit did; the memory-aware flush
(`AGGREGATION_FLUSH_MEM_PCT`) is what fires first under a cgroup limit,
at 60% of it by default. The high cap is deliberate for graphs in the
low-millions of pairs, where flushing costs write round-trips and buys
nothing; lower it (or raise the worker limit) before aggregating a graph
expected to exceed ~30M pairs.

## Hardening wave (2026-07-10): what changed, why, and the impact

**12. Type-level boundary broke self-nesting graphs (2026-07-11,
live).** The canonical selection keyed on ontology TYPE levels, so any
type nesting under itself (``Node ⊃ Node`` — folders, systems,
components) made every intermediate container a "leaf": a live
two-type graph with 246 Node→Node containments materialized only 9
Roots→Roots cells and Context View showed no aggregated lineage below
the roots. The boundary is now STRUCTURAL (containment parents, ranked
by depth) across all three writers — pipeline, write/delete hooks,
versioning projector — with type levels kept as stamps. The old
label-mismatch precondition guard became obsolete (unmapped labels now
aggregate fine) and was replaced by a sharper one: declared containment
types matching ZERO edges while rollup cells exist fails loudly
instead of wiping them.


A full audit of this pipeline (old implementation vs the rewrite, plus
every integration edge) confirmed the EXTRACT→COMPUTE→RECONCILE→APPLY
core sound and found a ring of defects around it that kept production
failing. Each fix below records the SYMPTOM it removes, the root cause,
and the operational impact. All are covered by unit tests that failed
before the fix, plus the live suite (see Validation).

**1. Automatic re-aggregation was dead (trigger sources).** After every
purge — which deletes ALL `:AGGREGATED` edges — the promised rebuild
500'd against the jobs-table CHECK constraint (`post_purge` wasn't an
allowed `trigger_source`); the read-path backfill's `auto` died the
same way, silently. Container-level lineage stayed blank until someone
manually re-aggregated. Both values are now first-class
(`TRIGGER_SOURCES` in `models.py` builds the constraint; migration
`20260711_1200_agg_job_guards`), unknown sources 422 instead of 500,
and caller-minted `purge` rows are rejected (they mark the purge
lifecycle itself and are excluded from recovery). *Impact: purge and
empty-read backfill heal without operator action.*

**2. Crash recovery existed only in the monolith (topology).** The
lock-aware reconciler (exec-lock absent ⇒ auto-resume from
`last_cursor`) never started in the split topology: the dedicated
control plane didn't run it, and workers ACK stream messages BEFORE
executing by design. A worker crash mid-job sat `running` until the
scheduler's ~4h sweep marked it FAILED — the reported "jobs keep
breaking and I resume manually". The control plane now runs the
reconciler (advisory-lock guarded for replicas), the scheduler's
mark-failed sweep stands down whenever the job bus is available, and
the fallback sweep excludes purge rows (their progress is Redis-only,
so every >4h purge was being hijacked to failed). *Impact: worker
death → automatic resume from the last checkpoint in ~90s (lock TTL +
sweep interval), capped at 5 attempts; zero manual resumes for
transient crashes; purges can run long safely.*

**3. The load path used the banned scan-per-row pattern — with no
timeouts.** The versioning projector matched every edge endpoint with
unlabeled `MATCH (a {urn})` under UNWIND — a full node scan per row,
for EVERY edge of a full seed — as did its rollup upserts and deletes
(`MATCH ()-[r {id}]->()` was untyped and unindexed), and no projector
query carried a timeout, so the fleet's new `TIMEOUT_DEFAULT 30000`
killed big seed batches mid-load. All node lookups are now label+urn
index seeks (labels resolved from committed `entityType`s), edge
deletes are typed and endpoint-anchored, and every query carries
`PROJECTION_FALKOR_{WRITE,READ}_TIMEOUT_S`. The same fix on
`save_custom_graph`'s bulk path measured **~2000× (17min → 4s per 100k
edges)**. The lint test now scans `projection.py` and catches the
f-string brace form that had let `save_custom_graph` evade it.
*Impact: seeds and incremental projections scale as E·log N instead of
N·E, and a degraded write is killed by the server instead of outliving
the client.*

**4. The lineage-delete hook could destroy pipeline-written cells
(data loss).** `on_lineage_edge_deleted` overwrote `r.weight` from a
Redis SCARD — an accounting system the batch pipeline never populates —
and DELETED any pair whose members-set was empty, i.e. every
batch-written cell (the observed "12,000 → 1" class). It also built the
full ancestor cross-product instead of the canonical selection. It now
mirrors the write hook (shared chain/level resolution + canonical
pairs) and only ever DECREMENTS, gated on SREM proving this edge's
tracked contribution, via the `AGGREGATED(aggKey)` index seek; weight 0
deletes the cell in the same query. Untracked pairs are left for the
next reconcile. *Impact: a raw-edge deletion can never collapse or
delete a rollup it didn't contribute to; worst case is a briefly
stale-high weight that the next run reconciles.*

**5. One slow — or one oversized — range scan failed the whole run.**
Scan timeouts are deliberately never retried at the connection layer (a
slow query must not be multiplied), so a briefly-busy server or one dense
ID range sent a multi-hour job back through worker retry into a full
EXTRACT re-run. `_fetch_range` now halves the failing range down to
`AGGREGATION_SCAN_SHRINK_FLOOR` (sticky for the rest of the run,
re-growing after sustained health). *Impact: multi-hour jobs absorb
transient provider slowness instead of restarting; a partial scan is
never silently treated as complete.*

Two later findings changed the ladder's shape. First, the timeout arm was
effectively dead in production: every query goes out with a server
`TIMEOUT` 500 ms under the client budget, so a slow scan is aborted by the
SERVER and arrives as a `ResponseError("Query timed out")`, which the
ladder — listening for `asyncio.TimeoutError` only — re-raised; the real
signal escaped to the worker's generic retry and restarted the run from
its cursor. `_is_query_timeout_error` now matches it beside the memory
matcher. Second, halving alone was the wrong lever for RECONCILE: its
11-column projection is ~10× heavier per row than EXTRACT's two integers,
so under pressure it now switches to a keys-only two-pass strategy (pass 1
reads `ID(a), ID(b), ID(r), aggKey, latestUpdate`; pass 2 seeks the
comparison columns by `aggKey` for exactly the desired, not-yet-flushed
keys), the first event of a run pins wave concurrency to 1, the floor
defaults to one row, and a floor-width timeout is retried with backoff
before it is declared an outage. Writes and deletes halve their batches
under the same signals. Only a single row over the ceiling is terminal.

The same ladder now also catches the server's PER-QUERY memory refusal
(`QUERY_MEM_CAPACITY`: *"Query's mem consumption exceeded capacity"*).
That signal used to escape it entirely — the `except` was
`asyncio.TimeoutError` only — so the job failed, the circuit breaker
relabelled it `ProviderUnavailable`, and the worker retried the IDENTICAL
query three times: exactly enough failures to open the breaker for every
reader of that provider, while the UI told the operator the graph store
was offline. It is shrinkable because FalkorDB buffers a query's whole
result set inside the tracked budget (it does not stream), so the bytes
scale linearly with rows returned; at floor width it raises
`MaterializationQueryMemoryExceeded` — a `ValueError`, hence
breaker-ignored and terminal — carrying the scan label, the range, the
width and the ordered fixes. Exposure is very uneven across the four
scan shapes: RECONCILE projects 11 columns including `aggKey` (two
concatenated URNs) and the `sourceEdgeTypes` array, while EXTRACT returns
two integers at the same range width — so the full-cube regime, which
multiplies RECONCILE's row count, is what brings a graph within reach of
the ceiling. A run that survived by degrading reports `scan_width_min`
and `scan_shrinks` in `run_stats` (and, since the ladder's rework, the
full `adapted` record). *Impact: growing past the per-query ceiling costs
a slower run, not a failed job — and never a breaker trip.*

**6. Apply-resume could skip pairs (completeness).** The apply-phase
cursor fast-forward bisected past every key ≤ the recorded position —
including pairs NEW since the crashed attempt that happened to sort
before it. RECONCILE re-runs fully on resume and already excludes
everything the prior attempt wrote, so the bisect was a redundant
optimization with a correctness hole; it is removed and the recorded
position is progress display only. *Impact: resume is exactly
complete — proven live by resuming past every computed key.*

**7. Keyed deletes could run as full scans (index readiness).**
FalkorDB builds indexes in the background; nothing waited for
`AGGREGATED(aggKey)` readiness, so a first run against a large existing
set executed every keyed delete as a full relation scan. The reconcile
phase now polls `db.indexes()` (bounded 60s, version-tolerant,
WARN-and-proceed — an optimization gate, never a correctness one).

**8. Case-sensitivity could silently skip whole types (completeness).**
FalkorDB matching is case-sensitive and the alias map was the only
spelling seam — a casing present in the graph but absent from the map
scanned zero edges, and worker-run jobs inject no entity aliases at
all. The pipeline now probes `db.relationshipTypes()`/`db.labels()`
once per run and unions case-fold variants for every declared spelling
(including graphs holding SEVERAL casings of one type, where
half-scanned containment breaks ancestor chains); a declared type that
matches NOTHING observed warns loudly instead of aggregating nothing in
silence. *Impact: onboarded graphs aggregate correctly whether or not
their casing matches the ontology, and vocabulary mismatches are
diagnosable from the job log.*

**9. Idempotency-key reuse 500'd.** `ix_agg_jobs_idem_active` was
unique forever despite its name while the replay window is 60 minutes,
so a key reused later collided with a completed row's tombstone. The
index now covers only ACTIVE rows (same migration as #1) and a
concurrent-trigger race replays the winner's job instead of surfacing
an IntegrityError.

**10. Unbounded read sorts, then silent truncation.** The
`get_aggregated_edges_between` main queries carried `ORDER BY
r.weight DESC` with no LIMIT — every 5k-urn batch materialized and
sorted its full match set server-side before Python truncated. Putting
`AGGREGATED_EDGE_RESULT_CAP` in the Cypher bounded that work but made
the cap the *answer size*: anything past 100k rows was dropped, and
because `weight` is a COUNT, ties are pervasive and the cut landed
mid-tie-group — with delete-on-oversize (a >1MiB payload is never
cached, so every open re-runs the query) a large model could render a
*different* arbitrary lineage subset each time it was opened.

The read now **pages to completeness**: the LIMIT is a page size
(`AGGREGATED_EDGE_PAGE_SIZE`, default 50k) and the reader walks a
keyset over the total order `coalesce(r.weight, 0) DESC, sUrn, tUrn`
until a short page arrives. `coalesce`, not a bare `r.weight`, because
a null weight compares as null against every integer — a bare column
would strand null-weight cells after page 1 permanently. `(sUrn, tUrn)`
is what makes a mid-tie boundary exact; the materializer keys cells by
pair, so that triple is a unique total order.
`AGGREGATED_EDGE_RESULT_CAP` (default raised to 1M) is now only a
runaway guard: tripping it logs at WARNING and flags `truncated=true`,
and a failure mid-paging keeps the correct prefix while flagging
`degraded`/`stale` so a partial is never cached as complete.
*Verified against FalkorDB v4.18.11: 2452 cells over 5 pages returned
2452 distinct pairs, zero gaps or overlaps, across mid-tie boundaries
and null-weight rows.*

The on-demand synth queries in the same file still use the cap as a
plain LIMIT — their RETURNs aggregate (`collect(DISTINCT type(r))`),
the shape where FalkorDB silently discards `ORDER BY`, so they need a
separate redesign before they can page.

**11. The instance itself had no memory ceiling.** `QUERY_MEM_CAPACITY`
bounds one query; nothing bounded the dataset, so graph growth still
OOM-killed the pod — the incident class the write budget guards
against, from the OS side. Every manifest now passes `REDIS_ARGS`
`--maxmemory` (75% of the container limit; `FALKORDB_MAXMEMORY` in
compose) with `noeviction`, verified against `falkordb/falkordb:v4.16.0`.
*Impact: two-layer protection — the write budget fails a job loudly
before writing an oversized result, and maxmemory fails writes loudly
if anything else grows the instance — the pod is never OOM-killed into
a LOADING/replay cycle.*

**Completeness contract (what the caps do and do NOT do).** No cap in
this pipeline silently drops aggregations: EXTRACT tiles the full ID
space (a floor-width timeout fails the run rather than passing a
partial scan off as complete); the pending-pairs cap is a flush
trigger with exact weight semantics; the write budget fails terminally
and loudly with a per-level composition breakdown and the shard's own
numbers (it reads the instance's headroom itself; the reserve and
bytes-per-edge are the tunable parts); endpoints deleted mid-run are dropped
WITH a warning and recomputed next run; read-path caps are response
top-N contracts over complete stored data. The live suite pins the
observable contract: exact cells/weights/level stamps under mixed
casing, exact deltas on re-run, zero-touch no-op runs, and complete
apply after resume.

## Removed (release notes)

* `AGGREGATION_BULK_REBUILD_ENABLED` / `AGGREGATION_STREAMING_REBUILD_ENABLED`
  env flags and all three legacy strategies. Rollback = version rollback.
* The `aggEpoch` edge property is no longer written and its index is no
  longer created; stale epochs are cleaned by the first RECONCILE.
* Job phase IDs changed to `extracting / computing / reconciling /
  applying` (UI label map updated; unknown phases degrade to a generic
  label, so mixed-version windows are safe).
* `AGGREGATION_JOB_TIMEOUT_SECS` no longer bounds a running job (the
  control-plane scheduler still uses it as a stale-row backstop).

## Validation

`backend/scripts/benchmark_aggregation_scan.py` seeds a synthetic graph
into a live FalkorDB and verifies the pipeline's benchmark-gated
assumptions: ID-range scan cost vs the legacy sorted page scan, ID-seek
MERGE vs label+urn MERGE, and that a pathological write is killed
server-side at its timeout (requires `TIMEOUT_MAX`). Unit coverage lives
in `backend/tests/test_falkordb_materialize.py` (semantics, exact
weights under overflow and cancel+resume, no-op re-runs, guarded
deletes) and `backend/tests/test_aggregation_admission.py`.
`backend/tests/integration/test_aggregation_pipeline_live.py`
(`RUN_FALKOR_LIVE=1`) proves the completeness contract on a REAL
engine: mixed-case seed → exact canonical cells/weights/level stamps,
mutate → exact diff, unchanged re-run → zero writes with `latestUpdate`
frozen, resume-mid-apply → every missing pair created, and the
`db.indexes()` shape the readiness probe parses.

**Worker-crash soak (manual):** seed 2M/5M via the benchmark script,
trigger via the UI with the worker container running, then
`docker restart` the worker mid-APPLY — the control plane's reconciler
auto-resumes from `last_cursor` (watch for "auto-resume #1"), no edge
is wiped, and the re-run converges to a zero-write diff.

---

## Related

- [Data Architecture](/docs/data-architecture) — the graph data model, aggregated-edge shape, and Redis job bus
- [Decisions](/docs/decisions) — ADR-020/021/022 (FalkorDB client, Redis roles) that underpin provider protection
- [Architecture](/docs/architecture) — where the aggregation control plane and worker fleet sit in the topology
- [Services Overview](/docs/services-overview) — the WORKER and CONTROLPLANE roles that run this pipeline
- [Technical Debt](/docs/technical-debt) — related scaling and observability gaps
