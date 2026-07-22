# Release Notes — Data Freshness & the OPS Freshness Cockpit

**Branch:** `claude/falkordb-redis-connectivity-va6czv`
**Coverage window:** 17 July 2026 → 20 July 2026
**Prepared:** 21 July 2026
**Size:** 53 commits · 75 files · +14,587 / −87 lines (merged up to date with `main`, conflict-free)

---

## Overview

This branch fixes a class of bug that had been quietly eroding trust in the canvas: **data loaded
into the graph store outside the application never reached the screen.** A user could confirm the
new data was in FalkorDB and still see an old, thinner picture — with no signal that anything was
wrong.

The work then goes beyond the fix, because "it's stale" is only half the problem — operators had
no way to *see* freshness or *do* anything about it. So the branch also delivers an operational
cockpit: per-source freshness and cache visibility, one-click refresh at source / provider / fleet
scope, an audit trail of every refresh, configurable rebuild cadence, and — when a rebuild does
fail — an honest explanation with a resolution path.

Five streams of work:

1. **Convergence loop** — an external data load now propagates to every canvas read path, with
   honest "recomputing" signalling while it happens. The bundled seed/import loaders announce
   themselves automatically, so a direct load converges without anyone remembering a manual step.
2. **OPS Freshness Cockpit** — a new *Ingestion → Freshness* tab plus the API behind it: fleet and
   per-source freshness, a unified refresh verb, guarded provider/fleet batches, and an audit trail.
3. **Cache visibility & fleet refresh** — per-provider cache-coverage rollups, per-source cache
   contents, and a one-click "Refresh all sources".
4. **Failure resilience** — failed rebuilds stop churning, stop lying in the UI, and now come with
   category-specific guidance and a safe "Clear cache" escape hatch.
5. **Cache correctness** — response-cache entries are scoped to the *physical* graph (collision- and
   re-point-proof) and now honour the configured `REDIS_CACHE_*` instance.

The notes are written twice: **Part 1** for a business/stakeholder audience, **Part 2** for
engineers. Appendices carry the API surface, configuration, verification evidence, and known limits.

---

# Part 1 · Business / Executive Release Notes

### 1. Data you load now actually shows up

Previously, if data was loaded into the graph store by a script or an external connector — outside
the product's own APIs — the canvas could keep showing the *old* picture for up to fifteen minutes,
and the aggregated lineage view could stay stale **indefinitely**. Worse, the product reported that
view as fresh, so nobody knew to look twice.

Now a single "this source changed" signal makes every part of the canvas converge on the real data:
the hierarchy updates immediately, and the lineage rollups rebuild in the background. **The bundled
seed and import scripts now emit that signal themselves at the end of a load**, so the common case
needs no manual step; external connectors call the same endpoint, and a scheduled check acts as a
safety net for sources configured for it. The signal is best-effort by design — if the application
stack isn't running (common during container initialisation), the load still succeeds and simply
logs a warning.

### 2. Nobody stares at a blank or lying canvas while it catches up

Rebuilding lineage on a large model takes time. Rather than emptying the canvas or pretending the
old data is current, the product now keeps serving the previous view **clearly labelled as being
recomputed**, and swaps in the new one the moment it's ready — the canvas notices completion on its
own and refreshes, with no manual reload and no lingering banner. Everyone sees the same thing,
across every server instance.

### 3. Operators can finally see — and fix — freshness

A new **Freshness** tab under *Data Ingestion* gives a fleet-wide cockpit:

- **At-a-glance health** — how many sources are ready, rebuilding, never built, or need attention,
  plus cache coverage across the fleet. The summary tiles double as filters.
- **Triage-first ordering** — problems float to the top; healthy provider groups collapse out of
  the way.
- **Per-source detail** — when lineage was last built, when its cache was last refreshed, what's
  currently cached, and a full history of who or what refreshed it.
- **Action** — refresh a single source, every source under a provider, or the entire fleet, with
  clear guardrails and progress.

### 4. Failures explain themselves and offer a way out

When a lineage rebuild fails, the product used to show a spinning "Recomputing" badge **forever** —
implying progress that would never come. Now a failed source says **"Rebuild failed"**, and the
detail panel explains in plain language *what* happened, *why* (for example: the graph store ran out
of memory building lineage for a very large source), and *how to resolve it* — with a safe
**Clear cache** action and a **Retry** that honestly warns when it's likely to fail again.

Behind the scenes, a failing rebuild is no longer retried every minute; it backs off to once per
configured window, so a struggling graph store isn't hammered while someone investigates.

### 5. Refresh cadence is now a setting, not a deployment change

How often a source may automatically rebuild used to be fixed in environment configuration. It's now
editable in the product — a global default plus an optional per-source override — and the "next
rebuild" countdown shown in the UI is guaranteed to match the behaviour the server actually enforces.

