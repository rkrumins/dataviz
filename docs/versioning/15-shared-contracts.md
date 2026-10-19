# 15 · Shared contracts for access, lifecycle v2 and streaming ingestion

Binding for [13](13-access-and-review.md), [14](14-graph-lifecycle-v2.md) and [12](12-streaming-ingestion.md). Section numbers (§1–§17) are what those specs cite as "contract §N".

### 1. Principals and actors
Every service entry point has a required keyword-only `principal`; `test_service_signatures` covers lifecycle and ingest entry points too. The `Principal` dataclass is defined in `versioning/access.py`.

| kind | actor string | built by | may do |
|---|---|---|---|
| human | `<user_id>` | `principal_ctx` | per §2 |
| service | `svc:ingest:<source_id>` | `Principal.service(sid)` | only `INGEST_APPLY` via `apply_source_delta`; never reads or writes drafts or PRs |
| system | `system:{ttl,migration,lifecycle,sync,compaction,purge,storage_guard}` | `Principal.system(name)` | ttl: abandon drafts. lifecycle: import/repair commits (an unprotected graph only), transitions. sync: `sync_ingest` commits on behalf of `requested_by`. |

The bare `system` actor is never written again.

Jobs created by a human store `summary.principal` (from `Principal.snapshot()`) and `summary.bypass`. Each job re-authorizes from that snapshot under the lock before its irreversible phase.

`commits.actor_kind` and `access_events.actor_kind` both take values in {human, service, system}.

### 2. Permissions
Notation: R = `workspace:datasource:read`, M = `…:manage`, P = `…:publish` AND manage, A = `workspace:admin`.

**Prerequisite (ACCESS R0).** Add `'workspace:datasource:publish'` to `_SEED_LEAVES['workspace:datasource']` (permission_service.py:430) and to `_WORKSPACE_CATEGORY_LEAVES`. Seed role `workspace_publisher`. Grant publish to `workspace_data_engineer`, `org_admin` and `super_admin`. `workspace_member` does not get it.

**Shadow mode** applies only to legacy actions. Every lifecycle, ingest and A action always enforces.

| Area | R | M | P | A |
|---|---|---|---|---|
| Drafts / PRs | ACCESS §4 matrix, unchanged | | | |
| Lifecycle | snapshot, preflight report, issues, events, evidence, drift view | preflight, drift scan, cancel pre-cutover/pre-swap job | start convert, resume/restart, cutover, rollback (any target), reverify, adopt and continue adoption, relocate, rebuild/reseed, freeze/unfreeze, drift-sync run, DS soft delete/restore (A when protected) | release source, detach, permanent delete, loss/reidentify acks, mass-delete override, drift dismiss, history export, history restore/import |
| Ingest | list/read sources, status, issues, entity source chips, revisions | create/edit/propose (inert), dry-run, pause, issue dismiss ('current'), view rejects | approve policy (four-eyes when `require_review`), activate, resume, replay/rewind, confirm-deletes, retire, redrive, discard, issue take-source → main | storage budget/retention |
| Ingest: custom value | issue 'value' → main follows `MAIN_WRITE_THROUGH`: P and not protected; otherwise 409 `review_required {canStageToDraft}` or a bypass. Target=draft needs `DRAFT_WRITE`. | | | |
| Graph policy | `POLICY_READ` | | | `PATCH /graphs/{gid}/policy`: requireReview, requiredApprovals, bypassPolicy, requireUpToDate, ingestGuardrails |

### 3. Graph columns (single owner: migration 20261010_1300)
**From ACCESS**
- `require_review` bool, default false
- `required_approvals` smallint, 1–10, default 1
- `bypass_policy` ∈ {nobody, admins, publishers}, default admins
- `review_policy_version` bigint, default 1
- `policy_updated_by`, `policy_updated_at`

**From plan 1.3**
- `require_up_to_date` ∈ {on_overlap, always}, default on_overlap

**From INGEST**
- `ingest_guardrails` jsonb
- `storage_bytes_est`
- `storage_budget_bytes`
- `ingest_retention_days`
- `storage_state` ∈ {ok, warn, critical, over}

**From CONVERSION**
- `lifecycle_state` ∈ {converting, ready, live, live_legacy, frozen, detaching, detached, trashed, purging}
- `lifecycle_rev`
- `read_store` ∈ {source, projection, postgres}
- `prior_state`
- `source_graph_name`, `source_provider`
- `source_status` ∈ {attached, released_kept, released_deleted}
- `source_released_at/by`
- `cutover_at`, `cutover_seq`, `live_since`, `writes_open_at`, `last_unhealthy_at`
- `drift_summary`, `drift_scan_hours`, `identity_property`

The lifecycle backfill (CONVERSION) also runs in this migration.

### 4. Enumerations (every CHECK is widen-only; the ORM equals the migration)
**Commits and jobs**
- `ck_commits_kind`: genesis, edit, checkpoint, squash_publish, import, sync, revert, restore, pull, ingest.
- `ck_jobs_type`: ingest (file import), projection, rebuild, export, bootstrap, publish, purge, lifecycle, preflight, ingest_dryrun, ingest_replay, ingest_redrive, compaction.
- `jobs.op` (lifecycle only): convert, adopt, relocate, reseed, detach, release_source, drift_scan, drift_sync, history_export, history_restore.

