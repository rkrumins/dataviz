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

## Read routing matrix (V1)

Different read shapes hit different stores. The cold Postgres store
is always system-of-record (decision 15); FalkorDB and the composed
snapshot cache are rebuildable downstream projections.

| Read shape | Source | Why |
|---|---|---|
| `main` HEAD raw graph query (neighbours, paths, traversals) | FalkorDB namespace `authored_<graph_id>` (V1-5 projector) | hot, indexed, sub-100ms even at millions of nodes |
| `main` HEAD composed view (mode-2: source + enrichment) | Postgres composed snapshot via `graph_composition.compose` | composition is a render concern; mode-2 has no hot projection in V1 |
| draft branch reads (any non-default branch) | Postgres via `snapshot_reader.load_snapshot` | per-draft Falkor namespaces are deferred (see README "What's intentionally not built") |
| `/as_of?at=<iso8601>` time-travel | `graph_trunk_log` indexed lookup + `snapshot_reader.load_snapshot` | trunk-only index (decision 26) + reuse of the snapshot reader |
| `/audit`, `/blame`, `/diff` | `graph_change_event` + `graph_commits` in Postgres | per-attribute history is dense; the row store is the right fit |
| Working-set state (uncommitted ops) | Postgres `graph_working_set` + `graph_working_change` | client-visible only to the owning user; transactional with stage/commit |
| Catalog/canvas reads via existing `/graph/*` endpoints | FalkorDB `authored_<graph_id>` via `ContextEngine.for_workspace(ws_id, data_source_id=)` | authored graphs are first-class workspace data sources (M1) — no parallel read path |

The projector is **best-effort downstream**: a FalkorDB outage
pauses `graph_projector_cursor` advancement and `main` HEAD raw
queries transparently degrade to the Postgres snapshot reader.
Correctness is unaffected; only `main` hot-path latency suffers.

## Authored graphs as workspace data sources (M1/M2)

Authored graphs are exposed to the existing catalog/read surface as
ordinary `workspace_data_sources` rows so every consumer of that
catalog — the data-source listing endpoint, freshness gauges, the
`ContextEngine.for_workspace(ws_id, data_source_id=)` factory, the
30+ `/graph/*` read endpoints — works against them with no change.
There is no parallel "authored read path" and no `AuthoredProvider`
class.

### Flow

1. `POST /api/v1/{ws_id}/graphs` writes the `user_graphs` row in the
   Graph Store DB and emits `visualization.user_graph.created` to the
   Graph Store outbox **in the same transaction** (via
   `graph_store_outbox_repo.emit`).
2. The existing `run_graph_outbox_relay` lifespan task drains the
   outbox to the `graph.outbox` Redis stream (no change — same
   transport, same contract).
3. A new lifespan consumer
   `services/authored_data_source_relay.run_authored_data_source_relay`
   joins consumer group `authored_ds_relay_v1` on `graph.outbox`,
   filters for `visualization.user_graph.{created,deleted}` and
   `visualization.graph.materialized`, and projects each into the
   management DB's `workspace_data_sources` table using the SQLAlchemy
   ORM (dialect-portable for the SQLite test suite).
4. The CREATE handler binds the row to a singleton system FalkorDB
   provider `prov_sys_authored_falkor` (bootstrapped by alembic
   migration `20260528_authored_falkor_provider`) with
   `graph_name='authored_<graph_id>'` so the existing
   `ProviderManager._create_provider_instance` dispatches to the
   FalkorDB provider against the correct namespace — no new provider
   class.
5. The FalkorDB projector emits `visualization.graph.materialized`
   atomically with its cursor advance after every successful
   default-branch flush; the relay flips
   `aggregation_status='ready'` + sets `last_aggregated_at` +
   `graph_fingerprint=sha256(commit_id)` so the catalog UI's
   freshness gauges work.
6. `DELETE /api/v1/{ws_id}/graphs/{graph_id}` emits
   `visualization.user_graph.deleted`; the relay soft-deletes the
   matching row.

### Why a relay instead of a synchronous write

