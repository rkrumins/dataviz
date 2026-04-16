# Architecture when scaling — deferred horizontal-scale plan

> **Status:** **Future architecture, not active scope.** This document
> captures the design we'd execute *when* operational load justifies
> horizontal scale-out. Today Synodic runs as a single process with
> one Postgres v16 — that's the right shape for current scale.
>
> Original location: this lived as "Phase 6" of the schema-optimization
> plan. The cleanup pass extracted it to its own doc to make the active
> backlog reflect what's *actually being built*, not what *might* be
> built later. The plan kept Phase 6 as scoped work, which created
> pressure to start building distributed-systems machinery for a
> deployment shape that doesn't exist.

## When this becomes real

Trigger conditions — any one of these flips this from "design notes" to
"funded work":

1. P99 latency on the web tier consistently exceeds the SLO under
   normal load (i.e., one process can no longer keep up).
2. A single aggregation job's runtime starves the rest of the API for
   tens of seconds at a time, even with the Phase 0 checkpoint
   coalescing in place.
3. A real customer commitment requires multi-replica HA (RTO < ~5
   minutes) that one process cannot provide.
4. Operations need to deploy without dropped requests (rolling
   restart) and the existing single-process restart window is no longer
   acceptable.

Until then: don't build any of this. Module-level dicts work fine for
one process. The InProcessDispatcher works fine for one process. There
is no advantage to Redis / control-plane / role-gating in a deployment
that has nothing to coordinate.

## What changes if we do build it

Three deployment tiers, all from the same image, gated by env var:

| Tier | Replicas | Workers per replica | Roles |
|---|---|---|---|
| `synodic-web` | N (autoscale on CPU/RPS) | M (`UVICORN_WORKERS`, default 4) | HTTP API, auth, reads, lightweight writes |
| `synodic-worker` | K (autoscale on Redis stream lag) | 1 process, `WORKER_CONCURRENCY` async tasks | Aggregation execution, heavy provider I/O |
| `synodic-controlplane` | 1 (`replicas: 1`, `strategy: Recreate`) | 1 | Scheduler, outbox relay, crash recovery, Alembic runner |

Same code, different `SYNODIC_ROLE ∈ {web, worker, controlplane}` env var
gates which subsystems start in `lifespan()`.

## Mandatory infrastructure (when it's time)

- **Postgres v16+** — already enforced today.
- **Cache Redis (`REDIS_CACHE_URL`)** — vanilla Redis with
  `maxmemory-policy=allkeys-lru`, persistence optional. Backs the
  shared cache abstraction that replaces the in-memory `_test_cache`,
  `_test_inflight`, and provider-registry caches.
- **Coordination Redis (`REDIS_COORDINATION_URL`)** — vanilla Redis
  with `maxmemory-policy=noeviction` and AOF. Backs distributed locks,
  the aggregation Streams broker, rate-limit counters, and replica
  health gossip.

### Cache vs coordination — never combined

| Concern | Cache Redis | Coordination Redis |
|---|---|---|
| Eviction | `allkeys-lru` (TTL-aware) | `noeviction` (lock loss = correctness violation) |
| Persistence | None / RDB-only | AOF |
| Failure blast radius | Cache miss → cold reads from Postgres | Some 503s + per-process correctness fallback |
| Memory profile | Small | Small unless backlog grows |
| Latency target | <1ms | <2ms |

The eviction policies are *incompatible* — one Redis can't satisfy both
roles. A single instance with `allkeys-lru` could evict an aggregation
job's lock under cache pressure (correctness violation). With
`noeviction` the cache fills and starts returning OOM errors.

Graph providers (FalkorDB, Neo4j, DataHub) are external services
registered via the `providers` table — **never** part of platform
infrastructure. The platform makes no assumptions about which graph
backend operators run.

## Web tier — stateless mandate

Every module-level mutable state moves to Redis or is eliminated:

