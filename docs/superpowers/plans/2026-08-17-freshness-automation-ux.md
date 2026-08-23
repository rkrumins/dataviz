# Freshness Automation UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make automatic reconciliation understandable and manageable from the Freshness tab by naming one pipeline — ① Detect → ② Check → ③ Act — and using that vocabulary in the panel, the drawer, the rows and the history.

**Architecture:** Backend first: expose three already-stored-but-unreachable finding columns and the per-source probe settings, then add a `paused_until` hold. Frontend second: a shared `DurationField`, an in-page `AutomationPanel` that replaces the modal, quiet rows, and a restructured drawer. Each task is independently shippable and leaves the app working.

**Tech Stack:** FastAPI + SQLAlchemy (async) + Alembic; React 18 + TypeScript + TanStack Query + Tailwind; pytest + vitest/@testing-library.

**Spec:** `docs/superpowers/specs/2026-08-17-freshness-automation-ux-design.md`

## Global Constraints

- **Alembic revision ids must be ≤32 characters.** CI-gated by `backend/tests/test_alembic_revision_lengths.py`. Longer ids make a brand-new environment unbuildable while migrated ones keep working.
- **Every migration must be idempotent.** `0001_baseline` runs `create_all()` against the current ORM, so a bare `op.add_column` breaks a fresh environment. Use inspector guards, and mirror the column in `backend/app/services/aggregation/db_init.py`.
- **Partial-PATCH semantics.** `FreshnessSettingsRequest` treats an explicit `null` as "clear this override". Handlers MUST apply only keys present in `model_fields_set`; treating an absent field as null makes a partial PATCH impossible.
- **`None` means "unset, fall through"; `False` and `0` are real values.** Every resolution chain is override → persisted global → env. Never test truthiness.
- **All API responses need an explicit `response_model`.** Missing it causes camelCase/snake_case mismatch — fields silently arrive `undefined` on the client.
- **Run backend tests with** `.venv/bin/python -m pytest <file> -q -p no:randomly` from the repo root.
- **Run frontend tests with** `npx vitest run <path>` from `frontend/`.
- **Frontend tsc baseline is 61 errors.** `npx tsc --noEmit -p tsconfig.json` from `frontend/` must not exceed it.
- **Known pre-existing failures — do not try to fix:** `ReconcilePreviewDialog.test.tsx` (1 test), `test_falkordb_provider.py` (4), `test_aggregation_service_isolation.py::test_the_key_ring_still_refuses_when_it_is_actually_needed` (caused by an uncommitted `.env.dev`, not by code).
- **Copy rule:** operator-facing strings use plain language, never internal identifiers. "Rollups went missing", not `overlay_missing`.

---

### Task 1: Expose the stored finding on FreshnessDoc

The sweep has stamped `last_finding_at` / `last_finding_reason` / `last_finding_evidence` on every evaluation since migration `20260815_1200_recon_ops`, including holds. No API field exposes them, so the "why is this drifting" answer is thrown away at the boundary. No migration needed.

**Files:**
- Modify: `backend/app/services/aggregation/schemas.py` (class `FreshnessDoc`, near `blocked_reason`)
- Modify: `backend/app/services/aggregation/service.py` (`_state_map`, `_freshness_row_kwargs`)
- Test: `backend/tests/test_freshness_endpoints.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `FreshnessDoc.last_finding_at` → `lastFindingAt: str | None`, `.last_finding_reason` → `lastFindingReason: str | None`, `.last_finding_evidence` → `lastFindingEvidence: dict | None` (parsed from the stored JSON, `None` when absent or unparseable). `_state_map` dict gains keys `last_finding_at`, `last_finding_reason`, `last_finding_evidence`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_freshness_endpoints.py`:

```python
@pytest.mark.asyncio
async def test_source_doc_carries_the_live_finding_evidence(session_factory):
    """The sweep stamps why a source is drifting on every evaluation; the
    doc must carry it, or the drawer has nothing to explain the verdict with."""
    import json
    from backend.app.services.aggregation.models import (
        AggregationDataSourceStateORM,
    )
    from backend.app.services.aggregation.service import _state_map

    evidence = {
        "rawNodeCountBefore": 500500, "rawNodeCountAfter": 500340,
        "expectedAggregatedEdges": 50000, "observedAggregatedEdges": 0,
    }
    async with session_factory() as s:
        s.add(AggregationDataSourceStateORM(
            data_source_id="ds_1", workspace_id="ws_1",
            aggregation_status="ready",
            drift_state="drifting",
            last_finding_at="2026-08-17T09:00:00+00:00",
            last_finding_reason="overlay_missing",
            last_finding_evidence=json.dumps(evidence),
        ))
        await s.commit()

    async with session_factory() as s:
        state = (await _state_map(s, ["ds_1"]))["ds_1"]

    assert state["last_finding_at"] == "2026-08-17T09:00:00+00:00"
    assert state["last_finding_reason"] == "overlay_missing"
    assert state["last_finding_evidence"] == evidence


@pytest.mark.asyncio
async def test_unparseable_finding_evidence_degrades_to_none(session_factory):
    """A malformed evidence blob must not take out the whole freshness read."""
    from backend.app.services.aggregation.models import (
        AggregationDataSourceStateORM,
    )
    from backend.app.services.aggregation.service import _state_map

    async with session_factory() as s:
        s.add(AggregationDataSourceStateORM(
            data_source_id="ds_1", workspace_id="ws_1",
            aggregation_status="ready",
            last_finding_evidence="{not json",
        ))
        await s.commit()

    async with session_factory() as s:
        state = (await _state_map(s, ["ds_1"]))["ds_1"]

    assert state["last_finding_evidence"] is None
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_freshness_endpoints.py -q -p no:randomly -k "finding"`
Expected: FAIL with `KeyError: 'last_finding_at'`.

- [ ] **Step 3: Add the columns to `_state_map`**

In `backend/app/services/aggregation/service.py`, extend the `select(...)` in `_state_map` with three columns and the returned dict with three keys. The evidence is stored as a JSON string and must be parsed defensively:

```python
            select(
                S.data_source_id,
                S.rebuild_min_interval_secs,
                S.reconcile_enabled,
                S.reconcile_check_interval_secs,
                S.drift_state,
                S.last_reconcile_checked_at,
                S.last_reconciled_at,
                S.last_reconcile_reason,
                S.last_reconcile_mode,
                S.last_finding_at,
                S.last_finding_reason,
                S.last_finding_evidence,
            ).where(S.data_source_id.in_(ds_ids))
```

and in the returned comprehension:

```python
            "last_finding_at": r[9],
            "last_finding_reason": r[10],
            # Stored as a JSON string. A malformed blob degrades to None
            # rather than failing the whole freshness read.
            "last_finding_evidence": _safe_json(r[11]),
```

