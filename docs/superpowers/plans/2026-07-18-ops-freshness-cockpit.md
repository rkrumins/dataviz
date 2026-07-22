# OPS Freshness Cockpit + Unified Refresh API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give OPS one cockpit (API + Ingestion-tab UI + audit trail) over data-source freshness — cache as-of, aggregation age, stale/drift/cooldown state — and one scoped refresh verb per source and per provider.

**Architecture:** Two new sources of truth (a `genat` Redis stamp written at every generation bump; a `refresh_events` audit table written best-effort from the signal funnel and the event listener) feed read-only freshness endpoints (fleet = DB+Redis only; per-source probe explicit). A unified `refresh` service verb dispatches four scopes over the *existing* convergence primitives; a control-plane background runner fans it out per provider as a guarded batch. The FE adds a Freshness tab to the Ingestion page.

**Tech Stack:** FastAPI + SQLAlchemy/alembic (management DB), aioredis via `aggregation.redis_client.get_redis`, existing AggregationService/graph_cache primitives, React + React Query + existing StatusChip patterns.

**Spec:** docs/superpowers/specs/2026-07-18-ops-freshness-design.md (approved). Feature background: docs/features/data-freshness-convergence.md.

## Global Constraints

- Read paths NEVER trigger materialization/rebuilds (commit 110cd431 constraint; unchanged).
- Fleet endpoint does NO FalkorDB work; per-source probe only with explicit `probe=true`, bounded by `SCHEDULER_DRIFT_CHECK_TIMEOUT` (5s env default).
- Audit writes are best-effort and may NEVER block or fail the operation they record.
- All new Redis helpers follow graph_cache conventions: `str()` coercion, empty-id guards, never raise (log warning).
- Alembic revision id ≤32 chars (CI-gated).
- Every new route declares an explicit `response_model` (camelCase alias trap: pydantic models use snake_case fields + camelCase aliases + `response_model_by_alias=True` default, matching existing aggregation routes).
- RBAC: reads = the Ingestion-surface perms (mirror `nav_catalogue.py` "ingestion": `system:admin` | `system:org-admin` | `workspace:provider:read` | `workspace:datasource:manage`); mutations = `_REQUIRE_DS_MANAGE` (existing dependency in `api/v1/endpoints/aggregation.py`).
- Marker literal stays `"source_changed"`; the signal's `reason`/`origin` strings are response/audit-only.
- White-label FE copy; plain-language labels; no new stores; React Query only via existing `queryClient`.
- Before every in-container test run: `git branch --show-current` must print `claude/falkordb-redis-connectivity-va6czv` (a concurrent session sometimes switches the tree; if it differs, STOP and report).
- Test command shape: `docker exec synodic-dev-viz-service-1 python -m pytest /app/backend/tests/<file> -q`.
- Commits: explicit paths only (`git status --short` first — never sweep `edge_editing.dmg` or others' files); trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task F1: Audit table + cache as-of stamp (foundations)

**Files:**
- Create: alembic migration under the management-DB migrations dir (locate via `ls backend/app/db/migrations/versions | tail`, follow the newest file's template; revision id e.g. `refresh_events_0001`, ≤32 chars)
- Create: `backend/app/db/models/refresh_event.py` (ORM; register wherever sibling models are imported for metadata — grep how `view_activity_log`'s model registers)
- Create: `backend/app/db/repositories/refresh_events_repo.py`
- Modify: `backend/app/services/graph_cache.py` (genat stamp + readers)
- Test: `backend/tests/test_refresh_events_repo.py`, extend `backend/tests/test_graph_cache.py`

**Interfaces:**
- Produces (consumed by F2–F5):
  - ORM `RefreshEventORM` (table `refresh_events`): `id: str pk (uuid4 hex)`, `ts: DateTime(timezone=True) server_default now, indexed`, `workspace_id: Text nullable`, `data_source_id: Text index (composite ix with ts desc)`, `provider_id: Text nullable`, `origin: Text` (`script|connector|api|drift|reconcile`), `actor: Text default "internal"`, `scope: Text` (`auto|read-caches|rollups|full|batch-item`), `gate: Text` (`changed|unchanged|forced|n/a`), `actions: JSON nullable`, `outcome: Text` (`accepted|deferred|noop|conflict|error|completed|failed`), `detail: Text nullable`.
  - `async def emit_refresh_event(session_factory_or_none, *, workspace_id, data_source_id, provider_id=None, origin, actor="internal", scope, gate, actions: dict | None, outcome, detail: str | None = None) -> Optional[str]` in `refresh_events_repo.py` — opens its OWN short session via `get_async_session()` (never reuses the caller's mid-transaction session), commits, returns event id; on ANY exception logs warning and returns None. Also `async def list_refresh_events(session, data_source_id: str, limit: int = 20) -> list[RefreshEventORM]` and `async def latest_refresh_event_map(session, data_source_ids: list[str]) -> dict[str, RefreshEventORM]` (one query, window/max per ds).
  - graph_cache module helpers: `_GENAT_PREFIX = "graphcache:genat"`; `async def get_cache_as_of(workspace_id, data_source_id, branch_id="") -> Optional[str]` (GET, never raise); `bump_generation` and `bump_generations` additionally `SET {_GENAT_PREFIX}:{ws}:{ds}:{branch}` = `datetime.now(timezone.utc).isoformat()` (bulk: same pipeline).

- [ ] Write failing tests: genat stamp written by `bump_generation` (fake redis asserts SET of the genat key with parseable ISO value) and by `bump_generations` (pipeline contains one genat SET per scope); `get_cache_as_of` returns the value / None-on-miss / None-on-redis-error. Repo: emit returns an id and the row round-trips (SQLite test session like sibling repo tests — copy the harness from the newest repo test file); emit swallows a broken session factory (returns None, no raise); `latest_refresh_event_map` returns the newest row per ds.
- [ ] Run: `docker exec synodic-dev-viz-service-1 python -m pytest /app/backend/tests/test_graph_cache.py /app/backend/tests/test_refresh_events_repo.py -q` → new tests FAIL.
- [ ] Implement migration + ORM + repo + graph_cache changes (genat SET goes inside the existing try blocks; failure already logged by the surrounding handler).
- [ ] Run same command → ALL PASS (record counts). Run `docker exec synodic-dev-viz-service-1 alembic upgrade head` (or the project's documented alembic invocation — check backend README/dev.sh) and verify the table exists.
- [ ] Commit (migration, model, repo, graph_cache.py, two test files).

### Task F2: Audit emission from the signal funnel + listener

**Files:**
- Modify: `backend/app/services/aggregation/service.py` (`signal_source_changed`)
- Modify: `backend/app/services/aggregation/event_listener.py`
- Modify: `backend/app/services/aggregation/scheduler.py` (pass origins)
- Test: extend `backend/tests/test_source_changed_signal.py`, `backend/tests/test_aggregation_event_listener.py`

**Interfaces:**
- Consumes: `emit_refresh_event(...)` (F1).
- Produces: `signal_source_changed(..., origin: str = "api", actor: str = "internal")` — new kwargs, defaulted so ALL existing callers keep working; scheduler passes `origin="drift"` / `origin="reconcile"`; the script/route callers pass their origin in F4. Every invocation emits exactly ONE event: gate `unchanged`→outcome `noop`; changed+job→`accepted`; changed+deferred→`deferred`; changed+ConflictError→`conflict`; changed+trigger-error→`error` (detail = exception class); actions dict records booleans/ids per spec §1b. Listener emits outcome `completed` (job.completed, after marker clear) / `failed` (job.failed) with `actions={"job_id": ...}`, `origin="reconcile" if unknown else event payload's trigger source when present` — inspect the event payload; if it has no trigger source, use `origin="api"` with `detail="listener"`. Marker/vocabulary/response behavior UNCHANGED (existing 23 signal tests must pass untouched except where they gain event assertions).

- [ ] Write failing tests: signal no-op emits `noop` event and nothing else; changed path emits `accepted` with job id in actions; deferred → `deferred`; scheduler drift/reconcile calls carry their origins; listener completed/failed emit; emit failures never break signal or listener (patch emit to raise → operation still succeeds).
- [ ] RED run → implement (emit calls in `finally`-adjacent positions AFTER the operation's outcome is known; never inside the invalidation sequence) → GREEN run both files.
- [ ] Commit.

### Task F3: The unified refresh verb (service layer)

**Files:**
- Modify: `backend/app/services/aggregation/service.py` (new method beside `signal_source_changed`)
- Modify: `backend/app/services/aggregation/schemas.py`
- Test: create `backend/tests/test_refresh_verb.py`

**Interfaces:**
- Consumes: `signal_source_changed` (unchanged), `mark_source_stale`, `invalidate_hierarchy_reads`, `GraphCache.purge_lkg`, `provider.clear_content_caches()`, `mark_stats_changed`, `self.trigger`, `emit_refresh_event`.
- Produces:
  - `class RefreshRequest(BaseModel)`: `scope: Literal["auto","read-caches","rollups","full"] = "auto"`, `force: bool = False`, `reason: Optional[str] = None`, `wait: Literal["none","complete"] = "none"` (aliases per file style).
  - `class RefreshResponse(BaseModel)`: `scope: str`, `gate: str`, `changed: bool`, `actions: list[str]`, `job_id: Optional[str]` (alias jobId), `deferred: bool = False`, `event_id: Optional[str]` (alias eventId).
  - `async def refresh_source(self, ds_id: str, session, *, scope="auto", force=False, reason=None, actor="internal", origin="api", wait="none") -> RefreshResponse`; raises `NotFoundError` when the ds has neither a state row nor a `WorkspaceDataSourceORM` row (the route maps to 404).
- Scope dispatch (single method, no new mechanisms):
  - `auto` → call `signal_source_changed(..., force=force, origin=origin, actor=actor)`; map its response (gate = `forced` if force else `changed|unchanged`).
  - `read-caches` → NO gate: `provider.clear_content_caches()`; `invalidate_hierarchy_reads(ws, ds)`; `get_graph_cache().purge_lkg(scope_obj, ENDPOINT_AGGREGATED)` (aggregated LKG goes too — operator override); `mark_stats_changed(ds, ws)`; NO marker, NO trigger; gate `n/a`, outcome `accepted`, actions list what ran.
  - `rollups` → `mark_source_stale(ws, ds)` (literal source_changed) + `self.trigger(ds, AggregationTriggerRequest(idempotency_key=f"refresh-rollups:{uuid4().hex}"), "api", session)` — fresh key every call = cooldown/gate/idempotency BYPASS by construction; catch ConflictError → outcome `conflict`, job_id None.
  - `full` → read-caches steps, then rollups steps.
  - `wait == "complete"` and a job id exists → poll the job via the service's existing job-get (reuse whatever `get_job` exists; look at `GET /jobs/{id}` route's service call) every 2s ≤60s; append final status to actions (`"job:completed"` / `"job:timeout"`).
  - Exactly ONE audit event per call: scope auto delegates emission to `signal_source_changed` (F2) and reuses its event id in the response; other scopes emit their own with `scope` set accordingly.
- [ ] Failing tests (fake collaborators in the existing signal-test style, ORDER-asserting): auto delegates verbatim + force passthrough; read-caches runs exactly its 4 actions, no marker/trigger/gate; rollups sets marker + triggers with a `refresh-rollups:` key and unique-per-call; full = read-caches ∪ rollups in order; unknown ds → NotFoundError; wait=complete polls to completed; one event per call with correct scope.
- [ ] RED → implement → GREEN (`test_refresh_verb.py` + re-run `test_source_changed_signal.py` untouched-green).
- [ ] Commit.

### Task F4: Freshness + refresh HTTP endpoints, CP twins, script flag

**Files:**
- Create: `backend/app/api/v1/endpoints/freshness.py` (router; mount it exactly like the aggregation admin router is mounted under `/api/v1/admin` — grep `api.py` for the include and mirror)
- Modify: `backend/app/api/v1/endpoints/aggregation.py` (source-changed docstring: note it equals refresh scope=auto)
- Modify: `backend/app/services/aggregation/controlplane.py` (twin routes: refresh, per-source freshness assembly where in-process state is needed — follow how source-changed twinned)
- Modify: `backend/app/services/aggregation/schemas.py` (freshness response models)
- Modify: `backend/scripts/signal_data_changed.py` (`--scope`, default auto → hits the refresh CP route)
- Test: create `backend/tests/test_freshness_endpoints.py`

**Interfaces:**
- Consumes: F1 readers (`get_cache_as_of`, `get_source_stale_reason`, `list_refresh_events`, `latest_refresh_event_map`), F3 `refresh_source`, state ORM fields (`aggregation_status`, `last_aggregated_at`, `graph_fingerprint`), `AGGREGATION_REBUILD_MIN_INTERVAL_SECS`.
- Produces:
  - `class FreshnessRow(BaseModel)` (all camelCase-aliased, Optional-heavy): `data_source_id`, `workspace_id`, `provider_id`, `name`, `provider_name`, `aggregation_status`, `last_aggregated_at`, `last_materialized_at`, `cache_as_of`, `generation: Optional[int]`, `stale_reason`, `stale_since: Optional[str]` (None — marker has no since; include field, populate from marker TTL remaining ONLY if cheap via TTL cmd, else leave None and document), `cooldown_until`, `stored_fingerprint`, `drifted: Optional[bool]`, `running_job_id`, `last_event: Optional[RefreshEventSummary]` (`origin`,`outcome`,`ts`).
  - `class FreshnessDoc(FreshnessRow)`: + `lkg_count: Optional[int]`, `lkg_oldest_age_secs: Optional[int]`, `live_fingerprint: Optional[str]`, `live_node_count/live_edge_count: Optional[int]` (probe only), `events: list[RefreshEventSummary]` (last 5).
  - Routes: `GET /api/v1/admin/freshness` (query `workspaceId`, `providerId`, `staleOnly`, `page=1`, `pageSize=50`; response `{rows: list[FreshnessRow], total: int}`); `GET /api/v1/admin/data-sources/{ds_id}/freshness?probe=false` → `FreshnessDoc`, 404 unknown; `POST /api/v1/admin/data-sources/{ds_id}/refresh` (body RefreshRequest → RefreshResponse, `_REQUIRE_DS_MANAGE`, proxy-aware, 404 unknown).
- Assembly rules: one SQL pass (state rows joined to workspace_data_sources + providers, filtered/paged) then ONE Redis pipeline for gen/genat/marker per ds; `cooldown_until = last_aggregated_at + interval` only when in the future; `drifted` = stored vs live ONLY under probe, else None (fleet never probes); LKG stats via one bounded SCAN per doc request only.
- [ ] Failing endpoint tests (existing endpoint-test conventions from `test_stale_overlay.py` — direct handler calls with fakes): fleet returns assembled rows with Redis nulls tolerated; staleOnly filters on marker; per-source 404; probe=false does zero provider calls, probe=true calls `get_schema_stats` once under wait_for; refresh route delegates to `refresh_source` and maps NotFoundError→404; RBAC dependency present (assert route dependencies include the manage gate — inspect route object).
- [ ] RED → implement → GREEN. Also run script smoke: `python -m backend.scripts.signal_data_changed --help` in-container shows `--scope`.
- [ ] Commit.

### Task F5: Guarded provider batch

**Files:**
- Modify: `backend/app/services/aggregation/controlplane.py` (batch runner + routes)
- Modify: `backend/app/api/v1/endpoints/freshness.py` (viz proxies: `POST /admin/providers/{provider_id}/refresh`, `GET /admin/refresh-batches/{batch_id}`)
- Modify: `backend/app/services/aggregation/schemas.py` (`BatchRefreshRequest {scope="auto", force=False, max_concurrent=2}`, `BatchStatus {batch_id, provider_id, total, done, results: list[{data_source_id, outcome, job_id}] , state: "running"|"done"}`)
- Test: create `backend/tests/test_provider_refresh_batch.py`
- Modify: `docs/features/data-freshness-convergence.md` (short "OPS API" section pointing at the new endpoints)

**Interfaces:**
- Consumes: `refresh_source` (F3), `emit_refresh_event` (scope `batch-item`), provider→data-source enumeration (grep the repo for how a provider's data sources are listed — `data_source_repo` / registry; reuse it).
- Produces: batch state in Redis hash `refreshbatch:{batch_id}` (fields: provider_id, state, total, done, `ds:{id}` = JSON outcome; EXPIRE 86400); single-flight lock `refreshbatch:lock:{provider_id}` (SET NX EX 3600 → 409 when held; DEL in finally). Runner = `asyncio.create_task` in the CP process; semaphore bounds `max_concurrent` (cap request value at 4); each item: fresh session, `refresh_source(..., origin="api", scope=req.scope, force=req.force)`, outcome written per ds; item exceptions recorded as `error`, never abort the batch.
- [ ] Failing tests: batch enumerates N sources and records N outcomes; concurrency ≤ max (instrument with a counting fake); overlap → 409; item failure recorded + batch completes; lock released on completion and on runner crash; unknown provider → 404.
- [ ] RED → implement → GREEN.
- [ ] Commit.

### Task F6: Ingestion → Freshness tab (frontend)

**Files:**
- Create: `frontend/src/components/admin/Freshness/index.tsx` (tab root: filters + fleet table), `FreshnessRow.tsx` (row + badges), `FreshnessDrawer.tsx` (doc + probe + events), `ProviderRefreshDialog.tsx`, `useFreshness.ts` (React Query hooks + `FRESHNESS_KEYS`, 30s refetchInterval; mutations for refresh/batch with invalidation of the fleet key)
- Modify: `frontend/src/pages/IngestionPage.tsx` (register the tab — follow the existing tabs array)
- Test: `frontend/src/components/admin/Freshness/Freshness.test.tsx` (RegistryConnections.test.tsx pattern)

**Interfaces:**
- Consumes: `GET /api/v1/admin/freshness`, `GET .../data-sources/{id}/freshness?probe=`, `POST .../data-sources/{id}/refresh`, `POST .../providers/{id}/refresh`, `GET .../refresh-batches/{id}` — camelCase wire shapes exactly as F4/F5 define.
- UI contract: columns Source / Aggregation ("updated Xm ago" chip via the existing StatusChip Cached-pattern) / Cache ("as of Xm ago", em-dash null) / Freshness (badges: `Recomputing`, `Drift detected`, `Next rebuild in Xm`) / Last activity / Actions dropdown ("Refresh caches"=read-caches; "Rebuild lineage"=rollups + confirm; "Full refresh"=full + confirm). Drawer: full doc, "Probe now", events list. Provider header row: "Refresh provider…" → dialog (source count, scope radio, force checkbox + warning copy, progress via batch poll every 2s). Filters: workspace, provider, "Needs attention" (marker OR drifted OR status failed). Plain-language, white-label, `useDocumentTitle("Freshness")`.
- [ ] `cd frontend && npx tsc --noEmit | tail -3` — record baseline error count FIRST.
- [ ] Failing test: tab renders rows from a mocked fleet payload (names, "as of" text, Recomputing badge), action dropdown fires the refresh mutation with the right scope payload.
- [ ] Implement → test GREEN → tsc after = baseline (zero new errors).
- [ ] Commit.

---

## Final phase (not a task — controller-run)

Whole-branch review of the F-range + live E2E: alembic upgrade on dev DB; restart CP/worker (verify branch first); exercise each refresh scope + fleet/doc endpoints against the real `pipeline` source; confirm the known stray marker (`ws_438429af72a9/ds_5181ba1ba07e`, if still present) appears under "Needs attention" and a `rollups` refresh clears it; audit rows visible in the drawer; provider batch on a small provider. Then merge/PR decision per finishing-a-development-branch.

## Self-review notes (done)

- Spec coverage: §1a→F1, §1b→F1+F2, §2a/2b/2c→F3+F4, §2d→F5, §3→F2, §4→F6, §5 embedded in Global Constraints, §6 in per-task tests + final phase. No gaps.
- Type consistency: `refresh_source` name + RefreshRequest/RefreshResponse/FreshnessRow/FreshnessDoc/BatchRefreshRequest/BatchStatus used consistently across F3–F6.
- Placeholders: none — where the plan says "grep/mirror X", X is a named, existing artifact and the requirement is exact.
