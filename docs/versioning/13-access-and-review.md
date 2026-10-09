# ACCESS final spec: draft access model and review gate (protected main)

This spec adopts the shared contracts §1–§17 as written. It applies these integration issues: X-02, X-03, X-04, X-05, X-06, X-08, X-10, X-12, X-13, X-14, X-15, X-17, X-18, X-20, X-21, X-22, X-23, X-25, X-26, X-27 and X-29.

I re-checked these code claims for this revision:
- `_SEED_LEAVES['workspace:datasource']` = {manage, read} at permission_service.py:430-433. The dict starts at L417. `_WORKSPACE_CATEGORY_LEAVES` is at L463. `_collapse_wildcards` is at L395, `has_permission` at L516 and `simulate_for_user` at L618.
- In rbac_seed.py, `workspace_data_engineer` has datasource read/manage (L280-281), and org_admin/super_admin are at L236-237 and L267-268.
- In versioning.py, `viewer_ctx` is at L100, `pr_in_workspace` at L421, `_domain_errors` at L458, the `ConcurrencyError` mapping at L480, and `POST /graphs/{graph_id}/sync` at L2530.
- In service.py: `AccessDenied` L187, `ApprovalRequired` L191, `Viewer` L305, `stage_changes` L583, `_checkpoint_once` L705, `_flush_pending_changes` L850 (called at L907 in publish and L2097 in merge_mr, before the lock), `publish` L882, `_rebase_draft_once` L1095 (stats.rebased at L1165), `abandon_draft` L1264, `sweep_idle_drafts` L1311.
  - The sweep has no lifecycle, live-PR or working-changes exclusion (L1322-1327).
  - `merge_mr` L2072 runs `_compute_merge_bounded` BEFORE the approval check (L2121-2127).
  - Other lines: `_live_prs_for_branch` L1913, `open_draft_mr` L1947, `list_branches` L4195, `_branch_role` L4395, `_require_open` L4413 (raises ValueError), `_require_edit` L4419-4424 (inverted `if not branch.is_shared: return`), `_require_manage` L4426, `_is_pr_participant_for_branch` L4432, `_branch_readable` L4444 (`viewer.can_manage` short-circuit at L4451), `sync_ingest` L4982, `_lock_graph` L5370, `_apply_ops_once` L5420, `_branch_contributors` L5780.
- In models.py: `is_shared` L137, `ck_bm_role` L183, `approval_status` L208 (no CHECK), `merged_via` L216 (no CHECK; values review | direct_publish), `jobs.summary` JSONB L332, `ck_jobs_type` L356, `ck_commits_kind` L433.
- purge_worker.py: `_BULK` L65-72, and `_phase_meta` L365-383 deletes merge_requests and branches.
- user_repo: `get_groups_for_user` at db/repositories/user_repo.py:1121. auth/dependencies: `_audit_access_denied` at L564.
- graph.py `apply_graph_changes` L3720 uses `get_optional_user`.
- Frontend:
  - `components/ui` has Badge, Button, DangerConfirmDialog, EmptyState, HoverTip, ProgressBar, Segmented, Skeleton, Tabs, TimeStamp and UserAvatar.
  - ShareViewDialog `AddGrantPicker` is at L771.
  - `useActiveBranchGuard` does not exist yet.

---

## Summary

### One decision point
Every versioning action is decided by:
- the pure module `backend/app/services/versioning/access.py`, which holds `Principal` (§1), the `Action` registry, `decide` and `explain`;
- `GraphVersioningService._authorize(...)`.

Every service entry point takes a required keyword-only `principal`. Every action has three registry attributes:
- **`perm`:** R, M, P or A, plus a relation.
- **`legacy`:** whether the action can be shadowed. Only actions that existed before R0 can be.
- **`audit_sink`:** one of access, lifecycle, ingest, commit or none (X-13).

### Draft visibility
Draft visibility is an explicit column, `branches.visibility` ∈ {private, members, workspace}. `is_shared` is derived from it.
- A private draft is readable and writable only by its owner and invited members (users or groups) (D4).
- PR participants and publishers can read a draft that has a live PR.
- Admins can read and manage membership, but have no content write.

### Protected main
Protected main is set per graph with the shared §3 columns: `require_review`, `required_approvals`, `bypass_policy` and `review_policy_version`.
- **Approvals.** Approvals are rows in `pr_reviews`, each bound to the reviewed head commit.
- **Staleness.** An approval stays valid only through content-neutral draft commits, meaning pulls whose `stats.rebased` is all zero.
  - The D2 merge-time auto-rebase writes no draft commit, so it never invalidates an approval.
- **Up-to-date gate.** The D2 "not up to date" gate fires only on human, system or structural overlap. Service-only overlap joins the bounded merge (X-10).

### Publish permission
A new permission, `workspace:datasource:publish`, gates every human action that advances main or changes what readers see. It is fenced from the wildcard collapse by the R0 `_SEED_LEAVES` fix. Without that fix the permission is a no-op: every editor's token collapses to `workspace:datasource:*`.

### Ingest and lifecycle principals
- Ingest runs as `svc:ingest:<sid>`, which may only call `INGEST_APPLY` through `apply_source_delta`.
- Lifecycle and sync run as `system:<component>`.
- There are no system-owned drafts (X-06). The bare `system` actor is never written again.

### Audit
Audit has one sink per fact (§11). `graphver.access_events` is append-only and records branch, PR, review, policy, bypass and main write-through, revert, restore and sync events, in the same transaction as the change.

### Gate and lock order
- **Gate order.** Every write, merge, ingest and transition path follows the shared §7 gate order, where the first failure wins.
- **Lock order.** All paths follow shared §8. Draft writers take `graphs FOR KEY SHARE`, so lifecycle transitions are linearized with draft saves without contending with main commits (X-15).

### Rollout
1. R0: seed and schema.
2. R1: data-safety fences and the collaborator backfill.
3. R2: shadow mode, legacy actions only.
4. R3: enforce.
5. R4: per-graph protection, ingest graphs first.

---

## Goals / non-goals

### Goals
- **G1 (D4).** Private drafts are readable and writable only by the owner and invited members.
  - PR participants have read-only access.
  - Publishers can read drafts that have a live PR.
  - Admins can read and manage membership (audited), but cannot write content unless they add themselves as a member (audited).
- **G2.** No path commits into a merged, publishing, abandoned, foreign-graph or main branch by mistake.
  - `/graph/changes` never writes main.
  - No human advances protected main except by a PR merge, an audited bypass, or the policy-bounded "take source" issue resolution (X-05).
