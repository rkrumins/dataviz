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

---

## 8. Addendum, same day — scale, background jobs, and the second offline path

The first two rounds fixed a slow query being read as a dead provider. Reviewing the
release for hundreds of concurrent users, and for users sharing the graph with aggregation
jobs, found four more things worth fixing before shipping, plus one remaining path to the
"Graph service is unavailable" card in the new frontend.

### What was still wrong

- **FalkorDB's own capacity replies were 500s.** The server answers "Max pending queries
  exceeded" (its `MAX_QUEUED_QUERIES` cap, the shape of a cold-cache stampede or of jobs
  and users sharing the instance) and "Query timed out" (its kill of one query at the
  `TIMEOUT` the provider sent) as ordinary error replies. Round one stopped counting them
  toward the breaker, but they surfaced as 500 `GRAPH_QUERY_ERROR`, which no client
  retries: the canvas showed "taking longer" and waited for its paced retry.
- **The cache-envelope fetch path could still open the canvas's breaker.** Data-source
  stats, the wizard's entity step and the ontology helpers fetch through
  `services/cacheEnvelope.ts`, which counted *any* 5xx toward the `(workspace, data
  source, default)` breaker it shares with `/nodes/query`. Under a slow backend, three
  504s there opened it, and the view's next node query fast-failed in the browser as
  "circuit open", which classifies as **unavailable**. This is the one way the new
  frontend could still show the outage card over a graph that was merely slow.
- **Writers had no feedback from readers.** Aggregation jobs pace themselves on their own
  write latency, hold a fleet-wide write lease per graph and keep two write slots per
  endpoint. A job issuing small, fast MERGE batches while the canvas's reads queued behind
  them looked healthy from the writer's side, so nothing yielded.
- **An error thrown by code read as a provider state.** A `TypeError` raised while a view
  loaded (the reported `Cannot read properties of undefined (reading 'startTime')` is one)
  classified as transient: "taking a little longer than usual", retrying, over a bug. In
  the previous frontend it classified as an outage.
- **The client gave up on children before the server could answer.** `/children-with-edges`
  runs the children page and then their edges, each on the backend's 15s budget; the
  client aborted at 30s, so the backend's structured 504 never surfaced and the retry
  doubled the load.
- **The load harness never exercised the view open**, and its URN discovery sent a body
  the endpoint rejects with 422, so every graph scenario ran against an empty pool.

### What changed

| Change | Where | Knob (default) |
|---|---|---|
| "Max pending queries exceeded" → `ProviderBusy`: HTTP 429, code `PROVIDER_BUSY`, `Retry-After: 1`. "Query timed out" → `ProviderTimeout`: HTTP 504, `PROVIDER_TIMEOUT`. Neither counts; `ProviderBusy` is now a logical exception so a nested proxy never counts a busy signal either. | `backend/common/adapters/circuit.py` | — |
| Readers first. The breaker proxy publishes a capacity signal (queue full, server-side timeout, client deadline) to a listener; the web tier stamps `agg:readpressure:{endpoint}` on the job-bus Redis; the materializer's pacing loop paces every write batch on that endpoint at the read-pressure ratio while the key lives. Fails open both ways. | `circuit.py`, `backend/app/services/aggregation/read_pressure.py`, `admission.py`, `backend/app/providers/falkordb_materialize.py`, `main.py` | `AGGREGATION_READ_PRESSURE_PACING_RATIO` (4.0 → ≤ ~20% write duty cycle), `AGGREGATION_READ_PRESSURE_TTL_S` (30), `AGGREGATION_READ_PRESSURE_POLL_SECS` (2) |
| The cache-envelope path counts only a confirmed outage (503 `PROVIDER_UNAVAILABLE`) or a request that never reached the backend — the same reading as the graph read path. | `frontend/src/services/cacheEnvelope.ts` | — |
| A fourth canvas state, **error**: an engine error thrown during the load is named as such ("Something went wrong while loading"), logged with its stack, retried at the calm cadence, never an outage, never counted. | `services/graphRequestFailure.ts`, `hooks/useGraphHydration.ts`, `components/canvas/CanvasProviderStateOverlay.tsx` | — |
| Children client budget 30s → 45s, above the server's 30s worst case and under the 60s graph tier. | `frontend/src/config/timeouts.ts` | `VITE_TIMEOUT_GET_CHILDREN_MS` (45000) |
| GCLB `timeoutSec` for the API backend 120 → 180, the same margin the frontend backend got. | `deploy/k8s/base/services/viz-service/backendconfig.yaml` | — |
| Middleware tier tests for the workspace-scoped graph routes: `/edges/aggregated` and `/edges/between` resolve to the 45s aggregation tier, node and children reads to the 60s graph tier, and every provider budget sits under its tier. | `backend/tests/test_timeout_middleware.py` | — |
| A canvas view-open scenario (100-URN node batches, four in flight, then one edge scan), smoke and stress targets, tiered SLOs, and the discovery body fix. | `loadtest/` | `SYNODIC_URNS_PER_WORKSPACE` sizes the view |

