# 09 · Scale, Limits & Roadmap

> **Audience & scope:** engineers and operators making production commitments. The candid state of the
> art — what's proven and measured, where the sharp edges are, what's wired-but-dormant, the known
> gaps, and the prioritized roadmap. Nothing here is aspirational marketing; every limit traces to
> code.

**Re-checked against the code on 2026-10-09 (`42cae50`); §7, §9 and §10's Stage 1–2 subsections again on 2026-10-19 (`57444bd8`); §2–§4 and §8 on 2026-10-30, at millions of entities; §2's 5M section and §10's further work on 2026-11-14, from the scale runs; §2's second 200-reader run and §9 on 2026-11-17.**

**TL;DR.** The Versioned Graph is **feature-complete and test-covered for the managed, single-node
case**. Saves, pulls, previews, reviews and publishes are `O(change)`, not `O(graph)`, and a publish,
its projection and a rebuild of millions hold a page at a time (§2). It is tested end to end up to
1,000,000 nodes and 2,000,000 edges, in every read mode. At 5,000,000 nodes and 5,000,000 edges,
the import and the publish take far longer than five times as long (§2), and §10 lists that and the
other further work the scale runs found. The remaining sharp edges are
deliberately-deferred scale items — export jobs that start over when interrupted (imports resume); no
retention inside a live graph; and a partitioning key that doesn't help a single hot collaborative
graph. Re-sync, separately, runs a bounded merge that has not been
proven on a graph the bootstrap worker wrote ([11](11-resync-at-any-scale.md)). Read this chapter
before betting a large production workload on it.

---

## 1. Design targets

From project intent: *Git-like collaborative versioning over graphs of **millions of entities** — full
per-entity history, an audit trail, ontology enforcement, **no data loss**, Postgres as source of
truth, FalkorDB a bounded cache.* Concretely:

- **Interactive edits cost `O(ops)`**, publishes/merges cost `O(changed)` — never `O(graph)`.
- **Full history + audit** retained forever (append-only) — the flip side is *no GC yet* (§5).
- **The cache is disposable** — any FalkorDB graph can be dropped and rebuilt from Postgres.

## 2. What's proven — measured wins

These were real hotspots that were fixed and measured (see [03](03-branching-commits-merge.md),
[04](04-projection-and-cache.md)):

| Win | Mechanism | Result |
|-----|-----------|--------|
| **State reconstruction** `_state_as_of` | Two-phase: a narrow `DISTINCT ON (entity_id)` over `ix_*_entity_hist` selecting only `(entity_id, id, op)`, then point-fetch payloads for **live winners only** | `O(live state)`, not `O(history)`; ~**8.6×** at 60 versions/entity; equivalence proven at every seq (`test_versioning_state_reconstruction.py`) |
| **Publish under the lock** `_kind_map_multi` | Bounded to the delta's ids via chunked `IN`-lists on the `entity_heads` PK (was a full-branch head scan) | 5-entity publish on a 200k-node graph **585ms → 29ms**; the merge advisory lock is now `O(delta)` |
| **Direct writes** `apply_ops` | Resolves + composes only affected entities | `O(ops)` |
| **Merge on the write path** `_compute_merge_bounded` | Composes only `own ∪ resolutions ∪ changed-in-window` | `O(changed)` |
| **`main` Merkle root** | Persisted copy-on-write, only changed-path rows written; unchanged subtrees inherited via the as-of index | `O(changed · depth)` for non-fork `main` |
| **Bulk inserts / large reads** | Chunked to stay under asyncpg's 32767 / Postgres' 65535 bind-param cap (`_IN_LIST_MAX=20000`) | no param-overflow crashes at scale |
| **Reconciling projection** | Stalest-first, bounded concurrency (`PROJECTION_CONCURRENCY=8`), unpinned graphs excluded from the batch | catches up across hundreds of graphs |

### Measured up to 1,000,000 nodes and 1,000,000 edges

`backend/scripts/bench_versioning.py` (one job per process, peak RSS of that process; Postgres 16 and
FalkorDB 4.18 on one 4-CPU machine). The graph is imported into a new graph's draft, published,
projected and exported; "one pass" is the same step with the paging threshold raised past it.

| Step | 100k + 100k | 300k + 300k | 1M + 1M | 300k + 300k, one pass |
|------|------------:|------------:|--------:|----------------------:|
| Import into a draft (windowed) | 117 s, 192 MB | 214 s, 198 MB | 727 s, 197 MB | — |
| Publish (paged above 200,000 changes) | 24 s, 436 MB (one batch) | 111 s, 369 MB | 367 s, 399 MB | ~1 GB, est. (1.7 KB a change) |
| Projection of the published window (paged above 100,000 rows) | 28 s, 198 MB (CI) | 112 s, 182 MB | 426 s, 206 MB | 92 s, 956 MB |
| Rebuild from nothing (paged above 100,000 entities) | 37 s, 220 MB (CI) | 84 s, 209 MB | 286 s, 216 MB | 77 s, 1,653 MB |
| Export (NDJSON, streamed) | 12 s, 154 MB | 31 s, 150 MB | 101 s, 166 MB | — |

A paged publish holds at most the Merkle fingerprint's list of changes besides its page — up to
1,000,000 entries, past which the fingerprint is left unset — so its peak stops growing there.
Everything else above is flat in the graph's size. Time is not: for 3.3 times the entities, 1M + 1M
took 3.3 to 3.4 times as long as 300k + 300k (the projection 3.8 times).

