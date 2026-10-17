> Read-only audit of branch `claude/versioning-golive-designs` at a98c0765 (main 360766d9 + Stage 1), 2026-10-17: four areas audited and each audit adversarially re-checked. Line numbers are at that commit.

# Versioned graphs: store visibility, lifecycle management and multi-user branching (synthesis for go-live)

All paths are relative to `/home/user/dataviz`. Line numbers are HEAD a98c0765 unless marked s1/W. I spot-checked these against HEAD: `_watermark_model` (versioning.py:1770), `has_workspaces` (provider_repo.py:235), `ForkRequest` (versioning.py:713) and the fork route (versioning.py:3085), the probe `.limit(8)` (probes.py:1330), `list_branches` filtering after LIMIT (service.py:4559-4586), and the six commits on s1/W.

**Lane W is further along than the task text says.** s1/W has six commits: 3ae2ecf1, f026f45a, c429cba8, f123dfad, 72e33581 (C32) and 2d697be8 (C33). Only C34–C37 have not been started.

---

## 1. Direct answers

**Can a user see which versioned graph writes into which FalkorDB instance?**
- Only in pieces, and never on the versioning screens.
- `projection_state` stores the key and provider for every graph (models.py:254-268). The API computes them (service.py:2583-2584), but `_watermark_model` drops them (versioning.py:1770-1780).
- The places that show something today:
  - the admin ProjectionPanel shows key and provider for the 8 worst graphs only (probes.py:1330);
  - the Insights placement card shows the data source's key, labelled "source graph". That matches the versioned key for everything except forks.
- There is no fleet list of graph → provider → key → shard. Nothing marks which keys the platform owns and which belong to the customer. Nothing tells a user whether a read came from FalkorDB or from Postgres.

**What is missing?**
- **Visibility:**
  - a per-graph projection card (key, provider, owned flag, node/shard, bytes, epoch, retry state, liveness);
  - a paged fleet inventory;
  - versioned and fork keys marked on the topology page;
  - a "served from" indicator.
- **Operations:**
  - move or relocate a graph;
  - freeze, detach, fork delete or purge, manual evict/rehydrate;
  - a UI for the watermark reset.
- **Safety:**
  - deleting or editing a provider ignores the versioned graphs pinned to it;
  - a fork can be bound to any data source;
  - moving a data source to another workspace orphans its history.

**Can we fully manage the lifecycle of versioned graphs in Postgres and in FalkorDB or other stores?**
- No. What works end to end:
  - enable (bootstrap), package seed, blank create;
  - rebuild and reconcile;
  - trash, restore and purge;
  - revert and restore of main;
  - point-in-time state export.
- What does not exist:
  - no lifecycle state machine;
  - no move or relocate, freeze, or detach;
  - no fork cleanup;
  - no history backup or retention;
  - moving a data source breaks every lifecycle path that filters on graphver `workspace_id`.
- **Other stores:** versioned graphs project only into FalkorDB (falkor_graph_registry.py:98-104). Neo4j, Spanner and DataHub adapters exist (backend/graph/adapters/), but projecting to them is an explicit non-goal (doc 14:71). `POST /versioning/graphs` (versioning.py:1203-1226) still accepts a non-FalkorDB source, and that graph then fails on every projection pass.

**Is full branch versioning working for many people on the same graph?**
- **On HEAD, no.** Saves can land on merged or abandoned drafts, or on main by id. A pull can revert a save that arrives during it. A queued publish loses later saves.
- **s1/W fixes those three data-loss blockers** but is not merged.
- **Overwrite paths that remain even with W:**
  - private drafts are not owner-protected for writes, publish or abandon;
  - private drafts can be read by anyone with read access, through canvas reads;
  - entities served from FalkorDB carry no version token (OCC), so edits are last-writer-wins and deletes override edits;
  - pull, merge-request open and previews replay the whole history inside the web request;
  - the UI never assigns reviewers, so approval is never enforced;
  - nothing protects main from direct publish;
  - the draft list truncates at 100;
  - there is no idempotent save yet (C34/C36).

---

## 2. Gap matrix

Status key: **W** = fixed on s1/W, not on HEAD. **=** = unchanged by Stage 1 and W.

