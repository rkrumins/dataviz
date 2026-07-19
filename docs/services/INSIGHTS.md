# Insights Service

The insights service is the headless background service that keeps per–data-source
statistics, graph-schema profiles, and pre-registration asset discovery fresh —
so the web tier can answer "how big is this graph, what's in it, and is it
healthy?" from cache instead of hitting a provider on every request.

Related reading: [Platform Services](/docs/services-overview),
[Aggregation pipeline](/docs/aggregation-pipeline), [Backend guide](/docs/backend).

## Purpose / What it does

The service continuously polls registered data sources and profiles their graphs,
writing the results to PostgreSQL where the web tier reads them. It has two
collection facets and a discovery path:

- **Counts facet (`stats_poll`)** — the cheap facet: node/edge counts plus
  per-type breakdowns via two grouped scans. Partial-upserted so counts
  freshness never waits on schema work. Triggered by the scheduler interval,
  by read-path "stale" enqueues, and by app write paths.
- **Deep facet (`stats_deep`)** — one `get_schema_stats` pass (labels + samples,
  edge-type, tag scans) that serves both the counts derivation and the
  graph-schema build, then stamps `schema_updated_at`. Includes change
  detection: a cheap counts probe is compared against the stored row, and when
  nothing changed the expensive schema scans and rebuild are skipped and only
  freshness markers advance.
- **Discovery** — pre-registration asset listing and per-asset stats for a
  provider, so the registry UI can browse a provider's assets before a data
  source is created.

For large graphs, the counts lane also **materializes a top-level-nodes payload**
into Postgres so the entry-list endpoint serves pages from the DB instead of
running an expensive live roots query per request, and a **cache warmer**
pre-fills the graph cache for the first few endpoints a user hits when opening a
data source.

## Where it runs

The insights service is a **separate headless process**, not part of the FastAPI
web tier. It is started with:

```bash
python -m backend.insights_service [--health-port PORT]
```

(`Dockerfile.insights` uses this as its entrypoint.) The entrypoint wires up
concurrent tasks in one event loop:

1. **Scheduler** — every tick, finds due data sources and enqueues jobs to Redis.
2. **Worker** — an `XREADGROUP` loop over the job streams, routing each message
   through a dispatcher to the registered handler under per-lane concurrency
   budgets.
3. **Discovery scheduler** and a periodic **stream-trim** task.
4. **Health HTTP** — a minimal liveness endpoint (default port `8092`).

Jobs flow over **Redis Streams**, one stream per kind (post-registration stats,
deep schema, discovery, purge), each with its own consumer group; a single DLQ
(`insights.dlq`) collects exhausted messages tagged with their origin. Worker
concurrency is split into **lanes** — `fast` (counts polls + user-initiated
discovery), `sweep` (background discovery), `heavy` (deep schema scans), and
`purge` — so a slow large-graph scan can never starve the slots that keep counts
fresh. On `SIGTERM` the service drains in-flight jobs (up to
`STATS_DRAIN_TIMEOUT_SECS`) so restarts don't leave partial upserts.

**Admission control** guards provider I/O: a per-provider **Redis-backed GCRA
token bucket** caps the request rate across the whole worker fleet, and a
**rolling success window** (persisted to `provider_health_window`) feeds the
"provider degraded" UI. Duplicate enqueues are prevented by a Redis `SET NX`
dedup claim per `(data_source_id, tick)` with a size-aware TTL.

**Degradation contract:** if Redis is down the stats pipeline pauses (streams,
dedup claims, and cooldown keys all live in Redis), the web read path keeps
serving Postgres rows marked `status=stale`, and the admission GCRA fails open.
All Redis state here is advisory — lost claims and queue entries heal within a
scheduler tick; Postgres rows are the only authority.

## Key endpoints

