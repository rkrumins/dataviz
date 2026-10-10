# Observability

*For platform operators.*

How to tell whether {brand} is healthy, and what to do about it when it isn't: the health
endpoints and which probe uses which, the metrics the services export and how to scrape them,
the logs, the health pages inside the product, and a starter set of alerts. Read the
reference tables when you wire up monitoring; follow
[Turn on metrics](#turn-on-metrics) to switch the scrape endpoints on.

## Where to look first

| Question | Look at |
|---|---|
| Is the process running at all? | `/health/live` (or its alias `/health`) |
| Should this API instance get traffic — database reachable, schema current? | `/health/ready` |
| Why does it say it's degraded? | `/health/deps` |
| Is the platform trending toward trouble — shedding load, holding rebuilds? | The metrics endpoints |
| What happened to one request? | The logs, by `X-Request-ID` |
| Which part of the platform is unhappy, right now, in one place? | **Administration → Infrastructure** |

## Health endpoints

The API (`viz-service`) answers each of these on two paths: the short one, and the same path
under `/api/v1` — for example `/health/ready` and `/api/v1/health/ready`. Through the web
tier only the `/api/v1/…` form reaches the API, because the web tier answers `/health`
itself.

| Endpoint | Answers | What it checks | Cost |
|---|---|---|---|
| `/health/live` | Is the process alive? | Nothing — `{"status":"live","version":"0.2.0"}` whenever the event loop runs | Constant time, no I/O |
| `/health` | The same (an alias of `/health/live`) | Nothing | Constant time, no I/O |
| `/health/ready` | Should this instance get traffic? | One `SELECT 1` on Postgres; the schema is at the release's migration head; with `ENV=production`, that session revocation uses the shared Redis store. `200` with `"status":"ready"`, or `503` with `"status":"not_ready"` and a reason. Graph-store health is reported but never fails readiness | One small database query |
| `/health/deps` | What is degraded, and why? — for people, not probes | A Postgres ping (capped at 1 second); the revocation store; each graph provider's circuit breaker; event-loop lag (`degraded` from a 50 ms p99, `critical` from 500 ms); the warm-up loop's heartbeat; the resilience counters. The graph-store topology summary only for a caller presenting the metrics token | One capped database query; the rest from memory |
| `/api/v1/health/providers` | Is each data source's graph provider reachable? | Breaker and warm-up state from memory, mapped to data sources by one cached query; serves the last known answer, with `stalenessSecs`, if the database is slow | One cached query |

Things to know when you wire probes to these:

- `/health/deps` always answers `200`. Read its `status` field — `healthy`, `degraded` or
  `unhealthy` — and its `reason`.
- Every health path is cut off after `HTTP_TIMEOUT_HEALTH_SECS` (default 5 seconds).
- The health paths are exempt from the `ALLOWED_HOSTS` check, so probes that address a pod by
  its IP work.
- The app's own banners poll `/api/v1/health` (the **Service Unavailable** banner) and
  `/api/v1/health/providers` (every 30 seconds while a tab is visible).

The other processes have health endpoints of their own:

| Process | Endpoint | Returns |
|---|---|---|
| Aggregation control plane | `:8091/health` | `status`, `role` (`aggregation-controlplane`) and the drift-probe scheduler's last tick |
| Aggregation worker | `:8090/health` (any path) | `status`, `role`, `uptime`, `activeJobs`, `consumer` |
| Stats service | `:8092/health` (any path) | `status`, `role` (`insights-service`), its schedulers and lanes |
| Web tier (nginx) | `/health` and `/readyz` | Answered by nginx itself — never by the API — so a slow API can't take the site's static pages down |
| Versioning worker | none | — |

## Which probe uses which

| Service | Docker Compose | Kustomize (`deploy/k8s`) | Helm (`deploy/helm/dataviz`) |
|---|---|---|---|
| `viz-service` | `/api/v1/health` | Startup and liveness `/health`; readiness `/api/v1/health/ready` | Startup, liveness and readiness `/api/v1/health`; init containers wait for the control plane and the schema |
| `aggregation-controlplane` | `:8091/health` | `:8091/health` (all three) | `:8091/health` (all three); waits for the schema |
| `aggregation-worker` | `:8090/health` (the image's check) | `:8090/health` (all three) | `:8090/health` (startup, liveness) |
| `stats-service` | `:8092/health` | `:8092/health` (all three) | `:8092/health` (all three) |
| `versioning-worker` | none (restart on exit) | none | not deployed |
| `frontend` | `/health` (the image's check) | Startup and liveness `/health`; readiness `/readyz`; load balancer `/health` | Liveness and readiness `/health` |
| FalkorDB | `redis-cli ping` answers `PONG` or `LOADING` | Readiness: `PONG` only; liveness: `PONG` or `LOADING` | The same, when `stores.falkordb.enabled` |

> **Note:** the Helm chart uses the liveness alias for readiness too, so an API pod stays in
> rotation while Postgres is unreachable or the schema is behind. Watch `/api/v1/health/ready`
> from your monitoring.

`LOADING` counts as alive on purpose: a graph store replaying a large append-only file is
working, and restarting it would start the replay over.

## Turn on metrics

The scrape endpoints are off by default, and they stay off — answering `404` — unless both
`METRICS_ENABLED` and `METRICS_TOKEN` are set. The scraper presents the token as a bearer
token; a wrong or missing token gets `401`.

| Process | Scrape at | Notes |
|---|---|---|
| `viz-service` | `:8000/api/v1/metrics` | Also reachable through the web tier at `https://<host>/api/v1/metrics` |
| `aggregation-controlplane` | `:8091/metrics` | |
| `aggregation-worker` | `:9100/metrics` | Its own small server, started only when metrics are on; port `METRICS_PORT` |
| `stats-service`, `versioning-worker` | — | No scrape endpoint |

1. Generate a token: `openssl rand -hex 32`.
2. Give `METRICS_ENABLED=true` and `METRICS_TOKEN` to the three processes above.
   - **Docker Compose** — set both in `.env` and add the lines from the
     [hardening checklist](/docs/deployment#production-hardening-checklist) to
     `docker-compose.yml`, then `./deploy.sh up`.
   - **Helm** — add both keys to your Secret (every backend pod reads all of its keys), then
     `kubectl -n <namespace> rollout restart deployment`.
   - **Kustomize** — add `METRICS_ENABLED: "true"` to `common-config` in your overlay's
     [production-settings patch](/docs/kubernetes#turn-on-the-production-settings), create a
     Secret for the token, and hand it to the three Deployments with a patch in your overlay's
     `patches:` like the one below. Repeat its document for `aggregation-controlplane` and
     `aggregation-worker`, changing both names. Then deploy the overlay and run
     `kubectl -n synodic rollout restart deployment`.

     ```bash
     kubectl -n synodic create secret generic metrics-token --from-literal=token="$(openssl rand -hex 32)"
     ```

     ```yaml
     apiVersion: apps/v1
     kind: Deployment
     metadata:
       name: viz-service
       namespace: synodic
     spec:
       template:
         spec:
           containers:
             - name: viz-service
               env:
                 - name: METRICS_TOKEN
                   valueFrom:
                     secretKeyRef:
                       name: metrics-token
                       key: token
     ```

3. Let your Prometheus reach the ports. The kustomize manifests deny all ingress by default;
   on a cluster that enforces NetworkPolicy, add a rule such as:

   ```yaml
   apiVersion: networking.k8s.io/v1
   kind: NetworkPolicy
   metadata:
     name: allow-prometheus-scrape
     namespace: synodic
   spec:
     podSelector:
       matchExpressions:
         - key: app.kubernetes.io/name
           operator: In
           values: [viz-service, aggregation-controlplane, aggregation-worker]
     policyTypes:
       - Ingress
     ingress:
       - from:
           - namespaceSelector:
               matchLabels:
                 kubernetes.io/metadata.name: <prometheus-namespace>
         ports:
           - protocol: TCP
             port: 8000
           - protocol: TCP
             port: 8091
           - protocol: TCP
             port: 9100
   ```

4. Verify:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<host>/api/v1/metrics
   curl -s -H "Authorization: Bearer <token>" https://<host>/api/v1/metrics | grep metrics_process_up
   ```

   The first prints `401`; the second prints `metrics_process_up{role="web"} 1`.

> **If you set `ALLOWED_HOSTS`:** the API's metrics path is subject to it — only the health
> paths are exempt — so scrape the API by a host name on that list, not by pod IP. In
> Compose, add `viz-service` to `ALLOWED_HOSTS` and scrape `viz-service:8000`. The control
> plane and the worker have no host check.

### A Prometheus scrape configuration

For Docker Compose, with Prometheus attached to the stack's network (`synodic_default`) and
the token in a file:

```yaml
scrape_configs:
  - job_name: web
    metrics_path: /api/v1/metrics
    authorization:
      credentials_file: /etc/prometheus/metrics-token
    static_configs:
      - targets: ["viz-service:8000"]
  - job_name: controlplane
    authorization:
      credentials_file: /etc/prometheus/metrics-token
    static_configs:
      - targets: ["aggregation-controlplane:8091"]
  - job_name: aggregation-worker
    authorization:
      credentials_file: /etc/prometheus/metrics-token
    dns_sd_configs:
      - names: ["aggregation-worker"]
        type: A
        port: 9100
```

The DNS lookup finds every worker replica when you scale with
`docker compose up --scale aggregation-worker=<n>`. On Kubernetes, scrape each control-plane
and worker pod by its address (the worker's port 9100 isn't declared on the pod, so set it in
your scrape configuration), and the API as described in the note above.

### Read the numbers per process

Every process keeps its own counters, and they reset when it restarts — sum across targets in
your queries. The API runs several worker processes behind one port (`GUNICORN_WORKERS`,
default 4), and a scrape is answered by whichever one takes it, so treat the API's series as
samples for dashboards. The control plane and each aggregation worker are single processes, so
their series are complete: alert on those.

## What the metrics tell you

| Metric | Type | From | Read it as |
|---|---|---|---|
| `metrics_process_up{role}` | gauge | every process that serves metrics | `1` while the target answers; `role` is `web`, `controlplane` or `worker`. No series means the scrape target is wrong |
| `provider_breaker_events{event}` | gauge, rises from boot | every process that serves metrics | Circuit-breaker decisions: `breaker_opens`, `breaker_pretrips`, `network_failures_counted`, and the slow or busy replies deliberately not counted (`deadline_timeouts_not_counted`, `queue_full_not_counted`, `pool_exhaustion_not_counted`, `query_errors_not_counted`). Under load the healthy shape is the `*_not_counted` events rising while `breaker_opens` stays flat |
| `provider_manager_events{event}` | gauge, rises from boot | every process that serves metrics | Admission and preflight decisions: `graph_shed_process_full`, `graph_shed_over_share`, `slots_shed_queue_full`, `slots_shed_wait_timeout`, `fleet_slots_shed`, `fleet_slots_fail_open`, the `preflight_*` events, `graph_inflight_peak`, `provider_close_timeouts` |
| `graph_cache_reads_total{endpoint,outcome}` | counter | API | Graph cache outcomes: `hit`, `miss`, `stale` (served last-known data), `bypass`, `too_large` |
| `aggregation_read_pressure_signals_total{outcome}` | counter | API | The API telling rebuilds that interactive reads are starving: `signals_sent`, `signals_coalesced`, `signals_unkeyed`, `signal_errors` |
| `aggregation_slot_waits_total{kind,node}` | counter | worker | A rebuild waited for a write or scan slot on a graph-store node, then got one |
| `aggregation_slot_fail_open_total{kind,node,reason}` | counter | worker | A rebuild went ahead without a slot: `reason="deadline"` means the per-node cap isn't capping; `reason="bus_error"` means the job-bus Redis is unreachable |
| `aggregation_governor_holds_total{kind,node}`, `aggregation_governor_hold_seconds_count` / `_sum{kind}` | counter | worker | How often, and for how long, a rebuild paused because the node was outside its safe envelope (forks, replica lag or loss, memory) |
| `aggregation_governor_eases_total{reason,node}` | counter | worker | A rebuild halved its batch because the node was struggling |
| `aggregation_read_pressure_yields_total{reason,node}` | counter | worker | Rebuild writers backing off because interactive reads are starving |
| `aggregation_write_budget_refusals_total{node}` | counter | worker | A rebuild refused before writing because the node had no room |
| `cooperative_cancels_observed_total{kind}` | counter | worker | Running jobs that honoured a cancel |
| `stuck_jobs_redispatched_total{kind,outcome}` | counter | control plane | Recovery of stalled jobs: `auto_resumed`, `marked_failed`, `pending_abandoned`, `auto_resume_exhausted` |
| `aggregation_job_history_pruned_total{outcome}` | counter | control plane | The job-history retention sweep: `swept`, `capped`, `failed` |
| `job_events_emitted_total{kind,type}`, `job_events_emit_errors_total{kind,type,stage}` | counter | processes that run jobs | Job progress events, and failures to record or publish them |
| `graph_store_command_calls{endpoint,role,command}`, `graph_store_command_usec_per_call{…}` | gauge | the process that swept the graph-store topology | Per node and command, since the node started — use `rate()` of the calls with the per-call time beside it |
| `metrics_series_dropped_total{metric}` | counter | any | A metric reached its cap of 500 label sets and dropped series |

How to act on the rebuild signals is in
[Concurrency and Timeout Tuning](/docs/concurrency-tuning#what-to-watch-and-the-one-number-that-means-stop).

## Logs

| Process | Format |
|---|---|
| `viz-service` (API) | One JSON object per line — `asctime`, `levelname`, `name`, `message` and the record's own fields — whenever `SYNODIC_ROLE` names a role other than `dev`, as every shipped deployment does |
| Control plane, aggregation worker, stats service, versioning worker | Plain text: time, level, logger name, message |

**Follow one request.** Every API response carries `X-Request-ID` — the value the caller sent,
or a generated `req_` followed by 16 hex characters — and `X-Process-Time`. Each request also
writes an access record (logger `synodic.access`, message `request`) with `requestId`,
`connectionId`, `method`, `path`, `status` and `durationMs`. Search the API's logs for the ID.

**Level.** `LOG_LEVEL` — `DEBUG`, `INFO`, `WARNING` or `ERROR`. Compose defaults to `INFO`;
the kustomize base sets `INFO`, the `dev` overlay `DEBUG` and `production` `WARNING`; the Helm
chart uses `config.logLevel` (`INFO`). Under `DEBUG` the Redis client's own loggers stay at
`INFO`.

**Read them.** `./deploy.sh logs <service>` on Compose;
`kubectl -n <namespace> logs deploy/<service>` or `make -C deploy/k8s logs-<service>` on
Kubernetes.

Startup lines worth knowing, from the API:

| Line starts with | Tells you |
|---|---|
| `Auth fingerprint:` | How this instance identifies sessions — environment id, issuer, cookie names, key fingerprints; a warning follows when `AUTH_ENVIRONMENT_ID` is unset |
| `Session config:` | Access-token lifetime, refresh lifetime and session ceilings in force |
| `Schema verified at Alembic head` / `ALEMBIC HEAD MISMATCH` | Whether the database matches this release |
| `Bootstrap failed — starting in degraded mode` | The API started without its database; `/health/deps` shows the reason |
| `In-process versioning projection is OFF` | Projection runs in the versioning worker — make sure that worker is running |

## Health pages in the product

People with the `system:admin` permission see these under **Administration**; the
Freshness page is under **Ingestion**.

| Page | Shows | Guide |
|---|---|---|
| **Administration → Global Overview** | System health, graph scale and cross-workspace analytics: Total Nodes, Total Edges, Data Sources, Entity Types | [The Admin Console](/guide/governance-ops) |
| **Administration → Infrastructure** | A tile per service and store — Viz Service, Postgres · Management, Postgres · GraphVer, Redis · Bus, Redis · Cache, FalkorDB, Aggregation Controlplane, Aggregation Worker, Stats Service — plus streams, projection lag, graph providers, aggregation success rate, stuck jobs, overdue data sources and overlay integrity | [The Admin Console](/guide/governance-ops) |
| **Administration → Redis & Graph Store** | Streams, cache and default graph endpoints — authentication, TLS and where each setting came from | [The Admin Console](/guide/governance-ops) |
| **Administration → Graph store** | Shards, replicas, memory, and where every graph lives | [The Graph Store](/guide/graph-store-topology) |
| **Ingestion → Freshness** | Overlay integrity and each source's freshness, with rebuild actions per source | [Data Freshness & Ingestion](/guide/data-freshness) |

[screenshot-pending]: # "observability-infrastructure — Administration → Infrastructure with the service tiles and the workload tiles (aggregation success rate, stuck jobs, overdue data sources, overlay integrity) visible"

> **Note:** the Infrastructure page also shows a **Graph Service** tile that always reads
> down. It is left over from a retired service; ignore it.

## What to alert on

A starter set, built from what the platform exports. Tune the windows to your traffic.

| Alert | Signal | Fires when | Why |
|---|---|---|---|
| API not ready | Probe `GET /api/v1/health/ready` | Not `200` for 3 minutes | Postgres unreachable, schema behind, or revocation store missing — users get errors |
| Site down | Probe `GET https://<host>/health` | Not `200` for 2 minutes | The web tier or the edge is down |
| Event loop wedged | Poll `/api/v1/health/deps` | `dependencies.event_loop` starts with `critical` | One slow request is freezing every request on that process |
| Target missing | Prometheus `up` | `0` for 5 minutes on the control plane or a worker | You're blind to the signals below |
| Rebuilds over-admitted | `sum(increase(aggregation_slot_fail_open_total{reason="deadline"}[15m]))` | Above 0 | The per-node cap has stopped capping — the state just before an incident |
| Job bus unreachable | `sum(increase(aggregation_slot_fail_open_total{reason="bus_error"}[15m]))` | Above 0 | Redis is down for the workers; fix Redis |
| Jobs failing recovery | `sum(increase(stuck_jobs_redispatched_total{outcome=~"marked_failed\|auto_resume_exhausted"}[1h]))` | Above 0 | Stalled jobs that recovery gave up on |
| Shard out of room | `sum by (node) (increase(aggregation_write_budget_refusals_total[1h]))` | Above 0, repeatedly | Rebuilds refused for lack of memory — grow that shard |
| Readers starving | `sum(rate(aggregation_read_pressure_yields_total[10m]))` | Above 0 for 30 minutes | Rebuilds keep yielding to interactive reads — capacity or tuning |
| Job events failing | `sum(increase(job_events_emit_errors_total[15m]))` | Above 0 | Job progress isn't being recorded |
| Unbounded label | `metrics_series_dropped_total` | Above 0 | A metric is losing series — tell engineering |
| Restarts | Container restart count | Any, sustained | Crash loops hide behind healthy averages |

Postgres, Redis and the graph store's own memory aren't exported by the platform; use your
platform's monitoring or exporters for them. The thresholds in
[Launch Scale §9](/docs/infra-launch-scale#9-observability--alerting) are a good start.

## Where in the code

| What | Where |
|---|---|
| API health endpoints | `backend/app/main.py` — `liveness_check`, `health_alias`, `readiness_check`, `dependency_health`, `provider_health_check` |
| Host check and its health exemption | `backend/app/main.py` — `_TrustedHostMiddleware` |
| Scrape endpoint and its token check | `backend/app/api/v1/endpoints/metrics.py` — `scrape`, `metrics_authorized` |
| Metrics registry | `backend/app/jobs/metrics_prometheus.py` — `PrometheusBackend`, `install` |
| Worker health and scrape servers | `backend/app/common/health_server.py`; `backend/app/services/aggregation/__main__.py` — `_serve_metrics` |
| Log format and request IDs | `backend/app/middleware/logging.py` — `configure_json_logging`, `StructuredLoggingMiddleware`; `backend/app/middleware/request_id.py` |
| Infrastructure page data | `backend/app/services/system_status/` |

## See also

- [Runbooks](/docs/runbooks) — what to do once an alert fires.
- [Concurrency and Timeout Tuning](/docs/concurrency-tuning) — when the graph is slow or timing out.
- [Self-Host Deployment](/docs/deployment) — the Compose stack these endpoints run in.
- [Deploying on Kubernetes](/docs/kubernetes) — probes, NetworkPolicies and production settings on a cluster.