What 1M + 1M left behind: 6.1 GB of graphver in Postgres (each entity's version on the draft and on
`main`, and both branches' heads) and 2.7 GB of the import's staged rows until they are swept
([08](08-import-export.md) §3c); 1.05 GB for the graph in FalkorDB (`GRAPH.MEMORY USAGE`).

### At 1,000,000 nodes and 2,000,000 edges: a defect found, and fixed

Measured by the `versioning-scale` workflow, three times on the same runner:
- run 43606161278, on 14 November 2026;
- run 43638740082 on `c602d81`, which carried a first attempt at the fix below;
- run 43690420051 on `ee5c43f`, on 15 November, which carried the fix. Every step and every read
  mode passed.

| Step | 1M + 1M | 1M + 2M, first run | 1M + 2M, second run | 1M + 2M, on the fix |
|------|--------:|-------------------:|--------------------:|--------------------:|
| Import into a draft | 1,009 s, 487 MB | 1,508 s, 486 MB | 1,562 s, 487 MB | 1,555 s, 492 MB |
| Publish (the graph's lock held throughout) | 526 s, 396 MB | 686 s, 399 MB | 733 s, 399 MB | 714 s, 402 MB |
| Projection of the published window | 381 s, 276 MB (2 passes) | 467 s, 278 MB (2 passes) | 476 s, 290 MB (2 passes) | 475 s, 285 MB (2 passes) |
| Rebuild from nothing | 295 s, 255 MB | did not finish | did not finish | 382 s, 293 MB (2 passes) |
| Export | 86 s, 164 MB | — | — | 103 s, 167 MB |

- **Memory stayed flat**, and the import and the publish grew about as the graph did: 1.5 and 1.3
  times the time for 1.5 times the entities. The edge windows still grew within the import: the
  last tenth took 336% longer than the first (§10, Further work, item 2).
- **The rebuild found a defect in the projector.**
  - This graph's containment puts nearly every node under one root, with 500,000 children. Their
    relationships are the first 500,000 a rebuild reads, in id order. (At 1M + 1M there are
    500,000 roots and no such node.)
  - A rebuild compares every relationship FalkorDB holds with what Postgres says, looking each one
    up by its two ends. For each of the root's relationships, FalkorDB walked the root's
    children. The statements that ran out of their 30 s budget
    (`PROJECTION_FALKOR_READ_TIMEOUT_S`) shrank from 2,366 rows to 352 over the run. So a row cost
    more than 13 ms at first and more than 85 ms by the end, as the rebuild moved through the root's
    children.
  - Each such statement was halved and sent again (§10, item 8). Both runs ran out the job's
    time, 300 and 330 minutes.
  - The same lookups serve every seed from Postgres (a full seed, a reseed, a build's seed) and a
    window's deletes. On a graph with such a node, all of them would have stalled the same way.
  - The first attempt found each end in a MATCH clause of its own, before the relationship's
    (`c602d81`). The second run stalled the same way. Yet MERGE finds an edge between the same two
    ends fast: the projection wrote all 3,000,000 entities, the edges by MERGE, in 69 s of
    FalkorDB's time.
- **The fix.** A `WITH` now comes between finding the two ends and matching the relationship
  (`_between` in `projection.py`). It covers the fingerprint read, the deletes by key, by id and by
  internal id, and the lineage summaries' read and delete. Measured on FalkorDB 4.18.11 against a
  node with 200,000 children (`test_hub_lookups_live.py`, CI's live FalkorDB job):

  | Shape | FalkorDB's plan | A row from the hub | A row from a leaf |
  |-------|-----------------|-------------------:|------------------:|
  | `(a {urn})-[r]->(b {urn})`, one pattern | an index scan of `a`, then Conditional Traverse | 70.5 ms | 0.011 ms |
  | each end in a MATCH clause of its own (`c602d81`) | the same | 71.1 ms | 0.011 ms |
  | both ends, then `WITH`, then the relationship | two index scans, then Expand Into | 0.009 ms | 0.009 ms |

  - Every statement the projector sends this way costs 0.009 to 0.011 ms a row from the hub, and
    finds exactly what it should. The live test fails if a row from the hub costs over ten times
    one from a leaf (2 ms at least).
  - `test_projection_hub_lookups.py` holds every statement to that shape.
  - The web tier's read of the relationships between a few known entities
    (`_edges_between_pairs`, the relationship drawer's) had the same flaw: 61 ms a call from the
    hub. It binds its ends the same way now: 0.27 ms.
- **A hub's page of relationships.** Before it compares what main holds, a rebuild reads what
  FalkorDB holds, 20,000 source nodes at a time. The root's page held about 520,000
  relationships, read in one statement: 353 MB in Python for the rows and their keys alone, before
  their lookup in Postgres, against the rebuild's ceiling of 512 MB. Each page is now read 50,000
  relationships at a time, in internal id order (`_EDGE_SLICE`).
- **On the fix**, the rebuild landed in 382 s at 293 MB, against its 512 MB ceiling. No statement
  ran out of its budget, and FalkorDB then held exactly what Postgres holds: 1,000,000 nodes and
  2,000,000 edges. Its 2,085 FalkorDB statements took 88 s in all.
- **The read modes at this size** are in What readers get while a change lands, measured, below:
  every mode landed its change with no read failing.

### At 5,000,000 nodes and 5,000,000 edges: where the write path stops scaling

This replaces an estimate that multiplied the 1M + 1M run by five. Measured by the
`versioning-scale` workflow on 14 November 2026 (run 43577703970), on a 4-CPU, 16 GB runner with
Postgres 16 at its default settings (128 MB of shared buffers). The run stopped at its 340-minute
limit while it projected the publish. So this size has no figures for the projection, the rebuild,
the export or the read modes.

| Step | 1M + 1M | 5M + 5M | For 5 times the entities |
|------|--------:|--------:|-------------------------:|
| Import into a draft | 1,009 s, 487 MB | 7,695 s, 1,335 MB | 7.6 times the time, 2.7 times the memory |
| Publish | 526 s, 396 MB | 12,149 s, 395 MB | 23 times the time |
| The graph's publish lock, held | 525 s | 12,149 s (3 h 22 min) | 23 times |
| The runner's disk | +13 GB, every step | +47 GB, the import and the publish | |

- **The import grows faster than the graph.**
  - Each edge window took longer than the one before. At 5M the median window took 9.0 s and the
    slowest 22.7 s, and the last tenth of the windows took 168% longer than the first. At 1M the
    edge windows grew by 167% too; node windows grew by 56% at 5M.
  - Its slowest statements write and look up edge versions: `INSERT INTO graphver.edge_versions`
    (4.3 s) and the existing-edge lookup, `SELECT DISTINCT edge_versions.entity_id,
    target_entity_id` (3.9 s).
  - Its memory grows with the graph, by 110 to 135 MB per million entities: 244 MB at 100k + 100k,
    487 MB at 1M + 1M, and 1,335 MB at 5M + 5M. Its target is 600 MB.
- **The publish grows worse.**
  - Five times the changes took 23 times as long. That is close to 5 × 5, the growth of a step in
    which each page costs in proportion to the table.
  - Its slowest statement ran for about 17.7 s, repeatedly: a page's
    `SELECT DISTINCT ON (graphver.node_versions.entity_id) …`. At 1M, no statement of that kind was
    among the slowest; the slowest was an insert, at 1.15 s.
  - The whole publish is one transaction under the graph's lock. For 3 h 22 min no other publish
    or merge into that graph could land, and each answered 503 `lock_busy` after its wait. Saves
    into drafts and reads don't wait for that lock.
- **What it means today.**
  - A first import of 10 million entities takes about 2 hours, and its publish another 3.4 hours.
  - At that size the read modes don't fit in a 6-hour CI job.
  - Tested end to end: up to 1,000,000 nodes and 2,000,000 edges.
  - The causes, the leads and what done looks like are in §10, Further work found by the scale
    runs, items 1 to 3.

### Measuring at your size

CI runs the 1M + 1M graph end to end every week (`.github/workflows/versioning-scale.yml`, also on
demand at any size). It fails when a step does not complete, when its peak memory passes its ceiling
(512 MB, 1 GB for a publish), or when FalkorDB and Postgres disagree after it. To measure at your own
size, point the harness at a staging Postgres and FalkorDB sized like production
(`MANAGEMENT_DB_URL`, `FALKORDB_HOST`, `FALKORDB_PORT`) and run each step in a process of its own:

```bash
B="python -m backend.scripts.bench_versioning"
$B gen-package --nodes 5000000 --edges 5000000 --out /data/p10m.zip
$B run inspect --package /data/p10m.zip --state s.json --label inspect
$B run import --target empty --state s.json --label import
$B run publish --state s.json --label publish
$B run project --state s.json --label project
$B run project --full --state s.json --label rebuild
$B run export --state s.json --label export
$B run readmodes --nodes 5000000 --edges 5000000 --changes 100000 --state s.json --label readmodes
$B report --state s.json --md report.md
```

Watch each step's peak memory (flat in the graph's size), its time (linear), how long the publish
held the graph's publish lock, and how much Postgres and FalkorDB grew.

`run readmodes` measures what readers get while a change lands, in each read mode
([04](04-projection-and-cache.md) §5, Read modes): the published graph seeded whole into a key of its
own, then per mode (`--modes`: `latest`, `in_place`, `beside` — its new key copied — and
`beside_seed`, seeded from Postgres) a change of `--changes` version rows, a quarter new nodes and a
quarter new edges by an import job into a draft, a quarter updates and a quarter deletes in the same
draft, published Postgres first and projected while `--readers` readers in each of `--reader-procs`
processes of their own read a node and its connections by the route a read of main takes, admitted
as a web pod's reads are. Per mode it reports the time to
land, read latency percentiles and errors while the change is imported, while it lands and after, the
routes reads took and the versions they saw, FalkorDB's memory (start and peak), and whether FalkorDB
holds what Postgres does after. The `versioning-scale` workflow runs it after the steps above.
Its Postgres keeps its data on the runner's large disk, which holds a graph of 5,000,000 nodes and
edges (+47 GB). The job's time doesn't: at that size the import and the publish alone took 5.5
hours, and the job allows at most 350 minutes (`timeout_minutes`). See "At 5,000,000 nodes and
5,000,000 edges", above.

### What readers get while a change lands, measured

The `versioning-scale` workflow, on a 4-CPU, 16 GB runner (Postgres 16 and FalkorDB 4.18, no memory
limit on FalkorDB). On a graph of 1,000,000 nodes and 1,000,000 edges, each mode lands a change of
100,000 version rows (a quarter new nodes, a quarter new edges, a quarter updates, a quarter
deletes), published Postgres first, while 4 readers in a process of their own read nodes and their
connections by the route a read of main takes:

| Read mode | Landed in | Reads meanwhile | Latency p50 / p95 / p99 | Errors | Read from | Versions readers saw | FalkorDB memory |
|---|--:|--:|--:|--:|---|---|--:|
| Always the latest | 29 s, 1 pass | 39,213 | 4.4 / 41.7 / 66.4 ms | 0 | FalkorDB 95%, Postgres 5% | the old one, then the new one at once | 1,264 → 1,308 MB |
| Update in place | 30 s, 1 pass | 68,469 | 4.4 / 6.6 / 9.0 ms | 0 | FalkorDB | the old one, with parts of the new one as written | 1,286 → 1,332 MB |
| Switch when ready, copied | 56 s, 3 passes | 85,500 | 4.4 / 7.3 / 9.6 ms | 0 | FalkorDB | one whole version at a time: the old, then the new | 1,324 → 3,910 MB |
| Switch when ready, seeded | 522 s, 4 passes | 463,765 | 4.4 / 6.7 / 9.7 ms | 0 | FalkorDB | one whole version at a time: the old, then the new | 1,337 → 2,735 MB |

After every mode FalkorDB held exactly what Postgres holds, and no read failed. What it shows:

- **Always the latest** shows the new version the moment it is published, at a cost in speed: the
  reads that went to Postgres while FalkorDB caught up (5% here) are the slow tail (p95 42 ms, p99
  66 ms against 7 to 10 ms), and they carry no lineage summaries.
- **Update in place** lands as fast and reads as fast as anything here, with no extra memory: its
  cost is that for those 30 s a reader can see part of the new version.
- **Switch when ready** keeps reads as fast as in place and shows one whole version at a time. A
  copy lands in about twice the time of in place, and while `GRAPH.COPY` runs FalkorDB holds the new
  key and the copy's own buffer, each about the graph's size: 2.0× the graph at the peak, which is
  why **Room a copy needs** asks for ×2.2. A seed from Postgres needs about half that (1.1×) but
  lands much later (522 s here, against 56 s for a copy): it is what a build does when no copy fits
  or the graph is too large to copy.

Steps at that size in the same run (each in a process of its own): import into a draft 1,009 s and
487 MB; publish 526 s and 396 MB; projection of the published window 381 s and 276 MB (2 passes);
rebuild from nothing 295 s and 255 MB; export 86 s and 164 MB.

Run 43729410624, on `2fbd409` with the route cache, measured 1M + 1M again with 4 readers:
- No read failed, and FalkorDB held what Postgres holds after every mode.
- The p50 was 2.3 ms in every mode, against 4.4 ms above: a read no longer asks Postgres for its
  route.
- The readers read about 1.5 times as often, and the change landed later: Always the latest in 37 s,
  in place in 39 s, a copy in 74 s and a seed in 715 s. On one 4-CPU runner, readers and the change
  share the CPUs. Runs vary as well: on `fbf1bfe` (run 43644225938) the same modes landed in 22 to
  404 s.

The same on a graph of 1,000,000 nodes and 2,000,000 edges (run 43690420051), with changes of
100,000 rows and 4 readers:

| Read mode | Landed in | Reads meanwhile | Latency p50 / p95 / p99 | Errors | Read from | Versions readers saw | FalkorDB memory |
|---|--:|--:|--:|--:|---|---|--:|
| Always the latest | 28 s, 1 pass | 38,475 | 3.7 / 8.9 / 69.3 ms | 0 | FalkorDB 95%, Postgres 5% | the old one, then the new one at once | 1,408 → 1,438 MB |
| Update in place | 30 s, 1 pass | 62,967 | 3.8 / 6.0 / 8.4 ms | 0 | FalkorDB | the old one, with parts of the new one as written | 1,426 → 1,468 MB |
| Switch when ready, copied | 55 s, 3 passes | 88,872 | 3.7 / 6.5 / 8.8 ms | 0 | FalkorDB | one whole version at a time | 1,463 → 4,447 MB |
| Switch when ready, seeded | 642 s, 4 passes | 668,251 | 3.7 / 5.4 / 7.9 ms | 0 | FalkorDB | one whole version at a time | 1,482 → 3,017 MB |

After every mode FalkorDB held exactly what Postgres holds, and no read failed. Twice the edges
changed little for readers:
- reads from a key were as fast as at 1M + 1M;
- a copy took 2.0 times the graph's memory at its peak, and a seed 1.0 times;
- only the seed's time grew much: 642 s, against 522 s.

The read-modes step runs every mode's import, publish, projection and build in its one process. It
peaked at 1,162 MB (901 MB on the 1M + 1M run on `fbf1bfe`). Its longest event-loop stall was 2.1 s,
in the change's edge windows (1.6 s at 1M + 1M; §10, item 4). The memory ceilings above hold each
step in a process of its own.

**With 200 readers on the same graph** (run 43728972056, on `a7e7eea`), the readers ran as 10
processes of 20. Each process read as a web pod does: by the route it keeps, within its bounds on
reads from FalkorDB and from Postgres, retrying as the app's client does.

| Read mode | Landed in | Reads meanwhile | Latency p50 / p95 / p99 | Errors | Read from | Versions readers saw | FalkorDB memory |
|---|--:|--:|--:|--:|---|---|--:|
| Always the latest | 144 s, 1 pass | 282,108 | 77 / 171 / 3,308 ms | 0 (171 shed, then read on a retry) | FalkorDB 96%, Postgres 4% | the old one, then the new one at once | 1,408 → 1,436 MB |
| Update in place | 149 s, 1 pass | 660,475 | 76 / 147 / 198 ms | 0 | FalkorDB | the old one, with parts of the new one as written | 1,426 → 1,501 MB |
| Switch when ready, copied | 421 s, 16 passes, **written in place** | 1,333,975 | 77 / 150 / 202 ms | 0 (4 shed, then read on a retry) | FalkorDB | the old one, with parts of the new one as written | 1,463 → 4,450 MB |
| Switch when ready, seeded | not landed in the harness's hour | | | | | | |

What it shows:
- **No read failed.** There were 2.28 million reads in the three modes that landed, and FalkorDB
  held what Postgres holds after each.
- **The latency is queueing.**
  - The 200 readers got about 2,500 reads a second in all, on one 4-CPU runner shared by Postgres,
    FalkorDB, the change and the 10 reader processes. 200 readers sharing 2,500 reads a second
    wait about 80 ms each: the p50. With 4 readers the same read took 3.7 ms.
  - The change's import, publish and landing took 3 to 5 times as long as with 4 readers (run
    43690420051, above), for the same reason.
  - In Always the latest, the 4% of reads that went to Postgres while FalkorDB caught up make its
    p99 of 3.3 s.
- **A build beside the serving key didn't land under this load** (§10, item 6):
  - *The copy.*
    - `GRAPH.COPY` took 76 to 88 s on the server, against about 19 s at 1M + 1M with 4 readers.
      FalkorDB's log shows 29 to 37 s to dump the graph and 43 to 45 s to load it.
    - The projector's socket gives up after 75 s, so the first and third attempts failed, though
      the server went on to finish each copy. The second found the first's copy already there.
    - After 3 attempts the build was dropped and the change written in place, so readers saw it
      land as Update in place shows it.
    - The harness's check of one whole version at a time passed anyway: it compares only the
      version numbers readers saw.
  - *The seed.* Its seed from Postgres took most of the hour, against 642 s with 4 readers. Then
    its check for lineage summaries left in its key ran past its 30 s budget twice, and the
    harness's hour ran out.

**Again with 200 readers** (run 43967953534, on `4004f1461`, once each graph's read mode resolved
platform → workspace → graph): the same graph of 1,000,000 nodes and 2,000,000 edges, changes of
100,000 rows, and 200 readers as 10 processes of 20. Three modes ran; there was no seeded one. These
are this run's figures, beside the run above:

| Read mode | Landed in | Reads meanwhile | Latency p50 / p95 / p99 | Errors | Read from | Versions readers saw | FalkorDB memory |
|---|--:|--:|--:|--:|---|---|--:|
| Always the latest | 96 s, 1 pass | 293,455 | 41 / 97 / 1,983 ms | 0 (34 shed, then read on a retry) | FalkorDB 96%, Postgres 4% | the old one, then the new one at once | 1,408 → 1,446 MB |
| Update in place | 83 s, 1 pass | 718,576 | 38 / 78 / 105 ms | 0 | FalkorDB | the old one, with parts of the new one as written | 1,426 → 1,486 MB |
| Switch when ready, copied | 161 s, 3 passes | 1,044,808 | 40 / 81 / 113 ms | 0 | FalkorDB | one whole version at a time | 1,463 → 4,450 MB |

Each mode's change took 66 to 72 s to import and 58 to 63 s to publish. What it shows:
- **No read failed.** There were 2.06 million reads in the three modes, and FalkorDB held what
  Postgres holds after each.
- **Switch when ready landed by a switch this time:** in 3 passes, one whole version at a time. The
  copy took about 32 s on the server (FalkorDB's log: 9 s to dump the graph, 21 s to load it),
  inside the projector's 75 s socket. At its peak FalkorDB held 4,450 MB, about three times the
  1,463 MB it held before. In run 43728972056, above, the copy outlasted that socket and the change
  was written in place (§10, item 6).
- **The p99s are this run's, not a speed-up.** Per mode they were 1,983, 105 and 113 ms, against
  3,308, 198 and 202 ms in run 43728972056. Both ran on one shared 4-CPU runner, where Postgres,
  FalkorDB, the change and the 10 reader processes take turns, and such runs vary from one to the
  next.
- **The run's checks.** "Switch when ready: one whole version at a time" passed, and so did the
  read-modes step's per-window growth (−29%, under the 20% target). Its event-loop lag p99 was
  193 ms, against a target of 50 ms: that step runs every mode's import, publish, projection and
  build in one process (§10, item 4). It peaked at 2,224 MB, and its longest stall was 7.4 s, in the
  change's edge windows.
- **The steps at full size**, each in a process of its own: import into a draft 1,492 s and 493 MB;
  publish 666 s and 403 MB, the graph's lock held throughout; projection of the published window
  448 s and 292 MB (2 passes); rebuild from nothing 362 s and 286 MB (2 passes); export 96 s and
  167 MB.

The first run at 200 readers failed (43699487982, before the route cache, with 50 readers in each
of 4 processes):
- In Always the latest, 23,106 of 89,432 reads failed (26%), at p50 177 ms and p99 3.8 s.
- The next mode stopped when Postgres ran out of connections.
- Each read had asked Postgres for its route: five checkouts of the route pool and about eight
  statements.

What changed since:
- **The route cache.** Each process keeps a graph's route and reads it again, in one query, only
  once a write has moved it ([04](04-projection-and-cache.md) §9).
- **CI sized for 10 reader processes.**
  - Postgres allows 500 connections. Each reader process can open 35: 15 to the store, 5 to the
    route pool and 15 read-only.
  - FalkorDB queues 150 queries (`MAX_QUEUED_QUERIES`, the production cluster's value, where CI's
    was 25).
- **Readers admitted as a web pod's are.**
  - A process runs 8 reads of a key at once (`PROVIDER_MAX_CONCURRENCY`) and keeps 16 more
    waiting. So it admits 24 reads of one graph at a time and sheds the 25th.
  - Hence 20 readers to a process: 50 in one process is more than a web pod admits for one graph.
    Hundreds of users reach a graph through several pods.

The same on a graph of 100,000 nodes and 100,000 edges, with changes of 20,000 rows:

| Read mode | Landed in | Reads meanwhile | Latency p50 / p95 / p99 | Errors | Read from | FalkorDB memory |
|---|--:|--:|--:|--:|---|--:|
| Always the latest | 9.8 s, 1 pass | 7,626 | 4.7 / 56.5 / 69.4 ms | 0 | FalkorDB 92%, Postgres 8% | 131 → 150 MB |
| Update in place | 9.9 s, 1 pass | 15,246 | 4.6 / 6.8 / 9.1 ms | 0 | FalkorDB | 137 → 145 MB |
| Switch when ready, copied | 14.5 s, 3 passes | 18,863 | 4.6 / 7.4 / 9.6 ms | 0 | FalkorDB | 143 → 394 MB |
| Switch when ready, seeded | 51.4 s, 3 passes | 48,159 | 4.6 / 7.1 / 9.6 ms | 0 | FalkorDB | 146 → 307 MB |

The shape holds from 100,000 to 1,000,000: in place lands as fast as Always the latest with reads
as fast as a key's; a copy adds about 1.9 to 2.0 times the graph's memory at its peak, a seed 1.1
to 1.2 times; and a seed's time grows with the graph (51 s to 522 s) faster than a copy's (14 s to
56 s). Steps at 100,000 in that run: import 90 s and 244 MB; publish 27 s and 450 MB; projection
28 s and 198 MB; rebuild 37 s and 220 MB; export 8 s and 160 MB. Before the paging thresholds came
down to 100,000, the projection held that window whole (463 MB) and the rebuild the whole graph
(667 MB).

## 3. Complexity reference

| Operation | Cost | Notes |
|-----------|------|-------|
| Stage / checkpoint (draft) | `O(ops)`; the touched entities' values read alone | a draft gets no Merkle root |
| `apply_ops` (direct write) | `O(ops)` | ontology + integrity gated |
| Pull latest / publish preview / a review's open, preview, diff, summary | `O(changed)`: the draft's edits and what main changed since it branched | the bounded merge (`_compute_merge_bounded`) |
| Publish / merge to `main` | `O(changed)` compose + **`O(changed)` incremental Merkle**; a page at a time above `GRAPHVER_SQUASH_PAGED_ABOVE` | advisory-locked, `O(delta)` |
| Fork creation / a fork's draft work | `O(1)` / `O(changed)`: through the parent for what the fork has not changed | §4.1 |
| A fork's review (open, preview, diff, merge) | `O(changed)` since its last merged review; merged in the request | §4.1 |
| Read a fork's `main` | `O(neighborhood)` in its root's store, over a patch set of `O(changed)` since the fork and its root parted (built once per fork head, then extended); past `GRAPHVER_FORK_REWIND_MAX`, composed in Postgres | §4.1 |
| Read `main` (fresh) | `O(neighborhood)` in FalkorDB | hot path |
| Read `main` at a past revision K (`?asOfSeq`, a preview) | `O(neighborhood)` in main's store, over a patch set of `O(changed since K)` built from content hashes — no payload, no FalkorDB copy — once per revision and head, then extended as the head moves; about 1.2 KB a changed entity in each web process that reads it | the machinery of a fork's `main` (§4.1, whose measurements apply); past `GRAPHVER_REVISION_REWIND_MAX` (100,000), refused with `409 revision_too_far` |
| Read `main` (lagging) / draft / as-of | `O(neighborhood)` compose in Postgres | + `O(delta)` overlay for drafts |
| Incremental projection window | `O(window)` MERGE/DELETE; a page at a time above `GRAPHVER_PROJECTION_PAGED_ABOVE` | idempotent |
| **Full re-projection** | `O(N + E)` reads; a page of each side at a time above `GRAPHVER_PROJECTION_RECONCILE_STREAMED_ABOVE` | §4.2 |
| Schema counts of `main` read from Postgres | counted in Postgres, once per commit | `schema_counts` |
| Reconcile (drift scan) | `O(N)` streamed, bounded memory | operator tool |
| A change list (a draft's changes, one revision's, two revisions compared) | `O(changed)` index-only reads to build — no payload — kept per process; a page `O(page)`; one entity's before and after, two point reads | counted, not listed, past `GRAPHVER_CHANGE_LIST_MAX` (250,000) |
| History calendar (`/history/months`) | one grouped read of `main`'s commits, kept per head | |
| One commit's or a draft review's tree | `O(changed)` payloads; counted from the change list past `GRAPHVER_DIFF_TREE_MAX_CHANGES` (20,000) | the review's merge is not run for it |

## 4. The sharp edges (`O(graph)` hotspots)

### 4.1 A busy fork: its reads and its review

Forking, working on a fork, reading it and reviewing it cost what changes in the fork: the fork point
copies the root its parent stored, a fork's commits carry no root, the bounded reads go through to the
parent for what the fork has not changed, a review merges what the fork changed since its last merged
review ([03](03-branching-commits-merge.md) §3.8), and a fork's `main` reads its root's store with a
patch set of what either side changed since they parted laid over it, with no FalkorDB copy of its own
([17](17-forks-and-residency.md) §2, §6). Three things still scale with a busy fork:

- **A fork past `GRAPHVER_FORK_REWIND_MAX`** (200,000) entities to classify is read from its layered
  rows in Postgres instead, and search does not reach it; its fork-list item recommends an update from
  its parent.
- **A listing scans what the fork created there to page it.** A listing's first page holds at
  most a page of the nodes the fork (or a draft) created that it lists, in name order, and the rest
  follow the store's last page at positions the overlay owns, so a page loads a page of values
  however many it created. Ordering them is `O(created)` once per patch set and listing; until
  2026-11 every one came on the first page, loaded each time (an unfiltered listing of 500 through
  a fork that created 12,500 nodes served all 12,500, in 0.75 s each time).
- **A fork's review is merged inside the request**, holding what the fork changed since its last merged
  review (about 1.5 KB a change); a draft that large is published by a job on the versioning worker.

**Measured** (`backend/scripts/bench_fork_overlay.py`, one process: a root of 100,000 nodes and
100,000 edges that changed 50,000 entities after the fork point). A fork that changed 100,000 of its
own builds a patch set of 145,000 entries in 6.2 s and holds 170 MB (292 MB at the build's peak); one
that changed 1,000, 50,500 entries in 2.2 s and 69 MB. A canvas read through it (the top-level page,
the edges of its first 500 nodes, a table's children) takes 10.9 s and 5.6 s on a process's first
read, which builds the patch set (once per fork head, base and root head), then 2.7 s and 2.1 s,
against 2.5 s and 2.2 s for the same reads on the root's key alone. Before any read, a request on a
fork runs 21 statements (21.6 ms warm), where the same request on its root runs 17; deciding the
ceiling counted 73 ms a request at 145,000 candidates before the count was kept per version, and
takes 5 ms after. A rollup read runs no query per flow the root changed: 528 more than its store's
own at 4 such flows, 5,280 at 40, before the chains were kept with the patch set.

> **Limitation.** Reviewing a fork that changed hundreds of thousands of entities holds them in a web
> process. Review a busy fork often: each review merges only what changed since the last.

### 4.2 A full re-projection holds the graph's ids in memory

A full replay reconciles FalkorDB in place (`_reconcile_in_place` in `projection.py`): it never
drops the graph, and writes only the difference. Up to `GRAPHVER_PROJECTION_RECONCILE_STREAMED_ABOVE`
(100,000) live entities it holds whole-graph maps of small tuples, `O(N + E)` (667 MB at 200,000 and
1,653 MB at 600,000 when held whole), and moves the summaries by the difference. Above it, `_reconcile_streamed` compares a page of each
side at a time — FalkorDB's in internal-id pages against Postgres lookups, then Postgres's heads in
keyset pages against FalkorDB's urn indexes — and hands the summaries to the aggregation job (209 MB
at 600,000). A fork is never projected ([17](17-forks-and-residency.md) §6). (The "`O(n²/batch)` —
upgrade to keyset if a graph outgrows it" comment belongs to the drift reconciler, `reconcile.py`,
not to the projector.) See [04](04-projection-and-cache.md).

## 5. Wired-but-dormant machinery

| Feature | State | Consequence |
|---------|-------|-------------|
| **Per-provider RAM-budget eviction** | Superseded: the worker no longer starts the loop, and `falkorMaxResident`, `GRAPHVER_FALKOR_MAX_RESIDENT`, `GRAPHVER_FALKOR_BUDGETS` and `GRAPHVER_EVICT_SECS` are not acted on | Graph residency replaces it once a system administrator turns it on: each graph kept by its class and each master's memory ([17 §16](17-forks-and-residency.md#16-turning-residency-on)). Off, FalkorDB caches are unbounded per provider. A later release removes the budget's settings. |
| **Ephemeral time-travel pool** | `EPHEMERAL_POOL_MAX_GRAPHS`/`EPHEMERAL_TTL_SECS`/`TRACE_LEASE_TTL_SECS` exist with **zero call sites** | Time-travel is served from Postgres (`_state_as_of` / `materialize_state(as_of_seq=…)`), not a dedicated FalkorDB pool, and a past revision on the canvas as main's store with what changed since put back (`?asOfSeq`): a copy per revision would cost about 1 GB of FalkorDB memory per million nodes and edges, and minutes to build. The active read lease uses `LEASE_TTL`, not `TRACE_LEASE_TTL_SECS`. |

## 6. Correctness & operational gaps

- **No retention inside a live graph.** Superseded version rows, committed `working_changes`, and
  Merkle leaf buckets accrue forever (Merkle already shows ~7× row amplification in dev). There is no
  compaction, TTL, or archival path for a live graph. This is the single biggest *durability-cost*
  gap. (Two sweeps now exist around it: a deleted data source gets a 30-day undo window and then a
  windowed purge of its six version tables, and import/export artifacts and staged import rows are
  swept.)
- **`HASH(graph_id)` partitioning helps many graphs, not one hot graph.** All of a single collaborative
  graph's rows hash to **one partition**, so the busiest graph gets **zero** partition-pruning benefit.
  The key is **immutable-after-data** — decide before loading production data whether a composite key
  (e.g. `(graph_id, entity_id)`) is needed. See [02](02-data-model.md).
- **Reads while the graph updates show an earlier version**, in the read modes that keep serving.
  Every read surface then serves main from the key at the version it last published while it catches
  up or rebuilds (`serving_seq`, doc 04 §5), so a change shows once its pass publishes; the sync chip
  says so meanwhile. Always the latest, the default, reads it from Postgres at once instead, without
  the lineage summaries, and so does a graph further behind than [Most versions
  behind](/guide/versioned-graph-settings#reads-maxversionsbehind) allows.
- **A large restructure or an overlapping window still rebuilds rollups in full.** A window of any
  size is maintained by delta, but a move of a subtree over `PROJECTION_ROLLUP_INLINE_CAP` (50,000)
  or an overlap punts to `"stale"` → full rebuild. See [04](04-projection-and-cache.md) §8.
- **`gv:<id>` urn fallback can mint phantoms.** A node that *should* carry a `urn` but doesn't projects
  under a synthetic `gv:<entity_id>` key with a WARN — an explicit "FalkorDB ⊄ Postgres" signal for
  reconciliation, not a handled case.
- **Check-sync's sorted merge assumes ASCII collation parity.** The drift reconciler's deep verify
  relies on FalkorDB string ordering matching Postgres `COLLATE "C"` — true for ASCII ids; non-ASCII
  ids could mis-align the diff (needs a keyset upgrade with a shared collation). The projector's own
  replay is keyed by `(label, urn)` and does not depend on it.

**Closed since this chapter was written:** the standalone projection worker now carries the
`on_rollups_stale` hook, so a full seed, a stale window or a heal-reseed queues the rollup rebuild on
either wiring; incremental rollups now carry level and depth stamps (`sourceLevel`, `targetLevel`,
`sourceDepth`, `targetDepth`, `levelDigest`); and a provider edit is broadcast to the web process
and the aggregation and versioning workers, so credential rotation no longer needs a restart there
unless the broadcast is missed. (The stats service and the control plane do not listen yet —
`docs/TECHNICAL_DEBT.md` §2.3.)

## 7. Security / authorization — closed

The asymmetry this section used to flag is resolved: `/graph/changes` and every other `graph.py`
mutation route now require `workspace:datasource:manage` (`require_ws_manage`), alongside edit mode.
`/graph/changes` also needs a signed-in user (`get_current_user`; there is no `system` fallback), and
refuses `main` (409 `main_write_forbidden`) and a closed draft (409 `branch_closed`). See
[06](06-api-reference.md).

Stage 2 added who may do what on a draft and on `main` (see [03 §3.15](03-branching-commits-merge.md)
and [13](13-access-and-review.md)):

- **Drafts.** A public draft is written by everyone who can edit its data source; a private one by
  its owner and its editor and maintainer members (403 `not_draft_owner` / `not_owner_or_member`). A
  draft the caller cannot read answers 404 on every path, writes included.
- **`main`.** Publish, merge, revert, restore, sync and `/graph/resync` need
  `workspace:datasource:publish` on top of manage (403 `missing_permission`). A person's direct write
  to a versioned graph's `main` (the graph routes with no draft, and bulk ingest) needs it too (403
  `publish_required`); an API key may do that only if its owner (a person, or the service account
  for an `nxsat_` key) holds publish.
- **Reviews.** Approvals are bound to the draft head the reviewer saw; the author and the draft's
  owner cannot approve.

What is still not there: per-graph protected `main` (`require_review`), review records with
request-changes and comments, a bypass, an audit table of access decisions, and an editor role that
writes drafts without `workspace:datasource:manage` (doc 13's R2–R4).

*(Endpoint source/target type validation on the `/changes` path is also enforced server-side via the
rich `validate_entities_rich` gate — see [05](05-ontology-governance.md) — closing an earlier
frontend-only gap.)*

## 8. Import / Export limitations

See [08](08-import-export.md) for detail; the load-bearing ones:

- **An interrupted export starts over; an import resumes.** Jobs queue in Postgres and run only on
  the versioning worker's transfer lane (the web tier never runs them). A worker that stops hands
  its job back (drain) or loses its lease (crash, after `INGEST_STALE_SECS`), and another worker
  takes it over: an import resumes from its last committed window (`parse:` / `node:` / `edge:`
  cursor); an export is rewritten from the start under a new attempt key.
- **A 50 GB export takes hours.** An export reads one snapshot a page at a time, in flat memory at any
  size, and the Export dialog has the workers write it to the object store, then downloads it in
  pieces that resume. One export runs on one worker, at about 10 MB a second as NDJSON and 3.5 as
  CSV (two passes): nothing splits it across workers yet. `GRAPH_EXPORT_MAX_BYTES` caps it at 50 GiB.
- **The cloud client is opt-in**: artifacts live in the management database (`DatabaseObjectStore`,
  shared by every API pod), as files on a mount every pod shares, which can be a bucket's FUSE
  mount (`OBJECT_STORE_BACKEND=local`), or in an S3-compatible bucket (`OBJECT_STORE_BACKEND=s3`:
  Amazon S3, MinIO, GCS through HMAC keys; boto3 from `requirements-s3.txt`). With
  `OBJECT_STORE_S3_PRESIGN=1`, view-package uploads and stored downloads go straight to the bucket;
  a data source's own import still uploads through the backend, in resumable pieces.
  JSON and xlsx *exports* now stream; JSON and xlsx *imports* are still read whole, which the client
  and the server cap at 100 MiB.
- **A view's export holds the view's entity ids.** A view-scoped export (and a view package) first
  finds the entities the view places and their containment descendants, and keeps their ids while
  it streams — about 100 bytes each, so about 1 GB for a view of 10 million entities, inside the
  transfer worker's 4 GiB. A whole data source's export keeps nothing.
- **Row-scoped export is API-only — not surfaced in the UI.** The backend export options (`props`,
  row-scope `ids`/`types`, view-scope, branch-vs-published, as-of) are wired consistently end-to-end
  (`create_export` → `create_export_job` packs an `options` dict → `ExportWorker`). The **ExportDialog
  / client service send only `format`, `viewId`, `branchId`, and `props`**, so row-scoped export
  (`ids`/`types`) and as-of export (`asOfSeq`) are reachable over HTTP but not exposed in the UI — a
  small frontend follow-up. (An
  earlier static-analysis pass suspected a `TypeError` in this plumbing; it is **not** present in the
  current tree — the three layers' kwargs align.)

## 9. Operational tunables

Almost every knob lives in `backend/app/services/versioning/config.py` and is env-overridable; the
export limits live in `import_export/stream.py` and the FalkorDB write/read timeouts in
`projection.py`. The **immutable-after-data** ones (changing them after rows exist corrupts
hashes/partitions) are marked ⚠. The table is the load-bearing subset. The versioned-graph
settings are left out: a system administrator sets them live, for the platform, a workspace or a
graph, and their environment variables (`GRAPHVER_READ_MODE`, `GRAPHVER_READ_MAX_LAG`,
`GRAPHVER_DRAFT_TTL_DAYS`, `GRAPHVER_DRAFT_RETENTION_DAYS`, `GRAPHVER_MAX_FORKS_PER_GRAPH`,
`GRAPHVER_PURGE_GRACE_DAYS` and the pacing, build, residency, database-read and import ones)
give only their defaults. [Versioned Graph Settings](/guide/versioned-graph-settings) explains each one.

| Env var | Default | Purpose |
|---------|---------|---------|
| `GRAPHVER_DB_URL` | falls back to `MANAGEMENT_DB_URL` | decouple the store onto its own instance |
| ⚠ `GRAPHVER_PARTITIONS` | `64` | HASH partition count for append-only tables |
| ⚠ `GRAPHVER_MERKLE_DEPTH` | `4` | Merkle trie depth (16^depth buckets) |
| ⚠ `GRAPHVER_HASH_ALGO` / `_DIGEST_SIZE` | `blake2b` / `32` | content + Merkle hash |
| `GRAPHVER_PROJECTION_INPROCESS` | off | run the worker lanes inside viz-service, honoured only with `SYNODIC_ROLE=dev`; Compose, Kubernetes and Helm run the versioning worker lanes instead |
| `GRAPHVER_PROJECTION_CONCURRENCY` | `8` | graphs projected per poll pass |
| `GRAPHVER_PROJECTION_VERIFY` | on | post-projection count reconcile + bounded heal |
| `GRAPHVER_REBUILD_TIMEOUT_SECS` | `900` | budget for an explicit operator rebuild |
| `GRAPHVER_VERSIONED_WRITES` | on | write-through: every provider write → an audited commit, which the projector carries to FalkorDB. `0` opts out only data sources without version control; a versioned graph is always written through versioning |
| `GRAPHVER_FALKOR_MAX_RESIDENT` / `_BUDGETS` | `0` (not acted on) | per-provider RAM-budget eviction, which Graph residency replaces |
| `GRAPHVER_DRAFT_SWEEP_SECS` | `3600` (hourly) | how often the versioning worker sweeps: open drafts idle past their workspace's window are abandoned, and closed drafts' changes past theirs removed ([03](03-branching-commits-merge.md) §3.15) |
| `GRAPHVER_COMMIT_MAX_RETRIES` | `5` | `commit_seq`-collision retry budget |
| `GRAPHVER_GRAPH_LOCK_TIMEOUT_MS` | `5000` | longest wait for any one graph, draft, lifecycle, move, PR or graph-row lock; a write `_retry_seq` retries (save, checkpoint, pull, publish, merge, revert, restore, sync, bulk ingest) tries `GRAPHVER_COMMIT_MAX_RETRIES` times before 503 `lock_busy`, anything else answers it after one wait |
| `GRAPHVER_FORK_REWIND_MAX` / `_WARN` | `200000` / `50000` | entities a fork's patch set may classify before its reads go to Postgres / parent changes not taken in that recommend an update ([17](17-forks-and-residency.md) §2, §7) |
| `GRAPHVER_OVERLAY_CACHE_ENTRIES` | `400000` | entries the overlay deltas a process keeps for drafts' and forks' reads hold together: about 1.2 KB each (0.74 KB a draft's, 0.87 KB a fork's, measured, before allocator slack and the chains a rollup read keeps), so under 512 MB a process; an evicted delta is built again on its next read, 2 to 6 s at 50,000 to 145,000 entries |
| `GRAPHVER_SET_FIELDS` | `tags` | payload fields merged as unordered sets in 3-way merge |
| `IMPORT_COMMIT_WINDOW` / `INLINE_IMPORT_MAX` | `10000` / `5000` | import windowing / inline-vs-async threshold |
| `OBJECT_STORE_BACKEND` | `database` | where import/export artifacts live: `database`, `local` (a shared mount) or `s3` (opt-in) |
| `GRAPHVER_PROJECTION_ROLLUP_INLINE_CAP` | `50000` | largest moved subtree whose rollups the projector maintains itself; a window's own lineage edges have no cap |
| `GRAPHVER_ROLLUP_NET_MAX_CELLS` | `200000` | rollup cells a projection window nets in memory; past it, in `graphver.rollup_deltas` |
| `GRAPHVER_RESYNC_MAX_ENTITIES` | `250000` | largest graph a re-sync may attempt; `0` disables the guard ([11](11-resync-at-any-scale.md)) |
| `GRAPHVER_BOOTSTRAP_MERKLE_MAX` | `1000000` | above this, an enable-VC copy defers the Merkle root rather than building it in memory |

## 10. Roadmap (prioritized)

Status as of 2026-10-09 in brackets.

1. **Prove re-sync identity on a bootstrapped graph** — the test [11](11-resync-at-any-scale.md)
   describes: bootstrap a small graph with the real worker, re-sync the unchanged source, assert
   almost nothing changes. *(Open. The bounded merge it guards is already live.)*
2. **Incremental cross-branch Merkle** — remove the full-graph rebuild on draft checkpoints, pulls,
   fork creation and fork mains (§4.1). *(Done another way: draft and fork commits carry no root, and
   nothing rebuilds a whole one; a fork has no fingerprint of its own after its fork point.)*
3. **Keyset-streaming full re-projection & export** — bounded-memory `O(N)` for 5M+ graphs (§4.2,
   §8). *(Export done: it streams in flat memory. Re-projection reconciles in place but still holds
   `O(N + E)` ids.)*
4. **Durable async import/export** — *(Largely done: jobs queue in Postgres, claimed with
   `SKIP LOCKED` on the versioning worker's transfer lane; an interrupted import resumes from its
   last committed window. Still open: resuming an interrupted export instead of starting over.)*
5. **Retention** — compaction/TTL for superseded versions, committed `working_changes`, Merkle
   buckets (§6). *(Open for live graphs; deleted data sources are purged.)*
6. **Partitioning decision** — settle the `graph_id`-only key before production data lands (§6).
   *(Open.)*
7. **Surface row-scoped and as-of export in the ExportDialog** (§8). *(Open.)*
8. **Set an eviction budget in production config** and unify the two read-freshness definitions
   (§5, §6). *(Open: nothing sets a budget.)*
9. **Full lifecycle validation story test** — the designed `test_versioning_full_lifecycle.py`
   (alice/bob/carol drafts → isolation → disjoint auto-merge → same-field conflict → ontology attacks
   → time-travel → tombstone retrieval → audited revert). *(Open.)*

**Done since the last revision of this list:** the projector wiring gap (the standalone worker's
rollup hook, §6) and the `/changes` authorization asymmetry (§7).

### Delivered by the go-live Stages 1 and 2 (to `57444bd8`)

The item-by-item record, with commits, is the gap audit in the repository,
`docs/audits/versioning-stage2-gap-audit-2026-10.md` §4–§5.

**Stage 1: a save, an import or a re-sync can no longer lose people's work.**
- A save to a merged, abandoned or publishing draft answers 409 `branch_closed`, and one to `main`
  409 `main_write_forbidden`; a draft's writers take turns on its row lock, and a queued publish holds
  its draft `publishing` until the job ends.
- Every write that advances `main` takes the graph lock, and every lock wait is bounded by
  `GRAPHVER_GRAPH_LOCK_TIMEOUT_MS` (503 `lock_busy` with `Retry-After`).
- Canvas edits to a versioned graph are written to Postgres only; the projector is FalkorDB's one
  writer for them.
- `/graph/changes` takes an `Idempotency-Key`, so a retried save lands once; one import runs per draft.
- A sync refuses to undo curation (409 `curation_at_risk`) or delete most of a graph (409
  `mass_delete_blocked`) unless a workspace admin overrides it.
- The `versioning-e2e` CI job runs the `GRAPHVER_E2E` suite, informational for now.

**Stage 2: visibility, lifecycle operations, and people not overwriting each other.**
- *Visibility:* the watermark names each graph's FalkorDB key, provider and retry state; placement by
  graph id; a projection health card for every viewer; the canvas read-route chip; the Versioned
  graphs inventory on Admin → Infrastructure; versioned keys on the Graph store page; Reseed from
  Postgres.
- *Lifecycle:* a data source's move carries its graph, forks and jobs; fork delete, restore, list and
  purge; a projection move to another FalkorDB provider or key (admin); freeze and unfreeze; the
  trash says why a purge is blocked; provider delete and move account for versioned graphs.
- *Collaboration:* public and private drafts under a workspace drafts and reviews policy (overridable
  per data source), unreadable drafts 404; a change of level, member or owner saves the staged edits of
  whoever loses write access first; advancing `main` needs `workspace:datasource:publish`; approvals
  are bound to the head;
  reviewers can be asked for; the branch list pages and shows group-shared drafts; the review inbox
  keeps every open PR.

### Still open after Stage 2

- The bounded merge for rebase, merge previews, merge-request open and PR diffs (plan INGEST S0):
  without it many publishers on one graph can livelock on "not up to date".
- Version tokens on FalkorDB-served reads (E4), and an expected head on rebase, publish and merge (E1;
  only approve takes one today).
- A load test of concurrent save, pull and publish at hundreds of users on one graph (TESTS-4), and
  making `versioning-e2e` a required job (C99).
- ACCESS R2–R4 ([13](13-access-and-review.md)): protected `main`, review records, bypass, draft reopen,
  abandon closing its PR, and an editor role.
- CONVERSION L2–L4 ([14](14-graph-lifecycle-v2.md)): blue/green KeyMigration, lossless convert, cutover
  and rollback, adopt, detach, history backup.
- The items numbered 1–9 above.

### Further work found by the scale runs (November 2026)

The `versioning-scale` runs at 100k, 1M and 5M (§2) left these open. Each item gives what was
measured, where to start, and what done looks like. The leads are leads, not findings: confirm each
one before changing code.

To re-measure, dispatch the workflow at any size (`nodes`, `edges`, `changes`, `modes`, `readers`,
`reader_procs`), or run the harness against a staging database (§2, Measuring at your size). The
harness prints each step's slowest statements, its window times by tenths, and its event-loop lag
by phase. It also checks each step against the targets in `TARGETS` (`bench_versioning.py`), which
are set for 100k + 100k. A missed target is reported but doesn't fail the run. The run fails when:
- a step doesn't complete;
- a step passes its memory ceiling;
- a read fails;
- FalkorDB and Postgres disagree;
- a reader of Switch when ready sees parts of two versions.

1. **The publish: each page costs in proportion to the table.**
   - *Measured.* Five times the changes took 23 times as long (§2, At 5,000,000). A page's
     `SELECT DISTINCT ON (graphver.node_versions.entity_id) …` took about 17.7 s at 5M, and
     wasn't among the slowest statements at 1M. The publish ran 25,003 statements, in one
     transaction under `_lock_graph`.
   - *Where to start.*
     - `_squash_paged` (`service.py`) walks the draft's heads `SQUASH_PAGE` (20,000) at a time, four
       times over: the deletes, the nodes, the changed edges and the new edges.
     - For each page it asks `main` for those ids as of the base: `_hashes_at` and `_skeletons_at`,
       a `DISTINCT ON (entity_id)` with `entity_id = ANY(:ids)` and `commit_seq <= base`. The
       gates ask more: `_enforce_written`, `_unique_violations` and
       `_incident_live_edge_skeletons`.
     - Capture `EXPLAIN (ANALYZE, BUFFERS)` of the slow statement at 1M and at 5M, then tell two
       causes apart:
       - a plan that reads or sorts the whole partition for each page, which an index or a
         reshaped query fixes;
       - an index that outgrew the cache. CI's Postgres has 128 MB of shared buffers; production
         settings may hide this, but the work is still there.
     - The squash writes `main`'s rows as it goes, so each later page searches a larger `main`.
   - *The lock.* The publish holds the graph's lock for its whole length: 525 s at 1M, against
     the harness's target of 60 s at 100k. A shorter hold needs a faster publish, or a squash that
     prepares its pages outside the lock and only writes under it.
   - *Done when* a page costs the same at the start and at the end, and a publish of 5M + 5M takes
     about five times as long as one of 1M + 1M, its lock held for no longer.

2. **The import: each window costs more than the last, and memory grows with the graph.**
   - *Measured.* The last tenth of the edge windows took 168% longer than the first at 5M, 167%
     at 1M and 27% at 100k. Peak memory: 244 MB at 100k, 487 MB at 1M, 1,335 MB at 5M.
   - *Where to start.*
     - The edge window's existing-edge lookup, `edges_between` (`import_export/snapshot.py`). It
       matches `source_entity_id = ANY(…)` and `target_entity_id = ANY(…)` through `ix_ev_source`
       and `ix_ev_target`, on every branch of the graph. Each window adds to what later windows
       search.
     - Endpoint resolution (`import_export/resolve.py`).
     - The cost of keeping `edge_versions`' indexes up to date as the table grows.
     - For the memory, find what the job keeps from one window to the next: compare
       `tracemalloc` snapshots at the 100th window and the 400th.
   - *Done when* each tenth of the windows takes within 20% of the first (the harness's target),
     and peak memory is within 100 MB at 100k, 1M and 5M.

3. **The read modes at 5,000,000: after items 1 and 2.**
   - The 5M run spent 5.5 hours on the import and the publish, so it measured no read mode.
   - Give the workflow a way to start the read modes from the imported graph, skipping the
     projection, rebuild and export measurements, so they fit in one job.
   - Switch when ready needs room in FalkorDB:
     - A copy needs about 2.2 times the graph free (2.0 times at its peak, measured). A seed needs
       about 1.2 times.
     - A 5M + 5M graph takes about 6.3 GB, five times 1M + 1M's 1.26 GB. So a copy needs about
       14 GB free and a seed about 7.5 GB, more than a 16 GB runner holds beside Postgres. Measure
       the copy on a larger runner.
   - A seed's time grew from 51 s at 100k to 522 s at 1M, so expect most of an hour at 5M.
   - Re-run at 5M with `latest,in_place,beside_seed` first, and add `beside` on a larger runner.

4. **Event-loop lag in every job.**
   - *Measured* at 100k, the size the targets are set for: the loop-lag p99 was 95 to 205 ms in
     every job, against a target of 50 ms:
     - import 140 ms, publish 99 ms, export 95 ms;
     - projection 205 ms, rebuild 180 ms, read modes 176 ms.
   - The import's worst stall was 321 ms (target 250 ms). At 5M it was 3.1 s.
   - These jobs run on the versioning worker, not on web pods, so requests don't wait on them. Other
     work on the same worker loop does.
   - *Where to start.* The harness names each run's worst phase. Move the CPU-bound step in that
     phase off the loop (`asyncio.to_thread`), as the reconcile's diff already is.
   - *Done when* the p99 is under 50 ms in every job at 100k.

5. **A publish of up to 200,000 changes is held whole.**
   - *Measured.* At 100k + 100k (200,000 changes) the publish peaked at 450 MB. That is under its
     1 GB ceiling but over its 300 MB target.
   - Below `SQUASH_PAGED_ABOVE` (200,000) the squash holds the whole draft. Above it the squash
     pages and stays flat: 396 MB at 1M and 395 MB at 5M.
   - The projector's thresholds came down to 100,000 for the same reason (§2).
   - *Done when* the publish peaks under 300 MB at 100k + 100k without getting slower. A lower
     threshold is the first thing to measure.

6. **Hundreds of concurrent users.**
   - *What protects the read path.*
     - Each process keeps a graph's route (`route_cache.py`). It reads the route from Postgres again
       only once a write has moved it, which the write says in Redis as its commit returns. A read
       checks that in one Redis round trip, so Postgres' load no longer grows with readers.
     - Each web process bounds its reads:
       - from Postgres, per graph ([Reads at once per graph](/guide/versioned-graph-settings#database-readspergraph)) and
         in all ([Reads at once per process](/guide/versioned-graph-settings#database-readsperprocess));
       - from FalkorDB, per key (`PROVIDER_MAX_CONCURRENCY`, 8, with 16 more waiting).
     - Past those bounds a read answers 429 with `Retry-After`. A read past its statement timeout
       answers 503.
     - The client retries twice and honours `Retry-After`, up to 5 s.
     - The harness reads the way the web pods do: by the route each process keeps, bounded,
       retried, from several processes (`--readers`, `--reader-procs`). It reports shed reads and
       retries.
   - *Measured.*
     - 200 readers, as 10 processes of 20, at 1M nodes and 2M edges (§2): no read failed in Always
       the latest, Update in place or Switch when ready, over 2.28 million reads in run 43728972056
       and 2.06 million in run 43967953534.
     - Their p50 of 77 ms (38 to 41 ms in the second run) was queueing on one 4-CPU runner.
     - Before the route cache, 26% of reads failed.
   - *Still open.*
     - **A copy under load.**
       - *Measured.* Under 200 readers, `GRAPH.COPY` of 1M + 2M took 76 to 88 s (run 43728972056).
         - The client gave up after 75 s, the projector's socket timeout
           (`projection_socket_timeout()`, `falkordb_connection.py`), which is
           `PROJECTION_FALKOR_WRITE_TIMEOUT_S` (60) plus `PROJECTION_SOCKET_TIMEOUT_MARGIN_S` (15).
         - The server finished the copy anyway, so the next attempt found "destination key
           already exists". The third copied again and timed out again.
         - After 3 attempts the build was dropped and the change written in place.
         - Any copy that takes longer than 75 s fails the same way, under load or for a larger
           graph.
         - It didn't recur in run 43967953534, at the same size and load: the copy took about
           32 s, and the change landed by a switch (§2). The 75 s limit stands, so a slower copy
           would still fail.
       - *Where to start.* `_build_copy` (`projection.py`).
         - Give the copy a socket that waits as long as a copy can take.
         - Have a retry after a timeout use the copy the server made: if the build's key holds the
           serving key's version (its marker), go on from it rather than fail. If a copy is still
           running, wait for it.
       - *Done when* a copy of 1M + 2M under 200 readers lands by a switch, and a retry after a
         timed-out copy goes on from the copy the server made.
     - **A seed under load.**
       - *Measured.* Under 200 readers, the seed of 1M + 2M from Postgres took most of an hour,
         against 642 s with 4 readers. Then `_clear_summaries` (`projection.py`) failed two
         attempts: its check that no summaries are left,
         `MATCH ()-[r:AGGREGATED]->() RETURN 1 LIMIT 1`, ran past its 30 s budget
         (`PROJECTION_FALKOR_READ_TIMEOUT_S`).
       - *Where to start.*
         - When no summary is left, that check likely visits every node of the key to find none,
           so its cost grows with the graph. The clear could stop once a page deletes fewer than it
           asked for, which needs no check.
         - Then measure what slows the seed itself under readers: its writes share FalkorDB's
           threads with them.
       - *Done when* a seed of 1M + 2M under 200 readers lands within the harness's hour.
     - **The harness's check of Switch when ready.** It compares only the version numbers readers
       saw, so a build dropped and written in place passes (§2). Have `run_readmodes`
       (`bench_versioning.py`) fail a mode that switches when ready unless its change landed on a
       new key (`landed["key"]`).
     - **The management database.** A graph request may read the data source's row up to three
       times: in the access check, in `get_provider` (`providers/manager.py`) and in
       `for_workspace` (`context_engine.py`). Passing the row down would read it once.
     - **Watermark reads outside the route cache.** The versioning API's own routes ask Postgres
       for the watermark on each request (`projection_watermark`, in
       `api/v1/endpoints/versioning.py`). These are `…/watermark`, which the "refreshing" badge
       polls, and the state reads. With hundreds of users, that is load the route cache could
       take.
     - **The fleet's slot.** Web pods also hold a slot among the whole fleet's reads of a key
       (`fleet_slot`, `providers/manager.py`). The harness's readers don't, so the run didn't
       measure that bound.
     - **FalkorDB's own queue.** CI's FalkorDB now queues 150 queries, the production cluster's
       value. The readers, 10 processes of 8 reads at once, sent it at most 80 at a time, so the
       run didn't fill that queue.
     - TESTS-4: a load test over HTTP, through several web pods, with saves, pulls and publishes
       at the same time.

7. **Lineage summaries: what is still left to the aggregation job.**
   - *Corrected by the job's next run.* Until then, a summary can differ from the job's in:
     - depth stamps;
     - `sourceEdgeTypes`, which a window only adds to;
     - parallel edges on one (source, target, type) triple;
     - the `reconciling` flag's clock.
   - *Phase 3b of the summaries plan:*
     - a watermark for the summaries, so readers can tell which version they reflect;
     - a fence with the aggregation job, so that its extract (`rawSeq` on `_AggMeta`, adopted as
       the watermark) can't overwrite summaries a newer window moved;
     - a rebuild that fixes the raw edges and catches the summaries up from that watermark by
       delta. Since the streamed threshold came down to 100,000 entities, a reconcile of 100,000
       to 500,000 entities that changes anything hands its summaries to the job;
     - a sampled check of the summaries against what the job would write.
   - Each of these needs a live FalkorDB to verify.

8. **A pass's time box stops at page boundaries, not within a page.**
   - *Measured.* In both 1M + 2M runs, one rebuild pass ran for more than four hours. Its page's
     lookups kept running out of their budget; each was halved and sent again, and the width the
     ladder keeps came back to one row under the last that failed, which then failed too. The
     300 s time box (`GRAPHVER_PROJECTION_PASS_MAX_SECS`) is checked between pages. The cause
     there is the lookups' (§2, At 1,000,000 nodes and 2,000,000 edges), but nothing yet bounds how
     long one page can take.
   - *Where to start.* `_laddered` in `projection.py`: the halving, `PROJECTION_FLOOR_RETRIES` and
     the backoff between them. Fail the pass, so it backs off and says why, once its time box has
     passed while statements at one row still time out.
   - *Done when* a pass whose every statement times out fails within about twice its time box,
     with a last error naming the statement.

---

## Related chapters

- [03 · Branching, Commits & Merge](03-branching-commits-merge.md) — where the `O(change)` guarantees
  and the Merkle hotspot live.
- [04 · Projection & Cache](04-projection-and-cache.md) — the seed cost, eviction, rollup gaps.
- [08 · Import / Export](08-import-export.md) — the dispatch and export-options limits.
- [10 · Authoritative Sources](10-authoritative-sources-datahub-openmetadata.md) — additional
  federation open questions.
