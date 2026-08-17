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

Reading it was only half the problem. Because that evidence arrived on a
15-minute poll and each source was checked at most hourly, a source could be
serving wrong rollups for over an hour before anything noticed. The poll is
slow for a good reason — it is two full graph scans — so the fix was not to
run it more often. See **The probe** below.

## The probe

The sweep can only act on the counts it finds in Postgres, so how fast it
reacts is set by how fast those counts refresh. `provider.get_stats()` refreshes
them with two full scans — `MATCH (n) RETURN labels(n)[0], count(*)` and its
edge twin — which is why its idle interval has to be 900s.

FalkorDB will answer a *bare* count from its label and relation-type counters
instead: `MATCH (n) RETURN count(n)`, `MATCH (n:L) RETURN count(n)` and the
edge equivalents all plan as `Results / Project` with **no scan operator**.
Adding any projection alongside the count loses the optimisation, which is
exactly what the two queries above do.

`provider.get_counts_fast()` therefore rebuilds the same payload from
`db.labels()` + `db.relationshipTypes()` plus one constant-time count each.
Measured on a 500k-node / 850k-edge graph: **~1.3ms against ~514ms**, and
constant in graph size rather than linear. That is what makes a 60s probe
cadence affordable where the counts poll must stay at 900s, and it takes
worst-case drift detection from roughly 75 minutes to under one.

Two corrections are load-bearing, both verified against a live engine:

* **Zero-count buckets are dropped.** `db.labels()` keeps listing a label after
  its last node is deleted, where `get_stats` returns no row for it. A
  `{"Ghost": 0}` key hashes differently from an absent one, so keeping it would
  read as drift on the first probe of every graph that ever deleted a type.
* **`unknown` is derived as `total − sum(labels)`.** Unlabelled nodes are
  invisible to per-label counts and `get_stats` buckets them under
  `labels(n)[0] or "unknown"`. If the label sum comes out *above* the total the
  graph has multi-label nodes, per-label counting is no longer equivalent, and
  the probe returns `None`. There is no scan fallback in the probe lane — the
  attempt stamps only the probe clock (so the source retries once per probe
  interval instead of every scheduler tick) and the scheduled stats poll
  remains the source of counts for that graph.

Scheduling and execution are split deliberately. `ProbeScheduler` (Control
Plane) resolves policy and enqueues; the stats service executes, because every
outbound provider call belongs to the tier that owns them. They meet at the
`insights.jobs.probe` stream, whose SET NX claim means any number of requests
for one source inside the claim window buy exactly one probe.

## The design

A scheduled sweep decides everything from Postgres. **`ReconciliationSweeper`
takes no provider registry**, so an *auto* tick cannot make a graph call. The
one exception is deliberate and operator-shaped: a manual Check now / Preview
refreshes counts live (`_live_observe_counts`, reached through the service's
registry) — counter reads first, the full `get_stats` only where counters
cannot answer, the whole pass under a 30-second budget. Sources not reached in
time evaluate from stored counts through the named skip paths.

```
tick (60s)  → is any source due?  (counts moved, or per-source interval)
  Phase A — advisory lock held, pure SQL, no network
     batched reads → evaluate() → stamp drift_state + last_checked_at
                                → seed baselines, write run header → COMMIT
  Phase B — no lock, one short session per action
     signal_source_changed(origin="reconcile-sweep")   … or trigger() for a first build
```

Two phases because the advisory lock is transaction-scoped and `engine.py`
forbids holding a session across an outbound network call. Cross-replica
safety is layered: the advisory lock serialises auto ticks (and fails
*closed* — a Postgres error skips the tick rather than double-acting), every
evaluated source advances `last_reconcile_checked_at` so a losing replica
finds it no longer at the head of the window, and the residual Phase-A/Phase-B
gap is collapsed by the trigger idempotency keys — a duplicate dispatch lands
as a conflict no-op that neither adopts the baseline nor counts as an action.

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