Add the helper next to `_state_map`:

```python
def _safe_json(raw: Optional[str]) -> Optional[dict]:
    """Parse a stored JSON column; None on absent or malformed content."""
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_freshness_endpoints.py -q -p no:randomly -k "finding"`
Expected: PASS (2 tests).

- [ ] **Step 5: Add the fields to `FreshnessDoc`**

In `backend/app/services/aggregation/schemas.py`, immediately after `blocked_reason`:

```python
    # The live detector finding, stamped on EVERY evaluation including holds
    # (migration 20260815_1200_recon_ops). Distinct from last_reconcile_*,
    # which records the last rebuild we queued: a source can have an open
    # finding it is deliberately not acting on, and the drawer must be able
    # to explain that rather than showing a bare verdict word.
    last_finding_at: Optional[str] = Field(None, alias="lastFindingAt")
    last_finding_reason: Optional[str] = Field(None, alias="lastFindingReason")
    last_finding_evidence: Optional[dict] = Field(
        None, alias="lastFindingEvidence",
    )
```

- [ ] **Step 6: Populate them in `_freshness_row_kwargs`**

In `backend/app/services/aggregation/service.py`, find `_freshness_row_kwargs` (it already reads `state_row.get("drift_state")` around line 775) and add to the returned kwargs:

```python
        last_finding_at=state_row.get("last_finding_at"),
        last_finding_reason=state_row.get("last_finding_reason"),
        last_finding_evidence=state_row.get("last_finding_evidence"),
```

- [ ] **Step 7: Run the full freshness suite**

Run: `.venv/bin/python -m pytest backend/tests/test_freshness_endpoints.py backend/tests/test_reconcile_api.py -q -p no:randomly`
Expected: PASS, no failures.

- [ ] **Step 8: Commit**

```bash
git add backend/app/services/aggregation/schemas.py backend/app/services/aggregation/service.py backend/tests/test_freshness_endpoints.py
git commit -m "feat(freshness): carry the live finding evidence into the source doc

The sweep has stamped last_finding_at/reason/evidence on every evaluation
since 20260815_1200_recon_ops, including holds, so that a source could
explain WHY it is drifting rather than only that it is. No field exposed
them, so the answer was discarded at the API boundary."
```

---

### Task 2: Expose the per-source probe settings

`probe_enabled` / `probe_interval_secs` exist on the state row and have a global control, but nothing surfaces or accepts the per-source override — so it is unreachable from the UI. This also fixes an inconsistency: the per-source check interval still enforces `ge=300` while the global one was lowered to `ge=30`.

**Files:**
- Modify: `backend/app/services/aggregation/schemas.py` (`FreshnessDoc`, `FreshnessSettingsRequest`, `FreshnessSettingsResponse`)
- Modify: `backend/app/services/aggregation/service.py` (`_state_map`, `_freshness_row_kwargs`, new `set_source_probe_settings`)
- Modify: `backend/app/api/v1/endpoints/freshness.py` (`patch_freshness_settings`)
- Test: `backend/tests/test_freshness_endpoints.py`

**Interfaces:**
- Consumes: `_state_map` from Task 1.
- Produces: `AggregationService.set_source_probe_settings(ds_id, session, *, enabled=_UNSET, interval_secs=_UNSET) -> dict` returning `{"probe_enabled": bool | None, "probe_interval_secs": int | None}`. `FreshnessDoc` gains `probeEnabled`, `probeIntervalSecs`, `resolvedProbeIntervalSecs`, `probeIntervalSource` (`"override" | "global" | "env"`). `FreshnessSettingsRequest` accepts `probeEnabled`, `probeIntervalSecs`.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/test_freshness_endpoints.py`:

```python
@pytest.mark.asyncio
async def test_probe_settings_round_trip_and_report_their_source(session_factory):
    """A per-source detect override must be settable, readable, and must say
    where the effective value came from — otherwise the drawer cannot show
    "Using default" versus "Overridden"."""
    from backend.app.services.aggregation.models import (
        AggregationDataSourceStateORM,
    )
    from backend.app.services.aggregation.service import (
        AggregationService, _state_map, resolve_probe_interval,
    )

    async with session_factory() as s:
        s.add(AggregationDataSourceStateORM(
            data_source_id="ds_1", workspace_id="ws_1",
            aggregation_status="ready",
        ))
        await s.commit()

    svc = AggregationService.__new__(AggregationService)
    async with session_factory() as s:
        stored = await svc.set_source_probe_settings(
            "ds_1", s, enabled=False, interval_secs=30,
        )
    assert stored == {"probe_enabled": False, "probe_interval_secs": 30}

    async with session_factory() as s:
        state = (await _state_map(s, ["ds_1"]))["ds_1"]
    assert state["probe_enabled"] is False
    assert state["probe_interval_secs"] == 30

    # Resolution: override wins, then global, then env.
    assert resolve_probe_interval(30, 120) == 30
    assert resolve_probe_interval(None, 120) == 120


@pytest.mark.asyncio
async def test_clearing_a_probe_override_falls_back(session_factory):
    """Explicit None clears the override; False must NOT be read as unset."""
    from backend.app.services.aggregation.models import (
        AggregationDataSourceStateORM,
    )
    from backend.app.services.aggregation.service import (
        AggregationService, _state_map,
    )

    async with session_factory() as s:
        s.add(AggregationDataSourceStateORM(
            data_source_id="ds_1", workspace_id="ws_1",
            aggregation_status="ready",
            probe_enabled=False, probe_interval_secs=30,
        ))
        await s.commit()

    svc = AggregationService.__new__(AggregationService)
    async with session_factory() as s:
        await svc.set_source_probe_settings("ds_1", s, interval_secs=None)

    async with session_factory() as s:
        state = (await _state_map(s, ["ds_1"]))["ds_1"]
    assert state["probe_interval_secs"] is None
    # Untouched key keeps its value — partial update, not a wipe.
    assert state["probe_enabled"] is False
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/python -m pytest backend/tests/test_freshness_endpoints.py -q -p no:randomly -k "probe"`
Expected: FAIL with `AttributeError: 'AggregationService' object has no attribute 'set_source_probe_settings'`.

- [ ] **Step 3: Add the setter**

In `backend/app/services/aggregation/service.py`, directly after `set_source_reconcile_settings`:

```python
    async def set_source_probe_settings(
        self, ds_id: str, session: AsyncSession, *,
        enabled: Any = _UNSET, interval_secs: Any = _UNSET,
    ) -> dict:
        """Set or clear the per-source drift-probe overrides.

        UPSERTS for the same reason ``set_source_reconcile_settings`` does: a
        never-aggregated source has no state row, and that is exactly the
        source an operator may want to exclude from probing.

        Only fields explicitly passed are written. ``None`` clears an
        override; ``False`` is a real value and is stored as one.
        """
        from .models import AggregationDataSourceStateORM

        state = await session.get(AggregationDataSourceStateORM, ds_id)
        if state is None:
            from backend.app.db.models import WorkspaceDataSourceORM

            ds = await session.get(WorkspaceDataSourceORM, ds_id)
            if ds is None or ds.deleted_at is not None:
                raise NotFoundError(f"Data source {ds_id} not found")
            state = AggregationDataSourceStateORM(
                data_source_id=ds_id,
                workspace_id=ds.workspace_id,
                aggregation_status="none",
            )
            session.add(state)

        if enabled is not self._UNSET:
            state.probe_enabled = enabled
        if interval_secs is not self._UNSET:
            state.probe_interval_secs = interval_secs
        await session.commit()
        logger.info(
            "Probe settings for data source %s: enabled=%s interval=%s",
            ds_id, state.probe_enabled, state.probe_interval_secs,
        )
        return {
            "probe_enabled": state.probe_enabled,
            "probe_interval_secs": state.probe_interval_secs,
        }
