# Logical Domain Ownership Map

*For backend engineers adding tables or queries, and for anyone reviewing their changes.*

Use this page to find which domain owns a table, how other domains may refer to it, and what the cross-domain JOIN check enforces.

> Authoritative table-to-domain assignment *within the monolith*. {brand}'s
> backend is one codebase on one PostgreSQL database, run as several
> processes. These domains are **logical module boundaries** — the rule that
> module A doesn't reach into module B's tables — not promises of future
> extraction.
>
> Code review and a lint enforce the boundary. The lint is
> `backend/scripts/check_cross_domain_joins.py`; the test
> `backend/tests/test_no_new_cross_domain_joins.py` runs it as part of the
> backend test suite and fails if the number of cross-domain JOINs grows.

## Why bother in a monolith

Clean module boundaries pay off regardless of whether the monolith ever
splits:

1. **Cross-domain JOINs are forbidden in app code.** A query in
   module X that joins to module Y is a tight coupling. The lint
   surfaces it at review time so the team chooses coupling explicitly
   rather than accidentally.
2. **Cross-domain references use IDs only.** A view's `created_by`
   is a user_id string; its display name is resolved by the identity
   module's own API, not by JOINing from the visualization module.
3. **Cross-domain state changes propagate via outbox events.** A domain
   records the change as an event in `outbox_events`, in the same
   transaction as the change, and a cross-module reaction consumes the
   event instead of reading the other domain's tables. Today the outbox
   carries view activity and authentication events; see
   [Outbox event-type contract](#outbox-event-type-contract).

**Extraction is a future option, not a roadmap item.** See
[Scaling Architecture](/docs/scaling-architecture) for the conditions
that would flip extraction on. Until then, treat each domain as a
well-fenced module in one service.

## The map

The map covers the tables the boundary rules were written for. The lint
checks the subset named in its `ORM_TO_DOMAIN` map, which mirrors this
table — update both together. Tables added since, such as those for
role-based access, single sign-on, notifications, analytics events and
the version store, are not assigned a domain here yet;
[Data Architecture](/docs/data-architecture#where-every-table-belongs)
places every table by area and schema.

| Domain | Owned tables | Notes |
|---|---|---|
| **identity** | `users`, `user_roles`, `user_approvals`, `revoked_refresh_jti`, `refresh_tokens` | PII boundary — `email`, `password_hash`, `metadata` live here and only here. |
| **workspace** | `workspaces`, `workspace_data_sources`, `assignment_rule_sets` | Tenancy boundary — `workspace_id` is THE tenant identifier. |
| **provider** | `providers`, `catalog_items` | Pure infrastructure — no tenant data, no PII. |
| **ontology** | `ontologies`, `ontology_audit_log`, `ontology_source_mappings` | Versioned + immutable audit log. `revision` is the optimistic concurrency token. |
| **visualization** | `context_models`, `views`, `view_favourites`, `view_versions`, `object_store_objects`, `object_store_chunks` | References ontology + workspace by ID only. `ontology_digest` captures schema fingerprint at save time. `view_versions` holds the history of a view's design (FK to `views`, intra-domain). `object_store_objects` / `object_store_chunks` are the import/export artifact store (uploads, exports, view packages) every API pod shares; a key names its workspace, data source and job by ID, and nothing joins to them. |
| **aggregation** | `aggregation_jobs`, `data_source_state`, `reconcile_runs`, `aggregation_settings`, `automation_holds`, `job_event_log` (all in the `aggregation` schema); `data_source_polling_configs`, `refresh_events` | Job lifecycle. Hot writes (checkpoints). `aggregation_jobs` carries a denormalised `workspace_id` and `data_source_label`, so job listings never JOIN out of this domain. `reconcile_runs` is one row per reconciliation sweep (not per data source), trimmed to 30 days. `refresh_events` is the per-operation audit trail (immutable, best-effort emission); the counts-history read correlates against it by id, never by JOIN. |
| **stats** | `data_source_stats`, `data_source_count_snapshots`, `data_source_count_rollups`, `data_source_count_alerts` | `data_source_stats` is a read-mostly cache, tolerant of staleness. `data_source_count_snapshots` is its append-only twin — one row per observed change (plus an hourly heartbeat), purged by age and per-source cap; `data_source_count_rollups` holds its compacted tiers. Snapshots carry denormalised `workspace_id`/`provider_id` so the per-provider rollup never JOINs out of this domain. `data_source_count_alerts` freezes an anomaly's verdict and evidence so it outlives the snapshot that produced it. |
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
| aggregation → workspace | `aggregation_jobs.data_source_id`, `aggregation_jobs.workspace_id` | The job row stores the workspace id and the data source's label when it is created, so `list_jobs_global` reads `aggregation_jobs` alone — the "add a denormalised column when a real tenant-filtering query needs it" case. |
| visualization → workspace | `views.workspace_id`, `views.data_source_id` | `views` owns its own `workspace_id` FK (intra-schema). |
| stats → workspace | `data_source_stats.data_source_id`, `data_source_count_snapshots.{data_source_id,workspace_id}` | `data_source_stats` does not need workspace awareness. The snapshot table denormalises `workspace_id`/`provider_id` at capture time, so the per-provider history rollup reads the stats domain alone. It also has no FK: an audit trail must outlive the row it describes. |
| identity → identity | `user_roles.user_id`, `user_approvals.user_id` | Intra-domain — keep DB FK forever. |
| visualization → visualization | `views.context_model_id`, `view_favourites.view_id`, `view_versions.view_id` | Intra-domain. |
| ontology → ontology | `ontology_audit_log.ontology_id`, `ontology_source_mappings.ontology_id` | Intra-domain. |

## Outbox event-type contract

`emit` in `backend/app/db/repositories/outbox_event_repo.py` adds an event
to the caller's transaction and refuses an `event_type` that does not
match `<domain>.<entity>.<verb>`: lowercase, dot-separated, at least
three parts, with `<domain>` one of the domains in the map above
(`_VALID_DOMAINS`). Its caller today is the view activity log, which
emits `visualization.view.<action>` for each recorded change to a view.

The authentication events — `user.login_failed`, `user.sso_login_failed`,
`user.password_changed` and their siblings — predate the contract:
`create_outbox_event` in `backend/app/db/repositories/user_repo.py` writes
them without that check. New events go through `emit`.

The outbox relay (`backend/app/services/outbox_relay.py`) copies each
unprocessed event verbatim into the append-only `auth_audit_log` and marks
it processed in the same transaction.

When the payload schema changes incompatibly, bump `event_version`
on the emit call so consumers can branch.

## Adding a new domain

1. Add the domain key to `_VALID_DOMAINS` in
   `backend/app/db/repositories/outbox_event_repo.py`.
2. Add the domain row + tables to the table above.
3. If the new domain owns data with cross-domain consumers, document
   the by-ID resolution path in the cross-domain table.
4. Add its ORM classes to `ORM_TO_DOMAIN` in
   `backend/scripts/check_cross_domain_joins.py`, so the lint knows
   which joins stay inside the domain.

## Adding a new table to an existing domain

1. Add the model to `backend/app/db/models.py` (or the service-package-local
   model file for service-private tables, e.g.
   `backend/app/services/aggregation/models.py`).
2. Add the table name to the corresponding row in the table above, and
   its ORM class to `ORM_TO_DOMAIN` in the lint.
3. If the table has cross-domain references, store the referenced id
   as a plain column (no FK across schemas once extraction happens).
   Do not add denormalised tenancy columns speculatively — wait until
   a real query needs them.
4. If the table participates in domain events, emit them via
   `outbox_event_repo.emit` — never `session.add(OutboxEventORM(...))`
   ad-hoc.

## Known cross-domain debt

The lint finds **10 cross-domain JOINs** in `backend/app` today. They are
not bugs — the code works — but each is a place that would need
refactoring before its domain could move to a separate process. The
test gate allows up to 12 (`BASELINE_VIOLATIONS` in
`backend/tests/test_no_new_cross_domain_joins.py`) and fails if the count
goes above that. To check, run the lint from the repository root:

```bash
python backend/scripts/check_cross_domain_joins.py --baseline 12
```

It prints one line per violation, then:

```
10 cross-domain JOIN violation(s) found.
OK — within baseline of 12 (current: 10). Fix the existing ones to ratchet the baseline down.
```

When you pay one down, lower `BASELINE_VIOLATIONS` to the new count. When
the count reaches zero, switch to `--strict`.

| Hotspot | Cross-domain pair | Suggested resolution |
|---|---|---|
| `db/repositories/view_repo.py` | visualization ↔ workspace | Use `views.workspace_id` directly; for workspace name, fetch via the workspace module's API. |
| `db/repositories/catalog_repo.py` | visualization ↔ workspace | Same pattern. |
| `db/repositories/provider_repo.py` | provider ↔ workspace / visualization | Provider-impact endpoint reads workspace + visualization tables — should use outbox event subscriptions to maintain a per-provider impact projection. |
| `api/v1/endpoints/catalog.py` | provider ↔ workspace | Same pattern. |
| `ontology/adapters/sqlalchemy_repo.py` | ontology ↔ workspace | Reading workspace data sources to find which workspaces use an ontology — should be reversed: workspace domain queries ontology by id, not the other way around. |
| `services/aggregation/probe_scheduler.py` | stats ↔ workspace | Annotated `# noqa: cross-domain` (not in the count). The due-query joins `workspace_data_sources → data_source_stats` because `stats.last_probed_at` is the probe cadence clock. Read-only, bounded by `AGGREGATION_PROBE_SCAN_CAP`. To pay down: denormalise `last_probed_at` onto `aggregation.data_source_state`. |
| `services/aggregation/reconcile_sweeper.py` | provider ↔ workspace | Annotated `# noqa: cross-domain` (not in the count). `_batch_context` joins `workspace_data_sources → providers` for the provider NAME that labels findings; read-only, ≤ `_SCAN_CAP` rows per tick. To pay down: denormalise the name, as `aggregation_jobs` already does for its labels. |

A few other read-only admin views — the freshness and capacity views in
`services/aggregation/`, the system-status probes and the stats admin
endpoint — are annotated `# noqa: cross-domain` for the same reason: one
bounded query that needs a provider name to label its rows.

## What this map does NOT do

- It does not give each domain its own PostgreSQL schema. Only the
  aggregation job tables (`aggregation`), the version store (`graphver`)
  and the property side index (`propidx`) have schemas of their own;
  moving the domains that share `public` is deferred until the
  cross-domain join lint is clean and stable. Inside `public` the
  boundary is enforced by review + lint, not by schema separation.
- It does not turn the monolith into microservices. It makes that
  refactor possible without a rewrite when ops capacity allows.
- It does not eliminate cross-domain reads from the database — only
  from app code. The DB itself happily serves whatever the app asks
  for; the lint is what stops bad asks from landing.

## Where in the code

| What | Where |
|---|---|
| The lint and its domain map | `backend/scripts/check_cross_domain_joins.py` (`ORM_TO_DOMAIN`) |
| The test gate | `backend/tests/test_no_new_cross_domain_joins.py` (`BASELINE_VIOLATIONS`) |
| The outbox helper and its domains | `backend/app/db/repositories/outbox_event_repo.py` (`emit`, `_VALID_DOMAINS`) |
| The outbox relay | `backend/app/services/outbox_relay.py` (`drain_once`) |
| The models | `backend/app/db/models.py`, `backend/app/services/aggregation/models.py`, `backend/app/jobs/models.py` |

## See also

- [Data Architecture](/docs/data-architecture#where-every-table-belongs) — every table, by area and schema
- [Design Decisions](/docs/decisions#adr-025-postgresql-only-management-database-schema-owned-by-an-upgrade-job) — why there is one PostgreSQL database, and who owns its schema
- [Scaling Architecture](/docs/scaling-architecture) — what would have to be true before a domain moves to its own process
