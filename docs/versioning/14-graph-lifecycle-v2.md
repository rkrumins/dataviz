# Versioned Graph Lifecycle v2 (CONVERSION): final spec

## Summary

This spec covers the full lifecycle of a FalkorDB graph a customer already owns:

1. **Preflight.** A read-only check of the customer's graph.
2. **Lossless convert.** The graph is copied into Postgres (graphver), which becomes the source of truth. Copy passes are repeated until they match the live source ("re-scan converge").
3. **Seed.** The Postgres copy is written into a new platform-owned FalkorDB key, `gvp_<gid>{<gid8>.<n>}` (D1).
4. **Prove.** Full parity checks plus shadow read probes.
5. **Cutover.** One atomic switch of reads. Writes reopen after a 10 s settle. While nothing has been published since cutover, reads can go back to the original instantly.
6. **Operate.** Health checks, relocate, blue/green rebuild, owned-only eviction, drift scans, verified history export.
7. **Exit.** Release the original key (forget it or delete it), freeze, detach, trash, restore, purge.
8. **Adopt.** Graphs converted under the old model are moved onto platform-owned keys.

**Design base: STATEMACHINE, plus four grafts from SAFETY.**
- Lifecycle state and read routing live only in graphver. They change by compare-and-set (CAS) on `lifecycle_rev`.
- One KeyMigration primitive (place, seed, catchup, parity, swap, retire) serves convert, adopt, relocate, reseed and detach.
- `projection_state.falkor_graph_name` stays NULL until the swap. The projector already skips unpinned graphs (`projection.py:462-474`, verified: a missing name falls back to `gv_<id>`, which returns `skipped:'unpinned'`).
- Grafted from SAFETY:
  - `ReadOnlySourceClient`, which only sends `GRAPH.RO_QUERY`;
  - a `_GVProjMeta.graph_id` ownership marker;
  - release gated on an export and a final drift scan;
  - an evidence download.

**This revision applies the integration contracts:**

| Topic | What this spec now does | Issues |
|---|---|---|
| Migrations | Single migration chain | X-01, X-02 |
| Errors | `versioning/errors.py` with the §6 codes | X-03 |
| Permissions | §2 matrix: convert, cutover, rollback, relocate and freeze are now P; release, detach, delete, export and restore are A | X-04, X-20 |
| Drift sync | No system drafts. Drift sync runs only through a `falkordb_snapshot` ingest binding via `apply_source_delta` | X-06, X-07 |
| Adopt on protected graphs | Repair lands in a draft owned by the requesting human, plus a PR | X-06 |
| Ingest coupling | Transitions pause, resume and retire ingest sources | X-08 |
| Edge identity | Triple lookup before minting, via `versioning/identity.py` | X-09 |
| Storage | Budgets are set at T1; `finalize_pg` sets `storage_bytes_est` | X-11 |
| Compaction | `cutover_seq` is protected; compaction pauses while lifecycle jobs run | X-12 |
| Audit | `lifecycle_events` is the single lifecycle sink | X-13 |
| Purge | Covers every new table | X-14 |
| Concurrency and keys | `graphs FOR KEY SHARE` vs `FOR UPDATE`; idempotency keys | X-15, X-16 |
| UI capability data | One `access{can, reasons, required}` envelope replaces `allowedActions` | X-17 |
| Hub | Uses the §16 tab layout; DriftInbox is dropped | X-18 |
| Draft/PR coupling | Detach closes PRs and abandons drafts (`graph_detached`) | X-22 |
| History export | A only; full bundle | X-23 |
| Read routing | Composed as defined | X-24 |
| Actors | `system:lifecycle` and principal snapshots | X-26 |
| Gate order | §7 | X-27 |
| Worker roles | Single role and claim map | X-28 |
| Ontology | Shared `ontology_containment_missing` code | X-30 |

## Goals / non-goals

### Goals
1. **One CAS-guarded lifecycle state per graph.** It answers three questions: who may write, which store serves reads, and which FalkorDB keys the platform owns and may evict or drop.
2. **Zero silent loss from source to Postgres.** Every row either converts losslessly or becomes a per-row `conversion_issues` entry. Anything that changes how data is represented needs an acknowledgement before conversion proceeds.
3. **Full parity.**
   - Source vs Postgres: per-window counts plus order-independent digests, computed through an independent inverse mapping.
   - Postgres main vs the new key: counts plus a `gvHash` comparison for every entity.
4. **D1.**
   - The customer key is read only through RO queries.
   - It is written or deleted only by `release_source(mode=delete_key)`, which is A, type-to-confirm, eligible-only and audited.
   - Derived writes (rollups) never target it.
5. **Atomic cutover.** A route-settle fence before writes open; instant rollback to the source while `main_head == cutover_seq`; rollback to Postgres always available.
6. **Operate at 500+ graphs on 3 × 64 GB.** Capacity-aware placement, owned-only eviction, relocate, blue/green rebuild, liveness checks, drift detection, verified history export.
7. **Safe exits.** Freeze, detach (handover / materialize / restore_source), re-attach, trash, restore, purge, with ownership-proof drop guards.
8. **Clean coupling with ACCESS and INGEST.** Drafts, PRs and ingest sources follow the §9 matrix exactly.

### Non-goals
- Kafka and OpenLineage internals. INGEST owns them; this spec defines only the binding hand-off.
- Non-FalkorDB sources. `_assert_copyable` (`graph.py:333`) keeps refusing them.
- Distinct parallel edges in the projection. The triple collapse in `reconcile.py:92-146` is unchanged and disclosed.
- No GRAPH.COPY or RENAME. Every key move is seed + swap.
- No per-request dual reads.
- No change to merge, review or overlap semantics.

## Concepts, roles & state machines

### 1. Axes

| Axis | Stored in | Drives |
|---|---|---|
| Lifecycle state | `graphs.lifecycle_state`, `lifecycle_rev`, `read_store`, `prior_state` | Writability, read store, owned keys |
| Lifecycle job | `jobs` (`job_type` ∈ {preflight, lifecycle, bootstrap(v1 drain), purge}, `op`, `current_phase`) | Progress, resume, cancel |
| Projection health | `projection_state` (watermark, epoch, liveness, parity, candidate, retired_keys) | Only `fresh` and the read route. Never the lifecycle state. |

### 2. Principals (shared §1)
- **Humans** act as `<user_id>`.
- **Lifecycle jobs** write as `system:lifecycle` (`actor_kind='system'`), with `source_ref.requested_by=<user>`.
- **Drift sync commits** are `svc:ingest:<sid>`.
- The bare `system` actor is never written again.
- **Human-created jobs** store `summary.principal = Principal.snapshot()`. Each re-authorizes from that snapshot under the lock before its irreversible phase:
  - swap (convert cutover, adopt, relocate, reseed);
  - release `delete`;
  - detach `repoint`.

### 3. States (shared §9, with conversion specifics)

| State | Human writes; create/reopen draft; merge | `read_store` | Owned keys evictable | Projector | Ingest sources | TTL sweep / compaction |
|---|---|---|---|---|---|---|
| `converting` | 409 `graph_not_writable` (reason `converting`) | `source` | No | Skips (unpinned) | Activation refused | Skip / skip |
| `ready` | 409 (`awaiting_cutover`) | `source` | No | Skips | Refused | Skip / skip |
| `live` | Allowed once `writes_open_at ≤ now`; before that `cutover_settling` + Retry-After | `projection` \| `postgres` | Yes (primary) | Runs; dual-writes the candidate | Activatable if owned | Yes / yes |
| `live_legacy` | Allowed | `source` (legacy projection key) \| `postgres` | **Never** | Runs under plan 0.3 guards | `projection_not_adopted` | Yes / yes |
| `frozen` | 409 (`frozen`) | As `prior_state` | Yes if owned | Runs (idle) | Auto-paused `lifecycle:frozen` | Skip / yes |
| `detaching` | 409 (`detaching`). With `force`: PRs closed and drafts abandoned (`graph_detached`) | As `prior_state` until the swap | No | Only for the materialize copy | Paused | Skip / skip |
| `detached` | 409 (`detached`); invisible to `get_graph_by_data_source` | n/a | None owned | Skips | Retired | Skip / skip |
| `trashed` | 409 (`trashed`); drafts and PRs kept | n/a | Yes, evicted first | Skips | Auto-paused; resumed on restore | Skip / skip |
| `purging` | 409 (`purging`) | n/a | Dropped by purge | Skips | Rows deleted | n/a |

- Blank and fork graphs are born `live` with owned keys (`create_graph`, `service.py:336`).
- A data source with no graph row is non-versioned.

**`physical_key(ds, purpose)`**

| | `read` | `derive` |
|---|---|---|
| `converting` / `ready` | source key | **None** (refused: 409 `conversion_in_progress`) |
| `live_legacy` | legacy key (`ps.falkor_graph_name`) | legacy key |
| `live` | `ps.falkor_graph_name` | owned key, or an internal `target_graph_key` |
| `frozen` | as `prior_state` | owned key |
| `detaching` / `trashed` / `purging` | as above where applicable | None |
| no graph row | `ds.graph_name` | `ds.graph_name` |

### 4. Transitions
Every transition goes through `lifecycle_state.transition(s, gid, frm, to, *, op, principal, job_id, reason, expected_rev=None, **cols)`.

**Lock and gate order (§7/§8):**
1. gvproj session lock (only if this is a swap).
2. `_lock_graph` (`service.py:5370`).
3. `SELECT … FROM graphs WHERE id=:g FOR UPDATE`.
4. Compare `lifecycle_rev`; a mismatch returns 409 `version_conflict {resource:'lifecycle', currentVersion}`.
5. State guard; failure returns the action's state code.
6. CAS `UPDATE … SET lifecycle_rev=lifecycle_rev+1`.
7. Same-transaction side effects through registered hooks:
   - ingest_sources pause/resume/retire plus `ingest_source_revisions` (hook registered by INGEST S1);
   - PR and draft closure on forced detach;
   - `ingest_redrive` enqueue on entering a writable state;
   - one `lifecycle_events` row.

`FOR UPDATE` conflicts with the draft writers' `FOR KEY SHARE`, so a transition waits for in-flight draft saves (X-15).

