# Telling us an external data source changed

**Audience:** teams that load data straight into a graph this product reads —
ETL jobs, connectors, migration scripts, anything that writes to FalkorDB
outside the app.

**Short answer: you do not have to tell us anything.** Since the drift probe
shipped, we detect external changes ourselves within about a minute. Push
notification is an accelerator, not a requirement, and correctness never depends
on you calling us.

Read this alongside [Automatic Aggregation Reconciliation](aggregation-reconciliation.md),
which describes what happens after a change is noticed.

---

## Why a notification is needed at all

When an external system loads data, it adds, updates and deletes nodes and edges
— and routinely wipes the `:AGGREGATED` overlay that this product materialises
to answer rollup and lineage queries. Until that overlay is rebuilt, the product
serves **wrong rollups**. The gap between "your load finished" and "our overlay
was rebuilt" is the window we are closing.

## What happens with no integration at all

```
your load lands
      │
      ▼
① Detect   probe reads counts        ≤ 60s   (probeIntervalSecs, 15s tick)
      │    counts digest moves
      ▼
② Check    sweep evaluates           ≤ 60s   (sweep tick)
      │    detector fires
      ▼
③ Act      rebuild queued
```

**Typical end-to-end: under two minutes.** Previously this was bounded by the
statistics service's 900-second poll plus the sweeper's 3600-second per-source
window — a worst case around **75 minutes**.

Two things make this cheap enough to run at that cadence:

- The probe reads **counters, not data**. `count()` over an unfiltered pattern
  reduces to a constant-time matrix read in FalkorDB, so the whole per-label /
  per-type count set costs ~1.3 ms instead of ~514 ms of scanning — measured at
  500k nodes / 850k edges. It does not get slower as your graph grows.
- A moved counts digest makes a source **due immediately**, bypassing its normal
  check interval. An unchanged digest costs nothing — no verdict, no evidence,
  no write.

So for most integrations the correct action is: **do nothing, and let the probe
find it.** Push a signal only if you need the window tighter than a couple of
minutes, or you want the rebuild to start the instant your job finishes.

## If you do want to push a signal

### The endpoint

```http
POST /api/v1/admin/data-sources/{dataSourceId}/refresh
Content-Type: application/json

{ "scope": "auto" }
```

All body fields are optional; an empty body gets the defaults.

| Field | Values | Default | Meaning |
|---|---|---|---|
| `scope` | `auto`, `read-caches`, `rollups`, `full`, `clear` | `auto` | `auto` runs the change gate and rebuilds only if something actually moved. This is the one you want. |
| `force` | boolean | `false` | Overrides the change gate. **Only affects `auto`.** See the warning below. |
| `reason` | string | — | Free text, recorded in the audit trail. |
| `wait` | `none`, `complete` | `none` | `complete` blocks (bounded) on the queued rebuild so you can refresh-then-read synchronously. |

Response:

```json
{
  "scope": "auto",
  "gate": "changed",
  "changed": true,
  "actions": ["marker_set", "content_cleared", "stats_nudged", "rebuild_queued"],
  "jobId": "agg_1a2b3c4d5e6f",
  "deferred": false,
  "eventId": "evt_...."
}
```

`gate` is `forced` / `changed` / `unchanged` for `auto`. **`changed: false` is a
success, not a failure** — it means we checked and your load did not actually
alter the graph shape, so no rebuild was warranted. Treat a `2xx` as "signal
accepted", never as "rebuild started"; use `jobId` for that.

`actions` is the ordered list of what actually ran, drawn from a fixed
vocabulary: `marker_set`, `marker_cleared`, `content_cleared`,
`hierarchy_invalidated`, `aggregated_lkg_purged`, `stats_nudged`, `invalidated`,
`rebuild_queued`, `rebuild_deferred`, `rebuild_conflict`, `rebuild_error`. Log
it — when a signal does less than you expected, this says which step declined.

`POST /api/v1/admin/data-sources/{ds}/source-changed` with `{"reason", "force"}`
is the older equivalent of `scope=auto`. It still works and connectors already
wired to it need not migrate, but new integrations should use `refresh`.

### Authentication, and the constraint that will bite you

The route requires a user JWT holding `workspace:datasource:manage` on the
workspace that owns the data source.

> **⚠️ A token alone is not enough today.** CSRF protection is applied to every
> non-safe method app-wide, with only auth routes exempt. It requires the
> `nx_csrf` cookie *and* a matching `X-CSRF-Token` header. A machine client
> presenting only `Authorization: Bearer …` and no cookies is rejected with
> **403 `csrf_failed`** before the route ever runs.

In practice this means **there is no polished machine-to-machine credential
yet.** Your options today:

1. **Rely on self-detection** (recommended) — no credential, no integration, ~2
   minutes.