```

- [ ] **Step 4: Add the columns to `_state_map`**

Extend the `select(...)` with `S.probe_enabled, S.probe_interval_secs` and the returned dict with `"probe_enabled": r[12], "probe_interval_secs": r[13]`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_freshness_endpoints.py -q -p no:randomly -k "probe"`
Expected: PASS (2 tests).

- [ ] **Step 6: Add the doc fields**

In `schemas.py`, after the `reconcile_interval_*` fields on `FreshnessDoc`:

```python
    # ① Detect — the per-source probe override, its resolved value, and where
    # that value came from. Mirrors the reconcile_*/rebuild_* triples exactly
    # so the drawer can render "Using default" vs "Overridden" uniformly.
    probe_enabled: Optional[bool] = Field(None, alias="probeEnabled")
    probe_interval_secs: Optional[int] = Field(None, alias="probeIntervalSecs")
    resolved_probe_interval_secs: Optional[int] = Field(
        None, alias="resolvedProbeIntervalSecs",
    )
    probe_interval_source: Optional[str] = Field(
        None, alias="probeIntervalSource",
    )
```

- [ ] **Step 7: Populate them in `assemble_source_freshness`**

Next to the existing `recon_override` / `recon_interval` / `recon_source` derivation (around line 2241), add the probe triple and pass it into the `FreshnessDoc(...)` call:

```python
        probe_override = state_row.get("probe_interval_secs")
        probe_interval = resolve_probe_interval(
            probe_override, cadence.probe_interval_secs,
        )
        probe_source = (
            "override" if probe_override is not None
            else "global" if cadence.probe_interval_secs is not None
            else "env"
        )
```

```python
            probe_enabled=resolve_probe_enabled(
                state_row.get("probe_enabled"), cadence.probe_enabled,
            ),
            probe_interval_secs=probe_override,
            resolved_probe_interval_secs=probe_interval,
            probe_interval_source=probe_source,
```

- [ ] **Step 8: Accept the fields in the PATCH**

In `schemas.py`, add to `FreshnessSettingsRequest` — and lower the check-interval floor to match the global one:

```python
    reconcile_check_interval_secs: Optional[int] = Field(
        None, alias="reconcileCheckIntervalSecs", ge=30, le=86400,
        description="How often this source is checked for drift. Null "
                    "inherits the global cadence.",
    )
    probe_enabled: Optional[bool] = Field(
        None, alias="probeEnabled",
        description="Per-source change-detection flag. Null inherits the "
                    "global setting.",
    )
    probe_interval_secs: Optional[int] = Field(
        None, alias="probeIntervalSecs", ge=15, le=86400,
        description="How often this source's counts are re-read. Null "
                    "inherits the global cadence.",
    )
```

Add the matching echo fields to `FreshnessSettingsResponse`:

```python
    probe_enabled: Optional[bool] = Field(None, alias="probeEnabled")
    probe_interval_secs: Optional[int] = Field(None, alias="probeIntervalSecs")
```

- [ ] **Step 9: Route them in the handler**

In `backend/app/api/v1/endpoints/freshness.py`, inside `patch_freshness_settings`, after the existing `recon = {}` block — note this reads `sent`, so an absent field is never written:

```python
        probe = {}
        if {"probe_enabled", "probe_interval_secs"} & sent:
            kwargs = {}
            if "probe_enabled" in sent:
                kwargs["enabled"] = body.probe_enabled
            if "probe_interval_secs" in sent:
                kwargs["interval_secs"] = body.probe_interval_secs
            probe = await svc.set_source_probe_settings(
                ds_id, session, **kwargs,
            )
```

and extend the returned `FreshnessSettingsResponse(...)`:

```python
        probe_enabled=probe.get("probe_enabled"),
        probe_interval_secs=probe.get("probe_interval_secs"),
```

- [ ] **Step 10: Run the suites**

Run: `.venv/bin/python -m pytest backend/tests/test_freshness_endpoints.py backend/tests/test_reconcile_api.py backend/tests/test_aggregation_settings.py -q -p no:randomly`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add backend/app/services/aggregation/schemas.py backend/app/services/aggregation/service.py backend/app/api/v1/endpoints/freshness.py backend/tests/test_freshness_endpoints.py
git commit -m "feat(freshness): make the per-source detect override reachable