### A. Store visibility and projection health

| Capability | API | UI | Tested | Status after S1+W | Gap | Covered by |
|---|---|---|---|---|---|---|
| Per-graph key and provider | partial (dropped at versioning.py:1770) | partial (DataSourceDetailPanel.tsx:321-327, unlabelled; GraphStorePlacementCard on DataSourceProfile.tsx:457) | none | = | Not on WatermarkModel or DataHealthTab; wrong for forks | doc 14 LifecycleSnapshot.projection (14:472) and ProjectionHealthCard (14:710) |
| Owned key vs customer key (`owns_falkor_graph`) | missing | missing | unit | = | No badge saying "platform copy" or "customer graph" | doc 14 live_legacy (14:389, 14:713) |
| Node, shard, slot, bytes | partial (graph_store.py:290-393, keyed on the data source) | partial ("source graph" label) | unit | = | Not derived from projection_state; forks missed; `shard_map` unused (models.py:257) | doc 14 KeyMigration place (14:244-246) |
| Watermark, lag, last error | works (versioning.py:852-870) | partial (manager-only, ViewVersioningPanel.tsx:187) | e2e | = | Not on the hub; non-managers blind; evicted shows as "behind" (DataHealthTab.tsx:48-54) | doc 14 Data health (14:708-714) |
| Epoch, failed_attempts, next_retry_at | missing | missing | unit | = | Backoff cannot be told apart from a wedged graph | epoch in doc 14; retry fields **NEW** |
| Liveness (C43) result | partial (last_error string only) | partial | e2e | = | No structured state or last-check time | doc 14 liveness_state (14:397) |
| Read route (FalkorDB, Postgres, or draft overlay) | missing | partial (inferred from `fresh`) | e2e | = (W C33 makes main stale more often) | No servedFrom field or chip | doc 14 read_store (14:378), chip (14:682) |
| Fleet inventory for 500+ graphs | partial (worst 8, probes.py:1330; no forks or orphans) | partial (ProjectionPanel.tsx:104-148) | none | = | No paged or filterable list; the 9th failing graph is invisible | **NEW** (E9 adds gauges only) |
| Reverse view per instance/shard | partial (topology.py:1226-1322, system admin) | partial (ShardCard.tsx) | unit | = | Versioned, owned and fork keys not marked; forks show as "unregistered" | partly doc 14:638 and 14:852; overlay **NEW** |
| Multi-instance routing by pin | works (falkor_graph_registry.py:87-118) | n/a | e2e (test_versioning_projection_provider_routing.py:117-222) | = | Invisible to users only | exists |
| Single FalkorDB writer | n/a | n/a | e2e | **W** (2d697be8) | Aggregation rollups remain a second writer (projection_target.py:73-98) | C33; doc 14 D1.4 |
| Provider delete accounts for versioned graphs | missing (provider_repo.py:235-247 joins catalog items only) | missing | none | = | A provider hosting only blank versioned models can be deleted; every projection pass then raises | **NEW** |
| Provider connection edit | partial (providers.py:412-452 evicts clients only) | missing | unit | = | Watermarks stay "fresh" on a new host; only the 60s liveness check catches it | **NEW** |
| Watermark reset after DR | works (versioning_admin.py:26-45) | missing | e2e | = | No UI; provider-wide only; graphs show "failed" afterwards (service.py:2682) | API C43; UI **NEW** |
| Eviction budget per provider (`falkor_max_resident`) | works (management.py:441,510,537) | missing | unit | = | No form field or residency count | E7 (bytes); UI **NEW** |
| Non-FalkorDB projection | missing | n/a | unit | = | `POST /graphs` accepts Neo4j/Spanner (versioning.py:1203-1226); Enable shows for unsupported providers (DataSourceVersioningTab.tsx:105-117) | non-goal (14:71); guard **NEW** |

### B. Lifecycle

