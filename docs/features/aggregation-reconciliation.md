# Automatic Aggregation Reconciliation

**Status:** shipped (branch `claude/reconciler-automation-drift-8v7ngx`, 2026-08-14)

## The problem

An external system reloads a data source. The raw nodes and edges come back
with the same URNs, but the `:AGGREGATED` overlay is wiped — and nothing in the
product noticed. The lineage canvas served an empty or thin rollup while every
status in the app reported the source as `ready`.

Three compounding holes:

1. **No overlay-integrity check existed.** `aggregation.data_source_state.aggregation_edge_count`
   is written once by the worker on completion and never re-verified against the graph.
2. **Drift detection was effectively dead code.** `AggregationScheduler._tick()`
   only checks sources with `aggregation_schedule IS NOT NULL AND aggregation_status = 'ready'`,
   and nothing in the product ever sets that cron. It also made a live
   `get_schema_stats()` call per source per 60-second tick, which would not have
   scaled even if it were reachable.
3. **Never-aggregated sources were excluded by design.** `_AGG_NOT_APPLICABLE`
   means an onboarded source with zero AGGREGATED edges never got a first build
   from any signal — a documented limitation of the convergence work.

Meanwhile the stats service already collected the evidence, roughly every 15
minutes, into `public.data_source_stats.edge_type_counts` — a JSON dict that
carries the `AGGREGATED` count beside every raw edge type. Nothing read it.

## The design

A scheduled sweep decides everything from Postgres. **`ReconciliationSweeper`
takes no provider registry**, which is the structural guarantee — asserted in
the tests — that it cannot make a graph call even by accident.

```
tick (60s)  → is any source due?  (per-source interval, default hourly)
  Phase A — advisory lock held, pure SQL, no network
     batched reads → evaluate() → stamp drift_state + last_checked_at
                                → seed baselines, write run header → COMMIT
  Phase B — no lock, one short session per action
     signal_source_changed(origin="reconcile-sweep")   … or trigger() for a first build
```

Two phases because the advisory lock is transaction-scoped and `engine.py`
forbids holding a session across an outbound network call. The
`last_reconcile_checked_at` write inside Phase A *is* the cross-replica mutual
exclusion: a replica that loses the race finds no due candidates.

### The baseline

The drift baseline is a **new** fingerprint that excludes `AGGREGATED`
(`raw_fingerprint_from_counts`). `graph_fingerprint` includes it and therefore
moves on every rebuild, so reusing it would make each successful rebuild look
like fresh drift and re-trigger itself forever. Excluding `AGGREGATED` makes the
baseline invariant across rebuilds by construction, so it never needs
re-seeding. The digest carries a `"v": "raw1"` namespace tag so it can never
collide with the schema digest for a source that happens to have no overlay.

### Detectors, first match wins

| Reason | Fires when |
|---|---|
| `overlay_missing` | Status `ready`, a non-zero build history, and zero rollups observed |
| `overlay_shrunk` | Rollups materially below the last build **with the raw data unchanged** |
| `never_aggregated` | Onboarded, has nodes and an ontology, never had a completed job |
| `raw_drift` | The raw fingerprint moved |

### Guards, and why each exists

| Guard | Without it |
|---|---|
| `overlay_unobservable` (dedicated projection) | Its rollups live in a graph `get_stats()` never scans, so the observed count is permanently zero — and dedicated projection is used for the *largest* graphs. Every one of them would rebuild hourly, forever. Detectors 1–2 sit out; drift and first-build still apply. |
| `platform_mastered` (versioned source) | Postgres masters the graph, so every count-based signal measures a rebuildable cache instead of the source of truth — and the projector already maintains the rollups. See the section below; without it the sweep closes a self-sustaining loop with the projection watermark. |
| `stats_predates_build` | A source rebuilt two minutes ago still reports its pre-rebuild count. Acting on it re-fires the same finding forever. |
| NULL baseline = seed | The first sweep over a fleet would classify every source as drifted and queue a fleet-wide rebuild. |
| `expected > 0` on detector 1 | A containment-only graph legitimately materialises an empty cube and would rebuild forever. |
| `already_marked` | The stale-marker reconciler in `scheduler.py` owns that source. Two mechanisms must never both retry one rebuild. |
| Circuit breaker (3 consecutive actions) | A finding we can never clear would rebuild a huge graph every hour indefinitely. |
| `no_ontology` | `trigger()` would raise `OntologyResolutionError` once an hour. Recorded as a finding instead — a useful signal on its own. |

Two conditions produce a finding that is **recorded and surfaced but not acted
on**, so the cockpit stays honest about drift even where automation is off:
`policy_disabled` and `cooldown` / `failed_backoff`.