### Verification

`GET /api/v1/health/deps` → `resilience` gains `breaker.queue_full_not_counted` and a
`read_pressure` block (`signals_sent`, `signals_coalesced`, `signal_errors`). The healthy
shape: `queue_full_not_counted` non-zero only during bursts, `signals_sent` moving with it,
`signal_errors` at 0, `breaker_opens` still flat.

| Line | Meaning |
|---|---|
| `query queue full on … (breaker=closed, not counted; shed as busy)` | FalkorDB at its queue cap; the client retries in place |
| `server-side deadline exceeded on … (breaker=closed, not counted)` | the server killed one query at its budget — a slow query, not an outage |
| `read pressure on <host:port> (<kind>): aggregation writers yield for the next 30s` | the web tier told the writers to back off |
| `aggregation on <graph> yielding to interactive reads (<kind>): write pacing ratio 4` / `read pressure cleared` | a worker doing so, and stopping |

Load: `make smoke-canvas-open` against a seeded stack, then `make stress-canvas` (or
`make sweep`) at 100 / 300 / 500 users with `SYNODIC_URNS_PER_WORKSPACE=500`. A 429 counts
as a failure in the harness on purpose — it is the capacity signal. Read the counters above
after each tier; `breaker_opens` must not move.

In the browser, an engine error during a load now reads "Something went wrong while
loading" with the error in the console at error level, not "taking longer" and not
"unavailable".

### Rollback

```
AGGREGATION_READ_PRESSURE_PACING_RATIO=1.0   # equal to the base ratio → no yield
VITE_TIMEOUT_GET_CHILDREN_MS=30000           # build-time
```

The reply relabelling, the cache-envelope breaker policy and the error state have no knob:
they are the fix.

### Known limitations

- The `startTime` `TypeError` is not raised by application code, by the layout engine on
  the view page, or by anything on the request path; the readers of that property in the
  bundle are react-dom's resource-timing loop (safe on its own), framer-motion's grouped
  animation controls, and mermaid's Gantt renderer. It is a symptom of the failed load
  (elements torn down mid-animation), not its cause, and this release makes it impossible
  for such an error to read as an outage. Pinning the thrower needs the browser's expanded
  stack for that console entry.
- The read-pressure signal is advisory: writers already mid-batch finish that batch, and a
  job needs one write batch to notice (a few seconds). It slows jobs; it does not pause
  them.
- Capacity itself is unchanged: one FalkorDB with 4 query threads and a 64-deep queue.
  `MAX_QUEUED_QUERIES` decides whether a burst waits (deeper queue, later 504s) or is shed
  (shallower queue, more 429s retried in place). Responses over 1 MiB are not cached
  (`GRAPH_CACHE_MAX_PAYLOAD_BYTES`), so the largest views recompute on every open. The
  per-workspace fair-share limiter is off by default and does not yet cover the view-open
  endpoints.

---

## 9. Addendum, round four — one bad data source, and the shape of hundreds of users

Two questions drove this round: can the stack serve hundreds of concurrent users, and
can one or two unhealthy data sources out of five take the application down. The second
had a concrete answer, and it was yes.

### The mechanism: one shared pool, held across the provider call

Every graph request checks out a `GRAPH_READ` database session in `get_context_engine`
**before** the data source is resolved, and holds it across the whole outbound FalkorDB
call. That pool is per process (10 + 10 by default) and **shared by every data source**.

A data source that is merely slow is deliberately never gated — that was the fix for the
false "graph is offline" in round one — so its requests keep arriving, and each one pins
a session for up to its 20s query budget. Five sources configured and one slow: it fills
all 20 sessions on a worker. Requests for the four healthy sources then wait
`DB_POOL_TIMEOUT_SECS` (10s) for a session that never frees and fail with a generic
"Database is temporarily unavailable" 503. One unhealthy source took the graph down for
all of them, and the per-provider slot cap could not prevent it: it is applied inside 16
of the 55 graph routes, always *after* the session is already held.

**Admission now runs at the door.** A dependency declared before the session (FastAPI
resolves sub-dependencies in declaration order, so a shed request never takes one) keeps
a per-source count and applies three rules:

| Rule | Effect |
|---|---|
| over `GRAPH_INFLIGHT_HARD_MAX` | shed — the invariant that keeps a checkout from ever waiting on the 10s pool timeout |
| under `PROVIDER_SOURCE_RESERVED` | admit, whatever else is in flight — this is the guarantee |
| otherwise | admit while there is still room for every other source's reserve |

"Every other source" means every source this process has served within
`GRAPH_SOURCE_RECENT_SECS` (60), not just the ones with a request in flight. That
distinction is the point: the reported case is a source that has been slow for a while
before anyone opens a view on another one, so the neighbour arrives cold and must still
find room. Sizing the reserve from what the deployment actually uses also means a
single-source install holds nothing back and uses the entire ceiling — a fixed
mid-ceiling would have throttled it to protect neighbours that do not exist. Defaults
derive from the pool (10+10 → ceiling 16, reserve 2) rather than being hard-coded, so
resizing the pool moves the gate with it. A shed request is `ProviderBusy` (429 +
`Retry-After`), which the canvas retries in place.

