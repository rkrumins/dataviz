# Architecture

The structural decisions behind the authored-graph backend. Pairs
with [`README.md`](./README.md) (decisions at-a-glance) and
[`scenarios.md`](./scenarios.md) (flows). Endpoint shapes are in
[`api-reference.md`](./api-reference.md).

## Two-database model

| Database | Owns | Why separate |
|---|---|---|
| **Management DB** (Postgres, `backend/app/db/engine.py`) | Workspaces, ontologies, views, data-source connections, RBAC, audit (admin actions). | Pre-existing system; powers the rest of the product. Authored-graph rollout cannot block on a schema change here. |
| **Graph Store DB** (Postgres, `backend/app/db/graph_store_engine.py`) | `user_graphs`, refs, commits, blobs (`graph_node_versions` / `graph_edge_versions`), manifests, audit (`graph_change_event`), working sets, merges, PRs (schema), source layer, outbox. | Append-only, content-addressed, very high write volume during enrichment; isolating it lets us tune storage / sharding / cold-tiering independently. |

**No foreign keys across the boundary.** Cross-DB references
(`workspace_id`, `ontology_id`, `created_by`, `source_graph_id` on a
View, `source_data_source_id` on a Graph) are **soft refs** — text
columns + endpoint-level integrity checks. Each DB is independently
recoverable; consistency is "the graph store can be replayed against
any management snapshot and remains correct."

Cross-DB queries happen at the endpoint layer (e.g. `delete_branch`
needs to enumerate views bound to the branch; the endpoint queries
the management DB and passes the IDs to the graph-store repo). No
service-layer code holds both sessions.

## Layered model — source + enrichment + composition

Three layers at read time for connected (mode-2) graphs:

```
              ComposedGraph         ←─── compose() at read time
                ▲       ▲
                │       │  per-field merge (enrichment wins),
                │       │  tag union, tombstone suppression,
                │       │  dangling-edge guard
                │       │
   ┌────────────┴──┐ ┌──┴─────────────┐
   │  enrichment   │ │  source layer  │
   │  layer        │ │                │
   │               │ │  graph_source_ │
   │ graph_node_   │ │  nodes / edges │
   │ versions      │ │  (last_sync_   │
   │ graph_edge_   │ │   run_id tag)  │
   │ versions      │ │                │
   │  + commits +  │ │  + snapshots   │
   │    audit      │ │    audit       │
   └───────────────┘ └────────────────┘
        │                  ▲
        │ user             │ provider stream
        │ commit           │ (DataHub /
        ▼                  │  OpenMetadata)
   POST /commits      POST /source/refresh
```

For authored (mode-1) graphs the source layer is empty; composition
is the identity over the enrichment layer.

For forked graphs the source layer is empty and the enrichment layer
is seeded by blob copy from the parent at fork time (Phase 2.5).

### Composition rules

Code: `backend/app/services/graph_composition.py`.

| Case | Output | Origin tag |
|---|---|---|
| source present, enrichment absent | source fields verbatim | `source` |
| source absent, enrichment present | enrichment fields verbatim | `enrichment` |
| both present, enrichment NOT tombstoned | per-field merge (enrichment wins); tags union | `hybrid` |
| enrichment tombstoned | suppressed (no row emitted) | n/a |
| edge endpoint missing from composed map | dropped (composition is a render concern); counted in `composition_diagnostics.edges_dropped_dangling` or `edges_dropped_endpoint_suppressed` | n/a |

The dangling/endpoint-suppressed distinction is intentional: a
dangling edge points to something that never existed in any layer
(usually broken upstream lineage), while endpoint-suppressed means
the user explicitly tombstoned the endpoint. The UI surfaces the
counts so the user can decide whether to fix upstream or repoint.

## Content addressing + Merkle manifest

Code: `backend/app/services/graph_versioning/{content_address,manifest,commit}.py`.

Every blob is SHA-256 keyed:

```python
node_content_hash(entity_type, display_name, position, properties, tags)
edge_content_hash(source, target, type, confidence, properties)
```

So two clients producing identical content emit the same blob — the
`UNIQUE(graph_id, content_hash)` constraint on the version tables
deduplicates automatically. A graph is "a set of `(key, content_hash)`
entries"; the Merkle manifest groups entries into N partitions
(default 128) and hashes each partition into a root.

This gives us:
- **O(log N) diff** between two snapshots (compare partition hashes
  first; only descend into divergent partitions).
- **Free Merkle-prune of merges** — partitions identical on all
  three sides are skipped.
- **Cheap delta sync from server to client** — the client knows the
  root_hash it has; the server returns only the changed partitions.