| # | From → To | Trigger | Guards | Side effects |
|---|---|---|---|---|
| T1 | ∅ \| `detached` → `converting` | `POST …/conversions` | P; preflight ≤24h with the same `FIDELITY_VERSION`; acks; capacity (FalkorDB, PG budget, fleet); no other graph row | `create_graph(lifecycle_state='converting', read_store='source', falkor_graph_name=NULL, storage_budget_bytes=max(default, ceil(2·pgBytes)))`; job `lifecycle/convert` |
| T2 | `converting` → `ready` | Convert job reaches `await_cutover` | Clean converge pass, validate, parity, rollups or `skip_rollups`, shadow | Job completed |
| T3 | `ready` → `live` | `POST …/lifecycle/cutover` | P; parity ≤24h; last shadow clean; source quick re-check, else `reverify_required` unless `acceptDrift` | Swap; `read_store='projection'`, `cutover_at`, `cutover_seq=main_head`, `live_since`, `writes_open_at=now+ROUTE_SETTLE_SECS` |
| T4 | `ready` → `converting` | `…/lifecycle/reverify` | P | Resume convert at `converge` |
| T5 | `converting` \| `ready` → ∅ | Cancel (M) or data source delete | Not cut over | Delete the graph rows (`abandon_bootstrap` body, `bootstrap_worker.py:1248`); drop the candidate (owned, marker-proven); keep the `lifecycle_events` receipt |
| T6 | `live` → `ready` | Rollback `{target:'source'}` | P; `main_head == cutover_seq`; `source_status='attached'`, else `source_stale` | `read_store='source'`; sources paused (`lifecycle:ready`); drafts kept |
| T7 | `live` → `live` | Rollback `{target:'postgres'}` / `{target:'projection'}` | P; target projection needs liveness and parity OK | `read_store` flip + route broadcast |
| T8 | `live_legacy` → `live` | Adopt swap | P (snapshot re-auth); as T3, but writes stay open | Swap; legacy key becomes `source_graph_name` with `source_status='attached'` |
| T9 | `live` \| `live_legacy` ⇄ `frozen` | `…/freeze`, `/unfreeze` | P; no mutating lifecycle job (`drift_scan`/`drift_sync` are cancelled in the same transaction) | `prior_state` saved/restored; sources paused/resumed |
| T10 | `live` \| `live_legacy` \| `frozen` → `detaching` | `…/detach` | A; `confirmName`; live PRs → 409 `review_pending {prs}` unless `force` | With `force`: PRs `closed/graph_detached`, drafts `abandoned/graph_detached`; sources paused; job `lifecycle/detach` |
| T11 | `detaching` → `detached` | Detach `tombstone` phase | — | `deleted_at`; `ps.falkor_graph_name=NULL`; `owns=false`; sources retired |
| T11b | `detaching` → `prior_state` | Detach cancelled before `repoint` | M | Drop the materialised candidate; sources resumed |
| T12 | `detached` → `converting` | Conversion with `mode=reimport` | P; no purge job; `require_review=false`, else 409 `review_required {canStageToDraft:false}` | `deleted_at` cleared at `finalize_pg` |
| T13 | any except `purging` / `detached` → `trashed` | Data source delete | P (A when `require_review`); no job in an irreversible phase, else 409 `lifecycle_job_running {jobType, phase}` | `prior_state` saved; other mutating lifecycle jobs cancelled; sources paused; `converting`/`ready` go to T5 instead |
| T14 | `trashed` → `prior_state` | Data source restore | P (A when protected); no purge job in any status, else 409 `lifecycle_job_running {jobType:'purge'}` | Rehydrate nudged; sources resumed |
| T15 | `trashed` \| `detached` → `purging` | Reaper after grace, or permanent delete (A) | — | `create_purge_job` (fixed); cancels other lifecycle jobs |

- Relocate, reseed and adopt-on-live are `live → live` (or `frozen → frozen`), with a projection epoch bump and a `lifecycle_events` row where `from == to` and `op` is set.
- Every transition into `live` or `live_legacy` enqueues `ingest_redrive` for held `graph_not_writable` rejects (X-08).

### 5. Jobs
`LifecycleRunner` reuses a JobLease mixin extracted from `bootstrap_worker.py:244-407` (`claim_one`, `_own`, heartbeat, `_run_phase`). `PurgeRunner` adopts the same mixin.

**Claiming and fencing**
- Claim: `FOR UPDATE SKIP LOCKED` where `not_before IS NULL OR not_before ≤ now`.
- Epoch: `retry_count`, bumped on stale takeover and on every resume or restart.
- `_own()` also fails when `status='cancelled'` or when the graph's state is outside the op's allowed states.
- Phase advance is a CAS: `UPDATE jobs SET current_phase=:next WHERE id AND current_phase=:cur AND retry_count=:epoch`; zero rows raises `Superseded`.
- Transient errors (`_is_transient`, `bootstrap_worker.py:1389`) re-queue with `not_before` backoff. Data errors fail with `BootstrapFailure(code)`.

**Keys and concurrency (§15)**
- Idempotency key: `lc:<op>:<gid>:<lifecycle_rev>`. Exceptions: `pf:<ds_id>:<hour>` for preflight and `purge:<gid>` (revived) for purge.
- At most one mutating lifecycle job per graph (`uq_jobs_lifecycle_active`). `drift_scan` and `history_export` are exempt.
- Per-worker `LIFECYCLE_SLOTS`; per-FalkorDB-node scan semaphore `CONVERSION_SCANS_PER_NODE=1`.
- Every seed goes through `ProjectorWriteGovernor` (`providers/shard_capacity.py:597 hold_reason`).

| op | Phases |
|---|---|
| preflight (`graph_id='ds:<ds_id>'`) | `probe → labels → sample_windows → properties → estimate → capacity → ontology → report` |
| convert | `counting → nodes → edges → reidentify → converge → validate → heads → merkle → finalize_pg → place → seed → catchup → parity → rollups → shadow → await_cutover` |
| adopt | `gap_scan → repair → place → seed → catchup → parity → rollups → shadow → await_cutover` |
| relocate / reseed | `place → seed → catchup → parity → rollups → swap → retire` |
| detach | `precheck → [export_history] → [place → seed → catchup → parity → swap(materialize)] → repoint → tombstone → invalidate` |
| release_source | `recheck → final_drift_scan → delete\|forget → verify_gone → record` |
| drift_scan (read-only) | `scan → classify → record` |
| drift_sync | `scan → apply → record` (requires an active `falkordb_snapshot` binding) |
| history_export | `manifest → commits → versions → heads → prs → audit → verify` |
| history_restore | `verify_bundle → load → validate → place → seed → catchup → parity → rollups → shadow → await_cutover` |
| purge | `quiesce → count → edges → nodes → heads → merkle → working → commits → bulk_ext → falkor → meta → sweep → finalize` |

**Preflight specifics**
- **`probe`:** EXISTS first. A missing key returns 503 `source_unreachable {reason:'missing', retryable:false}` and creates nothing. Then `GRAPH.MEMORY USAGE` (optional), `count(n)`, `count(r)`, `max(ID(n))`, all over RO.
- **`labels`:** coverage of `coalesce(n.urn, n[$idp])`, where idp comes from `node_identity.load_node_identity` (`services/node_identity.py:391`).
- **`sample_windows`:** 20 random windows run through the real converter in dry-run mode.
- **`properties`:** ≤1k nodes per label and ≤1k edges per type.
- **`estimate`:**
  - `pgBytes = (n·avgNode + e·avgEdge) · GRAPHVER_PG_ROW_OVERHEAD`;
  - `falkorBytes = memory · 1.15 + rollups`.
- **`capacity`:**
  - FalkorDB: `topology.get_topology_snapshot` (`topology.py:1382`) + `read_shard_memory` (`shard_capacity.py:823`);
  - Postgres: `GRAPHVER_DEFAULT_GRAPH_BUDGET_BYTES`, then fleet headroom `GRAPHVER_FLEET_BUDGET_BYTES − Σ storage_bytes_est` ≥ `2·pgBytes` (X-11).
- **`ontology`:** a `canonicalize_rows` dry-run against the data source's assigned OntologyRules. Containment gaps are reported as `ontology_containment_missing {from, to, edgeType, count}` (X-30).

**Convert specifics**
- **`nodes` / `edges`:** `_scan_phase` (`bootstrap_worker.py:502`) runs over `ReadOnlySourceClient`. Each window transaction also writes a `conversion_windows` pass-0 row.
- **`reidentify`:** collision rows are re-read by RO and re-inserted with namespaced ids. Above `CONVERT_MAX_COLLISIONS` the job fails `too_many_collisions`.
- **`converge`** (1–3 passes): re-scan each window, then digest the source with `normalize_source(raw)` and Postgres with `payload_to_source_shape(stored JSONB)`. On mismatch, diff item by item and fix.
  - Import rows may change only while `main_head_commit_seq < import.commit_seq`. This is re-read under `_lock_graph` + `graphs FOR UPDATE`; otherwise the job fails `import_published`.
  - An `extras` probe deletes rows that are absent from the source.
  - After 3 dirty passes the job fails `source_unstable`, resumable, listing the hot windows.
- **`validate`:** a clean pass exists; 0 dangling edges (the anti-join at `bootstrap_worker.py:614-623`); 0 head collisions; all acks present; tallies equal.
- **`heads`:** `RETURNING 1`; a count mismatch fails `integrity`.
- **`finalize_pg`:**
  - assert per-commit counts;
  - flip the main head under `_lock_graph`;
  - set `storage_bytes_est = tallies × avg payload × GRAPHVER_PG_ROW_OVERHEAD` in the same transaction (X-11);
  - no watermark fast-forward.
- **Reimport mode:**
  - the import commit is at `main_head+1`;
  - edges are resolved by triple first (§13);
  - deletions = live heads absent from `conversion_seen`;
  - `finalize_pg` advances the head under `_lock_graph`.

**Adopt specifics (X-06)**
- **`gap_scan`:** a converge-style RO scan of the legacy key vs main. Differences are classified:
  - `missing_in_pg` → repairable;
  - `lossy_fields` while the head is still the v1 import version → repairable;
  - `external_write` → an issue;
  - `missing_in_key` → ignored.
- **`repair`:**
  - **Unprotected graph:** commits of kind `import`, actor `system:lifecycle`, `source_ref.requested_by`, ≤5k entities each, under `_lock_graph`.
  - **Protected graph** (`require_review`): the rows go into a draft owned by the requesting human (visibility `private`, `originating_view_id` NULL). A PR is opened by that human. The job **completes** with `summary.outcome={code:'repair_pr_opened', prId, branchId}`.
  - After the merge, the hub offers "Continue adoption", which is a new adopt job whose `gap_scan` finds 0 repairable gaps.
  - Edges are resolved by triple before minting (§13).

### 6. KeyMigration (`versioning/keymigrate.py`)

**place**
- Taken under `pg_advisory_xact_lock(hashtext('gvplace:'||provider))`.
- Per master: `free = maxmemory − used − Σ reserved − FORK_HEADROOM_FRACTION·maxmemory`. Pick the requested node, or the largest free master with `free ≥ need·1.3`. Co-residency with attached sources is counted.
- Tag: the first `<gid8>.<n>` whose `topology.key_slot` (`topology.py:351`) falls in that master's slot ranges (`topology.place`, L362). An existing key that is not a resume → next n.
- Persist `candidate_graph_name/provider` and `shard_map {node, slot, tag, needBytes, reservedBytes, chosenAt}`. The `shard_map` column exists and is unused today (`models.py:253`).

