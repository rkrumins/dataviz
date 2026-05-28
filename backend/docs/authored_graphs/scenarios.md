# Scenarios — Day-0 and Day-N walkthroughs

Every Day-0 and Day-N flow as an end-to-end walkthrough. For each
scenario:

1. **What the user does** — one paragraph of intent.
2. **Endpoint sequence** — every HTTP call (+ payload shape) the
   client makes, in order, including SSE events received.
3. **Backend code flow** — service → repo → DB writes, one line per
   hop, with `file:line` citations.
4. **Audit footprint** — exactly which rows are written.
5. **Edge cases** — RBAC, 409, 422, concurrency.

Pairs with [`architecture.md`](./architecture.md) (why) and
[`api-reference.md`](./api-reference.md) (what).

---

## Day-0 scenarios

### D0-a — Create a blank authored graph; first commit on `main`

**User does**: opens the workspace launcher, clicks "New graph",
picks "blank canvas", names it "Lineage v2", clicks Create. The
canvas opens empty. They drag two nodes + a connecting edge, click
"Commit changes", type a message, confirm.

**Endpoint sequence**:

```
1. POST /api/v1/{ws}/graphs                                        ───┐
   body: {name: "Lineage v2", schema_mode: "schemaless",             │
          origin: "authored"}                                         │  Day-0
   → 201 GraphResponse {id: "g_abc", default_branch: "main",         │  graph
                       head_commit_id: null}                          │  create
                                                                      ┘

2. POST /api/v1/views                                              ───┐
   body: {name: "Lineage v2 — default", workspaceId: "ws_x",         │
          sourceGraphId: "g_abc",                                     │  bound view
          branchingPolicy: "per_view",                                │  create
          mergeTargetBranch: "main"}                                  │  (atomic w/
   → 201 ViewResponse {id: "view_xyz", sourceBranch: "view/view_xyz"}│  ensure_branch)
                                                                      ┘

3. GET /api/v1/{ws}/graphs/g_abc/refs/view/view_xyz/snapshot       ───┐
   → 200 {nodes: [], edges: [], commit_id: null, root_hash: null,    │  open canvas
          composed: false}                                            ┘

4. POST /api/v1/{ws}/graphs/g_abc/branches/view/view_xyz/stage     ───┐
   body: {changes: [                                                  │
     {change_type: "add_node", object_kind: "node",                   │
      object_id: "u:n1", payload: {entity_type: "Dataset",            │
                                   display_name: "Orders",            │
                                   position: {x:100,y:100}}},         │
     {change_type: "add_node", object_kind: "node",                   │
      object_id: "u:n2", payload: {…}},                               │
     {change_type: "add_edge", object_kind: "edge",                   │  user
      object_id: "e1", payload: {source_urn:"u:n1",                   │  edits
                                  target_urn:"u:n2",                   │
                                  edge_type:"flows_to"}}              │
   ]}                                                                  │
   → 200 {ws_change_version: 1, op_count: 3}                          │
                                                                       │
   (SSE: visualization.working_set.advanced — same user only)         ┘

5. POST /api/v1/{ws}/graphs/g_abc/branches/view/view_xyz/commits   ───┐
   body: {message: "Initial lineage",                                  │
          expected_head_commit_id: null,                               │  first
          view_id: "view_xyz"}                                         │  commit
   → 200 CommitResponse {commit_id: "gcmt_1", commit_hash: "...",     │  (genesis)
                         root_hash: "...",                             │
                         delta_summary: {nodes_added: 2, edges_added: 1}}
                                                                       │
   (SSE: visualization.graph.committed — broadcast to all subs)       ┘
```

**Backend code flow**:

1. `POST /graphs` → `endpoints/graphs.py::create_graph` →
   `GraphAuthoringEngine.create_graph` →
   `graph_repo.create_graph` writes `user_graphs` row + empty `main`
   `GraphRefORM` with `commit_id=null, revision=0`. `body.origin='authored'`
   skips the source-sync branch. The endpoint then emits
   `visualization.user_graph.created` to the Graph Store outbox
   atomically with the insert; the `authored_data_source_relay`
   lifespan task (consumer group `authored_ds_relay_v1` on
   `graph.outbox`) drains it and inserts a corresponding
   `workspace_data_sources` row (`provider_id=prov_sys_authored_falkor`,
   `graph_name=authored_g_abc`, `aggregation_status=pending`) so the
   new graph shows up in the catalog and routes through the standard
   `ContextEngine.for_workspace(ws_id, data_source_id=)` read path.
   The first commit's projector flush then emits
   `visualization.graph.materialized`, which the same relay turns
   into a `aggregation_status='ready'` tick.
2. `POST /views` → `endpoints/views.py::create_view` →
   `view_repo.create_view` writes `ViewORM` with the binding columns.
   When `source_graph_id` is set, the endpoint loads the freshly-
   created row and calls
   `view_binding_service.ensure_branch(graph_store_session, view=row,
   user_id=alice)`. The service resolves the branch (`"view/view_xyz"`
   for `per_view`), sees no `GraphRefORM` exists, calls
   `graph_repo.create_branch(name="view/view_xyz",
   from_commit_id=null)`. View's `source_branch` is updated.
3. `GET /snapshot` → `endpoints/graphs.py::get_snapshot` →
   `graph_repo.get_branch_ref_or_none("view/view_xyz")` → fast path
   resolves ref. `commit_id=null` → `load_graph_state` returns
   empty maps. `graph.origin='authored'` → composed=false →
   plain enrichment-only output (empty arrays).
4. `POST /stage` → `GraphAuthoringEngine.stage` →
   `ws_repo.get_or_open(graph_id, branch, user_id=alice)` creates
   `GraphWorkingSetORM(status=open)`. For each change:
   `coalesce_decision` → new row → `session.add(GraphWorkingChangeORM)`.
   `working_set.ws_change_version += 1`. Outbox emits
   `visualization.working_set.advanced` with `user_id=alice` so only
   Alice's tabs refetch.
5. `POST /commits` → `endpoints/graphs.py` body has `view_id` →
   loads `ViewORM`, validates `source_graph_id == "g_abc"`,
   `assert_branch_matches_view(view, user_id=alice,
   branch="view/view_xyz")` confirms the URL branch matches the
   policy. Calls
   `GraphAuthoringEngine.commit(view_id="view_xyz", actor=alice)` →
   `apply_changes` projects the working set onto base snapshot
   (empty, since `commit_id=null`) → `plan_commit(base_snapshot=null,
   nodes={u:n1, u:n2}, edges={e1})` builds the genesis manifest →
   `persist_commit(view_id="view_xyz")` dedup-inserts blobs,
   manifests, the commit row (`parent_ids=[]`), advances the ref via
   CAS (revision 0 → 1), writes three `GraphChangeEventORM` rows
   each with `view_id="view_xyz"`, `actor="alice"`, emits the
   `visualization.graph.committed` outbox event.

**Audit footprint** (after step 5):

| Row | Why |
|---|---|
| `graph_change_event` × 3 (u:n1, u:n2, e1; action=created) | one per object the genesis commit added; each carries view_id |
| `graph_commits` × 1 (parent_ids=[]) | the genesis commit |
| `graph_node_versions` × 2 + `graph_edge_versions` × 1 | the content blobs |
| `graph_partition_manifest` × N (one per non-empty partition + root) | the Merkle manifest |
| `graph_outbox_events` × 1 (`graph.committed`) | for SSE fan-out |