### Caps

`_SCAN_CAP = 200` per pass · `reconcileMaxActionsPerRun = 10` ·
`_FIRST_BUILD_CAP = 1` (a fresh install with many unbuilt sources drains one per
sweep rather than queueing every full build at once) · `_NUDGE_CAP = 25` stats
re-polls · breaker cap 3.

### First builds

Detector 3 calls `svc.trigger(..., trigger_source="schedule")` **directly**, not
`signal_source_changed` — that path treats a `none` status as not-applicable by
design, and that remains true. `trigger()` applies the stored global tuning
defaults, so an auto-queued job inherits the configuration that clears a
1M-node / 2M-edge graph with no extra plumbing.

## Versioned (platform-mastered) sources

A graph mastered inside the platform inverts everything above. Postgres
(`graphver`) is the source of truth and FalkorDB is a **rebuildable read cache**
of committed `main`. Such sources are 1:1 with a data source, are polled by the
stats service with no special-casing, and get an `aggregation.data_source_state`
row as soon as the projector's rollup hook fires — so they land in the sweep's
candidate set like anything else.

**They are guarded out of every detector** (`platform_mastered`, evaluated
second, immediately after `deleted`), recorded, and surfaced as **Version
controlled**. Two independent reasons:

1. **The counts measure the wrong backend.** `ContextEngine` routes a versioned
   source's reads to FalkorDB only while `projection_watermark(...)["fresh"]`
   holds; otherwise they come from Postgres, which has no `:AGGREGATED` rows by
   construction. So `observed_aggregated == 0` for a perfectly healthy source.
   That is not rare — LRU eviction under a per-provider RAM budget, a repoint,
   and an unfaithful-seed hold all clear the watermark, the last of them
   indefinitely. `stats_stale` does not help: an evicted source is polled on
   schedule, so its counts are fresh, just measured elsewhere. Raw drift is no
   better — every publish moves the counts and `nudge_stats_after_projection`
   re-polls seconds later.
2. **There is nothing to do.** `FalkorProjector` maintains `:AGGREGATED`
   incrementally per committed window from the same `pair_rules` the batch
   pipeline uses, and hands off to `agg.trigger()` through `on_rollups_stale`
   wherever it cannot — a full seed, a move window past `_MOVE_EDGE_CAP`, or a
   verify-heal reseed. All three projector wirings carry that hook.

Left unguarded these compound into a loop: the sweep queues a job → the job
stamps `_AggMeta` → the next projection's verify counts it as an extra entity →
the watermark is pinned → reads fall back to Postgres → the overlay reads as
wiped → the sweep queues a job. Each turn increments the breaker until the
source is suspended.

Identification is a live `graphver.graphs` row, resolved by
`services/versioned_sources.py` — an app-layer bridge in the same position as
`projection_target.py`, since the versioning package stays decoupled from the
management DB. `workspace_data_sources.source_mode` cannot answer it: `'managed'`
is written only by the blank-model wizard and a one-off script, never by the
bootstrap path, so most versioned sources have it NULL. The read runs **before**
the advisory lock (a second engine may be a second database), caches for 10
minutes, serves the last good answer through a blip, and on a cold failure
**defers the whole sweep** to the next 60s tick — both fail-open answers are
wrong, and an hourly check loses nothing by waiting.

The baseline is still adopted on every pass, so a source later taken back out of
versioning does not read as drifted on its first sweep afterwards.

> **Known gap — no shared lock with the projector.** The projector holds a
> Postgres session advisory lock `hashtext("gvproj:{graph_id}")`; the
> aggregation worker holds a Redis lease `agg:graphwrite:{host:port}:{graph}`.
> Disjoint namespaces over the same graph, and a projector full seed opens with
> `client.delete()` on the whole key, so an aggregation job landing mid-projection
> is unguarded — including one the projector queued itself. `trigger()`'s
> graph-level guard only sees other aggregation jobs; it cannot consult
> `graphver.projection_state`. Observe-only means this feature adds no new
> exposure, but the gap predates it and is not closed here.

## Configuration

Global policy lives in `aggregation_settings.cadence_json` beside the rebuild
cadence — the same store, the same 30-second cache, the same dialog.

| Field | Env fallback | Default |
|---|---|---|
| `reconcileEnabled` | `AGGREGATION_RECONCILE_ENABLED` | `true` |
| `reconcileCheckIntervalSecs` | `AGGREGATION_RECONCILE_INTERVAL_SECS` | `3600` (floor 300) |
| `reconcileMaxActionsPerRun` | `AGGREGATION_RECONCILE_MAX_ACTIONS` | `10` |
| `reconcileShrinkTolerancePct` | `AGGREGATION_RECONCILE_SHRINK_TOLERANCE_PCT` | `10` |
| `reconcileDetectors` | — | unset = all on; **`[]` = all off** |
| — | `AGGREGATION_RECONCILE_STATS_MAX_AGE_SECS` | `2700` |
| — | `AGGREGATION_RECONCILE_BREAKER_CAP` | `3` |
| — | `AGGREGATION_RECONCILE_SCAN_TIMEOUT` | `3` |