Concretely, at the shipped defaults: one source alone reaches all 16 concurrent graph
requests per worker; with five sources known, a saturated one is held at 8 and the other
four each get their full reserve.

### The other ways one provider reached the others

- **A wedged `close()` froze the fleet's control plane.** `_close_and_forget` awaited
  `provider.close()` with no ceiling, and it runs on two process-wide *serial* paths:
  the warmup cycle's idle reap and the cross-process invalidation listener. Against a
  blackholed host, the warmup cycle stopped — so every provider's verdict went stale and
  the health endpoint reported the loop degraded — and no other provider's invalidation
  was applied. Now bounded by `PROVIDER_CLOSE_TIMEOUT_S` (2s), like the probe path
  already was.
- **Cache writes serialized whole payloads on the event loop, twice.** The primary entry
  and the last-known-good mirror each called `model_dump_json` inline, so every cache
  fill blocked the worker for every other data source in proportion to the largest
  response any one of them returned. Now serialized once, on a thread.
- **The v2 graph dependency took a `WEB`-pool session** — the pool that serves auth and
  navigation. That router is not mounted, so it was harmless; it now takes the same two
  gates as v1 so enabling it cannot reintroduce the bug in its worst form.
- **The frontend asserted zeros when a bulk read failed.** One request covers every
  workspace, so one unhealthy source could fail it for all of them, and the workspaces
  page and admin overview then rendered "0 entities" across a fleet whose other four
  sources were fine. A failed refresh is now "we don't know" — the last known counts stay,
  behind the page's existing degraded banner.
- **Every unscoped envelope fetch shared one circuit breaker.** Three failures on a bulk
  endpoint fast-failed unrelated endpoints for 15s, returning `null`, which callers
  cannot tell apart from "no data". Unscoped calls are now keyed by endpoint path.

The health surface itself was already clean: no health or status endpoint does
per-provider I/O, so a hung provider cannot make its neighbours read "unknown".

### Capacity

| Knob | Was | Now | Why |
|---|---|---|---|
| FalkorDB `THREAD_COUNT` | 4 | 8 | The query threads are the read tier's real concurrency limit; a handful of heavy reads occupied all four while everyone else queued |
| FalkorDB CPU limit | 4 | 8 | `THREAD_COUNT` must track it, or the threads throttle |
| FalkorDB memory limit | 10Gi | 14Gi | Sized for the new concurrency: `maxmemory×1.25 + THREAD_COUNT × QUERY_MEM_CAPACITY×1.3 + 256Mi`. Raising threads without this would OOM-kill the pod under exactly the load it was raised for |
| `MAX_QUEUED_QUERIES` | 64 | 256 | A burst now queues instead of being rejected; the rejection is a retried 429 either way since round three |
| `GRAPH_CACHE_MAX_PAYLOAD_BYTES` | 1 MiB | 4 MiB | At 1 MiB the biggest views — the ones whose queries cost most — were never cached, so every concurrent open recomputed the same multi-second scan |

Pool sizes are deliberately unchanged: the per-process ceiling is already
85 connections against a Postgres configured for 400, and raising it needs a connection
pooler first, not a bigger number.

### Verification

`/api/v1/health/deps` → `resilience.provider_manager` gains `graph_shed_over_share`,
`graph_shed_process_full`, `graph_inflight_peak` and `provider_close_timeouts`. The
healthy shape under load: `graph_inflight_peak` below the hard ceiling,
`graph_shed_over_share` non-zero only for a source that is actually slow, and
`graph_shed_process_full` at zero. A rising `graph_shed_over_share` on one source while
the others keep serving is the fix working, not a regression.

### Known limitations

- The reserved share is per process, so a source's fleet-wide floor is
  `reserved × workers × pods`, not a single number.
- A source unused for longer than the recency window stops holding capacity, and a
  process serving more sources than `ceiling ÷ reserve` cannot give them all a share —
  at the defaults that is eight sources per worker.
- Admission is keyed on the workspace and data source in the URL, so several workspaces
  sharing one physical source are counted together. That errs safe: it can shed earlier
  than necessary, never later.
- The bulk stats endpoints still fail as one unit, so a cold start with an unhealthy
  source shows unknown counts rather than partial ones. Making the backend return
  per-source partial results is the real fix and is not in this change.
- Two endpoints outside the graph router (`/freshness`, aggregation readiness) take a
  graph-read session without passing the gate. That is what the four-connection gap
  between the hard ceiling and the pool is reserved for; they are short Postgres reads,
  so the gap holds, but the accounting is a reservation rather than a guarantee.
- Two data sources pointing at the same host and port share one read-pressure signal.
- Capacity is still one FalkorDB instance. Eight query threads is roughly double the
  concurrent read throughput, not an order of magnitude; past that the answer is read
  replicas.