| Capability | API | UI | Tested | Status after S1+W | Gap | Covered by |
|---|---|---|---|---|---|---|
| Enable (bootstrap) | works | works | e2e | = | Lossy; writes the customer key; no cutover or rollback | doc 14 L3 |
| Preflight | partial | partial | unit | = | No capacity check or dry run | doc 14 L3 |
| Lifecycle state machine | missing | missing | none | = | No single authority for state | doc 14 L0/L1 |
| Rebuild and reconcile | works (versioning.py:1789-1860) | partial (manager-only DataHealthTab) | e2e | = | Not on the hub or admin pages; rebuild is in place | doc 14 L2 blue/green |
| Move or relocate to another provider or key | missing (`ensure_projection_target` reverts edits, service.py:2610-2621) | missing | none | = | Cannot rebalance 3×64GB or instances | node relocate within one provider: doc 14 L2; **cross-provider is NEW** |
| Freeze one graph | missing | missing | none | = | Only the global gate exists | doc 14 T9 |
| Detach or disable | missing | missing | none | = | The only exit is deleting the data source | doc 14 T10/T11 |
| Trash, restore, purge | works | works | e2e | = | Refusal reason not shown (purge_worker.py:583-588; DeletedDataSources.tsx:84-92) | C20 done; reason display **NEW** |
| Move data source to another workspace | partial (workspaces.py:814 never updates graphver) | works | unit (no graphver case) | = | Orphans history; delete tombstones nothing; never reaped | doc 14 move route |
| Forks: create, list, delete, purge | partial (READ can fork; `dataSourceId` unvalidated, versioning.py:713, 3085-3096) | missing | e2e | = | Unbounded owned keys; never reaped; parent can no longer be purged; read and write keys can diverge | quota E7; validation, delete, purge and visibility **NEW** |
| Evict and rehydrate | partial (internal only) | missing | e2e | = | Churn bug once budgets are on; customer keys never evictable | E7; doc 14 actions |
| History backup and restore | partial (state export) | partial | e2e | = | No per-graph history export | doc 14 history_export |
| Retention and compaction | missing | missing | none | = | Unbounded growth | INGEST S4 |
| Lifecycle audit trail | partial | partial | unit | = | No events for rebuild, reconcile, fork, abandon, sweep | doc 14 lifecycle_events |
| Orphaned versioned graphs | partial (count only) | partial | none | = | No list or cleanup | **NEW** |

### C. Collaboration

| Capability | API | UI | Tested | Status after S1+W | Gap | Covered by |
|---|---|---|---|---|---|---|
| Canvas save fences (closed draft, main, foreign branch) | partial | partial | e2e | **W** (3ae2ecf1, f123dfad) | On s1/W an unknown branch raises `ValueError` → 500 (no handler) | C30a, C31; 500 bug **NEW** |
| Draft writer serialisation, bounded lock | partial | n/a | e2e | **W** (72e33581) | No load proof | C30a, C32, TESTS-4 |
| Pull safe against concurrent saves | partial | works | e2e | **W** | — | C30a |
| Async publish holds the draft | partial | partial | e2e | **W** (f026f45a) | BranchManager.tsx:72,86 and BranchSwitcher.tsx:164 hide `publishing` drafts | C30b; UI filter **NEW** |
| Idempotent saves and frontend save safety | missing | missing | none | not started | A retry after a timeout can double-create | C34, C36 |
| Import into a draft | partial | works | e2e | **W** (c429cba8) | Import ignores the version token | C30c, C35, E5 |
| Private-draft owner protection | missing (service.py:4783-4785) | missing | pinned wrong (test_versioning_shared.py:100-105) | = | Any member can write, publish or abandon someone else's draft | R3 per X3 (plan:104) vs plan:885: **scheduling inconsistency** |
| Private-draft read privacy | partial (context_engine.py:163-167 skips readability check) | n/a | service only | = | Viewers can read any private draft by id | doc 13:636 (R1/R3), not scheduled |
| Shared drafts and members | partial (versioning.py:1452-1491) | missing | e2e | = | Semantics inverted; no members UI; `/graph/changes` skips `_require_edit` | R2/R3 |
| Branch list paging and status filter | partial (filter after LIMIT, service.py:4570-4585) | partial (versioningApiService.ts:863-870 never pages) | none | = | Drafts drop out past 100 | R2 keyset |
| Branch GC (merged and abandoned branches) | missing | missing | none | = | Branches accumulate | **NEW** |
| OCC token on every read | partial (falkordb_provider.py:1990 has none) | partial | e2e | = | Last-writer-wins; deletes override edits | E4 |
| Bounded rebase, previews, MR open | partial (service.py:1433, 1657, 2281, 2315) | partial | none | = | Publishers can livelock on NotUpToDate | INGEST S0 |
| Conflicts: expected head, cascade, structure | partial | partial | e2e | = | Picks default to "ours"; changes published after the dialog opened are overwritten unseen | E1 |
| Reviewers, approve, request changes | partial (reviewers only at open, service.py:2283-2296) | missing (CommitDialog.tsx:97-98) | e2e | = | Approve never renders; `approved_by` race (service.py:2004-2017) | R2/R3; race implicitly fixed by `pr_reviews` |
| Approval bound to the reviewed head | missing | missing | pinned wrong | = | Changes after approval merge under the old approval | R3 |
| Protected main, publish permission | missing (`workspace:datasource:publish` checked nowhere) | missing | none | = | Any member can publish, revert or restore main | R3/R4 |
| Abandon, reopen, TTL sweep | partial | partial | e2e | lock only (W) | Sweep abandons drafts under review; no reopen | doc 13 |
| History attribution | partial | partial | e2e | = | Per-entity history shows the merger, not the author | E2 |
| Live awareness and presence | partial | partial | none | = | Canvas stale after pull; no presence | E10 (presence **NEW**) |
| Read-cache isolation | partial (graph_cache.py:1354-1377) | n/a | none | = | Every save invalidates the whole data source's cache | E8 |
| Workspace-wide "who's working on what" | missing | partial (my drafts only) | none | = | No cross-graph drafts view | **NEW** |
| Review inbox | partial | partial (no status filter, 2N requests) | none | = | Older open PRs drop out | E10 |
| Multi-user E2E, load tests, CI gate | n/a | n/a | none | = | versioning-e2e has `continue-on-error: true` (backend-tests.yml:165-168) | C99, TESTS-4 |

