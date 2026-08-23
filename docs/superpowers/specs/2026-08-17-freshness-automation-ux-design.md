# Freshness Automation UX — one pipeline, named end to end — Design

**Date:** 2026-08-17 · **Status:** approved (user, in-session) · **Home decision:** in-page Automation panel (replaces the Cadence modal) · **Row decision:** automation chip only when notable · **Capabilities:** all four (snooze, inline impact preview, per-source detect override, live drift evidence)

## Why

The reconciliation machinery is now good and — since the drift probe landed — fast. The operator surface over it is not. Three defects, all visible in one screenshot of the Cadence dialog:

1. **The mental model is inverted and invisible.** The three policies form a pipeline — detect → check → act — but the dialog lists them in the opposite order, in a 448px column, in three unrelated boxes, under three unrelated names ("change detection", "automatic reconciliation", "rebuild cadence"). Nothing shows that detection is *upstream* of checking, so an operator cannot see that turning detection off makes the check interval meaningless.
2. **Nothing says what a setting will do.** "At most 10 rebuilds per check" against a fleet of 31 sources with 14 needing attention — the consequence is unknowable from the dialog, and the dry-run that could answer it lives behind a separate button.
3. **The unit and default handling is ambiguous.** Units flip between minutes and seconds for adjacent concepts. `0` sits in a field whose helper text says "leave blank to use the system default (15 minutes)", so the current state is genuinely unreadable.

Underneath that, two pieces of already-built work are unreachable:

- `data_source_state.last_finding_{at,reason,evidence}` was added by `20260815_1200_recon_ops` **specifically** to stamp live detector evidence on every detection including holds. No API field exposes it and no component reads it. `reconcileEvidenceRows()` already renders before → after count pairs. The "why is this drifting" answer is three schema fields away.
- `probe_enabled` / `probe_interval_secs` (shipped 2026-08-17) have a global control but no per-source control, so the override is unreachable from the UI.

Framing decisions (challenged and settled):

- **One vocabulary, everywhere.** ① Detect / ② Check / ③ Act is used by the panel, the drawer, the row chips and the run history. This is the highest-leverage change; every number then has an obvious home.
- **The panel explains to everyone, edits for admins.** Read-only for non-admins rather than hidden — the explanation is the valuable half.
- **Absence is the healthy signal.** Rows say nothing when automation is fine, so the exceptions read.
- **No invented numbers.** The budget denominator ("7 of 60 this hour") is deliberately NOT shipped — see §5.

## 1. The vocabulary

| Stage | What it does | Cost | Cadence | Governed by |
|---|---|---|---|---|
| **① Detect** | reads FalkorDB's label/relation counters — "has anything moved?" | ~1 ms, constant in graph size | 60s | `probeEnabled`, `probeIntervalSecs` |
| **② Check** | evaluates the verdict from stored counts — "is the overlay wrong, and may we act?" | pure SQL, no graph call | 5 min | `reconcileEnabled`, `reconcileCheckIntervalSecs`, `reconcileDetectors` |
| **③ Act** | rebuilds the overlay | minutes, heavy | cooldown 15 min, ≤10 per check | `rebuildMinIntervalSecs`, `reconcileMaxActionsPerRun` |

Every label in the UI derives from this table. Where a stage is off, downstream stages say so rather than silently degrading.

## 2. The Automation panel

New `AutomationPanel.tsx`, rendered by `Freshness/index.tsx` directly under `OverlayIntegrity`. Open state in the URL (`?automation=open`), consistent with every other facet on this page.

**Collapsed** — one line, always truthful:
`Automation · detect 60s → check 5m → act ≤10/check · 14 qualify now`

**Expanded** — three stage cards, left to right, with flow connectors. Wraps to a single column below `md`.

