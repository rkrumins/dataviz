# API Reference

Every authored-graph endpoint as it exists at commit `f755180`.
Grouped by surface. Error envelope codes are listed in
[`architecture.md`](./architecture.md#failure-modes--409422-envelopes).

All routes are mounted under `/api/v1`. `{ws_id}` is the workspace
slug or id.

## Graph lifecycle

### `POST /{ws_id}/graphs` — create graph

**Body** (`CreateGraphRequest`):
```json
{
  "name": "string",
  "description": "string?",
  "schema_mode": "strict | schemaless",
  "ontology_id": "string?",        // required when strict
  "origin": "authored | connected | fork",   // default "authored"
  "source_data_source_id": "string?"          // required when connected
}
```

**Response** (`GraphResponse`):
```json
{
  "id": "g_…",
  "workspace_id": "...",
  "name": "...",
  "description": "...",
  "origin": "...",
  "schema_mode": "...",
  "default_branch": "main",
  "head_commit_id": null,
  "initial_source_snapshot": {     // present only for origin=connected
    "id": "gss_…",
    "status": "completed | failed",
    "added_count": 0, "modified_count": 0, "removed_count": 0
  }
}
```

**Behaviour.** Creates the `user_graphs` row + an empty `main`
branch ref with `commit_id=NULL`. When `origin='connected'`, also
triggers `sync_data_source` inline; the result is exposed in
`initial_source_snapshot`. On provider-resolve failure, the graph is
still created and `initial_source_snapshot` is omitted; the canvas
can retry via `POST /source/refresh`.

**RBAC**: `workspace:graph:create`.

**Errors**:
- `422 ontology_required` — strict graph without `ontology_id`.
- `422 ontology_not_published` — bound ontology is draft.

### `GET /{ws_id}/graphs` — list graphs

Returns `list[GraphResponse]` for the workspace. `head_commit_id` is
populated from the current `main` ref.

### `GET /{ws_id}/graphs/{graph_id}` — read graph

Returns `GraphResponse`.

### `DELETE /{ws_id}/graphs/{graph_id}` — soft-delete graph

**Behaviour.** Sets `deleted_at` on the `user_graphs` row. Refs +
commits + blobs untouched.

**RBAC**: `workspace:graph:delete`.

## Branch lifecycle

### `POST /{ws_id}/graphs/{graph_id}/branches` — create branch

**Body**:
```json
{ "name": "string", "from_commit_id": "gcmt_…?" }
```

**Response**:
```json
{ "branch": "...", "commit_id": "gcmt_… | null" }
```

`from_commit_id=null` creates a branch with an empty head (no
commits yet) — useful for branches forked off a brand-new graph.

**RBAC**: `workspace:graph:branch`.

### `GET /{ws_id}/graphs/{graph_id}/branches` — list refs

**Response**:
```json
{
  "graph_id": "g_…",
  "branches": [
    {
      "name": "main",
      "ref_type": "branch",
      "commit_id": "gcmt_…",
      "revision": 12,
      "is_protected": false,
      "created_by": "usr_…",
      "created_at": "ISO",
      "updated_at": "ISO"
    }
  ]
}
```

Newest-touched first (by `updated_at`). Includes tags.

**RBAC**: `workspace:graph:read`.

### `DELETE /{ws_id}/graphs/{graph_id}/branches/{branch}` — delete branch

**Behaviour.** Three guards (each returns structured 409):
- `cannot_delete_default` — branch is `graph.default_branch`.
- `working_sets_open` — at least one user has an open working set;
  `context.user_ids` lists them.
- `views_bound` — at least one `ViewORM` still pins
  `source_branch=<branch>`; `context.view_ids` lists them.

On success: removes the `graph_refs` row + emits
`visualization.branch.deleted` outbox event. Commits + blobs stay
(they're content-addressed; another ref may still point at them).

**RBAC**: `workspace:graph:delete`.

## Working set

### `POST /{ws_id}/graphs/{graph_id}/branches/{branch}/stage` — stage changes

**Body** (`StageRequest`):
```json
{
  "changes": [
    {
      "change_type": "add_node | update_node | delete_node | add_edge | update_edge | delete_edge",
      "object_kind": "node | edge",
      "object_id": "u:…",
      "payload": { /* full node or edge content */ },
      "base_content_hash": "..."   // for update/delete; lost-update guard
    }
  ]
}
```

**Behaviour.** Resolves the caller's (graph, branch, user) working
set (creates if absent). Coalesces by `(object_kind, object_id)` per
`coalesce_decision` — `add → delete` drops the row, `add → update`
keeps as `add` with the new payload, otherwise replaces. Emits
`visualization.working_set.advanced` with the user_id so only the
originating user's tabs refetch.

**Response**: `{ws_change_version, op_count}`.

**RBAC**: `workspace:graph:edit`.

### `GET /{ws_id}/graphs/{graph_id}/branches/{branch}/working-set`

Returns the caller's working set: `{ops: [...], ws_change_version}`.

### `DELETE /{ws_id}/graphs/{graph_id}/branches/{branch}/working-set`

Discards all uncommitted ops in the caller's working set.

## Commits

### `POST /{ws_id}/graphs/{graph_id}/branches/{branch}/commits`

**Body** (`CommitRequest`):
```json
{
  "message": "string",
  "expected_head_commit_id": "gcmt_… | null",
  "view_id": "view_… | null"
}
```

**Behaviour.** Atomic: validate (strict mode → ontology check) →
apply working set → plan commit (compute diff vs base) → dedup-insert
blobs + manifests + commit row → advance ref via CAS → write per-
object `graph_change_event` rows (each carries `view_id` if set) →
emit `visualization.graph.committed` outbox event.

When `view_id` is set: the endpoint loads the view, asserts
`source_graph_id == graph_id` AND the resolved branch matches the
URL branch (defence against committing under the wrong audit
context).

**Response** (`CommitResponse`):
```json
{
  "commit_id": "gcmt_…",
  "commit_hash": "...",
  "root_hash": "...",
  "delta_summary": {
    "nodes_added": 1, "nodes_modified": 0, "nodes_removed": 0,
    "edges_added": 2, "edges_modified": 0, "edges_removed": 0
  }
}
```

**RBAC**: `workspace:graph:edit`.

**Errors**:
- `409 head_moved` — branch advanced since `expected_head_commit_id`.
- `422 working_set_invalid` — `base_content_hash` mismatch on an op.
- `422 view_branch_mismatch` / `view_graph_mismatch` / `view_missing`.
- `422 graph_validation_failed` — strict-mode rejection (dangling
  edge, unknown entity_type, containment cycle).

### `GET /{ws_id}/graphs/{graph_id}/branches/{branch}/commits`

**Query**: `?limit=N` (default 50, max 200).

**Response**: `{commits: [{id, commit_hash, parent_ids, message,
author, committed_at, delta_summary, ...}]}`.

Walks from the branch head following the first `parent_id` until
`limit` is reached.

## Snapshot read

### `GET /{ws_id}/graphs/{graph_id}/refs/{ref}/snapshot`

`{ref}` is a branch name OR a commit_id (mirrors `git show <ref>`).

**Query**: `?composed=true|false` —
- For `authored` graphs: ignored (no source layer).
- For `connected`/`fork` graphs: default `true` returns source +
  enrichment composed; `false` returns enrichment-only ("see only
  my edits" view).

**Response**:
```json
{
  "ref": "view/view_abc",
  "commit_id": "gcmt_…",
  "root_hash": "...",
  "composed": true,
  "nodes": [
    {
      "key": "u:n1",
      "entity_type": "Dataset",
      "display_name": "Orders",
      "position": {"x": 100, "y": 200},
      "properties": {...},
      "tags": [...],
      "origin": "source | enrichment | hybrid",   // only when composed
      "content_hash": "..."
    }
  ],
  "edges": [...],
  "composition_diagnostics": {                    // only when composed
    "nodes_suppressed_by_enrichment": 0,
    "edges_suppressed_by_enrichment": 0,
    "edges_dropped_dangling": 0,
    "edges_dropped_endpoint_suppressed": 0
  }
}
```

**RBAC**: `workspace:graph:read`.

## Audit / blame / diff

### `GET /{ws_id}/graphs/{graph_id}/audit`

**Query**:
- `?branch=<b>` — per-branch filter (per-view scope when branch is
  view-bound).
- `?view_id=<v>` — per-view filter (composes with `branch`).
- `?object_kind=node|edge|graph|branch`
- `?actor=<uid>`
- `?since=<ISO>` — events at or after this timestamp.
- `?limit=N` — default 100, max 500.

Default (no filters) = **per-source** — every event across every
branch on this graph.

**Response**:
```json
{
  "graph_id": "g_…",
  "events": [
    {
      "id": "gce_…",
      "branch": "view/view_abc",
      "commit_id": "gcmt_…",
      "object_kind": "node",
      "object_id": "u:n1",
      "action": "created | updated | deleted",
      "attribute_path": null,
      "prev_content_hash": "...",
      "new_content_hash": "...",
      "actor": "usr_…",
      "view_id": "view_…",
      "pr_id": null,
      "created_at": "ISO"
    }
  ]
}
```

Newest first.

### `GET /{ws_id}/graphs/{graph_id}/objects/{urn:path}/blame`

Per-object audit chain. Used by `BlamePanel` ("display_name set by
alice in c1; tag pii added by bob in c2; ..."). Newest first; uses
the `idx_gce_blame` index.

**Query**: `?limit=N` (default 50, max 200).

### `GET /{ws_id}/graphs/{graph_id}/diff?from=<commit>&to=<commit>`

Merkle diff between two commits on the same graph. Reuses
`diff_snapshots`.

**Response**:
```json
{
  "graph_id": "g_…",
  "from": "gcmt_…", "to": "gcmt_…",
  "added":    [{"key": "u:n1", "kind": "node", "content_hash": "..."}],
  "modified": [{"key": "u:n2", "kind": "node",
                "prev_content_hash": "...", "new_content_hash": "..."}],
  "removed":  [{"key": "u:n3", "kind": "node", "content_hash": "..."}]
}
```

## Merge

### `POST /{ws_id}/graphs/{graph_id}/branches/{source}/merge-into/{target}`

**Body**:
```json
{
  "message": "string?",
  "auto_commit_if_clean": false
}
```

**Behaviour.**
1. Resolve refs + LCA (bidirectional BFS over `parent_ids`).
2. Run three-way merge on the three snapshots.
3. If clean, run integrity check.
4. Persist `GraphMergeORM` + per-conflict `GraphMergeConflictORM`.
5. If clean + integrity-clean + `auto_commit_if_clean=true`, write
   the merge commit inline (parent_ids = [target_head, source_head];
   merge_base_id set) and update the merge row to `status=committed`.

**Response** (`MergePlan`):
```json
{
  "merge_id": "gmrg_…",
  "graph_id": "g_…",
  "source_branch": "...",
  "target_branch": "main",
  "base_commit_id": "gcmt_… | null",
  "source_commit_id": "gcmt_…",
  "target_commit_id": "gcmt_…",
  "status": "open | committed",
  "has_no_conflicts": true,
  "has_no_integrity_violations": true,
  "is_mergeable": true,
  "auto_entry_count": 42,
  "conflicts": [
    {
      "key": "u:n1",
      "kind": "node",
      "conflict_class": "add_add | edit_delete | modify_modify",
      "base_content_hash": "...",
      "source_content_hash": "...",
      "target_content_hash": "..."
    }
  ],
  "integrity_violations": [
    {"code": "dangling_edge | containment_cycle", "detail": "...", "key": "..."}
  ],
  "result_commit_id": "gcmt_… | null",
  "delta_summary": {...}
}
```

**RBAC**: `workspace:graph:merge`.

**Errors**:
- `404 branch_not_found` — source or target ref missing.
- `409 head_moved` — concurrent commit during plan.
- `422 invalid_merge` — `source == target`.

### `GET /{ws_id}/graphs/{graph_id}/merges/{merge_id}`

Read a persisted merge plan with its current state + per-conflict
resolution snapshot.

### `POST /{ws_id}/graphs/{graph_id}/merges/{merge_id}/resolve`

**Body**:
```json
{
  "resolutions": {
    "u:n1": {"kind": "node", "content_hash": "h_target"},
    "u:n2": null                              // null = delete
  },
  "message": "string?"
}
```

**Behaviour.** Re-resolves heads + LCA (catches base advance during
human time), re-runs three-way, applies resolutions, re-runs
integrity. If clean, commits the merge with parent_ids =
[fresh_target, fresh_source].

**Errors**:
- `404 merge_not_found`.
- `422 merge_not_resolvable` — resolutions still leave dangling
  edges / containment cycles.
- `409 head_moved`.

## View binding

### `POST /views/{view_id}/enter-edit`

**Behaviour.** Resolves the view's editable branch per its
`branching_policy` and materialises it if absent (forks from
`merge_target_branch` head). Idempotent — subsequent opens are O(1).

**Response** (`ResolvedViewBinding`):
```json
{
  "view_id": "view_…",
  "graph_id": "g_…",
  "branch": "view/view_…",
  "branching_policy": "per_view",
  "merge_target_branch": "main",
  "created_branch": true
}
```

**RBAC**: `workspace:view:edit` (when `RBAC_ENFORCE_VIEWS=true`).

**Errors**:
- `404 view_not_found`.
- `422 view_not_bound` — view has no `source_graph_id`.
- `422 view_binding_error` — other policy / config issue.

### `GET /views/{view_id}/audit`

**Query**: `?object_kind=`, `?actor=`, `?since=`, `?limit=N`.

Convenience wrapper around `GET /graphs/{g}/audit?view_id=`. Resolves
the view → `source_graph_id`, queries `graph_change_event` with the
view_id filter.

## View create (extended)

### `POST /views`

The existing endpoint now accepts three additional optional fields
that bind the new view to a graph at creation time:

```json
{
  "name": "...", "workspaceId": "...",
  "sourceGraphId": "g_…",                 // optional
  "branchingPolicy": "per_view",           // optional; default per_view
  "mergeTargetBranch": "main"              // optional; default main
}
```

When `sourceGraphId` is set: the endpoint persists the binding +
calls `ensure_branch` inline so the canvas can open with one
round-trip. Late binding via `enter-edit` still works for legacy
callers.

## Source sync (Mode-2 / connected graphs)

### `POST /{ws_id}/graphs/{graph_id}/source/refresh`

**Query**: `?source_data_source_id=<id>` — override the graph's
bound source (default: `user_graphs.source_data_source_id`).

**Behaviour.** Resolves the upstream provider via the
`ProviderRegistry`, streams every node + edge through
`provider.get_nodes` / `get_edges`, converts to
`SourceNodeInput` / `SourceEdgeInput`, applies the diff into
`graph_source_*` tables. Always one Graph-Store txn. Emits
`visualization.graph.source_refreshed` (or `source_failed`) outbox
event.

**Response**: the resulting snapshot row (see below).

**Errors**:
- `422 graph_not_connected` — graph's `origin='authored'`.
- `422 provider_resolve_failed` — registry couldn't instantiate the
  upstream client.

### `GET /{ws_id}/graphs/{graph_id}/source/snapshots`

**Query**: `?limit=N` (default 50, max 200).

**Response**: `{graph_id, snapshots: [...]}` — newest first.

### `GET /{ws_id}/graphs/{graph_id}/source/snapshots/{snapshot_id}`

**Response** (`SourceSnapshot`):
```json
{
  "id": "gss_…",
  "graph_id": "g_…",
  "source_data_source_id": "wds_…",
  "status": "running | completed | failed",
  "source_root_hash": "...",
  "added_count": 100,
  "modified_count": 5,
  "removed_count": 2,
  "orphan_count": 1,
  "error_message": null,
  "triggered_by": "usr_…",
  "started_at": "ISO",
  "finished_at": "ISO"
}
```

### `GET /{ws_id}/graphs/{graph_id}/orphans`

**Query**: `?include_resolved=true|false` (default false),
`?limit=N`.

Lists enrichment objects whose source URN vanished. Triage queue.

## SSE events

### `GET /{ws_id}/graphs/{graph_id}/branches/{branch}/events`

Server-Sent Events stream scoped to `(graph_id, branch)`. Carries:
- `visualization.graph.committed` events (broadcast)
- `visualization.working_set.advanced` events (filtered to the
  caller's user_id by the SSE handler)
- `visualization.branch.deleted`, `visualization.graph.merged`,
  `visualization.graph.source_refreshed`, `visualization.graph.source_failed`

Honours `Last-Event-ID` for resume; emits heartbeats every 15s of
silence.
