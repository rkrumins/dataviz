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
       └──────────────────────┘
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
- **Hot projection per-branch namespace** — Phase 2 materialization
  worker. Without it, canvas reads fall back to the cold store
  (current behaviour; correct but slower).
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