### 6. Very large models render consistently

Models above the display cap show their most significant connections rather than everything. That
selection is now **deterministic**: the same source, unchanged, shows the same set every time it is
opened. Previously the cut-off could land differently between openings, so the picture could shift
without the data changing — which read as flakiness rather than as a deliberate cap.

### 7. Cache correctness across multiple graph stores

Two different graph databases can legitimately host graphs with the *same name*. The product now
guarantees those can never share cached results, and that re-pointing a data source at a different
graph automatically invalidates its cache. The cache also now uses the dedicated cache instance
configured for the deployment, keeping it separate from operational coordination data.

---

# Part 2 · Engineering Release Notes

## 2.1 Root cause

Four compounding defects, all confirmed by investigation before any code changed:

| # | Defect | Effect |
|---|---|---|
| 1 | Nothing rebuilt the `:AGGREGATED` overlay after an external load (read-path auto-heal was removed in `110cd431` for storm reasons; the drift scheduler was notify-only) | Lineage stale indefinitely, and reported `stale=false` because staleness detection was structural only |
| 2 | The response-cache generation counter was never bumped by external writes | All canvas endpoints masked the change up to TTL (aggregated 15 min; last-known-good 1 day) |
| 3 | `payload_too_large` skipped the cache write but never deleted the existing smaller entry | Once a model outgrew the 1 MiB cap, the stale entry could **never** be replaced |
| 4 | A timed-out aggregated batch silently returned `[]`; truncated results cached at full TTL | Incomplete data served and cached as if complete |

## 2.2 The convergence loop

```
signal (script | connector API | UI | drift sweep | reconciler)
  → fingerprint change gate (no-op syncs cost nothing; --force overrides)
  → set stale marker + clear provider content caches
  → bump cache generation + purge non-aggregated LKG      ← hierarchy converges immediately
  → nudge stats / top-level materialisation
  → queue idempotency-keyed, cooldown-throttled rebuild
  … meanwhile: hierarchy fresh; aggregated served from the previous rollup, flagged stale …
job.completed → second generation bump + aggregated-LKG purge + marker cleared
  → cache warmer re-warms → `lastMaterializedAt` flips → frontend refetches
```

**Invariants (do not break):**

- **Reads never trigger materialisation** — everything is signal/schedule/event-driven (the
  `110cd431` constraint stands).
- **Staleness is overlaid post-cache** — baking `stale` into a cached payload would give it the
  negative TTL and destroy stale-while-revalidate.
- **Aggregated LKG survives the signal** and is purged only at `job.completed`; hierarchy LKG is
  purged at signal time. One scope-wide generation covers all endpoints.
- **Coordination state never lives on an evicting cache** (see §2.6).
- **Not-applicable sources are never marked stale** — otherwise an unclearable marker drives a
  60-second reconcile loop that re-arms its own TTL.

## 2.3 Convergence on load, and determinism

Three additions close the gap between "the machinery is correct" and "the symptom is gone":

- **Loaders announce themselves.** Eight bundled seed/import scripts call `emit_after_load_async`
  at end-of-load. It is deliberately best-effort: a no-op when the control plane is unreachable
  (routine at container init), an escape hatch via `DATAVIZ_SKIP_LOAD_SIGNAL`, and any failure logs
  a warning instead of failing the load. Without this, convergence depended on someone remembering
  the manual step — which is exactly how the original symptom was reproduced.
- **The canvas notices completion.** `useSourceChangedRefresh` polls the **cheap readiness
  endpoint** (never the expensive aggregated query, which would hammer the graph store mid-rebuild
  on a large model) and invalidates the aggregated cache exactly once on the not-ready → ready
  transition. Without it the stale-while-revalidate cache would keep re-serving the previous rollup,
  and the "recomputing" banner would linger until the 5-minute client TTL.
- **The reconciler always runs.** It is no longer gated by `AGGREGATION_DRIFT_AUTO_REBUILD`: a
  stale marker means a rebuild was *already requested*, so deferred and failed rebuilds are retried
  even when drift auto-rebuild is switched off. The marked-source check in the drift path became
  unconditional at the same time, so a source that is both marked and drifting is not dropped.
- **Truncation is deterministic.** The materialized `:AGGREGATED` read now orders by
  `weight DESC, s.urn, t.urn` instead of weight alone. Weight is a count, so ties are pervasive and
  the `LIMIT` cut lands mid-tie-group; combined with delete-on-oversize (a payload above the cap is
  never cached, so every open re-runs the query) an over-cap model could return a *different* subset
  on each canvas open. The cap still truncates and still says so — it is now stable.

## 2.4 Components changed