Three conditions produce a finding that is **recorded and surfaced but not acted
on**, so the cockpit stays honest about drift even where automation is off:
`disabled`, `paused` (an operator snooze, held in the state row's
`paused_until` until it lapses — future-only and at most 90 days out) and
`cooldown` / `failed_backoff`. (The guard names above describe conditions; the
per-sweep tally uses the `SKIP_REASONS` tokens in `reconcile.py`, and holds
advance the fairness clock while staying due through the unresolved-drift
clause.)

### Caps

`_SCAN_CAP = 200` per pass · `reconcileMaxActionsPerRun = 10` ·
`_FIRST_BUILD_CAP = 1` (a fresh install with many unbuilt sources drains one per
sweep rather than queueing every full build at once) · `_NUDGE_CAP = 25` stats
re-polls · breaker cap 3.

### First builds

Detector 3 calls `svc.trigger(..., trigger_source="reconcile")` **directly**, not
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
| `reconcileCheckIntervalSecs` | `AGGREGATION_RECONCILE_INTERVAL_SECS` | `3600` (floor 30) |
| `reconcileMaxActionsPerRun` | `AGGREGATION_RECONCILE_MAX_ACTIONS` | `10` |
| `reconcileShrinkTolerancePct` | `AGGREGATION_RECONCILE_SHRINK_TOLERANCE_PCT` | `10` |
| `reconcileDetectors` | — | unset = all on; **`[]` = all off** |
| — | `AGGREGATION_RECONCILE_STATS_MAX_AGE_SECS` | `2700` |
| — | `AGGREGATION_RECONCILE_BREAKER_CAP` | `3` |
| — | `AGGREGATION_RECONCILE_SCAN_TIMEOUT` | `3` |
| `probeEnabled` | `AGGREGATION_PROBE_ENABLED` | `true` |
| `probeIntervalSecs` | `AGGREGATION_PROBE_INTERVAL_SECS` | `60` (floor 15) |
| — | `AGGREGATION_PROBE_BATCH_CAP` | `200` |
| — | `STATS_PROBE_CONCURRENCY` (stats-service lane) | `4` |
| — | `STATS_PROBE_TIMEOUT_SECS` (stats-service lane) | `20` |
| — | `STATS_PROBE_DEDUP_TTL_SECS` (enqueue claim) | `90` |
| — | `AGGREGATION_PROBE_SCAN_CAP` (code constant, not env) | `1000` due rows per tick |

Per-source overrides are columns on `aggregation.data_source_state`:
`reconcile_enabled` (the per-source feature flag — it cannot live in
`feature_flags`, which is a single global row),
`reconcile_check_interval_secs`, and `probe_enabled` /
`probe_interval_secs`. Resolution is override → global → env, the
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

External systems that want to *push* a change signal rather than wait for the
probe to find it should read
[Telling us an external data source changed](external-change-notification.md),
which documents the supported paths and the constraints on each.

`activity` defaults to the last 24 hours (`since=24h`, or an ISO timestamp).
Each row is a finding from `reconcile_runs.detail.findings`, joined to
`refresh_events` by `run_id`, so a rebuilt source carries its `jobId` and a
held source (cooldown, cap, automation off, paused, already suspended) is still
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
tallies, Check now / Preview / Automation. The whole card goes amber when sweeps
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
tile and filter facet, a per-row verdict badge with its reason, the per-source
Detect/Check/Act panel in the source drawer, and the global policy controls
inside the **Automation** modal. The verdict also appears on the data-source
profile with a link through to `?fds=<this source>`.

### One vocabulary: ① Detect → ② Check → ③ Act

Automation is a chain, and its characteristic failure is a stage being *starved
by the one before it*. Turning Detect off does not disable Check — it silently
makes Check's interval meaningless, because Check can only ever be as fresh as
the evidence Detect produced. The three stages are named once and used
everywhere: the Automation modal, the source drawer, the row chips and the run
history. Each name appears exactly once per surface, so reusing one elsewhere
would break the signposting.

