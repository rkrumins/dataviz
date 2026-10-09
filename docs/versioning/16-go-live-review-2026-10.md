> Verified review of the versioning subsystem (2026-10-09): 12 dimension reviewers + 5 gap reviewers, every finding adversarially verified (220 survived, 1 refuted). The delivery order in §5 is superseded by the rollout stages in [13](13-access-and-review.md), [14](14-graph-lifecycle-v2.md), [12](12-streaming-ingestion.md) and [15 §17](15-shared-contracts.md).

# Versioned-graph review: readiness for 500+ graphs and hundreds of concurrent users

## 1. Executive verdict

The versioned-graph system is not fit for the target envelope today. Several separate defects can lose or corrupt data, and the deployed FalkorDB topology cannot hold or rotate 500 graphs.

The core design is sound and much of it works:
- Version tables are append-only, and each entity's head pointer is updated with a compare-and-swap.
- Publishes take a per-graph advisory lock and refuse a draft that is behind main.
- The field-level 3-way merge is correct for single entities.
- The projector checks counts before advancing its watermark.
- The enable-version-control copy (bootstrap) is resumable and epoch-fenced.

Six defect clusters block it:
1. **The canvas save path accepts writes to closed branches.** `_apply_ops_once` saves into merged, abandoned or other users' drafts and reports success (MERGE-1 and four duplicates). "Pull latest" can revert edits saved to the same draft while it runs (GAP_E2E_COLLAB_TRACE-1).
2. **The platform can delete customer data in FalkorDB.** Eviction, operator Rebuild and an unvalidated `POST /graphs` can `GRAPH.DELETE` or fully reconcile a customer's original graph. This includes mid-bootstrap, and it permanently removes entities that have no URN, which bootstrap never copied (FALKORSCALE-2, BOOTSTRAP-1/2, APIOPS-1, PROJECTION-1).
3. **Postgres and FalkorDB can drift apart without anyone noticing.** The watermark is computed from Postgres only. Nothing checks that the FalkorDB key exists or is current, and projector writes are not confirmed by replicas (PROJECTION-2, FALKORSCALE-7).
4. **Core collaboration operations do not scale.** Pull latest, opening a PR, PR diffs and checkpoints rebuild the whole graph two or three times inside a web request (STORE-1).
5. **FalkorDB capacity management does not work.** Eviction is undone by the poll loop within 5 seconds, budgets count graphs rather than bytes, placement across shards cannot be controlled, and the manifests give about 96 GB usable rather than 192 GB (FALKORSCALE-1/6).
6. **None of the roughly 104 Postgres-backed versioning integration tests run in CI**, and there are no load, chaos or browser end-to-end tests (TESTS-1/5/7/9).

Phase 0 below fixes the data-safety blockers. It is mostly S/M effort and makes heavy use of existing helpers. It must land before any production conversion of customer graphs or before eviction is enabled.

## 2. Requirement scorecard

| Req | Status | Driving findings | Rationale |
|---|---|---|---|
| R0 External → PG → FalkorDB, no data loss | **Not operational** | BOOTSTRAP-1/FALKORSCALE-2, BOOTSTRAP-2/APIOPS-1, PROJECTION-1 | Bootstrap mechanics are durable, but entities without a URN are never copied and are later deleted. Eviction or Rebuild can wipe the source graph mid-copy. Divergence goes undetected (PROJECTION-2). |
| R1 Full entity history across merges | **Partially operational** | HISTORY-1, HISTORY-2, HISTORY-3 | Append-only, field-level, paginated history works for direct writes. Merged changes are credited to whoever clicked merge. Imported entities show empty history. Expanding the import commit runs out of memory. |
| R2 Parallel branches without overwrites | **Not operational** | MERGE-1, GAP_E2E_COLLAB_TRACE-1, MERGE-3/MERGE-4 | Publish is locked and the up-to-date gate is correct. But saves go into dead branches, a pull silently reverts concurrent saves, a delete cascade silently removes other users' edges, and stale conflict resolutions default to "mine". |
| R3 Feature-rich CRUD in a view | **Partially operational** | FRONTEND-1, FRONTEND-2, GAP_DRAFT_READ_SEMANTICS-2 | Atomic batch save, conflict choices and ontology mapping are strong. Double-submit duplicates entities, publishing drops unsaved edits, and search and display rules are wrong or return 500 on drafts and while main lags. |
| R4 Rich, premium, modern UI | **Partially operational** | GAP_R4_R5_UI_AUDIT-11, GAP_R4_R5_UI_AUDIT-10, FRONTEND-8 | The design system is barely adopted (0 Button/Badge/Tabs imports across about 50 components, 243 raw buttons). The Save modal has a hard-coded dark theme. Dialogs lack keyboard dismissal and focus traps. The PR drawer is unbounded. |
| R5 Lifecycle after conversion | **Partially operational** | STORE-4/LIFECYCLE-2, LIFECYCLE-10, LIFECYCLE-5 | "Delete permanently" always returns 503 because of a CHECK constraint. Version control cannot be disabled, history has no retention or backup, re-sync is impossible above 250k entities, and an abandoned draft cannot be reopened. |
| R6 500+ graphs, ~500 GB PG, 3×64 GB FalkorDB | **Not operational** | STORE-1, FALKORSCALE-1, FALKORSCALE-3 | Collaboration operations cost O(graph) on web pods. Eviction thrashes instead of freeing memory. A full seed of a large graph runs out of memory on the single 4 GiB worker. Shards actually hold about 96 GB. |

## 3. End-to-end flow walkthrough

### (a) External FalkorDB graph → versioned (PG) → published FalkorDB projection

| Step | Status | Notes |
|---|---|---|
| `POST /graph/bootstrap`: tenant check, provider check, pin to `ds.graph_name`, `owns_falkor_graph=False` | Works | Breaks on Helm installs, which deploy no versioning-worker, so the job stays `pending` forever (APIOPS-2). |
| Count, then nodes and edges windows (resumable, fenced, deterministic ids) | Works mechanically | **Breaks:** <br>• URN-less nodes and edges are skipped (PROJECTION-1). <br>• Identity-mapped sources convert almost empty (BOOTSTRAP-7). <br>• Edges sharing a raw `r.id` collapse, and edge heads that collide with node URNs are dropped (BOOTSTRAP-6). <br>• Native edge properties and secondary labels are dropped (BOOTSTRAP-7). <br>• Bad values fail as "infrastructure" and Resume can never get past them (BOOTSTRAP-12). <br>• Cost grows with node count × number of windows (BOOTSTRAP-11). |
| Writes during the copy | Breaks | Edge PATCH/DELETE bypass the write gate and the audit trail (BOOTSTRAP-4). Writes to already-copied windows are undetected, and the sample check covers only 64 nodes and no edges. |
| Background actors during the copy | **Breaks (critical)** | Eviction's LRU picks the bootstrapping graph first (`last_projected_at` is NULL) and runs `GRAPH.DELETE` on the source (BOOTSTRAP-1/FALKORSCALE-2/GAP_PROJECTION_LEASE_FENCING-1). A Rebuild or repin full-reconciles an empty genesis into the source (BOOTSTRAP-2, APIOPS-1). |
| Validate, then finalize (fast-forward `projected=target=2`) | Partially works | Ontology canonicalization makes PG types differ from physical labels, so the first edit duplicates nodes or drops edges (BOOTSTRAP-5). Restarting while a worker is running can finalize over deleted rows (BOOTSTRAP-10). |
| First user publish → incremental projection → verify | **Breaks** | `falkor_counts` counts URN-less nodes and parallel edges as "extra", so the verify holds the watermark back and the graph wedges on Postgres with no rollups (BOOTSTRAP-9, PROJECTION-3/GAP_PROJECTION_LEASE_FENCING-5). The UI's "Rebuild" advice then permanently deletes the skipped entities (PROJECTION-1/BOOTSTRAP-2). |
| Steady state | Breaks | Lost or truncated FalkorDB data is never detected (PROJECTION-2/FALKORSCALE-7). External writers' properties are silently removed (BOOTSTRAP-8). Resync paging truncates and then mass-deletes (BOOTSTRAP-3), and it is capped at 250k entities (LIFECYCLE-10). |