- `_test_cache`, `_test_inflight` in [providers.py](../backend/app/api/v1/endpoints/providers.py) → Redis-backed `SharedCache`.
- `_providers: dict` and negative cache in [provider_registry.py](../backend/app/registry/provider_registry.py) → Redis-backed signal store; per-process driver pooling stays.
- `InProcessDispatcher._active_tasks` → web tier always uses an outbox-based dispatcher; the actual aggregation runs in the worker tier.
- `AggregationScheduler` does NOT start in the web tier — control-plane only.
- `recover_interrupted_jobs()` runs in the control-plane only, batched ≤10 dispatches/sec to avoid flood-on-restart.
- `slowapi` rate limit storage moves to Redis (`limits.storage.RedisStorage`) — the in-memory backend silently *bypasses* rate limiting once you have N>1 replicas.

## Worker tier

- New deployment built from `backend/app/services/aggregation/__main__.py`.
- Reads jobs from the `aggregation.jobs` Redis Stream via `XREADGROUP` with consumer group `synodic-workers`. Acks (`XACK`) only after durable status update in Postgres.
- Per-DS lock (`lock:agg:ds:{ds_id}`) acquired before `worker.run()`, released in `finally`. TTL renewal background task on a 30s TTL with 5s renew cadence.
- Concurrency: `WORKER_CONCURRENCY` env (default 4) async tasks per worker. `K replicas × WORKER_CONCURRENCY` = total parallel aggregation throughput.
- Graceful shutdown: SIGTERM → stop pulling new jobs → wait up to 60s for in-flight to checkpoint → exit. K8s preStop hook + `terminationGracePeriodSeconds: 90`.

## Control-plane tier

- Single replica (`replicas: 1, strategy: Recreate`). No leader election needed; k8s guarantees no two pods at once via `Recreate`.
- Roles enabled by `SYNODIC_ROLE=controlplane`:
  - `OutboxRelay` lifespan task — drains `outbox_events` → Redis Streams.
  - `AggregationScheduler` — periodic drift detection + cron-based re-aggregation triggers.
  - `recover_interrupted_jobs()` — runs once at startup (rate-limited).
  - `provider_registry.start_polling()` — periodic provider health write-back.
- Reads/writes Postgres + Redis; no inbound HTTP. K8s probe via `/internal/controlplane/health`.

## New code we'd write (when scaling)

- `backend/app/runtime/redis_clients.py` — sole owner of Redis client construction. Two singletons: `cache_client()` (against `REDIS_CACHE_URL`), `coordination_client()` (against `REDIS_COORDINATION_URL`).
- `backend/app/cache/shared.py` — `SharedCache` interface (`RedisSharedCache` for prod, `InProcessSharedCache` for `SYNODIC_ROLE=dev`).
- `backend/app/locks/distributed.py` — `DistributedLock` async context manager. `SET NX EX` + TTL renewal in a background task; releases via Lua script for atomic check-and-del. Falls back to `asyncio.Lock` in dev.
- `backend/app/runtime/role.py` — `SynodicRole` enum + `current_role()` + `validate_redis_topology()`. `lifespan()` consults at every gate point.
- `backend/scripts/migration_runner.py` — usable as either control-plane lifespan call or standalone k8s Job.
- Static guarantee: `scripts/check_redis_client_usage.py` CI lint. Walks the codebase, fails if any module imports `aioredis`/`redis` outside `runtime/redis_clients.py`. Makes accidental cross-wiring impossible to ship.

## Connection management

- Postgres pool (Phase 2.5 already shipped) — tier-specific defaults at deployment time:
  - Web: `DB_POOL_SIZE=20` per process, M=4 workers → 80 conn/replica.
  - Worker: `DB_POOL_SIZE=10`.
  - Control-plane: `DB_POOL_SIZE=5`.
- Postgres budget: deployment doc reconciles `(N×80 + K×10 + 5)` against `max_connections`. Pgbouncer in front for any N>3.
- Redis: two `aioredis` clients per process. `REDIS_CACHE_POOL_SIZE` (default 25), `REDIS_COORDINATION_POOL_SIZE` (default 25).

## Migrations and startup