**seed** (`FalkorProjector.seed_stream`)
- **Refusals:** the key must be EXISTS=0, or carry our own `_GVProjMeta{graph_id, job_id, state:'seeding'}`. The name must match `^gvp_<gid>\{[0-9a-z]{8}\.\d+\}$`. Anything else raises `SeedRefused`.
- **Steps:**
  1. Write the marker first.
  2. Record S0 = `main_head`.
  3. Create urn indexes (`falkordb_provider.py:8577`).
  4. Keyset pages of 5k over heads ⋈ versions, built with `_node_item` (`projection.py:294`) in `to_thread` and applied with `_apply` (L1977).
  5. Edges: endpoint lookup per page; the largest `entity_id` wins a collapsed triple (matches `_expected_projection` L1528).
  6. Cursor `seed:<kind>:<eid>`.

**catchup**
- Projector-owned. In `_project_graph_locked` (`projection.py:447`), under gvproj, when `candidate_seq` is set: apply `(candidate_seq, projected]` to the candidate, then dual-write each new window.
- The job sets `candidate_seq=S0` under gvproj and only polls until `main_head − candidate_seq ≤ SWAP_MAX_LAG`.

**parity**
- Counts: `pg_live_counts_projectable` (`reconcile.py:92`) vs `falkor_counts` (L149).
- `gvHash` per entity vs `_node_fingerprint` / `_edge_fingerprint` (`projection.py:184/193`). Heads newer than `candidate_seq` are skipped.
- One bounded re-upsert, then re-check. Any residue fails `parity_failed` and records `conversion_issues(kind='projection_parity')`.

**rollups**
- Aggregation trigger with an internal `target_graph_key=candidate` and key `gv-rollup-seed:<job>:<epoch>`.
- The ack `skip_rollups` (P) lets cutover proceed.

**shadow**
- Probe suite: label counts, 200 urns, 50 neighbourhoods, top page, 20 searches, 10 depth-2 traces.
- Blocking categories: `missing_entity`, `missing_edge`, `value_diff`.
- Repeated every `SHADOW_INTERVAL_SECS` while `ready`.

**swap**
1. `pg_try_advisory_lock(hashtext('gvproj:'||gid))` on a dedicated session, polled ≤30s; otherwise 503 `lock_busy`.
2. Re-authorize the principal snapshot.
3. `SET LOCAL lock_timeout='5s'`; `_lock_graph`; `graphs` FOR UPDATE; `projection_state` FOR UPDATE.
4. Apply the final window (lag ≤ `SWAP_MAX_LAG`, else 409 `catchup_required`).
5. Set the marker `state:'ready', seq=head, epoch+1`.
6. `wait_for_replicas(1)` (`falkordb_provider.py:3236`); 0 acks → 503 `replica_unconfirmed`, and Postgres is unchanged.
7. Update `projection_state`: name = candidate, `owns=true`, `projected=target=head`, `epoch+1`. Push the old *owned* key to `retired_keys` (never a source key).
8. `transition()`.
9. COMMIT.
10. Route broadcast, then `bump_graph_generation`.

**`is_droppable_owned_key(ps, name)`** requires all of:
- `owns_falkor_graph`;
- the name matches the gvp pattern or a minted blank/fork name;
- marker `graph_id == gid`, or EXISTS=0;
- no other `projection_state` reference (primary, candidate or retired);
- not any `graphs.source_graph_name`;
- the management resolver confirms no data source (live or trashed) has `graph_name` equal to it.

### 7. Read routing (X-24)
- `versioned_sources.read_routes()` returns `{ds_id: Route(graph_id, state, read_store, source_key, source_provider, projection_key, projection_provider, rev, writes_open_at)}`. TTL `ROUTE_TTL_SECS=2`; serves last-known on a Postgres blip; invalidated by bus `route:<ds_id>`.
- ContextEngine order:
  1. Look up the route.
  2. `read_store='postgres'` → `VersionedBranchProvider`.
  3. `read_store='projection'` with `liveness_state='ok'` → `svc.read_route(graph, actor)` (plan 1.6). The projection may lag only by service commits (≤`READ_MAX_LAG_COMMITS` / `READ_MAX_LAG_SECS`). A human or system commit newer than projected forces Postgres for that actor.
  4. Overlay drafts.
- `converting` / `ready` → the source-key provider wrapped by `VersionedWriteProvider`, so writes are refused.
- `projection_watermark.fresh` stays strict and is used for the UI only.
- **Why stale pods are safe:** `writes_open_at ≥ swap + 2·TTL + bus latency`. Source and candidate are content-equal at the swap, so a stale pod serves identical data.

### 8. External writes during the copy: re-scan converge
- **Certificate:** every entity in window w equals the source at `verified_at(w)`; the snapshot is referentially whole; no Postgres extras.
- Later source writes are drift. The source is never touched (D1), so drift is detectable. Release is blocked until drift is synced or acknowledged.
- Quiescing writers is optional; the wizard checkbox only shortens convergence.

### 9. Lossless conversion rules (`entity_serde`, `identity.py`)

**Nodes (§13)**
- Identity: `urn`, else `n[identity_property]`, else synthetic `urn='gv:src:<ID>'` with **`entity_id='src:<ID>'`**.
- So `urn == 'gv:' + eid`, which matches the stand-in convention stripped by `graph.py:3664-3671 _ref`. Today `bootstrap_worker.py:955` sets `eid = node.urn`; v2 keeps that for URN nodes only.
- Duplicate effective identities need the A ack `duplicate_urns_reidentify`. Later occurrences then become synthetic, keeping `properties['__src.urn']`.

**Node payload**
- Every physical non-derived label (`labels`); ontology-canonical `entityType`.
- Reserved keys move to `properties['__src.<k>']`.
- `propertiesRaw` blobs are decoded and merged, native keys winning.
- `SOURCE_DERIVED_NODE_KEYS={gvHash, searchableText, level, levelDigest, childCount}` are excluded on both parity sides.

**Edges**
- Fresh convert: `r.id`, else `mint_import_edge_id(s, T, t)` → `<s>|<T>|<t>`. A parallel group gets `#blake2b(canonical props)[:12]`. Byte-identical copies fold, with `__src.multiplicity=N`.
- Cross-window conflicts, or an eid equal to a node eid → `id_collision`, fixed by `reidentify` to `<rawid>@<s>|<T>|<t>`.
- **Reimport and adopt repair** resolve first with `_heads_by_edge_triple` (`service.py:5243`) under the lock:
  - exactly 1 live head → reuse its id;
  - >1 heads → if one head id equals the deterministic mint (a converted parallel group), reuse it; otherwise `ambiguous_identity`, recorded as `conversion_issues(kind='id_collision', detail.reason='ambiguous_identity')`, and the edge is skipped;
  - none → mint.
- Native `r.*` keys are folded into `properties`.

**Values (`_json_safe`)**
- NaN/±Inf → `{"$f":…}`; temporal → `{"$t",v}`; point → `{"$p"}`; bytes → `{"$b"}`.
- The engine serializer uses `allow_nan=False`.

**Errors and hashing**
- A per-row exception becomes `unconvertible` and needs the A ack `accept_unconvertible_loss`.
- Property-tested invariant: `payload_to_source_shape(convert(x)) == normalize_source(x)`.

### 10. Drift and the falkordb_snapshot binding (X-07, X-19)

**drift_scan** (M; read-only; every `graphs.drift_scan_hours`, default 24, 0 = off)
- RO re-scan of the recorded windows against the latest clean pass digests. Dirty windows are diffed item by item.
- Baseline:
  - a bound graph uses the binding's shadow (`source_assertions`);
  - an unbound graph uses the main state at `coalesce(cutover_seq, main_head)`. This is protected from compaction (§10), and import/sync commits are never compacted.
- Results go to `conversion_issues(kind='source_drift')` and `graphs.drift_summary`.

**The binding**
- **Row shape:** `ingest_sources` with `decoder='falkordb_snapshot'`, `raw_topics='{}'`, `routing=NULL`, `decoder_options={provider, sourceGraphName, identityProperty, autoApply}`, and default `field_policy {'*':{'*':'shared'}}` minus guardrails.
- **Created from:** Drift & sync → "Keep in sync with original graph" (SourceWizard steps 3–5).
- **Approval:** P, four-eyes when protected.
- **Activation** needs all of: `live`, `owns_falkor_graph`, `falkor_graph_name IS NOT NULL`, and a drift_scan younger than 24h (its "dry-run").
- **Shadow seeding at activation:** `source_baseline.iter_conversion_baseline(s, gid)` (NEW, in this spec) yields import rows mapped by `payload_to_source_shape`, with `k=(verified_at(window) ms, mapping_epoch, 0, 0)` and `claimed=false`. Adopted graphs use the gap_scan baseline (`conversion_windows.verified_seq`).

**drift_sync** (P, or scheduled when `autoApply`)
- RO scan, then `apply_source_delta(delivery='snapshot', k=(scan_started_ms, mapping_epoch, 0, scan_seq))` with COMPLETE scope over the scanned windows.
- Commits are kind `ingest`, actor `svc:ingest:<sid>`.
- Conflicts and delete_modify go to `ingest_issues` in IssuesInbox.
- Delete governance and the breaker belong to INGEST.
- There is no 3-way path, no system draft and no DriftInbox.

**Release** retires the binding in the same transaction.

## Data model & migrations

All revisions belong to the shared chain (§5). CONVERSION owns the lifecycle content of migrations 1300, 1500, 1600 and 2000, and needs 1200. ORM CHECKs equal the migration domains (widen-only; each `_REQUIRED` is a literal superset of the previous one).

**`20261010_1200_gv_jobs_types`** (shared, X-01)
- `ck_jobs_type` = the full §4 union. The ORM at `models.py:349-357` is set to the identical tuple; today it lacks `purge` (STORE-4).
- Adds `jobs.op TEXT NULL` and `jobs.not_before TEXT NULL`.

**`20261010_1300_gv_graphs_policy_lifecycle`**: CONVERSION columns on `graphver.graphs`.
- `lifecycle_state TEXT NOT NULL DEFAULT 'live'`, `ck_graphs_lifecycle_state` ∈ §3 domain.
- `lifecycle_rev BIGINT NOT NULL DEFAULT 0`.
- `read_store TEXT NOT NULL DEFAULT 'projection'`, CHECK ∈ {source, projection, postgres}.
- `prior_state TEXT NULL`, same domain.
- `source_graph_name`, `source_provider`, `source_status` (CHECK ∈ {attached, released_kept, released_deleted}), `source_released_at`, `source_released_by`.
- `cutover_at`, `cutover_seq BIGINT`, `live_since`, `writes_open_at`, `last_unhealthy_at`.
- `drift_summary JSONB`, `drift_scan_hours INT NOT NULL DEFAULT 24`, `identity_property TEXT`.

**Backfill** (same migration; one UPDATE per rule, per-state counts logged before and after):
1. Purge job in any status and `deleted_at` set → `purging`.
2. `deleted_at` set → `trashed`, with `prior_state` from rules 3–6.
3. Bootstrap job pending, running or failed → `converting`, `read_store='source'`.
4. `kind='blank'` or a fork → `live`.
5. `owns_falkor_graph=false` AND `falkor_graph_name NOT NULL` AND `falkor_graph_name <> 'gv_'||id` → `live_legacy`, `read_store='source'`; `source_graph_name/provider` copied from `projection_state`; `source_status='attached'`.
6. Otherwise → `live`.

