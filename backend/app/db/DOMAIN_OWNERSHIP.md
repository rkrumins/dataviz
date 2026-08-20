# Synodic — Logical Domain Ownership Map

> Authoritative table-to-domain assignment *within the monolith*. Synodic
> is one service, one Postgres instance, one codebase. These domains are
> **logical module boundaries** — the rule that module A doesn't reach
> into module B's tables — not promises of future extraction.
>
> Code reviews + CI lint enforce the boundary. Lint:
> [`backend/scripts/check_cross_domain_joins.py`](../../scripts/check_cross_domain_joins.py).

## Why bother in a monolith

Clean module boundaries pay off regardless of whether the monolith ever
splits:

1. **Cross-domain JOINs are forbidden in app code.** A query in
   module X that joins to module Y is a tight coupling. The lint
   surfaces it at PR time so the team chooses coupling explicitly
   rather than accidentally.
2. **Cross-domain references use IDs only.** A view's `created_by`
   is a user_id string; its display name is resolved by the identity
   module's own API, not by JOINing from the visualization module.
3. **Cross-domain state changes propagate via outbox events.** When
   an ontology is published, an `ontology.published` event lands in
   `outbox_events` (same DB transaction as the publish). Any
   cross-module reaction subscribes — no direct table reads.

**Extraction is a future option, not a roadmap item.** See
[`docs/architecture-when-scaling.md`](../../../docs/architecture-when-scaling.md)
for the conditions that would flip extraction on. Until then, treat
each domain as a well-fenced module in one service.

## The map

| Domain | Owned tables | Notes |
|---|---|---|
| **identity** | `users`, `user_roles`, `user_approvals`, `revoked_refresh_jti`, `refresh_tokens` | PII boundary — `email`, `password_hash`, `metadata` live here and only here. |
| **workspace** | `workspaces`, `workspace_data_sources`, `assignment_rule_sets` | Tenancy boundary — `workspace_id` is THE tenant identifier. |
| **provider** | `providers`, `catalog_items` | Pure infrastructure — no tenant data, no PII. |
| **ontology** | `ontologies`, `ontology_audit_log`, `ontology_source_mappings` | Versioned + immutable audit log. `revision` is the optimistic concurrency token. |
| **visualization** | `context_models`, `views`, `view_favourites` | References ontology + workspace by ID only. `ontology_digest` captures schema fingerprint at save time. |
| **aggregation** | `aggregation_jobs`, `data_source_polling_configs`, `reconcile_runs` | Job lifecycle. Hot writes (checkpoints). `reconcile_runs` is one row per reconciliation sweep (not per data source), trimmed to 30 days. |
| **stats** | `data_source_stats`, `data_source_count_snapshots` | `data_source_stats` is a read-mostly cache, tolerant of staleness. `data_source_count_snapshots` is its append-only twin — one row per observed change (plus an hourly heartbeat), purged by age and per-source cap. It carries denormalised `workspace_id`/`provider_id` so the per-provider rollup never JOINs out of this domain. |
| **platform** | `feature_flags`, `feature_categories`, `feature_definitions`, `feature_registry_meta`, `announcements`, `announcement_config`, `management_db_config`, `schema_migrations` | Reference + global config. |
| **events** | `outbox_events` | Cross-domain contract. Every domain writes here; consumers drain. |
| **legacy (deprecated)** | `graph_connections` | Do not write to it. Slated for removal. |

## Cross-domain references — by-ID only

These are app-layer references (no DB FK across schemas). They become
unenforceable once domains are extracted, so we treat them as such
already:

| From → To | Column | Resolution path |
|---|---|---|
| workspace → provider | `workspace_data_sources.provider_id` | Workspace stores the id. Provider deletion: subscribe to `provider.deleted` event and null the reference, or block the delete in the workspace domain via prior validation. |
| workspace → ontology | `workspace_data_sources.ontology_id` | Same pattern. `ontology.deprecated` → workspace surfaces a banner. |
| workspace → catalog item | `workspace_data_sources.catalog_item_id` | Same pattern. |
| aggregation → workspace | `aggregation_jobs.data_source_id` | Aggregation resolves workspace via `workspace_data_sources.workspace_id` today (lint-flagged cross-domain JOIN in `service.py:list_jobs_global`). When a real tenant-filtering query is needed, add a denormalised `workspace_id` column then — not before. |
| visualization → workspace | `views.workspace_id`, `views.data_source_id` | `views` owns its own `workspace_id` FK (intra-schema). |
| stats → workspace | `data_source_stats.data_source_id`, `data_source_count_snapshots.{data_source_id,workspace_id}` | `data_source_stats` does not need workspace awareness. The snapshot table denormalises `workspace_id`/`provider_id` at capture time — the "add a denormalised column when a real tenant-filtering query is needed" case above — so the per-provider history rollup reads the stats domain alone. It also has no FK: an audit trail must outlive the row it describes. |
| identity → identity | `user_roles.user_id`, `user_approvals.user_id` | Intra-domain — keep DB FK forever. |
| visualization → visualization | `views.context_model_id`, `view_favourites.view_id` | Intra-domain. |
| ontology → ontology | `ontology_audit_log.ontology_id`, `ontology_source_mappings.ontology_id` | Intra-domain. |

