# Authored Graphs — backend design

User-authored, versioned graphs with full audit, view-as-branch
binding, and a connected-source layered model. This directory
documents the **backend implementation as of `f755180`**.

## What lives here

| File | Audience | Contents |
|---|---|---|
| `README.md` (this file) | Anyone touching authored-graph code | Decisions, layer cake, doc index. |
| `architecture.md` | Backend / platform engineers | Two-DB model, layered source/enrichment composition, content addressing, view-as-branch policies, outbox + SSE, what's deferred and why. |
| `api-reference.md` | Frontend, integrators | Every endpoint: route, body, response, error envelopes, RBAC. |
| `scenarios.md` | Anyone debugging or extending a flow | Every Day-0 and Day-N scenario as a complete walkthrough: endpoints called, payloads, backend code flow with `file:line` citations, audit footprint, edge cases. |

## Confirmed product decisions

These are the **22 architectural decisions** the implementation is
built around. Changing any of these is a breaking design change —
document it in this file when it happens.

1. **Git-style collaboration** — per-`(user, branch)` isolated
   working copy; explicit commits; three-way merge across branches.
   No shared live working set.
2. **Append-only history** — commits + audit events are immutable;
   no in-place edits.
3. **Two databases** — management DB (workspaces, views, ontologies,
   RBAC) is separate from the Graph Store DB (graphs, refs, commits,
   blobs, audit, working sets, source layer, merges). **No FKs
   across the boundary.** Soft references only.
4. **Content addressing + Merkle manifest** — every node/edge blob
   is keyed by a SHA-256 content_hash; per-graph partition manifests
   roll up into a root_hash that identifies the graph state.
5. **Per-attribute audit** — `graph_change_event` carries
   `prev_content_hash` and `new_content_hash` so blame can show
   "alice changed display_name in c1; bob added pii tag in c2" by
   diffing two adjacent blobs.
6. **Optimistic concurrency on refs** — commits CAS-advance the
   `(commit_id, revision)` of the target branch ref. Conflicting
   commits raise `HeadMovedError → 409`.
7. **Working-set base-content-hash re-check at commit** — every
   staged update/delete carries the base blob's content_hash and is
   re-verified at commit time against the live snapshot. Lost-update
   protection on individual fields.
8. **Working-set coalescing matches frontend** — re-staging the same
   object replaces the prior op; `add → delete` of an uncommitted
   object **drops** the row (cancels out), not "delete of nonexistent"
   at commit time.
9. **Strict-mode ontology validation at commit** — strict graphs
   reject commits that introduce nodes/edges of types absent from the
   bound ontology, or containment cycles, or dangling edges.
10. **Schemaless mode permitted** — graphs can opt out of strict
    validation; the engine still enforces structural invariants
    (dangling edges, containment cycles) but allows arbitrary
    `entity_type` / `edge_type` strings.
11. **Per-graph workspace ownership** — every `UserGraphORM` belongs
    to exactly one workspace; cross-workspace shares route through
    `view_grants` (Phase 2C).
12. **Outbox + relay** — every commit writes a `graph_outbox_events`
    row in the same transaction; a relay process drains it into a
    Redis stream for SSE fan-out (at-least-once).
13. **SSE last-event-id resumable** — clients reconnecting carry
    `Last-Event-ID`; the stream rewinds to that cursor in Redis.
14. **Per-user working-set SSE filter** — `working_set.advanced`
    events carry `user_id` so only the originating user's tabs
    react; other users see only `graph.committed`.
15. **Cold store wins; hot projection is disposable** — SQL Graph
    Store is system-of-record. FalkorDB (hot projection) is
    rebuildable from any commit; staleness or loss is recoverable.
    Phase 2 worker rebuilds projections per branch namespace.
16. **View-as-branch** — every editable view binds to exactly one
    `(graph_id, branch)`. Opening the view IS opening that branch.
    Save = commit on that branch.
17. **`per_view` is the default branching policy** —
    `{shared_main, per_view, per_user_per_view}`. Default `per_view`:
    one branch per view shared across editors. `per_user_per_view`
    isolates per editor. `shared_main` is force-edit-trunk.
18. **Auto-create the view's branch on first edit-mode entry** —
    forked from `merge_target_branch` head. Idempotent.
19. **`view_id` on every audit row** — per-view audit is an indexed
    lookup, not a branch→view JOIN.
20. **Publish = PR from view branch to merge_target** — same engine
    as cross-branch merge.
21. **Mode-2 source layer for connected graphs** — `graph_source_*`
    tables materialise the upstream provider's view; user edits
    accumulate as enrichments (`graph_node_versions`, etc.);
    composition merges the two at read time. Upstream system stays
    source-of-truth for source data; we keep our copy of every
    enrichment with full audit.
22. **Hot projection is per-branch namespace** — Phase 2
    materialization worker creates one FalkorDB namespace per active
    branch so views read the right scope.