The `storage_*` columns belong to INGEST in the same migration; CONVERSION only writes them (T1, `finalize_pg`). Same-PR code: v1 `create_bootstrap_job` (`bootstrap_worker.py:1114`) sets `converting`, and v1 finalize sets `live_legacy`. That keeps the state correct between R0 and L0.

**`20261010_1500_gv_projection_state_keys`**: `projection_state` gains:
- `candidate_graph_name`, `candidate_provider`, `candidate_seq BIGINT`;
- `retired_keys JSONB` (`[{name, provider, retireAfter, reason}]`);
- `last_parity_at`, `last_parity_ok`, `last_liveness_at`, `liveness_state`;
- `epoch BIGINT NOT NULL DEFAULT 0`, `failed_attempts INT NOT NULL DEFAULT 0`, `next_retry_at`, if plan 0.5 has not added them.

Unique indexes:
- `uq_ps_key` UNIQUE `(coalesce(falkor_provider,'default'), falkor_graph_name) WHERE falkor_graph_name IS NOT NULL`;
- `uq_ps_candidate_key` on the same shape for the candidate.

Duplicate pre-check: tombstoned, non-owned duplicates have their name set to NULL. Any other duplicate aborts with a report.

**`20261010_1600_gv_lifecycle_tables`**
- **`lifecycle_events`** (append-only trigger; kept by purge):
  - columns: `id 'lev_…' PK`, `graph_id`, `data_source_id`, `workspace_id`, `from_state`, `to_state`, `rev`, `op`, `job_id`, `actor`, `actor_kind` ∈ {human, service, system}, `reason`, `payload JSONB`, `created_at`, `outbox_emitted_at`;
  - indexes: `ix_lev_graph_time(graph_id, created_at DESC)`, `ix_lev_unemitted WHERE outbox_emitted_at IS NULL`.
- **`conversion_windows`:**
  - columns: `job_id`, `graph_id`, `kind` ∈ {node, edge}, `lo`, `hi`, `pass`, `src_count`, `src_sum NUMERIC(20,0)`, `src_xor`, `pg_count`, `pg_sum`, `pg_xor`, `dirty`, `verified_seq BIGINT`, `scanned_at`;
  - PK `(job_id, kind, lo, pass)`; `ix_cw_graph(graph_id, kind, lo)`;
  - retention: kept while `source_status='attached'`; deleted at release + `RELEASE_WATCH_DAYS`, or by purge.
- **`conversion_issues`:**
  - columns: `id BIGSERIAL`, `graph_id`, `job_id`, `kind` ∈ {unconvertible, id_collision, duplicate_urn, synthetic_urn, parallel_divergent, reserved_key, value_normalized, projection_parity, shadow_diff, external_write, source_drift}, `severity` ∈ {blocking, ack, info}, `entity_ref JSONB`, `detail JSONB`, `status` ∈ {open, acked, resolved, dismissed}, `resolved_by`, `resolved_at`, `created_at`;
  - indexes: `ix_ci_job_kind(job_id, kind, id)`, `ix_ci_graph_open(graph_id, kind) WHERE status='open'`;
  - cap: `CONVERT_MAX_ISSUE_ROWS` per job, then the job fails `too_many_issues`.
- **`conversion_seen`:** `(job_id, entity_id) PK`. Filled in reimport mode; GC'd at job terminal state and by `sweep_once` (`worker.py:97`).

**`20261010_1800_gv_idx_concurrent_a`**: `ix_graphs_lifecycle ON graphs(lifecycle_state)`.

**`20261010_2000_gv_jobs_lifecycle_active`** (autocommit)
- `uq_jobs_lifecycle_active` UNIQUE `ON jobs(graph_id) WHERE job_type IN ('bootstrap','lifecycle','purge') AND status IN ('pending','running','failed') AND coalesce(op,'') NOT IN ('drift_scan','history_export')`.
- Pre-check: keep the newest duplicate; the rest become `cancelled` with `summary.superseded=true`.

**Not added (X-07):** no columns on `ingest_sources`.

**Engine** (`versioning/db.py get_engine`): `json_serializer=partial(json.dumps, allow_nan=False)`.

**Management DB:** no routing change. `ds.graph_name` stays the logical identity, which keeps continuity for `stats_history_repo` and profiling. New `data_source_repo.repoint_graph_name(session, ds_id, new_name, actor)`, used by detach only, plus outbox `workspace.data_source.repointed`.

**`AggregationJobORM.graph_name`** records the physical key written. No migration.

**`versioning/config.py`:**
- `FIDELITY_VERSION=1`
- `CONVERGE_MAX_PASSES=3`
- `CONVERT_MAX_COLLISIONS=10000`
- `CONVERT_MAX_ISSUE_ROWS=1000000`
- `CONVERSION_SCANS_PER_NODE=1`
- `PREFLIGHT_MAX_AGE_SECS=86400`
- `ROUTE_TTL_SECS=2`
- `ROUTE_SETTLE_SECS=10`
- `SWAP_MAX_LAG=50`
- `RETIRE_GRACE_SECS=900`
- `SHADOW_INTERVAL_SECS=600`
- `SEED_HOLD_MAX_SECS=1800`
- `ROLLUP_SEED_TIMEOUT_SECS=3600`
- `RELEASE_MIN_HEALTHY_DAYS=14`
- `RELEASE_REQUIRE_EXPORT=True`
- `RELEASE_WATCH_DAYS=30`
- `FORK_HEADROOM_FRACTION=0.15`
- `GRAPHVER_PG_ROW_OVERHEAD=1.9`
- `LIFECYCLE_SLOTS=2`

## API

**Conventions**
- New router `api/v1/endpoints/versioning_lifecycle.py` reuses `_domain_errors` (`versioning.py:458`) from `versioning/errors.py`.
- Resolution:
  - data source: `_data_source_in_workspace` (`graph.py:306`);
  - graph: `graph_in_workspace` (`versioning.py:408`), which rejects deleted graphs except on routes marked `include_deleted` (lifecycle GET, impact, restore).
- Unreadable resources → 404.
- Mutating routes take `expectedRev`; a mismatch returns 409 `version_conflict {resource:'lifecycle', currentVersion}`.
- `graph_not_writable {state, reason, retryable}`.
- 503 responses carry Retry-After.
- Every response that carries a resource includes `access{can, reasons, required}` (§12).

Auth column: R = read, M = manage, P = publish+manage, A = admin.

| Method & path | Request | Response | Auth | Errors |
|---|---|---|---|---|
| GET `/{ws}/data-sources/{ds}/versioning/lifecycle` | — | **LifecycleSnapshot:** `{state, rev, readStore, priorState, graphId, mainHeadSeq, cutoverSeq, liveSince, writesOpenAt, access, activeJob{jobId, op, status, phase, phases[], percent, etaSeconds, failure{code, phase, nextStep}, requiredAcks[], outcome?}, source{graphName, provider, status, driftSummary, binding{sourceId, state}?, releaseEligibility{eligible, reasons[], eligibleAt}}, projection{key, provider, node, slot, epoch, fresh, lagCommits, liveness, lastParityAt, lastParityOk, memoryBytes, candidate?}, storage{bytesEst, budgetBytes, state}, lastPreflightJobId, recentEvents[≤20]}` | R | 404 |
| POST `…/versioning/preflight` | `{identityProperty?}` | 202 `{jobId}`; 200 if an identical one is ≤10 min old | M | 422 `invalid_source_config {reason:'provider_unsupported'}`; 409 `version_conflict` (graph exists, not detached); 503 `source_unreachable {reason:'missing'\|'unreachable'}`; 403 `feature_disabled` |
| GET `…/versioning/preflight/{jobId}` | — | `{status, phase, percent, report{source, labels, edgeTypes, identity, estimates, properties, sizing, capacity{perNode[], pg{need, free}, fleet}, ontology{canonicalized[], unknown[], violations[{code:'ontology_containment_missing', from, to, edgeType, count}]}, sharedKey, requiredAcks[{code, count, explanation, required:'publish'\|'admin'}]}}` | R | 404 |
| POST `…/versioning/conversions` | `{preflightJobId, acks[], targetNode?, externalWritersPaused, mode?:'fresh'\|'reimport'}` | 202 `{jobId, graphId, state:'converting', rev}` | P; A for `accept_unconvertible_loss` / `duplicate_urns_reidentify` (`needs_admin`) | 409 `reverify_required {reason:'preflight_stale'}`; 422 `ack_required {missing[]}`; 422 `ontology_containment_missing`; 409 `capacity_insufficient {perNode?, pg?}`; 409 `version_conflict`; 409 `job_active`; 409 `review_required {canStageToDraft:false}` (reimport on a protected graph) |
| GET `/{ws}/versioning/lifecycle-jobs/{jobId}` | — | `activeJob` + report `{checks[], passes[], parity, shadow, certificate{windowsVerified, digestRoot, verifiedFrom, verifiedTo}}` | R (job workspace = ws) | 404 |
| GET `…/lifecycle-jobs/{jobId}/evidence` | — | JSON download | R | 404 |
| POST `…/lifecycle-jobs/{jobId}:resume` \| `:restart` \| `:cancel` | `{expectedRev?, acks?}` | 202 `{jobId, status, epoch}` | resume/restart P (A for detach/release jobs); cancel M pre-cutover / pre-swap / detach-before-repoint | 409 `job_active` (pending, or running with a fresh heartbeat); 409 `lifecycle_job_running {phase}` (past the irreversible point); 422 `ack_required` |
| POST `/{ws}/versioning/graphs/{gid}/lifecycle/cutover` | `{expectedRev, acceptShadowDiffs?[], acceptDrift?}` | 200 snapshot | P | 409 `version_conflict`; 409 `reverify_required {reasons:['parity_stale'\|'shadow_blocking'\|'rollups_missing'\|'source_moved'], movedSince?}`; 409 `catchup_required`; 503 `lock_busy`, `replica_unconfirmed` |
| POST `…/lifecycle/rollback` | `{target:'source'\|'postgres'\|'projection', expectedRev, reason}` | 200 snapshot | P | 409 `source_stale {commitsSinceCutover \| reason:'released'}`; 409 `reverify_required {reason:'projection_unhealthy'}`; 409 `version_conflict` |
| POST `…/lifecycle/reverify` | `{expectedRev}` | 202 `{jobId}` | P | 409 `version_conflict` |
| POST `…/lifecycle/adopt` | `{targetNode?, autoCutover?:false, expectedRev}` | 202 `{jobId}` (outcome may be `repair_pr_opened`) | P | 409 `version_conflict` (not `live_legacy`); `job_active`; `capacity_insufficient` |
| POST `…/projection/relocate` | `{targetNode, expectedRev}` | 202 `{jobId, targetKey}` | P | 409 `projection_not_adopted`; `capacity_insufficient {reason:'unknown_node'?}`; `job_active` |
| POST `…/projection/rebuild` (existing, `versioning.py:1968`) | — | Owned key: 202 `{jobId, mode:'blue_green'}`. `live_legacy`: 200 `{mode:'in_place', adoptRecommended:true}` | P | 409 `graph_not_writable {state}`; `job_active` |
| POST `…/lifecycle/freeze` \| `/unfreeze` | `{expectedRev, reason}` | 200 snapshot | P | 409 `version_conflict`; `lifecycle_job_running` |
| POST `…/lifecycle/detach` | `{mode:'handover'\|'materialize'\|'restore_source', targetGraphName?, confirmName, exportHistoryFirst, force, expectedRev}` | 202 `{jobId}` | A | 422 `confirm_mismatch`; 409 `graph_name_unavailable` (existing, `versioning.py:1485`); 409 `review_pending {prs[]}` unless `force`; 409 `source_stale`; 409 `version_conflict` |
| POST `…/lifecycle/release-source` | `{mode:'forget'\|'delete_key', confirmGraphName, acknowledgeUnsyncedDrift, expectedRev}` | 202 `{jobId}` | A | 409 `release_not_eligible {reasons ⊂ [not_live, healthy_days<N, parity_stale, drift_scan_stale, unsynced_drift, issues_open, export_missing, shared_with:[…], pinned_by_graph, route_uses_source, already_released, job_active]}`; 422 `confirm_mismatch` |
| POST `…/lifecycle/drift-scans` | — | 202 `{jobId}`, idempotent while running | M | 409 `source_stale {reason:'released'}` |
| GET `…/lifecycle/drift` | `?cursor` | `{summary, issues page}` | R | 404 |
| POST `…/lifecycle/drift-sync` | Idempotency-Key | 202 `{jobId}` | P | 409 `projection_not_adopted`; `dryrun_required` (no binding, or scan >24h); `graph_not_writable`; `job_active` |
| POST `…/lifecycle/drift/dismiss` | `{issueIds, reason}` | 200 | A | 404 |
| GET `…/lifecycle/events?before&limit≤100` | — | Keyset page | R | 404 |
| GET `…/lifecycle-jobs/{jobId}/issues?kind&status&cursor&limit≤500`, `…/issues.csv` | — | Page / streamed CSV | R | 404 |
| POST `…/issues/{id}:ack` \| `:dismiss` | `{reason?}` | 200 | P; A for loss acks | 422 `ack_required` |
| POST `…/lifecycle/history-exports`; GET same | `{asOfSeq?}` | 202 `{jobId}`; list `[{jobId, at, verified, bytes, manifestSha}]` | A | 410 `history_compacted`; 403 `feature_disabled` (`graphExportEnabled`) |
| GET `/graphs/{gid}/exports/{jobId}/download` (existing, `versioning.py:3161`), `kind='history'` | — | NDJSON per table + manifest | A for history | 404 |
| POST `/{ws}/data-sources/{ds}/versioning/history-imports` | `{exportJobId \| uploadId}` | 202 `{jobId, graphId}` | A | 409 `version_conflict` (graph exists); 422 `bundle_invalid {file, expectedSha, gotSha}` (requested §6 addition) |
| POST `/api/v1/admin/versioning/watermarks/reset` | `{provider, node?}` | 200 `{graphsReset}` | system:admin | — |