---

## 3. Gaps not in any plan

| # | Gap | Severity |
|---|---|---|
| N1 | Paged fleet inventory API and UI: graph → workspace → data source → provider → key → shard → status → owned → fork, including orphans and forks | high |
| N2 | Moving a graph to another FalkorDB provider or instance. Doc 14 relocate only moves between nodes of the same provider. | high |
| N3 | Fork `dataSourceId` is unvalidated and needs only READ (versioning.py:713, 3085-3096). Reads and writes then use different keys. | high |
| N4 | Provider delete guard and impact view ignore `projection_state` and blank models (provider_repo.py:235-284) | medium-high |
| N5 | Editing a provider's connection silently re-homes pinned graphs; no verify or reseed | medium |
| N6 | Fork list, delete and purge; reaper never walks forks; parent cannot be purged (purge_worker.py:498-525, 629-636) | medium-high |
| N7 | Topology overlay: versioned, owned and fork attribution plus per-provider counts. Doc 14:638 covers only key registration. | medium |
| N8 | Expose retry and backoff state (`failed_attempts`, `next_retry_at`) | medium |
| N9 | Watermark-reset UI; reset reads as "failed" (service.py:2682). Node scope is specified in doc 14:498 but unscheduled. | medium |
| N10 | Provider-type guard on `POST /versioning/graphs`; hide Enable for providers that cannot be copied | low-medium |
| N11 | Purge refusal and failure reason shown in the trash UI | medium |
| N12 | Orphaned versioned graphs: list and clean up | low |
| N13 | Branch GC for merged and abandoned branches | medium |
| N14 | Workspace-wide drafts view and presence | medium |
| N15 | s1/W: `ValueError("unknown branch")` on `/graph/changes` returns 500 | medium (fix before W merges) |
| N16 | BranchManager and BranchSwitcher hide `publishing` drafts | low-medium |
| N17 | Private-draft owner enforcement has no owning work item: X3 (plan:104) and plan:885 contradict each other | high |
| N18 | Eviction budget form field and residency count | low |
| N19 | MERGE-11 fork base never advances; field-level revert; restore expected head | medium (open decisions) |
| N20 | BootstrapJobsPanel admin actions (retry, abandon, link to source) | low |

---

## 4. Recommended Stage 2

