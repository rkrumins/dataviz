# 09 · Scale, Limits & Roadmap

> **Audience & scope:** engineers and operators making production commitments. The candid state of the
> art — what's proven and measured, where the sharp edges are, what's wired-but-dormant, the known
> gaps, and the prioritized roadmap. Nothing here is aspirational marketing; every limit traces to
> code.

**TL;DR.** The Versioned Graph is **feature-complete and test-covered for the managed, single-node
case**. Interactive edits and publishes are `O(change)`, not `O(graph)`. The remaining sharp edges are
deliberately-deferred scale items — a full-graph Merkle rebuild on *draft* checkpoints, an `O(N·E)`
FalkorDB full seed, an in-process import dispatcher, no GC/retention, and a partitioning key that
doesn't help a single hot collaborative graph. Read this chapter before betting a large production
workload on it.

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

## 3. Complexity reference

| Operation | Cost | Notes |
|-----------|------|-------|
| Stage / checkpoint (draft) | `O(ops)` writes; **`O(graph)` Merkle** | see §4.1 |
| `apply_ops` (direct write) | `O(ops)` | ontology + integrity gated |
| Publish / merge to `main` | `O(changed)` compose + **`O(changed)` incremental Merkle** | advisory-locked, `O(delta)` |
| Fork merge / rebase | `O(changed)`; **full `_merkle_root`** for forks | forks use full compose in places |
| Read `main` (fresh) | `O(neighborhood)` in FalkorDB | hot path |
| Read `main` (lagging) / draft / as-of | `O(neighborhood)` compose in Postgres | + `O(delta)` overlay for drafts |
| Incremental projection window | `O(window)` MERGE/DELETE | idempotent |
| **Full FalkorDB seed** | **`O(N·E)`**, in-memory compose | §4.2 |
| Reconcile (drift scan) | `O(N)` streamed, bounded memory | operator tool |

## 4. The sharp edges (`O(graph)` hotspots)

### 4.1 Draft checkpoints do a full-graph Merkle rebuild
Non-fork `main` gets an **incremental** persisted Merkle root, but **draft checkpoints and fork
`main`s** call the full `_merkle_root` build over the entire composed state on *every* commit
(cross-branch copy-on-write Merkle is explicitly a "later step"). This is the next `O(graph)` hotspot
after `_state_as_of`/`_kind_map_multi` were fixed — it makes a one-entity checkpoint on a large draft
`O(graph)`. See [03](03-branching-commits-merge.md).

> **Limitation.** A checkpoint on a draft of a multi-million-entity graph pays a full-graph hash walk.
> Fine at current scale; a keyset/CoW upgrade is the fix (§7).

### 4.2 The FalkorDB full seed is `O(N·E)` and not streamed
A full seed composes the **entire live state in memory** via `_state_as_of`, then applies per-edge
`MATCH (a {urn}) MATCH (b {urn}) MERGE …`. The drift **reconciler** already streams in bounded batches
(`reconcile._stream_pg_nodes`), but the projector's seed path does not. Its own comment flags the
SKIP/LIMIT scan as "`O(n²/batch)` — acceptable at current scale; upgrade to keyset if a graph outgrows
it." See [04](04-projection-and-cache.md).

## 5. Wired-but-dormant machinery

| Feature | State | Consequence |
|---------|-------|-------------|
| **Per-provider RAM-budget eviction** | Daemon wired in both worker paths but **off by default** (`FALKOR_MAX_RESIDENT=0`; gated by `falkor_eviction_configured()`) | FalkorDB caches are **unbounded per provider** until an operator sets `GRAPHVER_FALKOR_MAX_RESIDENT`/`GRAPHVER_FALKOR_BUDGETS`. Called out in code as "the riskiest scale bet." |
| **Ephemeral time-travel pool** | `EPHEMERAL_POOL_MAX_GRAPHS`/`EPHEMERAL_TTL_SECS`/`TRACE_LEASE_TTL_SECS` exist with **zero call sites** | Time-travel is served from Postgres (`_state_as_of` / `materialize_state(as_of_seq=…)`), not a dedicated FalkorDB pool. The active read lease uses `LEASE_TTL`, not `TRACE_LEASE_TTL_SECS`. |