**Shims** (`graph.py`)
- POST `/graph/bootstrap` (lifecycle v2 on) and POST `/graph/resync` (graph with `source_graph_name`) → 422 `client_upgrade_required {next:'preflight'|'drift-sync'}`.
- GET `/graph/bootstrap/status` → the latest convert job.
- retry / abandon → `:resume` / `:cancel`.

**Data source routes** (`workspaces.py`)
- `DELETE /{ws}/data-sources/{ds}` (`remove_data_source`, L655):
  - versioned: P (A when protected); T13, or T5 for `converting`/`ready`;
  - `?permanent=true` is A and drives T15;
  - 409 `lifecycle_job_running`.
- `POST …/restore` (L727): T14.
- `POST …/move` (L759): updates graphver `workspace_id` first; 409 `job_active` while a mutating lifecycle job runs.
- `GET …/impact?action=delete|detach|release|freeze`: the fixed `versioning_impact`.

**`POST /{ws}/versioning/graphs`** (`versioning.py:1185`)
- Ignores client key names; mints owned keys for blank graphs only.
- 409 `data_source_has_data {next:'preflight'}` (requested §6 addition).

## Enforcement points (file:function → change)

**New modules**
- **`versioning/errors.py` (NEW, shared):**
  - `GraphNotWritable(state, reason, retryable, retry_after)` is not a `ConcurrencyError` subclass and is mapped before the L480 `ConcurrencyError` catch;
  - also `LockBusy`, `VersionConflict(resource, current)`, `LifecycleJobRunning`, `SeedRefused` → `lock_busy`/409, `DeriveTargetUnavailable` → `conversion_in_progress`, `SourceUnreachable`.
- **`versioning/lifecycle_state.py` (NEW):**
  - `TRANSITIONS`; `transition()` (§4 lock order, CAS, hook registry `on_transition(s, gid, frm, to, principal)` used by INGEST and drafts);
  - `WRITABLE={'live','live_legacy'}`; `allowed_actions(graph, ps, job)` (state guards only).
- **`versioning/access.py` (shared):**
  - `explain()` composes `allowed_actions` with `decide`; the state reason wins.
  - New Actions (`legacy=False`, always enforced): the X-04 list (`LIFECYCLE_PREFLIGHT` … `DRIFT_SCAN`), plus requested `LIFECYCLE_CANCEL` (M), `LIFECYCLE_RELEASE` (A), `LIFECYCLE_DELETE` (A), `LIFECYCLE_TRASH` (P / A protected), `DRIFT_SYNC` (P), `DRIFT_DISMISS` (A). All have `audit_sink='lifecycle'`.
- **`versioning/identity.py` (NEW, shared):** `synthetic_node_identity(id)`, `mint_import_edge_id`, `mint_sync_edge_id`. The latter is extracted from `service.py:5214/5345` with no change in behaviour.
- **`versioning/source_client.py` (NEW):**
  - `ReadOnlySourceClient.query()` → `projection._q(..., read_only=True)` (`projection.py:83`);
  - a regex guard rejects CREATE/MERGE/SET/DELETE/REMOVE/DETACH;
  - `exists()`;
  - `WritableSourceHandle` is constructible only in `ReleaseRunner._phase_delete` with token `release:<job>:<epoch>`, verified against the jobs row.
- **`versioning/source_baseline.py` (NEW):** `iter_conversion_baseline` (X-07 shadow seed) and `drift_baseline` (§10).
- **`versioning/keymigrate.py` (NEW):** §6.
- **`versioning/lifecycle_runner.py` (NEW):**
  - JobLease mixin; op dispatch; copy phases delegated to BootstrapRunner;
  - drift-scan scheduler; `lifecycle_events` → management outbox relay (`workspace.data_source.lifecycle_transitioned`); shadow repeat.

**`versioning/service.py`**
- **`_assert_not_bootstrapping` (L466) → `_assert_writable(s, gid)`:**
  - reads `lifecycle_state` and `writes_open_at` from the `FOR KEY SHARE` read (draft path) or the `_lock_graph` read (main path);
  - keeps the v1 bootstrap-job check until v1 is drained;
  - the old name stays as an alias.
- **`_assert_writable` call sites, at the §7 gate positions:**
  - `open_draft` L494 (CREATE_DRAFT), reopen, PR open;
  - `stage_changes`, `_checkpoint_once`, `publish` L882, `_rebase_draft_once`, `revert_commit` L1351, `restore_to_commit` L1464;
  - `fork_graph` L1583 (the source must be live);
  - `merge_pr` L1766, `merge_mr` L2072;
  - `bulk_ingest` L4791, `sync_ingest` L4982, `_apply_ops_once`; `apply_source_delta` (INGEST).
  - Draft writers first run `SELECT lifecycle_state, writes_open_at FROM graphs WHERE id=:g FOR KEY SHARE`.
  - A publish or merge job refused for `GraphNotWritable` resets the branch to `open`.
- **`create_graph` (L336):** new kwargs `lifecycle_state`, `read_store`, `source_graph_name`, `source_provider`, `identity_property`, `storage_budget_bytes`. Convert → `falkor_graph_name=None`. `ValueError` if a non-owned key name is given.
- **`sweep_idle_drafts` (L1311):** add `graph_id IN (SELECT id FROM graphs WHERE lifecycle_state IN ('live','live_legacy') AND deleted_at IS NULL)`. Actor `system:ttl`.
- **`request_projection_rebuild` (L2295) / `ensure_projection_target` (L2272):** only `live`/`live_legacy`/`frozen`; never repoint a graph with `source_graph_name` set or a `gvp_` key; an owned rebuild enqueues `lifecycle/reseed`.
- **`projection_watermark` (L2227):** adds `lifecycle_state`, `read_store`, candidate; strict `fresh`.
- **`get_graph` (L4114)** excludes deleted graphs. **`get_graph_by_data_source` / `resolve_graph` (L4120/L4139)** exclude `detached`, `trashed` and `purging`.

**`versioning/bootstrap_worker.py`**
- `_client` (L238): `ReadOnlySourceClient` from `job.summary.source`, never `ps.falkor_graph_name`.
- `_count` (L487): `read_only=True` after an EXISTS probe. Today it deliberately instantiates the key (verified).
- Scan cypher (L157-180): URN-less nodes included; edges return `ID`, `urn` and `[$idp]` of both endpoints.
- `_scan_phase` (L502):
  - caches `maxId` per pass;
  - runs the conversion in `to_thread`;
  - writes the `conversion_windows` row in the same transaction;
  - a cross-window ON CONFLICT becomes an issue.
- `_nodes_to_rows` (L936) / `_edges_to_rows` (L980): §9. The None `continue` at L949 becomes `unconvertible`.
- New `_phase_reidentify`, `_phase_converge`, `_phase_validate_v2`. They replace `_phase_validate` (L594); delete `_verify_sample` (L1022).
- `_phase_heads` (L703): `RETURNING` count check.
- `PHASES` (L109): the v2 tuple. Delete `_phase_backfill` (L821) and `_BACKFILL_*` (L183).
- `_phase_finalize` (L789) → `finalize_pg` (no watermark fast-forward; sets `storage_bytes_est`).
- `run_job` (L290): phase CAS.
- `retry_bootstrap` (L1205): `FOR UPDATE`, status/heartbeat guard, epoch bump.
- `create_bootstrap_job` (L1114): stores `summary.source` and `summary.principal`; no `_pin_projection_target`; refused when `GRAPHVER_BOOTSTRAP_V1=drain`.