2. **Behave like a browser session** — authenticate, keep the `nx_csrf` cookie,
   and echo it in `X-CSRF-Token` on every call. Workable, but you are using a
   human's credential for a machine.
3. **Call the control plane directly, from inside the cluster.** The aggregation
   control plane is a separate service that applies no CSRF middleware and
   authenticates every route with a shared bearer token
   (`AGGREGATION_INTERNAL_TOKEN`):

   ```http
   POST http://aggregation-controlplane:8091/aggregation/data-sources/{ds}/refresh
   Authorization: Bearer $AGGREGATION_INTERNAL_TOKEN
   { "scope": "auto", "origin": "connector" }
   ```

   (`AGGREGATION_SERVICE_URL` is the same address the viz-service proxies to.)

   Caveats you must accept before using it: the control plane is **not intended
   to be internet-exposed**; the token is a **single global secret** with no
   per-tenant scoping and no allowlist of which sources a caller may touch; and
   it **fails open when the variable is unset**, so an unconfigured deployment
   authenticates nobody. Use it only from inside the trust boundary.

Set `origin` to `connector` when calling the control plane so the audit trail
attributes the signal correctly (the loader script uses `script`; the UI proxy
forces `api`).

### Do not use `force`

`force: true` skips the change gate, so every call queues a rebuild whether or
not anything changed. On a large graph a rebuild is minutes of work. A retry
loop with `force: true` is the fastest way to turn a healthy fleet into a
rebuild queue, and nothing currently rate-limits it for you.

Leave it `false` and let the gate decide. If the gate says `unchanged`, that is
the system correctly declining to do expensive work — not a bug to route around.

### Batching and retries

There is no endpoint that takes an arbitrary *list* of source ids — the per-source
route is one call per source. Two coarser batch verbs do exist, both of which run
as a background job on the control plane and always proxy:

| Endpoint | Gate | Scope |
|---|---|---|
| `POST /api/v1/admin/providers/{providerId}/refresh` | `system:admin` | every live data source on that provider |
| `POST /api/v1/admin/freshness/refresh-all` | `system:admin` | every live data source |

Both return `202` with a `BatchStatus` you poll, and both are guarded — they are
operator tools for a bulk reload, not something a connector should call per job.
If you have just loaded 200 graphs, prefer either one provider-scoped batch call
or plain self-detection over fanning out 200 individual signals.

Retries are safe: the change gate, a rebuild cooldown, an idempotency replay
window, a partial unique index, an advisory lock and a graph-level conflict
check all sit between your call and a duplicate job. Repeated identical signals
collapse; they do not stack up rebuilds.

## Not built — do not integrate against these

The design for this feature specified a dedicated machine ingress that **was
never implemented**. It is described in the plan and may look real in design
documents. It does not exist:

- `POST /api/v1/ingest/source-changed` and its `:batch` twin
- Per-tenant API keys (`sk_…`, an `ingest_api_keys` table, scoping, revocation)
- `changeToken` de-duplication for exact-once client retries
- Per-principal rate limiting and global / per-workspace rebuild budgets
- Refusing `force` for machine principals
- A CSRF exemption for a bearer-authenticated ingest path

Until those ship, the honest posture is: self-detection is the supported
integration, and the paths above are what exists.

## Checking that it worked

Every accepted signal writes a `refresh_events` audit row carrying its origin
and actor, and the resulting job carries a trigger you can filter on.

- **In the UI** — Ingestion → Freshness. Find your source; the drawer's activity
  trail shows the signal, the finding and the rebuild it started.
- **By API** — `GET /api/v1/admin/data-sources/{ds}/freshness` returns the
  source's last-checked, last-reconciled, drift state and current finding.
- **End to end** — load a graph externally, then watch the source's drift state
  move from `inSync` to a finding and back, with a `jobId` attached. Doing this
  with **no** signal at all is the better test: it proves self-detection meets
  the same window, which is what you are actually relying on.

## Things that will surprise you

- **A rebuild that produces zero rollup edges is a correct outcome**, not a
  failure. A graph with no containment edges legitimately materialises an empty
  overlay, and the detectors are explicitly guarded so this does not re-fire
  forever.
- **A source an operator has snoozed still reports its findings.** The snooze
  refuses the rebuild, not the detection, so the cockpit keeps showing what is
  wrong with it.
- **A source whose rebuilds repeatedly fail stops being retried** once it trips
  the breaker (3 consecutive actions), and is surfaced as "Needs a person"
  rather than being retried forever.
- **Version-controlled sources ignore all of this.** For them Postgres is the
  source of truth and the graph is a rebuildable read cache, so the overlay is
  maintained incrementally on commit. They report as `managed` and the sweep
  never acts on them. Signalling one has no effect.