## 6. Correctness & operational gaps

- **No GC / retention anywhere.** Superseded version rows, committed `working_changes`, and Merkle leaf
  buckets accrue forever (Merkle already shows ~7× row amplification in dev). There is no compaction,
  TTL, or archival path. This is the single biggest *durability-cost* gap.
- **`HASH(graph_id)` partitioning helps many graphs, not one hot graph.** All of a single collaborative
  graph's rows hash to **one partition**, so the busiest graph gets **zero** partition-pruning benefit.
  The key is **immutable-after-data** — decide before loading production data whether a composite key
  (e.g. `(graph_id, entity_id)`) is needed. See [02](02-data-model.md).
- **The standalone projection worker lacks the `on_rollups_stale` hook.** A full-seed / stale-window /
  heal-reseed on a deployment running *only* the standalone worker leaves `:AGGREGATED` rollups stale
  until a **manual** aggregation rebuild — whereas the in-process worker and interactive path
  self-heal. This is the biggest behavioral difference between the two projector wirings. See
  [04](04-projection-and-cache.md).
- **Read-freshness is computed two ways.** `ContextEngine` uses strict `projected ≥ committed`; the
  neighbors endpoint applies `READ_MAX_LAG`. They coincide at the default `READ_MAX_LAG=0`; a non-zero
  lag would make the two surfaces disagree on when to serve FalkorDB vs Postgres.
- **Incremental rollups carry no hierarchy `level` stamp.** So level-scoped aggregation can't be
  reconciled incrementally; a bulk window (`> _MOVE_EDGE_CAP=1000`) or an overlap punts to `"stale"` →
  full rebuild. See [04](04-projection-and-cache.md).
- **`gv:<id>` urn fallback can mint phantoms.** A node that *should* carry a `urn` but doesn't projects
  under a synthetic `gv:<entity_id>` key with a WARN — an explicit "FalkorDB ⊄ Postgres" signal for
  reconciliation, not a handled case.
- **Reconcile's sorted-merge assumes ASCII collation parity.** It relies on FalkorDB string ordering
  matching Postgres `COLLATE "C"` — true for ASCII ids; non-ASCII ids could mis-align the diff (needs a
  keyset upgrade with a shared collation).
- **Credential rotation needs a process restart** — the provider registry memoizes provider rows for
  the process lifetime.

## 7. Security / authorization open question

> **Limitation (product decision needed).** The versioning endpoints require
> `workspace:datasource:manage` for writes, but the `/graph/changes` path and other `graph.py`
> mutation endpoints use `get_optional_user` (no hard authz gate). Since a graph write becomes an
> audited commit, this asymmetry should be resolved deliberately — either gate `/changes` to `manage`
> or make the relaxed policy explicit. See [06](06-api-reference.md).

*(Endpoint source/target type validation on the `/changes` path is now enforced server-side via the
rich `validate_entities_rich` gate — see [05](05-ontology-governance.md) — closing an earlier
frontend-only gap.)*

## 8. Import / Export limitations

See [08](08-import-export.md) for detail; the load-bearing ones:

- **In-process `BackgroundTasks` dispatch, not a real async dispatcher.** A `uvicorn --reload` (or a
  crash) mid-import/export kills the job and leaves its summary null. A Redis/Postgres dispatcher is a
  designed slot-in behind the same call.
- **Export doesn't stream the read.** It `materialize_state`s the whole state then streams the write —
  fine for human-scale exports, not 5M+ (swap `materialize_state` → keyset streaming).
- **Object store is local-only** (`LocalFsObjectStore`); S3/GCS raise `NotImplementedError`; the
  `presigned` upload path is modeled but unbacked. JSON/xlsx adapters are buffered, not streamed.