**Branches**
- `branches.visibility` ∈ {private, members, workspace}. `is_shared` is derived.
- `branches.status` is unchanged: open, publishing, merged, abandoned.
- `abandon_reason` ∈ {user, ttl, graph_deleted, graph_detached, migration}.

**Merge requests and reviews**
- `merge_requests.close_reason` ∈ {user, draft_abandoned, migration, graph_detached}.
- `approval_status` ∈ {not_required, pending, approved, changes_requested}.
- `merged_via` ∈ {review, direct_publish, bypass}.
- `pr_reviews.state` ∈ {approved, changes_requested, commented}.
- `dismiss_reason` ∈ {stale, manual, reviewer_removed, legacy_unbound}.

**Ingest**
- `ingest_sources.state` ∈ {draft, paused, active, blocked, throttled, paused_budget, retired}.
- `state_reason` prefix `lifecycle:<state>` marks a lifecycle-driven pause.
- `decoder` ∈ {openlineage, canonical, snapshot (implicit `/sync` only, never applyable), falkordb_snapshot}.
- `delivery` ∈ {live, replay, redrive, snapshot}. Only `live` is offset-fenced.
- `ingest_issues.kind`: conflict, delete_modify, placement, invalid, ambiguous_identity, foreign_endpoint, out_of_scope, overridden.

**Conversion**
- `conversion_issues.kind`: unconvertible, id_collision, duplicate_urn, synthetic_urn, parallel_divergent, reserved_key, value_normalized, projection_parity, shadow_diff, external_write, source_drift.

**Audit**
- `access_events.action`: the ACCESS list MINUS graph.*, projection.* and ingest.*. Those facts belong to lifecycle_events, ingest_source_revisions and commits.
- `access_events.decision` ∈ {allowed, bypassed, denied, would_deny}.

### 5. Migration chain
**Shipped so far** (linear; each `down_revision` is the previous entry; the first follows `20261014_1200_aal_api_key`; head `20261018_1200_gv_lifecycle`). Every revision runs through alembic against the management database. The `gv_*` ones change `graphver` tables there, each waiting at most 5 s for its table's lock, and do nothing when those tables are not in that database. With a separate `GRAPHVER_DB_URL`, the versioning worker repeats each `gv_*` change at start (`models._ensure_schema_upgrades`); a required step that fails stops the worker, and its restart tries again. So with a separate `GRAPHVER_DB_URL`, start the versioning workers on this release before rolling the API pods: they select the new graphver columns (`graphs.lifecycle_*`, `merge_requests.approvals`, `projection_state.epoch`/`retired_keys`) on nearly every versioning request, reads included, and fail until those columns exist.
1. `20261017_1000_datasource_publish`: management DB. Seeds `workspace:datasource:publish`, the system role `workspace_publisher`, and the grants to `org_admin`, `super_admin` and `workspace_data_engineer` (not `workspace_member`). Replaces planned 1.
2. `20261017_1500_gv_ps_keys`: graphver. `uq_ps_key`, a partial unique index on `projection_state (coalesce(falkor_provider, 'default'), falkor_graph_name)`. A trashed graph that does not own a key another graph pins lets go of it first; pins still shared abort the upgrade and are named. The `uq_ps_key` part of planned 6 (no candidate key). Worker start: optional; shared pins are logged and leave the index unbuilt.
3. `20261017_1550_gv_ps_fencing`: graphver. `projection_state.epoch`, `failed_attempts`, `next_retry_at`. Not in the plan. Worker start: required.
4. `20261017_1900_gv_commits_idem`: graphver. `uq_commits_idem`, a partial unique index on `commits (graph_id, branch_id, idempotency_key)`; a later commit sharing a key on the same branch has its key cleared first. Anticipates planned 10, but as a plain build that keeps `ix_commits_idem` and adds no `ix_commits_actor`. Worker start: optional.
5. `20261017_1950_gv_ingest_active`: graphver. `uq_jobs_ingest_active`, a partial unique index on `jobs.branch_id` for a pending or running import; imports nothing will run are failed first, and imports running together on one draft stop the upgrade. Not in the plan. Worker start: optional; imports running together leave the index for a later start.
6. `20261017_2000_gv_ps_reseeding`: graphver. `ck_proj_status` allows `reseeding`; the downgrade turns those rows back to `idle`. Not in the plan. Worker start: required.
7. `20261018_1000_gv_mr_approvals`: graphver. `merge_requests.approvals` JSONB, `{actor: {headCommitId, headSeq, at}}`; an approval given before it has no head and counts as stale. Anticipates the approval-to-head binding of planned 5, without `pr_reviews`, `ck_mr_approval_status` or the backfills. Worker start: required.
8. `20261018_1100_gv_ps_retired`: graphver. `projection_state.retired_keys` JSONB, `[{name, provider, retireAfter, afterSeq, movedBy}]`; the downgrade drops it and logs how many graphs still had keys waiting; those keys are then never dropped for you. The retired-keys part of planned 6. Worker start: required.
9. `20261018_1200_gv_lifecycle`: graphver. `graphs.lifecycle_state` (`live` or `frozen`, `ck_graphs_lifecycle_state`), `lifecycle_rev`, `lifecycle_changed_at`; every existing graph reads `live` at rev 0 from the defaults. The freeze subset of planned 4: `trashed` and `purging` stay derived from `deleted_at` and the purge job, and no other §3 column is added. The downgrade drops the columns, so every frozen graph is editable again. Worker start: required, 10 tries of 500 ms.

