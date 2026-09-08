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

> free for rollups = maxmemory − reserve − memory in use
> edges that fit = free for rollups ÷ bytes per rollup edge

Three things follow from that:

- **Only growth is charged.** Edges the graph already holds are rewritten in
  place; they cost nothing new.
- **Adding memory to a shard is enough.** Raise its `maxmemory` and the very
  next rebuild sees the room. No setting in {brand} has to move.
- **The reading is fresh every time** — before the rebuild starts, after it has
  computed the result, before each overflow wave, and every million edges
  written during the apply — so a shard that fills up while a long rebuild is
  running is caught as a loud, resumable refusal rather than as an outage.

A shard with no `maxmemory` configured cannot be measured. There the rebuild
falls back to a static edge cap and its message says so; set `maxmemory` on
the node to let the budget read real headroom.

---

## Where to see it

**Ingestion → Freshness → Graph store capacity.** One row per shard: a meter of
memory in use with the reserve marked on it, what is free after the reserve,
how many more rollup edges that is, and the sources whose rollups live there.
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

## Known limits

- The rebuild **worker** has its own memory, bounded by the *max pending pairs*
  cap rather than by measurement. A graph producing tens of millions of pairs
  can exceed the worker's memory before that cap flushes; lower the cap or give
  the worker more memory before aggregating a graph of that size.
- Two rebuilds landing on the same shard at the same time each measure the
  shard for themselves; the reserve and the re-measure during the apply bound
  the overlap, but no reservation is held between them.
- **Full detail** pre-flight is *unknown* until a source has completed one
  rebuild — the estimate it needs is recorded on success.

Further reading: [the aggregation pipeline](/docs/aggregation-pipeline) for the
mechanism and every environment variable, [automatic
reconciliation](/docs/feature-aggregation-reconciliation) for the automation
that runs these rebuilds, and [Governance & Operations](/guide/governance-ops)
for provider health.
