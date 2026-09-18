# Upgrading an existing deployment — graph availability

**Companion to [`RELEASE_NOTES_2026-09-09_graph-availability.md`](RELEASE_NOTES_2026-09-09_graph-availability.md).**
The release notes say what was broken and why the fix is shaped the way it is.
This says what an operator has to touch to actually get the fixed values, in the
order to touch them.

There is **no database migration** and **no newly required environment
variable**. Deploy the images and most of the fix is live.

The risk in this upgrade is not what you have to add. It is **what you already
set**. Almost every value this release changed is an environment knob, and an
explicit override in a ConfigMap, a Helm `values.yaml`, a `.env` or a build
argument beats the new default silently — no warning, no log line. A deployment
that pinned `FALKORDB_NODES_QUERY_TIMEOUT=5` (or copied the old `.env.example`,
which documented `HTTP_TIMEOUT_GRAPH_SECS=15`) will run the new image and keep
producing the exact "Graph service is unavailable" this release exists to
remove. §2 is the section to read if you read only one.

---

## 0. The short version

| # | Step | Needs | Skipping it means |
|---|------|-------|-------------------|
| 1 | Deploy the backend image | rolling restart | none of it is live |
| 2 | **Remove stale overrides** (§2) | ConfigMap / `.env` edit + restart | new image, pre-fix behaviour |
| 3 | Rebuild + deploy the frontend image | image build | client deadlines still tie the layer beneath them; `/readyz` still takes the whole site down with the backend |
| 4 | Re-apply manifests / `helm upgrade` (§4) | `kubectl apply` | opaque edge 504s on long calls; viz pods CFS-throttled at 2 cores |
| 5 | Restart FalkorDB with the new args (§5) | **brief downtime** | read concurrency stays at 4 threads |
| 6 | Correct `DB_GRAPH_READ_POOL_MAX_OVERFLOW` in your live ConfigMap (§6) | ConfigMap edit + restart | the pool is 2 larger than you think it is |

Steps 1–4 are independently safe and can be done in any order over days.
Step 5 is the only one with downtime. Step 6 is a name correction, not a
behaviour change you have to schedule.

---

## 1. What arrives on its own

These have no knob and need nothing but the new backend image:

- A query that misses its deadline, a rejected query, and FalkorDB's
  `Max pending queries exceeded` / `Query timed out` replies no longer count
  toward the circuit breaker. Only connection-class failures do.
- Those two capacity replies now surface as `429 PROVIDER_BUSY` and
  `504 PROVIDER_TIMEOUT` with `Retry-After`, retried in place by the canvas,
  instead of a 500.
- The per-source admission gate in front of the `GRAPH_READ` pool (§6).
- `provider.close()` is bounded, so a wedged connection can no longer freeze
  the warmup cycle and the cache-invalidation listener.
- Graph responses are serialized off the event loop once, not twice.
- Canvas and v2 graph endpoints take **one** DB session per request, from the
  isolated `GRAPH_READ` pool rather than the `WEB` pool that serves auth.

Frontend equivalents (arrive with the frontend image): a thrown application
error is reported as an error rather than as a provider outage, the
cache-envelope path can no longer open the breaker that paints the outage card,
and a view that already has data keeps it on screen while retrying.

---

## 2. Overrides to remove

Check every place your deployment sets environment variables — the ConfigMaps
under `deploy/k8s/base/configmaps/`, your Helm `values.yaml`, `.env`,
`.env.deploy`, and anything your CI injects. If a variable below is set to the
"stale value" column, **unset it** and let the code default apply.

### Backend