**Planned (later stages)** (linear; down_revision = the previous entry; the first entry follows 20260930_1000_outbox_type_time)
1. `20261010_1000_datasource_publish`: management DB: permission, role, grants.
2. `20261010_1100_gv_commits_kind_actor`: ck_commits_kind adds 'ingest'; commits.actor_kind, source_id and source_ref; batched backfill (genesis, import and sync become system).
3. `20261010_1200_gv_jobs_types`: full-union ck_jobs_type; jobs.op and not_before.
4. `20261010_1300_gv_graphs_policy_lifecycle`: §3 columns plus the lifecycle backfill.
5. `20261010_1400_gv_access_review`: branches and branch_members columns, merge_requests columns plus ck_mr_approval_status NOT VALID, pr_reviews, access_events plus trigger, and the backfills (visibility, legacy approvals → legacy_unbound, zombie PRs). Then VALIDATE.
6. `20261010_1500_gv_projection_state_keys`: projection_state candidate, retired, parity and liveness columns; uq_ps_key and uq_ps_candidate_key with the duplicate pre-check.
7. `20261010_1600_gv_lifecycle_tables`: lifecycle_events, conversion_windows, conversion_issues, conversion_seen.
8. `20261010_1700_gv_ingest_tables`: ingest_sources, ingest_source_revisions, ingest_source_partitions, ingest_offsets, ingest_run_state, ingest_rejects, commit_compactions; source_assertions and ingest_issues (partitioned, added to PARTITIONED_TABLES, children created).
9. `20261010_1800_gv_idx_concurrent_a` (autocommit): ix_branches_graph_status_upd, ix_bm_subject, ix_mr_reviewers_live, ix_graphs_lifecycle.
10. `20261010_1900_gv_commits_idem_unique` (autocommit, per partition then ATTACH): uq_commits_idem; ix_commits_actor; drop ix_commits_idem.
11. `20261010_2000_gv_jobs_lifecycle_active` (autocommit): uq_jobs_lifecycle_active with the duplicate pre-check.

The ORM CHECKs and tables are updated in the same PR as each migration. `test_migrations_*` asserts that the live CHECK domains equal the ORM domains after upgrade head.

### 6. Exceptions → HTTP (versioning/errors.py; one `_domain_errors` table reused by every router)
**Live now.** Each class in `errors.HTTP_MAPPED` carries its status, `detail` and headers. The versioning router's `_domain_errors` maps them before its other clauses, and `main.py` registers a handler for each, so routes on other routers (graph, workspaces, admin) answer the same. Every body below is the response's `detail`; a class from `errors.py` always adds `message`. Codes in the target lists further down that are not in this table are not live yet.