### (b) Alice (view V1) and Bob (view V2) on the same data source

| Step | Status | Notes |
|---|---|---|
| H0: per-(user, view) drafts via `resolve_graph`; overlay = main@fork ⊕ delta | Works | Fork-point isolation is correct. Concurrent resolves can create duplicate drafts (VIEWS-11, low). |
| H1: Alice edits → `POST /graph/changes` → one atomic commit with head CAS | Works for token-bearing edits | **Breaks:** <br>• Entities served from FalkorDB carry no OCC token, so updates fall back to a plain patch (WRITE-8/TESTS-12). <br>• No in-flight guard and no idempotency key, so double-submits and timeouts duplicate entities (FRONTEND-1, WRITE-7). <br>• Each save invalidates the cache for the whole data source, including main (GAP_E2E_COLLAB_TRACE-6). |
| H2: Bob deletes M; cascade runs live | Works | Deletes carry no token, and the cascade preview goes stale (FRONTEND-3). |
| H3a: Alice opens an MR | Breaks at scale | Full O(graph) `_compute_merge` (STORE-1). The UI cannot assign reviewers, so Approve never appears (FRONTEND-5/GAP_R4_R5_UI_AUDIT-4). |
| H3b: Bob publishes directly (locked, gated) | Works | Bypasses any open review (APIOPS-7). Any member can publish another user's private draft (MERGE-5). |
| H3c: Alice's merge → `NotUpToDate`; banner within 15 s | Works | |
| H3d: Alice pulls latest | **Breaks** | <br>• O(graph) work two or three times (STORE-1/WRITE-6). <br>• A concurrent save is reverted or deleted (GAP_E2E_COLLAB_TRACE-1/MERGE-2). <br>• Alice's new edge to M is dropped silently, with no conflict (MERGE-3). <br>• Resolutions carry no freshness token and default to "ours" (MERGE-4). <br>• The UI says "your edits were kept" and does not re-hydrate the canvas (GAP_E2E_COLLAB_TRACE-5). |
| H3e: merge on an earlier approval | Breaks | Approval is not bound to the head commit that was reviewed (MERGE-6/GAP_E2E_COLLAB_TRACE-3). |
| H4: layout overlay promote | Breaks | Best-effort with no retry (VIEWS-3). Reordering makes "draft wins" apply to every layer (VIEWS-2). A View Wizard save leaks the draft layout into Published (VIEWS-1). |
| H5: projection | Mostly works | Full-graph count on every pass (STORE-3). Re-pointing an edge leaves a ghost edge (PROJECTION-4). Main write-through is a dual writer (WRITE-3/PROJECTION-8). |
| H6: views refresh | **Breaks** | Other users and other tabs never refresh (FRONTEND-6, GAP_E2E_COLLAB_TRACE-4, VIEWS-12). A tab still on the merged draft keeps saving with HTTP 200 into a dead branch (GAP_E2E_COLLAB_TRACE-2). Search and display rules are wrong on drafts and return 500 on a draft over a lagging main (GAP_DRAFT_READ_SEMANTICS-1/2/3). |

### (c) Entity history after those merges

| Step | Status | Notes |
|---|---|---|
| Paginated, field-level revisions on main plus the current draft | Works | |
| Who actually authored a merged change | Breaks | Every squash row is credited to whoever published or merged, and the source-draft rows are unreachable (HISTORY-1/GAP_E2E_COLLAB_TRACE-8). A cascade during pull is blamed on the puller. |
| Imported, staged or sync-created entities | Breaks | Lookup is by URN, but those entities have `entity_id ≠ urn`, so their history is empty (HISTORY-2). |
| Moves and relationship changes on a node | Missing | HISTORY-5 |
| History of deleted entities | Unreachable | HISTORY-10 |
| Reversed edges | Breaks | History splits across two ids and properties are lost (FRONTEND-7). |
| Whole-graph timeline | Breaks | Fails past 500 commits; drafts are capped at 100 (HISTORY-4). Expanding the import commit runs out of memory (HISTORY-3). There is no as-of view (HISTORY-9). |

## 4. Top risks by theme

**Data loss and divergence** (critical)
- *Customer graph destroyed* (BOOTSTRAP-1, FALKORSCALE-2, GAP_PROJECTION_LEASE_FENCING-1, BOOTSTRAP-2, APIOPS-1, PROJECTION-1, LIFECYCLE-8, GAP_PROJECTION_LEASE_FENCING-2): eviction, rebuild, repin or an attacker-chosen pin runs `GRAPH.DELETE` or `DETACH DELETE` on keys the platform does not own, including during a copy.
- *Silent divergence* (PROJECTION-2, FALKORSCALE-7, STORE-10, TESTS-7, GAP_PROJECTION_LEASE_FENCING-3/4/6, WRITE-3, PROJECTION-8, WRITE-2): after a failover, RDB restore, key drop, lost lock or late direct write, reads serve stale or empty FalkorDB data while marked "fresh".
- *Durable writes stranded* (MERGE-1, GAP_E2E_COLLAB_TRACE-2, WRITE-1, LIFECYCLE-4, APIOPS-5, GAP_IMPORT_EXPORT-4): the save returns 200 but lands on a branch that can never reach main.
- *View corruption* (VIEWS-1, VIEWS-4, VIEWS-8): a wizard save or a restore writes the draft layout into Published, erasing other users' merged layout.
- *Purge broken or racy* (STORE-4/LIFECYCLE-2, LIFECYCLE-3, TESTS-8): permanent delete always returns 503, the reaper stops at the first failure, a half-purged graph can be "restored", and a restore that races the reaper is purged anyway.