| Variable | Stale value | New default | If you leave it |
|---|---|---|---|
| `FALKORDB_NODES_QUERY_TIMEOUT` | `5` | `20` | canvas hydration times out on any large view, on every open |
| `HTTP_TIMEOUT_GRAPH_SECS` | `15` | `60` | the ASGI tier kills `/edges/between` (40s budget) mid-flight — a 504 the client cannot distinguish from an outage |
| `PROVIDER_SEMAPHORE_BUDGET_S` | `0.25` | `2.0` | a request that finds all 8 provider slots busy is shed after a quarter second instead of waiting out a normal burst |
| `PROVIDER_PREFLIGHT_DEADLINE_S` | `1.5` | `2.5` | a healthy-but-loaded provider fails its own reachability probe |
| `PROVIDER_PREFLIGHT_SKIP_AFTER_OK_S` | `0` | `10` | every graph request re-probes, adding a round trip to the hot path |
| `PROVIDER_PREFLIGHT_AMBIGUOUS_MISSES` | `1` | `2` | one slow probe gates the provider |
| `PROVIDER_WARMUP_PROBE_DEADLINE_S` | `1.5` | `3.0` | warmup marks a slow provider down at boot |
| `PROVIDER_WARMUP_PROBE_WALL_CLOCK_S` | `2.0` | `4.0` | same, on the wall-clock side |
| `PROVIDER_SLOT_MAX_WAITERS` | `1000000` | `16` | an unbounded queue of waiters, each holding a DB session |
| `GRAPH_CACHE_MAX_PAYLOAD_BYTES` | `1048576` | `4194304` | wide pages (a trace closure is ~2.5 MB) are exactly the ones not cached |

Every row except `HTTP_TIMEOUT_GRAPH_SECS` and `GRAPH_CACHE_MAX_PAYLOAD_BYTES`
is on the rollback list in release notes §6. If a past incident had you paste
that block in, this is where you take it out.

`GRAPH_CACHE_MAX_PAYLOAD_BYTES` is already `8388608` in every compose service —
that is above the new default and fine, leave it.

### Frontend (baked in at build time)

`frontend/Dockerfile` declares only `VITE_API_BASE_URL` as a build argument, so
these cannot reach the bundle through `--build-arg`. They reach it through a
`frontend/.env*` file in the build context or a `VITE_`-prefixed variable
exported in the build environment. If either sets one of these, **delete the
line** — every value below is now the shipped default:

| Variable | Old | New |
|---|---|---|
| `VITE_TIMEOUT_NODES_QUERY_MS` | *(unset — inherited the 30000 default)* | `45000` |
| `VITE_TIMEOUT_GET_CHILDREN_MS` | `30000` | `45000` |
| `VITE_TIMEOUT_AGGREGATED_EDGES_MS` | `45000` | `60000` |
| `VITE_TIMEOUT_EDGES_BETWEEN_MS` | `45000` | `60000` |
| `VITE_TIMEOUT_TRACE_MS` | `60000` | `75000` |

Each has to **outlast** the backend budget and the ASGI tier beneath it. A tie
is a coin flip over which layer explains the failure, and when the client wins
it throws away work the server was about to finish and retries it — doubling
load on the query that was already slow. `frontend/src/config/__tests__/timeouts.budgets.test.ts`
pins the ladder; `.env.example` documents the shipped values.

An out-of-range override is clamped rather than honoured, and both the clamp
and a non-numeric value log a `[timeouts]` warning in the browser console —
that warning is the fastest way to catch a stale build argument.

---

## 3. Images

### Backend (`backend/Dockerfile.viz`)

Carries `GUNICORN_KEEPALIVE=75` and the matching `--keep-alive` flag. This is
**baked into the image**, so a running deployment does not get it from a
ConfigMap edit — it needs the rebuilt image.

It must stay above the proxy's idle window (the pod nginx expires pooled
upstream connections at 30s). If your ingress or service mesh keeps idle
connections longer than 75s, raise `GUNICORN_KEEPALIVE` to match, or nginx will
reuse a socket the worker already closed and the request fails with
`upstream prematurely closed connection` — a sporadic 502 on a healthy stack,
and one nginx cannot retry for a POST.

### Frontend (`frontend/Dockerfile`)

Carries three things: the rebuilt bundle (§2), the nginx upstream
`keepalive_timeout 30s`, and the new `/readyz`.