**Edge cases**:
- If `body.schema_mode='strict'` and `body.ontology_id` is missing
  → step 1 returns `422 ontology_required`.
- If the user skips step 2 (no view): they can still commit via
  `POST /branches/main/commits` directly, omitting `view_id`. The
  audit rows then have `view_id=null` (direct main commits).
- If two tabs both hit step 4 simultaneously: the
  `UNIQUE(graph_id, branch, user_id)` constraint serialises them;
  one wins, the other retries on the existing row.

---

### D0-b — Create a connected graph; auto-import genesis from DataHub

**User does**: opens the launcher, picks "From data source",
selects "DataHub-prod" from the dropdown. Names the graph "DataHub
lineage". Clicks Create. The canvas shows a "Importing 1,247 nodes
from DataHub..." progress, then opens with the data.

**Endpoint sequence**:

```
1. POST /api/v1/{ws}/graphs                                        ───┐
   body: {name: "DataHub lineage", schema_mode: "schemaless",        │
          origin: "connected",                                        │  create
          source_data_source_id: "wds_datahub_prod"}                  │  + inline
   → 201 GraphResponse {id: "g_dh", default_branch: "main",          │  sync
                       head_commit_id: null,                          │
                       initial_source_snapshot: {                     │
                         id: "gss_1", status: "completed",            │
                         added_count: 1247,                           │
                         modified_count: 0, removed_count: 0}}        ┘

2. POST /api/v1/views                                              ───┐
   body: {…, sourceGraphId: "g_dh", branchingPolicy: "per_view"}    │  bound
   → 201 ViewResponse                                                 ┘  view

3. GET /api/v1/{ws}/graphs/g_dh/refs/view/<id>/snapshot            ───┐
   (composed=true by default for connected)                          │
   → 200 {nodes: [1247 nodes with origin: "source"],                 │
          edges: [...], composed: true,                              │  composed
          composition_diagnostics: {                                  │  read
            nodes_suppressed_by_enrichment: 0, ...}}                  ┘
```

**Backend code flow** (step 1, the interesting part):

1. `endpoints/graphs.py::create_graph` validates ontology (none for
   schemaless), calls `GraphAuthoringEngine.create_graph` → `user_graphs`
   row with `origin='connected', source_data_source_id='wds_datahub_prod'`.
2. Endpoint sees `origin == 'connected' and source_data_source_id` →
   calls
   `graph_source_sync_service.sync_data_source(graph_id="g_dh",
   workspace_id=ws_id, source_data_source_id="wds_datahub_prod",
   triggered_by=alice, mgmt_session=mgmt_session)`.
3. `sync_data_source` calls
   `provider_registry.get_provider_for_workspace(workspace_id,
   mgmt_session, data_source_id)` → instantiates
   `DataHubGraphQLProvider` (cached, circuit-breaker-wrapped).
4. Pages through `provider.get_nodes(NodeQuery(offset=k, limit=500))`
   until empty → buffers `SourceNodeInput`s.
5. Same for `provider.get_edges`.
6. Calls `run_inline_sync` → `graph_source_repo.start_snapshot`
   writes a `running` row → `apply_source_diff` content-hashes every
   incoming entity, upserts via `INSERT...ON CONFLICT(graph_id,urn)
   DO UPDATE`, tags `last_sync_run_id=gss_1`, sweep-deletes rows
   from prior runs (none on first sync) → `finish_snapshot(status=
   completed, result=ApplyResult(added=1247, ...))` → outbox
   `visualization.graph.source_refreshed`.
7. Endpoint returns the `GraphResponse` with
   `initial_source_snapshot` populated.

**Audit footprint**:

| Row | Why |
|---|---|
| `graph_source_snapshots` × 1 (status=completed, counts) | the run record |
| `graph_source_nodes` × 1247 (all added this run) | source layer |
| `graph_source_edges` × N | source layer |
| `graph_orphan_enrichments` × 0 | no enrichments to orphan on first sync |
| `graph_outbox_events` × 1 (`source_refreshed`) | for SSE fan-out |
| **zero** `graph_change_event` rows | source layer keeps its own audit (snapshots), enrichment layer is empty |

**Edge cases**:
- Provider instantiation times out (10s registry deadline) →
  `ProviderResolveError` → endpoint catches → graph created,
  `initial_source_snapshot` omitted → canvas can call
  `POST /source/refresh` to retry.
- Provider returns an error mid-stream → `run_inline_sync` catches
  → `finish_snapshot(status=failed, error_message=...)` → outbox
  `source_failed` → exception re-raised → 5xx to client (graph
  still created, snapshot row carries the failure).

---

### D0-c — Open existing view; first edit creates the per-view branch

**User does**: returns to the workspace; opens the existing
"Lineage v2" view they created earlier (per_view policy). Today the
view's `source_branch` is `view/view_xyz`. Drags a node, clicks
Save.

**Endpoint sequence**:

```
1. GET /api/v1/views/view_xyz
   → 200 ViewResponse {sourceBranch: "view/view_xyz", …}

2. POST /api/v1/views/view_xyz/enter-edit
   → 200 {branch: "view/view_xyz", created_branch: false, …}
   (idempotent — branch already exists from D0-a step 2)

3. GET /api/v1/{ws}/graphs/g_abc/refs/view/view_xyz/snapshot
   → 200 {…, commit_id: "gcmt_1"}

4. POST /api/v1/{ws}/graphs/g_abc/branches/view/view_xyz/stage
5. POST /api/v1/{ws}/graphs/g_abc/branches/view/view_xyz/commits
   body: {expected_head_commit_id: "gcmt_1", view_id: "view_xyz", …}
   → 200 CommitResponse {commit_id: "gcmt_2"}
```

`enter-edit` is the safety net — even if the view was created
without `sourceGraphId` (legacy / late binding), this call
materialises the branch on demand. For views created via D0-a's
atomic flow it's just an idempotent verify.

---

## Day-N scenarios

### DN-a — Single user edits `main` directly

**User does**: opens an authored graph on `main` (no view binding;
power-user mode). Edits, commits, repeats.

**Endpoint sequence**: identical to D0-a steps 4-5, but the URL
branch is `main` and `view_id` is omitted in the commit body.

**Audit footprint**: `graph_change_event` rows with `view_id=NULL`
and `branch="main"`. Per-source audit (`GET /audit`) and
per-branch audit (`?branch=main`) both surface these; per-view audit
(`?view_id=…`) ignores them.

**Why this works**: `view_id` is nullable on `graph_change_event`;
the commit endpoint only enforces view-graph consistency when
`view_id` is present. Power users get the historic "Git on main"
experience without coercing them into a view.

---

### DN-b — Two users commit to `main` concurrently

**User does**: alice opens main, edits 5 nodes, commits. Meanwhile
bob has main open and is editing different nodes; he tries to commit
right after.

