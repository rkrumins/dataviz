# 09 · Scale, Limits & Roadmap

> **Audience & scope:** engineers and operators making production commitments. The candid state of the
> art — what's proven and measured, where the sharp edges are, what's wired-but-dormant, the known
> gaps, and the prioritized roadmap. Nothing here is aspirational marketing; every limit traces to
> code.

**Re-checked against the code on 2026-10-09 (`42cae50`); §7, §9 and §10's Stage 1–2 subsections again on 2026-10-19 (`57444bd8`); §2–§4 and §8 on 2026-10-30, at millions of entities.**

**TL;DR.** The Versioned Graph is **feature-complete and test-covered for the managed, single-node
case**. Saves, pulls, previews, reviews and publishes are `O(change)`, not `O(graph)`, and a publish,
its projection and a rebuild of millions hold a page at a time (§2). The remaining sharp edges are
deliberately-deferred scale items — forks, which still read whole graphs; export jobs that start over
when interrupted (imports resume); no retention inside a live graph; and a partitioning key that doesn't
help a single hot collaborative graph. Re-sync, separately, runs a bounded merge that has not been
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

### Measured at 300,000 nodes and 300,000 edges

`backend/scripts/bench_versioning.py` (one job per process, peak RSS of that process; Postgres 16 and
FalkorDB 4.18 on one 4-CPU machine). The graph is imported into a new graph's draft, published,
projected and exported; "one pass" is the same step with the paging threshold raised past it.

| Step | 100k + 100k | 300k + 300k | 300k + 300k, one pass |
|------|------------:|------------:|----------------------:|
| Import into a draft (windowed) | 117 s, 192 MB | 214 s, 198 MB | — |
| Publish (paged above 200,000 changes) | 24 s, 436 MB (one batch) | 111 s, 369 MB | ~1 GB, est. (1.7 KB a change) |
| Projection of the published window (paged above 200,000 rows) | — | 112 s, 182 MB | 92 s, 956 MB |
| Rebuild from nothing (paged above 500,000 entities) | — | 84 s, 209 MB | 77 s, 1,653 MB |
| Export (NDJSON, streamed) | 12 s, 154 MB | 31 s, 150 MB | — |

A paged publish holds at most the Merkle fingerprint's list of changes besides its page — up to
1,000,000 entries, past which the fingerprint is left unset — so its peak stops growing there.
Everything else above is flat in the graph's size.

## 3. Complexity reference

| Operation | Cost | Notes |
|-----------|------|-------|
| Stage / checkpoint (draft) | `O(ops)`; the touched entities' values read alone | a draft gets no Merkle root |
| `apply_ops` (direct write) | `O(ops)` | ontology + integrity gated |
| Pull latest / publish preview / a review's open, preview, diff, summary | `O(changed)`: the draft's edits and what main changed since it branched | the bounded merge (`_compute_merge_bounded`) |
| Publish / merge to `main` | `O(changed)` compose + **`O(changed)` incremental Merkle**; a page at a time above `GRAPHVER_SQUASH_PAGED_ABOVE` | advisory-locked, `O(delta)` |
| Fork creation / fork merge / fork commit | **`O(graph)`**: whole states and a full `_merkle_root` | §4.1 |
| Read `main` (fresh) | `O(neighborhood)` in FalkorDB | hot path |
| Read `main` (lagging) / draft / as-of | `O(neighborhood)` compose in Postgres | + `O(delta)` overlay for drafts |
| Incremental projection window | `O(window)` MERGE/DELETE; a page at a time above `GRAPHVER_PROJECTION_PAGED_ABOVE` | idempotent |
| **Full re-projection** | `O(N + E)` reads; a page of each side at a time above `GRAPHVER_PROJECTION_RECONCILE_STREAMED_ABOVE` | §4.2 |
| Schema counts of `main` read from Postgres | counted in Postgres, once per commit | `schema_counts` |
| Reconcile (drift scan) | `O(N)` streamed, bounded memory | operator tool |

## 4. The sharp edges (`O(graph)` hotspots)