**Concurrency and merge** (critical and high)
- GAP_E2E_COLLAB_TRACE-1, MERGE-2, WRITE-5: pull and checkpoint overwrite concurrent draft saves (no branch lock, `occ_guard=False`).
- WRITE-4: main validations read the head as it was before the lock was taken, so dangling edges or a second parent can reach main.
- MERGE-3, MERGE-10: deletes cascade over other users' edges and children; structural conflicts surface only at publish.
- MERGE-4, GAP_R4_R5_UI_AUDIT-3: stale conflict resolutions plus "ours" defaults overwrite collaborators.
- MERGE-5, MERGE-6, APIOPS-7, GAP_E2E_COLLAB_TRACE-3, WRITE-11, LIFECYCLE-11: drafts are not owner-protected, and the review gate is advisory and bypassable.
- WRITE-8, TESTS-12, MERGE-13, FRONTEND-3: OCC token is missing on reads served from FalkorDB and on deletes.

**History** (high)
- HISTORY-1, HISTORY-2, HISTORY-3, HISTORY-4, HISTORY-9: misattributed, empty, prone to running out of memory, or truncated.

**Scale and FalkorDB capacity** (critical and high)
- STORE-1, WRITE-6, MERGE-7, GAP_E2E_COLLAB_TRACE-9, APIOPS-9, GAP_IMPORT_EXPORT-10: O(graph) work in request paths, including one triggered by a reader clicking "Download template".
- FALKORSCALE-1, PROJECTION-5, GAP_PROJECTION_LEASE_FENCING-7: eviction does not reclaim memory, uses count budgets, and orders by write time.
- PROJECTION-6, FALKORSCALE-3, APIOPS-3, APIOPS-13, GAP_PROJECTION_LEASE_FENCING-10: an in-memory full seed on one 4 GiB worker and on 2 GiB web pods, with head-of-line blocking.
- FALKORSCALE-4/5/6/8: no URN indexes on a fresh key, no shard-memory governor, no placement control, and no Postgres fallback when a shard is down.
- STORE-2, STORE-3, PROJECTION-7, MERGE-8: costs that grow with history or quadratically, under the graph lock.
- APIOPS-10, GAP_PROJECTION_LEASE_FENCING-8/9, STORE-6: the graphver engine runs behind a transaction pooler with prepared statements enabled and no timeouts.

**Lifecycle** (high)
- LIFECYCLE-10, BOOTSTRAP-13: no disable or detach, retention, history backup, or scalable re-sync.
- LIFECYCLE-5/6, MERGE-12, GAP_R4_R5_UI_AUDIT-6: abandon is irreversible; the TTL sweep kills drafts that are under review.
- LIFECYCLE-7, APIOPS-14: forks are unbounded and orphaned by purge.
- LIFECYCLE-9, GAP_R4_R5_UI_AUDIT-1: branch lists return the oldest 100, hiding new drafts.

**Frontend** (high)
- FRONTEND-1/2: double-submit duplicates entities; publish drops unsaved edits.
- FRONTEND-6: no awareness of other users' changes.
- FRONTEND-7: reversing an edge loses its properties.
- FRONTEND-4/8, GAP_R4_R5_UI_AUDIT-4/5: inbox fan-out and an unbounded PR drawer.
- GAP_DRAFT_READ_SEMANTICS-1/2/3: draft search, display rules and counts are wrong.

**Import and export** (high)
- GAP_IMPORT_EXPORT-1/2/3: re-import ignores `baseVersion`; replace mode fails open to the whole data source and deletes quarantined rows' entities.
- GAP_IMPORT_EXPORT-5/6: duplicate concurrent jobs; imports cannot be resumed.
- APIOPS-6: an import can target main.

**Validation** (high)
- TESTS-1/2: the versioning integration and unit suites do not gate merges.
- TESTS-3: the real conversion path is untested.
- TESTS-4/5/6/7/8/9: no multi-user story, load, scale, chaos, lifecycle or browser tests.

## 5. Remediation roadmap

Effort scale: S < 3 days, M ≈ 1–2 weeks, L ≈ 2–4 weeks, XL > 1 month.

### Phase 0: data-safety blockers (ship before any production conversion or enabling eviction)

**P0.1 Guard the canvas and import write path** (S, no dependencies)
- **Covers:** MERGE-1, GAP_E2E_COLLAB_TRACE-2, WRITE-1, LIFECYCLE-4, APIOPS-5, GAP_IMPORT_EXPORT-4, APIOPS-6, and the owner part of MERGE-5.
- **`service._apply_ops_once`:** replace `s.get(BranchORM, bid)` with `select(BranchORM).where(id==bid, graph_id==graph_id).with_for_update(read=True)`. Raise `ValueError('unknown branch')` if missing, then call `_require_open`. Add an `allow_main=False` parameter to `apply_ops_detailed`: `/graph/changes` keeps the default, and provider write-through passes `True`.
- **Draft ownership:** thread `actor_groups` through and add `_require_owner_or_maintainer`. Apply it to private drafts in `apply_ops`, `publish`, `abandon_draft`, `_rebase_draft_once` and `open_draft_mr`.
- **Publish and merge:** in `publish._once` and `merge_mr._once`, re-load the draft with `with_for_update=True, populate_existing=True` after `_lock_graph`.
- **Queued publishes:** set `status='publishing'` in `_queue_publish`. Reset it to `open` on job failure.
- **Errors:** add `BranchNotOpen(ValueError)` and map it to 409 `branch_closed` in `graph.py` and `_domain_errors`.
- **Imports:** in `ImportExportService.create_import_job`, validate the branch (draft, open, same graph, `_require_edit`). Store `created_by` and refuse while an ingest is active (GAP_IMPORT_EXPORT-14 attribution comes with it).
- **Frontend:** on 409 `branch_closed`, keep the staged changes and switch to main, offering "copy to new draft". Add `status` to `branch_freshness`.
- **Proof:** extend `test_versioning_draft_abandon.py` with `apply_ops` cases for merged, abandoned, foreign graph, main via `/changes`, and a non-owner on a private draft. Add a forced interleaving of a publish read with a concurrent draft `apply_ops`.

