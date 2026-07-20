# OPS Freshness Cockpit + Unified Refresh API — Design

**Date:** 2026-07-18 · **Status:** approved (user, in-session) · **Scope decision:** Full Approach B (API + audit + Ingestion-tab UI) · **UI placement decision:** Ingestion page → new "Freshness" tab

## Why

The data-freshness convergence feature (docs/features/data-freshness-convergence.md, branch `claude/falkordb-redis-connectivity-va6czv`) built the *machinery* — change-gated signal, cooldown, stale markers, reconciler — but OPS has no cockpit over it: no "cache as-of" timestamp anywhere, no single per-source freshness view (state is scattered across the DB state row, `_AggMeta`, Redis markers/gens/LKG, and the job table), no per-provider action, no audit of who/what triggered refreshes (the reconciler acts invisibly), and the refresh verb is fragmented across source-changed / manual re-aggregate / nothing-for-caches-only. A stray stale marker on a failed source went unnoticed until a subagent stumbled on it — exactly the visibility gap this design closes.

Framing decisions (challenged and settled):
- Provider-wide refresh is a **guarded batch**, never a hidden loop — provider-wide forced rebuilds are the historical storm shape.
- No "reload everything on demand": invalidate + stale-while-revalidate + the existing bounded cache-warmer. New machinery observes and steers; it does not add read-path work.
- The strategic center is **observability of refresh**, not more triggers: the audit trail is core, not a nice-to-have.

## 1. Sources of truth (two additions)

**1a. Cache as-of stamp.** `GraphCache.bump_generation` / `bump_generations` additionally `SET graphcache:genat:{ws}:{ds}:{branch}` = ISO-8601 UTC now (same Redis, no TTL; overwritten each bump; best-effort). Read by the freshness endpoints as "cache as of".