Per-source overrides are columns on `aggregation.data_source_state`:
`reconcile_enabled` (the per-source feature flag — it cannot live in
`feature_flags`, which is a single global row) and
`reconcile_check_interval_secs`. Resolution is override → global → env, the
same chain `rebuild_min_interval_secs` uses.

> **`reconcileDetectors == []` means "act on nothing", not "unset".** Every read
> must test `is not None`, never truthiness.

## Audit

Per-source actions extend `refresh_events` with `reason` (the typed detector
code), `evidence` (JSON: observed vs expected rollups, raw counts before →
after, both fingerprints, how old the statistics were) and `job_id`. `origin` is
**`reconcile-sweep`**, deliberately distinct from the pre-existing `reconcile`,
which means the stale-marker reconciler. Automatic vs manual is *derived* from
origin, not stored.

### The trail joins up with Job History

`refresh_events` knows **why** a rebuild was decided on; `aggregation.jobs`
knows **what** the rebuild did. Two changes connect them, in both directions:

- **`trigger_source = 'reconcile'`.** Every rebuild the sweep queues goes
  through `signal_source_changed`, which hardcoded `"api"` — so an hourly
  automatic reconciliation was indistinguishable in Job History from a person
  clicking Rebuild. The signal now takes a `trigger_source` (defaulting to
  `"api"`, so no existing caller changes) and the sweep passes its own. The
  first-build path moved off `"schedule"` for the same reason: that value means
  the cron-driven `AggregationScheduler`, and all four detectors should report
  as one thing.
- **`refresh_events.job_id`.** The audit event names the job it produced.
  `_reconcile_reason_map` reads it back for a page of jobs — batched and joined
  in memory, since `refresh_events` is `public` and `aggregation.jobs` is not —
  and only for jobs whose trigger is `reconcile`, so an ordinary page issues no
  extra query.
- **`refresh_events.run_id`.** Names the `reconcile_runs` pass that produced
  the event. The overnight blotter joins on it instead of filtering Job History
  by trigger + calendar day. Compact `findings` on the run (acted and held)
  are what let the ledger answer "found, not rebuilt" without a new table.
  `last_finding_*` on the state row is the live detector evidence, distinct
  from `last_reconcile_*` which remains "last rebuild queued".

The result: Job History's Trigger column reads **"Rollups were missing"** rather
than "API", filters by **Reconciliation**, and its expanded row carries the
counts that justified the rebuild plus a link into the cockpit. The drawer's
activity trail links the other way, to the rebuild each finding started.

Sweep-level passes get one `aggregation.reconcile_runs` row each — not one per
source per hour — with tallies by reason and by skip code, trimmed to 30 days.

## API

| Method & path | Gate | Mode |
|---|---|---|
| `GET /api/v1/admin/freshness/reconciliation` | ingestion-read | in-process |
| `GET /api/v1/admin/freshness/reconciliation/activity?since=` | ingestion-read | in-process |
| `PUT /api/v1/admin/freshness/reconciliation` | `system:admin` | in-process |
| `POST /api/v1/admin/freshness/reconcile-now` `{dryRun, dataSourceIds?}` | `system:admin` | proxy |
| `PATCH /api/v1/admin/data-sources/{id}/freshness-settings` | `ds:manage` | existing |

`activity` defaults to the last 24 hours (`since=24h`, or an ISO timestamp).
Each row is a finding from `reconcile_runs.detail.findings`, joined to
`refresh_events` by `run_id`, so a rebuilt source carries its `jobId` and a
held source (cooldown, cap, automation off, already suspended) is still
visible.

The reads stay in-process in both modes because they are pure SQL over tables
the web tier already reads; the write proxies because the sweeper lives on the
control plane. `actor` is forced server-side.

> **Partial-update semantics.** On both PATCH and PUT, only the keys actually
> sent are written. Every field treats an explicit `null` as "clear this
> override", so applying absent fields too would make a partial update silently
> destructive.

## UI

Freshness is a command center whose identity is **overlay integrity**, not a
collapsible footnote under cache tiles.

The **Integrity Pulse** is the signature: Watching / Detecting only, last and
next check, drifting count, sources that need a person (`suspended`), last-pass
tallies, Check now / Preview / Cadence. The whole card goes amber when sweeps
have stopped (last run older than three check intervals). A recon fetch error
renders; it must not look healthy.