23. **Linear trunk invariant (V1-1).** Every commit on the graph's
    `default_branch` has exactly one parent. The squash gate at
    `graph_commit_repo.py:150-151` drops `extra_parent_ids` when
    `is_default_branch=True` — trunk history is a chain, not a DAG.
    Multi-parent merges live only on draft branches; landing them on
    trunk happens via squash with a non-parent provenance pointer
    (decision 24). Why: O(1) blame walks, predictable `/as_of`,
    forensic-readable history for compliance.
24. **Squash provenance pointer (V1-2).** When a draft branch is
    merged into the default branch, the resulting trunk commit
    carries `merge_source_commit_id` (the draft tip) and
    `merge_source_branch` (the draft name) as non-parent columns on
    `graph_commits` (`models_graph.py:187-188`). They are GC-safe
    (a future draft-GC sweep can prune the draft chain without
    breaking the link), they don't show up in parent-chain walks, and
    they're set by `graph_merge_service._persist_merge_commit:699`
    only when `target == graph.default_branch`.
25. **Wave 6 audit-row copy + contributor manifest (V1-3).** On
    squash, every `graph_change_event` from the draft chain is
    re-stamped onto the new trunk commit (preserving original actor /
    timestamp / attribute_path) so `/blame` on any touched node
    still returns the original draft author, not the merger.
    Per-actor `ops_count` rolls up into `graph_commit_contributors`
    via `INSERT ... ON CONFLICT (commit_id, actor) DO UPDATE`,
    implemented in
    `graph_merge_service._copy_squashed_audit_and_contributors:717`.
    Squash compresses the *parent graph*, never the audit detail.
26. **`graph_trunk_log` — trunk-only date index (V1-4).** Insert-
    only table appended atomically inside the same transaction as
    every default-branch commit (`graph_commit_repo.py:319-329`).
    Backs `/as_of?at=`: one indexed lookup (`idx_trunk_log_committed_at`,
    `models_graph.py:736`) + one snapshot read. SCD2 lineage tables
    are explicitly killed; trunk_log is the trunk index, the parent
    DAG is the source-of-truth, and `snapshot_reader.load_snapshot`
    materializes any point in time.
27. **FalkorDB per-graph hot projection of main HEAD (V1-5).**
    `graph_falkor_projector` subscribes to `graph.outbox`, filters
    to commits on each graph's `default_branch`, and projects them
    into a per-graph FalkorDB namespace `authored_<graph_id>` —
    never the shared `nexus_lineage` namespace used by external
    lineage. Idempotent replay via `graph_projector_cursor` keyed by
    `(graph_id, target)` so the cursor table extends to future
    read-replica / warehouse / search projectors without schema
    churn. Batched `UNWIND … MERGE` / `DELETE` Cypher at
    `_BATCH_SIZE=1000` rows so million-node commits don't blow up
    FalkorDB. Decision 15 still holds — the cold Postgres store is
    system-of-record; FalkorDB is rebuildable.
28. **Functional pull endpoint, not "refresh to continue" (V1-6).**
    `POST …/working-set/pull` re-anchors the caller's working set
    against the current HEAD with per-entity conflict classification
    (`edit_edit` / `edit_delete` / `delete_edit` / `add_add`).
    Conflicted ops stay in the working set with their **original**
    `base_content_hash` so the resolver UI can render ours/theirs
    and the user does NOT lose work. delete/delete coincidences
    drop silently. Multi-user collaboration on a shared branch is
    Git-flow (pull → resolve → commit), explicitly not Google-Docs
    CRDT real-time co-editing.
29. **Time-travel via DAG + date index, not SCD2 (V1-9).**
    `GET /{ws_id}/graphs/{graph_id}/as_of?at=<iso8601>` does one
    indexed lookup in `graph_trunk_log` (committed_at ≤ at) + one
    `snapshot_reader.load_snapshot`. Wave 5 SCD2 lineage tables
    rejected — content addressing + parent DAG already encode every
    historical state at full fidelity. Time-travel is a query over
    existing data, not a separate denormalised projection to
    maintain.

## Layer cake