- **Row-scoped export is API-only — not surfaced in the UI.** The backend export options (`props`,
  row-scope `ids`/`types`, view-scope, branch-vs-published, as-of) are wired consistently end-to-end
  (`create_export` → `create_export_job` packs an `options` dict → `ExportWorker`). The **ExportDialog
  / client service send only `format`, `viewId`, `branchId`, and `props`**, so row-scoped export
  (`ids`/`types`) is reachable over HTTP but not exposed in the UI — a small frontend follow-up. (An
  earlier static-analysis pass suspected a `TypeError` in this plumbing; it is **not** present in the
  current tree — the three layers' kwargs align.)

## 9. Operational tunables

Every knob lives in `backend/app/services/versioning/config.py` and is env-overridable. The
**immutable-after-data** ones (changing them after rows exist corrupts hashes/partitions) are marked ⚠.

| Env var | Default | Purpose |
|---------|---------|---------|
| `GRAPHVER_DB_URL` | falls back to `MANAGEMENT_DB_URL` | decouple the store onto its own instance |
| ⚠ `GRAPHVER_PARTITIONS` | `64` | HASH partition count for append-only tables |
| ⚠ `GRAPHVER_MERKLE_DEPTH` | `4` | Merkle trie depth (16^depth buckets) |
| ⚠ `GRAPHVER_HASH_ALGO` / `_DIGEST_SIZE` | `blake2b` / `32` | content + Merkle hash |
| `GRAPHVER_PROJECTION_INPROCESS` | off (on in dev compose) | run the projector inside viz-service |
| `GRAPHVER_PROJECTION_CONCURRENCY` | `8` | graphs projected per poll pass |
| `GRAPHVER_READ_MAX_LAG` | `0` | staleness a read tolerates before Postgres fallback |
| `GRAPHVER_PROJECTION_VERIFY` | on | post-projection count reconcile + bounded heal |
| `GRAPHVER_REBUILD_TIMEOUT_SECS` | `900` | budget for an explicit operator rebuild |
| `GRAPHVER_VERSIONED_WRITES` | on | write-through: every provider write → an audited commit |
| `GRAPHVER_FALKOR_MAX_RESIDENT` / `_BUDGETS` | `0` (dormant) | per-provider RAM-budget eviction |
| `GRAPHVER_DRAFT_TTL_DAYS` / `_SWEEP_SECS` | `30` / daily | auto-abandon idle drafts |
| `GRAPHVER_COMMIT_MAX_RETRIES` | `5` | `commit_seq`-collision retry budget |
| `GRAPHVER_SET_FIELDS` | `tags` | payload fields merged as unordered sets in 3-way merge |
| `IMPORT_COMMIT_WINDOW` / `INLINE_IMPORT_MAX` | `50000` / `5000` | import windowing / inline-vs-async threshold |

## 10. Roadmap (prioritized)

1. **Incremental cross-branch Merkle** — remove the full-graph rebuild on draft checkpoints & fork
   mains (§4.1).
2. **Keyset-streaming full seed & export** — bounded-memory `O(N)` for 5M+ graphs (§4.2, §8).
3. **Real async import/export dispatcher** — replace `BackgroundTasks` with a durable Redis/Postgres
   queue so a reload can't kill a job (§8).
4. **GC / retention** — compaction/TTL for superseded versions, committed `working_changes`, Merkle
   buckets (§6).
5. **Partitioning decision** — settle the `graph_id`-only key before production data lands (§6).
6. **Close the projector wiring gap** — give the standalone worker (or a proxy-mode HTTP control plane)
   the `on_rollups_stale` trigger (§6).
7. **Resolve the `/changes` authz asymmetry** (§7) and **surface row-scoped export in the ExportDialog**
   (§8).
8. **Enable the eviction budget in production config** and unify the two read-freshness definitions
   (§5, §6).
9. **Full lifecycle validation story test** — the designed `test_versioning_full_lifecycle.py`
   (alice/bob/carol drafts → isolation → disjoint auto-merge → same-field conflict → ontology attacks
   → time-travel → tombstone retrieval → audited revert).

---

## Related chapters

- [03 · Branching, Commits & Merge](03-branching-commits-merge.md) — where the `O(change)` guarantees
  and the Merkle hotspot live.
- [04 · Projection & Cache](04-projection-and-cache.md) — the seed cost, eviction, rollup gaps.
- [08 · Import / Export](08-import-export.md) — the dispatch and export-options limits.
- [10 · Authoritative Sources](10-authoritative-sources-datahub-openmetadata.md) — additional
  federation open questions.