### 4.1 Forks still read whole graphs

A draft's checkpoint reads only the entities it touches, and a draft commit gets no Merkle root.
Forks are the exception: creating one builds the parent's full Merkle root, every commit on a fork's
`main` builds the fork's (`_commit_merkle` falls back to `_merkle_root`), and a fork's pull request
merges three whole states (`_compute_fork_merge`) under the parent's lock. A fork's checkpoint,
revert and restore compose its whole state too, because the bounded reads (`_values_at`) don't yet
look through to the parent's rows. See [03](03-branching-commits-merge.md).

> **Limitation.** Fine at thousands of entities; at millions a fork's creation and merge run out of
> memory. Bounded fork merges are the next step (§10).

### 4.2 A full re-projection holds the graph's ids in memory

A full replay reconciles FalkorDB in place (`_reconcile_in_place` in `projection.py`): it never
drops the graph, and writes only the difference. Up to `GRAPHVER_PROJECTION_RECONCILE_STREAMED_ABOVE`
(500,000) live entities it holds whole-graph maps of small tuples, `O(N + E)` (1,653 MB at 600,000),
and moves the summaries by the difference. Above it, `_reconcile_streamed` compares a page of each
side at a time — FalkorDB's in internal-id pages against Postgres lookups, then Postgres's heads in
keyset pages against FalkorDB's urn indexes — and hands the summaries to the aggregation job (209 MB
at 600,000). A fork always takes the first: its state composes its parent's. (The "`O(n²/batch)` —
upgrade to keyset if a graph outgrows it" comment belongs to the drift reconciler, `reconcile.py`,
not to the projector.) See [04](04-projection-and-cache.md).

## 5. Wired-but-dormant machinery

| Feature | State | Consequence |
|---------|-------|-------------|
| **Per-provider RAM-budget eviction** | The loop always starts, in both worker paths. Each provider's budget is its `falkorMaxResident` setting, falling back to `GRAPHVER_FALKOR_MAX_RESIDENT`/`GRAPHVER_FALKOR_BUDGETS`; a budget of 0 skips it | FalkorDB caches are still **unbounded per provider** by default: no manifest, chart or compose file sets a budget, and no screen sets `falkorMaxResident`. `falkor_eviction_configured()` has no callers. Called out in code as "the riskiest scale bet." |
| **Ephemeral time-travel pool** | `EPHEMERAL_POOL_MAX_GRAPHS`/`EPHEMERAL_TTL_SECS`/`TRACE_LEASE_TTL_SECS` exist with **zero call sites** | Time-travel is served from Postgres (`_state_as_of` / `materialize_state(as_of_seq=…)`), not a dedicated FalkorDB pool. The active read lease uses `LEASE_TTL`, not `TRACE_LEASE_TTL_SECS`. |

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
- **Read-freshness is computed two ways.** `ContextEngine` uses strict `projected ≥ committed`; the
  neighbors endpoint applies `READ_MAX_LAG`. They coincide at the default `READ_MAX_LAG=0`; a non-zero
  lag would make the two surfaces disagree on when to serve FalkorDB vs Postgres.
- **A large or overlapping projection window still rebuilds rollups in full.** A window over
  `PROJECTION_ROLLUP_INLINE_CAP` (50,000) or an overlap punts to `"stale"` → full rebuild. See
  [04](04-projection-and-cache.md).
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
  caps at 100 MiB.
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
hashes/partitions) are marked ⚠. The table is the load-bearing subset.

