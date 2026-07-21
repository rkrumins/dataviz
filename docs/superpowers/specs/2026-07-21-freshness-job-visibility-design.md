# Freshness tab: live job state, Job History navigation, and honest refresh dialogs — Design

**Date:** 2026-07-21 · **Status:** approved (user, in-session) · **Branch:** `claude/falkordb-redis-connectivity-va6czv`

## Why

The OPS Freshness Cockpit (2026-07-18 design) made freshness *legible* but left the operator stranded the moment they act on it:

1. **A rebuild you trigger disappears.** The row flips to `Recomputing` and stays there — a static badge with no phase, no percentage, no end in sight. `FreshnessRow` already holds `runningJobId`; nothing uses it. Meanwhile Job History has the full picture (EXTRACT → COMPUTE → RECONCILE → APPLY stepper, live progress, ETA, edge counts) and the two surfaces are not connected by so much as a link.
2. **"Refresh provider" understates itself.** The dialog says rebuilding "can take several minutes and adds load on the provider" for a verb that clears cached data and queues an aggregation job for *every live source under the provider* — 31 of them on the observed instance, several of which have previously failed on FalkorDB memory.
3. **"Refresh complete" reports nothing an operator can use.** It lists raw `ds_aa66b0b29766` identifiers with a green tick. It does not say what was done to each source, that 24 of them merely *queued* work that has not started, or which ones were deferred by cooldown. `RefreshResponse` already carries `actions` and `deferred` per source; the batch runner drops both on the floor.
4. **Every row action hides behind `⋯`.** Including the action the row's state actually calls for.

**Framing decision (user, mid-design): do not reinvent Job History inside Freshness.** Freshness answers *"is this source healthy, and what is happening to it right now?"*. The moment the operator wants depth — phases, edge counts, cancel, retry, history — they are sent to Job History. Freshness must not become a second job console with a second implementation to drift.

## 1. Live job state in the row

**Data flow.** One new React Query in the Freshness tab: `aggregationService.listJobsGlobal({ status: ['running', 'pending'], limit: ACTIVE_JOB_CAP })`, polled on the fleet's existing cadence (`FLEET_POLL_MS`, `staleTime: 15_000`), reduced to a `Map<dataSourceId, AggregationJobResponse>`.

**One request, not one per row.** `JobRow` opens an SSE stream per active row (`useJob`), which its own comment flags as capped by HTTP/1.1's ~6 connections per host. With 21 rebuilding rows that is a non-starter, and Freshness does not need per-second fidelity — poll cadence is sufficient for a badge.

**No silent truncation.** `listJobsGlobal` is paginated (`PaginatedJobsResponse` = `{items, total, limit, offset}`). Request `ACTIVE_JOB_CAP = 200`; when `total > items.length`, log once and let un-joined rows fall back to the plain `Recomputing` badge. A row never displays a *stale* phase or a percentage it cannot substantiate.

**Degradation.** If the jobs query fails or 403s for this operator, every row falls back to the plain badge. The Freshness tab must not break because a secondary query failed.

**Rendering in the row.** In `FreshnessRow.tsx`, `FreshnessBadges` extends only the `recomputing` branch — badge line plus a slim progress bar, so a rebuilding row grows by one line and no more:

```
⟳ Recomputing · Computing rollups · 62%        →
████████████████░░░░░░░░░
```

- Phase label from `PHASE_LABELS`, percentage and bar from `job.progress`.
- Phase label absent/unrecognized → fall back to today's bare `Recomputing` with no bar, never a guess.
- The badge links to Job History (§2). The rest of the badge cascade (`failed`, `queued`, `stale`, drift, cooldown) is untouched.