- Alembic `upgrade head` runs **only in the control-plane** lifespan, OR as a k8s `Job` ahead of the rollout. Web and worker tiers wait on a "schema ready" Redis key set by control-plane after migration completes; if not present after 60s, fail the readiness probe.

## Frontend / API contract

- Frontend already uses a single base URL (load balancer / ingress). No fetch logic changes needed.
- **Sticky sessions forbidden.** Any feature that assumes per-user in-memory state breaks. (None today, verified.)
- Long-lived connections (SSE for job progress, if added) must use Redis pub/sub on the backend so any web replica can fan events out from any worker.
- New `X-Synodic-Replica-Id` response header (uuid per process) — debugging aid surfaced in DevTools.

## Observability

- New `/internal/metrics` endpoint (Prometheus exposition format, admin-auth gated). Exposes:
  - DB pool stats per tier (today: shipped via [db_metrics.py](../backend/app/middleware/db_metrics.py)).
  - Redis stream lag (`XLEN` vs. consumer-group last-id) on `aggregation.jobs`.
  - Outbox backlog size.
  - Active aggregation jobs by status.
  - Per-tier role identifier for routing dashboards.
- K8s probes: `/health/live` (process responsive), `/health/ready` (DB + Redis reachable, Alembic head matches schema-ready key).

## Breaking changes (operator-visible)

When this work happens:

1. `MANAGEMENT_DB_URL` already enforced as `postgresql+asyncpg://` — no change.
2. `REDIS_CACHE_URL` and `REDIS_COORDINATION_URL` become mandatory for any non-`dev` role; must point at distinct Redis instances; validated at startup.
3. `SYNODIC_ROLE` env var must be set on every deployment.
4. The aggregation in-process dispatcher is removed from the web image's runtime path. Calling `POST /aggregate/trigger` without a worker tier deployed yields 503 with a clear error.
5. Provider registry's in-process credential cache is replaced — direct callers of `provider_registry._providers[...]` would break (none expected outside the registry module).
6. `slowapi` rate limits previously per-process become global; high-traffic endpoints may need their per-second numbers bumped.

## Verification checklist

- `SYNODIC_ROLE=web` + 3 replicas behind nginx → POST `/aggregate/trigger` 100× concurrent: exactly 1 × 2xx, 99 × 409.
- Kill 1 of 3 web replicas mid-request → load balancer routes; no requests dropped.
- Run 2 worker replicas → 50 jobs queued in stream; both consume from `synodic-workers` group; no double-processing.
- Kill worker mid-aggregation → `XPENDING` shows unacked entry; restart picks it up via `XCLAIM`.
- Stop control-plane replica → scheduler stops, outbox stops draining; restart → resumes; web/worker tiers keep serving / consuming throughout.
- `redis-cli FLUSHALL` mid-load → web tier degrades gracefully (cache misses, dedup falls back to per-process); control-plane logs degraded; outbox backlog grows but no data loss in Postgres.
- Postgres failover → web tier sees ~5s of 5xx then recovers (`pool_pre_ping` catches dead conns); workers re-establish; outbox replays unprocessed events.
- `helm upgrade` of web tier → zero dropped requests; control-plane untouched; workers untouched.

## Estimated scope when triggered

- Roughly 4–7 days of focused work for the platform changes.
- Plus deployment-platform work (helm chart, k8s manifests, Redis provisioning, monitoring dashboards) — out of scope for the platform team.

## Open design questions (resolve when starting)

- **Broker swap path.** Phase 4's outbox dispatcher Protocol stays useful — RedisStreamHandler is the obvious first implementation, RabbitMQ/Kafka are mechanical swaps. Picking the broker is a deployment-team decision, not a platform-architecture one.
- **Per-tenant rate limiting.** The `slowapi` Redis backend gives global limits. Per-tenant limits require a different key derivation. Defer until it's a real ask.
- **Read replicas.** SQLAlchemy's `bind` mechanism supports per-table or per-query routing to a read replica. Useful when control-plane reporting queries start contending with web-tier writes. Not needed at first.