| Env var | Default | Purpose |
|---------|---------|---------|
| `GRAPHVER_DB_URL` | falls back to `MANAGEMENT_DB_URL` | decouple the store onto its own instance |
| ⚠ `GRAPHVER_PARTITIONS` | `64` | HASH partition count for append-only tables |
| ⚠ `GRAPHVER_MERKLE_DEPTH` | `4` | Merkle trie depth (16^depth buckets) |
| ⚠ `GRAPHVER_HASH_ALGO` / `_DIGEST_SIZE` | `blake2b` / `32` | content + Merkle hash |
| `GRAPHVER_PROJECTION_INPROCESS` | off | run the worker lanes inside viz-service, honoured only with `SYNODIC_ROLE=dev`; Compose, Kubernetes and Helm run the versioning worker lanes instead |
| `GRAPHVER_PROJECTION_CONCURRENCY` | `8` | graphs projected per poll pass |
| `GRAPHVER_READ_MAX_LAG` | `0` | staleness a read tolerates before Postgres fallback |
| `GRAPHVER_PROJECTION_VERIFY` | on | post-projection count reconcile + bounded heal |
| `GRAPHVER_REBUILD_TIMEOUT_SECS` | `900` | budget for an explicit operator rebuild |
| `GRAPHVER_VERSIONED_WRITES` | on | write-through: every provider write → an audited commit, which the projector carries to FalkorDB. `0` opts out only data sources without version control; a versioned graph is always written through versioning |
| `GRAPHVER_FALKOR_MAX_RESIDENT` / `_BUDGETS` | `0` (dormant) | per-provider RAM-budget eviction |
| `GRAPHVER_DRAFT_TTL_DAYS` / `_SWEEP_SECS` | `30` / daily | auto-abandon idle drafts (not those with a live PR or staged edits, nor on a deleted, frozen or recently unfrozen graph) |
| `GRAPHVER_COMMIT_MAX_RETRIES` | `5` | `commit_seq`-collision retry budget |
| `GRAPHVER_GRAPH_LOCK_TIMEOUT_MS` | `5000` | longest wait for any one graph, draft, lifecycle, move, PR or graph-row lock; a write `_retry_seq` retries (save, checkpoint, pull, publish, merge, revert, restore, sync, bulk ingest) tries `GRAPHVER_COMMIT_MAX_RETRIES` times before 503 `lock_busy`, anything else answers it after one wait |
| `GRAPHVER_MAX_FORKS_PER_GRAPH` | `10` | live forks per graph; one more is 409 `fork_limit` |
| `GRAPHVER_SET_FIELDS` | `tags` | payload fields merged as unordered sets in 3-way merge |
| `IMPORT_COMMIT_WINDOW` / `INLINE_IMPORT_MAX` | `10000` / `5000` | import windowing / inline-vs-async threshold |
| `OBJECT_STORE_BACKEND` | `database` | where import/export artifacts live: `database`, `local` (a shared mount) or `s3` (opt-in) |
| `GRAPHVER_PROJECTION_ROLLUP_INLINE_CAP` | `50000` | largest projection window whose rollups are maintained incrementally |
| `GRAPHVER_RESYNC_MAX_ENTITIES` | `250000` | largest graph a re-sync may attempt; `0` disables the guard ([11](11-resync-at-any-scale.md)) |
| `GRAPHVER_BOOTSTRAP_MERKLE_MAX` | `1000000` | above this, an enable-VC copy defers the Merkle root rather than building it in memory |
| `GRAPHVER_PURGE_GRACE_DAYS` | `30` | undo window before a deleted data source's version history is purged |

## 10. Roadmap (prioritized)

Status as of 2026-10-09 in brackets.

1. **Prove re-sync identity on a bootstrapped graph** — the test [11](11-resync-at-any-scale.md)
   describes: bootstrap a small graph with the real worker, re-sync the unchanged source, assert
   almost nothing changes. *(Open. The bounded merge it guards is already live.)*
2. **Incremental cross-branch Merkle** — remove the full-graph rebuild on draft checkpoints, pulls,
   fork creation and fork mains (§4.1). *(Open.)*
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

---

## Related chapters

- [03 · Branching, Commits & Merge](03-branching-commits-merge.md) — where the `O(change)` guarantees
  and the Merkle hotspot live.
- [04 · Projection & Cache](04-projection-and-cache.md) — the seed cost, eviction, rollup gaps.
- [08 · Import / Export](08-import-export.md) — the dispatch and export-options limits.
- [10 · Authoritative Sources](10-authoritative-sources-datahub-openmetadata.md) — additional
  federation open questions.