The Graph Store DB and the management DB are deliberately decoupled
(decision 3 — separate CloudSQL instances, independent scaling).
Spanning a write across both would require a distributed transaction,
which the architecture rejects. The Redis-backed outbox relay gives
at-least-once cross-DB delivery; handlers are idempotent:

* CREATE uses SELECT-then-INSERT (single consumer per partition
  guarantees no race; redelivery hits the existing
  `uq_ds_ws_prov_graph` unique constraint anyway).
* DELETE is an `UPDATE WHERE deleted_at IS NULL` (re-delivery just
  re-stamps the same timestamp).
* MATERIALIZED is an `UPDATE WHERE matching` — if `created` hasn't
  drained yet, the UPDATE no-ops and the next commit's tick catches up.

### Failure modes

| Scenario | Behavior |
|---|---|
| Redis outage | Graph Store outbox rows accumulate; relay catches up on recovery |
| Management DB outage | Relay batch fails; events stay unacked; redelivered when the DB returns |
| Materialized arrives before created | UPDATE no-ops; next commit's tick brings the row to `ready` |
| Operator wants to retire the system FalkorDB provider | Migration is idempotent; admins re-point `prov_sys_authored_falkor` via the existing provider-edit endpoint without touching the relay |

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

## V1 collaboration model — shared branch + pull/commit/push

The product commitment (decision 28): multiple users target the
same branch with private working sets and reconcile via Git-flow
pull/commit/push. Explicitly NOT Google-Docs CRDT real-time
co-editing — the cost-vs-value tradeoff there isn't worth it for
analyst-scale graphs.

The four collaboration primitives:

1. **Isolation.** `UNIQUE(graph_id, branch, user_id)` on
   `graph_working_set` means each user gets at most one working set
   per branch; their staged ops are invisible to other users until
   commit.
2. **First-commit-wins on the ref.** `persist_commit` CAS-advances
   `graph_refs.commit_id` from `expected_head_commit_id` to the new
   id. If the ref already advanced, `HeadMovedError` → 409
   `head_moved` (see "Failure modes"). The losing user pulls
   (below) and retries.
3. **Per-entity stale-base guard.** Every staged update/delete
   carries `base_content_hash` (the blob hash the user observed).
   `apply_changes` re-checks it against the live snapshot at commit
   time and raises `StaleEntityViolation` if any other user
   modified the same field — surfaced as 422
   `working_set_invalid`. Field-level lost-update protection, not
   just ref-level.
4. **Functional pull (V1-6).** `POST …/working-set/pull` re-anchors
   the working set against the current HEAD using
   `graph_working_set_repo.rebase_against_snapshot`. For each
   staged op, the rebase classifies:

   | Outcome | Trigger | Behaviour |
   |---|---|---|
   | clean rebase | `staged.base_content_hash == current_hash` (or both sides agree the object is absent) | op stays in working set; `base_content_hash` refreshed to the new value |
   | drop | both sides deleted the same key | staged op removed silently from the working set |
   | `edit_edit` | both sides modified, hashes differ | conflict; op LEFT IN PLACE with original `base_content_hash` |
   | `edit_delete` | we edited; remote deleted | conflict; same in-place semantics |
   | `delete_edit` | we deleted; remote modified | conflict; same |
   | `add_add` | both sides independently created the same key | conflict; same |

   After the call, `working_set.base_commit_id` advances to the
   current HEAD unconditionally; conflicted ops remain with their
   **original** `base_content_hash` so the resolver UI can render
   ours/theirs without losing work. The commit endpoint still
   re-runs the per-entity stale guard at commit time, so a stale
   resolution becomes a clean 422 rather than corruption.