`/readyz` is now answered by nginx itself. It used to proxy the backend's
`/health` with a 3s timeout, which meant every frontend pod shared one
failure: a backend stall failed readiness on all of them at once and the load
balancer pulled the entire site, taking the static shell that would have shown
the "backend unreachable" banner with it. The backend still reports its own
health through its own probes and `/api/v1/health/deps`.

**If you run your own reverse proxy in front of this** (not the bundled nginx),
apply the same two rules there: `proxy_read_timeout` at 180s, and an upstream
idle timeout below the backend's 75s keep-alive.

---

## 4. Manifests

| What | Where | How it applies |
|---|---|---|
| GCLB backend timeout 120 → 180s (frontend and viz-service) | `deploy/k8s/base/services/{frontend,viz-service}/backendconfig.yaml` | `kubectl apply` — GKE reconciles the backend service, no pod restart |
| nginx-ingress `proxy-read-timeout` 120 → 180 | `deploy/helm/dataviz/values.yaml` | `helm upgrade` |
| viz-service CPU **limit** 2 → 4 (production overlay) | `deploy/k8s/overlays/production/patches/resource-limits.yaml` | rolling restart |

The 180s figure exists so the app's own structured JSON 504 always wins the
race against the proxy's opaque one. It has to clear the slowest ASGI tier
(versioning, 120s) with margin. If you terminate TLS or route through anything
else — a mesh, Cloudflare, a corporate proxy — give it the same 180s, because
the shortest timeout in the chain is the one the user experiences.

**The viz CPU change is a limit, not a request.** Requests stay at `500m`, so
scheduling density and HPA behaviour are unchanged (the HPA targets CPU as a
percentage of *requests*: production runs viz-service at min 3 / max 12). What
changes is that four single-threaded async workers stop CFS-throttling each
other under exactly the concurrent load they exist to absorb — and a throttled
worker's event loop stalls every request on it, which reads downstream as
provider slowness. Nodes need the headroom for the burst; the 8:1 limit-to-
request ratio is deliberate.

---

## 5. FalkorDB restart

**This is the step with downtime.** `THREAD_COUNT` and the other launch args
are read at process start and are not hot-reloadable, and the bundled
StatefulSet is single-replica.

| Setting | Was | Now |
|---|---|---|
| `THREAD_COUNT` | 4 | **8** |
| `MAX_QUEUED_QUERIES` | 64 | 64 (unchanged — see below) |
| `limits.cpu` | 4 | **8** |
| `limits.memory` | 10Gi | **14Gi** |
| `requests` | 1 CPU / 2Gi | unchanged |

In `deploy/k8s/base/infrastructure/falkordb/statefulset.yaml` and
`deploy/helm/dataviz/values.yaml` (`stores.falkordb.args` / `resources`).

Three things to check before you restart:

1. **Node capacity.** Requests are unchanged, so scheduling is unchanged and
   the pod will still be placed — but a node with fewer than 8 allocatable
   cores cannot deliver 8 query threads no matter what the args say. Verify the
   node pool before assuming the change took effect.
2. **Memory.** 14Gi is not padding: `maxmemory × 1.25 + THREAD_COUNT concurrent
   queries × QUERY_MEM_CAPACITY × 1.3 + 256Mi overhead` ≈ 13.1Gi at 6gb / 8 /
   512Mi. Raising `THREAD_COUNT` without raising the memory limit trades a
   caught query error for an OOM-killed pod, under exactly the load the change
   was made to serve.
3. **`FALKORDB_SERVER_TIMEOUT_MAX_MS` must equal the deployed `TIMEOUT_MAX`**
   (180000 in both). The backend clamps every per-query timeout it sends to
   this value because the server *rejects* queries asking for more. It lives in
   `deploy/k8s/base/configmaps/common-config.yaml` and
   `config.falkordb.serverTimeoutMaxMs` in Helm.

**The queue depth deliberately did not move.** Wait time is roughly
`(depth ÷ threads) × service_time`, so doubling the threads already halved it.
Doubling the depth as well would have taken the worst case for a 2s query from
32s to 64s — past every deadline above it — converting cheap immediate 429s
(which the canvas retries in place) into slow expensive 504s. A shallow queue
that sheds fast is the point.

