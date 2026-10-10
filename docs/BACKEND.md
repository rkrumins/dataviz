# Backend Reference

*For backend engineers and integrators.*

Use this page to find where an API lives: which router serves a path, what that group of endpoints is for, and which page documents it in depth. It also covers how requests are authenticated, the trace endpoints, the middleware every request passes through, what happens at startup, and the graph providers.

## How to use this page

1. Find your area in the [router map](#router-map) and note its path prefix.
2. Follow the link in **Documented in** for the concepts and the main calls.
3. For exact paths, parameters and schemas, open the [live API explorer](#explore-the-live-api) on a running deployment — it is generated from the code, so it is always current.

If you are writing a script or an integration rather than changing the backend, start with the [API Guide](/docs/api-guide). Every environment variable named here is described in the [configuration reference](/docs/configuration).

## The backend at a glance

One FastAPI application serves the HTTP API; the other backend processes run in the background and share its code:

| Process | Entry point | Port | Responsibility |
|---|---|---|---|
| API (`viz-service`) | `backend/app/main.py` (`app`), under gunicorn | 8000 | Every `/api/v1` route below |
| Aggregation control plane | `backend/app/services/aggregation/controlplane.py` | 8091 | Aggregation jobs, scheduling and recovery; the API forwards its aggregation endpoints here |
| Aggregation worker | `backend/app/services/aggregation/__main__.py` | 8090 (health) | Builds `:AGGREGATED` rollup edges |
| Versioning worker | `backend/app/services/versioning/__main__.py` | — | Projects version-controlled graphs into FalkorDB; runs import and export jobs |
| Stats service | `backend/insights_service/__main__.py` | 8092 (health) | Keeps per-data-source stats fresh |
| `upgrade` job | `backend/scripts/upgrade.py` | — | Builds and migrates the database schema |

How they fit together, and how a request flows through them: [Architecture](/docs/architecture). The process roles (`SYNODIC_ROLE`): [Platform Services](/docs/services-overview).

## Router map

`api_router` in `backend/app/api/v1/api.py` mounts every group below under `/api/v1`. Prefixes are shown without that `/api/v1`; `{ws_id}` is a workspace id. A few groups share the bare `/admin` prefix, so one router's paths sit beside another's.

| Group | Path prefix | What it is for | Documented in |
|---|---|---|---|
| Graph reads, search and trace | `/{ws_id}/graph` | Nodes, edges, children, search, lineage traces, stats and metadata for one data source; graph edits when editing is on; turning on version control for a data source | [API Guide](/docs/api-guide), [Search](/docs/services-search), [Context Engine](/docs/services-context-engine) |
| Batched canvas loading | `/{ws_id}/graph/canvas` | One request for a canvas's first page, or for opening a container | [Read-Path Performance](/docs/read-path-performance) |
| Layer assignment | `/{ws_id}/graph/assignments` | Computing which layer each entity of a view belongs in | [Assignments](/docs/services-assignments) |
| Graph export | `/{ws_id}/graph/export` | Exporting a whole data source that is not under version control | [Versioning: Import & Export](/docs/versioning-import-export) |
| Version control | `/{ws_id}/versioning` | Drafts, commits, review and merge, publish, revert, restore, imports and exports | [Versioning API Reference](/docs/versioning-api-reference) |
| Assignment rule sets | `/{ws_id}/assets` | Saved rule sets that place entities into layers | [Assignments](/docs/services-assignments) |
| Context models | `/{ws_id}/context-models`, `/admin/context-model-templates` | Layer configurations and the quick-start templates | [Context Engine](/docs/services-context-engine) |
| Views | `/views`, `/views/{view_id}/grants`, `/views/{view_id}/versions`, `/views/transfer` | Saved views, sharing, a view's design history, and moving views between environments | [View Portability](/docs/feature-view-portability), [Managing & Sharing Views](/guide/managing-views) |
| Sessions and sign-in | `/auth` | Sign-in, sign-out, session refresh, the current user, single sign-on flows, sign-up, password reset, invites | [Multi-Environment Sessions](/docs/multi-environment-sessions), [SSO](/docs/sso), [Sign-up Service](/docs/signup-service) |
| Your account | `/users`, `/me` | Your profile, password, sessions and activity; your permissions, linked identities, notifications and access requests | [RBAC](/docs/rbac), [SSO](/docs/sso) |
| Users, groups and access | `/admin/users`, `/admin/groups`, `/admin/workspaces/{ws_id}/members`, `/admin/role-bindings`, `/admin` (permissions and roles), `/admin/rbac/search`, `/access-requests`, `/admin/access-requests`, `/admin/workspaces/{ws_id}/access-requests`, `/directory`, `/admin/audit` | People, invites, groups, role bindings, custom roles, access requests, the people picker, and the audit log | [RBAC](/docs/rbac), [Users & Access](/guide/users-access) |
| Single sign-on administration | `/admin/idp-providers`, `/admin/idp-group-mappings`, `/admin/sso/config`, `/admin/sso/activity`, `/admin/sso/failures` | Identity providers, group-to-role mappings, the platform's sign-in posture, and sign-in diagnostics | [SSO](/docs/sso), [SSO Integration](/docs/sso-integration) |
| Providers, catalog and workspaces | `/admin/providers`, `/admin/catalog`, `/admin/workspaces`, `/admin/ontologies` | Registering graph stores and their graphs, binding them into workspaces as data sources, and the semantic layer | [Onboarding a Source](/docs/onboarding-a-source), [The Semantic Layer](/guide/semantic-layer) |
| Ingestion operations | `/admin` (aggregation jobs and settings, freshness, stats polling), `/admin/insights`, `/profiling` | Aggregation jobs (forwarded to the control plane), data freshness and refresh, cached asset discovery, and counts over time | [Aggregation Pipeline](/docs/aggregation-pipeline), [Insights](/docs/services-insights), [Data Freshness & Ingestion](/guide/data-freshness) |
| Feature switches | `/admin/features`, `/features` | Managing feature switches, and reading their values | [Features API](/docs/api-features), [Feature Flags Lifecycle](/docs/feature-flags-lifecycle) |
| Platform settings and appearance | `/admin/platform`, `/branding`, `/admin/branding`, `/announcements`, `/admin/announcements` | Platform-wide node-identity defaults, white-label branding, and announcement banners | [The Admin Console](/guide/governance-ops) |
| Analytics and telemetry | `/admin/analytics`, `/insights`, `/telemetry`, `/admin/telemetry` | Platform analytics, usage counts shown on content, and product telemetry | [Analytics](/guide/analytics) |
| Infrastructure status | `/admin/system`, `/admin/redis`, `/admin/graph-store` | Health of every backing service, the resolved Redis configuration, and graph-store topology | [The Admin Console](/guide/governance-ops), [The Graph Store](/guide/graph-store-topology), [Observability](/docs/observability) |
| Metrics | `/metrics` | Prometheus scrape endpoint; it answers only when `METRICS_ENABLED` is set | [Observability](/docs/observability) |

`backend/app/main.py` mounts two more groups directly, outside `/api/v1`:

| Group | Paths | What it is for | Documented in |
|---|---|---|---|
| Health | `/health/live`, `/health/ready`, `/health/deps`, `/health` (each also under `/api/v1/health/...`), and `/api/v1/health/providers` | Liveness, readiness (a database check), a deep dependency report, and provider health | [Observability](/docs/observability) |
| Database pool metrics | `/internal/metrics/db` | Connection-pool pressure; it answers only when `INTERNAL_METRICS_ENABLED=true` | [Observability](/docs/observability) |

## Authentication

The API uses cookie sessions, not bearer tokens. In short:

- **Signing in** (`POST /api/v1/auth/login`, or a single sign-on callback) sets four cookies: `nx_access` and `nx_refresh` (both `HttpOnly`), plus `nx_csrf` and `nx_access_exp`, which the app reads. The response body carries the user, never a token. With `AUTH_ENVIRONMENT_ID` set, each cookie name carries it as a suffix.
- **Every request** is authenticated by `get_current_user` (`backend/app/auth/dependencies.py`), which verifies the access cookie's JWT and checks that the session has not been revoked. `get_permission_claims` adds the session's workspace grants from the session store (Redis, falling back to PostgreSQL); global permission claims ride in the token itself.
- **Every state-changing request** (`POST`, `PUT`, `PATCH`, `DELETE`) must carry the `nx_csrf` value in an `X-CSRF-Token` header. `CSRFMiddleware` (`backend/auth_service/csrf.py`) checks the header against the cookie, the token's binding to the session, and the request's origin; a failure answers `403` with `csrf_failed`.
- **Renewal.** `POST /api/v1/auth/refresh` rotates the refresh token and mints a new access token. The app does this before `nx_access` expires, and once more on a `401`.
- **Permissions.** Each route declares what it needs with the `requires(...)` dependency; the catalogue of roles and permissions is in [RBAC](/docs/rbac).

Rules that are easy to trip over when you change these endpoints:

- **A forced password change.** While `must_change_password` is set on an account — for example a first administrator created with a password published in this repository — every route that requires a signed-in user, except a short allowlist, answers `403 {"error": "password_change_required"}`.
- **Signing a user out everywhere has two halves.** Tombstoning the session ids in Redis covers live access tokens; stamping `users.sessions_valid_from` makes every refresh token minted before it fail. Anything that revokes sessions for a security reason must do both, as `_revoke_my_every_session` in `backend/app/api/v1/endpoints/users.py` does around `revoke_subject_sessions`.
- **Changing your own password** answers `409` when the account has no local password (single sign-on only) and `403` — not `401` — when the current password is wrong, because the app treats `401` as a lost session.
- **Profile fields owned by the identity provider.** A single sign-on login records which name fields the provider asserted (`backend/common/identity_provenance.py`); `PATCH /users/me` and `PATCH /admin/users/{user_id}` refuse those fields with `409 {"error": "idp_managed_field"}`. The display name is never provider-owned.

More: [Multi-Environment Sessions](/docs/multi-environment-sessions) (cookie scoping and key rotation), [SSO](/docs/sso), [Security Overview](/docs/security-overview), and [ADR-024](/docs/decisions#adr-024-cookie-sessions-with-csrf-double-submit-not-bearer-tokens).

## The trace endpoints

All under `/api/v1/{ws_id}/graph`, in `backend/app/api/v1/endpoints/graph.py`:

| Endpoint | Request (key fields) | Answers |
|---|---|---|
| `POST /trace/v2` | `urn`, `direction`, `upstreamDepth` and `downstreamDepth` (default 25, at most 100), `level` (default `0`, the top-level skeleton), `lineageEdgeTypes` | Entities at one hierarchy level and the rollup edges between them |
| `POST /trace/expand` | `sourceUrn`, `targetUrn`, `nextLevel`, optional `drillAnchor` | The finer entities and edges inside one rollup edge |
| `POST /trace/expand-batch` | `pairs` (each `sourceUrn`, `targetUrn`, `nextLevel`), `lineageEdgeTypes` | The merged result for many rollup edges. A pair that fails is left out, and the result is marked truncated when a pair could not be answered right now; if every pair fails it answers `404` with the errors |
| `POST /trace/closure` | `urn`, `direction`, `upstreamDepth` and `downstreamDepth` (default 1, at most 25), `maxNodes`, `seedUrns`, `excludeUrns`, `afterCursor`, `seedCursor`, `grain` | One page of a walk over raw lineage around a focus, with a frontier and cursors to continue it; `grain: "coarse"` returns the rollup cells around the focus in one shot |
| `POST /trace` | — | `410 Gone`; the original trace is retired |

What every trace endpoint shares:

- It needs the **Lineage trace** feature switch (Administration → Features); when the switch is off it answers `403` with `feature_disabled`.
- It is bounded by the server, not the caller: at most `TRACE_MAX_NODES` nodes (default 2,000) and `TRACE_TIMEOUT_SECS` (default 120 seconds). A trace that reaches either limit still answers `200`, with `truncated: true` and a `truncationReason`.
- Answers are cached per data source and draft (see [Architecture](/docs/architecture#4-caching-and-load-shedding)); when the graph store is saturated a request is shed with `429` and `Retry-After`. `trace/closure` also counts against the optional per-workspace fair share (`FAIR_SHARE_ENABLED`).

## Middleware

Every request passes through this stack, outermost first, as registered in `backend/app/main.py` (pinned by `backend/tests/test_middleware_order.py`):

1. **Timeout** (`_TimeoutMiddleware`) — until startup finishes, answers everything but the health probes with `503` and `Retry-After`; afterwards gives each path a deadline (30 seconds by default, 120 for graph and trace routes) and answers `504` when it passes. Streaming paths are exempt.
2. **Body size** (`_BodySizeLimitMiddleware`) — refuses an oversized body with `413` before anything parses it: `MAX_REQUEST_BODY_BYTES` (8 MiB by default), or `MAX_IMPORT_BODY_BYTES` (100 MiB) on the bulk-import routes.
3. **Security headers** (`SecurityHeadersMiddleware`) — `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, a Content Security Policy, and HSTS on HTTPS.
4. **Host allowlist** (`_TrustedHostMiddleware`) — only when `ALLOWED_HOSTS` is set; another `Host` answers `400`.
5. **Request id** (`RequestIdMiddleware`) — reads or creates `X-Request-ID` and returns it.
6. **Access log** (`StructuredLoggingMiddleware`) — one JSON log line per request, and an `X-Process-Time` header.
7. **Compression** (`GZipMiddleware`) — responses over 1 KB, at level `GZIP_COMPRESSLEVEL` (default 1); downloaded files are left uncompressed.
8. **CORS** (`CORSMiddleware`) — origins from `CORS_ALLOWED_ORIGINS` (`http://localhost:3000` and `http://localhost:5173` when unset), with credentials.
9. **CSRF** (`CSRFMiddleware`) — innermost, so even its `403` carries the headers and CORS added above it.

Starlette runs the last-registered middleware outermost, so the code registers them in the reverse of this list.

## What happens at startup

The API never creates or migrates tables. The `upgrade` job builds the schema before the API starts (see [ADR-025](/docs/decisions#adr-025-postgresql-only-management-database-schema-owned-by-an-upgrade-job) and [Migrations](/docs/migrations)). When the API starts (`lifespan` in `backend/app/main.py`), it:

1. **Checks the schema** (`init_db()` in `backend/app/db/engine.py`): connects, retrying for up to `DB_STARTUP_RETRY_TIMEOUT_SECS` (default 60), and compares `alembic_version` with every Alembic head. With no schema at all it starts in degraded mode — database-backed routes answer `503` while a recovery loop retries; a version mismatch is logged loudly and reported by `/health/ready`.
2. **Seeds reference data**, idempotently: the context-model quick-start templates, the feature registry and switch values, and the system default ontology.
3. **Creates the first administrator** if there are no users, from `ADMIN_EMAIL` and `ADMIN_PASSWORD`. If the password is one published in this repository, the account must change it at first sign-in.
4. **Wires sign-in**: the local password provider and the database-backed identity-provider registry. If OIDC or SAML settings are present in the environment and no matching row exists, it records them once as a default identity provider.
5. **Wires aggregation**: with `AGGREGATION_PROXY_ENABLED=true` (as Compose and Kubernetes set it) the aggregation endpoints are forwarded to the control plane; otherwise a local dispatcher is chosen by `AGGREGATION_DISPATCH_MODE`.
6. **Starts background loops**: the provider-change listener, a provider warm-up loop, database health and event-loop monitoring, and any loops the process role enables. The versioning projector runs here only when `GRAPHVER_PROJECTION_INPROCESS=1`.
7. **Opens the readiness gate**, so requests other than health probes are served.

No graph provider, workspace or data source is created from environment variables: you register providers in the app — see [Admin Setup](/guide/admin-setup). On shutdown the API stops its loops, closes every cached provider (allowing 5 seconds) and closes its database pools.

## Graph providers

Every graph store is reached through one interface, `GraphDataProvider` (`backend/common/interfaces/provider.py`), and is instantiated by `ProviderManager._create_provider_instance` (`backend/app/providers/manager.py`):

| Provider type | Implementation | Writes (`PROVIDER_CAPABILITIES`) |
|---|---|---|
| `falkordb` | `FalkorDBProvider` in `backend/app/providers/falkordb_provider.py` | Full create, update and delete |
| `spanner` | `SpannerProvider` in `backend/graph/adapters/spanner_provider.py` | Full create, update and delete |
| `neo4j` | `Neo4jProvider` in `backend/graph/adapters/neo4j_provider.py` | Create only |
| `datahub` | `DataHubGraphQLProvider` in `backend/graph/adapters/datahub_provider.py` | None — a read-only view of an external catalog |

How they are used:

- `ProviderManager` (singleton `provider_manager`) caches one instance per provider and graph in each process, wraps each in a circuit breaker, admits graph requests per data source, and drops its copies when a provider edit is broadcast.
- `ContextEngine` (`backend/app/services/context_engine.py`) binds a workspace's data source to its provider and its resolved ontology for each request (`ContextEngine.for_workspace`). The resolved ontology — system defaults, plus the assigned ontology, plus types introspected from the graph — is cached per process and data source, refreshed whenever an ontology or its assignment changes, with a 5-minute backstop.
- Draft and history reads go through version-aware wrappers in `backend/app/providers/` (`versioned_branch_provider.py`, `versioned_write_provider.py`, `draft_overlay_provider.py`).
- Testing a connection before registering it, and discovering a provider's graphs, run in the API: `POST /api/v1/admin/providers/test-connection` and `POST /api/v1/admin/providers/{provider_id}/discover-schema`. The standalone `graph-service` that once did this was retired ([ADR-018](/docs/decisions#adr-018-retire-the-graph-service)).

Data access to the management database goes through about 40 repository modules in `backend/app/db/repositories/`. They take an `AsyncSession` and mostly return Pydantic models rather than ORM rows.

## Explore the live API

The API publishes its own OpenAPI schema and interactive explorers, generated from the code:

| On | Swagger UI | ReDoc | Schema |
|---|---|---|---|
| The app's address, through the frontend's nginx | `/viz-docs` | `/viz-redoc` | `/openapi.json` |
| The API directly (port 8000) | `/docs` | `/redoc` | `/openapi.json` |

They are on unless `ENV` is `prod` or `production`; set `API_DOCS_ENABLED=true` to turn them on there (`_DOCS_ENABLED` in `backend/app/main.py`). On the app's address, `/docs` is this documentation reader, which is why the explorer is published as `/viz-docs`.

## Error responses

| Status | Meaning |
|---|---|
| 400 | The request is malformed, names no workspace or data source, or names a host outside `ALLOWED_HOSTS` |
| 401 | No session, or an expired or invalid one |
| 403 | Not permitted; also `csrf_failed`, `feature_disabled` and `password_change_required` |
| 404 | Not found |
| 409 | A conflict: a duplicate, a stale version, a delete blocked by references, or an identity-provider-owned field |
| 410 | A retired endpoint (`POST /{ws_id}/graph/trace`) |
| 413 | The request body is too large |
| 422 | The request failed validation |
| 429 | Rate-limited or shed under load; honour `Retry-After` |
| 503 | Starting up, database unavailable, or a graph provider unavailable, loading or failing over; usually with `Retry-After` |
| 504 | The request ran past its deadline |

## Where in the code

| Concern | Where |
|---|---|
| Router map | `backend/app/api/v1/api.py` (`api_router`) |
| Endpoints | `backend/app/api/v1/endpoints/` — one module per router |
| App, middleware, startup, health | `backend/app/main.py` (`app`, `lifespan`, `_TimeoutMiddleware`, `_BodySizeLimitMiddleware`, `_DOCS_ENABLED`) |
| Session routes | `backend/auth_service/api/router.py` |
| Cookies and CSRF | `backend/auth_service/cookies.py`, `backend/auth_service/csrf.py` |
| Request authentication and permissions | `backend/app/auth/dependencies.py` (`get_current_user`, `requires`) |
| Trace endpoints | `backend/app/api/v1/endpoints/graph.py` (`trace_v2`, `trace_closure`, `trace_expand`, `trace_expand_batch`) |
| Trace request models | `backend/common/models/graph.py` (`TraceRequest`, `TraceClosureRequest`, `ExpandRequest`) |
| Query orchestration | `backend/app/services/context_engine.py` (`ContextEngine`) |
| Provider cache and admission | `backend/app/providers/manager.py` (`ProviderManager`) |
| Provider interface | `backend/common/interfaces/provider.py` (`GraphDataProvider`) |
| Response cache | `backend/app/services/graph_cache.py` (`GraphCache`) |
| Schema check and pools | `backend/app/db/engine.py` (`init_db`) |
| Repositories | `backend/app/db/repositories/` |

## See also

- [API Guide](/docs/api-guide) — calling the API from scripts and integrations
- [Architecture](/docs/architecture) — the processes, the stores and a request's lifecycle
- [Configuration](/docs/configuration) — every environment variable
- [RBAC](/docs/rbac) — roles, permissions and how they are checked
- [Frontend Reference](/docs/frontend) — the app that calls this API