| Stage | What it does | What it costs | Knob |
|---|---|---|---|
| ① **Detect** | Watches each source for data changed by systems outside this app. Reads stored counts, never the data itself. | O(1) counter reads — see [The probe](#the-probe) | `probeEnabled`, `probeIntervalSecs` |
| ② **Check** | Decides whether the rolled-up lineage still matches the data. | Pure database work; never touches the graph | `reconcileEnabled`, `reconcileCheckIntervalSecs`, `reconcileShrinkTolerancePct`, `reconcileDetectors` |
| ③ **Act** | Rebuilds the rolled-up lineage when it no longer matches. | Minutes of graph work — capped on purpose | `reconcileMaxActionsPerRun`, `rebuildMinIntervalSecs`, `pausedUntil` |

The detectors belong to **Check**, not Act: they decide what counts as a
finding, which is Check's job, while the cap decides how many rebuilds follow,
which is Act's.

### The Automation modal

Opened from the Integrity Pulse's *Automation* button (`system:admin`). Stages
stack as full-width rows on a continuous spine, so reading order matches run
order. The spine is the signature, and it is stateful rather than decorative:

- **feeding** — solid, in the downstream stage's accent
- **starved** — dashed, amber, captioned `starved`, and *everything downstream
  desaturates*. Turning Detect off visibly greys the rest of the pipeline.

That last behaviour is the point: the operator sees the consequence instead of
reading a warning they may skip. The warning text still appears — belt and
braces — but the diagram is the primary signal. State is never carried by colour
alone (the dash pattern and the caption carry it too), and under
`prefers-reduced-motion` the transition is instant.

It must not read as a wizard: no checkmarks, no "step 1 of 3", no completion
semantics. All three stages are simultaneously live and each carries a live
stat. The numerals encode dependency order, not progress.

Each stage has one `Advanced` disclosure, closed by default — nothing is
removed, it is ranked. Detect has none (it genuinely has one setting; an empty
Advanced there would be symmetry for its own sake). Env-only values
(`statsMaxAgeSecs`, the breaker cap) render as read-only context clearly marked
as deploy-set, never as disabled inputs pretending to be editable.

Closing with unsaved edits — `Esc`, the close button, or the backdrop — raises a
discard confirmation rather than silently dropping the work.

> **Non-admins currently cannot reach this modal from the UI at all.** Both
> entry points are admin-gated, so the read-only rendering inside it is only
> reachable via `?automation=open`. `GET /aggregation/settings` is
> `system:admin`-gated, so a non-admin cannot read the cadence even then: the
> modal shows the stage copy and the reconciliation policy and says "Only
> platform admins can see this cadence" for the rest, rather than inventing
> values.

### The source drawer, and the snooze

The drawer's reconciliation panel follows the same ①②③ order: Detect (probe
toggle + interval override), Check (reconcile toggle + check-interval override,
last-checked, why), Act (rebuild cadence, last-reconciled, and the snooze).

**A snooze is a hold, never a guard.** `paused_until` refuses *dispatch* only —
the source is still evaluated every check and still records its finding and
evidence, so the cockpit can show what is wrong with something it has been told
to leave alone. This is why the snooze sits in ③ Act: it gates the rebuild, not
the detection. An unparseable or past stamp is treated as expired, so a corrupt
value can never pause a source forever.

### Row chips

`automationChip` renders at most one chip per row, in strict precedence:
**Needs a person** (breaker tripped) → **Automation off** (deliberate opt-out) →
**Paused** (snooze, and only while it is holding back a real finding). Absence
is the signal — a healthy automated source shows nothing rather than repeating
"everything is fine" on every row.

Precedence is not cosmetic. "Automation off" outranks "Paused" because a
drifting, paused, opted-out source resumes on *nothing* when the snooze lapses,
and showing "Paused" there would imply otherwise.

There is deliberately **no cooldown chip**: `FreshnessBadges` already renders
"Next rebuild in Xm" from the same `cooldownUntil` on the same row, so a chip
would be the same fact twice, one column apart.

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
  repeatedly without the finding clearing. Fix why the rollups keep
  disappearing first — the breaker resets only when a later evaluation finds
  the source `in_sync` (a manual check *after* the underlying cause is fixed
  does it; while the finding persists, checks re-confirm the suspension).
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