| Area | Change |
|---|---|
| `graph_cache.py` | Delete-on-oversize; negative TTL + no LKG for truncated/degraded results (incl. nested `aggregated`/`aggregated_delta`); stale-source marker helpers; `invalidate_hierarchy_reads` with an aggregated-LKG carve-out; `genat` cache-as-of stamp; per-source cache-key counts; physical-graph namespacing; CACHE/coordination client split |
| `falkordb_provider.py` | Failed aggregated batches now flag `stale/degraded/truncated` instead of silently shrinking; `clear_content_caches()` bulk invalidation; `physical_graph_id()` |
| `aggregation/service.py` | `signal_source_changed` (gate → mark → clear → invalidate → nudge → throttled trigger, never raises after invalidation); unified `refresh_source` verb (`auto`/`read-caches`/`rollups`/`full`/`clear`); cadence resolution chain; failure classification; fleet & per-provider freshness assembly |
| `aggregation/scheduler.py` | Drift sweep now *acts*; stale-marker reconciler (≤50/tick, dedup, skips in-flight / in-cooldown / recently-failed) |
| `aggregation/event_listener.py` | Clears the stale marker on `job.completed` only (failures keep it, by design); emits completion audit events with inherited origin |
| `endpoints/freshness.py` (new) | Fleet + per-source freshness, unified refresh, provider/fleet batches, freshness settings — all proxy-aware with control-plane twins |
| `endpoints/graph.py`, `canvas.py` | Post-cache staleness overlay so even cached hits are flagged |
| Frontend | Stale-source banner + unplaceable-edge count on the canvas; the entire *Freshness* cockpit tab (stat band, faceted URL-synced filters, triage sort, drawer, dialogs); honest badge; resolution guidance |

## 2.5 Audit trail

New `refresh_events` table records **every** refresh — route, script, connector, drift, reconciler —
plus job completion/failure, with `origin`, `actor`, `scope`, `gate`, `outcome` and an `actions`
payload. `actor` and `origin` are forced server-side on both the direct and proxy paths, so neither
can be spoofed by a client. Completion events inherit the origin of the accepted event that queued
them, so a rebuild is attributable end-to-end.

## 2.6 Failure resilience

- **Backoff** — the reconciler skips a source whose latest rebuild failed within its cadence window
  (fail-open: a lookup error degrades to the pre-existing behaviour rather than freezing a source).
  Retry frequency drops from every 60 s to once per window.
- **Honest state** — `freshnessState()` resolves `failed` → `running` → `queued` → `stale` →
  `neverBuilt` → `upToDate`; **failed wins over the marker**, which is precisely the stuck-forever
  "Recomputing" bug.
- **Guidance** — `classify_failure()` maps the error to one of six categories (`out_of_memory`,
  `provider_unavailable`, `ontology`, `timeout`, `conflict`, `unknown`; OOM is matched *before*
  provider-unavailable because OOM errors arrive wrapped in connection language). The drawer renders
  category-specific what/why/how plus CTAs.
- **Escape hatch** — the `clear` scope performs the full invalidation *and* clears the stale marker,
  with no rebuild, so it is safe to run against an out-of-memory store.

## 2.7 Cache correctness

- **Physical-graph namespacing** — `CacheScope.graph_ns = sha1(host:port:graph_name)[:16]`, appended
  to response/LKG keys **only when non-empty**, so existing keys stay byte-identical (no mass
  invalidation on deploy) and the endpoint segment index is unchanged. Two physical graphs can never
  share an entry; re-pointing a data source lands in a fresh namespace. Generation, cache-as-of and
  marker keys stay `(workspace, data-source)`-scoped so invalidation still covers every variant.
- **`REDIS_CACHE_*` routing** — response payloads and LKG snapshots use the `CACHE` role resolved via
  `resolve_redis_config(RedisRole.CACHE)` (global `REDIS_CACHE_*` / legacy `CACHE_REDIS_URL`),
  falling back to the shared client when unconfigured. **Coordination keys (generation, cache-as-of,
  markers) always stay on the durable shared client** — this repository has already learned once that
  control state on a lossy cache corrupts silently.

## 2.8 Housekeeping

- Merged `origin/main` (168 commits) into the branch; two canvas conflicts resolved by deferring
  unresolved-edge surfacing to main's newer per-node indicators while keeping this branch's
  stale-source banner. An alembic merge revision rejoins the two heads.
- Fixed a **main-inherited** 38-character migration id
  (`20260719_1200_rebrand_default_branding` → `20260719_1200_rebrand_branding`), which violated the
  repository's ≤32-character revision contract and made a *fresh* environment unbuildable.

---

# Appendix A · API surface