- **G3.** Per-graph policy: `require_review`, `required_approvals` (1–10), `bypass_policy`, `require_up_to_date` ∈ {on_overlap, always}, and `ingest_guardrails` (the semantics are INGEST's).
- **G4.** Head-bound approvals. An auto-rebase never invalidates them. Any content change makes them stale.
- **G5.** `workspace:datasource:publish` (P) is separate from manage (M), following the shared §2 matrix.
- **G6.** One decision function feeds the service, the routes and the `access` capability envelope (§12). A route or method that bypasses it fails CI.
- **G7.** Durable, transactional audit in exactly one sink per fact. Denials are sampled.
- **G8.** Draft lifecycle safety:
  - abandon closes the live PR;
  - reopen exists;
  - the TTL sweep skips drafts in review, drafts with staged work, and graphs whose lifecycle state is not live (§9), and warns 7 days ahead.
- **G9.** Migration without lockouts (collaborator backfill) and without silently trusting legacy approvals that are not bound to a head.

### Non-goals (v1)
- Per-entity or per-field read ACLs.
- Code-owner review rules.
- Group reviewers. Reviewers are users; groups are supported for draft membership only.
- Entity-anchored comment threads (plan 4.3).
- PR reopen. A closed PR is terminal; the author opens a new one.
- Enforcing `workspace_data_sources.access_level`.
- Changing view RBAC semantics.
- An audit relay into `auth_audit_log`.
- Re-implementing the D2 overlap gate (plan 1.3 / INGEST §8), the bounded merge, lifecycle states (CONVERSION) or ingest policy (INGEST). ACCESS only places these in the gate order and authorizes them.

---

## Concepts, roles & state machines

### 1. Principal (shared §1, in `versioning/access.py`)

```python
@dataclass(frozen=True)
class Principal:
    actor: str                         # '<user_id>' | 'svc:ingest:<sid>' | 'system:<component>'
    kind: Literal['human','service','system']
    can_read: bool = False             # R  workspace:datasource:read
    can_manage: bool = False           # M  workspace:datasource:manage
    can_publish: bool = False          # P  workspace:datasource:publish (P effective = can_publish and can_manage)
    is_admin: bool = False             # A  workspace:admin (org_admin/super_admin via has_permission shortcuts)
    view_capability: str | None = None # request.state.view_capability: reads main only
    source_id: str | None = None
    groups_loader: Callable[[], Awaitable[tuple[str, ...]]] | None = None  # lazy, memoised
    def snapshot(self) -> dict ...     # {actor, kind, can_read, can_manage, can_publish, is_admin, workspace_id}
    @classmethod from_snapshot / service(sid) / system(component)
```

**`system(component)`** accepts only these components: ttl, migration, lifecycle, sync, compaction, purge, storage_guard. Any other value raises.

**`principal_ctx`** replaces `viewer_ctx` (versioning.py:100). It calls `has_permission(claims, …, workspace_id)` for R, M, P and A, with no DB hit. `Viewer` (service.py:305) stays as a deprecated alias.

**Groups** come from `user_repo.get_groups_for_user` (user_repo.py:1121). They are loaded only when a decision meets a `branch_members` row of type group. If the lookup fails, the call raises `GroupsUnavailable`, which maps to 503 groups_unavailable. It is never treated as "no groups".

### 2. Roles to capabilities (R0)

| Role | R | M | P | A |
|---|---|---|---|---|
| workspace_viewer | Y | – | – | – |
| workspace_member | Y | Y | – | – |
| **workspace_publisher (new)** | Y | Y | Y | – |
| workspace_data_engineer (granted P) | Y | Y | Y | – |
| workspace_admin, org_admin, super_admin | Y | Y | Y (via category leaves) | Y |

### 3. Branch relations and visibility

**Relations.**
- **O:** the owner.
- **bM / bE / bV:** a `branch_members` role, matched directly or through a group.
- **PRp:** the author or a requested reviewer of a PR from this branch (`_is_pr_participant_for_branch`, service.py:4432).
- **LP:** the branch has a live PR.

| visibility | READ | WRITE (content) | MANAGE (rename, visibility, members) | ABANDON / REOPEN |
|---|---|---|---|---|
| private | O, PRp, P∧LP, A | O | O | O, A |
| members | O, any member, PRp, P∧LP, A | O, bE, bM | O, bM; A may change members only | O, bM, A |
| workspace | any R holder | O, bE, bM, any M holder | O, bM; A may change members only | O, bM, A |

**Caps and derived values.**
- READ requires `can_read`. WRITE requires `can_manage`, so a bE who lacks M acts as a viewer.
- `view_capability` principals and service principals never read drafts.
- `is_shared` is maintained as `visibility <> 'private'`. It still drives the multi-writer fold in `_checkpoint_once`.
- Adding the first member to a private draft sets `members`. Setting `private` deletes every member row in the same transaction.

**Adopt-repair drafts (X-06).** These drafts are private, owned by the requesting human, and read by reviewers through PRp. There are no ownerless drafts.

### 4. Action registry
This is `access.POLICY` and the CSV fixture. Key: L = legacy (shadowable); sink = audit sink; "+gate" = the review gate or a bypass applies when the graph is protected.

| Action | Permission and relation | L | sink | Under require_review |
|---|---|---|---|---|
| READ_MAIN | R or view_capability | Y | none | – |
| READ_DRAFT | §3 READ; a denial is returned as 404 | Y | none | – |
| CREATE_DRAFT | M; `_assert_writable` | Y | none | – |
| DRAFT_WRITE (stage, `/graph/changes`, checkpoint, rebase/pull, resolve, claim, import into a draft, view layout/library overlay with branchId) | M + §3 WRITE; open; same graph; kind draft or fork_draft | Y | commit | – |
| DRAFT_MANAGE | M + O/bM (A: members only) | Y | access | – |
| DRAFT_ABANDON | O/bM/A, or system:ttl | Y | access | – |
| DRAFT_REOPEN | O/bM/A; `_assert_writable` | N | access | – |
| PR_OPEN | DRAFT_WRITE; reviewers hold M and are neither the author nor the owner | Y | access | – |
| PR_EDIT / PR_CLOSE | author, O, bM, P or A; PR live | Y | access | – |
| PR_REVIEW (approve, request_changes) | M; PR readable; not the author or owner; not a content contributor when protected; `expectedHeadCommitId` equals the head | Y | access | – |
| PR_COMMENT | PR readable | N | access | – |
| PR_DISMISS_REVIEW | P or A; reason of at least 10 characters | N | access | – |
| PR_MERGE | P | Y | access | +gate |
| DIRECT_PUBLISH | P + O/bM | Y | access | refused (review_required / review_pending) unless bypass |
| BYPASS | bypass_policy: publishers → P or A; admins → A; nobody → ✗ | N | access | – |
| MAIN_REVERT / MAIN_RESTORE (target main) | P | Y | access | +bypass |
| MAIN_REVERT / MAIN_RESTORE (target draft) | M (the result is the caller's own draft) | Y | access | – |
| MAIN_WRITE_THROUGH (legacy routes with no branchId; issue choice 'value' → main) | P | Y | access | 409 review_required {canStageToDraft:true} unless bypass |
| `/graph/changes` with main or 'main' | nobody | – | – | always 409 main_write_forbidden |
| MAIN_SYNC (sync, resync) | P | Y | access | +bypass |
| MAIN_BULK (genesis only) | P | Y | commit | – |
| SYSTEM_MAIN_COMMIT (system:lifecycle import/repair; system:sync on behalf of an authorized human) | system principal | N | commit | lifecycle: refused (the repair goes to a draft plus a PR, X-06) |
| BOOTSTRAP (legacy `/graph/bootstrap*` while lifecycleV2 is off) | P | Y | lifecycle | – |
| REBUILD / RECONCILE | P | Y | lifecycle | – |
| FORK | M; quota per plan 3.1; a fork PR merges under the TARGET graph's policy | Y | none | – |
| LIFECYCLE_PREFLIGHT, DRIFT_SCAN, lifecycle cancel (pre-cutover or pre-swap) | M | N | lifecycle | – |
| LIFECYCLE_CONVERT, _CUTOVER, _ROLLBACK, _ADOPT, _RELOCATE, _FREEZE, drift-sync run, DS soft delete/restore | P (DS delete/restore: A when protected) | N | lifecycle | – |
| RELEASE_SOURCE, LIFECYCLE_DETACH, permanent delete, LIFECYCLE_LOSS_ACK, mass-delete override, drift dismiss, HISTORY_EXPORT, HISTORY_RESTORE | A | N | lifecycle | – |
| INGEST_CREATE (create, edit, propose, dry-run), INGEST_PAUSE, INGEST_ISSUE_DISMISS | M | N | ingest / commit | – |
| INGEST_APPROVE | P | N | ingest | four-eyes: approver ≠ proposed_by, else 403 self_approval_forbidden (X-25) |
| INGEST_ACTIVATE, INGEST_RESUME, INGEST_REPLAY, confirm-deletes, retire, INGEST_REJECT_ADMIN (redrive, discard) | P | N | ingest | – |
| INGEST_ISSUE_RESOLVE_MAIN (choice 'source' → main) | P | N | commit | allowed without a PR (policy-bounded, X-05) |
| INGEST_APPLY | `Principal.service(sid)` only | N | commit | ignores require_review |
| STORAGE_EDIT, POLICY_EDIT | A | N | access (policy) / ingest (budget per INGEST) | – |
| POLICY_READ | R | Y | none | – |
| AUDIT_READ | P or A | N | none | – |

**Rules that cover the whole table.**
- A service principal calling anything other than INGEST_APPLY gets `AccessDenied('service_principal_forbidden')`. This code is a safety code and is never shadowed.
- `system:ttl` may only abandon. System principals never own drafts or author PRs.

**INGEST_APPLY** is allowed iff all of these hold (X-08):
- `source.graph_id = graph`;
- `state IN ('active','throttled')`;
- `decoder <> 'snapshot'`;
- the envelope's policy_version equals `source.policy_version`;
- `_assert_writable` passes.

State `blocked` returns HOLD, not a denial.

### 5. Lifecycle × drafts/PRs (shared §9; ACCESS enforcement)

| state | create/reopen draft; draft write; PR open, edit or review; merge/publish | close PR, abandon draft | reads | TTL sweep |
|---|---|---|---|---|
| live | allowed once `writes_open_at ≤ now`; before that, 409 graph_not_writable reason=cutover_settling with Retry-After | yes | yes | yes |
| live_legacy | allowed | yes | yes | yes |
| converting, ready, frozen, trashed | 409 graph_not_writable | yes (safety exits) | yes | skip |
| detaching | refused; with force, live PRs are closed (graph_detached) and open drafts abandoned (graph_detached) in the transition transaction | n/a | yes | skip |
| detached, purging | refused | refused | 404 once purged | skip |

- Trash leaves drafts and PRs untouched, and restore makes them usable again.
- A publish or merge job refused with GraphNotWritable resets the branch to `open` (X-22).

### 6. Draft status machine (`branches.status`, CHECK unchanged)

| From | Event | To | Guard and effect |
|---|---|---|---|
| (none) | open_draft | open | CREATE_DRAFT |
| open | write, pull, checkpoint | open | §7 draft-write gate; a content commit triggers `_on_draft_content_changed` |
| open | queue a large publish or merge | publishing | full gate at enqueue; writes now get 409 branch_closed |
| publishing | job succeeds | merged | gate re-run from `summary.principal` under the lock |
| publishing | job refused or fails (including GraphNotWritable), or is stale beyond JOB_TIMEOUT | open | worker reset; access_events row with decision denied |
| open | synchronous publish or merge | merged | §7 publish gate |
| open | abandon | abandoned | live PR closed (close_reason draft_abandoned); `abandoned_by` and `abandon_reason` ∈ {user, ttl, graph_deleted, graph_detached, migration} |
| abandoned | reopen | open | DRAFT_REOPEN; writable graph; `updated_at` bumped; the PR is not reopened |
| merged | – | – | terminal |

`_require_open` raises `BranchNotOpen(status)`, which maps to 409 branch_closed.

### 7. PR review model

**Columns.**
- `merge_requests.status` is unchanged; a closed PR is terminal.
- `approval_status` ∈ {not_required, pending, approved, changes_requested}.
- `merged_via` ∈ {review, direct_publish, bypass}.

**Evaluation.** `review_gate.evaluate(policy, pr, head, reviews, contributors, neutral_since, standing=None)` is pure.
- **Valid approval.** It is the reviewer's latest non-dismissed `approved` row, and all of these hold:
  - the reviewer is not the author or the owner;
  - when the graph is protected, the reviewer is not a content contributor;
  - `neutral_since(review.head_commit_seq)` is true;
  - at merge time, the reviewer's standing still includes M.
- **Neutral since a review.** Run `SELECT kind, stats FROM commits WHERE graph_id=:g AND branch_id=:b AND commit_seq > :seq ORDER BY commit_seq LIMIT 1001`. The result is neutral iff every row is a `pull` with `stats.rebased` = {0,0,0}. More than 1000 rows counts as not neutral.
- **Blocking.** A reviewer whose latest non-dismissed review is `changes_requested` blocks the merge.
- **Requested.** Every requested reviewer needs a valid approval.
- **Quorum.** The number of valid approvals must be at least `required_approvals` when protected.
- **approval_status.** `approved` iff requested ∧ quorum; `pending` otherwise.

**Transitions.**

| Event | Locks | Effect |
|---|---|---|
| open PR | graphs KEY SHARE → branch FOR UPDATE | evaluate; event pr.opened |
| submit_review | graphs KEY SHARE → branch FOR SHARE → PR FOR UPDATE | head check (409 head_moved); insert pr_reviews row; re-evaluate; mirror `approved_by`; bump `pr.updated_at` and `branch.updated_at` |
| draft content commit | already holds the branch | `_on_draft_content_changed`: approved reviews dismissed with `stale`; re-evaluate; approved → mergeable |
| neutral pull | branch | nothing (`reviewKept=true`) |
| dismiss_review / update reviewers | PR FOR UPDATE | removed reviewers are dismissed with `reviewer_removed`; re-evaluate |
| close / abandon | branch → PR | closed; close_reason ∈ {user, draft_abandoned, migration, graph_detached} |
| merge | §7 publish gate | `approved_head_commit_id`; `stats.review` |

**Bypass.**
- It needs `bypass.reason` of at least 10 characters (422 bypass_reason_required) and eligibility (403 bypass_not_allowed).
- It sets `merged_via='bypass'`, `bypassed_by` and `bypass_reason`, and writes `access_events` with decision `bypassed` and `detail.unmet`.

### 8. Gate orders (shared §7; first failure wins, X-27)

**Draft write.**
1. Request validation. `branchId='main'`, or the graph's main id (one indexed lookup), returns 409 main_write_forbidden.
2. `graphs FOR KEY SHARE`, then `_assert_writable`.
3. Branch `SELECT … WHERE id AND graph_id FOR UPDATE` → 404.
4. READ_DRAFT → 404.
5. `_require_open` → branch_closed.
6. `_authorize(DRAFT_WRITE)` → 403.
7. OCC and ontology.
8. Commit, then `_on_draft_content_changed`.

**Publish / merge.**
1. `_lock_graph`.
2. Re-read `graphs` (policy plus lifecycle) and `_assert_writable`.
3. Draft FOR UPDATE populate_existing, then PR FOR UPDATE.
4. PR live, `_require_open`, graph match.
5. `_authorize(PR_MERGE | DIRECT_PUBLISH)`.
6. pending_changes.
7. Review gate, or bypass.
8. D2 overlap gate (`require_up_to_date`; service-only overlap joins the merge) → not_up_to_date {overlapIds≤50, reason}.
9. `_compute_merge_bounded` → merge_conflict.
10. Ontology.
11. Squash with `stats.review` and `auto_rebased_*`.
12. access_events.

Note that today the approval check runs after `_compute_merge_bounded` (service.py:2121-2127). This order is reversed so that cheap authorization denials come before the merge computation.

**Review submission.** Steps 2, 3 (branch FOR SHARE) and 4 of the draft-write gate, then PR FOR UPDATE, PR live, `_authorize`, then the head check.

### 9. Lock order (shared §8)

Locks are always taken in this order:
1. jobs
2. `gvproj`
3. `gvcompact`
4. `_lock_graph`
5. `graphs`
6. `branches`
7. `merge_requests`
8. `projection_state`
9. `ingest_sources`
10. `ingest_offsets`

How each path uses them:
- **Draft writers:** `graphs FOR KEY SHARE` → branch FOR UPDATE.
- **Reviews:** KEY SHARE → branch FOR SHARE → PR.
- **Policy PATCH and lifecycle transitions:** `_lock_graph` → `graphs FOR UPDATE`. This conflicts with KEY SHARE, so these wait for in-flight draft writes, and later writers see the new state.
- **Main commits:** a plain UPDATE (NO KEY UPDATE), which does not contend with KEY SHARE.

### 10. Shadow mode (X-20)
`GRAPHVER_ACCESS_ENFORCE` ∈ {shadow, enforce} applies only to actions with `legacy=True`.
- In shadow, a denial records `would_deny` (metric `versioning_access_would_deny_total{action,code}` plus a sampled access_events row) and the action is allowed.
- These always enforce, in both modes:
  - the SAFETY_CODES: branch_closed, main_write_forbidden, service_principal_forbidden, foreign-graph 404;
  - every non-legacy action (lifecycle, ingest, A-level, bypass, reopen, dismiss);
  - graph_not_writable.

---

## Data model & migrations

The migrations follow the shared §5 chain. ACCESS owns entries 1, 5 and 9, and supplies column semantics to entry 4. The ORM CHECKs ship in the same PR as each migration, and every CHECK is widen-only.

**M1 `20261010_1000_datasource_publish`** (management DB; modelled on `20260731_1300_view_publish.py`; `down_revision = 20260930_1000_outbox_type_time`)
- INSERT permission `workspace:datasource:publish`, category workspace, description "Advance a versioned data source's Published version".
- INSERT role `workspace_publisher`, with the workspace_member grants plus publish.
- Grant publish to workspace_publisher, workspace_data_engineer, org_admin and super_admin. workspace_member is not granted it.
- All inserts use ON CONFLICT DO NOTHING. Downgrade order: grants, then role, then permission.
- The same rows go into `rbac_seed.py` (PERMISSIONS, SYSTEM_ROLES, ROLE_GRANTS).
- The code-constant change ships in the same PR: `_SEED_LEAVES['workspace:datasource']` (permission_service.py:430) and `_WORKSPACE_CATEGORY_LEAVES` (L463) each gain publish.

**M4 `20261010_1300_gv_graphs_policy_lifecycle`** (single owner of the `graphs` columns). ACCESS columns:
- `require_review BOOLEAN NOT NULL DEFAULT false`;
- `required_approvals SMALLINT NOT NULL DEFAULT 1 CHECK (BETWEEN 1 AND 10)`;
- `bypass_policy TEXT NOT NULL DEFAULT 'admins' CHECK IN ('nobody','admins','publishers')`;
- `review_policy_version BIGINT NOT NULL DEFAULT 1` (renamed per X-29);
- `policy_updated_by TEXT`, `policy_updated_at TEXT`;
- `require_up_to_date TEXT NOT NULL DEFAULT 'on_overlap' CHECK IN ('on_overlap','always')`. If plan 1.3 already shipped `machine_only`, the CHECK keeps it (widen-only) and the service maps it to on_overlap.

These are constant defaults, so the adds are metadata-only. Mirror them in GraphORM.

**M5 `20261010_1400_gv_access_review`** (transactional)
- **`branches`.** ADD:
  - `visibility TEXT NOT NULL DEFAULT 'private' CHECK IN ('private','members','workspace')`;
  - `abandoned_by TEXT`;
  - `abandon_reason TEXT CHECK (NULL OR IN ('user','ttl','graph_deleted','graph_detached','migration'))`;
  - `ttl_warned_at TEXT`.
- **`branch_members`.** ADD `added_by TEXT`.
- **`merge_requests`.** ADD:
  - `approved_head_commit_id TEXT`, `bypassed_by TEXT`, `bypass_reason TEXT`;
  - `close_reason TEXT CHECK (NULL OR IN ('user','draft_abandoned','migration','graph_detached'))`;
  - `ck_mr_approval_status CHECK (NULL OR IN ('not_required','pending','approved','changes_requested')) NOT VALID`;
  - `ck_mr_merged_via CHECK (NULL OR IN ('review','direct_publish','bypass')) NOT VALID`.
- **`pr_reviews`** (new, plain).
  - Columns:
    - `id TEXT PK DEFAULT prefixed_id('rv')`;
    - `pr_id TEXT NOT NULL REFERENCES merge_requests(id) ON DELETE CASCADE`;
    - `graph_id TEXT NOT NULL` (the target graph);
    - `reviewer TEXT NOT NULL`;
    - `state TEXT NOT NULL CHECK IN ('approved','changes_requested','commented')`;
    - `body TEXT CHECK (NULL OR length ≤ 4000)`;
    - `head_commit_id TEXT`, `head_commit_seq BIGINT` (both NULL only for legacy rows);
    - `created_at TEXT NOT NULL`;
    - `dismissed_at`, `dismissed_by`, `dismiss_note`;
    - `dismiss_reason CHECK (NULL OR IN ('stale','manual','reviewer_removed','legacy_unbound'))`.
  - Indexes: `ix_prr_active (pr_id, reviewer, created_at DESC) WHERE dismissed_at IS NULL` and `ix_prr_reviewer (reviewer, created_at DESC)`. These are small at creation.
- **`access_events`** (new, plain, no FK to `graphs`, so it survives purge).
  - Columns:
    - `id TEXT PK DEFAULT prefixed_id('ae')`;
    - `graph_id NOT NULL`, `branch_id`, `pr_id`, `occurred_at NOT NULL`, `actor NOT NULL`;
    - `actor_kind CHECK IN ('human','service','system')`;
    - `action`;
    - `decision CHECK IN ('allowed','bypassed','denied','would_deny')`;
    - `via`, `code`, `reason`, `detail JSONB`, `request_id`.
  - The `action` CHECK covers: branch.visibility_changed, branch.member_added, branch.member_removed, branch.member_role_changed, branch.abandoned, branch.reopened, branch.ttl_warned, branch.published, pr.opened, pr.reviewers_changed, pr.reviewed, pr.review_dismissed, pr.merged, pr.closed, pr.bypassed, policy.updated, main.reverted, main.restored, main.write_through, main.synced, access.denied, migration.access_backfill. It has no graph.*, projection.* or ingest.* values (X-13).
  - Indexes: `ix_ae_graph_at (graph_id, occurred_at DESC, id)`, `ix_ae_actor_at`, and `ix_ae_pr WHERE pr_id IS NOT NULL`.
  - Trigger `fn_ae_append_only` is BEFORE UPDATE OR DELETE and always raises. There is no purge GUC.
- **Backfills.** All are batched, and each change writes `access_events(action='migration.access_backfill', actor 'system:migration', detail=before)`.
  1. `visibility = CASE WHEN is_shared THEN 'members' ELSE 'private' END`. `is_shared` is untouched.
  2. Live PRs with `approval_status='approved'` → `pending`. Each `approved_by` entry becomes a `pr_reviews(state='approved', head NULL, dismissed_at=now, dismiss_reason='legacy_unbound')` row.
  3. Live PRs with no reviewers → `not_required`.
  4. Live PRs whose source branch is abandoned → `status='closed'`, `closed_by='system:migration'`, `close_reason='migration'`.
- Then `VALIDATE CONSTRAINT ck_mr_approval_status` and `ck_mr_merged_via`.
- `create_schema_and_partitions` creates both new tables on fresh databases.
- The downgrade drops the new tables, columns and CHECKs.

**M9 `20261010_1800_gv_idx_concurrent_a`** (autocommit_block). ACCESS indexes:
- `ix_branches_graph_status_upd ON branches(graph_id, status, updated_at DESC)`;
- `ix_bm_subject ON branch_members(subject_type, subject_id)`;
- `ix_mr_reviewers_live ON merge_requests USING gin (reviewers jsonb_path_ops) WHERE status NOT IN ('merged','closed')`.

`ix_graphs_lifecycle` is CONVERSION's.

**Other chain entries ACCESS relies on.** M2 (`commits.actor_kind`, `source_id`, `source_ref`), M3 (job types) and M10 (`ix_commits_actor`, used by the contributor query and the R0 report).

**`jobs`.** No schema change. Every human-created job stores `summary.principal = Principal.snapshot()` and `summary.bypass = {reason}|null` (models.py:332).

---

## API

### Shared conventions
Every route depends on `principal_ctx`. Errors come from `versioning/errors.py`, mapped by the single `_domain_errors` (versioning.py:458), which ingest.py and versioning_lifecycle.py reuse. Subclass mappings are placed before the `ConcurrencyError` catch at L480. The codes are exactly those in shared §6.

- **403** `{type:'access_denied', code, required}` with code ∈ {not_owner_or_member, needs_publish_permission, needs_admin, self_review, contributor_cannot_approve, not_eligible_reviewer, bypass_not_allowed, service_principal_forbidden, self_approval_forbidden}.
- **404** for any draft, PR, graph or job the caller cannot read, indistinguishable from not found.
- **409** codes:
  - graph_not_writable `{state, reason, retryable}` (Retry-After only for cutover_settling);
  - branch_closed `{status, branchId}`;
  - main_write_forbidden;
  - pr_closed;
  - pull_request_exists;
  - review_required `{prId?, canStageToDraft?}`;
  - review_pending `{prId, pending}`;
  - approval_required `{missing, stale}`;
  - changes_requested `{by}`;
  - pending_changes `{count}`;
  - head_moved `{headCommitId}`;
  - not_up_to_date `{overlapIds≤50, reason}`;
  - merge_conflict;
  - version_conflict `{resource:'graph_policy', currentVersion}`.
- **410** history_compacted `{fromSeq, toSeq, checkpointCommitId}`.
- **422** ontology_violation, bypass_reason_required, ineligible_member `{subjectId, reason}`, ineligible_reviewer, client_upgrade_required.
- **503** lock_busy (Retry-After) and groups_unavailable.

**Capability envelope.** Every graph, branch and PR resource carries `access:{can, reasons, required}` (§12), produced by `access.explain`.

### Graph policy
| Method / path | Request → Response | Authz | Errors |
|---|---|---|---|
| GET `/graphs/{gid}` | adds `policy{requireReview, requiredApprovals, bypassPolicy, requireUpToDate, version (=review_policy_version), updatedBy, updatedAt}` and `access{can:{createDraft, bypass, revertMain, restoreMain, editPolicy, readAudit, …}}` | READ_MAIN | – |
| PATCH `/graphs/{gid}/policy` | `{requireReview?, requiredApprovals?, bypassPolicy?, requireUpToDate?, ingestGuardrails? (INGEST schema), expectedVersion, reason (5-500)}` → `{policy, impact:{livePrs, prsNeedingApproval, selfApprovedSources:[{id, name, approvedBy}]}}` | POLICY_EDIT (A); always enforced | 403 needs_admin; 409 version_conflict; 422 |

The PATCH runs `_lock_graph` → `graphs FOR UPDATE` → CAS on `review_policy_version` → UPDATE → `access_events policy.updated {before, after}`. `selfApprovedSources` is INGEST's query: active sources whose approved revision has `approved_by = proposed_by`.

### Branches
| Method / path | Notes | Authz |
|---|---|---|
| GET `/graphs/{gid}/branches?status=open\|abandoned\|merged\|all&visibility=&mine=&viewId=&limit=&cursor=` | Visibility is filtered in SQL before LIMIT. BranchResponse adds `visibility`, `memberCount`, `myRole`, `abandonedBy`, `abandonReason`, `ttlWarnedAt`, `archivesAt` and `access`. `isShared` stays (derived, deprecated). | R |
| GET `/graphs/{gid}/branches/{bid}` (new) | BranchResponse | READ_DRAFT (404) |
| PATCH `/graphs/{gid}/branches/{bid}` | `{name?, description?, visibility?, isShared? (alias for one release)}` | DRAFT_MANAGE; 409 branch_closed, graph_not_writable |
| GET `…/members` | `{visibility, members:[{subjectType, subjectId, name, role, effectiveRole, addedBy, createdAt}]}` | READ_DRAFT |
| POST `…/members` | `{subjectType, subjectId, role}`. Eligibility via `simulate_for_user` (permission_service.py:618): R, plus M for editor or maintainer. The owner gets 422 ineligible_member `{reason:'owner'}`. | DRAFT_MANAGE |
| DELETE `…/members/{type}/{id}` | A member may also remove themselves. | DRAFT_MANAGE |
| POST `…/abandon` | → `{branch, closedPrIds}`. Idempotent when already abandoned. A merged or publishing draft gets 409 branch_closed. | DRAFT_ABANDON |
| POST `…/reopen` (new) | → `{branch, viewsRestored:bool}`. Reopening an open draft is an idempotent 200. A merged draft gets 409 branch_closed. A non-writable graph gets 409 graph_not_writable. Purged views give `viewsRestored:false` rather than an error. | DRAFT_REOPEN |
| POST `…/changes`, `/commit`, `/rebase`, `/claim` | §8 draft-write gate. The rebase response adds `reviewKept`. | DRAFT_WRITE |
| POST `…/publish` | `{message, resolutions?, bypass?:{reason}}` → 200 `{commitId}` or 202 `{jobId}` (sets `publishing` and stores the snapshot) | DIRECT_PUBLISH plus the §8 gate |

### Merge requests (`/merge-requests/*` and `/pulls/*` for forks)
| Method / path | Notes | Authz |
|---|---|---|
| POST `…/branches/{bid}/merge-requests` | `{title?, description?, reviewers?}` → 201 `{prId, approvalStatus, requirements}`. The route injects a `reviewer_eligible` callable. | PR_OPEN |
| PATCH `/merge-requests/{id}` | `{title?, description?, reviewers?}` (reviewers is a full replace) | PR_EDIT |
| GET item and lists (`/graphs/{g}/merge-requests`, `/pulls`, `/views/{v}/pull-requests[/count]`, `/data-sources/{ds}/pull-requests`, `?reviewer=me&activeOnly=true`) | A PR is visible to its author, requested reviewers, anyone who can read the source draft, P and A. PrResponse adds `sourceHeadCommitId`, `approvalStatus`, `requirements{requireReview, requiredApprovals, validApprovals, requested[{actor, satisfied}], stale, changesRequestedBy, pendingChanges, blocking[code]}`, `approvedHeadCommitId`, `bypassedBy`, `bypassReason`, `closeReason`, `access`. | READ |
| POST `/merge-requests/{id}/reviews` (new) | `{state:'approve'\|'request_changes'\|'comment', body?, expectedHeadCommitId}` → PrResponse | PR_REVIEW / PR_COMMENT |
| GET `/merge-requests/{id}/reviews` | `[{reviewId, reviewer, state, body, headCommitId, valid, staleReason, createdAt, dismissed*}]` | PR readable |
| POST `/merge-requests/{id}/approve` (legacy, Deprecation header) | Maps to approve. A missing head binds to the current head in shadow mode; in enforce mode it returns 422 client_upgrade_required. | PR_REVIEW |
| POST `…/reviews/{rid}/dismiss` | `{reason (10-500)}` | PR_DISMISS_REVIEW |
| POST `/merge-requests/{id}/close` | `{reason?}` | PR_CLOSE |
| POST `/merge-requests/{id}/merge` | `{message, resolutions?, bypass?}` → 200 or 202. The route resolves approver standing (≤ 20 users via `simulate_for_user`); a failed lookup returns 503. | PR_MERGE plus the §8 gate |

### Main operations
- **POST `/graphs/{gid}/commits/{cid}/revert` and `/restore`.** These add `target:'main'|'draft'` and `bypass?`.
  - target main: MAIN_REVERT or MAIN_RESTORE (P). When protected, a bypass is required or the call returns 409 review_required `{canStageToDraft:true}`.
  - target draft: M. Response 201 `{branchId, commitId}`.
  - Both, and also restore-preview, diff, export as-of and state-at-commit, can return 410 history_compacted (X-12).
- **POST `/graphs/{gid}/sync` (versioning.py:2530) and `/graph/resync`.** MAIN_SYNC (P, plus a bypass when protected, else 409 review_required) (X-21).
- **POST `/graphs/{gid}/bulk-ingest`.** MAIN_BULK.
- **Projection rebuild and reconcile.** REBUILD (P).
- **POST `/graphs/{gid}/forks`.** M (was R).
- **Imports (`/imports`, `/imports/uploads/{id}/complete`).**
  - A branchId must pass the draft-write gate; main gets 409 main_write_forbidden.
  - `autoPublish` requires DIRECT_PUBLISH at creation and again in the job.
  - Commits use `summary.principal`.
- **Exports, plan and stream.** A draft or as-of-draft scope requires READ_DRAFT.
- **GET `/graphs/{gid}/access-events?action=&actor=&branchId=&prId=&decision=&before=&limit≤200`.** Keyset on (occurred_at, id). Returns `{items, nextCursor}`. Authz AUDIT_READ.

### Lifecycle and ingest routes
These are owned by CONVERSION and INGEST. ACCESS only binds each route to its Action through `_authorize`, following the §4 registry.

**Issue resolution** (X-05):
- **`choice='current'`:** M. Writes nothing.
- **`choice='source'`, target main:** P on every graph.
  - Calls `apply_ops_detailed(principal=human, allow_main=True, main_action=Action.INGEST_ISSUE_RESOLVE_MAIN)`.
  - Commits with kind 'edit', actor = the human, `change_reason='issue:<iid>'`.
- **`choice='value'`, target main:** MAIN_WRITE_THROUGH. On a protected graph it needs a bypass (`access_events main.write_through`, decision bypassed), otherwise 409 review_required `{canStageToDraft:true}`.
- **target draft:** DRAFT_WRITE on `draftBranchId`.

**Ingest approval:** INGEST_APPROVE. On a protected graph, four-eyes applies: 403 self_approval_forbidden.

### `graph.py`
- **POST `/{ws}/graph/changes`** (graph.py:3720):
  - adds `Depends(require_versioning_enabled)` and requires an authenticated user (removing the `get_optional_user` 'system' fallback);
  - follows the §8 draft-write gate with `allow_main=False`;
  - main returns 409 main_write_forbidden.
- **Legacy mutations with no branchId** (`/save`, `/nodes/create`, `/edges*`, `/commands/batch`) on a versioned source are MAIN_WRITE_THROUGH.

### `views.py`
`GET /views/{id}?branchId`, `PUT /views/{id}/layout?branchId` and every library route that takes branchId call `require_branch_scope`: same graph, plus READ_DRAFT, or open plus DRAFT_WRITE for writes.

---

## Enforcement points (file:function → change)

### New modules
- **`versioning/errors.py` (new, shared).** Moves `AccessDenied` (service.py:187, now with `code` and `required`) and `ApprovalRequired` (L191, now with `missing` and `stale`). Adds `BranchNotOpen`, `MainWriteForbidden`, `ReviewRequired(pr_id, can_stage_to_draft)`, `ReviewPending`, `ChangesRequested`, `PendingChanges`, `HeadMoved`, `VersionConflict(resource, current)`, `BypassReasonRequired`, `IneligibleMember`, `IneligibleReviewer`, `ClientUpgradeRequired` and `GroupsUnavailable`, and hosts CONVERSION's `GraphNotWritable` and `LockBusy`. service.py re-exports them.
- **`versioning/access.py` (new, pure).**
  - `Principal`.
  - `Action` with `perm`, `legacy` and `audit_sink`.
  - `draft_level`.
  - `decide(principal, action, *, policy, lifecycle, branch, relation, pr, bypass) -> Decision(allowed, via, code, required)`.
  - `can_bypass`.
  - `explain(principal, ctx)`, which composes CONVERSION's `lifecycle_state.allowed_actions` with `decide`. When both deny, the state reason wins.
  - `SAFETY_CODES` and `ENFORCE`.
- **`versioning/review_gate.py` (new, pure).** `evaluate(...) -> Evaluation{status, valid, missing, stale, changes_requested_by, blocking}` and `is_neutral(rows)`.

### `service.py`
- **`_authorize(s, action, principal, *, graph, branch=None, pr=None, bypass=None)` (new).**
  - Loads the relation once: owner, member rows, groups only if a group row exists, PRp, LP.
  - Calls `decide`.
  - Writes `AccessEventORM` when `audit_sink == 'access'` or via ∈ {admin, bypass}.
  - Denials raise. In shadow mode, legacy non-safety denials record `would_deny` and allow.
  - A `system:*` principal outside its permitted action raises.
- **Helpers.**
  - `_branch_role` (L4395) gets its groups from `principal.groups_loader`.
  - `_require_edit` (L4419) and `_require_manage` (L4426) become wrappers over `_authorize`. This deletes the inverted L4420.
  - `_require_open` (L4413) raises `BranchNotOpen`.
  - `_branch_readable` (L4444) delegates to `access.draft_level`, which removes the `can_manage` short-circuit at L4451. `assert_branch_readable` and `_readable_branch_ids` inherit the change.
- **NEW `_draft_write_prologue(s, graph_id, branch_id, principal)`.** Implements §8 draft-write steps 2–6. It is used by `stage_changes` (L583), `checkpoint` / `_checkpoint_once` (L705), `_rebase_draft_once` (L1095), `claim_draft`, the import window and `_apply_ops_once` for drafts. `stage_changes` also bumps `branch.updated_at`.
- **`apply_ops`, `apply_ops_detailed` and `_apply_ops_once` (L5420).**
  - Gain required `principal`, `allow_main=False` and `main_action=Action.MAIN_WRITE_THROUGH`.
  - Replace `s.get(BranchORM, bid)` with the scoped FOR UPDATE select.
  - A main branch: `MainWriteForbidden` unless `allow_main`; then `_lock_graph` (already held for main writes), `_assert_writable` and `_authorize(main_action)`.
  - A draft: the prologue.
  - After a draft commit: `_on_draft_content_changed`.
- **NEW `_on_draft_content_changed(s, branch)`.** Dismisses approved reviews as `stale`, re-evaluates, sets `approval_status`, `approved_by` and `status`, and writes `pr.review_dismissed` (`system:…`? No: the actor is the committing principal, with `via='stale'`). It is called from:
  - `_apply_ops_once` (draft);
  - `_checkpoint_once` when it writes a commit;
  - `_flush_pending_changes` (L850) when it produces a commit;
  - `_rebase_draft_once` after L1165, only when `stats['rebased']` is non-zero.
- **`publish` (L882).**
  - Gains required `principal` and `bypass`.
  - Removes the pre-lock flush at L907. Inside `_once` it follows §8 publish/merge steps 1–12; the flush runs only when no review requirement applies.
  - `_authorize(DIRECT_PUBLISH)` replaces the `is_shared` check.
  - The plan 1.3 overlap gate replaces the hard `NotUpToDate`.
  - `merged_via`, the bypass fields and `stats.review` pass through `_apply_draft_squash` and `_resolve_live_prs`.
- **`merge_mr` (L2072) and `merge_pr` (L1766).**
  - Gain required `principal`, `bypass` and `approver_standing`.
  - Delete the pre-lock flush at L2097.
  - Reorder to §8: the review gate (`review_gate.evaluate`) moves before `_compute_merge_bounded` (today it is at L2125, after L2121).
  - Set `approved_head_commit_id`.
  - `merge_pr` uses the target graph's policy.
- **Reviews.**
  - `approve_pr` (L1685) becomes a wrapper over the new `submit_review(pr_id, *, principal, state, body, expected_head_commit_id)`.
  - Contributors come from `_branch_contributors(content_only=True)` (L5780), which excludes neutral pulls and adds `working_changes` actors.
  - NEW `dismiss_review`.
- **PR open, edit and close.**
  - `open_pr` and `open_draft_mr` (L1947): `_authorize(PR_OPEN)`, the injected `reviewer_eligible` callable, the initial evaluate, and `_assert_writable`.
  - `update_pr`: reviewers are a full replace; removed reviewers are dismissed with `reviewer_removed`.
  - `close_pr`: `close_reason`.
- **`abandon_draft` (L1264).**
  - Branch FOR UPDATE and `_authorize(DRAFT_ABANDON)`, which replaces the `is_shared` check.
  - Closes live PRs (`_live_prs_for_branch` L1913) with `close_reason='draft_abandoned'`.
  - Sets `abandoned_by` and `abandon_reason`.
- **NEW `reopen_draft(graph_id, branch_id, *, principal, views_restorable)`.**
- **Membership.** `update_branch`, `add_branch_member` (delete the `is_shared` flip at L553-555; set private → members), `remove_branch_member` and `list_branch_members` use `_authorize(DRAFT_MANAGE / READ_DRAFT)` and write access_events.
- **`sweep_idle_drafts` (L1311).**
  - Runs as `Principal.system('ttl')`.
  - Extends the WHERE clause at L1322-1327:
    - `NOT EXISTS` a live MR;
    - `NOT EXISTS` `working_changes`;
    - `graph_id IN (SELECT id FROM graphs WHERE lifecycle_state IN ('live','live_legacy') AND deleted_at IS NULL)`.
  - Pass 1 warns: sets `ttl_warned_at` and writes `branch.ttl_warned`.
  - Pass 2 abandons with `abandon_reason='ttl'` and `abandoned_by='system:ttl'`, plus bulk events.
  - The `worker.py` sweep loop returns early when `versioningEnabled` is off.
- **`revert_commit` (L1351) and `restore_to_commit` (L1464).**
  - Gain `principal`, `target` and `bypass`.
  - Call INGEST's `_assert_not_compacted` and return 410.
  - target draft: `open_draft(owner=principal.actor)` followed by `_write_deltas` as an 'edit' commit.
- **`sync_ingest` (L4982) and `resync_from_provider`.**
  - `_authorize(MAIN_SYNC, human)`, plus a bypass when protected.
  - Commits as `Principal.system('sync')` with kind 'sync', `source_id` = the implicit source, and `source_ref.requested_by` = the human.
  - Writes `access_events main.synced` with actor = the human (X-21).
- **`apply_source_delta(graph_id, *, principal, source, envelopes, delivery, …)`** (INGEST).
  - Asserts `principal == Principal.service(source.id)`.
  - Follows the §7 ingest gate and the INGEST_APPLY rule (X-08).
  - Decoder 'snapshot' gets `service_principal_forbidden`.
- **Lifecycle adopt repair** (CONVERSION's job; ACCESS contract).
  - On an unprotected graph: `_authorize(SYSTEM_MAIN_COMMIT, Principal.system('lifecycle'))`.
  - On a protected graph: the job rebuilds `Principal.from_snapshot(summary.principal)` and calls `open_draft(visibility='private')`, then `apply_ops_detailed` on that draft, then `open_draft_mr`. All of these are authorized as the requester. The job then completes with `summary.outcome={code:'repair_pr_opened', prId, branchId}`.
- **`list_branches` (L4195).** A SQL visibility predicate before LIMIT:
  - main;
  - OR owner;
  - OR (`workspace` AND `can_read`);
  - OR member (user, or a group only if any group row exists for the graph);
  - OR PRp;
  - OR (`can_publish` AND LP);
  - OR `is_admin`.
- **`_pulls_filtered`, `get_pr` and `_pr_meta`.** P and A see everything. Otherwise: author OR `reviewers @> [actor]` OR the draft is readable. Adds `requirements` and `access`.
- **Remaining entry points.** `enable_versioning`, `bulk_ingest`, `fork_graph`, `claim_draft`, `branch_freshness`, `preview_merge` (adds the `graph_id` match) and `neighbors_from_state` all gain a required `principal` and their Action.

### Routes, jobs and providers
- **`api/v1/endpoints/versioning.py`.**
  - `principal_ctx` replaces `viewer_ctx` (L100).
  - `pr_in_workspace` (L421) calls `svc.pr_visible`.
  - `_domain_errors` (L458) gets the shared mapping, with subclasses before L480, and sampled denial audit through `auth/dependencies._audit_access_denied` (L564).
  - The read routes for merge-preview, view-changes, freshness, members and neighbors assert READ_DRAFT.
- **Jobs.**
  - `_queue_publish` and `_publish_from_job`: set `publishing`, store the snapshot and bypass, re-run the full gate under the lock, and on refusal or GraphNotWritable reset to `open` and write an event.
  - Legacy jobs with no snapshot fail with "Re-submit" under enforce.
- **`services/context_engine.py for_workspace` (L150-200).** For a draft, `assert_branch_readable(viewer=principal)`. A denial becomes `KeyError('branch_not_found')`, which maps to 404. The principal is passed to the providers.
- **`graph.py`.**
  - `get_context_engine` builds the Principal.
  - `apply_graph_changes` (L3720) is changed as described in API.
  - The bootstrap and resync routes go through `_authorize`.
- **Providers.**
  - `providers/versioned_write_provider.py _record` passes `allow_main=True`, so MAIN_WRITE_THROUGH is enforced.
  - `versioned_branch_provider.py` and `draft_overlay_provider.py` writes pass `allow_main=False`.
- **Imports.** `import_export/service.py create_import_job` calls `authorize_branch(DRAFT_WRITE)` and stores the snapshot. `import_worker.py` uses `from_snapshot` and re-checks open and writable per window.
- **`api/v1/versioning_gate.py`.** NEW `require_branch_scope(session, ws_id, view, branch_id, principal, need)`, used by `views.py` `get_view`, `update_view_layout` and the library routes.
- **`purge_worker.py`** (X-14).
  - `_phase_meta` (L365) adds `DELETE pr_reviews WHERE graph_id=:g` before merge_requests (the FK cascade is the backstop).
  - `access_events` is never deleted.
  - No GUC.
- **Permissions and docs.**
  - `permission_service.py` L430 and L463: add publish.
  - `rbac_seed.py`: add the permission, the role and the grants.
  - `docs/RBAC.md`: catalogue, roles, and the §4 registry.

### Frontend
- **`frontend/src/services/versioningApiService.ts`.** Typed errors for every §6 code. New calls: getBranch, updateBranch, members CRUD, reopenDraft, submitReview, listReviews, dismissReview, updateMergeRequest, closeMergeRequest, patchGraphPolicy, listAccessEvents, and revert/restore with target. `useVersioning.ts` gets the matching hooks.
- **`features/versioning/model/accessCopy.ts` (new).** Copy for every shared §6 code. A completeness test enforces it.

---

## UI

### Principles
- Buttons follow `access.can.*`. Disabled buttons use `Button disabled` inside `HoverTip`, with the reason from `accessCopy`.
- `usePermission` may only hide tabs.
- Destructive or governance actions use `DangerConfirmDialog`.
- List states: loading uses `Skeleton`; empty uses `EmptyState`; error uses `EmptyState` with a Retry `Button`.
- Building blocks: `UserAvatar`, `TimeStamp`, `Badge`, `Segmented`, `Tabs`, `ProgressBar`.
- Every dialog uses the `ModalShell`/`useModalA11y` focus trap and is checked with vitest-axe.

### New shared component
**`components/ui/SubjectPicker.tsx`** is extracted from ShareViewDialog's `AddGrantPicker` (ShareViewDialog.tsx:771). ShareViewDialog is refactored onto it in the same PR. `ReviewerPicker` (features/reviews/components) wraps it in users-only mode.

### Screens
1. **`DraftAccessSection`** in `BranchSettingsModal`, replacing the Private/Shared toggle.
   - A `Segmented` with Only me / Me and people I invite / Everyone in {workspace}, plus an impact line.
   - The owner row is pinned.
   - Member rows have a role `Segmented` and a Remove button. When `effectiveRole` is lower than the assigned role, an amber `Badge` reads "View only: lacks edit permission".
   - `SubjectPicker` at the bottom.
   - States:
     - loading: Skeleton;
     - empty: "Only you can see this draft";
     - 422 inline;
     - read-only with a HoverTip;
     - 409 branch_closed or graph_not_writable: read-only banner;
     - admin acting: "Admin access: changes are logged" Badge.
   - Switching to private when members exist opens a DangerConfirmDialog listing who loses access.
2. **`BranchManager`.**
   - `Tabs`: Open / In review / Archived.
   - Archived rows show who archived the draft or "Auto-archived after N idle days", and a Reopen button. When `viewsRestored=false`, a toast reads "Draft reopened; its draft-only views were already purged".
   - DraftCard shows a visibility `Badge` and an "Archives in N days" `Badge`. Its buttons follow `branch.access.can.*`.
   - ArchiveConfirm names the live PR.
3. **`CommitDialog` and `PublishDraftDialog`.**
   - On a protected graph the primary action is "Submit for review", with a banner "Published is protected: N approvals required".
   - "Publish without review…" (opening BypassConfirmDialog) appears when `can.bypass`.
   - The MR path uses `ReviewerPicker`.
   - Inline 409s: review_required and review_pending offer Submit for review; pending_changes offers Save first.
4. **`PrDetailDrawer`** with **`ApprovalStatusPanel`** (new).
   - A quorum `ProgressBar`.
   - Reviewer rows with a state Badge (Approved / Changes requested / Pending / Stale), a `TimeStamp` and the head short-sha.
   - Blocking chips: changes requested, unsaved changes, and the D2 status ("No overlap" or "Overlaps N entities (people/structure): pull required").
   - Composer: a `Segmented` (Comment / Approve / Request changes) that sends `expectedHeadCommitId=pr.sourceHeadCommitId`. On 409 head_moved, a "draft changed" banner with Reload keeps the drafted text.
   - Action bar: Merge follows `can.merge`, or is disabled with `blocking[0]`. "Merge without review…" and Close follow the envelope. This removes the `hasReviewers` and `canManage` checks.
   - After a pull, a `reviewKept` toast.
   - A bypass Badge appears when the PR was merged by bypass.
   - Error state with Retry.
5. **`BypassConfirmDialog`** wraps DangerConfirmDialog.
   - Lists the unmet requirements.
   - Requires a reason of at least 10 characters, with a counter.
   - States that the bypass is recorded in the access log.
6. **`ProtectionSettingsPanel`** (hub tab 6, "Review & protection").
   - Controls:
     - Require review toggle;
     - approvals stepper (1–10);
     - "Who can skip review" Segmented: Nobody / Workspace admins / Publishers;
     - "Must be up to date" Segmented: On overlap / Always (X-10);
     - ingest guardrails (INGEST);
     - the self-approved sources list with a "needs countersign" Badge.
   - Saving opens a reason prompt and sends `expectedVersion`. On 409 version_conflict: "Someone else changed these settings", with Reload.
   - Enabling protection shows the impact, including `selfApprovedSources`. Disabling protection opens a DangerConfirmDialog.
   - Non-admins see it read-only.
7. **History tab, "Access log" segment** (shared §16 item 7). A virtualized list of access_events with actor (human, service or system), action and decision Badges (bypass highlighted) and an expandable detail row. Filters: action, actor, bypass only. The segment is shown when `graph.access.can.readAudit`.
8. **Canvas: `useActiveBranchGuard` (new) and `CanvasVersioningBar`.** One handler:
   - branch_closed: keep the staged edits; offer "Copy to a new draft" and "Switch to Published".
   - graph_not_writable: read-only banner with the reason.
   - cutover_settling: auto-retry after Retry-After.
   - review_required: offer "Open a draft".
   - main_write_forbidden: open a draft.
   - 403 or 404 on another user's draft: banner "You're viewing {owner}'s draft. Ask them to invite you"; edit tools follow `can.write`.
9. **Reviews inbox (`PrListRow`, `WorkspaceReviewsInbox`).** An "Awaiting my review" filter, Close/Dismiss gated by `can.close` with an error toast, and "Changes requested" / "Stale approvals" Badges.

---

## Failure modes & recovery

| Scenario | Behaviour | Recovery |
|---|---|---|
| A save races the publish or merge of the same draft | The merge holds `_lock_graph` and then the draft FOR UPDATE. A save that commits first makes the approval stale (409 approval_required{stale}), or lands in the squash when no review applies. A save that comes second gets 409 branch_closed, and the client keeps its edits. | Copy to a new draft. No orphaned writes; no unreviewed content. |
| An approval races a commit | The head check under branch FOR SHARE returns 409 head_moved, or the later commit makes the approval stale. | Re-review. |
| Staged edits exist at merge time while a review applies | 409 pending_changes; no silent flush (old service.py:2097). | Save, then re-review. |
| A freeze, trash or detach transition races draft saves | The transition's FOR UPDATE waits for KEY SHARE holders; later saves get 409 graph_not_writable. | Unfreeze or restore. Drafts and PRs persist (detach force closes them with graph_detached). |
| Merge during cutover_settling | 409 graph_not_writable with Retry-After. | Auto-retry. |
| A queued publish meets tightened policy, revoked P or a frozen graph | The job re-authorizes from the snapshot and re-reads the policy and lifecycle under the lock. On refusal: branch → open plus an event. A stuck `publishing` branch older than JOB_TIMEOUT is reset. | Submit for review or retry. |
| An approver loses access | The merge re-resolves standing; the approval no longer counts. A failed lookup returns 503; it never guesses. | Another approval. |
| The management DB is down during group resolution | 503 groups_unavailable only when a group row matters. Owner and user-member paths keep working. | Retry. |
| A stale token carries `datasource:*` | Bounded by the claims TTL. R3 requires a forced claims refresh first. | – |
| A custom role holds `workspace:datasource:*` | It gains publish. These roles are listed in the R0 report and reviewed before R3. | The admin narrows the role. |
| The access_events insert fails | It is in the same transaction, so the action rolls back with 500. | Retry. |
| A denial flood | Sampled once per hour per (actor, action, graph). | – |
| A reviewer is unavailable, or changes_requested blocks | P or A dismisses with a reason, or an eligible user bypasses. The TTL sweep never archives drafts in review. | – |
| The owner leaves | The admin reads the draft, adds a maintainer (or themselves, audited), and the maintainer finishes it. | – |
| Bypass misuse | Requires eligibility and a reason; recorded in access_events, on the PR, in `stats.review` and in a history Badge. `nobody` disables it. | Policy change (audited). |
| A compromised ingest credential | Bound to one source and one graph; INGEST_APPLY only; field policy, delete governance and the breaker apply. | Pause (M), fix the mapping, approve, replay (P). Or revert the specific in-window commits with target=draft plus a PR (or a bypass). Compacted commits get 410 (X-12). |
| A revert or restore into a compacted range | 410 history_compacted with the checkpoint id. | Revert the checkpoint diff via target=draft. |
| The TTL sweep on a non-live graph, a draft in review or a draft with staged work | Excluded by the predicate. A wrongly swept draft can be reopened. | Reopen. |
| Abandon of a draft with an approved PR | The PR is closed (draft_abandoned) and its reviews kept. Reopening the draft does not reopen the PR. | Open a new PR. |
| A policy PATCH races a merge | Both hold `_lock_graph`, so they are linearized. A PATCH with a stale version gets 409 version_conflict. | Reload. |
| A self-approved source exists when protection is enabled | The source keeps running with a "needs countersign" Badge; its next change needs four-eyes. | – |
| The collaborator backfill hits a duplicate | ON CONFLICT DO NOTHING; idempotent; dry-run by default. | – |
| An old client (isShared, or no expectedHeadCommitId) | isShared is aliased for one release. A missing head binds in shadow and returns 422 client_upgrade_required in enforce. | Upgrade. |
| A view-capability caller passes a draft branchId | 404, identical to a missing branch. | – |
| Purge | access_events, lifecycle_events, ingest_source_revisions and the purge job row are kept. pr_reviews are deleted. | – |

---

## Rollout & migration of existing data

The rollout follows the shared §17 order.

**R0: before CONVERSION L3 and INGEST S2 (X-20).**
1. Deploy M1 together with `rbac_seed` and the `_SEED_LEAVES` / `_WORKSPACE_CATEGORY_LEAVES` change.
2. Run a forced claims refresh through the revocation service.
3. Apply chain M2–M5 and M9.
4. One intended visible change: live PRs that had approvals become `pending`. They can be re-approved through the existing `/approve`, and an in-app notice says "Approvals now apply to a specific version".
5. The R0 report goes to the alembic log and `docs/runbooks/versioning-access-rollout.md`. It lists:
   - non-publishers who published, merged, reverted, restored, synced or deleted a data source in the last 90 days (using `ix_commits_actor`);
   - custom roles with `datasource:*`;
   - open private drafts with non-owner contributors;
   - PRs whose approvals were reset.

**R1: fences (enforce immediately, independent of the flag).**
- branch_closed, the foreign-graph 404, main_write_forbidden on `/graph/changes` and imports, the `publishing` status during jobs, service and system principal restrictions, and graph_not_writable.
- Every non-legacy action enforces from the day it ships.
- Run `backend/scripts/versioning_access_backfill.py` (dry-run by default, `--apply`). For every open draft or fork_draft, distinct non-owner actors in `commits` or `working_changes` become `branch_members(role='editor', added_by='system:migration')`, a private draft becomes `members`, and each insert writes `migration.access_backfill`.

**R2: shadow, after INGEST S2 (1–2 weeks).**
- `GRAPHVER_ACCESS_ENFORCE=shadow` applies to legacy actions only.
- The UI ships in R2. Admins bind `workspace_publisher` from the R0 report. A dashboard shows `would_deny` by action, role and code.

**R3: enforce. Preconditions:**
- `would_deny` is about 0 on legitimate paths, or each case is explained;
- queues are drained of jobs without a snapshot;
- a second claims refresh has run.

From R3, private drafts are owner-and-member only, main-advancing actions need P, `expectedHeadCommitId` is required and PR lists narrow.

**R4 (after INGEST S4 report mode).** There is no global default. Admins enable `require_review` per graph, ingest graphs first: configure the sources and guardrails, then countersign the self-approved sources.

**Rollback.**
- Set `GRAPHVER_ACCESS_ENFORCE=shadow`. Fences and non-legacy actions stay enforced.
- The schema is additive, and `is_shared` was never modified.
- The collaborator backfill is reversible from its events.
- Legacy approvals are not restored, by design.

**Backward compatibility (one release).** `isShared`, `/approve`, `approvedBy` (mirror) and the all-requested-reviewers semantics stay.

**Docs.** `docs/RBAC.md`, docs/versioning/03 §3.13 (gate orders), docs/versioning/06 (API) and the runbook (bypass, dismiss, ownerless drafts, disabling protection in an incident, pausing a source).

---

## Tests & pass criteria

- **`tests/unit/versioning/test_access_matrix.py`.**
  - Covers every Action × principal {V, E, P, A, view_capability, service, each `system:*`} × relation × visibility × branch status × lifecycle state × require_review × bypass_policy.
  - The expected results live in `tests/fixtures/versioning_access_matrix.csv`.
  - Pass:
    - 100% of cells match;
    - every denial code is in `accessCopy.ts`;
    - shadow allows only `legacy=True` and non-safety codes;
    - every non-legacy action enforces in shadow;
    - 100% branch coverage of `access.py`.
- **`test_review_gate.py`.** Exclusions (author, owner, contributor when protected); quorum; requested reviewers; changes_requested; stale; standing revocation; `is_neutral` (zero-rebased pull is neutral; rebased > 0, edit, checkpoint or more than 1000 rows are not). Pass: every §7 transition row yields the stated status.
- **`test_permission_service.py` (extend).**
  - read+manage does not collapse to `datasource:*`, and `has_permission(publish)` is False;
  - read+manage+publish passes;
  - admin, org_admin and super_admin imply publish.
- **`test_service_signatures.py`.** Every public mutating entry point, including the lifecycle entry points, `apply_source_delta`, `sync_ingest`, `submit_review`, `update_graph_policy` and `reopen_draft`, has a required keyword-only `principal`. Pass: none has a default.
- **`test_versioning_route_authz_graph.py`.** Every versioning, ingest and lifecycle route, every `graph.py` mutation and every branchId view route depends on `principal_ctx`, the principal-carrying `get_context_engine` or `require_branch_scope`. Pass: full coverage; adding an unguarded route fails CI.
- **`test_versioning_gate_order.py`** (X-27). Crafted multi-violation requests assert the first-failing code:
  - frozen graph + non-member + closed branch → graph_not_writable;
  - non-member + closed branch → 404 (unreadable);
  - member + closed → branch_closed;
  - merge during cutover_settling with missing approvals → graph_not_writable;
  - an editor merging with missing approvals → 403 needs_publish_permission;
  - missing approvals + overlap → approval_required.
- **`test_versioning_branch_guards.py` (live PG).**
  - Writes into merged, abandoned or publishing drafts → 409.
  - main or 'main' → main_write_forbidden.
  - A foreign branch → 404.
  - A service principal on a draft → 403.
  - 20 barrier-forced save-vs-publish and save-vs-merge interleavings.
  - Pass: 0 commits on non-open branches; every 200 save is either in the squash or the merge returned approval_required{stale}.
- **`test_lifecycle_concurrency` (ACCESS part)** (X-15). Freeze vs 50 concurrent draft saves. Pass: 0 draft commits with `created_at` after the transition's `lifecycle_events` row. A policy PATCH vs merge produces one linearized outcome.
- **`test_versioning_draft_acl.py`.** Alice's private draft:
  - Bob (E) gets 404 on every read path (including ContextEngine, neighbors, merge-preview, view-changes, freshness, members, export and views with branchId);
  - Bob gets 403 or 404 on every write path;
  - Bob as an editor member can write but not manage;
  - group membership works through `groups_loader`;
  - `workspace` visibility lets editors write;
  - view_capability reads main only;
  - A reads and manages members but cannot write.
  - Pass: every allowed state change has exactly one row in its sink.
- **`test_versioning_protected_main.py`.** The full D4 and D2 scenario: self_review, contributor block, stale approval after a save, merge via auto-rebase on a disjoint main change with the approval kept, an overlapping change → not_up_to_date{reason:'people'}, service-only overlap merges, rewriting vs neutral pull (`reviewKept`). Pass: `stats.review.approved_head_commit_id` equals the draft head; `merged_via='review'`.
- **`test_versioning_bypass_and_policy.py`.** Bypass eligibility for each policy value; 422 without a reason; `nobody`; 409 version_conflict; a queued job refused after the policy tightens resets the branch to open; pending_changes; the PATCH impact lists `selfApprovedSources`.
- **`test_versioning_draft_lifecycle_acl.py`.** Abandon closes the PR (draft_abandoned); reopen; reopen on a trashed graph → graph_not_writable; the sweep skips live-PR, working_changes and non-live graphs and the flag-off case, warns at TTL−7d and abandons with ttl; detach force closes PRs and drafts with graph_detached.
- **`test_versioning_service_principal.py`.** On a protected graph, the service writes main (`actor_kind='service'`); the service calling any other action → 403; a source on graph A writing graph B → 403; decoder snapshot → 403; blocked → HOLD; `sync_ingest` commits are kind 'sync' with actor `system:sync`, `requested_by` set, and need a bypass when protected.
- **`test_ingest_issue_access.py`** (X-05, X-25).
  - 'current' with M writes nothing;
  - 'source' → main under protection with P succeeds, with commit actor = the human and `change_reason='issue:<iid>'`;
  - 'value' → main under protection → 409 review_required{canStageToDraft:true}, and with a bypass → `main.write_through` bypassed;
  - target=draft needs DRAFT_WRITE;
  - the approver equal to the proposer on a protected graph → 403 self_approval_forbidden.
- **`test_adopt_repair_access.py`** (X-06). On a protected graph the repair lands in the requester's private draft plus a PR, the job completes with `repair_pr_opened`, and the requester cannot approve it. On an unprotected graph the commits are kind 'import' with actor `system:lifecycle`.
- **`test_history_compacted_access.py`.** Revert, restore, restore-preview, diff, export as-of and state-at-commit into a compacted range → 410 with the checkpoint id.
- **`test_versioning_import_access.py`.** main → 409; a teammate's private draft → 403; an editor member → 202 with actor = the requester; autoPublish under protection → 409.
- **`test_rbac_migration.py` (extend).** The permission and role exist; workspace_member lacks publish; seed equals migration; downgrade removes them. Under enforce, an editor's revert, restore, rebuild or sync → 403 needs_publish_permission.
- **`test_gv_access_migration.py`.** Visibility backfill; `is_shared` unchanged; legacy approvals → pending plus legacy_unbound rows; zombie PRs closed with `close_reason='migration'`; the backfill script is idempotent; upgrade → downgrade → upgrade works; `test_migrations_*` shows the live CHECK domains equal the ORM domains.
- **`test_access_events_append_only.py` and the purge test.** UPDATE or DELETE always raises; a failed audit insert rolls back the change; after purge, 0 rows for :g in every graphver table except the three audit tables and the purge job; `pr_reviews` is 0.
- **Frontend tests.**
  - `DraftAccessSection.test.tsx`, `ApprovalStatusPanel.test.tsx`, `PrDetailDrawer.review.test.tsx`, `ProtectionSettingsPanel.test.tsx` (two up-to-date options; version_conflict reload; selfApprovedSources list), `BranchManager.access.test.tsx`, `useActiveBranchGuard.test.ts` (each §16 code), and `accessCopy.test.ts` (every shared §6 code has copy).
  - Pass: all assertions, vitest-axe clean, and `ShareViewDialog.test.tsx` green.
- **`e2e/versioning-access.spec.ts`** (Playwright, nightly). Private draft, then invite, then protect, then submit, approve, save (stale), re-approve, a disjoint main change, merge by auto-rebase. The access log shows opened → reviewed → dismissed(stale) → reviewed → merged. Pass: under 3 minutes, and FalkorDB equals PG main for the touched entities.
- **Load (Locust).** 300 users, 20% on protected graphs. Pass:
  - authz overhead p95 < 10 ms on `/graph/changes`;
  - publish and merge p95 < 3 s;
  - 0 authz 5xx;
  - no KEY SHARE lock waits > 50 ms p99 caused by main commits.

---

## Findings resolved

**Review findings.**
- **MERGE-1, WRITE-1, GAP_E2E_COLLAB_TRACE-2, LIFECYCLE-4.** Scoped FOR UPDATE branch load, `_require_open` and main fencing; `/graph/changes` always uses `allow_main=False` and needs auth plus the flag; the canvas recovers from 409s.
- **MERGE-5, LIFECYCLE-11, GAP_R4_R5_UI_AUDIT-2.** Explicit visibility; the inverted `_require_edit` is removed; owner/member enforcement on every path; DraftAccessSection.
- **MERGE-6, WRITE-11, GAP_E2E_COLLAB_TRACE-3.** Head-bound `pr_reviews`, stale dismissal, pending_changes and the review gate under the draft lock.
- **APIOPS-5, LIFECYCLE-5, LIFECYCLE-6, MERGE-12, GAP_R4_R5_UI_AUDIT-6.** Abandon closes PRs; reopen; sweep exclusions (live PR, working changes, lifecycle state, flag); TTL warning; zombie-PR backfill.
- **APIOPS-6, GAP_IMPORT_EXPORT-14.** Imports never write main; actor comes from `summary.principal`.
- **APIOPS-7.** The publish permission with the wildcard fix; protected main.
- **APIOPS-8.** READ_DRAFT on every draft read path; `preview_merge` checks graph_id.
- **APIOPS-15 (partial).** `/graph/changes` auth.
- **VIEWS-5.** `require_branch_scope`.
- **FRONTEND-5, GAP_R4_R5_UI_AUDIT-4 (approval part) and -5 (dismiss gating).**
- **LIFECYCLE-7 / FALKORSCALE-5 (permission part).** Forking needs M.

**Integration issues applied.**
- X-02: chain ids M1, M4, M5 and M9.
- X-03: `errors.py`, the shared codes, `version_conflict`.
- X-04: the §2 matrix and Action entries.
- X-05: issue resolution.
- X-06: no system drafts; human-owned repair draft.
- X-08: the INGEST_APPLY rule.
- X-10: two-value `require_up_to_date`.
- X-12: 410 everywhere; restore(scope=all) removed.
- X-13: `access_events` scope and purge retention.
- X-14: pr_reviews in purge.
- X-15: KEY SHARE.
- X-17: the envelope with `required`, and `accessCopy`.
- X-18: hub tabs and the canvas handler.
- X-20: legacy-only shadow; R0 as prerequisite.
- X-21: sync attribution.
- X-22: enum domains, sweep predicate, `_assert_writable`.
- X-23: history export/restore need A.
- X-25: four-eyes and `selfApprovedSources`.
- X-26: actor strings and snapshots.
- X-27: gate orders.
- X-29: `review_policy_version`.

---

## Open questions

1. Should the PR author be allowed to merge their own approved PR without P when quorum is met (GitHub-style)? Today an editor's PR waits for a publisher.
2. What should the default `bypass_policy` be when protection is enabled: `admins` (this spec) or `nobody`?
3. Should non-admin data-product owners get a `datasource:govern` permission for policy edits? Today policy edits are A only.
4. Per-field approval binding: should only pulls that rewrite fields the draft changed make an approval stale? Today it is conservative at entity level.
5. Should admin reads of private drafts be audited? Today only governance mutations are audited.
6. Are code-owner rules or group reviewers required by any go-live customer?
7. Should `require_review` extend to base view config and layout edits (VIEWS-1/8)?
8. Should workspace_member get a temporary publish grant for one release on existing installs, or are the R0 report plus binding `workspace_publisher` sufficient?
9. Shared §6 does not list `views_purged` or `branch_not_abandoned`. This spec avoids them (reopen is idempotent and returns `viewsRestored:false`). Confirm this is acceptable rather than adding codes to the contract.

### Critical Files for Implementation
- /home/user/dataviz/backend/app/services/versioning/service.py
- /home/user/dataviz/backend/app/api/v1/endpoints/versioning.py
- /home/user/dataviz/backend/app/services/permission_service.py
- /home/user/dataviz/backend/app/services/versioning/models.py
- /home/user/dataviz/backend/app/services/versioning/purge_worker.py