**On a managed FalkorDB instance**, `THREAD_COUNT` is set by the provider's
instance size rather than by these manifests. Size for vCPU count and confirm
`TIMEOUT_MAX` matches `FALKORDB_SERVER_TIMEOUT_MAX_MS`; the rest of this
section does not apply.

`deploy/k8s/overlays/production-cluster/` (the sharded cluster layout) carries
its own `THREAD_COUNT 6 / MAX_QUEUED_QUERIES 150 / TIMEOUT_MAX 120000` args and
is deliberately untouched by this release. If you run that overlay, set
`FALKORDB_SERVER_TIMEOUT_MAX_MS=120000` to match its `TIMEOUT_MAX`.

---

## 6. `DB_GRAPH_READ_POOL_MAX_OVERFLOW` in your live ConfigMap

`deploy/k8s/base/configmaps/viz-config.yaml` set `DB_GRAPH_READ_MAX_OVERFLOW`,
which is not a name the code reads — the variable is
`DB_GRAPH_READ_POOL_MAX_OVERFLOW`. The overflow therefore stayed at the code
default of 10, so the pool has been running at 8+10 = 18 rather than the 16 the
manifest intended. This release corrects the key.

It matters more than it did, because the new admission gate sizes itself from
that pool. Every graph request holds a `GRAPH_READ` session across its outbound
FalkorDB call, so `pool_size + max_overflow` **is** the ceiling on concurrent
graph reads per worker — and it is shared by every data source. The gate
reserves each source a share it is never refused, so one slow source cannot
occupy the pool its healthy neighbours read through:

| `GRAPH_READ` pool | capacity | hard ceiling | per-source reserve |
|---|---|---|---|
| 10 + 10 (code default) | 20 | 16 | 2 |
| 8 + 10 (what the ConfigMap actually ran) | 18 | 14 | 2 |
| **8 + 8 (what it now says, and means)** | **16** | **12** | **2** |
| 6 + 4 (`INFRASTRUCTURE_LAUNCH_SCALE.md` recipe) | 10 | 6 | 1 |

If your deployment carries the old key, rename it. The effective ceiling drops
by 2 per worker, which is immaterial at the concurrency 300 browsing users
actually produce (reads are cache-dominated; the pool is per worker and you run
four per pod) — and it makes the manifest mean what it says. `GRAPH_INFLIGHT_HARD_MAX`
and `PROVIDER_SOURCE_RESERVED` override the derivation directly if you would
rather not resize the pool.

If you followed the at-scale recipe in `INFRASTRUCTURE_LAUNCH_SCALE.md`
(`DB_GRAPH_READ_POOL_SIZE=6`, overflow 4), your ceiling is 6 per worker and the
reserve is 1. That is deliberate there — the guidance is to scale connections
by adding pods, not by growing pools — and 6 per worker is 24 per pod, well
above what a view open costs (the canvas fans out 4 batches). It does mean a
burst sheds sooner, which is the intended behaviour: a fast 429 the canvas
retries in place beats a slow request queued behind a full pool.