## Outbox event-type contract

All events follow `<domain>.<entity>.<verb>` (lowercase, dot-separated).
The helper in
[`outbox_event_repo.emit`](repositories/outbox_event_repo.py) enforces
this at write time. Examples:

- `workspace.created`, `workspace.deleted`, `workspace.updated`
- `provider.registered`, `provider.deleted`, `provider.health_changed`
- `ontology.published`, `ontology.deprecated`, `ontology.deleted`
- `view.created`, `view.deleted`, `view.published`
- `user.approved`, `user.suspended`, `user.deleted`
- `aggregation.job.dispatched`, `aggregation.job.completed`, `aggregation.job.failed`
- `platform.feature_flag.changed`, `platform.announcement.published`

When the payload schema changes incompatibly, bump `event_version`
on the emit call so consumers can branch.

## Adding a new domain

1. Add the domain key to `_VALID_DOMAINS` in
   [`outbox_event_repo.py`](repositories/outbox_event_repo.py).
2. Add the domain row + tables to the table above.
3. If the new domain owns data with cross-domain consumers, document
   the by-ID resolution path in the cross-domain table.
4. Add the lint allowlist entry in
   [`backend/scripts/check_cross_domain_joins.py`](../../scripts/check_cross_domain_joins.py)
   for any intra-domain joins that span new tables.

## Adding a new table to an existing domain

1. Add the model under the right `# ----- <domain> -----` section in
   [`models.py`](models.py) (or the service-package-local model file
   for service-private tables, e.g.
   [`services/aggregation/models.py`](../services/aggregation/models.py)).
2. Add the table name to the corresponding row in the table above.
3. If the table has cross-domain references, store the referenced id
   as a plain column (no FK across schemas once extraction happens).
   Do not add denormalised tenancy columns speculatively — wait until
   a real query needs them.
4. If the table participates in domain events, emit them via
   `outbox_event_repo.emit` — never `session.add(OutboxEventORM(...))`
   ad-hoc.

## Known cross-domain debt (lint baseline = 12)

The lint surfaces **12 pre-existing cross-domain JOINs** in the
codebase as of the schema-optimization branch. They are not bugs — the
code works today — but each is a place that would need refactoring
before its domain can be extracted to a separate process. CI runs the
lint with `--baseline 12`; the count must not grow:

```bash
python backend/scripts/check_cross_domain_joins.py --baseline 12
```

When you pay one down, decrement the baseline. When the count reaches
zero, switch to `--strict`.

| Hotspot | Cross-domain pair | Suggested resolution |
|---|---|---|
| `services/aggregation/service.py` | aggregation ↔ workspace | `list_jobs_global` joins `aggregation_jobs → workspace_data_sources → workspaces` to enrich results with workspace name. When this becomes a bottleneck, either denormalise `workspace_name` onto the job row at creation time, or move the enrichment to a workspace-API call. Not a bug today. |
| `db/repositories/view_repo.py` | visualization ↔ workspace | Use `views.workspace_id` directly; for workspace name, fetch via the workspace module's API. |
| `db/repositories/catalog_repo.py` | visualization ↔ workspace | Same pattern. |
| `db/repositories/provider_repo.py` | provider ↔ workspace / visualization | Provider-impact endpoint reads workspace + visualization tables — should use outbox event subscriptions to maintain a per-provider impact projection. |
| `api/v1/endpoints/catalog.py` | provider ↔ workspace | Same pattern. |
| `ontology/adapters/sqlalchemy_repo.py` | ontology ↔ workspace | Reading workspace data sources to find which workspaces use an ontology — should be reversed: workspace domain queries ontology by id, not the other way around. |
| `services/aggregation/probe_scheduler.py` | stats ↔ workspace | Annotated `# noqa: cross-domain` (not in the count). The due-query joins `workspace_data_sources → data_source_stats` because `stats.last_probed_at` is the probe cadence clock. Read-only, bounded by `AGGREGATION_PROBE_SCAN_CAP`. To pay down: denormalise `last_probed_at` onto `aggregation.data_source_state`. |
| `services/aggregation/reconcile_sweeper.py` | provider ↔ workspace | Annotated `# noqa: cross-domain` (not in the count). `_batch_context` joins `workspace_data_sources → providers` for the provider NAME that labels findings; read-only, ≤ `_SCAN_CAP` rows per tick. To pay down: same denormalise-the-name pattern as `list_jobs_global`. |

## What this map does NOT do

- It does not move tables to Postgres schemas yet. The schema-namespace
  migration (originally Phase 1.5 §1.5.2) is **deferred** until the
  cross-domain join lint is clean and stable. Today the boundary is
  enforced by review + lint, not by schema separation.
- It does not turn the monolith into microservices. It makes that
  refactor possible without a rewrite when ops capacity allows
  (Phase 6.5 onward).
- It does not eliminate cross-domain reads from the database — only
  from app code. The DB itself happily serves whatever the app asks
  for; the lint is what stops bad asks from landing.