**1b. `refresh_events` table** (management DB, new alembic migration — **revision id ≤32 chars**, CI-gated):
`id (pk)`, `ts (tz, indexed)`, `workspace_id`, `data_source_id (indexed with ts)`, `provider_id (nullable)`, `origin` (`script|connector|api|drift|reconcile`), `actor` (user id or `internal`), `scope` (`auto|read-caches|rollups|full|batch-item`), `gate` (`changed|unchanged|forced|n/a`), `actions` (JSON: marker_set, gen_bumped, lkg_purged, content_cleared, stats_nudged, job_id, deferred), `outcome` (`accepted|deferred|noop|conflict|error|completed|failed`), `detail` (text, nullable).
Writers (all best-effort, never block/fail the operation):
- `signal_source_changed` emits one event per invocation (it is the funnel for origins script/connector/api/drift/reconcile — origin passed through from the caller; the existing `reason` param maps to origin).
- The aggregation event listener emits a completion event on `job.completed`/`job.failed` (outcome `completed`/`failed`, actions carry job_id).
Retention: 90 days, swept by the existing reaper/purge-worker pattern (follow `view_activity_log`'s precedent).

## 2. API surface

All on the viz-service admin router (`backend/app/api/v1/endpoints/`), proxy-aware exactly like the existing aggregation routes; control-plane twins where the service must run in-process. RBAC: reads = the ingestion-surface read perms (`workspace:provider:read` / `workspace:datasource:manage` union, per nav_catalogue "ingestion"); actions = `workspace:datasource:manage`. All responses have explicit `response_model` (camelCase alias trap).

**2a. `GET /api/v1/admin/freshness`** — fleet list. Query: `workspaceId?`, `providerId?`, `staleOnly?`, `page/pageSize`. Per row (DB + pipelined Redis ONLY — no FalkorDB probes): ds/ws/provider identity + names, aggregation `status`, `lastAggregatedAt`, `lastMaterializedAt` (state row), `cacheAsOf` (genat stamp), `generation`, stale marker (`reason`, `since`), `cooldownUntil` (derived from last_aggregated_at + AGGREGATION_REBUILD_MIN_INTERVAL_SECS when in window), `storedFingerprint`, `driftLastCheckedAt`/`drifted` (from the scheduler's stored state where available, else null), `runningJobId`, last refresh event summary (origin, outcome, ts). Missing Redis data → nulls, never errors.

**2b. `GET /api/v1/admin/data-sources/{ds_id}/freshness?probe=false`** — the full per-source document: everything in 2a plus LKG key count + oldest age (bounded SCAN), and last 5 refresh events. `probe=true` additionally computes the live fingerprint + physical node/edge counts via `get_schema_stats` under the existing 5s drift timeout, and returns `drifted` computed live. Probe is explicit; never on by default; fleet endpoint never probes. 404 on unknown ds.

**2c. `POST /api/v1/admin/data-sources/{ds_id}/refresh`** — the unified verb. Body `{scope: "auto"|"read-caches"|"rollups"|"full" = "auto", force: bool = false, reason?: string, wait: "none"|"complete" = "none"}`.
- `auto` → delegates to `signal_source_changed` unchanged (change gate, cooldown, marker, trigger). `force` maps through.
- `read-caches` → invalidation-only: `provider.clear_content_caches()` + `invalidate_hierarchy_reads` + `purge_lkg(scope, ENDPOINT_AGGREGATED)` (operator says caches are wrong → aggregated LKG goes too) + `mark_stats_changed`. NO marker, NO job. Always runs (no gate).
- `rollups` → forced rebuild: marker + `trigger` with `force`-style idempotency bypass semantics (cooldown and change-gate bypassed), no read-cache purge beyond what completion does.
- `full` → `read-caches` steps + `rollups` trigger.
- `wait: "complete"` → poll the queued job ≤60s, return final state; else return immediately.
- Response `RefreshResponse`: `{scope, gate, actions: string[], jobId, deferred, eventId, changed}` — says exactly what happened. **404 on unknown ds** (fixes the fails-open E2E finding for this verb; the legacy source-changed route keeps its current behavior).
- `POST .../source-changed` remains as the stable alias for `scope=auto` (connectors don't churn); `backend/scripts/signal_data_changed.py` gains `--scope` (default auto).

**2d. `POST /api/v1/admin/providers/{provider_id}/refresh`** — guarded batch. Body `{scope="auto", force=false, maxConcurrent=2}`. Enumerates the provider's data sources, runs per-source refresh with bounded concurrency, honoring each source's gate/cooldown unless `force`. Batch state (per-source status/outcome) lives in Redis under a `refreshbatch:{id}` hash, TTL 24h. Returns `{batchId, total}`; **`GET /api/v1/admin/refresh-batches/{id}`** polls progress. Runs where the aggregation service is in-process (control plane; viz proxies), as a background task; one batch per provider at a time (409 on overlap).

## 3. Scheduler / listener integration

No behavioral change. `signal_source_changed` gains the audit emit + an `origin` passthrough; scheduler drift/reconcile calls pass `origin="drift"`/`"reconcile"`; the listener adds the completion/failure audit emit next to its existing marker-clear. Result: every refresh — human, script, connector, or autonomous — is attributable in one table.

## 4. Frontend — Ingestion → "Freshness" tab

- New tab in `frontend/src/pages/IngestionPage.tsx` beside the existing tabs; component tree under `frontend/src/components/admin/Freshness/`.
- **Fleet table** (React Query, 30s refetchInterval, keys under a new `FRESHNESS_KEYS`): columns — Source (name + provider chip), Aggregation (StatusChip + "updated Xm ago" from lastMaterializedAt/lastAggregatedAt), Cache ("as of Xm ago" from cacheAsOf; em-dash when null), Freshness (badges: "Recomputing · Xm" when marker set, "Drift detected" when drifted, cooldown countdown "next rebuild in Xm"), Last activity (origin + outcome + ago), Actions (dropdown: "Refresh caches" → read-caches, "Rebuild lineage" → rollups w/ confirm, "Full refresh" → full w/ confirm; disabled while a job runs). Plain-language labels; white-label copy; `useDocumentTitle`.
- **Row drawer**: the full freshness document, "Probe now" button (`?probe=true`, shows live counts + drift), LKG summary, last payload_too_large if surfaced, event history (last 20, origin/outcome/actor/ago).
- **Provider grouping** with a "Refresh provider…" action → dialog (source count, scope picker, force checkbox with warning copy, cost note) → polls the batch endpoint with progress bar + per-source outcomes.
- Filters: workspace, provider, "needs attention" (marker set OR drifted OR failed).

## 5. Performance & failure posture

Fleet = one SQL query + pipelined Redis reads; per-source probe explicit and 5s-bounded; audit writes best-effort; batch endpoint is the only fan-out and is visibly bounded + single-flight per provider; zero new read-path work; every new Redis helper follows graph_cache's never-raise conventions. All existing convergence invariants (read paths never trigger work; overlay post-cache; SWR LKG split) unchanged.

## 6. Testing & verification

- Backend: endpoint suites — fleet assembly with fake Redis/DB (nulls on missing), per-source doc ± probe, refresh scope×gate×force×cooldown matrix, 404s, batch bounding + overlap 409 + per-source outcomes, audit emission per origin (signal/drift/reconcile/listener), migration up/down. Run per-file in-container (verify `git branch --show-current` first — concurrent sessions may switch the tree).
- Frontend: tab tests per the RegistryConnections.test pattern (table renders fleet payload, action calls, badge states); tsc baseline unchanged.
- Live: extend the E2E recipe — each scope exercised against a real source; audit rows visible; stray-marker scenario (the known `ws_438429af72a9/ds_5181ba1ba07e` marker, if still present, must show as "needs attention" in the tab — a real-world fixture).

## Out of scope (explicitly)

Connector convergence webhooks, SSE freshness stream, Prometheus metrics (Approach C follow-ons); fixing the Redis DB0-vs-CACHE_REDIS_URL keyspace split; CP/worker stdout log visibility; per-view freshness (exists elsewhere).

## 7. UI/UX uplift (user addition 2026-07-19, screenshot-driven)

Problems: flat ~59-row scroll dominated by NOT BUILT noise; no fleet summary; filters minimal; "Up to date" shown for never-built sources (misleading).
Decisions (user-approved): triage-first default (severity sort failed→recomputing→drifted→cooldown→ready→not built; provider groups with nothing actionable collapsed to a one-line rollup); "Build lineage" CTA on never-built rows via the rollups scope (also closes the never-aggregated gap through the UI).
Design:
- **Fleet summary (server-side)**: `summary` object on the fleet response — {total, ready, pending, failed, notBuilt, recomputing, needsAttention, cacheStamped} — computed over the workspace/provider-filtered set BEFORE staleOnly/pagination, in the same assembly pass; omitted (null) when the filtered set exceeds 1000 sources (FE hides tiles gracefully). "recomputing" = stale marker present; "needsAttention" = marker OR failed; "cacheStamped" = cacheAsOf non-null; "pending" = a rebuild job is IN FLIGHT (live AggregationJobORM pending|running — the same signal as runningJobId; the mirror column's "pending" status value is write-path-dead and must not be used). A row can be both ready and pending (last run succeeded, new rebuild in flight) — tiles are overlapping facets, not a partition.
- **Stat-tile band = filters**: KPI tiles (Total/Ready/Rebuilding/Needs attention/Not built/Cache coverage) that toggle the corresponding table filter on click.
- **Sticky faceted filter bar**: Provider + Workspace multi-select (with counts), status segmented control, name search, removable filter chips, URL-synced state (repo convention: state derives from URL).
- **Table**: severity-sorted, collapsible provider groups with mini-rollups, sticky headers, denser rows. Never-built rows: freshness cell "Never built" (+ CTA), no fake "Up to date", collapsed em-dashes.

## 8. Cheap-tier cache stats + fleet refresh (user addition 2026-07-20)

Goal: "see cache stats per provider and per data source, and trigger a full refresh of everything from the UI." Cheap = reuse already-assembled data + on-demand bounded SCANs; NO new telemetry infra, NO per-row SCAN on the fleet path, invariants preserved (fleet stays DB+Redis-only, no read-path triggering).

### 8a. Per-provider summaries (fleet response) — G1
`FreshnessFleetResponse.providerSummaries: Optional[list[ProviderFreshnessSummary]]`, each `{providerId, providerName, total, ready, pending, failed, notBuilt, needsAttention, cacheStamped}`, computed in the SAME in-memory pass as the fleet `summary` (over the workspace/provider-filtered set, before staleOnly/pagination); `None` whenever `summary` is None (>1000 cap). Zero extra queries/Redis — a GROUP BY over rows already read. Pagination-accurate (not client-side over the 200-row page).

### 8b. Per-source cache-key counts (doc, on-demand) — G1
`FreshnessDoc.cacheKeyCount: Optional[int]` + `cacheKeyCountByEndpoint: Optional[dict[str,int]]` — one bounded SCAN over `graphcache:v1:{ws}:{ds}:{branch=""}:{current_gen}:*` (current generation = the live/usable entries), tally by the endpoint segment (split index 6). Best-effort, null on Redis error. DOC-ONLY (per-source, on-demand when the drawer opens) — never on the fleet list. Pairs with the existing `lkgCount`/`lkgOldestAgeSecs`.

### 8c. Fleet-wide guarded refresh — G2
`POST /api/v1/admin/freshness/refresh-all` (system:admin, proxy-aware + CP twin) — enumerates ALL live sources (deleted_at IS NULL) across every provider and runs the F5 batch runner with a GLOBAL single-flight lock (`refreshbatch:lock:__fleet__`), bounded concurrency, `{scope=auto, force=false}` body; returns `{batchId, total}`; progress via the existing `GET /refresh-batches/{id}`. 409 if a fleet batch is already running. actor/origin server-forced (api). Reuses F5's runner/hash/guard verbatim — only the enumeration source and lock key differ.

### 8d. FE — G3
- Provider group header: cache-coverage chip (cacheStamped/total for that provider, from providerSummaries) + the existing state rollup; expanded groups get a compact per-provider stat strip.
- Drawer "Cache contents" section: total cached entries + per-endpoint breakdown (cacheKeyCountByEndpoint) + the existing LKG count/age.
- Tab header: "Refresh all sources" button (system:admin, confirm dialog naming the total + cost/SWR reassurance copy), wired to 8c + batch progress (reuse the ProviderRefreshDialog progress shape). White-label, plain-language, tsc 76→76.

## 9. Force-clear + failed-rebuild resilience (user, 2026-07-20)

Context: large graphs (Sol Xlarge Test 239k edges, Physical Lineage5 60k) fail aggregation with FalkorDB `OutOfMemoryError` (store pegged at its 12G ceiling). The failed job leaves the stale marker set, so the reconciler re-signals every 60s (generation climbed to 93) and the UI shows "Recomputing" forever — misleading, and wasteful load on an already-strained store. Three parts:

### 9a. Force-clear scope (H1) — "clear the cache for any data source, no rebuild"
New refresh scope `clear` on `refresh_source`: the `read-caches` steps (clear_content_caches + invalidate_hierarchy_reads + purge_lkg(aggregated) + mark_stats_changed) PLUS `clear_source_stale(ws, ds)` — the only scope that clears the marker, so it *un-sticks* a stuck source. No gate, no cooldown, no rebuild → safe even when the store is out of memory. Auto-propagates to per-source / provider batch / fleet batch (they take any scope). Response `actions` records `marker_cleared`. This is the realistic "clear everything for this source; hierarchy recomputes lazily on next page load" (the aggregated overlay still needs a rebuild — documented).

### 9b. Reconciler failure backoff (H2) — stop the every-60s churn
The scheduler reconciler additionally skips a marked source when `aggregation_status == "failed" AND (now - state.updated_at) < resolve_rebuild_interval(...)`. Migration-free (reuses existing status + updated_at + the cadence chain). Effect: a permanently-failing rebuild is retried at most once per cadence window (e.g. 1h) instead of every tick; the marker is KEPT so the source still reads "needs attention." Escalating backoff is a noted future enhancement.

### 9c. Failure surfacing + honest badge + resolution guidance (H1 backend fields, H3 FE)
- FreshnessDoc gains (doc-only, one bounded query on the latest job): `lastFailureReason` (raw error_message), `lastFailureCategory` (classified server-side: `out_of_memory | provider_unavailable | ontology | timeout | conflict | unknown`), `retryCount`.
- **Honest badge** (FE): "Recomputing" shows ONLY when a job is genuinely running (`runningJobId`); `aggregationStatus === 'failed'` → a red "Rebuild failed" state; marker set but no running job and not failed → "Queued"; else the existing states. No more "Recomputing" on a dead/failed source.
- **Resolution guidance (premium UX)** in the drawer for failed/attention sources: a rich panel stating **what** happened, **why** (category-specific, plain-language), and **how to resolve**, with **CTAs** — "Clear cache" (the safe 9a scope, primary), "Retry rebuild" (rollups; warns "may fail again until memory is freed" when category is out_of_memory), and category-specific guidance (e.g. OOM → free graph-store memory / raise its limit; ontology → assign an ontology; provider_unavailable → check the provider). Guidance is design-system-consistent, accessible, and calm (not alarmist).