**`versioning/projection.py`**
- Add `seed_stream`.
- `_project_graph_locked` (L447): candidate catch-up + dual write; epoch-fenced watermark; marker + WAIT before advancing; delete the L589 target pin; skip unless `live`/`live_legacy`/`frozen` and not deleted; refuse to apply ingest commits into a non-owned key (§9 `live_legacy`).
- `project_pending` (L711): adds the `deleted_at`, lifecycle, `status != 'evicted'` and `next_retry_at` filters.
- `_reconcile_in_place` (L1572): an empty owned key routes to `seed_stream`; non-owned keys never DETACH DELETE unkeyed nodes.

**`versioning/cache_manager.py`**
- `lru_candidates` (L159) / `resident_count` (L149): candidates must be owned, projected, in state `live`/`frozen`/`trashed` (trashed first), with no active lifecycle job, and not a candidate key.
- `evict` (L87): `pg_try_advisory_lock(gvproj)`, marker check, epoch bump.

**`versioning/purge_worker.py`**
- `create_purge_job` (L394): graph `FOR UPDATE`; refuse if not deleted; revive failed/cancelled rows; cancel other lifecycle-class jobs; transition to `purging`.
- `_phase_quiesce` (NEW): cancel jobs of every type, including `ingest_*`, `compaction` and `lifecycle`.
- `_phase_count` (L243): `live_forks` refusal.
- `_BULK` (L65) gains `source_assertions` and `ingest_issues`, chunked in phase `bulk_ext` (X-14).
- `_phase_meta` (L365) adds `ingest_offsets`, `ingest_run_state`, `ingest_rejects WHERE graph_id=:g`, `ingest_source_partitions` (by source ids), `commit_compactions`, `conversion_windows`, `conversion_issues`, `conversion_seen`, `pr_reviews WHERE graph_id`, then `ingest_sources` last. It keeps `lifecycle_events`, `access_events`, `ingest_source_revisions` and its own job row.
- Each table is added in the PR that creates it.
- `_phase_falkor` (L309): the drop set filtered by `is_droppable_owned_key`; never `source_graph_name`.
- `_phase_sweep` (NEW).
- `restore_graphs_for_data_source` (L488): any purge status blocks restore.
- Drop the `workspace_id` predicate.
- `Reaper.run_once` (L551): per-data-source try/except, re-queue failed purges, released-key watch.

**`versioning/lifecycle.py` `versioning_impact` (L47):** open drafts, live reviews, bounded counts with `greaterThan`, source and platform key info.

**`versioning/entity_serde.py`:** `normalize_source`, `payload_to_source_shape`, `source_item_hash`, `_json_safe`, `window_digest`.

**`versioning/worker.py` `ProjectionWorker.run` (L160) + `__main__.py`**
- `VERSIONING_WORKER_ROLES ⊂ {projection, transfer, lifecycle, purge, reaper, compaction}`.
- projection role: projector, `_retire_loop`, `_liveness_loop`.
- lifecycle role: claims `lifecycle`, `preflight`, `bootstrap`.
- purge role: `purge`.

**Compaction runner (INGEST-owned; contract with this spec)**
- Skips graphs with pending or running lifecycle, bootstrap, preflight or purge jobs.
- Protects `graphs.cutover_seq`.
- `history_export` takes `pg_advisory_xact_lock_shared('gvcompact:'||gid)` per transaction and records the max seq.

**Routing**
- **`services/versioned_sources.py`:**
  - `read_routes`, `physical_key`, `reset_route_cache`;
  - `versioned_data_source_ids` (L67) includes every state except `detached` and `purging`;
  - `projector_health` (L255) adds state.
- **`providers/manager.py` `get_provider` (L439):**
  - kwargs `graph_key`, `purpose`;
  - `cache_key` (L463) uses the physical key;
  - `get_provider_for_workspace` passes them through;
  - invalidation bus `route` kind → `reset_route_cache` + `evict_data_source`.
- **`services/context_engine.py` `for_workspace` (L98):** §7 composition; remove the `ds_row.graph_name` pass-through (L213-226).
- **`providers/versioned_write_provider.py`:** every write method, including `update_edge` L177 and `delete_edge` L186, first calls `assert_writable`.

**Aggregation and projection target**
- `services/aggregation/service.py` `trigger` (L660): internal `target_graph_key` (verified against graphver as candidate or owned primary); otherwise `physical_key(ds,'derive')`; None → 409 `conversion_in_progress`.
- Aggregation worker uses `purpose='derive'`.
- `capacity.py` `graph_key_of` (L169): explicit target first; ignore `dedicated_graph_name` for versioned graphs.
- `services/projection_target.py`:
  - `repair_projection_target` (L203) only for `live_legacy` with an unpinned `gv_` name;
  - `make_rollup_rebuild_hook` (L73) passes `target_graph_key`.

**Topology** (`services/graph_store/topology.py` `_expected_graphs`, L275): register primary, candidate and retired keys, plus attached `source_graph_name`, from `read_routes()`.

**Endpoints and gates**
- `api/v1/versioning_gate.py` `_WRITE_ALLOWLIST_SUFFIXES` (L33): becomes a regex list adding `:cancel`, `/lifecycle/rollback`, `/lifecycle/freeze`, `/lifecycle/detach`, `/lifecycle/release-source`, `/lifecycle/history-exports`, `/ingest/sources/[^/]+/pause`.
- `api/v1/endpoints/graph.py`: shims; `apply_graph_changes` (L3720) uses the shared error map; `_ref` (L3664-3671) is unchanged.
- `api/v1/endpoints/workspaces.py` L655 / L727 / L759: as described in API.
- `db/repositories/data_source_repo.py`: `repoint_graph_name`.

**Deploy and docs**
- `deploy/helm/dataviz/templates/versioning-worker.yaml` (NEW, shared): a roles value and `GRAPHVER_*` config.
- Docs: `docs/RBAC.md` (lifecycle rows of §2), `docs/versioning/13-lifecycle.md` (NEW), `docs/FALKORDB_DR_RUNBOOK.md`.

## UI

All of this lives in the `DataSourceVersioningTab` hub (mounted at `components/admin/workspace/DataSourceDetailPanel.tsx:678`) using the §16 tab set. New code goes in `features/versioning/lifecycle/`.

**Data and permissions**
- `useLifecycle(wsId, dsId)` is a React Query poll: every 2 s while a job is pending or running, otherwise every 30 s, plus on focus.
- Buttons render only from `access.can`. A disabled button shows `HoverTip(accessCopy[reasons[a]])` and names `required[a]`.
- `usePermission` only hides whole tabs (Backups for non-admins).
- API functions are added to `services/versioningApiService.ts`:
  - lifecycle: getLifecycle, startPreflight, getPreflight, startConversion, getLifecycleJob, getEvidence, lifecycleJobAction;
  - state changes: cutover, rollback, reverify, adopt, relocate, rebuild, freeze, unfreeze, detach, releaseSource;
  - drift: startDriftScan, getDrift, runDriftSync, dismissDrift;
  - history, issues and impact: listLifecycleEvents, listLifecycleIssues, issueAction, createHistoryExport, listHistoryExports, getImpact.

**Building blocks**
- From `components/ui`: Button, Badge, Tabs, Segmented, ProgressBar, Skeleton, EmptyState, TimeStamp, HoverTip, TablePagination, DangerConfirmDialog, Backdrop, DurationField, UserAvatar, notifications.
- `hooks/useModalA11y`.
- Shared: ConflictResolver, SubjectPicker.

**StateBadge**

| State | Label | Tone |
|---|---|---|
| converting | Setting up | info |
| ready | Ready to switch | warning |
| live | Active | success |
| live_legacy | Legacy key | warning |
| frozen | Paused | neutral |
| detaching / detached | Detaching / Detached | neutral |
| trashed | In trash | destructive |
| purging | Deleting | destructive |

The route chip reads "Serving from: platform copy · shard 2", "original graph", or "history store (slower)".

### Tabs
1. **Overview.**
   - StateBadge, route chip, ProjectionHealthCard summary, SourceGraphCard summary.
   - No graph, or detached: an `EmptyState` titled "Version control is off" with the **Check this graph** button. Detached adds "History kept until…" and **Re-attach**.
2. **Conversion** (pre-live, plus adopt and history restore).
   - **ConversionWizard** (Backdrop + useModalA11y; replaces `EnableVersioningFlow.tsx`):
     1. Preflight progress.
     2. PreflightReport cards: Size & time, Identity coverage, Structure (estimated), Property types (TablePagination), Ontology alignment (the `ontology_containment_missing` fix hint links to the ontology editor), Capacity (per-shard bars, Postgres budget and fleet), Shared key.
     3. Acknowledge: one checkbox per ack. Admin acks are disabled for non-admins (`needs_admin`).
     4. Placement: `Segmented` Auto / Choose node.
     5. Confirm: "Viewing continues; editing pauses until you switch over" plus "I paused external writers".
     - States: Skeleton (loading); inline error + Retry; a stale banner leading to **Re-run checks** (`reverify_required:preflight_stale`); `capacity_insufficient` shows the per-shard / Postgres table; `ack_required` highlights the missing boxes.
   - **ConversionProgress** (replaces `BootstrapProgress.tsx`):
     - phase stepper with per-step ProgressBar, converge-pass chips, ETA;
     - Cancel (DangerConfirmDialog: "your original graph is untouched");
     - Resume and Start over on failure;
     - failure panel by code (`source_unstable`, `ack_required`, `capacity_insufficient`, `parity_failed`);
     - IssuesDrawer (virtualised, CSV).
   - **CutoverPanel:**
     - IntegrityReport with certificate and **Download evidence**; ShadowDiffs;
     - **Switch reads to the versioned graph**, with copy "editing opens in ~10 s; undo instantly until the first publish";
     - an `acceptDrift` toggle appears only after `reverify_required:source_moved`;
     - `version_conflict` → toast + refetch;
     - `lock_busy` / `replica_unconfirmed` → automatic retry with a countdown.
   - **Adopt:** reuses Progress and Cutover plus a gap report. On `outcome.code='repair_pr_opened'`, a card "Repairs are waiting for review" links to the PR, followed by **Continue adoption**.
3. **Data health.**
   - ProjectionHealthCard (extends `DataHealthTab.tsx`): key, node/slot, memory, lag, liveness, epoch, parity.
   - Actions Rebuild (blue/green), Move to another node (RelocateDialog with capacity bars), Evict/Rehydrate (owned keys).
   - INGEST's Storage card and RejectsTable.
   - `live_legacy` banner with **Move to a platform-managed copy**.
   - `read_store=postgres` banner with **Return to fast reads**.
   - **Undo switch-over** link while `cutoverSeq == mainHeadSeq`.
4. **Ingest** (INGEST).
5. **Drift & sync.**
   - SourceGraphCard: status, drift summary, **Scan now** (M), drift results list, writer-migration guidance.
   - **Keep in sync with original graph** opens SourceWizard steps 3–5 for the binding; conflicts go to the IssuesInbox on the Ingest tab.
   - Release eligibility checklist and **Release original graph**.
