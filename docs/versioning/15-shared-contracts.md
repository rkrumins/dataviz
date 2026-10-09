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

### 5. Migration chain (linear; down_revision = the previous entry; the first entry follows 20260930_1000_outbox_type_time)
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
**403**
- 403 `{type:'access_denied', code}` with code ∈ {not_owner_or_member, needs_publish_permission, needs_admin, self_review, contributor_cannot_approve, not_eligible_reviewer, bypass_not_allowed, service_principal_forbidden, self_approval_forbidden}, plus `required`.
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
4. PR live, `_require_open`, graph match.
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
2. `_lock_graph`.
3. `graphs FOR UPDATE`.
4. CAS on `lifecycle_rev`.
5. Same-transaction side effects: ingest_sources pause/resume/retire, PR/draft closure on detach, lifecycle_events.

### 8. Lock order (global)
1. jobs row (claim)
2. `gvproj:<gid>` session lock (projector, swap, evict)
3. `gvcompact:<gid>`: exclusive for compaction; shared for seq pinners (restore, revert, export, fork, history_export, purge)
4. `pg_advisory_xact_lock(graph)` (`_lock_graph`): main writers, publish, merge, ingest, policy, transitions
5. `graphs` row: FOR UPDATE for transitions and policy; FOR KEY SHARE for draft writers and reviews; plain UPDATE for main commits
6. `branches`: FOR UPDATE for writers; FOR SHARE for reviews
7. `merge_requests`
8. `projection_state`
9. `ingest_sources`
10. `ingest_offsets`

Writers never take gvproj, and the projector never takes `_lock_graph`.

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