## View-as-branch + per-view audit

Code: `backend/app/services/view_binding_service.py`.

Each editable view has a `(source_graph_id, branching_policy,
merge_target_branch)` tuple on the management DB. The branch the
view actually opens is **computed**, not stored as authoritative:

```python
resolve_branch(view, user_id) →
   "main"                          if policy == "shared_main"
   "view/<view.id>"                if policy == "per_view"
   "user/<uid>/view/<view.id>"     if policy == "per_user_per_view"
```

`view.source_branch` IS persisted but only as a "last-used" hint —
the resolver is canonical. On `POST /views/{id}/enter-edit` the
service forks the resolved branch from `merge_target_branch` head if
absent (idempotent fast-path otherwise).

**Per-view audit dimension.** Every audit row carries `view_id`
(nullable). The commit endpoint accepts `view_id` in the body and
threads it through to `persist_commit`, which stamps it on every
`GraphChangeEventORM` row in the same transaction. Per-view audit
is then an indexed lookup on `(graph_id, view_id, created_at)` — no
branch→view JOIN needed. Per-source audit is the same table without
the filter — branches are partitioning, not isolation.

## Working sets — per-(graph, branch, user)

Code: `backend/app/db/repositories/graph_working_set_repo.py`.

`graph_working_set` has `UNIQUE(graph_id, branch, user_id)`. Each
user has at most one open working set per branch. The stage endpoint
scopes by `current_user.id`; the commit endpoint resolves the same
user's working set, computes the plan, and atomically persists the
commit + advances the ref + writes audit + emits the outbox event,
all in one Graph Store transaction.

**Coalescing.** `coalesce_decision(existing_change_type,
incoming_change_type)` is pure — `add → delete` of an uncommitted
object **drops** the row (cancels out, mirrors `git add` then `git
rm`). Tested matrix in `tests/test_graph_working_set_repo.py`.

**Stale-base protection.** Every staged update/delete carries the
base blob's content_hash. `apply_changes` (in
`backend/app/services/graph_versioning/snapshot_reader.py`) re-checks
against the live snapshot at commit time and raises `WorkingSetError`
if a concurrent commit changed the same field.

## Three-way merge

Code: `backend/app/services/graph_versioning/merge.py` (pure) +
`backend/app/services/graph_merge_service.py` (orchestrator).

The pure engine takes three snapshots (base = LCA, ours = target,
theirs = source) and emits a `MergeOutcome` with:
- `auto: EntryMap` — the cleanly-merged `(key → (kind, content_hash))`
- `conflicts: tuple[MergeConflict, ...]` — per-key disagreements
- `integrity_violations: tuple[IntegrityViolation, ...]` — dangling
  edges / containment cycles in the merged result

**Single gate**: `outcome.is_mergeable` = `has_no_conflicts AND
has_no_integrity_violations`. `run_post_merge_checks` populates the
integrity field — callers must invoke it before reading the gate.

**Orchestrator** flow:
1. Resolve target_head + source_head + LCA via bidirectional BFS over
   `graph_commits.parent_ids`.
2. Load three snapshots.
3. `three_way_merge` → outcome.
4. If clean, `run_post_merge_checks` for integrity.
5. Persist `GraphMergeORM` row + `GraphMergeConflictORM` rows.
6. If clean AND `auto_commit_if_clean`, also commit the merge using
   `persist_commit(extra_parent_ids=[source_head], merge_base_id=base)`.
7. Emit `visualization.graph.merged` outbox event.

`commit_resolved_merge` re-runs steps 1-3 from scratch (catches base
advance during human resolution time), applies the resolutions,
re-checks integrity, then commits.

## PR machinery (designed, not built this round)

Schema: `GraphPullRequestORM`, `GraphPrReviewORM`, `GraphPrCommentORM`
in `models_graph.py`. Migration `0002_fork_and_pr.py`.

Pure policy: `backend/app/services/graph_versioning/pr_policy.py`.
- `evaluate_mergeability(status, reviews, base_head, head_head,
  has_changes)` decides whether a PR may merge.
- `is_approval_stale(review, base_head, head_head)` — approvals
  invalidated by base or head advance.
- `latest_per_reviewer` — collapses to the most recent gating
  review per reviewer; `commented` doesn't gate.

No `POST /pulls/...` endpoints yet. Phase 2.5.

## Outbox + relay + SSE

Code: `backend/app/db/repositories/graph_store_outbox_repo.py`,
`backend/app/services/graph_outbox_relay.py`.