6. **Review & protection** (ACCESS).
7. **History.** `Segmented` → the Lifecycle segment is `LifecycleTimeline`, a keyset list of `lifecycle_events` (from→to, op, UserAvatar, TimeStamp, reason, job link).
8. **Backups** (admin): exports list (TimeStamp, size, verified Badge, download), Create backup, Restore into a new data source.
9. **Danger zone.**
   - Pause / Resume version control (freeze).
   - Turn off version control… → DetachDialog: mode Segmented, name availability check (`/blank-graphs/name-check`, `versioning.py:1352`), impact sections, Export history first, type-to-confirm. `review_pending` lists the PRs plus a **Close them and detach** (force) option.
   - ReleaseSourceDialog: Stop tracking / Delete original graph, eligibility checklist, type the key name; disabled while impact loads.
   - Delete data source: impact copy "Your original graph <key> is kept".

**Canvas.** The shared `useActiveBranchGuard` + `CanvasVersioningBar` show a read-only chip with reason and ETA for converting, ready, frozen and detaching. They handle `graph_not_writable` / `cutover_settling` (auto-retry) while keeping staged changes.

**Copy.** Every lifecycle code in §6 has an entry in `features/versioning/model/accessCopy.ts`, covered by the completeness test.

## Failure modes & recovery

| Failure | Behaviour | Recovery |
|---|---|---|
| Source key missing or unreachable at preflight | 503 `source_unreachable`; nothing created (EXISTS before any query) | Fix the provider, re-run |
| Worker SIGKILL in any phase | Stale heartbeat → takeover with epoch bump; the old worker fails `_own` | Automatic. Window transactions are atomic, version ids deterministic, seed MERGE resumes from the cursor |
| Concurrent Resume + Start over | `FOR UPDATE`; `job_active`; the loser's CAS fails `Superseded` | UI refetch |
| Source keeps changing | Converge fails `source_unstable` after 3 passes; main head unchanged | Pause writers and Resume, or Cancel |
| Source writes after verification or cutover | Drift; cutover → `reverify_required`; release blocked | Bind and sync, or acknowledge |
| Identity or value problems missed by sampling | validate → `ack_required`, issues listed with CSV | Ack (A for loss), Resume |
| Edit of a URN-less entity | `gv:src:7` → `_ref` → `src:7`, which exists | n/a |
| Source shard or Postgres failover mid-scan | Transient retry with backoff; `finalize_pg` is a single transaction | Automatic, or Resume |
| Candidate shard fills up | Governor hold; past `SEED_HOLD_MAX_SECS` → `capacity_insufficient`; candidate retired | Resume with another node |
| Candidate deleted out of band | Pre-swap: parity fails → re-seed. Post-swap: liveness → projected=0, Postgres reads, in-place seed | Automatic |
| WAIT returns 0 at swap | 503 `replica_unconfirmed`; Postgres unchanged | Retry |
| Crash between swap commit and broadcast | Stale pods serve content-equal data until `writes_open_at` | Automatic |
| Cold route lookup with Postgres down | 503 for versioned sources; a warm cache serves last-known | Automatic |
| Shadow blocking diffs | Job fails `shadow_blocking`; stays converting | Fix identity or ontology mapping, Re-verify |
| Aggregation during converting/ready | 409 `conversion_in_progress`; sweep skips | n/a |
| Wrong data after cutover | Undo while `main_head == cutover_seq`; afterwards rollback to postgres + Rebuild | One CAS + broadcast |
| Swap blocked by writers | `lock_busy` (503) or `catchup_required` | Retry |
| Freeze vs 50 in-flight draft saves | `FOR UPDATE` waits on `FOR KEY SHARE`; later saves see `frozen` | None needed |
| Freeze / trash / rollback with an active binding | Same transaction: source paused `lifecycle:<state>`; unfreeze/restore resumes via replay; a retention gap leaves it paused with an issue | Ingest panel |
| Held ingest rejects during non-writable states | Redrive enqueued on re-entering writable | Automatic |
| Adopt repair on a protected graph | Job completes `repair_pr_opened`; slot freed | Review → Continue adoption |
| Reimport or adopt edge with >1 live heads per triple | Deterministic-id match, else `ambiguous_identity` issue, edge skipped | Resolve the issue; Continue |
| Compaction during export, gap_scan or release | Compaction skips the graph; export holds `gvcompact` shared | n/a |
| As-of export inside a compacted range | 410 `history_compacted` | Choose a protected seq |
| Second relocate | New key `lc:relocate:<gid>:<rev>`; no IntegrityError | n/a |
| Release with the key shared by another data source | `release_not_eligible {shared_with}` | Remove that data source, or use `forget` |
| Change during release's final drift scan | Abort; nothing deleted | Sync or acknowledge, retry |
| GRAPH.DELETE timeout | Resumable; EXISTS=0 → proceed | Resume |
| Released key recreated within `RELEASE_WATCH_DAYS` | Hub and system-status alert | Find the writer |
| Detach crash between repoint and tombstone | Both idempotent; writes blocked | Resume |
| Materialize target name taken | `SeedRefused` → `graph_name_unavailable`; T11b | Pick another name |
| Detach with live PRs | `review_pending` unless `force` (closes `graph_detached`) | n/a |
| Failed lifecycle job at trash or purge | Cancelled in the same transaction | n/a |
| Purge transient error | Revived row with backoff; restore refused | Automatic |
| Purge leaves ingest shadow rows | Prevented: `bulk_ext` phase; test asserts 0 rows | n/a |
| Bug places a source key in a drop set | `is_droppable_owned_key` refuses; logged PROTECTED | n/a |
| `versioningEnabled` off mid-job | Workers continue; mutating routes 403 except the allowlist; ingest applier pauses | n/a |
| Move data source during a job | 409 `job_active` | Retry |
| Eviction races swap | Evict skips (gvproj held) | n/a |
| v1 jobs at deploy | `drain`: running → `live_legacy`; pending or failed → Restart with v2 | Adopt later |

## Rollout & migration of existing data

**Order** (shared §17)
1. **ACCESS R0** ships chain migrations 1–5 and 9, including 1300 with the lifecycle backfill, plus the same-PR v1 bootstrap code that maintains `lifecycle_state`.
2. **ACCESS R1.**
3. **L0** (migrations 6, 7, 11):
   - `lifecycle_state.transition`; `_assert_writable` (same semantics as before for existing states);
   - errors module;
   - purge fixes, impact, workspace move;
   - permanent delete is A;
   - a reconcile command re-applies the backfill rules to `lifecycle_rev=0` rows and must report 0 mismatches.
4. **L1:** routing choke point with routes equal to today's keys. A CI and staging assertion logs whenever `physical_key ≠ ds.graph_name` for legacy or non-versioned sources. Topology and aggregation derive routing.
5. **L2:** KeyMigration on owned keys only (blank graphs first: reseed, relocate); nightly chaos.
6. **INGEST S0:** system-ontology CONTAINS widening, plus plan 0.4, 1.3, 1.6 and 1.7.
7. **L3** (requires ACCESS R0 and INGEST S0), behind `versioningLifecycleV2`, workspace-scoped:
   - set `GRAPHVER_BOOTSTRAP_V1=drain` first;
   - `ReadOnlySourceClient`, preflight, lossless rules, converge, cutover;
   - drift_scan, release (default `forget`; `delete_key` opt-in; export required);
   - detach, history export and restore;
   - the hub UI.
8. **INGEST S1:** brings the `falkordb_snapshot` binding and drift_sync. INGEST registers the ingest hook on `transition()`. Purge `bulk_ext` / `_phase_meta` entries ship with the tables.
9. **INGEST S2:** activation needs `live` + owned key.
10. **ACCESS R2/R3.** New actions already enforce from day one.
11. **L4 adoption campaign:**
    - a read-only fleet `gap_scan` report first;
    - wave 1: zero-gap graphs under 100k entities, one seed per shard;
    - wave 2: graphs needing repairs (PRs on protected graphs);
    - wave 3: large graphs in maintenance windows;
    - `autoCutover=false`; capacity `need×1.3` counting co-residency;
    - 14 days of daily drift scans afterwards.
12. **INGEST S4 compaction** (protects `cutover_seq`), then **ACCESS R4**, then the go-live gate.

**Existing data**
- The backfill is deterministic, with per-state counts.
- `live_legacy` rows get `source_graph_name` populated.
- Duplicate-pinned tombstoned keys are set to NULL; live duplicates abort 1500 with a report.
- Failed purges are revived by the first reaper pass.
- No existing graph has `gv:src:` entities.
- `storage_bytes_est` for already-converted graphs comes from INGEST's offline backfill.

**Capacity**
- Source and platform keys co-reside until release.
- Placement refuses above 80% of maxmemory.
- The hub and status probe flag eligible-but-unreleased sources on shards above 70%.

**Observability**
- Gauges and metrics:
  - `gv_lifecycle_state{state}`
  - `gv_lifecycle_job_phase_seconds{op,phase}`
  - `gv_convert_dirty_windows`
  - `gv_parity_mismatch_total`
  - `gv_shadow_blocking_total`
  - `gv_drift_entities{kind}`
  - `gv_release_eligible_graphs`
  - `gv_route_cache_age_seconds`
  - `gv_seed_bytes_reserved{node}`
  - `gv_liveness_failures_total`
- Alerts: parity mismatch after a swap; unsynced drift older than 7 days; lifecycle job failed for more than 1h; failed purge; released key recreated; liveness failures.

**Benchmark gate:** measure copy, converge, seed and parity throughput on the largest graph (plan 3.8) and store the ETA priors. If the editing-paused window exceeds the SLO, the label-urn seek scan ships first.

**Rollback of the rollout:** every step is flag-gated and migrations are additive. Turning the flag off hides the UI; cut-over graphs stay `live`.

## Tests & pass criteria