The web tier exposes an admin surface under `/api/v1/admin/insights` (all routes
require `system:admin`). These reads are **cache-only** — the web tier never
calls a provider here; a cache miss enqueues a job into the insights service and
returns `200` with `meta.status="computing"`.

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/providers/{provider_id}/assets` | Cached asset list for a provider (discovery). |
| GET | `/providers/{provider_id}/assets/{asset_name}/stats` | Cached per-asset stats. |
| POST | `/providers/{provider_id}/assets/{asset_name}/refresh` | Enqueue a refresh for one asset. |
| POST | `/providers/{provider_id}/assets/refresh` | Enqueue a refresh for all assets. |
| GET | `/jobs/{job_id}` | Poll the status of an enqueued job. |
| GET | `/dlq` | List dead-letter-queue entries. |
| POST | `/dlq/{msg_id}/redrive` | Redrive a DLQ message back to its stream. |
| DELETE | `/dlq/{msg_id}` | Drop a DLQ message. |
| GET | `/admission/{provider_id}` | Read admission knobs + rolling-window health. |
| PUT | `/admission/{provider_id}` | Upsert per-provider admission knobs. |
| GET | `/discovery/status` | Last discovery-scheduler tick summary. |
| POST | `/discovery/trigger` | Run one discovery tick immediately. |
| GET | `/config` | Frontend-facing insights UX tuning values. |

Every cache-only read uses a universal envelope: `{ data, meta }`, where
`meta.status` is one of `fresh`, `stale`, `computing`, or `unavailable`.

## Configuration

The service reads all knobs from the environment. Required infra:
`MANAGEMENT_DB_URL` and `REDIS_URL` (a preflight check fails fast with a fix
pointer if either is missing).

Scheduler / worker tunables (defaults in parentheses):

| Env var | Default | Meaning |
|---------|---------|---------|
| `STATS_SCHEDULER_TICK_SECS` | `30` | Scheduler poll cadence. |
| `STATS_DEFAULT_INTERVAL_SECS` | `900` | Idle reconcile interval (freshness is mostly event-driven). |
| `STATS_MIN_INTERVAL_SECS` | `60` | Floor on per-source poll interval. |
| `STATS_WORKER_CONCURRENCY` | `4` | Fast-lane concurrency budget. |
| `STATS_SWEEP_CONCURRENCY` | `2` | Background-discovery lane. |
| `STATS_HEAVY_CONCURRENCY` | `1` | Deep schema-scan lane. |
| `STATS_PURGE_CONCURRENCY` | `1` | Purge lane. |
| `STATS_MAX_CONCURRENT_PER_GRAPH` | `1` | Cap on concurrent jobs per graph. |
| `STATS_MAX_DELIVERY_ATTEMPTS` | `3` | Redeliveries before DLQ. |
| `STATS_DRAIN_TIMEOUT_SECS` | `60` | Graceful-drain budget on shutdown. |
| `STATS_HEALTH_PORT` | `8092` | Liveness endpoint port (also `--health-port`). |
| `INSIGHTS_TRIM_INTERVAL_SECS` | `3600` | Stream-trim cadence. |
| `INSIGHTS_COUNTS_PARITY_CHECK` | `0` | Diagnostic: run direct count scans alongside the deep facet and log divergence. |

Per-provider admission knobs (`bucket_capacity`, `refill_per_sec`) are stored in
`provider_admission_config` and tuned live via the `PUT /admission/{provider_id}`
endpoint; workers re-read on their next acquire.

## How it appears in the product

The service is invisible except through the freshness and health it produces.
In the registry / assets UI, a `RefreshControl` pill renders
"Auto-refreshes every X · Last refresh Ym ago" from `GET /discovery/status`, and
cache-only reads let the frontend render a placeholder with an ETA chip while a
job is `computing`. A stuck pipeline (Redis down) surfaces as a
"background refresh paused" affordance when a read comes back `unavailable`.
Providers that fail repeatedly show as degraded via the rolling success window.

## Limitations

- The scheduler and worker run in the insights process. The web tier's
  `GET /discovery/status` reflects only the **web process's** view of that state,
  which is empty in a split-process deployment (live only in single-process /
  dev mode).
- Freshness is bounded by the scheduler tick plus poll interval; the default
  `900s` reconcile interval is a safety net, not the primary freshness mechanism
  (write paths enqueue within seconds).
- All queueing, dedup, and cooldown state is advisory Redis state — a Redis flush
  loses in-flight queue entries, which heal on the next tick but do not replay.
- Top-level materialization and cache warming are best-effort optimizations that
  only engage above a size threshold; they never block or fail a counts write.