**Prerequisite (end of Stage 1, not Stage 2):**
- Fix N15 (graph.py `/graph/changes` except list: map `ValueError`/unknown branch to 404; add an HTTP test).
- Merge s1/W.
- Land C34–C37.
- Promote versioning-e2e to required (C99).

Stage 2 assumes C33 is merged, so the projector is the only FalkorDB writer and projection visibility matters to every editor.

**On ordering:** I kept the requested order (a) → (d). Items 2C-1 to 2C-3 are go-live blockers for "people overwrite each other", though, and are small. I recommend running track (c) in parallel from day one.

### (a) Graph → store visibility and projection health

**2A-1 Projection fields on the per-graph API (S)**
- Change:
  - extend `WatermarkModel` and `_watermark_model` (versioning.py:852-870, 1770-1780) with `projectionKey`, `providerId`, `providerName`, `owned`, `epoch`, `failedAttempts`, `nextRetryAt`, `livenessError`;
  - widen `projection_watermark` in service.py (around :2579);
  - add the fields to the `Watermark` type in versioningApiService.ts:117-131.
- Use doc 14 `LifecycleSnapshot.projection` names (14:472) so they are not renamed in L1.
- Tests:
  - extend test_watermark_revisions.py;
  - new: blank, bootstrap and fork graphs each return the `projection_state` key and provider.

**2A-2 Placement by graph id (S)**
- Change: add a `graphId` mode to `GET /graph-store/placement(s)` (graph_store.py:290-393). It resolves from `projection_state`, not `ds.graph_name`.
- Reuse `placement_keys_for` and the CRC16 `key_slot` (topology.py:351-375, 1669-1682).
- Gate it on workspace read of the graph's workspace.
- Tests: test_graph_store_api.py, including a fork key.

**2A-3 ProjectionHealthCard v0 (M)**
- New component: `frontend/src/features/versioning/components/ProjectionHealthCard.tsx`. It shows:
  - provider name, key and a badge ("Platform copy" or "Customer graph");
  - node, shard, slot and memory (reuse GraphStorePlacementCard internals);
  - watermark, epoch, backoff and liveness;
  - Rebuild and Check sync (manage only).
- Mount it in `DataSourceVersioningTab.tsx` and in DataHealthTab.
- Show a read-only variant to non-managers by relaxing the `canManage` gate at ViewVersioningPanel.tsx:187 to read-only.
- Fix related UI:
  - add an `evicted` case to `heroState` (DataHealthTab.tsx:48-54);
  - rename the "rollup projection" label to "aggregation rollup" (GraphStorePlacementCard.tsx:28-34).
- Tests: DataHealthTab.test.tsx, a new ProjectionHealthCard test, a DataSourceVersioningTab test.

**2A-4 Read-route chip (S)**
- Change: add derived `readRoute: {main: 'falkordb'|'postgres', drafts: 'overlay'}` to the watermark response, using the same rule as context_engine.py:158-185.
- Show a chip in CanvasVersioningBar ("Serving from FalkorDB · {provider}" or "Serving from Postgres (catching up)"), with draft-overlay copy on drafts.
- Tests: assertions in test_versioning_draft_read_routing.py; a frontend chip test.

**2A-5 Fleet inventory (M/L; N1)**
- API: `GET /api/v1/admin/versioning/graphs?provider=&status=&workspaceId=&kind=main|fork|orphan&q=&cursor=` in versioning_admin.py.
  - Keyset paging over `GraphORM` ⋈ `ProjectionStateORM`, plus workspace and data-source names.
  - Do not apply the `present` filter from probes.py:1281-1289, so forks and orphans appear.
  - Extract the shared select out of `probe_projection_lag` (probes.py:1271-1374).
  - Requires `system:admin`; exclude API keys, mirroring test_versioning_admin_watermarks_route.py:78.
- UI: a "Versioned graphs" table in AdminInfrastructure, opened from ProjectionPanel's worst-8 list.
  - Filters: provider, status, owned, fork.
  - Row actions: rebuild, check sync, open source.
  - Slot computed client-side or via the batch `/placements`.
- Tests:
  - new test_versioning_admin_graphs_route.py (paging, filters, fork and orphan rows, auth);
  - the first unit test for `probe_projection_lag`;
  - a table component test.