| Test | Asserts | Pass |
|---|---|---|
| `unit/versioning/test_lifecycle_state.py` | Every TRANSITIONS row succeeds with exactly 1 `lifecycle_events` row; illegal pairs fail; stale rev → `VersionConflict`; `explain()` matches the golden state × principal matrix (R/M/P/A, protected or not, shadow vs enforce: new actions never shadow) | 100% of cells |
| `unit/versioning/test_entity_serde_inverse.py` (Hypothesis 10k) | `payload_to_source_shape(json(convert(x))) == normalize_source(x)`, including multi-label, NaN, temporal, reserved keys, blobs, idp and URN-less; single-field-drop mutants fail | 0 counterexamples; all mutants caught |
| `unit/versioning/test_edge_identity.py` | Order-independent ids; parallel `#h`; folding; collisions → issue + reidentify; synthetic endpoints never start with `gv:`; reimport/adopt resolve by triple (1 → reuse, many → deterministic match or `ambiguous_identity`, 0 → mint) | No collapse without an issue |
| `unit/versioning/test_synthetic_urn_addressing.py` | `/graph/changes` on `gv:src:7` updates `src:7` (`graph.py:3671`); `_eid_for_urn` and the projector agree | 0 creation ops |
| `unit/versioning/test_window_digest.py` | Field change, delete+add with ID reuse, cross-window move detected; order-independent | 0 false negatives / 1k |
| `unit/versioning/test_source_client_readonly.py` | Write cypher and `.delete()` raise; reads are RO_QUERY; `_count` never instantiates | FakeFalkor sees only RO_QUERY/EXISTS |
| `unit/test_provider_manager_routing.py` | `physical_key` golden table (derive None for converting/ready); cache per physical key; bus eviction; warm-stale / cold-503; topology attributes gvp keys; X-24 composition (service-only lag → projection, human commit → Postgres) | All |
| `unit/test_migrations_lifecycle_v2.py` | Upgrade head on an empty and a seeded DB (blank, fork, converted, failed mid-bootstrap, tombstoned, purging, duplicate-pinned); backfilled states; `ck_jobs_type` / `ck_commits_kind` live domain == ORM; one `JobORM` per type inserts; `uq_jobs_lifecycle_active` pre-check | All |
| `unit/test_error_contract.py` | Every lifecycle exception → the §6 type/status; `GraphNotWritable` is not mapped to `integrity`; Retry-After only for `cutover_settling` and 503; `accessCopy.ts` covers every code | All |
| `integration/test_conversion_v2_live.py` (real FalkorDB, 50k nodes) | Source DUMP digest unchanged; MONITOR shows no writes; inverse-equal Postgres; clean parity; reads from `gvp_`; `storage_budget_bytes` and `storage_bytes_est` set | All equal |
| `integration/test_conversion_converge_live.py` | A writer that stops → pass 2 clean, exact equality; a writer that never stops → `source_unstable`, `main_head==1` | Both |
| `integration/test_conversion_write_gate.py` | During converting/ready every write path (incl. edge PATCH/DELETE, draft create/reopen, PR open, merge, import, sync, revert, restore, fork) → 409 `graph_not_writable`; settling → `cutover_settling` then success | 0 leaked commits |
| `integration/test_gate_order_lifecycle.py` | A non-member draft save on a frozen graph → `graph_not_writable` (step 2 before 4/6); merge during `cutover_settling` → `graph_not_writable`; cutover with stale rev + not ready → `version_conflict` | First-failing codes match §7 |
| `integration/test_aggregation_d1.py` | 409 `conversion_in_progress`; sweep skips; source digest unchanged; rollups only on the owned key even with `dedicated_graph_name` | No customer-key write |
| `integration/test_keymigrate_live.py` | 1M-entity seed RSS < 300 MB; kill -9 resume gives no duplicates; SeedRefused cases; catch-up within 5 commits at 20 c/s; swap under writers loses 0 commits | All |
| `integration/test_cutover_rollback_live.py` | Undo while equal, `source_stale` after a publish; postgres/projection flips; multi-pod route convergence ≤ TTL+1 s | All |
| `integration/test_adopt_legacy_live.py` | Gap repair unprotected (kind import, actor `system:lifecycle`, `requested_by`); protected → private draft owned by the requester, PR authored by them, job completed `repair_pr_opened`, slot free; merge → Continue → 0 gaps → swap; no writes to the legacy key | All |
| `integration/test_lifecycle_ingest_coupling.py` | freeze, trash, detaching and rollback pause active/throttled/blocked sources (`lifecycle:<state>`, revision row by `system:lifecycle`); unfreeze/restore resume; detached retires; resume on frozen → 409; activation on `live_legacy` → `projection_not_adopted`; redrive enqueued on entering writable | All |
| `integration/test_drift_binding_live.py` | Scan reports exactly 10 changed / 5 new / 3 deleted; binding activation seeds the shadow from the baseline; drift_sync commits kind `ingest` actor `svc:ingest:<sid>`; 2 human-edited entities → `ingest_issues` conflict; deletes propagate via shadow; release retires the binding | All |
| `integration/test_release_detach_live.py` | Each ineligibility reason; `delete_key` removes only the source; drift during the final scan aborts; recreated-key watch; release re-auth (demoted admin → job fails before delete); handover / materialize; force-detach closes PRs and abandons drafts with `graph_detached`; reimport on a protected graph → `review_required` | All |
| `integration/test_history_export_authz.py` | M → 403 `needs_admin`; the bundle has `pr_reviews`, `access_events`, `lifecycle_events`, `commit_compactions`, `ingest_source_revisions`; restore keeps owner and visibility; as-of inside a compacted range → 410 | All |
| `integration/test_graph_lifecycle_purge.py` | Failed purge revived; failed relocate cancelled; restore refused; reaper isolation; after purge 0 rows for `:g` in every graphver table except the 3 audit tables + the purge job row | All |
| `integration/test_lifecycle_concurrency.py` | 20 interleavings each: cutover vs publish, cutover vs evict, swap vs projector, resume vs restart, freeze vs 50 draft saves, freeze vs drift_sync, detach vs publish, trash vs convert, relocate vs relocate, compaction vs history_export | One winner per rev; 0 draft commits after the freeze event; monotonic epoch; 0 IntegrityError |
| `frontend/.../lifecycle/__tests__/LifecycleHub.test.tsx` (RTL + vitest-axe) | Screen per state; buttons follow `access.can` with reasons; `version_conflict` → toast + refetch; `lock_busy` retry; wizard ack gating; release type-to-confirm; `repair_pr_opened` card; canvas keeps staged changes | 0 axe violations |
| `e2e/playwright/lifecycle.spec.ts` (nightly) | preflight → convert → cutover → edit/publish visible in 30 s → relocate → freeze/unfreeze → scan → bind + sync → export → release(forget) → detach(materialize) → re-attach; proxy log shows no non-RO command to the source until release | All |
| Load + chaos (Phase 5 gate) | 10M/30M convert with 3 worker kills, Postgres failover and FalkorDB master failover; adopt 50 graphs with 300 concurrent editors | Clean parity, 0 duplicate ids, publish p95 < 3 s during swaps, shards < 80% |

## Findings resolved

| Finding | Resolution |
|---|---|
| BOOTSTRAP-1 / FALKORSCALE-2 / LIFECYCLE-8 | No customer key in `projection_state`; owned-only eviction under gvproj with a marker check |
| BOOTSTRAP-2 | No backfill; `seed_stream` refusals; blue/green rebuild; 409 in converting/ready |
| BOOTSTRAP-3 | `/graph/resync` replaced by windowed drift_scan plus the ingest binding |
| BOOTSTRAP-4 | `_assert_writable` on every write path, including edge PATCH/DELETE; converge + extras |
| BOOTSTRAP-5 / 9 | Resolved by construction |
| BOOTSTRAP-6 | Deterministic edge ids, reidentify, heads count check, triple-first resolution (X-09) |
| BOOTSTRAP-7 / 12 | Lossless payload, inverse-mapping validation, per-row issues, `allow_nan=False` |
| BOOTSTRAP-8 | Never projected into the customer key; `uq_ps_key`; shared-key release block |
| BOOTSTRAP-10 | `FOR UPDATE` retry, epoch bump, phase CAS |
| BOOTSTRAP-11 | Cached max_id, `to_thread`, slots, semaphores |
| BOOTSTRAP-13 | Freeze, detach, re-attach; honest copy with ETA |
| PROJECTION-1 | `gv:src:<ID>` URNs via the `gv:` convention |
| PROJECTION-2 / FALKORSCALE-7 | Marker + WAIT, liveness loop, watermark reset |
| PROJECTION-3 | Swap sets watermarks explicitly; L589 pin removed; epoch fencing |
| FALKORSCALE-6 | Per-graph tags, `shard_map`, relocate, `repair_projection_target` restricted |
| APIOPS-1 | `POST /graphs` ignores client key names |
| APIOPS-2 | Single Helm worker with roles (X-28) |
| LIFECYCLE-2 / STORE-4 | Full-union `ck_jobs_type` with ORM parity (X-01) |
| LIFECYCLE-3 | Purge revive, backoff, restore block, cancel blockers |
| LIFECYCLE-10 | Hub per §16 |
| LIFECYCLE-12 | Workspace move fixed |
| LIFECYCLE-13 | Deleted graphs excluded; purge quiesce and sweep; `bulk_ext` (X-14) |
| LIFECYCLE-14 | Impact counts fixed |
| GAP_PROJECTION_LEASE_FENCING-1 / 2 | Unpinned until swap; key uniqueness; filters |
| TESTS-3 | Live conversion, converge, adopt, drift and D1 suites |

Integration issues applied: X-01, X-02, X-03, X-04, X-06, X-07, X-08, X-09, X-11, X-12, X-13, X-14, X-15, X-16, X-17, X-18, X-19, X-20, X-22, X-23, X-24, X-26, X-27, X-28, X-30.

## Open questions
1. **Requested §6 additions:** `409 data_source_has_data {next}` and `422 bundle_invalid {file, expectedSha, gotSha}`. Every other lifecycle condition is folded into the canonical codes with a `reason` field (`reverify_required:{preflight_stale, source_moved, parity_stale, shadow_blocking, rollups_missing, projection_unhealthy}`, `source_stale:{released}`, `source_unreachable:{missing}`).
2. **Requested access.py Actions beyond X-04:** `LIFECYCLE_CANCEL` (M), `LIFECYCLE_RELEASE` (A), `LIFECYCLE_DELETE` (A), `LIFECYCLE_TRASH` (P; A when protected), `DRIFT_SYNC` (P), `DRIFT_DISMISS` (A).
3. **§13 refinement for INGEST to confirm:** when a triple has more than one live head and one head id equals the deterministic import mint (a converted parallel group), conversion and adopt reuse it. INGEST still raises `ambiguous_identity` for any >1 case.
4. **Divergent parallel edges** stay collapsed in the projection. Revisit after the preflight fleet report.
5. **Release default:** stay with `forget`, or switch to `delete_key` after 14 healthy days? Should large graphs on tight shards get a shorter period?
6. **Detached data sources become read-only on the canvas** when `GRAPHVER_VERSIONED_WRITES=1` (`versioned_write_provider.py:118 _graph_id`). Is that intended?
7. **Synthetic identity uses FalkorDB internal IDs**, which are reused after deletes. Drift on URN-less entities may read a delete+create as a change. Accept?
8. **Drift-scan default cadence:** daily (one scan per graph per day) or weekly?
9. **Hash-tag braces** must be accepted in every key path (GRAPH.LIST parsing, generation keys, UI). This is verified in L2; the fallback is tag-free names found by CRC16 search.
10. **Is the editing-paused window acceptable** for the largest graphs (about 3k edges/s today)? If not, the seek scan is required before go-live.

### Critical files for implementation
- /home/user/dataviz/backend/app/services/versioning/bootstrap_worker.py
- /home/user/dataviz/backend/app/services/versioning/service.py
- /home/user/dataviz/backend/app/services/versioning/projection.py
- /home/user/dataviz/backend/app/services/versioning/purge_worker.py
- /home/user/dataviz/backend/app/providers/manager.py