The `visualization.graph.committed` SSE event (see "Outbox + relay
+ SSE") is the smooth path: the canvas auto-prompts pull before the
user attempts a doomed commit. The 409 / 422 path is the safety
net for missed events or offline tabs.

End-to-end walkthrough: `scenarios.md` DN-m.

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

## Linear trunk + `graph_trunk_log`

V1 separates the parent DAG (every branch, every parent edge) from
the trunk index (just `default_branch` commits, indexed by time).
Trunk commits are single-parent by construction; merges from a
draft branch land via squash with a non-parent provenance pointer
(next section). Why:

- O(1) blame / history walk on `main` — no DAG traversal needed to
  identify trunk commits.
- Predictable `/as_of?at=` via a single indexed lookup
  (decision 26) instead of "find the latest trunk-reachable commit
  at-or-before T in the parent DAG."
- Forensic-readable history for compliance — every line on `main`
  has exactly one parent and one author column on
  `graph_commits.author` (the squasher), with the original draft
  contributors preserved in `graph_commit_contributors` (next
  section).

**The squash gate** lives in `graph_commit_repo.persist_commit`
(`graph_commit_repo.py:150-151`):

```python
if is_default_branch:
    extra_parent_ids = None   # trunk is single-parent
```

`is_default_branch` is set by the merge orchestrator when
`target_branch == graph.default_branch`
(`graph_merge_service._persist_merge_commit:699`). Direct commits
to `main` pass through without merge: the same gate is a no-op
because no `extra_parent_ids` are passed in the first place.

**The trunk index** is `graph_trunk_log` — insert-only, schema in
`models_graph.py:715-742`:

```
graph_trunk_log
  ├─ id, graph_id, commit_id
  ├─ commit_seq                    monotonic per-graph
  ├─ committed_at                  indexed for /as_of
  └─ INDEX: (graph_id, committed_at)   idx_trunk_log_committed_at
```

Atomic append happens inside `persist_commit` in the same
transaction as the commit row + ref advance + audit + outbox
(`graph_commit_repo.py:319-329`). The pure-trunk constraint means
this table is the **authoritative trunk timeline** — readers
don't filter `graph_commits` by parent-chain shape, they read this
table.

### Squash semantics on trunk

When a draft branch merges into the default branch the trunk
commit needs (a) single-parent shape, (b) a non-parent pointer to
the draft tip so the original chain is traceable, (c) every
per-attribute audit row from the draft chain re-stamped under the
new trunk commit so `/blame` returns the original author, and
(d) a contributor manifest aggregating per-actor op counts.
Decisions 23-25.

Code paths:

1. `graph_merge_service._persist_merge_commit:617` detects squash
   via `is_squash = (target == graph.default_branch)`.
2. Calls `persist_commit(..., is_default_branch=is_squash,
   merge_source_commit_id=source_head,
   merge_source_branch=source_branch_name)`.
3. The squash gate (above) drops `extra_parent_ids`; the trunk
   commit row carries `parent_ids=[target_head]` (single parent)
   plus the new non-parent columns
   `merge_source_commit_id` + `merge_source_branch`
   (`models_graph.py:187-188`).
4. After commit insert, `_copy_squashed_audit_and_contributors`
   (`graph_merge_service.py:717`) walks the draft chain from
   `source_commit_id` back to `base_commit_id` collecting commit
   ids, then for each draft commit:
   - Re-inserts every `graph_change_event` row stamped with the
     **new trunk commit_id** but preserving the original
     `actor`, `committed_at`, `attribute_path`,
     `prev_content_hash`, `new_content_hash`. `/audit?commit_id=
     <trunk>` and `/blame` then return the original draft author.
   - Aggregates per-actor `ops_count` into
     `graph_commit_contributors` via
     `INSERT ... ON CONFLICT (commit_id, actor) DO UPDATE SET
     ops_count = ops_count + EXCLUDED.ops_count`
     (`models_graph.py:743-768`).

**Direct-main commit carve-out.** A user can commit directly to
`main` without going through a draft branch. The commit endpoint
takes the same path but with no merge — `is_default_branch=True`
still triggers the trunk_log append, but
`merge_source_commit_id` / `merge_source_branch` remain NULL and
no audit-copy step fires (there's no draft chain to copy from).
The original `graph_change_event` rows from that commit already
carry the correct `commit_id`. `graph_commit_contributors` is
single-row for direct-main commits.

**Why provenance is non-parent, not extra parent.** Two reasons:
(a) a future draft-branch GC can prune unreachable commits without
breaking the provenance link (drafts merged to main are usually
ephemeral), and (b) parent-chain walks (blame, ancestry) stay
strictly linear on trunk — provenance is a query-able sidecar,
not a graph edge.

End-to-end walkthrough: `scenarios.md` DN-n.

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

## FalkorDB projector for `authored_<graph_id>`

Code: `backend/app/services/graph_falkor_projector.py`.

The V1 hot projection for the read-routing-matrix top row. Each
graph's `main` HEAD lives in a per-graph FalkorDB namespace
`authored_<graph_id>` — never the shared `nexus_lineage` namespace
used by external lineage. Per-graph isolation means an authored
graph can't pollute lineage keys, and a corrupted projection can
be dropped + replayed without affecting any other graph.

**Pipeline per `visualization.graph.committed` event:**

1. `run_falkor_projector` (`graph_falkor_projector.py:93`) does an
   `XREADGROUP` on the `graph.outbox` Redis stream as consumer
   group `falkor_projector_v1`, count 32, blocking poll.
2. `_process_event` (`graph_falkor_projector.py:194`) decodes the
   payload and applies a strict default-branch filter — reads the
   graph's `default_branch` from Postgres (cached in
   `_ProjectorState`) and silently ACKs any event whose `branch`
   isn't the default. Draft-branch commits stay in cold storage
   only.
3. **Idempotency guard** against `graph_projector_cursor` keyed by
   `(graph_id, target='falkordb')` (`models_graph.py:770-786`). If
   `last_applied_commit_seq >= this commit's commit_seq`, ACK and
   skip. Replays converge because (a) the cursor advances strictly
   monotonically and (b) Cypher MERGE on `urn` is itself idempotent.
4. Read `graph_change_event` rows for the commit + the resulting
   content blobs from `graph_node_versions` /
   `graph_edge_versions` keyed by `new_content_hash`.
5. `_apply_to_falkor` (`graph_falkor_projector.py:451`) batches the
   deltas by kind + action and emits one Cypher query per chunk of
   `_BATCH_SIZE=1000` rows:

   ```cypher
   UNWIND $rows AS r
   MERGE (n:Node {urn: r.urn})
   SET   n.entity_type  = r.entity_type,
         n.display_name = r.display_name,
         n.properties   = r.props_json,  // JSON string (Falkor primitive)
         n.tags         = r.tags_json,
         n.position     = r.position_json,
         n.content_hash = r.content_hash
   ```

   Edges use `MERGE (s)-[e:CONNECTS {urn: r.urn}]->(t)` with
   `edge_type` as a property. V1 uses a uniform schema (single
   `:Node` label, single `:CONNECTS` relationship) so projection
   doesn't have to generate dynamic Cypher per entity-type;
   higher-fidelity per-label projection is a v2 enhancement gated
   on actual query patterns.

6. **Strict apply order**: node-upsert → edge-upsert → edge-delete
   → node-delete. A node being deleted in the same commit as edges
   that reference it is detached cleanly: edges go away first.

7. Cursor advances (commit_seq, commit_id, stream_id,
   lag_seconds_observed) in Postgres in its own transaction after
   FalkorDB succeeds; the stream entry is then XACK'd. Order
   matters — the cursor is the durable ledger; the Redis XACK is
   the optimisation. If Falkor succeeds but XACK fails, the next
   poll re-reads the entry, the cursor short-circuits the work,
   and XACK retries.

**Failure modes (best-effort):**

- FalkorDB unreachable mid-apply → exception bubbles up to the
  outer loop; cursor stays put; the stream entry stays in the
  consumer group's pending list. Next poll retries with
  exponential backoff (`_BACKOFF_MIN_S=0.5` … `_BACKOFF_MAX_S=30`).
  Reads of `main` HEAD raw queries transparently fall back to
  `snapshot_reader.load_snapshot` against Postgres while the
  projector is paused. Correctness intact; hot-path latency
  degrades.
- Postgres unreachable → projector can't decode the event payload;
  same backoff loop. The outbox relay itself paused, so no new
  events fan in.
- Malformed payload → ACK + drop; logged once at warning. Doesn't
  block the queue.

**Multi-target extensibility.** `graph_projector_cursor.target` is
a free-form text column with `UNIQUE(graph_id, target)`. Future
projectors (read-replica, analytics warehouse, search index) slot
in as new rows with `target='warehouse'`, `target='search'`, etc.
— they share the cursor model, the consumer-group pattern, and
the idempotency contract without schema churn.

End-to-end walkthrough: `scenarios.md` DN-p.

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

graph_trunk_log                   ◀── trunk-only date index (V1-4)
  ├─ id, graph_id, commit_id
  ├─ commit_seq                   (monotonic per-graph)
  ├─ committed_at                 (indexed)
  └─ INDEX: (graph_id, committed_at)   idx_trunk_log_committed_at

graph_commit_contributors         ◀── per-actor manifest (V1-3)
  ├─ commit_id (PK)
  ├─ actor (PK)
  └─ ops_count                    (incremented on squash)

graph_projector_cursor            ◀── multi-target projection state (V1-5)
  ├─ graph_id, target             (PK; target='falkordb' in V1)
  ├─ last_applied_commit_seq
  ├─ last_applied_commit_id
  ├─ last_stream_id               (Redis XACK reference)
  ├─ lag_seconds_observed
  ├─ last_error
  └─ updated_at
```

The two V1 columns added to `graph_commits` itself:

```
graph_commits  (extended; see models_graph.py:187-188)
  ├─ merge_source_commit_id       (non-parent provenance; V1-2)
  └─ merge_source_branch          (non-parent provenance; V1-2)
```

Both are NULL on direct-main commits; both are set on squash
merges by `_persist_merge_commit`. Partial index
`idx_commits_merge_source` (where `merge_source_commit_id IS NOT
NULL`) supports "which trunk commit landed this draft?" lookups
without scanning the full commit table.

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
| `no_trunk_commit_at_or_before` | 404 | `get_graph_as_of` | `/as_of?at=<T>` where `T` precedes the genesis trunk commit |

The pull endpoint (V1-6) does NOT return errors in the normal
case: conflicts are part of the success response shape, not error
envelopes. The two HTTP errors it can still raise are the standard
`404 not_found` (graph deleted) and 403 (RBAC). Successful pull
responses always carry:

```
{
  "previous_base": "gcmt_OLD | null",
  "new_base":      "gcmt_NEW | null",
  "rebased":       <int>,
  "dropped":       <int>,
  "conflicts":     [{object_kind, object_id, conflict_class, ...}]
}
```

The four `conflict_class` values are `edit_edit`, `edit_delete`,
`delete_edit`, `add_add` (see § "V1 collaboration model" for the
classification table). The frontend renders conflicts in the
resolver UI; staged ops stay in the working set with their
original `base_content_hash` until the user resolves and
re-commits.

## What's deferred and why

- **PR endpoints (Phase 2.5)** — the schema is in place and
  `pr_policy` is pure and tested. The UI work to drive PR review is
  the next user-visible deliverable; we'd rather ship the API
  surface alongside.
- **Fork endpoint + blob copy worker (Phase 2.5)** — schema in
  place. Blob copy is async-friendly (content addressing makes it a
  pure stream from one graph to another); needs a worker process to
  avoid blocking the request.
- **Per-draft FalkorDB namespaces (Phase 2)** — the V1 projector
  covers each graph's `main` HEAD only. Reads of non-default
  branches transparently fall back to
  `snapshot_reader.load_snapshot` against Postgres (correct,
  slower). The multi-target cursor (`graph_projector_cursor`)
  already accommodates this — Phase 2 adds rows with
  `target='falkordb_draft_<branch>'` against the same machinery.
- **PullChangesDialog visual component (Phase 2)** — the V1-6
  pull/rebase backend is functional and the frontend
  `graphEditorStore` contract is stable (`pendingConflicts`,
  `dismissConflict`). The visual ours/theirs conflict resolver UI
  is the next user-visible deliverable.
- **Draft-branch GC (Phase 2)** — a sweep over commits that are
  unreachable from any live ref AND from any
  `merge_source_commit_id`. Squash provenance is non-parent
  precisely so this sweep stays simple. Operational, not a
  correctness gap.
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
