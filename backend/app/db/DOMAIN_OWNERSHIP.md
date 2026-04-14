# Synodic — Domain Ownership Map

> Authoritative table-to-domain assignment. Code reviews enforce this contract.
> A PR that has one domain reading or writing another domain's table is
> rejected without an event-driven (outbox) alternative.
>
> Established in Phase 1.5 §1.5.1 of the schema-optimization plan
> ([serene-launching-russell.md](~/.claude/plans/serene-launching-russell.md)).
> Lint enforced by [`backend/scripts/check_cross_domain_joins.py`](../../scripts/check_cross_domain_joins.py).

## Why this exists

Synodic is a single Postgres v16 database today. The plan's Phase 1.5
adopts schema discipline that lets each domain become its own service
later **without a forklift rewrite**. Three guarantees follow from
this map:

1. **Cross-domain JOINs are forbidden in app code.** A query in
   domain X that joins to domain Y becomes structurally impossible
   once the domains live in separate processes/databases. The lint
   catches this at PR time, not at extraction time.
2. **Cross-domain references use IDs only.** A view's
   `created_by` is a user_id string; it is never resolved by JOIN
   to `users.email` from the visualization domain. The identity
   domain's API resolves names.
3. **Cross-domain state changes propagate via outbox events.**
   When ontology publishes, a `ontology.published` event lands in
   `outbox_events` (same DB transaction as the publish). Any other
   domain that needs to react subscribes — never reads the ontology
   table directly.

The `workspace_id` denormalization on transactional tables (Phase
1.5 §1.5.4) makes "all aggregation jobs for tenant X" answerable
**within the aggregation domain alone** — no JOIN through workspace.

## The map

| Future service | Owned tables | Notes |
|---|---|---|
| **identity** | `users`, `user_roles`, `user_approvals`, `revoked_refresh_jti` | PII boundary — `email`, `password_hash`, `metadata` never replicate to other services. |
| **workspace** | `workspaces`, `workspace_data_sources`, `assignment_rule_sets` | Tenancy boundary — `workspace_id` is THE tenant identifier. |
| **provider** | `providers`, `catalog_items` | Pure infrastructure — no tenant data, no PII. |
| **ontology** | `ontologies`, `ontology_audit_log`, `ontology_source_mappings` | Versioned + immutable audit log. `revision` column is the optimistic concurrency token. |
| **visualization** | `context_models`, `views`, `view_favourites` | References ontology + workspace by ID only. `ontology_digest` captures schema fingerprint at save time. |
| **aggregation** | `aggregation_jobs`, `data_source_polling_configs` | Job lifecycle. Hot writes (checkpoints). Future: extract to its own DB tier (Phase 6.5). |
| **stats** | `data_source_stats` | Read-mostly cache. Tolerant of staleness. |
| **platform** | `feature_flags`, `feature_categories`, `feature_definitions`, `feature_registry_meta`, `announcements`, `announcement_config`, `management_db_config`, `schema_migrations` | Reference + global config. |
| **events** | `outbox_events` | Cross-domain contract. Every domain writes here; the relay drains it. |
| **legacy (deprecated)** | `graph_connections` | To be removed. Do not write to it. |

## Cross-domain references — by-ID only

These are app-layer references (no DB FK across schemas). They become
unenforceable once domains are extracted, so we treat them as such
already:

| From → To | Column | Resolution path |
|---|---|---|
| workspace → provider | `workspace_data_sources.provider_id` | Workspace stores the id. Provider deletion: subscribe to `provider.deleted` event and null the reference, or block the delete in the workspace domain via prior validation. |
| workspace → ontology | `workspace_data_sources.ontology_id` | Same pattern. `ontology.deprecated` → workspace surfaces a banner. |
| workspace → catalog item | `workspace_data_sources.catalog_item_id` | Same pattern. |
| aggregation → workspace | `aggregation_jobs.data_source_id`, `aggregation_jobs.workspace_id` (denorm) | Aggregation queries by `workspace_id` directly — no JOIN through `workspace_data_sources`. |
| visualization → workspace | `views.workspace_id`, `views.data_source_id` | Same pattern. |
| stats → workspace | `data_source_stats.workspace_id` (denorm) | Same pattern. |
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
3. If the table has cross-domain references, populate the
   denormalised `workspace_id` (or equivalent tenancy column) at
   write time. The repo enforces.
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
| `services/aggregation/service.py` | aggregation ↔ workspace | Already denormalised: use `aggregation_jobs.workspace_id` (added in `0003_extraction_readiness`) instead of joining through `workspace_data_sources`. |
| `db/repositories/view_repo.py` | visualization ↔ workspace | Use `views.workspace_id` directly; for workspace name, fetch via the workspace service API or denormalise on view create. |
| `db/repositories/catalog_repo.py` | visualization ↔ workspace | Same pattern. |
| `db/repositories/provider_repo.py` | provider ↔ workspace / visualization | Provider-impact endpoint reads workspace + visualization tables — should use outbox event subscriptions to maintain a per-provider impact projection. |
| `api/v1/endpoints/catalog.py` | provider ↔ workspace | Same pattern. |
| `ontology/adapters/sqlalchemy_repo.py` | ontology ↔ workspace | Reading workspace data sources to find which workspaces use an ontology — should be reversed: workspace domain queries ontology by id, not the other way around. |

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
