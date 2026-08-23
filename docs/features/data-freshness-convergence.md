# Data-Freshness Convergence for External Loads

**Status:** shipped (branch `claude/falkordb-redis-connectivity-va6czv`, commits `a52cfcf1..d3bdb721`, 2026-07-17/18)

## The problem

Data loaded into FalkorDB **outside the app's write APIs** — import/seed scripts, external connectors syncing behind the scenes — was invisible to the read path. Users confirmed the data in FalkorDB while the Context View canvas served different (older or thinner) data. Four compounding causes, all confirmed by investigation:

1. **Stale `:AGGREGATED` overlay.** `/edges/aggregated` reads pre-materialized rollups; reads never trigger materialization (the read-path auto-heal was removed in `110cd431` after backfill storms). Nothing re-aggregated after an external load, and the API reported the healthy-but-outdated overlay as `stale=false` (staleness detection was structural only).
2. **Response cache never invalidated.** All canvas endpoints share a per-`(workspace, data source, branch)` generation counter (`graph_cache.py`); external writes never bumped it, masking changes for up to the TTL (aggregated: 15 min; last-known-good snapshots: 1 day).
3. **`payload_too_large` stranded stale entries.** When a result outgrew the 1 MiB cache cap, the write was skipped but the older smaller entry at the same key was never deleted — the fresh answer could *never* replace the stale one.
4. **Incomplete results cached as complete.** A timed-out aggregated batch silently returned `[]`; the shrunken result (and 100k-capped results) cached at full TTL, and the frontend silently dropped edges it couldn't place.

## The design

One invariant: **a single "source changed" event — explicit or detected — makes every canvas read path (containment hierarchy, top-level roots, layer assignment, aggregated lineage) converge to the new FalkorDB state, with honest staleness flags until convergence.** Rebuild work is bounded per source per window regardless of sync frequency or user count.

```
signal (script | connector API | drift sweep | reconciler)
  → fingerprint change gate (no-op syncs are free; --force bypasses)
  → set stale marker (aggstale:v1:{ws}:{ds}, reason "source_changed")
  → clear provider content caches (7-day ancestor-chain + urn-label)
  → bump cache generation + purge non-aggregated LKG   ← hierarchy converges NOW
  → nudge stats / top-level roots materialization
  → queue rebuild (idempotency-keyed, cooldown-throttled)
  … reads meanwhile: hierarchy fresh; aggregated = previous rollup, flagged stale …
job.completed (event listener)
  → bump generation again + purge aggregated LKG + clear marker + store fingerprint
  → stats nudge → cache warmer re-warms hot keys
  → lastMaterializedAt flips → frontend epoch invalidation → canvas refreshes
```

Key decisions:

- **Stale-while-revalidate, not cold-cache.** Users keep fast responses during a rebuild; the aggregated LKG deliberately *survives* the signal (it still matches the live overlay) and is purged only at completion. Staleness is overlaid **post-cache** so cached hits are flagged without baking `stale` into cached payloads.
- **Change-gated + throttled.** The gate compares a counts-based graph fingerprint server-side; unchanged syncs do nothing. Confirmed changes always invalidate (cheap), but the rebuild itself fires at most once per `AGGREGATION_REBUILD_MIN_INTERVAL_SECS` (default 900) per source; within the window the signal returns `deferred: true`.
- **Eventual consistency with a reconciler.** The scheduler tick (60s) acts on fingerprint drift for scheduled sources and sweeps the stale markers (≤50/tick) for *all* sources: deferred rebuilds fire when the cooldown elapses, failed rebuilds are retried, false markers are cleared, in-flight rebuilds (`pending` state) are left alone. Strictly schedule/event-driven — **read paths never trigger work** (the `110cd431` constraint stands).
- **Manual resolution always available**: `--force` on the signal (bypasses gate + cooldown; needed for count-neutral changes like re-parenting, since the fingerprint is counts-only), and the pre-existing manual re-aggregation endpoint.

## What changed (by component)