| Status | Code | `detail` as the code returns it | Raised by |
|---|---|---|---|
| 403 | `not_draft_owner` | `{type:"access_denied", code, branchId, owner, message}` | a write, rename, abandon or member change on someone else's private draft; a change of `isShared` by anyone but the owner |
| 403 | `not_owner_or_member` | `{type:"access_denied", code, required:"editor"\|"maintainer", branchId, message}` | a shared draft refused the caller: editor to write, maintainer to publish, abandon, rename or manage members |
| 403 | `self_review` | `{type:"access_denied", code, prId, message}` | an approve by the PR's author or its source draft's owner |
| 403 | `publish_required` | `{type:"access_denied", code, required:"workspace:datasource:publish", message}` | a person without publish writing a versioned graph's main directly (graph-router writes with no draft, bulk ingest), or an API key whose owner lacks it |
| 403 | `needs_admin` | `{type:"access_denied", code, required:"workspace:admin", error:"missing_permission", permission:"workspace:admin", scope:{type:"workspace", id}, message}` | `?force` or `?allowMassDelete` on a sync or re-sync by anyone but a workspace admin |
| 403 | `missing_permission` | `{error:"missing_permission", permission, scope:{type, id}, message:"Missing permission: <perm>"}` — no `type` key | the route gate `requires(...)`; this is what a person without publish gets on publish, merge, revert, restore, sync, `/graph/resync` and freeze/unfreeze. Replaces the design's `needs_publish_permission` |
| 403 | `api_key_not_allowed` | `{error:"api_key_not_allowed", message}`, `WWW-Authenticate` challenge | an API key on a route that is not on the key surface (graph creation, forks, members add/remove, publish, merge, revert, restore, sync, reviewers, freeze/unfreeze, `/admin/versioning/*`) |
| 403 | `access_denied` | `{type:"access_denied", message}` | any other draft-access refusal (the backstop in `_domain_errors` and `main.py`) |
| 403 | `feature_disabled` | `{type:"feature_disabled", feature:"versioningEnabled", message}` | a mutating versioning route while the switch is off, except `…/projection/rebuild`, `…/projection/reconcile`, `…/exports` and `…/lifecycle/freeze` |
| 404 | — | a plain string: `"unknown branch"` (a draft the caller can't read, or none), `"graph not found in workspace"`, `"pull request not found in workspace"` (also a PR the caller takes no part in); on the graph router an unreadable `?branchId=` answers `"'branch_not_found: <bid>'"` | `DraftNotReadable`, `graph_in_workspace`, `pr_in_workspace`, `get_context_engine`; any other `ValueError` answers 404 with its text |
| 409 | `branch_closed` | `{type, status, branchId, message}` | a write, checkpoint, pull or publish on a merged, abandoned or publishing draft |
| 409 | `main_write_forbidden` | `{type, message}` | `main` (literal or by id) on `/graph/changes`, an import or a view route's `branchId`; `main`'s id on stage, checkpoint, pull or a publish job. Abandon, rename, members and merge requests refuse `main` with 404 or 403 |
| 409 | `graph_not_writable` | `{type, state, reason, retryable:false, message}`; `reason` equals `state`: `frozen`, `trashed`, `purging`, or any stored state this code does not know. Never a `Retry-After` | a content write to a graph that is not live (§7, §9) |
| 409 | `version_conflict` | `{type, resource:"lifecycle", currentVersion, message}` | a freeze or unfreeze whose `expectedRev` is stale |
| 409 | `integrity` | `{type, message}` | a `ConcurrencyError`: a write, draft open or freeze while version control is still being enabled; a bulk ingest into a graph that already has entities; `POST /graphs` naming a FalkorDB key another versioned graph projects into |
| 409 | `bootstrapping` | `{type, message}` | a projection rebuild, or an admin projection move, while version control is still being enabled |
| 409 | `pull_request_exists` | `{type, prId, branchId, title, message}` | opening a second live request from a draft; deleting a fork whose PR into its parent is live |
| 409 | `approval_required` | `{type, pending, stale}` — no `message` | a merge (in the request, or before it is queued) whose requested reviewers have not all approved the current head. The design's `missing` is `pending` |
| 409 | `head_moved` | `{type, prId, headCommitId, message}` | an approve whose `expectedHeadCommitId` is no longer the source branch's head |
| 409 | `not_up_to_date` | `{type, branchId, behindBy, message}` | a publish or merge of a draft behind `main`. The design's `{overlapIds, reason}` is not live |
| 409 | `merge_conflict` | `{type, conflicts}`; `/graph/changes` adds `current` | a same-field clash in a merge or save |
| 409 | `too_large_for_tree` | `{type, changed, limit, message}` | the Changes tree's `/children` past `GRAPHVER_DIFF_TREE_MAX_CHANGES` |
| 409 | `job_active` | `{type, jobId, message}` | a second import on a draft; a publish, merge or publish job while an import runs on the draft; a data-source move while any job runs on the graph or its forks; an admin projection move while a rollup rebuild runs |
| 409 | `curation_at_risk` | `{type, lastHumanCommit:{id, seq, kind, actor, createdAt}, message}` | a sync or re-sync while `main` holds a person's commit from before its last import or sync |
| 409 | `mass_delete_blocked` | `{type, deletes, live, limit, message}` | a sync or re-sync that deletes more than `max(GRAPHVER_SYNC_DELETE_MAX_ABS, GRAPHVER_SYNC_DELETE_MAX_FRACTION × live)` |
| 409 | `fork_limit` | `{type, limit, message}` | a fork, or a fork restore, past `GRAPHVER_MAX_FORKS_PER_GRAPH` live forks |
| 409 | `not_a_fork` | `{type, graphId, message}` | a fork delete or restore on a graph `fork_graph` did not mint |
| 409 | `live_forks` | `{type, graphId, forks, message}` | deleting a fork that has live forks. A data source's permanent delete refused because forks read its graph answers `{type:"live_forks", message}`, without `graphId` or `forks` |
| 409 | `fork_not_restorable` | `{type, graphId, reason:"purging"\|"parent_deleted", message}` | restoring a fork whose purge exists, or whose parent is missing or trashed |
| 409 | `graph_moved` | `{type, graphId, message}` | a data-source move whose graph another move already took to a third workspace |
| 409 | `projection_not_adopted` | `{type, reason:"unpinned"\|"customer_key"\|"shared", sharedWith (shared only), message}` | an admin projection move of a graph that is unpinned, still on the customer's own key, or on a key other data sources read |
| 409 | `graph_key_in_use` | `{type, providerId, key, message}` (class `ProjectionKeyInUse`) | an admin projection move onto a key another graph holds. Enabling version control onto a taken key answers the same `type` as `{type, message}` |
| 422 | `ineligible_member` | `{type, subjectId, reason:"owner"\|"unknown_user"\|"unknown_group"\|"no_read"\|"no_manage", message}` | adding a draft member who cannot hold the role |
| 422 | `invalid_target_key` | `{type, key, message}` (class `ProjectionKeyInvalid`) | an admin projection move naming a key that is not this graph's platform key, one of its retired keys or its current key |
| 422 | `projection_mode_unsupported` | `{type, message}` | an admin projection move of a data source with a dedicated rollup graph |
| 422 | `provider_unsupported`, `provider_unreachable` | `{type, message}` | a provider that is missing, inactive, not FalkorDB, or offline, for a new versioned graph, a blank model or a projection move |
| 422 | `ontology_violation` | `{type, violations}` | the ontology gate |
| 422 | `invalid_patch` | `{type, message}` | an `unsetProperties` that contradicts its op |
| 422 | `graph_too_large_to_sync` | `{type, entities, limit, estimatedBytes, message}` | a sync or re-sync of a `main` above `GRAPHVER_RESYNC_MAX_ENTITIES` (`main.py` handler) |
| 422 | `ontology_required` | `{type, message}` | a write to an ontology-governed graph whose data source has no assigned ontology |
| 422 | `invalid_cursor` | `{type, message}` | an entity-history `before` cursor the server did not issue |
| 503 | `lock_busy` | `{type, retryable:true, message}`, `Retry-After` | a graph, lifecycle, move, draft, PR or graph-row lock not granted within `GRAPHVER_GRAPH_LOCK_TIMEOUT_MS` (`Retry-After` = that bound in seconds, at least 1; 5 by default), or every retry of a write lost (`ContentionExhausted`, `Retry-After: 2`) |
| 503 | `groups_unavailable` | `{type, retryable:true, message}`, `Retry-After: 2` | a role that turns on a group, when the caller's groups can't be read |
| 503 | `provider_unreachable` | `{type, retryable:true, message}` | an admin projection move that cannot list the provider's keys |
| 503 | `ontology_unavailable` | `{type, message}` | a write to an ontology-governed graph whose ontology cannot be resolved |
| 503 | — | `"Authorization temporarily unavailable"` | a permission gate (`requires`, `publish_required`, `needs_admin`) that would refuse but could not read the workspace grants |

**Target (design).**

**403**
- 403 `{type:'access_denied', code}` with code ∈ {not_owner_or_member, not_draft_owner, needs_publish_permission, needs_admin, self_review, contributor_cannot_approve, not_eligible_reviewer, bypass_not_allowed, service_principal_forbidden, self_approval_forbidden}, plus `required`.
- 403 `feature_disabled`.

**404**
- Any draft, PR, graph or job the caller cannot read. Indistinguishable from not-found.

**409**
- graph_not_writable `{state, reason, retryable}`. Retry-After only when reason=cutover_settling.
- Branch and PR state: branch_closed, main_write_forbidden, pr_closed, pull_request_exists.
- Review gate: review_required `{prId?, canStageToDraft?}`, review_pending, approval_required `{missing, stale}`, changes_requested, pending_changes, head_moved.
- Merge: not_up_to_date `{overlapIds≤50, reason:'people'|'structure'}`, merge_conflict `{conflicts[], theirs.sourceName?}`.
- version_conflict `{resource, currentVersion}`. This replaces 412 policy_version_mismatch, policy_version_conflict and lifecycle_conflict; the lifecycle routes keep `expectedRev` as the input name.
- Jobs: job_active, lifecycle_job_running, replay_in_progress.
- Lifecycle: projection_not_adopted, capacity_insufficient, conversion_in_progress, release_not_eligible, reverify_required, catchup_required, source_stale.
- Ingest: retention_gap, routing_overlap, dryrun_required, policy_unapproved, source_state.
- Quota: fork_limit `{limit}` (live forks per graph, GRAPHVER_MAX_FORKS_PER_GRAPH).

**410**
- history_compacted `{fromSeq, toSeq, checkpointCommitId}` on every as-of, diff, revert, restore and export path.

**422**
- ontology_violation (includes DanglingReference), bypass_reason_required, ineligible_member, ineligible_reviewer, client_upgrade_required, invalid_source_config, policy_violates_guardrail, ack_required, confirm_mismatch, ontology_containment_missing.

**503**
- lock_busy (LockBusy and ContentionExhausted) with Retry-After.
- groups_unavailable, replica_unconfirmed, source_unreachable.

### 7. Gate order (first failure wins)
**Draft write** (stage, apply_ops on a draft, checkpoint, rebase, import into a draft):
1. Request validation. A main id or the literal 'main' on `/graph/changes` or an import returns 409 main_write_forbidden.
2. `graphs FOR KEY SHARE`, then `_assert_writable` → graph_not_writable.
3. Branch `SELECT … WHERE id AND graph_id FOR UPDATE` → 404.
4. READ_DRAFT → 404.
5. `_require_open` → branch_closed.
6. `_authorize(DRAFT_WRITE)` → 403.
7. OCC / ontology.
8. Commit, then `_on_draft_content_changed`.

**Publish / merge:**
1. `_lock_graph`.
2. `graphs` re-read (policy plus lifecycle) and `_assert_writable`.
3. Draft FOR UPDATE populate_existing, then PR FOR UPDATE.
4. PR live, `_require_open`, no import pending or running on the draft (job_active), graph match.
5. `_authorize(PR_MERGE | DIRECT_PUBLISH)`.
6. pending_changes.
7. Review gate, or bypass.
8. D2 overlap gate (`require_up_to_date`; service-only overlap joins the merge).
9. `_compute_merge_bounded` → merge_conflict.
10. Ontology.
11. Squash, with `stats.review` and `auto_rebased_*`.
12. access_events.

**Ingest apply** (`apply_source_delta`):
1. `_lock_graph(lock_timeout 1 s)`.
2. `_assert_writable`.
3. `ingest_sources FOR SHARE`, then `INGEST_APPLY` (§8 guard of X-08), or HOLD when state is blocked.
4. Offset fence (live delivery only).
5. LWW fold.
6. Identity (§13).
7. Shadow, merge, scopes, delete governance / breaker.
8. `_commit_values(kind='ingest', actor_kind='service')`.
9. Shadow, issues and offsets in the same transaction.

**Lifecycle transition:**
1. gvproj session lock, if a swap.
2. `gvlifecycle:<gid>` exclusive.
3. `_lock_graph`.
4. `graphs FOR UPDATE`.
5. CAS on `lifecycle_rev`.
6. Same-transaction side effects: ingest_sources pause/resume/retire, PR/draft closure on detach, lifecycle_events.

**Shipped so far.** There is no `_authorize`, READ_DRAFT step, policy, bypass or access_events in the shipped writes: the route checks its permission (`requires(...)`) first, then the service runs these steps. Every lock wait is bounded by `GRAPHVER_GRAPH_LOCK_TIMEOUT_MS` (503 `lock_busy`).
- *Draft write* (stage, checkpoint, rebase): `gvlifecycle:<gid>` shared → `_assert_writable` (`graphs` FOR KEY SHARE; graph_not_writable) → branch `FOR NO KEY UPDATE`, scoped to the graph (404 "unknown branch") → `main` (main_write_forbidden) → `_require_open` (branch_closed) → `_require_edit` (not_draft_owner / not_owner_or_member; groups_unavailable). A checkpoint then withdraws the staged edits of anyone who may no longer write the draft. A draft write route needs `_MANAGE`, which reads every draft, so there is no read step; on the graph router, `get_context_engine` answers 404 for a `branchId` the caller cannot read before any write.
- *apply_ops* (`/graph/changes`, graph-router writes): enablement unfinished (409 integrity) → `main` or main's id on a draft route (main_write_forbidden) → for a draft, `gvlifecycle` shared, for main, `_lock_graph` → `_assert_writable` → the branch lock (a draft) → a retry with a known `Idempotency-Key` answers with its first commit here, before the refusals that follow → graph_not_writable → `_require_open` → `_require_edit` → OCC / ontology.
- *Import job creation*: the literal `main` (main_write_forbidden) → `gvlifecycle` shared → `gvmove` shared and the graph still in the workspace (404) → `_assert_writable` → with no `branchId`, the draft is opened in this transaction → branch lock → main by id (main_write_forbidden) → `_require_open` → `_require_edit` → another import pending or running on the draft (job_active).
- *Publish job creation*: `gvlifecycle` shared → `gvmove` shared and workspace → `_assert_writable` → branch lock → main (main_write_forbidden) → `_require_open` → `_require_publish`, except for a review's merge → no import on the draft (job_active) → for a merge, the request still live (404) and `_require_approvals` (approval_required) → the draft becomes `publishing`. *Export job creation* takes only `gvmove` shared and the workspace check.
- *Publish*: staged edits folded by a checkpoint (its own draft-write gate) → `_lock_graph` → `_assert_writable` → branch lock → `_require_open` → no import (job_active) → edits staged since the fold re-run the attempt (no pending_changes refusal) → `_require_publish` (a private draft's owner; a shared draft's owner or maintainer) → not_up_to_date `{branchId, behindBy}` → merge_conflict → ontology → squash.
- *Merge of a review* (`merge_mr`): fold → `_lock_graph` → the request merged or closed (404); its row is read without a lock → `_assert_writable` → branch lock → `_require_open` → no import (job_active) → staged re-run → `_require_approvals` (approval_required `{pending, stale}`) → not_up_to_date → merge_conflict → squash. The merger's right to the draft is not checked: `_MANAGE` and `_PUBLISH` on the route, and taking part in the request, are enough.
- *Freeze / unfreeze* (`set_frozen`): `gvlifecycle` exclusive → `_lock_graph` → `graphs` FOR UPDATE → unknown or trashed (404) → a state this code does not know (graph_not_writable) → freeze only: enablement unfinished (409 integrity) → already in that state (200, unchanged) → CAS on `lifecycle_rev` (version_conflict).
- *Trash and restore of a data source's graphs*: `gvlifecycle` exclusive per graph, in id order → `graphs` FOR UPDATE. *Queueing a purge*: its job row FOR UPDATE → `gvlifecycle` exclusive → `graphs` FOR UPDATE → direct forks FOR KEY SHARE. Neither takes `_lock_graph`. *Fork delete and restore* take no lifecycle key: delete locks the fork's row FOR UPDATE; restore takes the parent's `_lock_graph`, the parent row FOR KEY SHARE, then the fork's row FOR UPDATE.

### 8. Lock order (global)
1. jobs row (claim)
2. `gvproj:<gid>` session lock (projector, swap, evict)
3. `gvcompact:<gid>`: exclusive for compaction; shared for seq pinners (restore, revert, export, fork, history_export, purge)
4. `gvlifecycle:<gid>` (`_lock_lifecycle`): exclusive for transitions (freeze, trash, restore, purge queued); shared for draft writers and for creating an import or publish job
5. `pg_advisory_xact_lock(graph)` (`_lock_graph`): main writers, publish, merge, ingest, policy, transitions; then `gvmove:<gid>` (`_lock_move`): exclusive for a data-source move, shared for creating an import, export or publish job (which takes no `_lock_graph`)
6. `graphs` row: FOR UPDATE for transitions and policy; FOR KEY SHARE for draft writers and reviews; plain UPDATE for main commits
7. `branches`: FOR UPDATE for writers; FOR SHARE for reviews
8. `merge_requests`
9. `projection_state`
10. `ingest_sources`
11. `ingest_offsets`

Writers never take gvproj, and the projector never takes `_lock_graph`. Main writers never take gvlifecycle. Freeze and unfreeze take `_lock_graph` after it, so they queue behind a main writer there; trash, restore and queueing a purge do not take `_lock_graph` but lock the `graphs` row FOR UPDATE, which waits for the FOR KEY SHARE a main writer's `_assert_writable` holds. Draft writers take it because row locks alone do not queue fairly: a new FOR KEY SHARE goes past a waiting FOR UPDATE, so overlapping draft saves could hold a transition off for ever. The advisory lock's queue is fair, so a save that asks after a transition waits for it.

**Shipped so far.** Items 3, 10 and 11 do not exist yet, and item 2 is taken by the projector, evict and the retire loop only. Where the code differs from the list above:
- Item 5, `_lock_graph`: main writers (`apply_ops` on main, revert, restore, sync, bulk ingest), publish, merge of a review or fork PR, freeze and unfreeze, forking (on the parent), fork restore (on the parent), projection rebuild and the admin projection move, and a data-source move. Of the transitions only freeze and unfreeze take it: trash, restore and queueing a purge take `gvlifecycle` and then the `graphs` row FOR UPDATE, which waits for the FOR KEY SHARE that a main writer's `_assert_writable` holds. A data-source move takes `_lock_graph` then `gvmove` exclusive for its graph and then each fork, parent before child.
- Item 6, `graphs` row: FOR UPDATE for freeze, unfreeze, trash, restore and queueing a purge, and for a fork's own row on its delete and restore; FOR KEY SHARE for every content writer, draft or main (`_assert_writable`), and for a parent being forked or having a fork restored. Reviews take no `graphs` lock.
- Item 7, `branches`: FOR NO KEY UPDATE (`_lock_branch`) for every draft writer and for job creation, so inserting a member row does not wait on it. Reviews take no branch lock.
- Item 8, `merge_requests`: approve and the reviewer or title edit (`update_pr`) take the request's row FOR UPDATE; a merge reads it without a lock.

### 9. Lifecycle × drafts/PRs × ingest

| state | human main/draft writes; create/reopen draft; merge | ingest sources | TTL sweep | compaction |
|---|---|---|---|---|
| converting / ready | 409 graph_not_writable | activation refused | skip | skip |
| live | allowed once writes_open_at ≤ now (cutover_settling before) | activatable if `owns_falkor_graph` | yes | yes |
| live_legacy | allowed | projection_not_adopted; projector refuses ingest commits into a non-owned key | yes | yes |
| frozen | refused | auto-paused (`lifecycle:frozen`); auto-resumed on unfreeze | skip | yes |
| detaching | refused; with force, PRs closed (graph_detached) and drafts abandoned | paused, then retired at detached | skip | skip |
| trashed | refused; drafts and PRs kept | auto-paused; auto-resumed on restore | skip | skip |
| purging | refused | rows deleted; router treats them as ignored | n/a | n/a |
| live → ready (rollback to source) | refused | auto-paused | skip | n/a |

Every transition into a writable state enqueues `ingest_redrive` for held rejects with reason graph_not_writable.

### 10. Compaction (D3)
**Eligible commits:** main, `kind='ingest'`, `actor_kind='service'`, older than N days (minimum 7).

**Protected seqs** (INGEST §10 plus `graphs.cutover_seq`):
- every non-ingest main commit;
- every branch base (all statuses);
- MR bases;
- fork bases;
- pull `from_seq`/`to_seq`;
- `projected_commit_seq`;
- base/as_of of non-terminal jobs.

**Skips** graphs with pending or running lifecycle, bootstrap, preflight or purge jobs.

**Never compacted:** `sync`, `import`, `genesis`, and every human kind.

**Readers inside a compacted range** get 410.

### 11. Audit sinks (one per fact)
- **access_events:** draft membership and visibility, abandon/reopen/ttl, PR and review lifecycle, bypass, policy, main revert/restore/write-through/sync, sampled denials, migration backfill.
- **lifecycle_events:** every lifecycle transition and op, including convert, cutover, rollback, freeze, adopt, relocate, rebuild, detach, release, trash/restore/purge, history export. Relayed to the management outbox.
- **ingest_source_revisions:** all source config and state.
- **commits:** content changes, including issue resolutions via `change_reason='issue:<iid>'`.

Purge keeps all three audit tables plus its own job row.

### 12. Capability envelope
Every resource carries `access:{can:{<action>:bool}, reasons:{<action>:code}, required:{<action>:permission}}`. That covers graph, branch, PR, lifecycle snapshot (which replaces `allowedActions`) and ingest source.

It is produced by `access.explain`, which composes `lifecycle_state.allowed_actions` with `access.decide`.

The frontend copy for every code lives in `features/versioning/model/accessCopy.ts`. `usePermission` may only hide tabs.

### 13. Identity
**Nodes**
- Order of precedence: `urn`, else `identity_property`, else synthetic.
- A synthetic node has urn `gv:src:<ID>` and entity_id `src:<ID>`.

**Edges.** Every machine writer resolves an edge by live-head triple through `_heads_by_edge_triple` under the lock, BEFORE minting:
- exactly one live head → reuse its id;
- more than one → `ambiguous_identity`;
- none → mint.

**Mint functions** in `versioning/identity.py`:
- `mint_import_edge_id` → `<s>|<T>|<t>[#blake2b12]` (conversion, adopt);
- `mint_sync_edge_id` → `sync:e:<s>-><t>:<T>` (sync, ingest).

### 14. Flags and config
- **Feature flags:** `versioningEnabled`, `versioningLifecycleV2`, `ingestApplyEnabled`.
- **Access enforcement:** `GRAPHVER_ACCESS_ENFORCE` ∈ {shadow, enforce}; legacy actions only.
- **When the applier pauses:** if `ingestApplyEnabled` is off OR `versioningEnabled` is off.
- **Budgets:** the default budget is `GRAPHVER_DEFAULT_GRAPH_BUDGET_BYTES`. Converted graphs get `max(default, 2 × preflight.pgBytes)` at T1. Fleet headroom is checked against `GRAPHVER_FLEET_BUDGET_BYTES`.
- **Read routing:** `READ_MAX_LAG_COMMITS=500` and `READ_MAX_LAG_SECS=15` apply to service-only lag. `ROUTE_TTL_SECS=2`. `ROUTE_SETTLE_SECS=10`.
- **Write-gate allowlist:** `/projection/rebuild`, `/projection/reconcile`, `/exports`, `:cancel`, `/lifecycle/rollback`, `/lifecycle/freeze`, `/lifecycle/detach`, `/lifecycle/release-source`, `/lifecycle/history-exports`, and `/ingest/sources/{sid}/pause` (regex).

### 15. Job runners and idempotency keys
**Runners**

| Runner | Claims job types |
|---|---|
| transfer | ingest (file import), export, publish |
| lifecycle | lifecycle, preflight, bootstrap |
| purge | purge |
| compaction (also hosts storage_guard and ingest_retention loops) | compaction |
| ingest-worker `jobs` role | ingest_dryrun, ingest_replay, ingest_redrive |

**Idempotency keys** (`ix_jobs_idem_active` is unique across ALL statuses, so every key must be unique per run):
- lifecycle: `lc:<op>:<gid>:<lifecycle_rev>`
- preflight: `pf:<ds_id>:<hour>`
- purge: `purge:<gid>` (revived, never duplicated)
- replay: `replay:<sid>:<state_epoch>:<uuid>`. One active replay per source is enforced under `ingest_sources FOR UPDATE`.
- redrive: `redrive:<sid>:<uuid>`
- dry-run: `dryrun:<sid>:<policy_version>:<hour>`
- compaction: `compact:<gid>:<day>`

### 16. Data-source hub UI
`DataSourceVersioningTab` becomes the single lifecycle hub, with these sub-tabs:
1. **Overview.** StateBadge, route chip, ProjectionHealthCard summary, SourceGraphCard summary.
2. **Conversion.** Pre-live only: ConversionWizard, ConversionProgress, CutoverPanel.
3. **Data health.** ProjectionHealthCard, Storage card, RejectsTable.
4. **Ingest.** IngestPanel, SourceWizard, IssuesInbox. This is the only inbox; drift conflicts arrive here through the falkordb_snapshot binding.
5. **Drift & sync.** SourceGraphCard, drift scan results, 'Keep in sync with original graph' (creates the binding through SourceWizard steps 3-5), release checklist.
6. **Review & protection.** ProtectionSettingsPanel (two-option up-to-date mode, guardrails, self-approved sources list).
7. **History.** A `Segmented` with Changes (commit list with the People/Automation/All filter and compacted rows) | Access log (access_events) | Lifecycle (lifecycle_events) | Source changes (ingest_source_revisions).
8. **Backups.** Admin only.
9. **Danger zone.** Freeze, Detach, Release, Delete.

**Canvas.** One error handler, `useActiveBranchGuard` plus `CanvasVersioningBar`, covers branch_closed, graph_not_writable, cutover_settling (auto-retry), review_required and main_write_forbidden.

**Building blocks.** Shared components come only from `frontend/src/components/ui`, plus `SubjectPicker` (extracted by ACCESS), `ReviewerPicker`, `ConflictResolver` (with `sideLabels`) and `DangerConfirmDialog`.

### 17. Cross-spec rollout order
1. ACCESS R0: permission seed and wildcard fix, plus a forced claims refresh. Chain migrations 1-5 and 9.
2. ACCESS R1: data-safety fences.
3. CONVERSION L0/L1. Migrations 4, 6, 7, 11 are already in the chain.
4. CONVERSION L2, then INGEST S0. S0 includes the ontology widening and plan 0.4/1.3/1.6/1.7.
5. CONVERSION L3. Requires ACCESS R0.
6. INGEST S1. Migrations 2, 8, 10. Includes the falkordb_snapshot binding and drift sync.
7. INGEST S2. Activation requires CONVERSION live plus an owned key.
8. ACCESS R2 shadow, then R3 enforce.
9. CONVERSION L4 adoption.
10. INGEST S4 compaction (report mode first).
11. ACCESS R4 per-graph protection, ingest graphs first.
12. Go-live gate (plan Phase 5).