probe_enabled/probe_interval_secs existed on the state row with a global
control but no per-source surface, so the override could not be set at all.
Also lowers the per-source check floor from 300s to 30s, which the global
policy already allows — the two disagreeing meant a cadence you could set
globally was rejected per source."
```

---

### Task 3: Snooze — pause automation without turning it off

The only way to stop a known-broken source from churning today is turning auto-reconcile off permanently, which operators then forget to undo. `paused_until` is a **hold**, not a guard: the finding and its evidence are still recorded and shown, we simply refuse to act. A guard would suppress the verdict and make a paused source look healthy.

**Files:**
- Create: `backend/alembic/versions/20260817_1400_recon_pause.py`
- Modify: `backend/app/services/aggregation/models.py`, `db_init.py`, `reconcile.py`, `reconcile_sweeper.py`, `schemas.py`, `service.py`, `backend/app/api/v1/endpoints/freshness.py`
- Test: `backend/tests/test_reconcile_detectors.py`, `backend/tests/test_reconcile_sweeper.py`

**Interfaces:**
- Consumes: `set_source_probe_settings` pattern from Task 2.
- Produces: `Observation.paused_until: Optional[str]`; `SKIP_REASONS` gains `"paused"`; `FreshnessDoc.paused_until` → `pausedUntil`; `FreshnessSettingsRequest.paused_until` → `pausedUntil`; `AggregationService.set_source_pause(ds_id, session, *, paused_until) -> dict` returning `{"paused_until": str | None}`.

- [ ] **Step 1: Write the failing detector test**

Add to `backend/tests/test_reconcile_detectors.py`:

```python
def test_paused_holds_the_action_but_keeps_the_finding():
    """A paused source must still report WHY it is drifting. Suppressing the
    verdict would make a snoozed source look healthy — the same class of bug
    as the stale-stats guard."""
    obs = Observation(
        data_source_id="ds_1",
        ontology_id="bp_1",
        has_stats=True,
        stats_age_secs=10,
        aggregation_status="ready",
        expected_aggregated=500,
        observed_aggregated=0,
        has_completed_job=True,
        paused_until="2999-01-01T00:00:00+00:00",
    )
    verdict = evaluate(obs, Policy())

    assert verdict.reason == "overlay_missing"   # still detected
    assert verdict.skip == "paused"              # but not acted on
    assert verdict.should_act is False
    assert verdict.drift_state == "overlayMissing"
    assert verdict.evidence, "evidence must survive the hold"


def test_an_expired_pause_acts_again():
    obs = Observation(
        data_source_id="ds_1",
        ontology_id="bp_1",
        has_stats=True,
        stats_age_secs=10,
        aggregation_status="ready",
        expected_aggregated=500,
        observed_aggregated=0,
        has_completed_job=True,
        paused_until="2000-01-01T00:00:00+00:00",
    )
    verdict = evaluate(obs, Policy())
    assert verdict.should_act is True
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_reconcile_detectors.py -q -p no:randomly -k "pause"`
Expected: FAIL — `Observation.__init__() got an unexpected keyword argument 'paused_until'`.

- [ ] **Step 3: Add the hold to the pure detector layer**

In `backend/app/services/aggregation/reconcile.py`:

Add to `SKIP_REASONS`, after `"cooldown"`:

```python
    "paused",             # snoozed by an operator until a time
```

Add to `_HOLD_SKIPS`:

```python
_HOLD_SKIPS: Tuple[str, ...] = (
    "cooldown", "failed_backoff", "disabled", "suspended", "paused",
)
```

Add the field to `Observation`, next to `in_cooldown`:

```python
    # Operator snooze. ISO-8601, or None. A HOLD, never a guard: a paused
    # source is still evaluated and still reports its finding, so the cockpit
    # can show what is wrong with something it has been told to leave alone.
    paused_until: Optional[str] = None
```

Add to `_hold`, before the cooldown clause so the more deliberate reason wins:

```python
def _hold(obs: Observation, policy: Policy) -> Optional[str]:
    if _pause_active(obs.paused_until):
        return "paused"
    if obs.in_cooldown:
        return "cooldown"
    ...
```

and the helper, near `_idle_state`:

```python
def _pause_active(paused_until: Optional[str]) -> bool:
    """True while a snooze is still in force. An unparseable stamp is treated
    as expired: a corrupt value must not pause a source forever."""
    if not paused_until:
        return False
    from datetime import datetime, timezone
    try:
        until = datetime.fromisoformat(paused_until)
    except (TypeError, ValueError):
        return False
    if until.tzinfo is None:
        until = until.replace(tzinfo=timezone.utc)
    return until > datetime.now(timezone.utc)
```

- [ ] **Step 4: Run to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_reconcile_detectors.py -q -p no:randomly -k "pause"`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the migration**

Create `backend/alembic/versions/20260817_1400_recon_pause.py`. The revision id is 25 characters:

```python
"""Operator snooze for automatic reconciliation.

Revision ID: 20260817_1400_recon_pause
Revises: 20260817_1200_drift_probe
Create Date: 2026-08-17 14:00

Turning automation off was the only way to stop a known-broken source from
churning, and it is never turned back on. ``paused_until`` is the missing
middle: a time-boxed hold that expires by itself.

Inspector-guarded — 0001_baseline create_all()s the CURRENT ORM, so a bare
add_column here would make a brand-new environment unbuildable while every
migrated database kept working.
"""
from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "20260817_1400_recon_pause"
down_revision: Union[str, None] = "20260817_1200_drift_probe"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_SCHEMA = "aggregation"
_STATE = "data_source_state"


def _columns(inspector, table, *, schema=None) -> set:
    return {c["name"] for c in inspector.get_columns(table, schema=schema)}


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if "paused_until" not in _columns(inspector, _STATE, schema=_SCHEMA):
        op.add_column(
            _STATE, sa.Column("paused_until", sa.Text(), nullable=True),
            schema=_SCHEMA,
        )


def downgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    if not inspector.has_table(_STATE, schema=_SCHEMA):
        return
    if "paused_until" in _columns(inspector, _STATE, schema=_SCHEMA):
        op.drop_column(_STATE, "paused_until", schema=_SCHEMA)
```

- [ ] **Step 6: Add the ORM column and the db_init mirror**

In `backend/app/services/aggregation/models.py`, after `probe_interval_secs`:

```python
    # Operator snooze (ISO-8601). Automation still evaluates and still records
    # its finding while this is in the future; it just does not act.
    paused_until = Column(Text, nullable=True)
```

In `backend/app/services/aggregation/db_init.py`, in the `_additive_migrations` tuple after the probe columns:

```python
                f"ALTER TABLE {SCHEMA_NAME}.data_source_state "
                "ADD COLUMN IF NOT EXISTS paused_until TEXT NULL",
```

- [ ] **Step 7: Verify the revision id and chain**

Run: `.venv/bin/python -m pytest backend/tests/test_alembic_revision_lengths.py -q --noconftest`
Expected: PASS.

Run: `grep -rl 'down_revision.*20260817_1200_drift_probe' backend/alembic/versions/`
Expected: exactly one file — the new migration (more than one means the chain has branched).

- [ ] **Step 8: Write the sweeper wiring test**

Add to `backend/tests/test_reconcile_sweeper.py`:

```python
@pytest.mark.asyncio
async def test_a_paused_source_records_its_finding_but_queues_nothing(
    session_factory,
):
    """The whole point of a hold: the cockpit still knows what is wrong."""
    await _seed(session_factory, edge_counts={"FLOWS_TO": 200})
    async with session_factory() as s:
        state = await s.get(AggregationDataSourceStateORM, "ds_1")
        state.paused_until = "2999-01-01T00:00:00+00:00"
        await s.commit()

    svc = _FakeService()
    result = await ReconciliationSweeper(session_factory, lambda: svc).sweep()

    assert result.by_skip.get("paused") == 1
    assert svc.signals == [], "a paused source must not be dispatched"
    state = await _state(session_factory)
    assert state.last_finding_reason == "overlay_missing"
```