**P0.2 Serialize draft writers** (S; depends on P0.1's branch lock)
- **Covers:** GAP_E2E_COLLAB_TRACE-1, MERGE-2, WRITE-5, the stage-seq part of WRITE-13.
- Add `_lock_branch(s, branch_id)` (`SELECT … FOR UPDATE`). Call it in `_apply_ops_once` (drafts), `_checkpoint_once`, `_rebase_draft_once` and `stage_changes`, then `s.refresh(branch)`.
- In `_rebase_draft_once`, read `own` once and pass it into the merge through a new parameter.
- Pass `occ_guard=True` to `_write_deltas` in rebase and checkpoint.
- Make `ix_wc_branch_seq` unique.
- **Proof:** about 20 gathered runs of `rebase_draft` against `apply_ops_detailed(create Q, update N with baseVersion)`. Assert Q is live and N.v2 survives. Repeat with checkpoint against apply.

**P0.3 Never destroy keys the platform does not own** (M, no dependencies)
- **Covers:** FALKORSCALE-2, BOOTSTRAP-1, LIFECYCLE-8, GAP_PROJECTION_LEASE_FENCING-1/2/4, BOOTSTRAP-2, APIOPS-1, the deletion part of PROJECTION-1.
- **`CacheManager.lru_candidates` and `resident_count`:** filter `owns_falkor_graph IS TRUE`, `last_projected_at IS NOT NULL`, `graphs.deleted_at IS NULL`, and `NOT EXISTS` an active bootstrap job.
- **`CacheManager.evict`:** re-check the same conditions inside the transaction. Take `pg_try_advisory_lock(hashtext('gvproj:'||gid))` around the status CAS (`UPDATE … WHERE status='idle' RETURNING`) and the drop. Reuse purge's `shared_with` check.
- **`request_projection_rebuild` and `ensure_projection_target`:** call `_assert_not_bootstrapping` (409).
- **`_project_graph_locked`:** return a no-op with `skipped='bootstrapping'` while a bootstrap job is pending, running or failed.
- **`service.create_graph`:** when `owns_falkor_graph=False`, park `projected=target=1`.
- **`POST /graphs`:** resolve the data source through `_data_source_in_workspace` and ignore client-supplied `falkorGraphName`/`falkorProvider`.
- **`_reconcile_in_place`:** when not owned, never delete `unkeyed` nodes and only delete keys that have version history on main. Add a destructive-first-seed valve: refuse when `expected` is empty but `actual` is not, or when deletes exceed 50% of the graph.
- **`project_pending`:** add `GraphORM.deleted_at IS NULL`.
- **Pinning:** refuse to pin a name that a live graph already pins, enforced by a partial unique index.
- **Proof:**
  - `evict_once` skips graphs with `owns=False`, graphs with a pending bootstrap, and graphs whose `project_graph` holds the lock.
  - Rebuild during bootstrap returns 409.
  - Run a FakeFalkor bootstrap with URN-less nodes and parallel edges, then Rebuild. Assert source node and edge counts are unchanged.
  - `POST /graphs` with a foreign name is rejected.

**P0.4 Make conversion complete or explicitly blocked** (M; depends on P0.3)
- **Covers:** PROJECTION-1, BOOTSTRAP-9, BOOTSTRAP-6, BOOTSTRAP-4, BOOTSTRAP-10, BOOTSTRAP-12.
- **URN-less nodes:** in `_phase_backfill`, mint `urn='gv:src:'+ID(n)` on them so they are copied. If that is rejected (see Decision 6), make `invisibleNodes/invisibleEdges > 0` a blocking validate check with an acknowledge flag.
- **Count parity:** make `reconcile.falkor_counts` count only `n.urn IS NOT NULL` nodes and `count(DISTINCT [a.urn,type(r),b.urn])` edges. Store an `unmanaged_baseline` at finalize.
- **Edge identity:** in `_edges_to_rows`, re-identify edges whose same id carries a different (src, type, tgt) tuple. In `_phase_heads`, `RETURNING` the inserted count and fail on a mismatch.
- **Write gate:** add a public `assert_writable` and call it at the top of `VersionedWriteProvider.update_edge`/`delete_edge`.
- **Source re-check:** add a `verify_source` phase that re-counts before finalize, and sample edges in `_verify_sample`.
- **`retry_bootstrap`:** take `FOR UPDATE`, bump `retry_count`, and refuse a live running job. Compare-and-set the phase advance, and check stored counts before finalize.
- **Bad values:** per-row conversion try/except, recorded as `unconvertible` reject samples instead of failing the whole job.
- **Proof:** the real-engine conversion test from TESTS-3. Seed the source with URN-less nodes, colliding ids, parallel edges, a bad `properties` blob, and a mid-copy edge DELETE. Assert zero loss or an explicit blocking refusal. The first publish must project with `published=True`.

**P0.5 Detect and fence projection divergence** (M–L; depends on P0.3)
- **Covers:** PROJECTION-2, FALKORSCALE-7, STORE-10, TESTS-7, GAP_PROJECTION_LEASE_FENCING-3/4/5/6, PROJECTION-3.
- **Fencing epoch:** add `projection_state.epoch`. Claim it with a CAS update in a short transaction before computing changes. Make the final write `UPDATE … WHERE epoch=:mine`; on 0 rows, nudge instead of publishing. Bump the epoch in `evict`, `request_projection_rebuild` and `ensure_projection_target`.
- **Projection marker:** write `MERGE (:_GVProjMeta{id:'meta'}) SET seq,epoch` as the last write of each pass (add it to `DERIVED_LABELS`), then `WAIT 1 <ms>` on the owning node's connection.
- **Liveness loop:** add `ProjectionWorker._liveness_loop`. Use `EXISTS` plus the marker sequence, and track `INFO run_id` per node. On a missing key or a lagging marker, reset `projected` to the marker sequence (or 0).
- **Wedge:** set `to_seq = max(target, main_head)`, delete `projection.py:589`, and add `failed_attempts`/`next_retry_at` backoff.
- **Admin:** add an endpoint that resets watermarks per provider or node. Update `FALKORDB_DR_RUNBOOK` §4/§5 to call it.
- **Proof (chaos, live PG plus FalkorDB):**
  - Out-of-band `GRAPH.DELETE`, `FLUSHALL`, and deleting 5 nodes or editing a property on an idle graph are each detected and reseeded within one liveness interval.
  - Evict injected between verify and the final write does not leave a fresh watermark.
  - A held-back graph advances once the cause is removed, with no new commit.

**P0.6 View layout integrity** (S, no dependencies)
- **Covers:** VIEWS-1, VIEWS-8, VIEWS-5, and the dead-branch part of VIEWS-3.
- In `view_repo.update_view`, replace `_keep_config_display_rules` with `_keep_config_layout` (the stored referenceLayout and entityScope win) and add `FOR UPDATE`.
- In the ViewWizard, pass the base config fetched without a branch.
- In `ViewVersionsDrawer.onSuccess`, re-fetch with the effective branch.
- Add `_require_branch_scope` on `branchId` for the view, layout and library routes, requiring an open branch for writes.
- **Proof:** a wizard edit with an active draft leaves Published referenceLayout and entityScope unchanged; a layout PUT to a merged or foreign branch returns 409/404.

**P0.7 Purge correctness** (S–M, no dependencies)
- **Covers:** STORE-4, LIFECYCLE-2, LIFECYCLE-3, TESTS-8, LIFECYCLE-13, APIOPS-11, LIFECYCLE-7 (parent purge).
- Add `'purge'` to `ck_jobs_type` and add a widen-only migration.
- Wrap each data source in `Reaper.run_once` in try/except.
- `create_purge_job(require_tombstoned=True)`: lock the graph row and skip it if restored. Revive failed jobs rather than inserting a new row. Treat any purge job as blocking restore.
- `_phase_meta`: cancel other jobs instead of deleting them. `_phase_count`: refuse when live forks exist.
- `get_graph` and `graph_in_workspace`: filter `deleted_at`.
- **Proof:** a new `test_graph_lifecycle.py` covering tombstone → restore → expire → reaper → 409 on restore, the reaper/restore race, a failed purge being resumed, and `alembic upgrade head` plus a `JobORM` insert for every job type.

**P0.8 Single writer to FalkorDB, and main lock correctness** (M, no dependencies)
- **Covers:** WRITE-3, PROJECTION-8, WRITE-2, WRITE-4.
- In `VersionedWriteProvider`, stop calling `self._inner.create/update/delete/save`. Return values composed from Postgres and call `nudge_projection`.
- In `_endpoint_op`, emit an op only when `entity_value` is None. Reject a `create` over a live entity unless the op says `upsert`.
- Raise a 404-mapped error instead of writing FalkorDB directly for edges missing from PG.
- Refuse versioned main writes when `VERSIONED_WRITES_ENABLED` is off.
- In `_apply_ops_once`, take `_lock_graph` before loading the graph, or refresh graph and branch after the lock.
- **Proof:** with a FalkorDB-shaped inner provider, `create_edge` on existing endpoints writes 0 node_versions. Two interleaved PATCHes converge to the PG value. A publish deleting N concurrently with `create_edge(X→N)` under the lock raises `ConcurrencyError`.

**P0.9 Client and import save safety** (M; depends on P0.1)
- **Covers:** FRONTEND-1, FRONTEND-2, WRITE-7, APIOPS-12, GAP_IMPORT_EXPORT-2, GAP_IMPORT_EXPORT-3, GAP_IMPORT_EXPORT-5.
- **Canvas save (`onConfirm`):** set `applyStatus` to `'applying'` with a re-entry guard. Remove only the change ids that were sent. Make close, Esc and backdrop no-ops while applying.
- **Idempotency:** send an `Idempotency-Key` with `timeoutMs` ≥ 120 s. On the server, look up `CommitORM.idempotency_key` per (graph, branch) and replay the stored `assigned` map.
- **Publish:** CommitDialog and PrDetailDrawer block publish or merge while unsaved edits exist.
- **Import replace mode:** add a fail-closed `_resolve_replace_view_scope`. Refuse `_delete_absent` when any rows are invalid or skipped. Keep `matched_eid` on invalid rows.
- **Concurrent imports:** add a partial unique index allowing one active ingest per branch. Resume the remembered job instead of re-uploading.
- **Proof:** vitest checks that a double click sends one POST and that a change staged mid-save survives. An integration test replays the same key and gets the same commit with no new entities. A replace-mode import with an invalid row and an unscoped view deletes nothing.

### Phase 1: correctness

**P1.1 Honest merges and conflicts** (M; depends on P0.2)
- **Covers:** MERGE-3, MERGE-10, MERGE-4, GAP_R4_R5_UI_AUDIT-3, GAP_E2E_COLLAB_TRACE-5.
- In rebase and in MR preview/open, run `_cascade_incident_edges`/`_cascade_containment` on a copy. Emit `delete/reference` and `delete/contains` conflicts for edges and children that main added after the draft's base. Run `_validate_edge_integrity` and turn violations into `structure` conflicts.
- In `_expand_moves`, use a deterministic containment edge id.
- Make edge endpoints atomic in `_merge_dict`.
- Add `expected_head_seq` plus per-conflict `theirs_hash` to `RebaseRequest`, and re-raise conflicts on a mismatch.
- ConflictResolver and ConflictChoices start with no picks, disable submit until every conflict is decided, require a guarded cancel, and show who made the incoming change.
- Return `cascaded` from rebase, show it in IncomingChangesSheet, and bump `mainEpoch` after a pull.
- Delete `find_dangling_edges` or start using it.
- **Proof:** full-lifecycle story steps (d)–(f) and move-vs-move (TESTS-4), plus a stale-resolution test.

**P1.2 Binding review gate** (M; depends on P0.1)
- **Covers:** MERGE-6, APIOPS-7, GAP_E2E_COLLAB_TRACE-3, WRITE-11.
- Add `approved_head_commit_id`. `merge_mr` refuses with `stale_approval` when the head moved. Reset approval on commits to a draft that has a live PR.
- Add `GraphORM.require_review`. `publish` refuses a draft whose live PR has reviewers.
- Recompute `pr.status` and conflicts after rebase.
- **Proof:** approve → new commit → merge returns 409; direct publish with a pending review returns 409.

**P1.3 Projection window correctness** (S)
- **Covers:** PROJECTION-4, PROJECTION-13, FALKORSCALE-11.
- In `_compute_changes`, fetch before-values for upserts and emit an anchored delete when (src, tgt, type) changed. Reject URN changes on update.
- Add BFS from draft lineage edges in `_overlay_trace`.
- Call `stamp_graph_written` after projection writes.
- **Proof:** FakeFalkor plus live tests for an edge re-point and an edge retype.

**P1.4 History completeness** (M)
- **Covers:** HISTORY-1, GAP_E2E_COLLAB_TRACE-8, FRONTEND-11, TESTS-10, HISTORY-2, HISTORY-5, HISTORY-6, HISTORY-7, HISTORY-10, FRONTEND-7.
- **`entity_history_page`:** select `contributors`, `source_branch_id` and `source_commit_ids`. Attach `authored_revisions` from the source branch via `ix_nv_entity_hist`. Add a fork-parent union.
- **Entity id resolution:** add `_resolve_entity_id` (raw → `svc._eid_for_urn` → newest row by URN, including deleted entities).
- **Relationships:** `include=relationships` over `ix_ev_source`/`ix_ev_target`, with moves collapsed into one event.
- **Provenance:** `_write_deltas` takes `actor_by_entity`/`reason_by_entity` (checkpoint, cascade, `sync_override`). Revert records `source_commit_ids`.
- **Indexes and lookup:** index `ix_mr_resulting_commit`. Add `entities/lookup?includeDeleted`.
- **Reverse edge:** preserve properties using `ref`, or add a server-side `reverse` op that keeps `entity_id`.
- **UI:** "changed by A · merged by C via PR", plus a History action in ChangeTreePanel.
- **Proof:** A edits → MR → B merges, then assert history shows `actor=B, authored_by=[A]`. Import with an `ent_` id and look up by URN. Revert links to its target. A reversed edge keeps its properties.

**P1.5 Draft read semantics** (M)
- **Covers:** GAP_DRAFT_READ_SEMANTICS-1/2/3/4/6/7/8, PROJECTION-9.
- Add `deep_search_*` stubs to `VersionedBranchProvider` that raise `NotImplementedError`, and a `_base_op` helper in the overlay so a draft gets a 501 instead of a 500.
- Apply `_patch_hits` and evaluate membership for touched URNs with `common.search_semantics.evaluate`.
- Handle `moved_out`/top-level candidates.
- Rewrite `_matches` to be case-insensitive and to include tags.
- Pass search and sort through to `get_children_with_edges_from_state`.
- Share a keyset cursor helper.
- In `useDisplayRuleEngine`, include branch and content token in the signature.
- Raise the LRU size and share the rewind part of the delta.
- **Proof:** draft rename, create and delete with search, rules and counts. Moves out of a parent and to the top level. A cursor that crosses a freshness flip.

**P1.6 Conversion fidelity and sync** (L; depends on P0.4)
- **Covers:** BOOTSTRAP-5, BOOTSTRAP-7, BOOTSTRAP-8, BOOTSTRAP-3.
- Skip canonicalization during bootstrap, or add an `align` phase.
- Pass `identity_property` through to the bootstrap; refuse with 422 until that is supported.
- Fold native edge properties and the full label list into the payload.
- In `_mark_removed_properties`, limit `gone` to keys from the previous PG payload.
- Resync uses an ID-windowed scan, canonicalization, and a mass-delete ratio guard.
- **Proof:** the real-engine bootstrap → resync identity test returns zero deltas.

**P1.7 OCC everywhere** (M)
- **Covers:** WRITE-8, TESTS-12, MERGE-13, FRONTEND-3, FRONTEND-9.
- The projector stores `gvContent=content_hash`, and the reader maps it to `version`; alternatively the overlay stamps versions from heads.
- Deletes carry `baseVersion` and are enforced in `_apply_ops_once`.
- `_fold_shared` and `sync_ingest` use `_settle_conflicts`.
- Re-read truncated entity views (more than 500).
- **Proof:** `test_occ_token_on_every_read.py`; two shared-draft editors on the same field get a conflict.

**P1.8 Main-advancing utilities** (S)
- **Covers:** WRITE-9, MERGE-9, HISTORY-8, WRITE-10, BOOTSTRAP-13 (re-baseline part).
- Wrap revert, restore, sync and bulk ingest in `_retry_seq` with `_lock_graph` and `refresh`.
- Add `expected_head_seq` to restore.
- Make revert field-level with `three_way_merge`.
- `bulk_ingest` refuses non-empty graphs.
- Add `SET LOCAL lock_timeout` in `_lock_graph` (GraphBusy → 503) and jitter in `_retry_seq`.

**P1.9 View merge** (M; depends on P0.6)
- **Covers:** VIEWS-2, VIEWS-3, VIEWS-4, VIEWS-6, GAP_E2E_COLLAB_TRACE-10, GAP_DRAFT_READ_SEMANTICS-9.
- Strip `order` before comparing layers, merge each layer field by field, and return conflicts.
- Add `rebase_overlay` to the rebase endpoint.
- `draft_views.settle` promotes every overlay on a merged branch.
- Add `layout_rev` with optimistic concurrency (`baseRev`, 409 on mismatch, re-apply).
- Use `merged_effective_config` for the review diff.

**P1.10 Import correctness** (M–L)
- **Covers:** GAP_IMPORT_EXPORT-1, -6, -7, -8, -9, -13.
- Feed `baseVersion` into a 3-way merge in `resolve_rows`; produce `conflict` rows; handle "deleted since export".
- Re-open the snapshot per window.
- Quarantine rows on `OntologyViolation` and bisect on concurrency errors.
- Pass containment and ontology resolvers to `apply_ops`.
- Resume from a cursor and take over stale jobs.
- Honour the exported `entity_id` on restore.

### Phase 2: scale

**P2.1 Bounded collaboration operations** (L; depends on P0.2)
- **Covers:** STORE-1, WRITE-6, MERGE-7, GAP_E2E_COLLAB_TRACE-9, FRONTEND-8 (server side), APIOPS-9.
- Use `_compute_merge_bounded` plus `_hydrate_merge_neighborhood` in `_rebase_draft_once`, `open_draft_mr`, `preview_mr`, `preview_merge` and `_pr_merge_states`. Also use `_augment_containment_skeleton` and the `DIFF_TREE_MAX_CHANGES` guard.
- Use `_commit_merkle` instead of `_merkle_root`, and `_current_values` instead of `_composed_state` in checkpoint.
- Add an LRU cache of the PR diff index keyed by (pr_id, head_commit_id, main_head).
- Add index `(graph_id, branch_id, entity_id, commit_seq DESC) INCLUDE (op,id)`.
- **Proof:** a GRAPHVER_E2E test at ≥1M entities shows bounded RSS (< 200 MB delta) and p95 < 5 s for save, rebase, open MR and `diff_pr_children`.

**P2.2 Bound every whole-graph endpoint** (M)
- **Covers:** HISTORY-3, HISTORY-9, GAP_IMPORT_EXPORT-10, APIOPS-9, HISTORY-4, GAP_R4_R5_UI_AUDIT-14.
- Commit diff: count first, then return `tooLarge` built from a `GROUP BY`.
- `build_template` reads through `open_snapshot`, one page only.
- `/state` requires MANAGE and is capped by `STATE_MAX_ENTITIES`.
- `bulk-ingest`/`sync` stream the request body.
- Add `before_seq` keyset to `commit_log` and use `useInfiniteQuery` in the UI.

**P2.3 Projector efficiency** (M)
- **Covers:** STORE-2, STORE-3, PROJECTION-7, PROJECTION-12, FALKORSCALE-4, MERGE-8.
- Rewrite `_as_of_many` as `LATERAL … LIMIT 1` and add index `ix_merkle_asof_v2 … INCLUDE (hash)`.
- Run the count verify only on full seeds, heals and audits; incremental passes verify only the touched ids.
- Batch endpoint resolution.
- Add `_ensure_urn_indexes` and halve the batch size on timeout.
- Make the hierarchy gate a single pass with memoized parent chains.

**P2.4 Working eviction and capacity governance** (L; depends on P0.3/P0.5)
- **Covers:** FALKORSCALE-1, PROJECTION-5, GAP_PROJECTION_LEASE_FENCING-7, GAP_R4_R5_UI_AUDIT-12, FALKORSCALE-5, FALKORSCALE-6, LIFECYCLE-7/APIOPS-14 (fork limits).
- `project_pending` filters `status != 'evicted'`.
- ContextEngine serves Postgres for evicted graphs and nudges the worker to rehydrate.
- Add `last_read_at`, touched at most every 60 s.
- Byte budgets per owning node (`GRAPH.MEMORY USAGE`, `INFO memory`), with an advisory leader lock on `evict_once`.
- A `ProjectorWriteGovernor` reuses `shard_capacity.hold_reason` and `admission.write_slot`, with a per-node semaphore.
- Fork route requires MANAGE, with a quota and a capacity pre-check.
- Add a relocate/adopt endpoint (platform key `gvp_<id>{tag}`, recorded in `shard_map`).
- **Proof:** evict → `reconcile_once` → the graph stays evicted. Locust "500-graph rotation" holds per-shard `used_memory` under 80%. A seed during BGSAVE waits.

**P2.5 Worker topology and streaming seed** (L)
- **Covers:** PROJECTION-6, FALKORSCALE-3, APIOPS-3, APIOPS-13, GAP_PROJECTION_LEASE_FENCING-10, PROJECTION-10, BOOTSTRAP-11.
- Fast path for an empty key: keyset-stream heads joined to versions, per page.
- Bucketed diff for non-empty keys.
- `asyncio.to_thread` for item building.
- Replace the per-pass gather with a semaphore dispatcher and separate pools for seeds and windows.
- Web pods only nudge for full seeds and rebuilds; replace in-process sets with locks.
- `VERSIONING_WORKER_ROLES` to split into separate Deployments.
- `/healthz` on `WORKER_HEALTH_PORT`, plus probes and a PodDisruptionBudget.
- Prioritise publish in `TransferRunner`.
- Run bootstrap windows concurrently.
- **Proof:** a 5M-entity full seed has peak RSS < 1.5 GiB; small graphs keep projecting during the seed.

**P2.6 Data tier hygiene** (S–M)
- **Covers:** APIOPS-10, GAP_PROJECTION_LEASE_FENCING-8/9, STORE-6, FALKORSCALE-9, GAP_E2E_COLLAB_TRACE-6, FALKORSCALE-10, STORE-5.
- Pass `_asyncpg_connect_args` to `versioning/db.get_engine` (`statement_cache_size=0` under the pooler, plus timeouts).
- `SET LOCAL statement_timeout`.
- Pool ≥ 2×`PROJECTION_CONCURRENCY` + slots.
- One `read_routing` query with a 1–2 s TTL cache.
- Branch-scoped cache generation keys.
- Shared cluster clients and an explicit `maxclients`.
- Run graphver migrations against `graphver_db_url`.

**P2.7 Availability fallbacks** (M)
- **Covers:** FALKORSCALE-8, PROJECTION-11.
- On `ProviderUnavailable`/`ProviderLoading` for a versioned source, serve `VersionedBranchProvider` with a degraded flag. Add a `FallbackProvider` for errors at query time.
- **Proof:** stop one master in the cluster compose file; canvas reads on graphs hashed to it return 200.

**P2.8 Lists, inbox and storage** (M–L)
- **Covers:** LIFECYCLE-9, GAP_R4_R5_UI_AUDIT-1, FRONTEND-13, GAP_E2E_COLLAB_TRACE-7, FRONTEND-4, GAP_R4_R5_UI_AUDIT-5, STORE-7, STORE-8, GAP_IMPORT_EXPORT-11, GAP_IMPORT_EXPORT-12, APIOPS-2, APIOPS-4.
- `list_branches`: status filter, visibility in SQL before LIMIT, newest first, keyset paging.
- MR list `activeOnly`; workspace-wide paged MR endpoint.
- Merkle leaf bucket nulling and draft-head retention.
- Drop redundant indexes and BRIN; use ULID bootstrap ids.
- Helm chart gains a versioning-worker template.
- Prometheus gauges for lag and jobs, plus alerts.
- Object store off the management DB; sweep orphaned `import_rows`.

### Phase 3: UX and lifecycle

- **P3.1 Data-source lifecycle hub** (XL)
  - **Covers:** LIFECYCLE-10, BOOTSTRAP-13, GAP_R4_R5_UI_AUDIT-8/13, LIFECYCLE-12, LIFECYCLE-14.
  - Tabs: Overview, Drafts, History, Data health, Import/Export.
  - `POST /graphs/{gid}/disable` (soft delete, history kept).
  - Windowed resync as a worker job (`job_type='sync'`).
  - Full-history export and import.
  - A retention job, per Decision 3.
  - Moving a data source updates `graphs.workspace_id`.
  - Correct delete-impact counts.
  - Pre-flight item count and a Cancel button during bootstrap.
- **P3.2 Draft lifecycle** (M)
  - **Covers:** LIFECYCLE-5, LIFECYCLE-6, MERGE-12, GAP_R4_R5_UI_AUDIT-6, LIFECYCLE-11, GAP_R4_R5_UI_AUDIT-2.
  - Add `reopen_draft`. Abandon closes live PRs and soft-deletes draft-only views.
  - The sweep skips drafts with a live MR, tombstoned graphs, and deployments with the flag off; warn 7 days ahead.
  - Members UI.
  - Fix the shared/private semantics.
- **P3.3 Review workflow** (L)
  - **Covers:** FRONTEND-5, GAP_R4_R5_UI_AUDIT-4/5, FRONTEND-8 (client side).
  - Reviewer picker; PATCH reviewers; drawer uses ChangeTreePanel with summary and children; virtualized lists; comments anchored to an entity or field path.
- **P3.4 Live awareness** (M)
  - **Covers:** FRONTEND-6, GAP_E2E_COLLAB_TRACE-4, VIEWS-12.
  - `useMainHeadWatch`: 30 s poll plus refetch on focus, then a "Published updated — Refresh" chip, or an automatic epoch bump when nothing is staged.
- **P3.5 Design-system and accessibility pass** (L)
  - **Covers:** GAP_R4_R5_UI_AUDIT-7/9/10/11, FRONTEND-12, FRONTEND-10, HISTORY-11, GAP_IMPORT_EXPORT-15.
  - `ui/ModalShell` and `DrawerShell` built on `useModalA11y`.
  - `DangerConfirmDialog` for every destructive action.
  - Re-token StagedChangesPanel and ConflictChoices.
  - `Button`, `TimeStamp`, `EmptyState`, `Skeleton`.
  - Error states with Retry.
  - Per-user, per-tab IndexedDB snapshots.
  - Import progress and a downloadable rejected-rows file.
  - Entity-type editor.

### Phase 4: validation hardening

Covers TESTS-1..13, WRITE-12, HISTORY-13, PROJECTION-14, FALKORSCALE-12, GAP_PROJECTION_LEASE_FENCING-12, VIEWS-9 and GAP_E2E_COLLAB_TRACE-11. The detail is in section 6. Effort is L overall, started in parallel with Phase 0, because each Phase 0 item ships with its test.

## 6. Validation plan

### CI gates
- **`versioning-unit` (required, S):** add the files listed in TESTS-2 to `ci-required-files.txt` (`test_versioning_core`, `test_versioning_concurrency`, the bootstrap, projection and purge unit tests). `test_ci_required_list.py` asserts every pure versioning unit file is listed.
- **`versioning-e2e` (informational now, required after Phase 0):**
  - Services: postgres:16 and falkordb v4.18.11, `GRAPHVER_E2E=1`, `alembic upgrade head`.
  - Runs `ci-versioning-e2e-files.txt`, which must list every GRAPHVER_E2E file (enforced by `test_ci_required_list`).
  - Fix `test_versioning_write_through.py` first.
- **`versioning-cluster` (nightly):** `docker-compose.falkordb-cluster.yml` (3 masters with replicas), running the projection, eviction, liveness and fallback suites.

### Integration tests (live PG, FakeFalkor or real FalkorDB)
- `test_apply_ops_branch_guards.py`: closed, foreign, main and non-owner branches; a save racing a publish read. **Pass:** no commit reaches a non-open branch.
- `test_draft_writer_races.py`: rebase ∥ apply, checkpoint ∥ apply, 20 forced interleavings. **Pass:** every acknowledged write is either in the draft head or rejected.
- `test_versioning_full_lifecycle.py`, as designed in docs/09:
  - alice/bob/carol drafts across two views, disjoint auto-merge, same-field conflict;
  - delete vs modify, cascade vs edit, edge to a deleted node, move vs move;
  - MR with reviewer and stale approval, revert and restore;
  - entity history attribution, layout promote, projection equal to main.
  - **Pass:** zero silent overwrites. Every cross-user clash surfaces as a conflict or a 409. FalkorDB equals the PG main state field by field.
- `test_bootstrap_resync_live.py`, on real FalkorDB:
  - source with multi-label nodes, propertiesRaw values, URN-less nodes, parallel and colliding edge ids, case-drifted labels, ID reuse;
  - bootstrap, then a field-by-field comparison;
  - resync of an unchanged source gives 0 deltas; 3 mutations give exactly 3 deltas;
  - Rebuild leaves source counts unchanged.
- `test_projection_safety_live.py`: evict or rebuild mid-bootstrap; non-owned eviction refused; edge re-point and retype; held-back graph retry; evict → `reconcile_once` keeps the graph evicted.
- `test_graph_lifecycle.py`: tombstone, restore, reaper, purge resume, the reaper/restore race, parent purge with live forks, data-source move.
- `test_entity_history_lineage.py`: import → shared-draft squash → MR merge → revert → restore → fork inherit; lookup by URN for an `ent_` id.
- Scale tests (nightly perf environment): a 1M-entity graph for save, rebase, open MR, `diff_pr_children`, commit diff summary and template. **Pass:** RSS delta < 200 MB, p95 < 5 s. A 5M-entity full seed peaks below 1.5 GiB RSS. 20k CONTAINS edges publish in < 60 s under the lock.

### Chaos tests (`RUN_CHAOS_TESTS`, cluster compose)
- Shard master kill with replica promotion mid-window.
- `FLUSHALL` or `GRAPH.DELETE` out of band.
- RDB restore from an older snapshot.
- `pg_terminate_backend` on the projection lock session mid-apply, with a concurrent pass.
- Worker SIGKILL during a bootstrap window, import window and publish job.
- Graphver pooler restart.

**Pass:** no permanent divergence. The liveness loop detects it within one interval and reseeds. No duplicate rows appear. Jobs resume or report the correct terminal state, and a publish interrupted after commit reports `completed`, per TESTS-11.

### Frontend
- Vitest/RTL:
  - EnableVersioningFlow, DataSourceVersioningTab, PrDetailDrawer (approval gate, 409 `not_up_to_date`), PublishDraftDialog;
  - CommitDialog with unsaved edits;
  - double-submit Save; ConflictResolver requiring every pick;
  - `useDisplayRuleEngine` asks again after an edit;
  - error states for 503 on each surface.
- `vitest-axe` smoke test for each dialog: Escape, focus trap, labels.
- An OpenAPI contract test for fields used in `versioningApiService.ts`.
- Playwright (nightly, docker compose):
  - enable version control on a seeded graph;
  - two browser contexts (Alice V1, Bob V2) edit, raise a PR, publish, pull, resolve and merge; both canvases refresh within 30 s;
  - cascade delete with review;
  - lifecycle: archive, reopen, disable, restore from trash.

### Load (Locust, opt-in `versioning_collab` scenario)
- 300 users across 50 graphs, 20 of them on one hot graph. Edit via `/graph/changes` (50% with `baseVersion`), publish with p = 0.05, pull on 409. A second profile has readers on 500 graphs.
- Post-run audit: every acknowledged published write is present on main and in FalkorDB.
- **Pass:**
  - 0 lost acknowledged writes;
  - `ConcurrencyError` rate < 0.1%;
  - publish p95 < 3 s for ≤ 1k changes;
  - projection lag p95 < 15 s;
  - canvas read p95 < 500 ms (cached) and < 1.5 s (cold);
  - zero 5xx;
  - graphver pool wait p99 < 1 s;
  - per-shard `used_memory` < 80% with eviction on.

### Declaring R0–R6 operational
| Req | Condition |
|---|---|
| R0 | Conversion and chaos suites green, with real-engine fidelity |
| R1 | Lineage suite green |
| R2 | Lifecycle story, race tests and load audit green |
| R3 | Playwright collaboration flow and RTL green |
| R4 | axe and visual review of the P3.5 surfaces |
| R5 | Lifecycle suite plus Playwright lifecycle |
| R6 | Scale benchmarks plus the 500-graph rotation load test within budgets |

## 7. Open product decisions

1. **Draft authorization model:** private drafts owner-only, with or without an admin override? Should `workspace_member` keep `datasource:manage`, which today makes every member a "manager" who can publish, revert or restore main? Do we need a separate `datasource:publish` permission and a per-graph "protected main / require review" setting (MERGE-5, APIOPS-7)?
2. **Delete-vs-reference policy:** should deleting a node that other users have linked to since the draft's base raise a conflict (proposed) or delete with a notice (MERGE-3)? Should parallel same-type edges be supported (BOOTSTRAP-6, GAP_IMPORT_EXPORT-13)?
3. **History retention:** keep merged and abandoned draft rows forever (full authorship provenance, HISTORY-1) or compact them after N days? What retention, archival tier and backup format for the ~500 GB budget (STORE-7, LIFECYCLE-10)?
4. **Restore and revert semantics:** field-level revert (proposed), restore requiring an expected head, and whether a restore also rolls back promoted view layouts (MERGE-9, VIEWS-7).
5. **Converted-graph ownership:** keep projecting into the customer's original key (non-evictable, collides with external writers) or "adopt" into a platform-owned `gvp_<id>{tag}` key (evictable, relocatable, enables placement)? After conversion, are external writers blocked, detected and flagged, or ingested by scheduled resync (BOOTSTRAP-8, FALKORSCALE-6)?
6. **Entities without an identifier at conversion:** mint `gv:src:<ID>` URNs, or refuse conversion until the customer fixes them (PROJECTION-1)?
7. **FalkorDB sizing and placement:** raise maxmemory toward 48–56 GB per shard (currently 32 GB, about 96 GB usable), or accept eviction as the norm? Use hash-tag placement for related graphs or least-loaded placement? Read-triggered rehydrate versus a pre-warmed hot set (FALKORSCALE-1/6)?
8. **Partitioning:** HASH(graph_id) across 64 partitions puts a hot graph in one partition with one autovacuum worker. Keep it, or sub-partition the largest graphs by branch or seq (STORE-11)?
9. **View layout merge:** keep "draft wins" per entry, or surface layout conflicts and block promote until resolved (VIEWS-2)? Should view versions be enabled by default (VIEWS-9)?
10. **Fork policy:** who may fork, quotas, and whether forks get FalkorDB copies at all or are served from Postgres until "materialized" (LIFECYCLE-7, APIOPS-14).
11. **Freshness tolerance:** keep strict `projected >= committed`, which sends every read to Postgres after each publish, or allow bounded lag with a catch-up overlay on FalkorDB (GAP_DRAFT_READ_SEMANTICS-2, PROJECTION-7)?

### Critical Files for Implementation
- /home/user/dataviz/backend/app/services/versioning/service.py
- /home/user/dataviz/backend/app/services/versioning/projection.py
- /home/user/dataviz/backend/app/services/versioning/cache_manager.py
- /home/user/dataviz/backend/app/services/versioning/bootstrap_worker.py
- /home/user/dataviz/backend/app/api/v1/endpoints/graph.py
