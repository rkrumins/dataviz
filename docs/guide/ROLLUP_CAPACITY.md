# Rollup Capacity & Large Graphs

*For Administrators.* Every rebuild of rolled-up lineage writes into the graph
store, and a graph store shard that fills up refuses writes for **every** graph
on it. This page explains how {brand} measures that room before it writes,
where you can see the measurement, which limits you set and where, and what to
do when a rebuild says the rollups **would not fit**.

---

## What the write budget measures

A FalkorDB graph lives entirely on **one shard** — a cluster spreads graphs
across shards, it never splits one. So the question a rebuild has to answer
is not "does the cluster have room" but "does *this graph's* shard have room".

Before it writes, a rebuild reads the memory in use and the memory limit
(`maxmemory`) on the shard that owns the graph, and allows the write only while
the **new** rollup edges fit under a reserve:

> free for rollups = maxmemory − reserve − memory in use − what other running rebuilds hold
> edges that fit = free for rollups ÷ bytes per rollup edge

Four things follow from that:

- **Only growth is charged.** Edges the graph already holds are rewritten in
  place; they cost nothing new.
- **Adding memory to a shard is enough.** Raise its `maxmemory` and the very
  next rebuild sees the room. No setting in {brand} has to move.
- **The reading is fresh every time** — before the rebuild starts, after it has
  computed the result, before each overflow wave, and every million edges
  written during the apply — so a shard that fills up while a long rebuild is
  running is caught as a loud, resumable refusal rather than as an outage.
- **Two rebuilds cannot both pass on the same headroom.** A rebuild that has
  been allowed to write enters what it still has to land in its node's
  reservation ledger, and every other rebuild's budget takes that off the free
  memory as if it were already in use — until the writes land and the reading
  shows them, or the job ends. The capacity card and a refusal both name what
  is held and by how many rebuilds.

A shard with no `maxmemory` configured cannot be measured. There the rebuild
falls back to a static edge cap and its message says so; set `maxmemory` on
the node to let the budget read real headroom.

---

## Where to see it

**Ingestion → Freshness → Graph store capacity.** One row per shard: a meter of
memory in use with the reserve marked on it, what is free after the reserve
(and what running rebuilds already hold), how many more rollup edges that is,
and the sources whose rollups live there.
Click a source to open its drawer. A shard that cannot be measured says why. A
red **would not fit** count filters the table to the sources whose last rebuild
was refused. **Re-measure** takes a fresh reading.

**A source's drawer → Capacity.** This source's footprint (edges × bytes per
edge, measured by its last rebuild or the planning figure until then), its
shard's headroom, what the last rebuild decided to store, and a pre-flight:
whether **Full detail** would fit today, and what **Auto** would store.

**Job History → Re-trigger.** The same pre-flight at the top of the dialog,
re-decided as you change Rollup storage, the reserve, bytes per edge or the
ceiling in the form — so you know before the job is queued.

**Admin → Infrastructure → Memory headroom.** Every measurable node, always,
with the rollup reserve marked and what still fits.

---

## The limits, and where they are set

Every rebuild resolves its settings in this order: **the job's own overrides →
the source's Rollup storage override → the fleet Defaults → the environment.**