- [ ] **Step 9: Run to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_reconcile_sweeper.py -q -p no:randomly -k "paused"`
Expected: FAIL — `by_skip` has no `paused` key.

- [ ] **Step 10: Wire it through the sweeper**

In `backend/app/services/aggregation/reconcile_sweeper.py`, add `S.paused_until` to the `_candidates` state selection is NOT needed (the ORM object is loaded whole). In `_observe`, where `Observation(...)` is constructed, add:

```python
            paused_until=c.get("paused_until"),
```

and in `_batch_context`, where the state fields are read into `out[...]`, add `paused_until=state.paused_until` alongside the other state-row fields.

- [ ] **Step 11: Run to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_reconcile_sweeper.py backend/tests/test_reconcile_detectors.py -q -p no:randomly`
Expected: PASS.

- [ ] **Step 12: Expose and accept `pausedUntil`**

`FreshnessDoc` in `schemas.py`:

```python
    paused_until: Optional[str] = Field(None, alias="pausedUntil")
```

`FreshnessSettingsRequest`:

```python
    paused_until: Optional[str] = Field(
        None, alias="pausedUntil", max_length=64,
        description="ISO-8601 instant until which automation is held for this "
                    "source. Null resumes immediately.",
    )
```

Add `"paused_until": r[14]` to `_state_map` (and `S.paused_until` to its select), `paused_until=state_row.get("paused_until")` to `_freshness_row_kwargs`, a `set_source_pause` twin of `set_source_probe_settings` in `service.py`, and the matching `sent`-guarded block in `patch_freshness_settings`.

- [ ] **Step 13: Run the full backend regression**

Run: `.venv/bin/python -m pytest backend/tests/test_reconcile_sweeper.py backend/tests/test_reconcile_detectors.py backend/tests/test_reconcile_api.py backend/tests/test_freshness_endpoints.py backend/tests/test_probe_scheduler.py -q -p no:randomly`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add backend/alembic/versions/20260817_1400_recon_pause.py backend/app/services/aggregation/ backend/app/api/v1/endpoints/freshness.py backend/tests/
git commit -m "feat(freshness): snooze automation for a source without turning it off

Turning auto-reconcile off was the only way to stop a known-broken source
churning, so operators turned it off and forgot. paused_until is a HOLD, not
a guard: the source is still evaluated and still reports its finding, we
just refuse to act — a guard would make a snoozed source look healthy."
```

---

### Task 4: `DurationField` — one control, no unit arithmetic

The dialog asks for minutes in two places and seconds in a third, for stages of one pipeline, and shows `0` in a field whose helper text says "leave blank for the default". This component removes both problems: presets in natural units, and "default" as a visible, selectable state.

**Files:**
- Create: `frontend/src/components/ui/DurationField.tsx`
- Test: `frontend/src/components/ui/DurationField.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export interface DurationFieldProps {
    value: number | null          // seconds; null = "use the default"
    onChange: (secs: number | null) => void
    presets: number[]             // seconds, rendered in natural units
    defaultSecs: number           // the effective default, shown when value is null
    label: string
    disabled?: boolean
    min?: number
    max?: number
}
export function DurationField(props: DurationFieldProps): JSX.Element
export function formatDuration(secs: number): string  // 30 -> "30s", 300 -> "5m", 3600 -> "1h"
```

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/ui/DurationField.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { DurationField, formatDuration } from './DurationField'

const PRESETS = [30, 60, 300, 900, 3600]

describe('formatDuration', () => {
    it('uses the largest natural unit', () => {
        expect(formatDuration(30)).toBe('30s')
        expect(formatDuration(60)).toBe('1m')
        expect(formatDuration(300)).toBe('5m')
        expect(formatDuration(3600)).toBe('1h')
        expect(formatDuration(5400)).toBe('90m')
    })
})

describe('DurationField', () => {
    it('shows the effective default when nothing is overridden', () => {
        render(
            <DurationField
                value={null} onChange={vi.fn()} presets={PRESETS}
                defaultSecs={60} label="Look for changes every"
            />,
        )
        expect(screen.getByText(/Using default \(1m\)/)).toBeInTheDocument()
    })

    it('says it is overridden, and offers a reset', async () => {
        const onChange = vi.fn()
        render(
            <DurationField
                value={30} onChange={onChange} presets={PRESETS}
                defaultSecs={60} label="Look for changes every"
            />,
        )
        expect(screen.getByText(/Overridden: 30s/)).toBeInTheDocument()

        await userEvent.click(screen.getByRole('button', { name: /reset to default/i }))
        expect(onChange).toHaveBeenCalledWith(null)
    })

    it('emits seconds when a preset is chosen', async () => {
        const onChange = vi.fn()
        render(
            <DurationField
                value={null} onChange={onChange} presets={PRESETS}
                defaultSecs={60} label="Look for changes every"
            />,
        )
        await userEvent.click(screen.getByRole('button', { name: '5m' }))
        expect(onChange).toHaveBeenCalledWith(300)
    })

    it('distinguishes an explicit 0 from the default', () => {
        // The exact ambiguity in the old dialog: 0 in a field whose helper
        // said "leave blank for the default".
        render(
            <DurationField
                value={0} onChange={vi.fn()} presets={PRESETS}
                defaultSecs={900} label="Minimum time between rebuilds"
            />,
        )
        expect(screen.getByText(/Overridden: 0s/)).toBeInTheDocument()
        expect(screen.queryByText(/Using default/)).not.toBeInTheDocument()
    })

    it('marks the active preset for assistive tech', () => {
        render(
            <DurationField
                value={300} onChange={vi.fn()} presets={PRESETS}
                defaultSecs={60} label="Check every"
            />,
        )
        expect(screen.getByRole('button', { name: '5m' })).toHaveAttribute('aria-pressed', 'true')
        expect(screen.getByRole('button', { name: '1m' })).toHaveAttribute('aria-pressed', 'false')
    })
})
```

- [ ] **Step 2: Run to verify it fails**

Run (from `frontend/`): `npx vitest run src/components/ui/DurationField.test.tsx`
Expected: FAIL — cannot resolve `./DurationField`.

- [ ] **Step 3: Implement the component**

Create `frontend/src/components/ui/DurationField.tsx`:

```tsx
/**
 * DurationField — a duration as presets in natural units, with "default" as a
 * state you can see and choose rather than an empty box.
 *
 * Two failures it exists to prevent, both from the cadence dialog it replaces:
 * adjacent stages of one pipeline asking for minutes, minutes and seconds, so
 * the operator does the unit arithmetic; and a literal 0 sitting in a field
 * whose helper text said "leave blank to use the default", which made the
 * current state genuinely unreadable. Null is the ONLY way to say "default",
 * so 0 is free to mean zero.
 */
import { RotateCcw } from 'lucide-react'

import { cn } from '@/lib/utils'

export interface DurationFieldProps {
    /** Seconds, or null meaning "inherit the default". */
    value: number | null
    onChange: (secs: number | null) => void
    /** Offered presets, in seconds. */
    presets: number[]
    /** The effective default, shown while `value` is null. */
    defaultSecs: number
    label: string
    disabled?: boolean
    min?: number
    max?: number
}

/** Largest natural unit, so 300 reads "5m" rather than "300s". */
export function formatDuration(secs: number): string {
    if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600}h`
    if (secs >= 60 && secs % 60 === 0) return `${secs / 60}m`
    return `${secs}s`
}

export function DurationField({
    value, onChange, presets, defaultSecs, label,
    disabled = false, min = 0, max = 86400,
}: DurationFieldProps) {
    const isDefault = value == null

    return (
        <div className="space-y-1.5">
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                {label}
            </label>

            <div className="flex flex-wrap items-center gap-1">
                {presets.map((p) => (
                    <button
                        key={p}
                        type="button"
                        disabled={disabled}
                        aria-pressed={value === p}
                        onClick={() => onChange(p)}
                        className={cn(
                            'h-7 px-2 rounded-lg text-xs font-semibold border transition-colors',
                            'disabled:opacity-50 disabled:cursor-not-allowed',
                            value === p
                                ? 'bg-indigo-600 text-white border-indigo-600'
                                : 'bg-canvas text-ink-secondary border-glass-border hover:border-indigo-400',
                        )}
                    >
                        {formatDuration(p)}
                    </button>
                ))}
                <input
                    type="number"
                    min={min}
                    max={max}
                    disabled={disabled}
                    aria-label={`${label} (custom, seconds)`}
                    value={value ?? ''}
                    placeholder="Custom"
                    onChange={(e) => {
                        const raw = e.target.value.trim()
                        onChange(raw === '' ? null : Number(raw))
                    }}
                    className="w-24 h-7 px-2 rounded-lg border border-glass-border bg-canvas text-xs text-ink disabled:opacity-50"
                />
            </div>

            <div className="flex items-center gap-2 text-[11px]">
                {isDefault ? (
                    <span className="text-ink-muted">
                        Using default ({formatDuration(defaultSecs)})
                    </span>
                ) : (
                    <>
                        <span className="text-ink-secondary font-medium">
                            Overridden: {formatDuration(value)}
                        </span>
                        <button
                            type="button"
                            disabled={disabled}
                            onClick={() => onChange(null)}
                            aria-label="Reset to default"
                            className="inline-flex items-center gap-1 text-indigo-600 dark:text-indigo-400 hover:underline disabled:opacity-50"
                        >
                            <RotateCcw className="w-3 h-3" /> Reset to default
                        </button>
                    </>
                )}
            </div>
        </div>
    )
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/ui/DurationField.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: `61` or fewer.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/ui/DurationField.tsx frontend/src/components/ui/DurationField.test.tsx
git commit -m "feat(ui): DurationField — presets in natural units, default as a state

Replaces number-plus-unit-word inputs that made the operator convert between
minutes and seconds across stages of one pipeline, and that could not
distinguish an explicit 0 from an unset field."
```

---

### Task 5: The Automation panel

**Files:**
- Create: `frontend/src/components/admin/Freshness/automationCopy.ts`, `StageCard.tsx`, `AutomationPanel.tsx`
- Create: `frontend/src/components/admin/Freshness/AutomationPanel.test.tsx`
- Modify: `frontend/src/components/admin/Freshness/index.tsx`

**Interfaces:**
- Consumes: `DurationField`, `formatDuration` (Task 4); `useReconciliation`, `useSetReconciliationPolicy`, `useReconcileNow` (existing, `useFreshness.ts`); `aggregationService.getAggregationSettings` / `putAggregationCadence` and the `AggregationCadence` type (existing).
- Produces: `automationWarnings(policy, cadence) -> {id: string, text: string}[]`; `<AutomationPanel open onToggle isAdmin summary />`.

- [ ] **Step 1: Write the failing copy test**

Create `frontend/src/components/admin/Freshness/AutomationPanel.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest'

import { automationWarnings } from './automationCopy'

describe('automationWarnings', () => {
    it('warns that checks are only as fresh as the slow refresh when detect is off', () => {
        const w = automationWarnings(
            { enabled: true, detectors: null },
            { probeEnabled: false },
        )
        expect(w.map(x => x.id)).toContain('detect-off')
        expect(w[0].text).toMatch(/only see data as fresh as/i)
    })

    it('warns when every detector is unchecked', () => {
        const w = automationWarnings(
            { enabled: true, detectors: [] },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).toContain('no-detectors')
    })

    it('treats an unset detector list as all-on, not none', () => {
        // null = "all enabled"; [] = "act on nothing". Never truthiness.
        const w = automationWarnings(
            { enabled: true, detectors: null },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).not.toContain('no-detectors')
    })

    it('warns when the action cap is zero', () => {
        const w = automationWarnings(
            { enabled: true, detectors: null, maxActionsPerRun: 0 },
            { probeEnabled: true },
        )
        expect(w.map(x => x.id)).toContain('cap-zero')
    })

    it('is silent on a healthy policy', () => {
        expect(automationWarnings(
            { enabled: true, detectors: null, maxActionsPerRun: 10 },
            { probeEnabled: true },
        )).toEqual([])
    })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/admin/Freshness/AutomationPanel.test.tsx`
Expected: FAIL — cannot resolve `./automationCopy`.

- [ ] **Step 3: Implement the copy module**

Create `frontend/src/components/admin/Freshness/automationCopy.ts`:

```ts
/**
 * The words the Automation panel speaks, and the contradictions it reports.
 *
 * One vocabulary — ① Detect, ② Check, ③ Act — used by the panel, the drawer,
 * the row chips and the run history. Every label derives from here so the
 * three surfaces cannot drift apart.
 */

export const STAGES = {
    detect: {
        n: '①',
        name: 'Detect',
        means: 'Watches each source for data changed by systems outside this app.',
        costs: 'Reads stored counts, not the data itself — cheap enough to run every minute.',
    },
    check: {
        n: '②',
        name: 'Check',
        means: 'Decides whether the rolled-up lineage still matches the data.',
        costs: 'Pure database work; never touches the graph.',
    },
    act: {
        n: '③',
        name: 'Act',
        means: 'Rebuilds the rolled-up lineage when it no longer matches.',
        costs: 'Minutes of work on the graph — throttled and capped on purpose.',
    },
} as const

interface PolicyLike {
    enabled?: boolean | null
    detectors?: string[] | null
    maxActionsPerRun?: number | null
}
interface CadenceLike {
    probeEnabled?: boolean | null
}

/**
 * Combinations that are legal but almost certainly not intended. Derived, so
 * a settings change cannot leave a stale warning behind.
 */
export function automationWarnings(
    policy: PolicyLike | undefined,
    cadence: CadenceLike | undefined,
): { id: string; text: string }[] {
    const out: { id: string; text: string }[] = []
    if (!policy?.enabled) return out

    if (cadence?.probeEnabled === false) {
        out.push({
            id: 'detect-off',
            text: 'Change detection is off, so checks only see data as fresh as the '
                + '15-minute statistics refresh.',
        })
    }
    // null means "all detectors on"; an EMPTY array is a real configuration
    // meaning "act on nothing". Must be tested with length, never truthiness.
    if (Array.isArray(policy.detectors) && policy.detectors.length === 0) {
        out.push({
            id: 'no-detectors',
            text: 'Nothing is acted on. Problems are still detected and shown in the table.',
        })
    }
    if (policy.maxActionsPerRun === 0) {
        out.push({
            id: 'cap-zero',
            text: 'Detect and report only — no rebuilds will be queued.',
        })
    }
    return out
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/admin/Freshness/AutomationPanel.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit the copy module**

```bash
git add frontend/src/components/admin/Freshness/automationCopy.ts frontend/src/components/admin/Freshness/AutomationPanel.test.tsx
git commit -m "feat(freshness): the automation vocabulary and its contradiction rules"
```

- [ ] **Step 6: Write the panel behaviour test**

Append to `AutomationPanel.test.tsx` — mock the services the same way `CadenceControls.test.tsx` already does (copy its `vi.mock` block for `@/services/aggregationService` and `@/services/freshnessService`):

```tsx
    it('renders read-only without system:admin', async () => {
        renderPanel({ isAdmin: false })
        expect(await screen.findByText(/Detect/)).toBeInTheDocument()
        expect(screen.getByRole('button', { name: '5m' })).toBeDisabled()
    })

    it('round-trips the effective env defaults on a plain save', async () => {
        // Carried verbatim from CadenceControls: every toggle on this surface
        // inherits the hazard that an unrelated save flips it fleet-wide.
        renderPanel({
            isAdmin: true,
            settings: {
                tuning: null, cadence: null,
                envRebuildMinIntervalSecs: 900, envDriftAutoRebuild: false,
                envProbeEnabled: false, envProbeIntervalSecs: 60,
            },
        })
        await userEvent.click(await screen.findByRole('button', { name: 'Save' }))
        await waitFor(() => expect(putAggregationCadence).toHaveBeenCalledWith(
            expect.objectContaining({ driftAutoRebuild: false, probeEnabled: false }),
        ))
    })
```

- [ ] **Step 7: Implement `StageCard.tsx` and `AutomationPanel.tsx`**

`StageCard` renders one stage: `①` + name, the state dot, the `DurationField`, the two sentences from `STAGES`, and a `stat` slot. `AutomationPanel` composes three of them with `→` connectors (`flex` row above `md`, stacked below), renders `automationWarnings` output, the debounced dry-run impact line, and the Save/Cancel footer. It reads `useReconciliation()` + `getAggregationSettings()` and writes with `useSetReconciliationPolicy()` then `putAggregationCadence()` — sequenced, not raced, because both land in the same stored record.

Collapsed state renders the single summary line and nothing else.

- [ ] **Step 8: Mount it in the page**

In `frontend/src/components/admin/Freshness/index.tsx`, replace the `<CadenceSettingsDialog .../>` mount with `<AutomationPanel ... />` placed directly after `<OverlayIntegrity />`, and drive its open state from the URL:

```tsx
const automationOpen = params.get('automation') === 'open'
```

Point `onOpenCadence` at `() => patchParams({ automation: 'open' })` instead of `setCadenceOpen(true)`, in both `OverlayIntegrity` and `IntegrityPulse`.

- [ ] **Step 9: Delete the dialog and move its tests**

```bash
git rm frontend/src/components/admin/Freshness/CadenceSettingsDialog.tsx
```

Move the `admin cadence popover` describe block out of `CadenceControls.test.tsx` into `AutomationPanel.test.tsx`, keeping both assertions. The `cadence` block (the drawer's per-source editor) stays where it is.

- [ ] **Step 10: Run the Freshness suite**

Run: `npx vitest run src/components/admin/Freshness/`
Expected: 1 failed (the pre-existing `ReconcilePreviewDialog` test), everything else passing.

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"`
Expected: `61` or fewer.

- [ ] **Step 11: Commit**

```bash
git add -A frontend/src/components/admin/Freshness/
git commit -m "feat(freshness): in-page Automation panel replaces the cadence modal

The modal listed the three policies in the opposite order to how they run,
in three unrelated boxes, floating over the table it governs. The panel
names one pipeline — detect, check, act — shows each stage's cadence, cost
and live count, and reports what the policy would do to the fleet right now."
```

---

### Task 6: Quiet rows + the automation chip

**Files:**
- Modify: `frontend/src/components/admin/Freshness/FreshnessRow.tsx`
- Test: `frontend/src/components/admin/Freshness/FreshnessRow.test.tsx` (create if absent)

**Interfaces:**
- Consumes: `FreshnessDoc.pausedUntil`, `.driftState`, `.autoReconcile` (Tasks 1–3).
- Produces: `automationChip(row) -> {label: string, tone: string, facet: StatusFacet} | null`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, expect, it } from 'vitest'
import { automationChip } from './FreshnessRow'

describe('automationChip', () => {
    it('says nothing about a healthy watched source', () => {
        // Absence is the signal — a chip on every row is what made the old
        // Last activity column unreadable.
        expect(automationChip({ driftState: 'inSync', autoReconcile: true })).toBeNull()
    })

    it('names a snooze', () => {
        expect(automationChip({
            driftState: 'drifting', pausedUntil: '2999-01-01T00:00:00+00:00',
        })?.label).toBe('Paused')
    })

    it('prefers the breaker over a plain drift verdict', () => {
        expect(automationChip({ driftState: 'suspended' })?.label).toBe('Needs a person')
    })

    it('names a deliberate opt-out', () => {
        expect(automationChip({ driftState: 'inSync', autoReconcile: false })?.label)
            .toBe('Automation off')
    })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/admin/Freshness/FreshnessRow.test.tsx`
Expected: FAIL — `automationChip` is not exported.

- [ ] **Step 3: Implement `automationChip` and quieten `in_step`**

Add the exported helper to `FreshnessRow.tsx`, and change `ACTIVITY_PILL.in_step` so the routine outcome stops competing with the exceptional ones — replace its pill tone with muted, borderless, non-uppercase text. Every other kind keeps its pill exactly as it is.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/admin/Freshness/`
Expected: 1 failed (pre-existing), rest passing.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/admin/Freshness/FreshnessRow.tsx frontend/src/components/admin/Freshness/FreshnessRow.test.tsx
git commit -m "feat(freshness): quiet rows — absence means fine

'Reconcile check' rendered with the same weight as 'Rebuild failed', so a
healthy fleet was a wall of pills saying nothing happened. The routine
outcome becomes quiet text; a new automation chip appears only when a source
is drifting, held, suspended, paused or opted out."
```

---

### Task 7: The drawer — stages, evidence, snooze

**Files:**
- Modify: `frontend/src/components/admin/Freshness/FreshnessDrawer.tsx`
- Modify: `frontend/src/services/freshnessService.ts` (new `FreshnessDoc` + `FreshnessSettingsPatch` fields)
- Test: `frontend/src/components/admin/Freshness/CadenceControls.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–4; the existing `ReconcileWhy` component (`reconcileEvidence.tsx`), which already takes `{reason, evidence, dataSourceId}` and renders before → after pairs with unchanged rows dropped.
- Produces: nothing downstream.

- [ ] **Step 1: Add the client types**

In `frontend/src/services/freshnessService.ts`, add to `FreshnessDoc`: `lastFindingAt`, `lastFindingReason`, `lastFindingEvidence`, `probeEnabled`, `probeIntervalSecs`, `resolvedProbeIntervalSecs`, `probeIntervalSource`, `pausedUntil`. Add to `FreshnessSettingsPatch`: `probeEnabled`, `probeIntervalSecs`, `pausedUntil`.

- [ ] **Step 2: Write the failing test**

```tsx
    it('explains why a source is drifting from the stored evidence', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({
            driftState: 'overlayMissing',
            lastFindingReason: 'overlay_missing',
            lastFindingEvidence: {
                expectedAggregatedEdges: 50000, observedAggregatedEdges: 0,
            },
        }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)
        expect(await screen.findByText(/Rollups went missing/)).toBeInTheDocument()
        expect(screen.getByText(/50,000/)).toBeInTheDocument()
    })

    it('offers a detect override', async () => {
        getSourceDoc.mockResolvedValue(makeDoc({ resolvedProbeIntervalSecs: 60 }))
        wrap(<FreshnessDrawer dsId="ds-1" isOpen onClose={() => {}} />)
        expect(await screen.findByText(/Using default \(1m\)/)).toBeInTheDocument()
    })
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/components/admin/Freshness/CadenceControls.test.tsx`
Expected: FAIL — the evidence text is not rendered.

- [ ] **Step 4: Restructure the drawer sections**

Rename and reorder the existing sections to the pipeline: `DetectSection` (new — `probeEnabled` + `DurationField` on `probeIntervalSecs`), `CheckSection` (today's `ReconciliationSection`, using `DurationField`), `ActSection` (today's `RebuildCadenceSection`, using `DurationField`). Each labelled with its `STAGES` number and name from `automationCopy.ts`.

In `CheckSection`, when `doc.driftState` is a finding state, render:

```tsx
<ReconcileWhy
    reason={doc.lastFindingReason}
    evidence={doc.lastFindingEvidence}
    dataSourceId={doc.dataSourceId}
/>
```

Add the snooze control to `DetectSection`'s footer: a select of 1h / 8h / 24h / 7d that computes an ISO instant and PATCHes `pausedUntil`, showing the expiry and a Resume button (`pausedUntil: null`) when set.

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run src/components/admin/Freshness/`
Expected: 1 failed (pre-existing), rest passing.

- [ ] **Step 6: Full verification**

Run from `frontend/`: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -c "error TS"` → `61` or fewer.
Run from repo root: `.venv/bin/python -m pytest backend/tests/ -q -p no:randomly --ignore=backend/tests/test_auth_hardening.py --ignore=backend/tests/test_sso_phase2.py`
Expected: 25 failures, all on the known pre-existing list. Any new name is a regression.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/admin/Freshness/FreshnessDrawer.tsx frontend/src/services/freshnessService.ts frontend/src/components/admin/Freshness/CadenceControls.test.tsx
git commit -m "feat(freshness): drawer speaks the pipeline, explains drift, offers snooze

Restructures the per-source controls into detect/check/act, renders the
finding evidence the sweep has been storing all along, and adds the missing
middle between leaving automation on and turning it off forever."
```

---

## Self-Review

**Spec coverage:** §1 vocabulary → Task 5 (`automationCopy.STAGES`, consumed by Tasks 5–7). §2 panel → Tasks 4–5. §3a quiet `in_step` + §3b automation chip → Task 6. §4a detect override → Tasks 2, 7. §4b evidence → Tasks 1, 7. §4c snooze → Tasks 3, 7. §5a finding fields → Task 1. §5b probe settings → Task 2. §5c `paused_until` → Task 3. §5d `rebuiltLastHour` → **gap**, see below. §6 files → all tasks. §7 testing → per-task steps plus Task 7 Step 6.

**Gap found and accepted:** §5d (`rebuiltLastHour` on `assemble_reconcile_overview`) has no task. It is the ③ Act stage's live stat. It is one aggregate query and one response field; folding it into Task 5 would mix a backend change into a frontend task, and it does not block anything — the stage card renders without a stat. **Deferred deliberately to a follow-up**, noted here so it is not lost.

**Placeholder scan:** no TBD/TODO. Tasks 5 Step 7, 6 Step 3 and 7 Step 4 describe composition rather than showing every line — acceptable because each names the exact component, the exact props, and the exact source of every string; the primitives they compose are given in full in Tasks 4 and 5.

**Type consistency:** `DurationField` props identical in Tasks 4, 5, 7. `automationWarnings(policy, cadence)` identical in Tasks 5 Steps 1 and 3. `set_source_probe_settings(..., enabled=, interval_secs=)` identical in Task 2 Steps 1, 3 and 9. `Observation.paused_until` (snake) vs `FreshnessDoc.pausedUntil` (camel alias) is the intended boundary convention, matching every other field. `_state_map` tuple indices are sequential across Tasks 1 (`r[9]`–`r[11]`), 2 (`r[12]`–`r[13]`) and 3 (`r[14]`) — **tasks must be done in order, or the indices will not line up.**