The **overnight blotter** groups the last 24 hours by sweep. A rebuilt row
links to Job History by `jobId`; a held row says why. Clicking a source opens
`?fds=`.

Compact stat tiles and the provider-grouped fleet table stay below. There is
no eighth generic tile: `fstatus=suspended` is toggled from the pulse's
"needs a person" count, which comes from the server summary (not the 200-row
page). `needsAttention` includes suspended.

A version-controlled source shows the **Version controlled** badge, swaps the
integrity meter for an explanation of why counting rollups would measure the
wrong thing, and **hides** the per-source toggle and interval override rather
than disabling them — every one of those controls governs a sweep that will
never act on it. Its tone is `sky`, not `indigo`: measured against the six tones
already in `DRIFT_SPEC`, indigo-600 sits ΔE 7.5 from violet-600 ("Blocked") to
normal vision — worse than the red/amber pair below — and 1.3 apart under
protanopia. sky-600 is the only candidate that adds no new collision.

**Preview before committing.** The pulse's *Preview* opens a dry sweep —
every source evaluated exactly as a real pass would, nothing queued — grouped by
reason with the evidence behind each finding, including the provider name. This
is what makes enabling automation on an established fleet a decision rather
than a gamble.

**The sweep's own health.** A stopped control plane is a silent failure: no
source is ever re-checked and every drift verdict freezes at its last value,
looking perfectly current. The pulse shows *Sweeps have stopped* once the last
run is older than three check intervals, and *Not yet run* before the first.
System Status carries the same signal (`probe_reconciliation`) plus a
`suspendedCount`. Transition into `suspended` also rings `reconcile.suspended`
for workspace `datasource:manage` holders **and** globally bound `system:admin`,
unread-deduped per source, linking to `?fds=`.

The drawer's open source lives in the URL (`?tab=freshness&fds=<id>`), so a link
from a reconciliation job, a data-source profile, a bell, or a copied address
lands on that source's detail instead of an unfiltered fleet table.

Ingestion → Freshness: Integrity Pulse + overnight blotter, a "Drifting" stat
tile and filter facet, a per-row verdict badge with its reason, a Reconciliation
panel in the source drawer (integrity meter, history sparkline, per-source
toggle, check-frequency override, last-checked/last-reconciled/why), and the
policy controls inside the existing **Cadence & reconciliation** dialog. The
verdict also appears on the data-source profile with a link through to
`?fds=<this source>`.

Every drift state ships an icon **and** a written label. Light-mode `red-600`
and `amber-600` measure ΔE 14.4 apart to normal vision — below the 15 floor
where two colours stop being reliably distinguishable — and the two states they
carry sit adjacent constantly. `DriftStateBadge.test.tsx` asserts this for all
seven states.

## Operating it

- **Before enabling on an established fleet**, run the preview:
  `POST /api/v1/admin/freshness/reconcile-now {"dryRun": true}`. It evaluates
  and reports, and queues nothing.
- **The first sweep seeds and acts on nothing** for drift; detectors 1 and 3 can
  fire on it, which is the point.
- **A source stuck at "Reconcile suspended"** hit the breaker: it was rebuilt
  repeatedly without the finding clearing. Look at why the rollups keep
  disappearing before clearing it with a manual check.
- **Turning a detector off** stops rebuilds for it. The problem is still
  detected and still shown.

## Verifying it end to end

1. Pick a source with a built overlay; note `aggregation_edge_count`.
2. Wipe it out of band:
   `redis-cli -p 6379 GRAPH.QUERY <graph> "MATCH ()-[r:AGGREGATED]->() DELETE r"`.
3. Force a stats poll (or wait one interval) so `edge_type_counts` reports
   `AGGREGATED: 0`.
4. `POST .../reconcile-now {"dryRun": true}` → one finding,
   `reason: "overlay_missing"`, evidence `expected: N, observed: 0`, nothing queued.
5. Run it for real → a job with `trigger_source='reconcile'` (never
   `schedule` — that value is the cron-driven scheduler); a `refresh_events`
   row with `origin='reconcile-sweep'` and `run_id` of the pass; the blotter
   shows the source as Rebuilt with a job link; the tab shows Drifting →
   Recomputing.
6. On completion: count restored, verdict back to In sync, `last_reconciled_at`
   stamped, a `reconcile_runs` row recorded.
7. **Opt-out:** disable auto-reconcile on the source and repeat 2–3 → still
   surfaced as Drifting, nothing queued.

Note: the control plane is bind-mounted without autoreload, so new routes and
the sweeper need a real restart of `aggregation-controlplane`.