Every state-changing endpoint writes an `graph_outbox_events` row in
the same transaction as the state change. A relay process
(`run_graph_outbox_relay`, lifespan-wired in `main.py`) drains the
table into a Redis stream `graph.outbox`.

Event types currently emitted:

| Event | Emitter | Aggregate | Payload |
|---|---|---|---|
| `visualization.graph.committed` | `persist_commit` | graph_id | graph_id, branch, commit_id, commit_hash, root_hash, actor, view_id, pr_id, delta_summary |
| `visualization.working_set.advanced` | `stage_changes` | graph_id | graph_id, branch, user_id, ws_change_version |
| `visualization.branch.deleted` | `delete_branch` endpoint | graph_id | graph_id, branch, actor |
| `visualization.graph.merged` | `plan_merge` / `commit_resolved_merge` (when auto-commit / on commit) | graph_id | graph_id, merge_id, source_branch, target_branch, result_commit_id, actor |
| `visualization.graph.source_refreshed` | `run_inline_sync` (success) | graph_id | graph_id, sync_run_id, added, modified, removed, orphan_count, source_root_hash, actor |
| `visualization.graph.source_failed` | `run_inline_sync` (failure) | graph_id | graph_id, sync_run_id, error, actor |

`GET /graphs/{g}/branches/{b}/events` subscribes to the Redis stream
scoped to `aggregate_id = graph_id`. Server filters per branch on
the way out. `Last-Event-ID` header rewinds to a cursor; the relay
emits heartbeats every 15s of silence.

The `working_set.advanced` events carry `user_id` so the subscriber
filters them to "only events for the user opening this canvas",
preventing one user's staging from refetching every other user's tab.

## Authored-graph schema (Graph Store)

```
user_graphs                       ◀── one row per graph
  ├─ id, workspace_id, name, origin {authored | connected | fork}
  ├─ source_data_source_id        (NULL for authored)
  ├─ forked_from_graph_id         (NULL except fork)
  ├─ fork_point_commit_id         (frozen merge base for forks)
  ├─ default_branch
  ├─ schema_mode {strict | schemaless}
  ├─ ontology_id                  (required when strict)
  └─ partition_count              (frozen)

graph_refs                        ◀── one row per branch / tag
  ├─ id, graph_id, name, ref_type {branch | tag}
  ├─ commit_id                    (NULL until first commit)
  └─ revision                     (optimistic-lock guard)

graph_commits                     ◀── append-only
  ├─ id, graph_id, commit_hash
  ├─ parent_ids[]                 (1 normally; 2+ for merges)
  ├─ merge_base_id                (set for merge commits)
  ├─ root_manifest_hash
  ├─ author, message, committed_at
  └─ delta_summary (JSON counts)

graph_node_versions               ◀── content-addressed blobs
graph_edge_versions
  ├─ id, graph_id, content_hash
  ├─ node_key / edge_key + fields
  ├─ UNIQUE (graph_id, content_hash)

graph_partition_manifest          ◀── content-addressed manifests
  ├─ manifest_hash, partition_index
  ├─ entries (gzipped JSON list of (key, kind, content_hash))

graph_change_event                ◀── per-attribute audit
  ├─ id, graph_id, branch, commit_id
  ├─ object_kind, object_id, action
  ├─ prev_content_hash, new_content_hash
  ├─ actor, view_id, pr_id
  └─ INDEXES: blame (graph_id, object_id), branch, view (graph_id, view_id, created_at)

graph_working_set                 ◀── per-(graph, branch, user)
  ├─ id, graph_id, branch, user_id
  ├─ status {open | committing | abandoned}
  └─ ws_change_version

graph_working_change              ◀── ops in a working set
  ├─ id, working_set_id, seq
  ├─ change_type, object_kind, object_id
  ├─ base_content_hash            (stale-base check)
  └─ before_blob, after_blob

graph_merge                       ◀── merge attempt
  ├─ id, graph_id, source_branch, target_branch
  ├─ base_commit_id, source_commit_id, target_commit_id
  ├─ status {open | resolved | aborted | committed}
  └─ result_commit_id

graph_merge_conflict              ◀── per-conflict row
  ├─ id, merge_id, conflict_class
  ├─ object_kind, object_id
  ├─ base_value, source_value, target_value (JSONB hashes)
  └─ resolution, resolved_value, resolved_by, resolved_at

graph_source_snapshots            ◀── one row per source-sync run
  ├─ id, graph_id, source_data_source_id
  ├─ status {running | completed | failed}
  ├─ source_root_hash
  ├─ added_count / modified_count / removed_count / orphan_count
  ├─ error_message
  └─ triggered_by, started_at, finished_at

graph_source_nodes / graph_source_edges  ◀── current source state
  ├─ graph_id, urn (PK)
  ├─ entity_type / display_name / position / properties / tags
  ├─ content_hash
  └─ last_sync_run_id (drives end-of-run sweep)

graph_orphan_enrichments          ◀── triage queue
  ├─ id, graph_id, urn, object_kind {node | edge}
  ├─ sync_run_id, discovered_at
  └─ resolved_at, resolved_by, resolution
```