**2A-6 Topology overlay (M; N7)**
- Change:
  - join all `projection_state` rows into topology `_expected_graphs` (topology.py:1226-1322);
  - add `versioned{graphId, kind, owned, status, lag}` to `GraphOnShard` (schemas.py:155-172) and to graphStoreService.ts:118-129;
  - badge rows in ShardCard.tsx;
  - show per-provider versioned counts and bytes in GraphProvidersPanel.
- Build it so doc 14:638 (candidate and retired keys) extends it rather than replacing it.
- Tests: test_graph_store_topology.py ("fork key attributed, not unregistered"), a ShardCard test.

**2A-7 Provider safety (M; N4, N5)**
- Delete:
  - `has_workspaces` (provider_repo.py:235) must also count manual data sources by `provider_id`, and `projection_state.falkor_provider` through the graphver session;
  - `get_provider_impact` (provider_repo.py:250-284) lists the versioned graphs and keys.
- Edit:
  - `update_provider` (providers.py:412-452) returns 409 `versioned_graphs_pinned` unless `confirmReseed=true`;
  - when confirmed, it calls `reset_projection_watermarks(provider)` (service.py:2659-2689).
- UI: the provider dialogs show the affected graphs.
- Tests: deleting a provider that hosts only a blank versioned model is refused; an edit with confirm reseeds.

**2A-8 Watermark-reset UI (S/M; N9)**
- Add a per-provider "Reseed from Postgres" action in GraphProvidersPanel that calls versioning_admin.py:26, with a confirm dialog showing the count from 2A-5.
- Replace the `last_error` sentinel (service.py:2682) with a `reseeding` status, so DataHealthTab no longer shows "failed".
- Defer the optional `node` scope (doc 14:498).
- Tests: extend test_versioning_admin_watermarks_route.py; DataHealthTab shows "reseeding".

### (b) Lifecycle and collaboration operations that already have APIs but no UI

**2B-1 Hub actions (S)**
- Make Rebuild and Check sync reachable from DataSourceVersioningTab and the 2A-5 rows. They reuse the existing endpoints at versioning.py:1789-1860.
- Fix the hub's own bugs:
  - the "open drafts" miscount (DataSourceVersioningTab.tsx:134,147);
  - a resolve error showing "Enable" (DataSourceVersioningTab.tsx:84-117).
- Tests: a DataSourceVersioningTab test.

**2B-2 Reviewers (M)**
- CommitDialog sends `reviewers` (the client accepts them, versioningApiService.ts:1393-1403). Add a minimal ReviewerPicker.
- Allow reviewer edits on PATCH: versioning.py:3160-3170 and 3387-3397 → `update_pr` (service.py:2038-2054).
- Fix the `approve_pr` race with `with_for_update` (service.py:2004-2017).
- Tests: test_versioning_draft_mr.py (add reviewer after open; two concurrent approvals both persist); a PrDetailDrawer test showing Approve.

**2B-3 Branch list (S/M; N16)**
- Backend `list_branches` (service.py:4559-4586):
  - apply the viewer filter in SQL before LIMIT;
  - include shared drafts;
  - add a `status` filter;
  - order drafts newest first.
- Frontend:
  - `listBranches` pages and filters by status (versioningApiService.ts:863-870);
  - BranchManager and BranchSwitcher show `publishing` and add an "Archived" tab.
- Tests: a service test with more than 100 branches and a non-manager; BranchManager.test.tsx.

**2B-4 Review inbox (S)**
- Switch DataSourceReviewFeed to `listDataSourcePullRequests(status='open')` (versioningApiService.ts:1460; versioning.py:3354-3374).
- Tests: a new inbox test.

**2B-5 Purge reason (S; N11)**
- `purge_worker` returns the state and reason, not a boolean (purge_worker.py:583-588).
- DeletedDataSources shows "Blocked: N live forks" or the failure reason.
- Tests: test_graph_lifecycle_purge.py; a DeletedDataSources test.

**2B-6 Members UI (M)**
- Add a members section to BranchSettingsModal using versioning.py:1452-1491.
- Ship it only together with 2C-4. Building it on today's inverted semantics would mislead users.