| Method & path | Purpose |
|---|---|
| `POST /api/v1/admin/data-sources/{id}/refresh` | Unified verb — `{scope: auto\|read-caches\|rollups\|full\|clear, force, wait}` |
| `POST /api/v1/admin/data-sources/{id}/source-changed` | Stable alias for `scope=auto` (connectors) |
| `GET /api/v1/admin/freshness` | Fleet rows + `summary` + `providerSummaries` (DB + Redis only; no graph calls) |
| `GET /api/v1/admin/data-sources/{id}/freshness?probe=` | Per-source detail; `probe=true` adds a bounded live fingerprint/count check |
| `PATCH /api/v1/admin/data-sources/{id}/freshness-settings` | Per-source rebuild-cadence override |
| `POST /api/v1/admin/providers/{id}/refresh-batch` | Guarded per-provider batch |
| `POST /api/v1/admin/freshness/refresh-all` | Guarded fleet-wide batch |
| `GET /api/v1/admin/refresh-batches/{id}` | Batch progress |
| `GET`/`PUT /aggregation/settings` | Global cadence + drift auto-rebuild (returns effective env defaults) |
| CLI | `python -m backend.scripts.signal_data_changed --graph <name> [--scope S] [--force]` |

# Appendix B · Configuration

| Setting | Default | Notes |
|---|---|---|
| `AGGREGATION_REBUILD_MIN_INTERVAL_SECS` | `900` | **Env is now the fallback only** — a persisted global and a per-source override take precedence (override → global → env), shared by the cooldown gate, the reconciler, and the UI countdown |
| `AGGREGATION_DRIFT_AUTO_REBUILD` | `true` | Scheduler acts on drift and reconciles markers; `false` restores notify-only. Same persisted-global override |
| `GRAPH_CACHE_MAX_PAYLOAD_BYTES` | `1 MiB` | Oversized results now *delete* the stale entry; raise for large aggregated payloads |
| `REDIS_CACHE_*` / `CACHE_REDIS_URL` | — | Now honoured by the graph response cache (payloads + LKG). Coordination stays on the shared durable Redis |

**Migrations added:** `refresh_events`, `agg_cadence`, `merge_heads`, `clear_scope` (all ≤32 chars;
single alembic head verified).

# Appendix C · Verification

- **Reviews:** 22 independent per-task reviews plus three whole-branch passes and two delta passes.
  Every Critical/Important finding (11 in total — including a reason-vocabulary mismatch that would
  have kept the banner from ever firing, a reconcile loop on never-aggregated sources, a spoofable
  audit origin, a batch-abort on commit failure, and a drift-toggle that clobbered a deliberate
  `env=false` deployment) was fixed and re-review-confirmed. Final verdict: **Ready to merge**.
- **Tests:** ~370 backend tests across the feature suites green in-container; 26 frontend specs;
  TypeScript baseline unchanged throughout (76 → 76 pre-merge; 79 post-merge, the three additional
  being pre-existing `main` test-config errors).
- **Live end-to-end:** four passes on the dev stack through the real HTTP API — the full convergence
  loop (twice, pre- and post-fix), the cockpit (10/10), and the cache-stats/fleet-refresh addendum
  (7/7). Evidence logs under `.superpowers/sdd/`.

# Appendix D · Known limitations & operational notes

1. **Deploy requires a real restart.** The dev poll-reloader was observed missing bind-mounted
   router and schema changes; new routes are not served until the service actually restarts.
   Frontend dependencies also changed on `main` — run an install as part of deploy.
2. **The change gate is counts-based.** A change that doesn't alter node/edge counts by label/type
   (a re-parent, a property edit) isn't detected automatically — use `--force` or an explicit
   rebuild. The bundled loaders signal on every run, but a count-neutral load still passes the gate
   as a no-op unless forced.
3. **Graph-store capacity is a real ceiling.** Very large aggregations fail with
   `OutOfMemoryError` when the graph store is at its memory limit. This release makes that failure
   *legible, resettable and non-churning* — it does not create memory. Free space or raise the limit
   for those sources to complete.
4. **A fleet-wide refresh can fan out heavy work.** Even the change-gated `auto` scope queues real
   rebuilds for genuinely-changed large sources; ensure headroom before exposing it broadly.
5. **Frontend epoch lag (largely mitigated).** An open canvas now detects completion itself via the
   readiness poll whenever the source is flagged `source_changed`, so the banner clears and lineage
   refreshes without a reload. Where that flag isn't present, the older path still applies: an
   already-open canvas can take up to five minutes to notice a completed rebuild (cross-process
   run-meta cache); a fresh page load is always immediate.
6. **Custom or third-party loaders must still announce themselves.** The eight bundled scripts do
   this automatically; anything else writing straight to the graph store should call
   `emit_after_load_async` (in-process) or `POST /api/v1/admin/data-sources/{id}/refresh`, or be
   given a drift schedule as a backstop.
7. **Follow-ups tracked:** per-provider `cacheConnection` override for the *response* cache;
   `refresh_events` retention/GC; physical-graph namespacing on the draft/stale-main read path;
   per-tick audit growth for a persistently failing pipeline; control-plane/worker application logs
   not surfacing via `docker logs`.