## Authored-graph schema (Management DB additions)

```
views                              ◀── extended with binding fields
  ├─ source_graph_id               (soft ref → user_graphs.id)
  ├─ source_branch                 (last-used branch hint)
  ├─ branching_policy              ENUM {shared_main | per_view | per_user_per_view}
  └─ merge_target_branch           (default 'main')
```

Plus the existing `workspaces`, `workspace_data_sources` (provider
+ credentials), `ontologies`, `role_bindings`, `view_grants`.

## RBAC model

| Permission | Used by |
|---|---|
| `workspace:graph:read` | snapshot, audit, blame, diff, history, list_branches, list_merges, list_source_snapshots, list_orphans, SSE events |
| `workspace:graph:create` | POST /graphs |
| `workspace:graph:edit` | (reserved; source/refresh uses this) |
| `workspace:graph:delete` | DELETE /graphs, DELETE /branches |
| `workspace:graph:branch` | POST /branches |
| `workspace:graph:merge` | merge / merge-into / resolve |
| `workspace:view:create` / `read` / `edit` | views + enter-edit + per-view audit |

Enforcement is at the endpoint level via the `requires(...)` Depends
mixin (`backend/app/auth/dependencies.py`). Views additionally route
through `view_access` (three-layer evaluator: workspace, visibility,
explicit `view_grants`).

## Failure modes + 409/422 envelopes

Structured errors so the frontend can branch on code, not text:

| Code | HTTP | Source | Meaning |
|---|---|---|---|
| `head_moved` | 409 | `HeadMovedError` from `persist_commit` | Ref advanced since the client's view; refetch + retry |
| `working_set_invalid` | 422 | `WorkingSetError` from `apply_changes` | A staged op's `base_content_hash` no longer matches; discard + restage |
| `view_branch_mismatch` | 422 | `assert_branch_matches_view` | Commit request's `view_id` resolves to a different branch than the URL; client bug |
| `view_graph_mismatch` | 422 | commit endpoint | View's `source_graph_id` ≠ URL graph_id |
| `view_not_bound` | 422 | view-binding service | View has no `source_graph_id` |
| `cannot_delete_default` | 409 | `delete_branch` | Branch is the graph's `default_branch` |
| `working_sets_open` | 409 | `delete_branch` | One or more users have open working sets on the branch |
| `views_bound` | 409 | `delete_branch` | One or more views still pin `source_branch=<this>` |
| `merge_not_resolvable` | 422 | `commit_resolved_merge` | Resolutions still leave integrity violations |
| `graph_not_connected` | 422 | `refresh_source` | Authored graphs have no upstream to refresh |
| `provider_resolve_failed` | 422 | `sync_data_source` | Provider registry couldn't instantiate the upstream client |
| `merge_not_found` / `branch_not_found` / `snapshot_not_found` / `commit_not_found` | 404 | various | Standard 404 |

## What's deferred and why

- **PR endpoints (Phase 2.5)** — the schema is in place and
  `pr_policy` is pure and tested. The UI work to drive PR review is
  the next user-visible deliverable; we'd rather ship the API
  surface alongside.
- **Fork endpoint + blob copy worker (Phase 2.5)** — schema in
  place. Blob copy is async-friendly (content addressing makes it a
  pure stream from one graph to another); needs a worker process to
  avoid blocking the request.
- **Hot projection per-branch namespace (Phase 2)** — currently the
  canvas reads from the cold store (correct, slower). The
  materialization worker is its own commit-driven process; we'd
  rather ship after the merge orchestrator stabilises.
- **Genesis-import worker (Phase 2.5)** — Mode-2 sync runs inline
  at the endpoint today. Moving it to a worker is a deployability
  improvement, not a correctness one.
- **Cron-scheduled source refresh** — same; manual trigger MVP.
- **Publish-back to external systems (publish_runs)** — keeps our
  enrichment audit on our side; pushing the deltas back to DataHub
  / OpenMetadata is its own audited operation. Designed in plan
  §C.7.
- **Blended audit query** (union enrichment audit + source-sync
  snapshots) — composition diagnostics + per-snapshot rows already
  expose what the user needs; the union endpoint is cosmetic.