Two things the gate does **not** do, so you size for them yourself: it is
per-process, so it does not compose across pods (the fleet-wide bound is
FalkorDB's own queue), and the reserve is sized from sources seen in the last
`GRAPH_SOURCE_RECENT_SECS`, so a single-source install still uses the whole
ceiling.

`backend/tests/test_deploy_pool_env_names.py` now fails on any pool-sizing key
in `deploy/` or the compose files that the engine does not read, so this
particular silence cannot come back.

---

## 7. New knobs — all optional

Every one has a working default. Set them only to override:

| Variable | Default | When you would |
|---|---|---|
| `GRAPH_INFLIGHT_HARD_MAX` | derived (`pool − 4`) | you want the ceiling decoupled from pool size |
| `PROVIDER_SOURCE_RESERVED` | derived (`pool ÷ 8`) | one source must be guaranteed more |
| `GRAPH_SOURCE_RECENT_SECS` | `60` | sources with long idle gaps between bursts |
| `PROVIDER_CLOSE_TIMEOUT_S` | `2.0` | a provider whose close legitimately takes longer |
| `PROVIDER_SLOT_MAX_WAITERS` | `16` | tuning queue depth against pool size |
| `AGGREGATION_READ_PRESSURE_PACING_RATIO` | `4.0` | how hard aggregation writers yield while reads starve (≈20% write duty cycle) |
| `AGGREGATION_READ_PRESSURE_TTL_S` | `30` | how long one pressure signal keeps writers yielding |
| `AGGREGATION_READ_PRESSURE_POLL_SECS` | `2` | how often a writer re-reads the signal |

The read-pressure trio is the readers-first path: when the web tier sees
FalkorDB starving an interactive read, aggregation writers on that endpoint
pace themselves down until it clears. It fails open — if Redis is unreachable,
writers run at their normal pace. See `docs/AGGREGATION_PIPELINE.md`.

---

## 8. Outside these manifests

- **Managed Postgres and Redis.** The production overlay replaces the
  in-cluster StatefulSets with Cloud SQL and Memorystore, so their sizing is
  yours. Pool sizes were deliberately **not** raised in this release: peak is
  ~85 connections per process × `GUNICORN_WORKERS` (4) × replicas, which a
  single `max_connections` cannot cover across an HPA'd fleet. Front Postgres
  with a transaction pooler (PgBouncer, or Cloud SQL Managed Connection
  Pooling with `DB_POOLER_MODE=transaction`) before raising anything here.
- **Redis is not optional for this release.** The response cache, the
  last-known-good fallback and the read-pressure signal all live in it. They
  all fail open, so an unavailable Redis degrades to "every read hits
  FalkorDB" rather than an outage — which is precisely the load profile this
  release is built to avoid.
- **Your own CDN, WAF or mesh**, per §4: the shortest timeout in the chain wins.

---

## 9. Verifying the upgrade landed

`GET /api/v1/health/deps` → `resilience`, per process, monotonic since boot:

```
breaker.deadline_timeouts_not_counted   may climb — these used to open the breaker
breaker.queue_full_not_counted          FalkorDB queue-full replies, now 429s
breaker.breaker_opens                   0 unless FalkorDB was genuinely unreachable
provider_manager.graph_shed_process_full   0 in steady state
provider_manager.graph_shed_over_share     >0 only when one source is monopolising
provider_manager.graph_inflight_peak       stays below the §6 ceiling
provider_manager.provider_close_timeouts   0
read_pressure.signals_sent                 moves with queue_full_not_counted
```

The shape that says it worked: `deadline_timeouts_not_counted` non-zero while
`breaker_opens` stays flat. That is a slow query being read as a capacity
signal instead of an outage — the entire bug, inverted.

Spot checks:

- `GUNICORN_KEEPALIVE`: `kubectl exec <viz-pod> -- printenv GUNICORN_KEEPALIVE` → `75`.
- FalkorDB threads: `redis-cli GRAPH.CONFIG GET THREAD_COUNT` → `8`.
- Client deadlines: open a view with devtools; the `/graph/nodes/query` request
  should abort at 45s, not 30s. A `[timeouts]` console warning means a stale
  build-time override is still in the bundle.
- In the browser: a slow view shows "Taking a little longer than usual" and
  keeps whatever data it has; "Graph service is unavailable" appears only when
  the backend actually said so.

---

## 10. Backing out

Backend behaviour reverts through the environment — set the "stale value"
column of §2 and restart; no rebuild needed. The breaker's classification is
the exception: it has no knob, because it is the fix.

The FalkorDB args revert by restoring `THREAD_COUNT 4` and the 4 CPU / 10Gi
limits and restarting the pod (downtime again). The frontend reverts by
deploying the previous image. The 180s proxy timeouts are safe to leave at 180
whatever else you roll back — they only ever move which layer answers first.