Each card carries:
- **Duration control** — segmented presets (`30s · 1m · 5m · 15m · 1h · Custom`) rather than a bare number plus a unit word. Removes the minutes/seconds flip and the mental math. New shared `DurationField.tsx`; the presets differ per stage, the component does not.
- **Explicit default state** — `Using default (60s)` vs `Overridden: 30s` with a Reset control. "Blank means default" is replaced by a state you can see and select, which is what fixes the `0`-in-a-blank-field ambiguity. Clearing still sends `null`, so the resolution chain (override → global → env) is unchanged.
- **Two sentences**: what it means, and what it costs.
- **A live stat**: ① `31 watched` · ② `14 qualify now` · ③ `7 rebuilt this hour`.
- **State dot**: on / off / default.

**Impact line**, under the cards, from the real dry-run (`POST /freshness/reconcile-now {dryRun:true}` — already exists and already returns `findings[]`):
`14 sources qualify now · at ≤10 per check they clear in 2 checks (~10 min)`
with `Preview exactly ▸` opening the existing `ReconcilePreviewDialog`. Debounced; never fires on keystroke.

**Contradiction warnings**, inline, derived not hardcoded:
- detect off + check on → *"Detection is off, so checks only see data as fresh as the 15-minute statistics refresh."*
- check on + every detector unchecked → *"Nothing is acted on. Problems are still detected and shown in the table."*
- act cap 0 → *"Detect and report only — no rebuilds will be queued."*

**Permissions:** `system:admin` edits; everyone with ingestion read sees the panel and its explanations, controls disabled with a reason.

`CadenceSettingsDialog.tsx` is deleted. Its two entry points (the header `Cadence` button and the "every N minutes" link in `IntegrityPulse`) scroll to and expand the panel instead.

## 3. Row signal — quiet by default

Two separate problems, discovered while mapping the code:

**3a. The `RECONCILE CHECK` pill is not an automation chip.** It is the Last activity column's `in_step` kind — "the last thing that happened here was a check, and it found the rollups in sync". The content is right; the *weight* is wrong. `ACTIVITY_PILL.in_step` renders a bordered, uppercase, sky-toned pill — visually identical in structure to `failed` (red) and `queued` (amber). On a healthy fleet that is a wall of shouting pills saying "nothing happened". Fix: `in_step` degrades to quiet muted text (no border, no uppercase, no fill) — `✓ checked 1m ago`. Every other kind keeps its pill. Nothing is removed; the routine outcome stops competing with the exceptional ones.

**3b. There is no automation-state signal at all.** Add one, rendered only for a notable state:

| State | Chip | Meaning |
|---|---|---|
| `drifting` / `overlayMissing` / `neverBuilt` | amber | a finding is open |
| held by cooldown | slate | real finding, waiting out the rebuild window |
| `suspended` | red | breaker tripped, needs a person |
| `paused` | slate | snoozed until a time |
| automation off | slate outline | deliberate opt-out |

Healthy watched sources render nothing. Each chip is a filter: clicking sets the corresponding facet, matching how the stat band already behaves.

## 4. The drawer — per-source

`FreshnessDrawer`'s two existing sections (`RebuildCadenceSection`, `ReconciliationSection`) are restructured into the ①②③ stages, sharing `DurationField` and the same default-vs-override treatment. Three additions:

**4a. ① Detect override** — `probeEnabled` / `probeIntervalSecs`, the control that is currently missing entirely.

**4b. Why it is drifting** — when `driftState` is a finding state, render `lastFindingEvidence` through the existing `reconcileEvidenceRows()`:
`nodes 500,500 → 500,340 · AGGREGATED 50,000 → 0`
plus `lastFindingReason` (already mapped by `REASON_LABEL`) and `lastFindingAt`. Unchanged pairs are already dropped by that helper.

**4c. Snooze** — `Pause automation for [24h ▾]` (1h / 8h / 24h / 7d), showing the expiry and a one-click Resume. This is the missing middle between "leave it on and let it churn" and "turn it off forever and forget".

## 5. Backend

**5a. Expose the stored finding (no migration).** Add to `FreshnessDoc`: `lastFindingAt`, `lastFindingReason`, `lastFindingEvidence`. The columns exist and are written on every evaluation; only the schema and the assembler need them.