| Area | Change | Files |
|---|---|---|
| Response cache | Delete-on-oversize (stale entry can't outlive model growth); truncated/stale results get 5s negative TTL and never become LKG (incl. nested `aggregated`/`aggregated_delta`); stale-source marker helpers; `invalidate_hierarchy_reads` (gen bump + LKG purge with aggregated carve-out); `list_stale_sources` | `backend/app/services/graph_cache.py` |
| Provider | Failed aggregated batches flag the result `stale/degraded/truncated` instead of silently shrinking it; `clear_content_caches()` bulk-clears ancestor-chain/urn-label caches + run-meta memo | `backend/app/providers/falkordb_provider.py` |
| Signal | `AggregationService.signal_source_changed` (gate → mark → clear → invalidate → nudge → throttled trigger; never raises after invalidation; not-applicable sources are never marked) | `backend/app/services/aggregation/service.py`, `schemas.py` |
| Entry points | Control-plane route `POST /aggregation/data-sources/{id}/source-changed`; admin route `POST /api/v1/admin/data-sources/{id}/source-changed` (`workspace:datasource:manage`, proxy-aware); loader script `python -m backend.scripts.signal_data_changed --graph <name> [--force]` | `controlplane.py`, `api/v1/endpoints/aggregation.py`, `backend/scripts/signal_data_changed.py`, `backend/scripts/README.md` |
| Scheduler | Acts on drift + reconciles stale markers (both gated by `AGGREGATION_DRIFT_AUTO_REBUILD`, default on; skips in-flight/in-cooldown sources) | `backend/app/services/aggregation/scheduler.py` |
| Event listener | Clears the stale marker on `job.completed` only (failures keep it → reconciler retries) | `backend/app/services/aggregation/event_listener.py` |
| Read overlay | While the marker is set, `/edges/aggregated` + canvas bootstrap/expand responses carry `stale: true, staleReason: "source_changed"` (post-cache; never overwrites structural reasons) | `api/v1/endpoints/graph.py`, `canvas.py`, `common/models/graph.py` |
| Frontend | Blue "Source data changed — lineage is being recomputed" banner (self-clears); truncation banner now includes the unplaceable-connection count; truncated merges are no longer cached client-side (stale merges are — required for SWR) | `useAggregatedLineage.ts`, `useEdgeProjection.ts`, `ContextViewCanvas.tsx`, `GraphDataProvider.ts` |

## Configuration

| Env var | Default | Meaning |
|---|---|---|
| `AGGREGATION_REBUILD_MIN_INTERVAL_SECS` | `900` | Min interval between signal-triggered rebuilds per source; `0` disables throttling. Invalidation/marking is never throttled. **Env is the fallback only**: a persisted global (`PUT /aggregation/settings`, or the Freshness tab's Cadence settings) and a per-source override (`PATCH /admin/data-sources/{id}/freshness-settings`, or the source drawer) take precedence — resolution is override → global → env, shared by the cooldown gate, the reconciler, and the UI badge. |
| `AGGREGATION_DRIFT_AUTO_REBUILD` | `true` | Scheduler acts on drift + reconciles markers. `false` restores notify-only. Same persisted-global override applies. |
| `GRAPH_CACHE_MAX_PAYLOAD_BYTES` | `1048576` | Cache-entry cap. Raise (e.g. 8388608) for large-model aggregated payloads; oversized results now *delete* the stale entry rather than stranding it. |

## Operating it

- **After any direct load**: `python -m backend.scripts.signal_data_changed --graph <name>` (or `--data-source-id <id>`). External connectors call the admin API instead.
- **Re-parenting / property-only changes**: the fingerprint is counts-based and won't see them — use `--force`.
- **A source shows the stale banner "forever"**: check the aggregation job pipeline (a failing rebuild keeps the marker on purpose; the reconciler retries each window). The marker also has a 7-day TTL backstop.
- **Immediate resolution**: `--force` signal or the manual re-aggregation endpoint (both bypass the cooldown).

## OPS API

Operator-facing surface, mounted under `/api/v1/admin` (Ingestion-surface read gate unless noted):

- `GET /admin/freshness` — paged fleet freshness overview (`workspaceId` / `providerId` / `staleOnly` filters).
- `GET /admin/data-sources/{id}/freshness` — per-source detail; `?probe=true` adds one live provider stats call.
- `POST /admin/data-sources/{id}/refresh` — unified refresh verb (`scope`: `auto` | `read-caches` | `rollups` | `full`; `force`; `wait`). Gated by `workspace:datasource:manage`.
- `POST /admin/providers/{providerId}/refresh` — guarded batch refresh: fans `POST .../refresh` out across every live (non-deleted) data source under the provider, bounded to `maxConcurrent` (capped at 4). Returns `202` with a `batchId` immediately; one item failing is recorded, not fatal, to the rest. A single-flight lock (`refreshbatch:lock:{providerId}`, 1h TTL) rejects an overlapping batch for the same provider with `409`. Platform-admin only (`system:admin`) — a provider's sources can span workspaces the caller may not otherwise manage.
- `GET /admin/refresh-batches/{batchId}` — poll batch progress/outcomes (`state`: `running` | `done`; `results`: per-source `outcome` + `jobId`). Batch state lives in Redis for 24h.

## How to validate

**Unit suites** (run per-file in the viz container):
`docker exec synodic-dev-viz-service-1 python -m pytest /app/backend/tests/test_graph_cache.py /app/backend/tests/test_source_changed_signal.py /app/backend/tests/test_stale_overlay.py /app/backend/tests/test_aggregation_event_listener.py -q` — covers delete-on-oversize, incomplete-TTL rules, marker lifecycle, gate/cooldown/deferral ordering, reconciler triage (pending/cooldown/ready), overlay semantics.

**Live loop** (verified end-to-end on the dev stack 2026-07-18, evidence in `.superpowers/sdd/cf-e2e-report.md`):
1. Restart `aggregation-controlplane` + `aggregation-worker` after checkout (bind-mounted, no autoreload).
2. Mutate a graph out-of-band: `redis-cli -p 6379 GRAPH.QUERY <graph> "CREATE (:Table {urn:'urn:x'})"`.
3. Signal it; verify: `graphcache:gen:*` incremented; non-aggregated `graphcache:lkg:v1:*` keys purged while `:aggregated:` ones survive; `aggstale:v1:{ws}:{ds}` = `source_changed`; reads show the new node immediately (hierarchy) and `stale=true, staleReason="source_changed"` (aggregated) with the blue canvas banner.
4. After the job completes: marker gone, generation bumped again, fresh lineage, banner cleared.
5. Re-signal without changes → `changed: false`, nothing invalidated. Signal again within 15 min of a rebuild → `deferred: true`, reconciler fires it when the window opens.
6. While a rebuild runs (or during cooldown): the generation counter must stay flat across scheduler ticks (no churn).

## Known limitations / follow-ups (accepted, tracked)

- Counts-only fingerprint: count-neutral changes need `--force` (documented in the scripts README). Note this now applies to the reconciliation sweep too — it derives its own counts-based baseline, so a re-parent or a property edit is invisible to it as well.
- A **wiped `:AGGREGATED` overlay** was invisible to this design: the signal only fires when something announces a change, and the drift sweep required an `aggregation_schedule` cron nothing sets. Closed by automatic reconciliation (2026-08-14), which checks overlay integrity from the stats service's cached counts on a schedule — see [aggregation-reconciliation.md](aggregation-reconciliation.md).
- A persistently *failing* rebuild re-runs invalidation each tick until the pipeline is fixed (bounded job creation via the 60-min idempotency window; proper fix = cooldown vs latest job attempt).
- `force` + trigger failure + count-neutral change: the reconciler may later clear the marker via `changed=false` without a rebuild having run.
- Frontend epoch flip can lag ≤5 min after completion (cross-process `_agg_meta_cached`); edges themselves are fresh at the completion gen bump.
- graph_cache + marker live on the DB-0 Redis (`REDIS_URL`) rather than `CACHE_REDIS_URL` (pre-existing; keyspace isolation follow-up).
- Signal on an unknown data-source id returns `changed: true` (no existence check); CP/worker app-level INFO logs don't reach `docker logs` (observability follow-up).
- ~~Never-aggregated sources get cache convergence but no first rebuild from the signal~~ — **closed** by automatic reconciliation (2026-08-14): its `never_aggregated` detector queues the first build directly through `trigger()`, capped at one per sweep. The signal path itself is unchanged — a `none` status is still not-applicable there by design. See [aggregation-reconciliation.md](aggregation-reconciliation.md).
- Latent (test-scenario only): if a change lands a graph back on a fingerprint aggregated <60 min ago, the `source-changed:{fingerprint}` idempotency key collapses the rebuild each window until the 60-min replay expires (post-cooldown ticks re-invalidate meanwhile). Real loads produce novel fingerprints, so this doesn't arise normally.