### (c) Collaboration correctness: stop people overwriting each other

**2C-1 Private-draft owner enforcement (M; N17, pulled forward from R3)**
- `_require_edit` (service.py:4783-4785): a private draft is writable by its owner only (plus an explicit admin override).
- Call it from:
  - `_apply_ops_once`;
  - `_rebase_draft_once`;
  - `publish`, `abandon_draft`;
  - `open_draft_mr`, `merge_mr`.
- Change the inverted pin at test_versioning_shared.py:100-105 so it expects the refusal.
- Tests: new HTTP-level two-user tests. Bob is refused write, pull, publish and abandon on Alice's private draft with 403/404.

**2C-2 Private-draft read privacy (S/M; doc 13:636)**
- `ContextEngine.for_workspace` (context_engine.py:163-167) calls `_branch_readable` (service.py:4808-4819). Do the same in `/graph/neighbors`, merge-preview, view-changes, freshness and members.
- Tests: a viewer gets 404 on `/graph/nodes?branchId=<private>`.

**2C-3 Fork hardening (S; N3)**
- The fork route requires MANAGE (versioning.py:3085-3096).
- `dataSourceId` must be in the same workspace, unversioned and manageable, or the parameter is removed.
- Add a per-graph fork cap until E7 lands.
- Tests: extend test_versioning_fork.py.

**2C-4 Shared-draft semantics (M)**
- Implement the visibility table from plan:508-517 for the write path only:
  - shared drafts are writable by members, and by managers per policy;
  - `/graph/changes` calls `_require_edit`;
  - HTTP routes resolve `actor_groups`.
- Tests: test_versioning_shared.py at HTTP level.

**2C-5 Publish permission and approval staleness (M)**
- Check `workspace:datasource:publish` on publish, merge, revert and restore. It is seeded but checked nowhere today.
- Store `approved_head_commit_id` in `approve_pr`; `merge_mr` refuses when the head has moved (service.py:2443-2445). This is the R3 subset.
- Change the inverted pin in test_versioning_rebase.py:83-86.
- Full per-graph `review_required` stays in R4.
- Tests: test_versioning_pr_gate.py.

**2C-6 Canvas refresh after pull (S; pulled forward from E10/E1)**
- `usePullLatestDraft` calls `bumpMainEpoch` and invalidates canvas queries (useVersioning.ts:545-563).
- The rebase route bumps `CacheScope` (versioning.py:1721-1741).
- Tests: a hook test; an API test that the cache generation bumps.

**2C-7 Sweep predicate (S)**
- `sweep_idle_drafts` (service.py:1626-1646) skips drafts that have an open PR, are `publishing`, have staged work, or belong to a tombstoned graph.
- Tests: extend test_versioning_draft_sweep.py.

### (d) Missing lifecycle operations

**2D-1 Move data source carries its graph (S/M; LIFECYCLE-12, pulled forward from doc 14)**
- `move_data_source` (workspaces.py:814) updates `GraphORM.workspace_id` (including forks) through a new service method, under the graph lock, returning 409 when a job is active.
- Tests:
  - add graphver cases to tests/test_data_source_move.py: history reachable in the new workspace and 404 in the old;
  - delete tombstones; impact shows versioned.

**2D-2 Fork delete and purge (M; N6)**
- `DELETE /graphs/{forkId}` tombstones the fork, and the purge worker drops its owned key.
- The reaper walks fork graphs (purge_worker.py:629-636).
- Parent purge ignores tombstoned forks.
- Show forks in 2A-5 and on the parent's hub card.
- Tests: test_graph_lifecycle_purge.py with fork cases.

**2D-3 Move a graph to another provider or key, "reseed move" without blue/green (L; N2)**
- `POST /graphs/{gid}/projection/move {providerId, key?}`:
  - claim the target with `_claim_projection_key`;
  - set the pin, bump the epoch and set `projected=0`;
  - reads fall back to Postgres until caught up;
  - then drop the old key only if it is owned.
