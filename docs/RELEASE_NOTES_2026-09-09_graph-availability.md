# Graph availability — 2026-09-09

Users opened views in the canvas and saw "Graph service is unavailable" while FalkorDB was
serving fine; the logs showed provider probes marking the provider unhealthy, and HTTP 504s.
A page refresh sometimes "fixed" it. This documents what caused it, what changed at each
layer, how to roll it out, how to verify it in production, and how to turn each change off.

Every behaviour change ships with an environment knob and a default. **Nothing requires
configuration** — but read [Rollout](#4-rollout) before deploying: two of the changes are
infrastructure files (ingress timeout, nginx image, backend image) that only take effect
when those are re-applied or rebuilt.

---

## 1. What was broken

One thing, read as another, at every layer: **a slow query was treated as a dead provider.**

**Backend — the breaker counted deadline misses.** Every Cypher query runs under an
`asyncio.wait_for` budget. When a heavy `/nodes/query` (an open view sorting a whole label)
ran past it, the resulting `TimeoutError` was in the circuit breaker's list of
network-class failures. Three in a row opened the breaker for 30s: every read 503'd,
`/api/v1/health/providers` reported the provider unhealthy, and every response carried
`X-Provider-Health: unreachable`. A server error *reply* (a query over the per-query memory
ceiling, a bad Cypher) was counted the same way through the catch-all clause.

**Backend — two 1.5s health PINGs misread a busy instance.** The request-path preflight ran
a TCP+AUTH+PING before handing out a cached provider, and gated the request on a single
miss. The background warmup probe used the same budget and, after two misses, pre-tripped
the instantiation breaker and blocked reads for 60s. A FalkorDB serializing a large reply or
forking for a snapshot answers a fresh PING late; in the 5s recovery lane two such misses
land within seconds.

**Backend — load shedding was too eager.** A request that found all 8 provider slots busy
was shed with 429 after 250ms — even though a slot frees in ~100ms. A single canvas open
fans out ~10 short queries, so the tail of a view's own burst was shed.

**Edge — the proxy won the race.** The ingress (120s) and the load balancer (120s) tied the
backend's slowest tier (versioning, 120s), so users saw an opaque "upstream timed out"
instead of the app's structured error. The backend closed keep-alive sockets after 2s while
nginx kept a warm pool for 60s, so nginx sometimes reused a closed socket: sporadic 502s.

**Frontend — every failure was an outage.** The canvas treated anything that was not the
literal warming signal as "unavailable": a 504, a 429 from the backend shedding the view's
own burst, a 502 during a deploy, a 401 from an access token that had just expired, a
client-side timeout on a slow link. Any three 5xx or timeouts also opened the *client*
circuit breaker (a module-level singleton), so later reads never left the browser. Only a
page reload rebuilt it — hence "refreshing fixes it". The schema pill said "Provider Offline"
for endpoints that read Postgres and never touch the graph. A failed schema refetch
unmounted a canvas whose ontology was fine. A retry wiped the canvas between attempts, and
a partially failed load rendered silently incomplete.

---

## 2. What changed

### Backend

| Change | Where | Knob (default) |
|---|---|---|
| A deadline miss is `ProviderTimeout`: HTTP 504, code `PROVIDER_TIMEOUT`, `Retry-After`. Never counted by the breaker. Subclasses both `ProviderUnavailable` (stale-fallback cache and worker retry budgets unchanged) and `TimeoutError` (existing `except asyncio.TimeoutError` still sees a timeout). | `backend/common/adapters/circuit.py` | — |
| Server error replies (`redis.ResponseError`) are not counted and not relabelled as an outage; they map to 500 with code `GRAPH_QUERY_ERROR` (or `REDIS_COMMAND_ERROR` off graph paths). `ReadOnlyError` (a demoted master) still counts. | `circuit.py`, `main.py` | — |
| Request-path preflight is skipped for a provider real traffic reached recently; a timeout-class miss must persist before it gates; budget raised. | `backend/app/providers/manager.py` | `PROVIDER_PREFLIGHT_SKIP_AFTER_OK_S` (10), `PROVIDER_PREFLIGHT_AMBIGUOUS_MISSES` (2), `PROVIDER_PREFLIGHT_DEADLINE_S` (2.5, was 1.5) |
| Warmup probe budget raised; timeout-class reasons pre-trip and gate only after 3 consecutive misses (refused/DNS still after 2). | `warmup.py`, `state.py`, `manager.py` | `PROVIDER_WARMUP_PROBE_DEADLINE_S` (3.0, was 1.5), `PROVIDER_WARMUP_PROBE_WALL_CLOCK_S` (4.0) |
| `/nodes/query` gets its own query budget; a deadline miss inside one URN or edge bucket surfaces instead of silently dropping those rows. | `falkordb_provider.py`, `config/resilience.py` | `FALKORDB_NODES_QUERY_TIMEOUT` (20, was the generic 5) |
| A request that finds every provider slot busy waits before being shed; the queue of waiters is capped so a burst cannot pin the GRAPH_READ DB pool. | `manager.py` | `PROVIDER_SEMAPHORE_BUDGET_S` (2.0, was 0.25), `PROVIDER_SLOT_MAX_WAITERS` (16) |
| The request-timeout middleware's 504 carries code `REQUEST_TIMEOUT` and `Retry-After`. | `main.py` | — |
| Resilience counters on `/api/v1/health/deps` (see [Verification](#5-verification)). | `main.py` | — |

### Frontend

| Change | Where |
|---|---|
| One classification of a failed graph request (`services/graphRequestFailure.ts`): only 503 `PROVIDER_UNAVAILABLE` or no backend at all is an outage; 504/429/502/500, client timeouts and 401/403 are transient. | request layer + canvas |
| The client circuit breaker counts only confirmed outages. Idempotent graph reads (every GET, the read-only POSTs) retry in place on 429/502/503/504 and timeouts, honouring `Retry-After`; writes are never replayed. | `providers/RemoteGraphProvider.ts` |
| A third canvas state, **slow** — "taking a little longer than usual", calm, auto-retrying. **unavailable** only on a confirmed outage. | `hooks/useGraphHydration.ts` |
| A canvas that has data keeps it: a retry of the same view never wipes the canvas, and a failed or partial load shows a small pill over the data instead of the blocking card. Partial loads record how many entities are missing and keep retrying. | `components/canvas/CanvasRouter.tsx`, `CanvasProviderStateOverlay.tsx`, `store/canvas.ts` |
| The initial load runs node batches four at a time. | `VITE_HYDRATION_CONCURRENCY` (4) |
| The view schema gate keeps the last good schema mounted when a refetch fails. The schema pill says "Schema unavailable", keeps the HTTP status, retries transient failures, hides for a session being renewed, and does not show for the global scope while a view is open. | `providers/ViewExecutionContext.tsx`, `hooks/useGraphSchema.ts`, `components/layout/CanvasLayout.tsx` |
| `/health/providers` "unknown" is no longer read as unhealthy; a 401 body is no longer reported as the graph's credentials being rejected. | `store/providerHealth.ts`, `services/providerService.ts` |

### Deployment

| Change | Where |
|---|---|
| Ingress `proxy-read-timeout` and GCLB `timeoutSec` 120 → 180, matching the pod nginx, so the app's structured 504 always wins the race. | `deploy/helm/dataviz/values.yaml`, `deploy/k8s/base/services/frontend/backendconfig.yaml` |
| Backend keep-alive 75s (`GUNICORN_KEEPALIVE`); nginx upstream `keepalive_timeout 30s`. The backend must outlive the proxy's idle window. | `backend/Dockerfile.viz`, `Dockerfile.viz-quickstart`, `docker-compose.dev.yml`, `frontend/nginx.conf` |
| Frontend `/readyz` is nginx-local. It used to proxy the backend's `/health` with a 3s timeout, so a backend stall failed readiness on every frontend pod at once and the load balancer pulled the whole site. | `frontend/nginx.conf` |
| `.env.example` documents the real graph tier (`HTTP_TIMEOUT_GRAPH_SECS=60`; it said 15, which would have killed `/edges/between` mid-flight for anyone who copied it). | `.env.example` |

---

## 3. Risk register

What could still go wrong, what bounds it, and what to watch.

| Risk | Bound | Watch |
|---|---|---|
| **Load amplification under saturation.** Retries add requests when the provider is already slow. | Per request: at most 2 in-place retries, backed off with jitter, honouring `Retry-After` (capped 5s). Per canvas: 5 fast retries (10s) then a 60s cadence. Server side: 8 slots per provider per process, a 16-deep queue, 429 beyond it — the provider never sees more than that. | `slots_shed_*` counters climbing while `breaker_opens` stays flat = healthy shedding. Sustained `deadline_timeouts_not_counted` growth = capacity, not availability. |
| **A genuinely hung FalkorDB is detected later than before** — a deadline miss no longer opens the breaker. | The preflight PING still gates a dead host: after two timeout-class misses (~6s) on a cold provider, or on the first refused/DNS failure. A provider that served traffic in the last 10s skips the PING, so a hang is caught by its next query's connection error (counted) plus the following request's PING — within one query budget + 10s. | `preflight_gated` and `network_failures_counted` should move together during a real outage. |
| **DB pool pressure from the longer slot wait.** A waiting request holds a GRAPH_READ session. | 16 waiters × 2s per provider per process; the GRAPH_READ pool is 10+10 per process and isolated from the WEB pool that serves auth and navigation. | `slots_shed_queue_full` > 0 means the cap is doing its job; `DB_UNAVAILABLE` 503s on graph paths mean it is set too high for the pool. |
| **Partial loads render an incomplete canvas.** | It is now visible (a pill with the missing count) and retried; it is never reported as complete. | The pill; `[useGraphHydration] … batch(es) failed after retries` in the browser console. |
| **Stale data served on failure.** The backend serves the last-known-good snapshot on a timeout or outage (`X-Cache-Status: stale-fallback`), and the canvas keeps its last data while retrying. | Stale snapshots live 24h (`GRAPH_CACHE_LKG_TTL_S`) and are purged on write. The stale banner and the pill both say so. | `X-Cache-Status: stale-fallback` on responses. |
| **Session rotation invalidates the CSRF token** every access-token lifetime, and read-only graph POSTs are CSRF-checked. | The fetch layer heals (`GET /auth/csrf`) and replays once; concurrent failures join one heal. A 403 is never an outage. | `[auth] CSRF token missing or stale` in the browser console should be rare and never sustained. |
| **Event-loop stalls** from serializing multi-MB responses still affect every request on that worker. Not changed by this release. | 4 workers, gzip level 1, the frontend no longer fails readiness because of it. | `event_loop_lag_p99_ms` on `/health/deps`. |
| **Idle SSE job streams** have no heartbeat and are cut at the edge timeout. Not changed. | The job page reconnects. | — |

---

## 4. Rollout

Backend and frontend are independently safe to deploy, in either order:

- New backend, old frontend: the old canvas reads a 504 `PROVIDER_TIMEOUT` as an outage —
  exactly what it did before with the 503 — so nothing regresses, and the breaker no longer
  opening already removes most of the false outages.
- New frontend, old backend: the new classification reads the old 503s correctly.

Order of preference:

1. **Backend image** (`backend/Dockerfile.viz` — includes the keep-alive change). Roll one
   replica first and read `/api/v1/health/deps` on it (section 5).
2. **Frontend image** (`frontend/Dockerfile` — includes the nginx `/readyz` and keep-alive
   changes). The readiness change means a frontend pod is Ready as soon as nginx is up.
3. **Ingress / load balancer** (`helm upgrade`, or re-apply the BackendConfig). Until this is
   applied, long versioning calls can still surface an edge 504 — everything else is fixed
   without it.

No database migration. No new required environment variables.

---

## 5. Verification

On a rolled backend replica, `GET /api/v1/health/deps` → `resilience`:

```json
{
  "breaker": {
    "deadline_timeouts_not_counted": 0,
    "query_errors_not_counted": 0,
    "network_failures_counted": 0,
    "breaker_opens": 0,
    "breaker_pretrips": 0
  },
  "provider_manager": {
    "preflight_skipped_recent_ok": 0,
    "preflight_slow_misses": 0,
    "preflight_gated": 0,
    "slots_shed_queue_full": 0,
    "slots_shed_wait_timeout": 0
  }
}
```

Counters are per process, monotonic since boot. The healthy shape after a day of traffic:

- `deadline_timeouts_not_counted` and `query_errors_not_counted` may be non-zero — they are
  the events that used to open the breaker and no longer do.
- `breaker_opens` and `breaker_pretrips` stay at 0 unless FalkorDB was actually unreachable.
- `preflight_skipped_recent_ok` dominates `preflight_slow_misses`; `preflight_gated` is 0.
- `slots_shed_*` non-zero only during bursts.

Log lines to grep for (backend):

| Line | Meaning |
|---|---|
| `deadline exceeded on … (breaker=closed, not counted)` | a slow query, correctly not an outage |
| `query rejected on … (breaker=closed, not counted)` | a bad or too-heavy query, correctly not an outage |
| `Provider timeout on /api/v1/…: … retry_after=2s` | the 504 the client will retry |
| `Circuit breaker '…' transition CLOSED -> OPEN` | a real connection failure — should coincide with a FalkorDB incident |
| `Pre-tripped instantiation breaker for … after 3 consecutive warmup-observed failures (reason=connect_timeout)` | three warmup misses in a row — a real outage or a badly overloaded instance |

In the browser: the canvas shows "Taking a little longer than usual" (calm, retrying) for a
slow view and "Graph service is unavailable" only when the backend confirmed it; a view that
already has data shows a pill at the top rather than a card over the data.

---

## 6. Rollback

Every backend behaviour change is an environment knob; set these to return to the previous
values without a rebuild:

```
PROVIDER_SEMAPHORE_BUDGET_S=0.25
PROVIDER_SLOT_MAX_WAITERS=1000000
PROVIDER_PREFLIGHT_DEADLINE_S=1.5
PROVIDER_PREFLIGHT_SKIP_AFTER_OK_S=0
PROVIDER_PREFLIGHT_AMBIGUOUS_MISSES=1
PROVIDER_WARMUP_PROBE_DEADLINE_S=1.5
PROVIDER_WARMUP_PROBE_WALL_CLOCK_S=2.0
FALKORDB_NODES_QUERY_TIMEOUT=5
```

The breaker's classification (deadline misses and error replies not counted) has no knob:
it is the fix, and reverting it means reverting the image. The frontend changes are
automatic; `VITE_HYDRATION_CONCURRENCY` tunes the batch pool at build time.

---

## 7. Known limitations

- A **persistently** slow view (every attempt over the 20s budget with no stale snapshot to
  serve) keeps its "taking longer" state and retries every 60s; the fix for that is the
  query itself (or a larger `FALKORDB_NODES_QUERY_TIMEOUT`), not this release.
- The counters on `/health/deps` are per process and reset on restart; there is no
  Prometheus exporter in this codebase, so a dashboard has to scrape the endpoint per
  replica.
- CSRF protection still applies to read-only graph POSTs; the heal-and-replay path makes it
  invisible, at the cost of one extra round trip after each session rotation.