```
                ┌──────────────────────────────────────┐
                │   Frontend canvas + history + diff   │
                └──────────────────────────────────────┘
                                  │ HTTP + SSE
                                  ▼
                ┌──────────────────────────────────────┐
                │  endpoints/graphs.py + views.py      │
                │  RBAC, request shaping, error envelope│
                └──────────────────────────────────────┘
                                  │
       ┌────────────────────┬─────┴─────┬───────────────────────┐
       ▼                    ▼           ▼                       ▼
  GraphAuthoringEngine   view_binding   graph_merge_service   graph_source_sync_service
  (stage / commit /      _service       (LCA, plan, commit)   (provider → source layer)
   history / create)
       │                    │           │                       │
       └──────────┬─────────┴───────────┴───────────┬───────────┘
                  ▼                                  ▼
       ┌──────────────────────┐         ┌────────────────────────┐
       │   Graph Store DB     │         │     management DB      │
       │   (Postgres)         │         │     (Postgres)         │
       │                      │         │                        │
       │  user_graphs         │         │  workspaces            │
       │  graph_refs          │         │  views (incl.          │
       │  graph_commits       │         │    source_graph_id,    │
       │  graph_node_versions │  ◀──────│    branching_policy)   │
       │  graph_edge_versions │         │  workspace_data_sources│
       │  graph_partition_*   │         │  ontologies            │
       │  graph_change_event  │         │  roles + bindings      │
       │  graph_working_set   │         └────────────────────────┘
       │  graph_working_change│                      ▲
       │  graph_merge[_conflict]                     │
       │  graph_pull_request*                        │
       │  graph_source_snapshots                     │
       │  graph_source_nodes                         │
       │  graph_source_edges                         │
       │  graph_orphan_enrichments                   │
       │  graph_outbox_events ─────► relay ─► Redis ─┴─► SSE
       │  graph_trunk_log     │        │              │
       │  graph_commit_       │        │              ▼
       │   contributors       │        │      ┌───────────────────┐
       │  graph_projector_    │        │      │ graph_falkor_     │
       │   cursor             │        │      │ projector  (V1-5) │
       └──────────────────────┘        │      │ default-branch    │
                                       └─────►│ commits → Cypher  │
                                              │ UNWIND MERGE/     │
                                              │ DELETE into       │
                                              │ authored_<g_id>   │
                                              └───────────────────┘
                                                      │
                                                      ▼
                                              ┌───────────────────┐
                                              │  FalkorDB         │
                                              │  authored_<g_id>  │
                                              │  (main HEAD only) │
                                              └───────────────────┘
```

Three layers stacked at read time for connected graphs:

```
   Composed view    ◀── compose_snapshot(source, enrichment)
        ▲
        │ enrichment wins on field overlap; tags union; tombstones suppress
        │
   ┌────┴──────────┐       ┌─────────────────┐
   │ enrichment    │       │ source layer    │
   │ (our edits)   │       │ (upstream view) │
   │ versioned via │       │ refreshed via   │
   │ commits +     │       │ sync runs       │
   │ audit events  │       │ + snapshots     │
   └───────────────┘       └─────────────────┘
```

## What's intentionally not built (yet)

These are documented in `architecture.md`; here for at-a-glance
clarity:

- **Fork + PR API** — schema + pure pr_policy logic ready; no
  endpoints. Phase 2.5 work item.
- **Cross-graph merge** — the merge engine is graph-agnostic; the
  orchestrator constrains to same-graph this round.
- **Genesis-import as a worker process** — Mode-2 sync is inline at
  the endpoint MVP. Phase 2.5 promotes to a background worker.
- **Cron-scheduled source refresh** — manual trigger only this round.
- **Publish-back to external systems** — Mode-2 keeps our copy of
  enrichments; pushing them back to DataHub/OpenMetadata is the
  `publish_runs` machinery in plan §C.7. Designed, not built.
- **Federated overlay (mode-3)** — no materialisation, runtime
  composition only. Phase 3.
- **Per-draft FalkorDB ephemeral namespaces** — the V1 projector
  (decision 27) covers each graph's `main` HEAD only. Reads of
  non-default branches fall back to `snapshot_reader.load_snapshot`
  against Postgres (correct, slower). Spinning up
  `authored_<g_id>_<branch>` namespaces per active draft is a
  follow-on once branch read traffic justifies it.
- **PullChangesDialog visual component** — the pull/rebase backend
  (decision 28) is functional and the store contract
  (`pendingConflicts`, `dismissConflict`) is stable; the visual
  ours/theirs conflict resolver UI is the next user-visible
  deliverable.
- **Draft-branch GC** — a sweep over commits that are unreachable
  from any live ref AND from any `merge_source_commit_id`. Squash
  provenance (decision 24) keeps the linkage non-blocking; the
  sweep itself is operational work, not a correctness gap.
- **Blame across enrichment + source-sync** — `graph_change_event`
  is enrichment-only by design; a "blended audit" union query is
  Phase 2.5.

## Maintenance contract

When you change one of these decisions or ship a new endpoint:

1. Update the relevant section here AND in the affected
   `scenarios.md` walkthrough.
2. If the schema changes, add the migration alongside the existing
   `0005_source_layer.py` and the ORM mirror; mention it in
   `architecture.md` § "Schema".
3. If RBAC changes, update the permission column in
   `api-reference.md`.
4. Run the backend test suite — every doc claim has a pinning test
   somewhere in `backend/tests/test_graph_*.py`. If a test
   disappears, the doc is now lying.