- `projection_state` must become authoritative. `ensure_projection_target` (service.py:2594-2622; projection_target.py:203-222) currently repins any graph whose key differs from `ds.graph_name`; restrict that to `gv_` healing.
- Design it as the first phase of doc 14 L2 KeyMigration and record `shard_map`.
- Admin UI: a move dialog on the inventory row.
- Tests:
  - integration with test_versioning_projection_provider_routing.py: move from provider A to B, reads stay correct, old owned key dropped, customer key untouched;
  - a regression that the auto-repin no longer reverts the pin.

**2D-4 Per-graph freeze plus minimal lifecycle state (M/L)**
- Add a `lifecycle_state` column (live / frozen / trashed / purging) with CAS, read by the write prologue. This is a subset of doc 14 L0/L1.
- Freeze and unfreeze routes and UI.
- Tests: frozen graph refuses saves, publish and import with 409; reads still work.

### Suggested order and effort

| Order | Items |
|---|---|
| 1 | Prerequisite (merge W, C34–C37, C99) |
| 2 | 2C-1, 2C-2, 2C-3, 2D-1: blocker-class, about 1.5 weeks |
| 3 | 2A-1, 2A-2, 2A-3, 2A-4, 2B-1 |
| 4 | 2A-5, 2A-7, 2A-8 |
| 5 | 2B-2, 2B-3, 2B-4, 2C-5, 2C-6, 2C-7, 2B-5 |
| 6 | 2A-6, 2C-4 with 2B-6, 2D-2 |
| 7 | 2D-3, 2D-4 |

**Proof for Stage 2 as a whole:**
- one multi-user HTTP story test. Alice and Bob each own a draft. Bob is refused on Alice's private draft. They co-edit a shared draft, pull with a conflict, review with an assigned reviewer, the approval goes stale after an edit, then merge. Then check history, the watermark key and placement.
- add the test to versioning-e2e, now required.

---

## 5. What remains after Stage 2, before go-live

**Go-live blockers:**
- INGEST S0 bounded merge for rebase, previews, MR open and PR diffs (service.py:1433, 1657, 2281, 2315). Without it, many publishers on one graph livelock.
- E4 OCC everywhere (version tokens on FalkorDB-served reads, creates and deletes).
- E1 honest merges (expected head on rebase, publish and merge; cascade and structure conflicts).
- TESTS-4 concurrent save, pull and publish load test at hundreds of users on one graph.
- E9 metrics, alerts and worker roles.
- E8 branch-scoped cache generations.
- E7 eviction done right, if eviction is enabled at all: bytes, `last_read_at`, the "evicted stays evicted" churn fix, rehydrate, fork quota.

**ACCESS:**
- R2–R4 remainder: review records, request changes and comments, per-graph `review_required` and protected main, draft reopen, abandon closing its PR, editor role instead of `datasource:manage` for everyone.

**CONVERSION:**
- L2–L4: blue/green KeyMigration including node relocate, lossless convert with a `gvp_` owned key, cutover and rollback, Adopt, preflight with a capacity check, detach (T10/T11), history backup and restore, the full lifecycle_events timeline, liveness and parity state.

**INGEST:**
- S1–S4: drift scan and re-sync as a worker job with UI, and retention or compaction (S4).

**Other plan items:**
- E2 history attribution, E3 draft read semantics, E5 import OCC, E10 UX (main-head watch, error states).

**Unplanned, still open after Stage 2:**
- N12 orphaned graphs list;
- N13 branch GC;
- N14 workspace drafts view and presence;
- N18 budget UI;
- N19 MERGE-11, field-level revert, restore expected head;
- N20 bootstrap panel actions;
- node-scoped watermark reset;
- aggregation rollup jobs as a second FalkorDB writer on customer keys (until doc 14 D1.4 / `gvp_`).

**Explicitly out of scope:**
- projecting versioned graphs into Neo4j, Spanner or DataHub (doc 14:71). Stage 2 only adds the guard (N10).

### Critical Files for Implementation
- /home/user/dataviz/backend/app/api/v1/endpoints/versioning.py
- /home/user/dataviz/backend/app/services/versioning/service.py
- /home/user/dataviz/backend/app/api/v1/endpoints/versioning_admin.py
- /home/user/dataviz/backend/app/services/graph_store/topology.py
- /home/user/dataviz/frontend/src/features/versioning/components/DataSourceVersioningTab.tsx