**5b. Expose the probe settings.** `FreshnessDoc` gains `probeEnabled`, `probeIntervalSecs`, `resolvedProbeIntervalSecs`, `probeIntervalSource` — mirroring exactly how `reconcile_*` and `rebuild_*` already report override / resolved / source. `FreshnessSettingsRequest` accepts `probeEnabled` and `probeIntervalSecs` (partial-update semantics; explicit `null` clears), routed through a `set_source_probe_settings` twin of `set_source_reconcile_settings`.

**5c. Snooze.** New nullable `data_source_state.paused_until` (Text, ISO) via an idempotent inspector-guarded migration + the `db_init` additive mirror. `reconcile.py` gains a `paused` entry in `SKIP_REASONS` and a `_hold` clause reading a new `Observation.paused_until`; the sweeper populates it in `_observe`. It is a **hold**, not a guard — the finding and its evidence are still recorded and shown, we simply refuse to act. `PATCH /freshness-settings` accepts `pausedUntil`.

**5d. Rebuilt-this-hour.** `assemble_reconcile_overview` gains `rebuiltLastHour` — a count of `aggregation_jobs` with `trigger_source='reconcile'` created in the last hour. Numerator only.

> **Deliberately NOT built: the budget denominator.** The approved mockup showed *"7 of 60 rebuilds used this hour"*. The `60` is the global rebuild budget from Phase 2 of the reconciliation plan, which is not implemented. Shipping the denominator now would render a limit that does not exist and is not enforced. The panel shows `7 rebuilt this hour`; the denominator lands with Phase 2.

## 6. Files

| Area | Files |
|---|---|
| New | `Freshness/AutomationPanel.tsx`, `Freshness/StageCard.tsx`, `Freshness/automationCopy.ts`, `ui/DurationField.tsx` |
| Deleted | `Freshness/CadenceSettingsDialog.tsx` (+ its tests, folded into the panel's) |
| Reworked | `Freshness/index.tsx` (panel placement + URL state), `FreshnessRow.tsx` (quiet chip), `FreshnessDrawer.tsx` (stages, evidence, snooze), `IntegrityPulse.tsx` / `OverlayIntegrity.tsx` (entry points) |
| Backend | `aggregation/schemas.py`, `aggregation/service.py`, `aggregation/reconcile.py`, `aggregation/reconcile_sweeper.py`, one alembic revision (id ≤32 chars), `aggregation/db_init.py` |
| Frontend service | `services/freshnessService.ts` (new doc fields + settings fields) |

## 7. Testing

- **Unit** — `DurationField` preset/custom/reset round-trip; `automationCopy` contradiction rules; `reconcileEvidenceRows` against a real `last_finding_evidence` payload; the `paused` hold (finding still recorded, no action taken); probe-settings resolution chain (override → global → env, `False` is a real value).
- **Component** — panel renders read-only without `system:admin`; a save round-trips the effective env defaults without clobbering the other toggles (the existing `CadenceControls` regression, carried over — every toggle added to this surface inherits that hazard); row chip is absent for a healthy source and present-and-filtering for each notable state.
- **E2E** — set a per-source detect override in the drawer, confirm it survives a reload and that `probeIntervalSource` reports `override`; snooze a source and confirm the sweep records the finding but queues no job.
- **Regression** — `Freshness.test.tsx`, `IntegrityPulse.test.tsx`, `OverlayIntegrity.test.tsx` stay green. `CadenceControls.test.tsx` splits: its `cadence` block (the drawer's per-source editor) stays as-is; its `admin cadence popover` block moves to the panel's suite, keeping both assertions verbatim — including the env-default round-trip, which is the regression every new toggle on this surface inherits. Known pre-existing failure: `ReconcilePreviewDialog.test.tsx` (1, fails on a clean tree). Frontend tsc baseline is 61 errors — must not grow.

## 8. Out of scope

Phase 2 of the reconciliation plan (ingress API, per-principal rate limits, rebuild budgets, `force` lockdown, the two sweeper accounting fixes). This design assumes none of it and adds no dependency on it, other than the deferred budget denominator in §5d.