**Endpoint sequence (bob's perspective)**:

```
1. POST /commits {expected_head_commit_id: "gcmt_5", …}
   ↓ alice's commit landed first, advancing to gcmt_6
2. ← 409 {code: "head_moved"}
3. GET /branches/main/commits?limit=10
   → reads alice's gcmt_6
4. GET /refs/main/snapshot → fresh state
5. (client rebases his uncommitted ops onto the new base; for each
   op the base_content_hash either still matches or the op is
   highlighted for the user to reconcile)
6. POST /commits {expected_head_commit_id: "gcmt_6", …}
   → 200 gcmt_7
```

**Backend code flow** (step 2 → 409):

- `persist_commit` reads `graph_refs.commit_id` for `(graph_id, main)`
  with row lock → finds `commit_id="gcmt_6"`, but
  `expected_head_commit_id="gcmt_5"` → raises `HeadMovedError(ref.commit_id)`.
- Endpoint catches → `409 {code: "head_moved"}`.

For step 6: bob's ops carry `base_content_hash` from the freshly-
read snapshot. If alice and bob edited the same field on the same
object, bob's op's `base_content_hash` no longer matches the live
`new_content_hash` after alice's commit → `apply_changes` raises
`WorkingSetError` → endpoint returns `422 {code: "working_set_invalid",
detail: {field: ..., expected: ..., actual: ...}}`. Bob's UI
prompts him to reconcile field-by-field.

**Audit footprint**: alice's commit writes its own `graph_change_event`
rows + an outbox event; bob's failed first attempt writes nothing.
Bob's second commit (after rebase) writes its own rows.

**SSE**: alice's `graph.committed` event arrives at bob's tab via
SSE between steps 1 and 6, so the client can auto-trigger the
rebase prompt instead of waiting for the 409.

---

### DN-c — View per_view shared editing (two users, one view)

**User does**: alice and bob both have access to view "Q4 lineage"
(per_view policy → branch `view/q4`). Alice edits + commits; bob
sees alice's commit and continues editing in the same view.

**Endpoint sequence (bob's first save after alice)**:

```
1. (SSE: visualization.graph.committed {branch: "view/q4",
                                         commit_id: "gcmt_a"})
2. GET /refs/view/q4/snapshot → fresh state
3. POST /branches/view/q4/stage  …  [bob's edits]
4. POST /branches/view/q4/commits
   body: {expected_head_commit_id: "gcmt_a", view_id: "view_q4"}
   → 200 gcmt_b
```

**Audit footprint**: every commit on `view/q4` carries
`view_id="view_q4"`. `GET /audit?view_id=view_q4` returns both
alice's and bob's commits — per-view audit naturally aggregates
across users when the policy is `per_view`. `GET /audit` (per-source)
returns the same rows plus any direct-main commits.

**Why this works**: `per_view` is "shared editing on a per-view
branch" — same Git semantics as multiple committers on `main`, but
scoped to the view's branch. The branch is the unit of isolation,
not the user.

---

### DN-d — View per_user_per_view isolated editing

**User does**: alice and bob both editing view "Q4 critical"
(per_user_per_view policy). Each gets their own branch:
`user/alice/view/q4_critical`, `user/bob/view/q4_critical`. They
edit in parallel without seeing each other's uncommitted work.

**Endpoint sequence**: same as DN-c except `enter-edit` returns a
different branch per user. Commits land on the user-specific branch.

**Audit footprint**: alice's commits carry `view_id="view_q4_critical"`,
`branch="user/alice/view/q4_critical"`; bob's carry the same
view_id, different branch. `GET /audit?view_id=view_q4_critical`
returns both. `GET /audit?branch=user/alice/view/q4_critical`
returns alice's only.

**Publish flow** (next round; not yet wired): each user raises a PR
from their isolated branch to `main`. Until PR endpoints land, the
isolated branches are dead-ends — useful for exploration, not yet
for delivery.

---

### DN-e — Different views on the same data source, parallel edits

**User does**: alice opens view A (binds branch `view/A`); bob
opens view B (binds branch `view/B`). Both views point at graph
`g_xyz`. Both users edit + commit.

**Endpoint sequence**: each user's stage+commit lands on their
view's branch. Two independent commit streams; no interference.

**Audit footprint**:

```
GET /audit?graph_id=g_xyz
  → returns events from view/A AND view/B (per-source aggregation)

GET /audit?graph_id=g_xyz&view_id=view_A
  → returns events from view/A only (uses idx_gce_view)

GET /audit?graph_id=g_xyz&branch=view/B
  → returns events from view/B only (uses idx_gce_branch)
```

**Why this works**: the per-view audit dimension. Decision 19 from
the plan — every audit row carries `view_id`; per-view audit is an
indexed lookup, not a branch→view JOIN. Same source-of-truth data,
but distinct views with distinct edit history.

---

### DN-f — Gitflow feature branch + merge back to main

**User does**: from any view, alice creates a `feature/etl-cleanup`
branch off `main`. She edits + commits a few times. When done, she
clicks "Merge to main".

**Endpoint sequence**:

```
1. POST /api/v1/{ws}/graphs/g_xyz/branches
   body: {name: "feature/etl-cleanup", from_commit_id: "gcmt_main"}
   → 201 {branch: "feature/etl-cleanup", commit_id: "gcmt_main"}

2-N. POST /stage + POST /commits on feature/etl-cleanup
     (commits gcmt_f1, gcmt_f2, gcmt_f3)

N+1. POST /branches/feature/etl-cleanup/merge-into/main
     body: {message: "Merge ETL cleanup", auto_commit_if_clean: true}
     → 200 MergePlan {status: "committed",
                      is_mergeable: true,
                      conflicts: [], integrity_violations: [],
                      result_commit_id: "gcmt_merge"}

N+2. (SSE: visualization.graph.merged + visualization.graph.committed)
```

**Backend code flow** (step N+1):

1. `endpoints/graphs.py::merge_branch_into` calls
   `graph_merge_service.plan_merge(graph_id="g_xyz",
   source_branch="feature/etl-cleanup", target_branch="main",
   auto_commit_if_clean=true)`.
2. `plan_merge`:
   - Resolve `target_ref` (`main → gcmt_main2`, since main may have
     advanced) + `source_ref` (`feature → gcmt_f3`).
   - `find_merge_base(head_a=gcmt_main2, head_b=gcmt_f3)` →
     bidirectional BFS over `graph_commits.parent_ids` → returns
     `gcmt_main` (the original fork point).
   - Load three snapshots: base=gcmt_main, ours=gcmt_main2,
     theirs=gcmt_f3.
   - `three_way_merge(base, ours, theirs)` → outcome with
     `auto: EntryMap`, `conflicts=()`.
   - `run_post_merge_checks` builds edge-endpoint resolver, runs
     `check_referential_integrity` → no violations.
   - `outcome.is_mergeable=true` AND `auto_commit_if_clean=true` →
     calls `_persist_merge_commit`.
   - `_persist_merge_commit`:
     - `materialize_entries(merged_entries)` fetches blobs by hash,
       builds `NodeState`/`EdgeState` maps.
     - `plan_commit(base_snapshot=ours_snap, nodes, edges,
       schema_mode='schemaless', ontology=None)` — schemaless is
       deliberate: every blob was previously validated on its own
       branch; re-running strict validation on the merged result
       would reject combinations valid on each side.
     - `persist_commit(extra_parent_ids=[gcmt_f3],
       merge_base_id=gcmt_main, expected_head_commit_id=gcmt_main2)`
       writes the merge commit with two parents, advances main's
       ref via CAS, writes `graph_change_event` rows for each
       changed object (view_id=null, pr_id=null), emits
       `visualization.graph.committed`.
   - Updates `GraphMergeORM.status='committed',
     result_commit_id=gcmt_merge`, emits
     `visualization.graph.merged`.

**Audit footprint**:

| Row | Why |
|---|---|
| `graph_merge` × 1 (status=committed) | the merge attempt record |
| `graph_merge_conflict` × 0 | clean merge |
| `graph_commits` × 1 (parent_ids=[main, feature]) | the merge commit |
| `graph_change_event` × K (one per changed object in the merge) | enrichment audit; actor=alice, view_id=null |
| `graph_outbox_events` × 2 (`graph.committed` + `graph.merged`) | SSE fan-out |

**Conflict path** (if alice + main edited the same field on the
same object):

```
N+1. POST /merge-into/main
     → 200 MergePlan {status: "open",
                      is_mergeable: false,
                      conflicts: [{key:"u:n7", kind:"node",
                                    conflict_class:"modify_modify",
                                    base_content_hash:"h_base",
                                    source_content_hash:"h_feature",
                                    target_content_hash:"h_main"}],
                      integrity_violations: [],
                      result_commit_id: null}

N+2. (user opens conflict UI; picks "theirs" for u:n7)

N+3. POST /merges/{merge_id}/resolve
     body: {resolutions: {"u:n7": {kind:"node", content_hash:"h_feature"}},
            message: "..."}
     → 200 MergePlan {status: "committed", result_commit_id: "gcmt_merge"}
```

Re-runs three-way from scratch (catches base advance), applies
resolutions, re-checks integrity, commits. If main has advanced
between N+1 and N+3, the merge plan is re-derived against the new
heads — if a new conflict surface emerges, the resolve call still
proceeds when the user's prior resolutions still apply; if integrity
violations appear (e.g. the user's resolution introduces a dangling
edge), returns `422 merge_not_resolvable`.

---

### DN-g — Branch list + delete

**User does**: opens a graph admin panel, lists branches, deletes
an abandoned feature branch.

**Endpoint sequence**:

```
1. GET /api/v1/{ws}/graphs/g_xyz/branches
   → 200 {branches: [
       {name: "main",                  commit_id: "gcmt_5", revision: 5, ...},
       {name: "view/view_a",           commit_id: "gcmt_3", revision: 3, ...},
       {name: "feature/abandoned",     commit_id: "gcmt_4", revision: 1, ...},
     ]}

2. DELETE /api/v1/{ws}/graphs/g_xyz/branches/feature/abandoned
   → 204 (no body)
   (SSE: visualization.branch.deleted)
```

**Backend code flow** (step 2):

1. Endpoint queries the **management DB** for views still pinning
   `source_branch="feature/abandoned"` → returns `[]`.
2. Calls `graph_repo.delete_branch(branch="feature/abandoned",
   bound_view_ids=[])`.
3. Repo loads graph, checks `branch != default_branch` ✓; queries
   `graph_working_set` for any open working sets on this branch →
   empty; checks `bound_view_ids=[]` ✓.
4. `session.delete(ref)`.
5. Endpoint emits `visualization.branch.deleted` outbox.

**Guard failure example** (DN-g-fail):

```
2. DELETE /branches/view/view_a
   → 409 {code: "views_bound", branch: "view/view_a",
          view_ids: ["view_a"]}
```

The UI surfaces "1 view is still bound to this branch; delete or
unbind the view first."

---

### DN-h — Mode-2 source refresh

**User does**: opens a connected graph; sees a "Last synced 2 days
ago" banner; clicks Refresh.

**Endpoint sequence**:

```
1. POST /api/v1/{ws}/graphs/g_dh/source/refresh
   → 200 SourceSnapshot {id: "gss_2", status: "completed",
                         added_count: 12, modified_count: 5,
                         removed_count: 2, orphan_count: 1, ...}

2. (SSE: visualization.graph.source_refreshed)

3. GET /api/v1/{ws}/graphs/g_dh/refs/main/snapshot?composed=true
   → 200 {…, composition_diagnostics: {
            nodes_suppressed_by_enrichment: 0,
            edges_suppressed_by_enrichment: 0,
            edges_dropped_dangling: 1,        ← upstream lineage broken
            edges_dropped_endpoint_suppressed: 0}}

4. GET /api/v1/{ws}/graphs/g_dh/orphans
   → 200 {orphans: [
       {urn: "u:DELETED_TABLE", object_kind: "node",
        sync_run_id: "gss_2", discovered_at: "..."}]}
```

**Backend code flow** (step 1):

1. `endpoints/graphs.py::refresh_source` loads graph, validates
   `origin in ('connected','fork')`, calls
   `graph_source_sync_service.sync_data_source` (the
   provider-backed path).
2. Same as D0-b steps 3-6 but the second-run path:
   `apply_source_diff` finds existing rows for some URNs, compares
   content_hashes, classifies modified vs unchanged. The sweep at
   the end deletes 2 rows whose `last_sync_run_id != "gss_2"`
   (URNs that vanished upstream).
3. `sync_from_inputs` scans `graph_node_versions` for distinct
   `node_key` values — any that aren't in `incoming_urns` become
   orphans. `record_orphans` inserts the `graph_orphan_enrichments`
   rows.
4. `finish_snapshot(status=completed, result=ApplyResult(added=12,
   modified=5, removed=2, root_hash=...), orphan_count=1)`.
5. Outbox `source_refreshed`.

**Audit footprint**:

| Row | Why |
|---|---|
| `graph_source_snapshots` × 1 (status=completed) | the run record |
| `graph_source_nodes` × 12 added + 5 updated, 2 deleted by sweep | source state |
| `graph_source_edges` × similar diffs | source state |
| `graph_orphan_enrichments` × 1 | the user's annotation on `u:DELETED_TABLE` is now stranded |
| `graph_outbox_events` × 1 (`source_refreshed`) | SSE |
| **zero** `graph_change_event` rows | source layer audit ≠ enrichment audit |

**Failure path**:

```
1. POST /source/refresh
   ← 5xx — provider unreachable mid-stream
   (DB has: gss_2 status=failed, error_message="...")
   (SSE: visualization.graph.source_failed)

2. GET /source/snapshots → shows gss_2 as failed
3. (user retries)
```

---

### DN-i — Composed read with enrichments overriding source

**User does**: on a connected graph, alice renames a node ("Orders"
in DataHub → "Customer Orders" curated by alice). Then re-syncs
the source.

**Endpoint sequence**: standard commit (DN-a flow) followed by a
source refresh (DN-h).

**Composition outcome** at next `GET /snapshot?composed=true`:

```json
{
  "nodes": [
    {
      "key": "u:n1",
      "display_name": "Customer Orders",   ← alice's enrichment
      "entity_type": "Dataset",            ← source's value (alice didn't touch)
      "properties": {
        "owner": "data-team",              ← merged
        "rows": 10000,                      ← from refreshed source
        "curated_by": "alice"               ← from alice's enrichment
      },
      "tags": ["pii", "customer"],         ← union (pii from source, customer from alice)
      "origin": "hybrid"
    }
  ]
}
```

**Why this works**: composition rule `both present + enrichment not
deleted → hybrid` (architecture.md "Composition rules"). The
enrichment-layer commit is unaffected by source refresh; the
composition function merges them deterministically at read time.

**Blame on a hybrid node**:

```
GET /graphs/g_dh/objects/u:n1/blame
  → returns alice's enrichment commit events (display_name change,
    curated_by add)
GET /graphs/g_dh/source/snapshots
  → returns each refresh run; user infers source-side changes from
    counts + (optionally) a Phase 2.5 blended-audit endpoint
```

The split is intentional: enrichment audit is precise (per-attribute,
per-object); source audit is coarse (per-refresh). The Phase 2.5
blended audit unions them with each side's grain preserved.

---

### DN-j — View opened, branch absent → ensure_branch fast path

**User does**: opens a view that hasn't been edited since its
creation (binding was via `enter-edit` at create time).

**Endpoint sequence**:

```
1. POST /api/v1/views/view_xyz/enter-edit
   → 200 {branch: "view/view_xyz", created_branch: false, ...}

2. GET /refs/view/view_xyz/snapshot → opens canvas
```

`ensure_branch` finds the ref already exists → fast path, no DB
writes beyond the read. `created_branch: false` tells the client
nothing changed.

**If the view's branch was somehow deleted out-of-band**:

```
1. POST /enter-edit
   → ensure_branch sees missing ref → forks from main → returns
   → 200 {branch: "view/view_xyz", created_branch: true, ...}
```

The view-binding service is the durable contract; the branch ref
is rebuildable.

---

### DN-k — Power user creates a feature branch outside any view

**User does**: opens a graph admin panel, creates a
`feature/experiment` branch off main, edits + commits directly via
the API (no view context).

**Endpoint sequence**:

```
1. POST /branches body: {name: "feature/experiment",
                         from_commit_id: "gcmt_main_head"}
   → 201

2. POST /branches/feature/experiment/stage   [edits]
3. POST /branches/feature/experiment/commits
   body: {message: "...", expected_head_commit_id: "gcmt_main_head"}
        (no view_id)
   → 200 gcmt_x
```

**Audit footprint**: `graph_change_event` rows carry `view_id=NULL`,
`branch="feature/experiment"`, `actor="alice"`. The branch is
visible via `GET /branches` and editable by any user with
`workspace:graph:edit`. Merge back via DN-f.

---

### DN-l — Direct main commit blocked by SSE notification of concurrent edits

**User does**: alice on main, types a change, but before clicking
Commit she sees a "Bob committed 3 changes — refresh?" toast (from
SSE). She clicks Refresh, her stage is recomputed against the new
base, then she commits.

**Why this matters**: the SSE `graph.committed` event lets the
client UI catch concurrency *before* the user hits 409. The 409
path (DN-b) is the safety net; the SSE path is the smooth path.

The backend doesn't differentiate — same code on both. The UX
difference is purely client-side.

---

### DN-m — Shared-branch pull/commit cycle (V1-6)

**User does**: alice and bob both have `main` open via the
graph admin canvas (no view). Alice stages two edits and commits.
Bob — who has his own working set on `main` with one staged edit
that touches the same node alice touched, plus a clean add — sees
a "Pull required" banner via SSE, clicks Pull, sees one conflict
in the resolver, picks "ours", re-commits. The end-state is a
linear trunk with alice's commit then bob's commit; both authors
preserved in `/blame`.

**Endpoint sequence**:

```
─── alice's tab ────────────────────────────────────────────
1. POST /api/v1/{ws}/graphs/g_xyz/branches/main/stage      ───┐
   body: {changes: [                                          │
     {change_type: "update_node", object_id: "u:n1",          │  alice
      payload: {…, display_name: "Customers"},                │  edits
      base_content_hash: "h_n1_v0"},                          │  + commits
     {change_type: "update_node", object_id: "u:n2",          │
      payload: {…}, base_content_hash: "h_n2_v0"}             │
   ]}                                                          │
   → 200 {ws_change_version: 1}                               │
                                                               │
2. POST /api/v1/{ws}/graphs/g_xyz/branches/main/commits     │
   body: {message: "rename u:n1, retag u:n2",                 │
          expected_head_commit_id: "gcmt_A"}                  │
   → 200 {commit_id: "gcmt_B", commit_hash: "...",            │
          delta_summary: {nodes_modified: 2}}                 │
                                                               │
   (SSE: visualization.graph.committed fans out to bob's      │
    tab carrying {commit_id: "gcmt_B", branch: "main"})       ┘

─── bob's tab — working set already has 2 staged ops ──────
   bob's prior stage (BEFORE alice's commit):
     - update_node u:n1 base_content_hash="h_n1_v0"   ← SAME OBJECT
     - add_node    u:n9 base_content_hash=null         ← INDEPENDENT

3. (SSE: graph.committed {commit_id: "gcmt_B"} arrives → UI    ───┐
       shows "Pull required" banner — base differs from local    │
       graphEditorStore.baseCommitId="gcmt_A")                    │  bob
                                                                   │  pulls
4. POST /api/v1/{ws}/graphs/g_xyz/branches/main/working-set/pull   │
   (empty body — server reads bob's working set + current HEAD)    │
   → 200 PullResult {                                              │
       previous_base: "gcmt_A",                                    │
       new_base:      "gcmt_B",                                    │
       rebased:       1,                                           │
       dropped:       0,                                           │
       conflicts: [                                                │
         {object_kind: "node", object_id: "u:n1",                  │
          conflict_class: "edit_edit",                             │
          base_content_hash:    "h_n1_v0",                         │
          current_content_hash: "h_n1_v1",                         │
          staged_change_type: "update_node"}                       │
       ]                                                            │
     }                                                              ┘

5. (bob opens the resolver UI; the add_node u:n9 has already       ───┐
    re-anchored cleanly — base_content_hash refreshed silently.       │
    For u:n1 he picks "ours" — his display_name change wins.          │  bob
    Frontend dismissConflict("node","u:n1") → pendingConflicts        │  resolves
    empty → syncState returns to 'dirty'.)                            │  + commits

6. POST /api/v1/{ws}/graphs/g_xyz/branches/main/stage              │
   body: {changes: [{change_type: "update_node", object_id: "u:n1",│
                     payload: {…, display_name: "VIP Customers"},  │
                     base_content_hash: "h_n1_v1"}]}               │
   → 200 {ws_change_version: N+1}                                  │
                                                                    │
7. POST /api/v1/{ws}/graphs/g_xyz/branches/main/commits            │
   body: {message: "rename u:n1 + add u:n9",                       │
          expected_head_commit_id: "gcmt_B"}                       │
   → 200 {commit_id: "gcmt_C", delta_summary:                      │
          {nodes_added: 1, nodes_modified: 1}}                     ┘
```

**Backend code flow** (step 4 — the pull):

1. `endpoints/graphs.py::pull_working_set:384` validates graph +
   `workspace:graph:edit`, calls `get_branch_ref(graph_id,
   branch="main")` → ref points at `gcmt_B`.
2. `ws_repo.get_or_open(graph_id, branch="main",
   user_id=bob)` returns bob's open working set (base=`gcmt_A`).
3. `graph_repo.load_snapshot(graph_id, commit_id="gcmt_B")` →
   reads `graph_commits.root_manifest_hash` for B, materializes
   the Merkle snapshot via the existing
   `snapshot_reader.load_snapshot` path. Per-partition decode is
   the standard reader code; no V1-6-specific work here.
4. `graph_working_set_repo.rebase_against_snapshot:254` walks bob's
   working set:
   - For `u:n9` (add_node, `base_content_hash=null`): partition
     lookup → `partition_for("u:n9", partition_count)` → checks
     `snapshot.partitions[idx].entries` → key absent → matches
     the "create + remote-absent" branch → clean rebase,
     `rebased += 1`. No conflict.
   - For `u:n1` (update_node, `base_content_hash="h_n1_v0"`):
     partition lookup → entry present with `content_hash="h_n1_v1"`
     → staged base differs from current → conflict_class
     `"edit_edit"`. Op LEFT IN PLACE in
     `graph_working_change` row — `base_content_hash` is NOT
     refreshed so the resolver can show the user what changed.
5. `working_set.base_commit_id = "gcmt_B"`,
   `working_set.ws_change_version += 1`. Return.

**Audit footprint**:

| Row | Why |
|---|---|
| `graph_change_event` × 2 (alice's commit_id=gcmt_B; u:n1, u:n2) | alice's two edits |
| `graph_commits` × 1 (gcmt_B; parent_ids=[gcmt_A], single parent — linear trunk) | alice's commit |
| `graph_trunk_log` × 1 (commit_seq=N+1, committed_at=T_alice) | trunk index append on default branch |
| `graph_commit_contributors` × 1 (commit_id=gcmt_B, actor=alice, ops_count=2) | per-actor manifest for direct-main commit |
| `graph_outbox_events` × 1 (`graph.committed`) | SSE fan-out triggering bob's pull banner |
| (pull endpoint itself writes **no audit rows**) | pull is a per-user reconciliation, not a state change anyone else sees |
| `graph_change_event` × 2 (bob's commit_id=gcmt_C; u:n1 re-renamed, u:n9 added) | bob's second commit, after resolve |
| `graph_commits` × 1 (gcmt_C; parent_ids=[gcmt_B]) | bob's commit; trunk stays linear |
| `graph_trunk_log` × 1 (commit_seq=N+2) | second trunk row |
| `graph_commit_contributors` × 1 (commit_id=gcmt_C, actor=bob, ops_count=2) | bob's manifest |

**Blame after the cycle**:

```
GET /graphs/g_xyz/objects/u:n1/blame
  → returns the chain:
    [{actor: "bob",   commit_id: "gcmt_C", new_content_hash: "h_n1_v2"},
     {actor: "alice", commit_id: "gcmt_B", new_content_hash: "h_n1_v1"},
     {actor: "...",   commit_id: "gcmt_A", new_content_hash: "h_n1_v0"}]
```

Each user's own edit is preserved with their own actor; bob's
resolution did not "rewrite" alice's history.

**Edge cases**:

- Bob skips the pull and just commits → `persist_commit` reads
  the live ref (`gcmt_B`) but `expected_head_commit_id="gcmt_A"`
  → `HeadMovedError` → endpoint returns `409 head_moved`. Bob's
  UI shows the same banner; bob's next move is the same pull.
  The pull is the smooth path, the 409 is the safety net.
- Pull race: another commit lands while bob is in the resolver.
  His next commit attempt against `expected_head_commit_id=
  "gcmt_B"` then 409s — pull again, resolve again. The cycle is
  self-correcting.
- Bob's `add_node u:n9` collides with a concurrent commit that
  added `u:n9` independently → conflict_class `"add_add"`.
  Resolver lets bob pick keep-ours (he wins; he commits a new
  add) or keep-theirs (his add becomes a no-op; he dismisses).
- Conflict_class `"edit_delete"` (bob edits u:n2; another commit
  deletes u:n2): resolver shows "the object is gone — discard your
  edit?" If bob keeps editing, the next commit raises
  `WorkingSetError` on a base mismatch (`current_hash=null`); the
  UI prompts again. The pull never silently drops in-flight work.

---

### DN-n — Draft squash to `main` with audit preservation (V1-1, V1-2, V1-3)

**User does**: alice creates a `feature/etl` draft branch off
`main`, makes 3 commits over a few hours. Carol pulls alice's
draft branch, makes 2 more commits on the same draft. Alice clicks
"Merge to main"; the merge runs clean (no conflicts) and lands as
a single squash commit on trunk. `/blame` on every touched node
still returns the original draft author; `/audit?commit_id=
<trunk>` returns all 5 events.

**Endpoint sequence**:

```
1. POST /branches body: {name: "feature/etl", from_commit_id: "gcmt_M"}
   → 201

2-4. alice: stage + commit × 3 on feature/etl
     → gcmt_F1 (parent=gcmt_M, alice, 1 op)
     → gcmt_F2 (parent=gcmt_F1, alice, 1 op)
     → gcmt_F3 (parent=gcmt_F2, alice, 1 op)

5-6. carol: stage + commit × 2 on feature/etl
     → gcmt_F4 (parent=gcmt_F3, carol, 1 op)
     → gcmt_F5 (parent=gcmt_F4, carol, 1 op)

7. POST /branches/feature/etl/merge-into/main
   body: {message: "ETL cleanup", auto_commit_if_clean: true}
   → 200 MergePlan {status: "committed",
                    is_mergeable: true,
                    conflicts: [], integrity_violations: [],
                    result_commit_id: "gcmt_T"}    ← the single trunk commit

   (SSE: visualization.graph.merged + visualization.graph.committed)
```

**Backend code flow** (step 7 — the squash):

1. `endpoints/graphs.py::merge_branch_into` calls
   `graph_merge_service.plan_merge(..., target_branch="main",
   auto_commit_if_clean=true)`.
2. Standard merge resolution + three-way merge (DN-f flow); clean
   outcome with `is_mergeable=true`.
3. `_persist_merge_commit:617` detects
   `is_squash = (target_branch == graph.default_branch)` → True.
4. Calls `persist_commit(..., is_default_branch=True,
   extra_parent_ids=[gcmt_F5], merge_source_commit_id="gcmt_F5",
   merge_source_branch="feature/etl",
   expected_head_commit_id=gcmt_M_now)`.
5. **The squash gate** at `graph_commit_repo.py:150-151` fires:
   `extra_parent_ids = None`. The commit row written has
   `parent_ids=[gcmt_M_now]` (single parent) — NOT a 2-parent
   merge commit. `merge_source_commit_id="gcmt_F5"` and
   `merge_source_branch="feature/etl"` go on the same row.
6. Trunk index append: `graph_commit_repo.py:319-329` inserts the
   `graph_trunk_log` row with `commit_seq` = previous_seq + 1.
7. Back in `_persist_merge_commit`, after the commit insert,
   `_copy_squashed_audit_and_contributors:717` runs:
   - Walks parent chain `gcmt_F5 → gcmt_F4 → gcmt_F3 → gcmt_F2
     → gcmt_F1` collecting commit ids until reaching
     `base_commit_id=gcmt_M`.
   - For each draft commit, reads its `graph_change_event` rows
     and re-inserts each one with `commit_id="gcmt_T"` (the new
     trunk id) but preserving original `actor`, `created_at`,
     `attribute_path`, `prev_content_hash`, `new_content_hash`.
     Five rows in total (alice ×3, carol ×2).
   - Aggregates per-actor counts into
     `graph_commit_contributors` via `INSERT ... ON CONFLICT
     (commit_id, actor) DO UPDATE SET ops_count = ops_count +
     EXCLUDED.ops_count`. Two rows: (gcmt_T, alice, 3),
     (gcmt_T, carol, 2).
8. Updates `graph_merge.status='committed',
   result_commit_id="gcmt_T"`; emits `graph.merged` and
   `graph.committed` outbox events.

**Audit footprint**:

| Row | Why |
|---|---|
| `graph_commits` × 1 (gcmt_T; parent_ids=[gcmt_M_now]; merge_source_commit_id="gcmt_F5"; merge_source_branch="feature/etl") | the squash trunk commit — single parent, non-parent provenance pointer |
| `graph_trunk_log` × 1 (commit_seq=N+1, committed_at=T_merge) | trunk index append |
| `graph_change_event` × 5 (commit_id=gcmt_T; original actors: alice ×3, carol ×2; original `created_at` preserved) | re-stamped draft audit |
| `graph_commit_contributors` × 2 ((gcmt_T, alice, 3), (gcmt_T, carol, 2)) | per-actor manifest |
| `graph_merge` × 1 (status=committed, result_commit_id=gcmt_T) | merge attempt record |
| `graph_outbox_events` × 2 (`graph.merged` + `graph.committed`) | SSE fan-out |
| (the original `graph_change_event` rows on `gcmt_F1…F5` ARE NOT deleted) | the draft chain is still a valid sub-history; a future draft-GC sweep may prune it, but provenance via `merge_source_commit_id` stays intact regardless |

**Blame after the squash**:

```
GET /graphs/g_xyz/objects/<any-touched-node>/blame
  → returns rows whose commit_id is gcmt_T but whose actor is the
    ORIGINAL draft author (alice or carol), not the merger.
```

This is the V1-3 invariant — squash compresses the parent DAG,
NEVER the audit detail.

**Verifying the linear-trunk invariant**:

```
SELECT parent_ids FROM graph_commits WHERE id = 'gcmt_T'
  → ['gcmt_M_now']     -- exactly one parent

SELECT merge_source_commit_id, merge_source_branch FROM graph_commits
WHERE id = 'gcmt_T'
  → ('gcmt_F5', 'feature/etl')   -- non-parent provenance
```

**Edge cases**:

- Direct-main commit (no draft, no merge): same code path but with
  `merge_source_commit_id=NULL` and no audit-copy step (there's
  no draft chain). `graph_commit_contributors` is a single row;
  the original `graph_change_event` rows already carry the right
  `commit_id`.
- Merge to a non-default branch (e.g. `feature-x → feature-y`):
  `is_squash=False` → squash gate is a no-op; the commit ends up
  with two parents (traditional merge commit); no trunk_log
  append; no audit copy. The draft DAG stays exactly as merged
  branches have always behaved.
- Merge conflict path (alice + main touched the same node):
  `plan_merge` returns `status="open"` with conflicts; user
  resolves via `POST /merges/{id}/resolve`; `commit_resolved_merge`
  takes the same squash path on commit. Resolution doesn't
  bypass the trunk invariant.

---

### DN-o — Time-travel via `/as_of` (V1-9 forensic flow)

**User does**: an auditor needs to know what the graph looked like
on the morning of 2025-03-14 to investigate why a downstream alert
fired then. They hit `/as_of?at=2025-03-14T11:00:00Z`.

**Endpoint sequence**:

```
1. GET /api/v1/{ws}/graphs/g_xyz/as_of?at=2025-03-14T11:00:00Z
   → 200 {
       as_of:        "2025-03-14T11:00:00Z",
       commit_id:    "gcmt_T7",
       committed_at: "2025-03-14T10:42:11Z",
       commit_seq:   42,
       root_hash:    "…",
       nodes:        [ … snapshot at gcmt_T7 … ],
       edges:        [ … ]
     }
```

**Backend code flow**:

1. `endpoints/graphs.py::get_graph_as_of:895` parses
   `at=2025-03-14T11:00:00Z`, validates `workspace:graph:read`.
2. Single indexed query:
   ```sql
   SELECT commit_id, committed_at, commit_seq
   FROM graph_trunk_log
   WHERE graph_id = :g AND committed_at <= :at
   ORDER BY committed_at DESC, commit_seq DESC
   LIMIT 1
   ```
   Uses `idx_trunk_log_committed_at`. Returns
   (`gcmt_T7`, `2025-03-14T10:42:11Z`, `42`).
3. `snapshot_reader.load_snapshot(graph_id,
   commit_id="gcmt_T7")` — exact same path as
   `/refs/{commit_id}/snapshot`. Reads the root manifest, decodes
   partitions, materializes node/edge maps from
   `graph_node_versions` / `graph_edge_versions`.
4. Returns the combined payload (snapshot fields + the three
   `as_of` / `committed_at` / `commit_seq` extras).

**Why this works**: decision 26. The parent DAG already encodes
every historical state (each commit's root_hash deterministically
identifies its snapshot). `graph_trunk_log` is a thin date index
that lets `/as_of` do one indexed lookup instead of walking the
DAG to find "the latest trunk-reachable commit at-or-before T."
SCD2 lineage tables explicitly killed (decision 29).

**Audit footprint**:

| Row | Why |
|---|---|
| (none) | `/as_of` is a pure read; no audit, no outbox event |

**Edge cases**:

- `at` precedes the genesis trunk commit → no row matches →
  `404 no_trunk_commit_at_or_before` with the genesis timestamp
  in the response detail.
- `at` is after the latest trunk commit → returns the latest
  trunk commit (the response shape is identical to a present-day
  snapshot read). The endpoint doesn't try to be clever about
  "future" timestamps.
- `at` falls between two trunk commits → returns the earlier of
  the two (the snapshot was in force at that moment).
- `at` is unparseable → `422 invalid_at` from the endpoint's
  ISO-8601 validator.
- Draft branches are NOT queryable via `/as_of` — trunk-only by
  design. For a specific non-trunk commit, the client uses
  `GET /refs/{commit_id}/snapshot` directly.

**Pinned by**: `test_graph_commit_repo.py` trunk_log substrate
tests + integration tests for the endpoint. The decision to
expose `commit_seq` in the response is for clients building
"forensic diff" views — `GET /diff?from=<gcmt_T6>&to=<gcmt_T7>`
shows exactly what the auditor's `gcmt_T7` snapshot inherited
from the prior trunk state.

---

### DN-p — FalkorDB projector convergence + idempotent replay (V1-5)

**User does** (mostly invisible to the user — this is operator-
facing flow): an admin commits to `main`, then opens the canvas
and runs a "neighbours of u:n1" query. Within the convergence SLO
the query reads against `authored_<graph_id>` in FalkorDB. Later
the admin force-replays the projection to verify recoverability.

**Endpoint sequence (a)** — normal happy path:

```
1. POST /branches/main/commits         (any committing user)
   → 200 {commit_id: "gcmt_T8", …}
   (SSE: visualization.graph.committed)

2. (in background, within seconds:)
   graph_falkor_projector picks up the event off graph.outbox stream
   → reads change-events for gcmt_T8 → batches → applies UNWIND
   MERGE/DELETE Cypher into authored_<graph_id>
   → updates graph_projector_cursor for (graph_id, target='falkordb')

3. POST /api/v1/graph (FalkorDB query proxy — existing endpoint)
   body: {graph: "authored_<g_xyz>",
          query: "MATCH (n:Node {urn:'u:n1'})-[:CONNECTS]-(m) RETURN m"}
   → 200 {nodes: [m1, m2, …]}    ← reflects gcmt_T8's state
```

**Backend code flow** (step 2 — the projection):

1. `run_falkor_projector:93` polls
   `XREADGROUP GROUP falkor_projector_v1 <consumer> COUNT 32
    BLOCK 5000 STREAMS graph.outbox >` → receives the
   `visualization.graph.committed` entry.
2. `_process_event:194` decodes the payload. Reads
   `user_graphs.default_branch` for the graph (cached in
   `_ProjectorState.default_branches`) → confirms
   `payload.branch == "main"` (the default). Non-default-branch
   events are silently ACK'd here.
3. Loads `graph_projector_cursor` for
   `(graph_id, target='falkordb')`. If
   `last_applied_commit_seq >= this commit_seq` (replay /
   already-applied), ACKs and returns. Otherwise reads
   `graph_change_event` rows for the commit + content blobs from
   `graph_node_versions` / `graph_edge_versions` by
   `new_content_hash`.
4. `_apply_to_falkor:451` builds four batched lists
   (node_upserts / edge_upserts / edge_deletes / node_deletes),
   chunks each at `_BATCH_SIZE=1000` rows, and emits one Cypher
   per chunk in **strict order**:

   ```cypher
   -- chunk: node upserts
   UNWIND $rows AS r
   MERGE (n:Node {urn: r.urn})
   SET n.entity_type=r.entity_type, n.display_name=r.display_name,
       n.properties=r.props_json, n.tags=r.tags_json,
       n.position=r.position_json, n.content_hash=r.content_hash

   -- chunk: edge upserts
   UNWIND $rows AS r
   MERGE (s:Node {urn: r.source_urn})
   MERGE (t:Node {urn: r.target_urn})
   MERGE (s)-[e:CONNECTS {urn: r.urn}]->(t)
   SET e.edge_type=r.edge_type, e.properties=r.props_json,
       e.confidence=r.confidence, e.content_hash=r.content_hash

   -- chunk: edge deletes      MATCH ()-[e:CONNECTS {urn:r.urn}]->() DELETE e
   -- chunk: node deletes      MATCH (n:Node {urn:r.urn}) DETACH DELETE n
   ```

5. After every chunk succeeds, the projector opens a fresh
   Graph-Store session and upserts the
   `graph_projector_cursor` row via `INSERT ... ON CONFLICT
   (graph_id, target) DO UPDATE` with the new
   (commit_seq, commit_id, stream_id, lag_seconds_observed).
   Commits the session.
6. Then `XACK graph.outbox falkor_projector_v1 <stream_id>` —
   removes the entry from the consumer-group PEL.

**Endpoint sequence (b)** — operator-initiated replay:

```
1. (admin manually executes against the Graph Store DB:)
   DELETE FROM graph_projector_cursor
   WHERE graph_id='g_xyz' AND target='falkordb';

2. (optional: admin DROPs `authored_g_xyz` in FalkorDB)

3. (projector resumes; next poll picks up subsequent events; for
   already-XACK'd commits the operator can use the existing
   `XREADGROUP` PEL re-read pattern, or push a manual replay
   command — out of scope this round)
```

The current V1 cursor logic makes future commits idempotent: a
commit projected twice produces the same Cypher (`MERGE` is
content-addressed via `urn` + `content_hash`), so the second apply
is a no-op against the existing FalkorDB state.

**Audit footprint (per applied commit)**:

| Row | Why |
|---|---|
| (NO change to graph_change_event / graph_commits / etc.) | projector is read-only against Postgres state-of-record |
| `graph_projector_cursor` UPSERT × 1 | (graph_id, target='falkordb') row advances to the new commit_seq |
| (NO outbox event) | projector consumes; nothing else listens for "projection complete" in V1 |
| FalkorDB namespace `authored_<g_xyz>` mutated via UNWIND MERGE/DELETE | the projected state |

**Failure modes**:

- **FalkorDB unreachable** → Cypher call raises → outer loop logs
  and re-polls without ACK; entry stays in PEL. Cursor not
  advanced. Reads of `authored_<g_xyz>` against a stale projection
  are still serviceable (they return the last-good state); reads
  against a never-projected graph just degrade — the canvas falls
  back to `GET /refs/main/snapshot` against Postgres. Backoff:
  `_BACKOFF_MIN_S=0.5` … `_BACKOFF_MAX_S=30` seconds.
- **Postgres unreachable** → projector can't decode the event
  payload (no `_load_content_blobs`); same backoff path. The
  outbox relay is also stalled, so no NEW events arrive — the
  system is in a coherent paused state.
- **Malformed payload** → ACK + drop with a single warning log
  line. Doesn't block the queue.
- **Projector dies mid-commit** (e.g. SIGKILL after the FalkorDB
  Cypher applied but before the cursor advanced) → next poll
  re-reads the entry, the cursor check still passes (cursor was
  not advanced), the projector re-applies the same Cypher; MERGE
  is idempotent so FalkorDB converges to the same state; cursor
  advances second time around; ACK. The dual-write to two
  systems is reconciled via the cursor.

**Verifying convergence**:

```
SELECT last_applied_commit_seq, last_applied_commit_id,
       lag_seconds_observed, last_error
FROM graph_projector_cursor
WHERE graph_id='g_xyz' AND target='falkordb';
  → (42, 'gcmt_T8', 0.183, NULL)
```

`lag_seconds_observed` is the time between the projector picking
up the event and finishing the Cypher apply — operators alert on
this when it grows (indicates FalkorDB pressure or projector
saturation).

**Pinned by**: `backend/tests/test_graph_falkor_projector.py`
(8 cases covering ordering / idempotency / batching / namespace
isolation / serialization).

---

## Map: scenarios → tests + code

| Scenario | Pinned by | Critical code paths |
|---|---|---|
| D0-a | `test_graph_commit_repo` + integration | `endpoints/graphs.py::create_graph`, `commit` |
| D0-b | manual + Phase 2 integration | `graph_source_sync_service.sync_data_source` |
| D0-c | `test_view_binding_service` | `view_binding_service.ensure_branch` |
| DN-a | (existing) | `commit` path with `view_id=null` |
| DN-b | integration | `HeadMovedError` + `WorkingSetError` |
| DN-c | `test_view_binding_service::per_view` | view-as-branch |
| DN-d | `test_view_binding_service::per_user_per_view` | view-as-branch |
| DN-e | doc (test exists for per-view filter via index) | `view_id` audit column |
| DN-f | `test_graph_merge_service::test_lca_*` + integration | `graph_merge_service.plan_merge` + `commit_resolved_merge` |
| DN-g | (Wave 1 unit) + integration | `graph_repo.delete_branch` guards |
| DN-h | `test_graph_source_repo` + manual | `apply_source_diff` + sweep |
| DN-i | `test_graph_composition::test_hybrid_*` | `compose` rules |
| DN-j | `test_view_binding_service::test_ensure_branch_fast_path` | `ensure_branch` idempotent |
| DN-k | (existing commit tests) | `commit` path without `view_id` |
| DN-l | docs only | SSE + client UX |
| DN-m | `test_graph_working_set_pull.py` (10 cases) + frontend `graphEditorStore.test.ts` V1-6 cases (7 cases) | `endpoints/graphs.py::pull_working_set:384`, `graph_working_set_repo.rebase_against_snapshot:254`, `graphEditorStore.applyPullResult` / `dismissConflict` |
| DN-n | `test_graph_commit_repo.py` (squash gate + trunk_log substrate) + integration | `graph_commit_repo.persist_commit:150-151` (squash gate), `:319-329` (trunk_log append), `graph_merge_service._persist_merge_commit:617` + `_copy_squashed_audit_and_contributors:717` |
| DN-o | `test_graph_commit_repo.py` (trunk_log substrate) + integration | `endpoints/graphs.py::get_graph_as_of:895`, `graph_trunk_log` (`models_graph.py:715-742`), `snapshot_reader.load_snapshot` |
| DN-p | `test_graph_falkor_projector.py` (8 cases) + integration | `graph_falkor_projector.run_falkor_projector:93`, `_process_event:194`, `_apply_to_falkor:451`, `graph_projector_cursor` (`models_graph.py:770-786`) |