| Limit | What it does | Where |
| --- | --- | --- |
| **Shard memory reserve** | Share of a shard's `maxmemory` a rebuild must leave free — for live queries and every other graph on that shard. Default 20%. | Defaults dialog, or per job in Advanced tuning |
| **Bytes per rollup edge** | What one stored edge is assumed to cost when free memory is turned into an edge count. Each successful rebuild **measures** the real figure for its graph and uses it next time; set this only to pin the estimate by hand. Default 512 B. | Defaults dialog, or per job |
| **Edge ceiling** | An *optional* explicit cap on the total edges a graph may store, layered over the measured budget. Leave it empty — the shard governs. Set it only to hold a graph below what its shard could take. | Defaults dialog, or per job |
| **Rollup storage** | **Auto** stores full detail while it fits and the depth-diagonal otherwise, deriving finer granularities on demand: slower drills on the largest graphs, but it never fails. **Full detail** pre-creates every combination and is refused, before anything is written, when it cannot fit. | Automation modal (fleet), a source's drawer (this source), Re-trigger (this run) |
| **Memory flush** | The share of the rebuild worker's own memory limit at which the pipeline writes the pairs it holds to the graph early and frees them — however many there are — so a graph that produces more pairs than the worker can hold flushes instead of being OOM-killed. Default 60%. Needs the worker's cgroup limit to be readable and at least the deployment's minimum pairs in memory. | Defaults dialog (fleet) |
| **Scan floor** | The narrowest scan slice a rebuild descends to under the graph store's per-query pressure before it concludes that one row is too large. Default 1 row: the rebuild narrows all the way. | Defaults dialog, or per job |
| **Scan timeout / Write timeout** | How long one read scan, or one write or delete batch, may run before the store aborts it. Capped by the store's own `TIMEOUT_MAX`, read from the node — the editors say so, and an administrator can raise the cap from Infrastructure. | Defaults dialog, or per job; raisable on a running job |
| **Graph store limits** | The store's own per-query time cap (`TIMEOUT_MAX`) and memory ceiling (`QUERY_MEM_CAPACITY`), set on the node at runtime and guarded by the container sizing rule. | Infrastructure → Memory headroom → *Adjust graph store limits* (system administrators) |
| **Stall window** | How long a job may make no forward progress before the watchdog kills it. The per-job *Stall timeout* wins over the fleet default; narrowed scans and backoff retries count as progress. | Defaults dialog (fleet), per job as Stall timeout; raisable on a running job |
| **Wall clock** | The longest a job may run in total, never lower than its stall window. | Defaults dialog, or per job; raisable on a running job |

The Defaults dialog shows every value with where it came from — **Set here**
or **Environment default** — and, as you edit the reserve or bytes per edge,
restates how many more rollup edges each measured shard would take **before**
you save. Three figures are set by the deployment and shown for information
only: Auto's cube ceiling, the estimate margin, and how often the apply
re-measures the shard.

> **Tip:** Nothing in the presets sets the edge ceiling, on purpose. A ceiling
> on a job wins over the measurement, so a 25,000,000 left in Defaults from an
> older version would keep every rebuild at 25 million edges however much
> memory the shards have. If a refusal names the ceiling, clear it.

---

## When a rebuild says "would not fit"

The rebuild measured the shard and refused **before writing anything**. Its
message carries the whole record: the shard, the edges and bytes needed, what
was free of what `maxmemory` after the reserve, the shortfall, and which rule
governed. In Freshness the source shows **Would not fit**, and the drawer's
guidance and Capacity block point at the ways out, in this order:

1. **Set this source's Rollup storage to Auto** in its drawer (③ Act). Auto
   stores the depth-diagonal instead of the full cube and is never refused.
   You can set it before a large source's first build.
2. **Free or add memory on that shard.** The next rebuild reads it — nothing
   else has to change.
3. **Move the graph.** A dedicated projection lands its rollups on its own
   shard.
4. **If the headroom is real**, lower the shard memory reserve or correct
   bytes per rollup edge in Defaults; or clear an explicit edge ceiling if the
   message says one governed.

A refusal is deterministic — the job is not retried — and after three failed
automatic rebuilds automation suspends the source until a person resumes it.

**A rebuild refused part-way through** (the shard filled while it was writing,
usually because another graph landed on the same shard) keeps its checkpoint:
free memory, then use **Resume from cursor** in Job History rather than
starting over. The next successful rebuild tidies any partial result.

---

## When a rebuild says a query was too large or timed out

The graph store bounds every **single query**: a per-query memory ceiling
(`QUERY_MEM_CAPACITY`, shown as *per-query limit* on the capacity card) and a
per-query time limit. Neither says anything about the dataset or the shard's
memory — the store is healthy — and a rebuild does not fail on either. It
**goes slower until every query fits**:

1. **It reads serially.** The first refusal of a run drops read concurrency
   to 1 for the rest of the run.