**Expandable detail panel.** A rebuilding row expands in place (chevron in the source cell, same interaction as Job History's rows) to a panel carrying the **four-phase stepper** and a full-width progress bar:

```
Computing rollups                                62%
██████████████████████████░░░░░░░░░░░░░░░
✓ EXTRACT 1m2s   ● COMPUTE   ○ RECONCILE   ○ APPLY
                                    Open in Job History →
```

The panel deliberately stops there. Edge counts, ETA, worker, retries, run stats, cancel/resume/re-trigger and history all stay in Job History, one click away. Only rows with a joined running job are expandable.

**Shared components, not a second implementation.** The stepper is Job History's own `PhaseStepper`, moved — not copied — from `job-history/JobRow.tsx` into `job-history/shared.tsx` (the module `JobRow` already imports) and exported, with `PHASES`, `PHASE_BANDS`, `PHASE_LABELS` and `phaseLabel()` alongside it. `JobRow` imports it back and renders unchanged. `historicalEta` stays in `JobRow` — Freshness shows no ETA. Two hard-coded copies of the pipeline's phase vocabulary is exactly the drift this avoids.

`PhaseStepper` needs only `currentPhase`, `runStats` and `status`, all of which are already on the `listJobsGlobal` list payload — so the join in this section is sufficient and no per-row fetch is introduced.

## 2. Navigation to Job History

**No backend or routing work.** `paramsToFilters` (`job-history/shared.tsx:173`) already parses `dataSourceId` (repeatable), `status` (repeatable), and `workspaceId` from the URL, and `IngestionPage` already drives tabs from `?tab=` over `IngestionTab = 'providers' | 'assets' | 'jobs' | 'freshness'`.

Add one helper beside `paramsToFilters`:

```ts
jobHistoryPath({ dataSourceId?, status? }): string   // → /ingestion?tab=jobs&dataSourceId=…
```

Wired into five places:

| Where | Link |
|---|---|
| Row `Recomputing` badge | that source, no status filter |
| Row `⋯` → "Open in Job History" | that source |
| `FreshnessDrawer` header | that source |
| Refresh-complete dialog, per row | that source |
| Refresh-complete dialog, footer | all sources in the batch (`status=running,pending`) |

Links are real `<a>`/`Link` elements — middle-click and "open in new tab" must work.

## 3. Row actions: primary button + `⋯` overflow

`FreshnessRow` replaces the bare `⋯` with a state-driven primary action plus an overflow, both derived from `freshnessState(row)` (`freshnessTriage.ts:98`) so the visible action is always the one the row's state calls for.

| State | Primary | Overflow |
|---|---|---|
| `failed` | **Retry rebuild** (`rollups`, force) | Refresh caches · Clear cache · Full refresh · Open in Job History |
| `recomputing` | **View progress** (expands §1's panel) | Refresh caches · Cancel job · Open in Job History |
| `queued` / `stale` | **Rebuild now** (`rollups`) | Refresh caches · Clear cache · Full refresh · Open in Job History |
| `neverBuilt` | **Build lineage** (`rollups`, `firstBuild`) | — |
| `upToDate` | **Refresh caches** (`read-caches`) | Clear cache · Rebuild lineage · Full refresh · Open in Job History |

**`recomputing` primary is View progress, not Cancel** (decided against the initially-approved table). The natural primary for a running job is *go look at it*; Cancel is destructive and must not be the easiest target on 21 rebuilding rows. It opens §1's in-place panel rather than navigating, so the two progress affordances stay complementary — the primary peeks inline, the badge and the panel's footer link jump to the full console. Cancel remains in the overflow, delegating to `aggregationService.cancelJob(dataSourceId, jobId)` — no new endpoint.

Preserved from today: the whole cluster is hidden when the operator lacks `workspace:datasource:manage` for the row's workspace (`usePermission`, the RegistryConnections convention — a disabled control would just 403); actions disable while this row's own mutation is in flight. The current blanket disable-while-`running` is replaced by per-action rules, since View progress and Cancel are precisely the actions that *need* to work during a run.

## 4. Refresh-provider guard

`ProviderRefreshDialog.tsx` and its sibling `FleetRefreshDialog.tsx` replace the single generic amber line (`ProviderRefreshDialog.tsx:120-125`) with a per-scope impact block:

```
Scope: Full refresh
This will, for all 31 live sources:
  ⌧ clear cached canvas data      (users see slower first loads)
  ↺ queue a lineage rebuild job   (31 aggregation jobs, limited concurrency)
  ⏱ minutes to tens of minutes per source
⚠ Rebuilds continue in the background if you close this.
```

- Source count comes from the authoritative batch total where known; before the batch starts, the dialog says "every live source using this provider" rather than inventing a number from the possibly-filtered table (the existing `ProviderRefreshDialog.tsx:53-56` caveat).
- **Rebuilding scopes** (`rollups`, `full`, and `auto` with `force`) require a second explicit step; the confirm button names the consequence: `Yes, rebuild 31 sources`.
- **Non-rebuilding scopes** (`read-caches`, `clear`) keep the single click — cheap, safe, and routinely used to un-stick a source.

## 5. "Refresh complete" says what happened

**Backend** (`controlplane.py`, `schemas.py`):

- `BatchItemResult` (`schemas.py:765`) gains `name: Optional[str]`, `actions: List[str] = []`, `deferred: bool = False`.
- `_run_one` (`controlplane.py:785`) already holds the `RefreshResponse`; carry `resp.actions` and `resp.deferred` into the item instead of discarding them. The error branch (`:790`) keeps its shape with empty actions.
- `_live_ds_ids` (`controlplane.py:800`) selects `name` alongside `id` and the runner threads an `id → name` map into the item — no extra per-item query.
- Mirror the three fields in `freshnessService.ts:144`.

**Frontend** — the results list (`ProviderRefreshDialog.tsx:164-176`, and the same list in `FleetRefreshDialog.tsx`) shows name, what happened, and a link (`jobId` is already in the payload today). The list is extracted into one shared component so the provider and fleet dialogs cannot drift:

```
✓ Solidatus Perf Xlarge   cache cleared · rebuild queued     View job →
✓ Nexus Lineage           caches refreshed
◷ Manual Lineage          deferred — in cooldown, no rebuild queued
✗ Physical Lineage5       failed to start

31 sources · 24 rebuilds queued · 5 deferred · 1 failed        View all jobs →
```

- Raw `actions` strings are mapped to plain language in one exported table; unknown values pass through humanized rather than being hidden.
- `name` missing → fall back to `dataSourceId` (never a blank row).
- Summary counts are derived from the items themselves: `jobId` present = rebuild queued, `deferred` = deferred, `outcome === 'error'` = failed.
- The summary line is the substantive fix: a batch reports "complete" while having *queued* work that has not started. "Refresh complete" must not read as "rebuilds finished".

## 6. Testing

- `freshnessTriage` / row: the state → primary-action mapping for all six states; overflow contents per state; the whole cluster hidden without `workspace:datasource:manage`.
- Row badge: renders phase + percentage + bar when a job joins; falls back to bare `Recomputing` with no bar when the job is absent, the phase is unrecognized, or the jobs query failed.
- Expandable panel: only rows with a joined running job expand; the panel renders the shared `PhaseStepper` with the right phase marked current, and links out to Job History.
- `PhaseStepper` relocation: Job History's existing stepper tests still pass against the shared module (proving a move, not a fork).
- Active-jobs join: over-cap responses do not render stale phases.
- Dialogs: rebuild scopes require the confirm step, non-rebuild scopes do not; results render names, actions, deferred and failed states; summary counts are correct.
- Backend: a batch item carries `name`, `actions` and `deferred`; the error branch stays well-formed.

## 7. Scope boundaries

**Doing:** progress bar and four-phase stepper in Freshness, rendered by Job History's own `PhaseStepper` component after it is moved into the shared module.

**Not doing:** ETA, edge counts, worker/retry/run stats, resume/re-trigger controls, or a job list inside the Freshness panel; a second live-job stream; a re-implemented stepper; any change to Job History's behavior beyond relocating the shared pieces it already owns. (Cancel is reachable from the row's `⋯` overflow per §3 — it is a freshness action on the source, not a panel control.)

## 8. Risks

- **`listJobsGlobal` cost at fleet scale.** One extra polled query per Freshness viewer. Bounded by `ACTIVE_JOB_CAP` and the existing poll cadence; it reads the job table only.
- **Phase vocabulary drift.** Mitigated by moving `PHASE_LABELS` to `shared.tsx`; the fallback keeps an unrecognized phase honest rather than wrong.
- **Percentage credibility.** `job.progress` is phase-weighted, not linear in time. The badge shows the phase name alongside the number so the operator reads progress qualitatively; the ETA stays in Job History where the historical projection lives.
