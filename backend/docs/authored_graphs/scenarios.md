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
   `GraphRefORM` with `commit_id=null, revision=0`. No outbox event
   on create (the first commit emits one). `body.origin='authored'`
   skips the source-sync branch.
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