2. **It reads keys only.** The reconcile scan, the widest projection in the
   pipeline, switches to a two-pass strategy — a light key scan, then a
   lookup of only the keys that need comparing — instead of narrowing further.
3. **It narrows.** Scans halve down to the **scan floor** (default: one row)
   and re-grow only after sustained successes, never straight back into a
   width that failed. Writes and deletes halve their batches the same way,
   down to a single row.
4. **It waits.** A narrowest scan that keeps timing out is retried with
   backoff, heartbeating so the stall window sees the wait as progress.

Only two outcomes stop it. A **single row** larger than the per-query memory
ceiling is terminal for that rebuild: the message names the scan, the row's ID
range and the ceiling, and the fix is the ceiling — raise it from
Infrastructure (see *Adjusting the graph store's own limits* below; the
source's guidance and the re-trigger dialog link straight to it), which checks
the change against the container memory limit before it sets anything. A
narrowest scan that keeps timing out through every retry means the store is
not answering: the job fails as an outage, keeps its checkpoint, and **Resume
from cursor** continues it once the store answers.

**Where to see it.** A running job shows *Going slower to fit the graph
store* in Job History with the current width, concurrency and strategy; the
Freshness badge reads *narrowing*. Every run's **Run settings** disclosure
lists what it ran with — each value labelled *Job override*, *Fleet
default*, *Learned from last run* or *Environment* — and what it adapted to.

**Worker memory.** The worker holds pairs in its own memory while it
computes. It flushes them to the graph early when the pair cap is reached
— and, under a container memory limit, when its memory use crosses the
*Memory flush* share of that limit, whatever the count — so a graph that
produces more pairs than the worker can hold goes slower rather than being
OOM-killed. A run that flushed on memory says so in its record: *Flushed 3×
on worker memory (peak 2.9 GB of 4.0 GB)*.

**It remembers.** What a rebuild had to do is stored per source and the next
rebuild of that source starts there (never wider than its settings, so it can
only make a run more careful), re-growing during the run to probe whether the
narrowing is still needed. Tick *Ignore last run* in Advanced tuning to start
from the settings as set.

**The Gentle profile.** For a graph the store keeps refusing, the
**Gentle** profile in the re-trigger dialog — narrow scans, serial reads,
generous pacing, a longer scan timeout — starts a run the way the ladder
would end up anyway. After a per-query memory or timeout failure the
re-trigger dialog pre-selects it and says why.

**Time limits are yours to raise.** Scan and write timeouts, the stall window
and the wall clock are knobs in the Defaults dialog and per job. The two
per-query timeouts are capped by the store's `TIMEOUT_MAX` (180 s as
shipped), read from the node — the editors show the cap in force — and an
administrator raises the cap itself from Infrastructure (below). A
**running** job's limits can be raised without cancelling it — *Adjust this
run* in Job History, one job or every running job at once (*Extend all*).

**So is the scan shape.** The same disclosure offers **Go gentler**: pace the
writes (×2, ×4), read serially, halve the scans, or go back to the job's
settings — each applied from the next write, wave or scan without cancelling
the job, each a ceiling the pressure ladder may still narrow below on its
own, and each shown in the run's record as *Changed while running*. The
scan floor, the chunk sizes and rollup storage still change on the next
Resume or Re-trigger.

---

## Adjusting the graph store's own limits

Two limits belong to the graph store itself, not to a rebuild: the
**per-query time cap** (`TIMEOUT_MAX` — every scan and write timeout is
clamped to it) and the **per-query memory ceiling** (`QUERY_MEM_CAPACITY` —
the one thing a rebuild cannot narrow its way past when a single row exceeds
it). Both accept a runtime change, so a system administrator can adjust them
without a redeploy: **Infrastructure → Memory headroom**, where every node
the capacity sweep placed shows its limits (*per-query memory 512 MB · query
time cap 180 s · 4 threads*) and an **Adjust graph store limits** control. The
same dialog is one click from a failed source's guidance (*Raise the
per-query limit on …*) and from the Gentle pre-selection in the re-trigger
dialog.

What a change does, in order — and every step that can refuse, refuses before
anything is set:

1. **The node is read fresh:** memory, ceiling, cap, default and thread count.
2. **The change is checked.** A time cap is never set below the node's
   `TIMEOUT_DEFAULT`. **Raising the memory ceiling needs the container's
   memory limit** — the application cannot read it — and is refused, with the
   shortfall, when the deployment guide's sizing rule says the container
   cannot back it: `1.25 × maxmemory + concurrent × 1.3 × QUERY_MEM_CAPACITY
   + overhead` (256 MiB; 1 GiB from 32 GiB), where *concurrent* is how many
   queries may hold the ceiling at once — at most the node's `THREAD_COUNT`,
   since the ceiling is charged per thread; the guide plans for 2 when the
   rebuild is the only heavy reader. The dialog restates that figure as you
   type. `0` (unlimited) is refused; lowering needs nothing.
3. **The limits are set** on the node — or on every primary, in cluster mode
   when asked — read back and verified, and the change is logged with your
   name.
4. **Every provider on that node learns the new cap at once,** so a rebuild's
   per-query timeouts use it on their next query; the capacity views
   re-measure.

**It lasts until the store restarts.** The dialog hands you the
`FALKORDB_ARGS` fragment — for example `TIMEOUT_MAX 300000 QUERY_MEM_CAPACITY
1073741824` — to add to the deployment so the change survives a restart. Keep
`FALKORDB_SERVER_TIMEOUT_MAX_MS` in step for the time cap: it is only the
fallback the application clamps by until it has read a node, but a wrong
fallback would clamp the first queries after a restart too low. Set
`FALKORDB_CONTAINER_MEMORY_BYTES` in the deployment to prefill the container
field for every operator; otherwise the dialog remembers what you entered per
node.

---

## When the canvas says the store refused part of a read

The canvas reads rollups in pages and URN batches, and those queries are
bounded by the same two limits as a rebuild's scans. A read that meets one
no longer fails, and no longer drops what it could not fetch in silence: it
**narrows**. A refused page is halved and re-read from the same position,
down to a floor of 500 rows (`AGGREGATED_EDGE_PAGE_FLOOR`); a refused batch of
URNs is split in halves, down to a single URN; a floor-width timeout is
retried once, briefly. A read that completes after narrowing is a complete
answer and leaves no mark. Only what is still refused at the narrowest page
or batch is lost — and then the canvas says so: *The graph store refused part
of this read at its per-query memory limit — showing what it could read after
narrowing* (or *timed out on part of this read*), with *Narrow the selection,
or raise the per-query limit on the store* and, for a system administrator,
**Adjust graph store limits** straight to the node the read was bounded by.
Such a result is never cached as complete, and it never prompts the catch-up
check — the projector is not behind.

---

## Known limits

- The rebuild **worker**'s memory flush reads the worker's cgroup limit; on a
  host without one (a bare process, or a container with no memory limit) only
  the *max pending pairs* cap bounds worker memory, as before.
- **Full detail** pre-flight is *unknown* until a source has completed one
  rebuild — the estimate it needs is recorded on success.
- A single row larger than the graph store's per-query memory ceiling is
  still terminal for that rebuild; the message says exactly which row, and
  the ceiling — adjustable from Infrastructure — is the fix.
- A runtime change to the store's limits lasts until the store restarts; the
  dialog hands over the `FALKORDB_ARGS` fragment that keeps it. The
  container-memory guard trusts the figure entered (or
  `FALKORDB_CONTAINER_MEMORY_BYTES`), since the application cannot read the
  container limit. `THREAD_COUNT`, `OMP_THREAD_COUNT` and `CACHE_SIZE` remain
  load-time settings.
- The read-side ladder covers the aggregated-edges family (the canvas's
  rollup reads, on-demand pair synthesis and the raw mirror); the other reads
  — trace drills, children, top-level pages — keep their current behaviour
  under the store's limits.

Further reading: [the aggregation pipeline](/docs/aggregation-pipeline) for the
mechanism and every environment variable, [automatic
reconciliation](/docs/feature-aggregation-reconciliation) for the automation
that runs these rebuilds, and [Governance & Operations](/guide/governance-ops)
for provider health.
