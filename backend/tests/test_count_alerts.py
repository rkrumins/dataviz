"""Counts-anomaly alerting — what gets raised, what gets suppressed, and why.

The suppression rules carry as much weight as the detection here. An alerting
system that fires on every probe of a thrashing source trains people to ignore
it, at which point it is worth less than no alerting at all: they stop reading
it but still believe something is watching.
"""
import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    CatalogItemORM,
    DataSourceCountAlertORM,
    DataSourceCountSnapshotORM,
    ProviderORM,
)
from backend.app.db.repositories import count_alerts_repo

DS_ID = "ds_alert1"


def _iso(hours_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).isoformat()


async def _snap(session: AsyncSession, *, at: str, nodes: int,
                delta: int | None = None, ds_id: str = DS_ID,
                provider_id: str = "prov_a1", graph_name: str = "alert-graph"):
    session.add(DataSourceCountSnapshotORM(
        id=f"snp_{ds_id}_{at}",
        data_source_id=ds_id,
        captured_at=at,
        workspace_id="ws_a1",
        provider_id=provider_id,
        graph_name=graph_name,
        node_count=nodes,
        edge_count=0,
        entity_type_counts=json.dumps({"Table": nodes}),
        edge_type_counts="{}",
        counts_digest="d",
        lane="probe",
        capture_reason="changed",
        node_delta=delta,
        type_deltas=json.dumps({
            "nodes": {"added": {}, "removed": {}, "changed": {}},
            "edges": {"added": {}, "removed": {}, "changed": {}},
        }) if delta is not None else None,
    ))
    await session.flush()


def _policy(**over) -> count_alerts_repo.AlertPolicy:
    base = count_alerts_repo.env_alert_policy()
    return count_alerts_repo.AlertPolicy(**{**base.__dict__, **over})


async def _steady_then(session: AsyncSession, final_delta: int, final_nodes: int):
    """Ten ordinary observations, then one movement."""
    for hours in range(20, 10, -1):
        await _snap(session, at=_iso(hours), nodes=10_000, delta=10)
    await _snap(session, at=_iso(2), nodes=final_nodes, delta=final_delta)


async def _alerts(session: AsyncSession) -> list:
    return list((await session.execute(
        select(DataSourceCountAlertORM)
        .order_by(DataSourceCountAlertORM.detected_at)
    )).scalars().all())


# ── detection ────────────────────────────────────────────────────────

async def test_a_severe_drop_raises_an_alert(db_session: AsyncSession):
    await _steady_then(db_session, -9_900, 100)

    notice = await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy())
    assert notice is not None
    assert notice.severity == "severe"
    assert notice.direction == "drop"

    rows = await _alerts(db_session)
    assert len(rows) == 1
    assert rows[0].node_delta == -9_900
    assert rows[0].severity == "severe"


async def test_a_severe_rise_raises_too(db_session: AsyncSession):
    """A loader duplicating every node is as much a failure as a deletion."""
    await _steady_then(db_session, 30_000, 40_000)

    notice = await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy())
    assert notice is not None
    assert notice.direction == "rise"


async def test_ordinary_movement_raises_nothing(db_session: AsyncSession):
    await _steady_then(db_session, 10, 10_010)
    assert await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy()) is None
    assert await _alerts(db_session) == []


async def test_a_single_observation_cannot_be_a_movement(db_session: AsyncSession):
    """Otherwise every newly onboarded graph alerts on its first snapshot."""
    await _snap(db_session, at=_iso(1), nodes=50_000)
    assert await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy()) is None


async def test_the_severity_floor_is_respected(db_session: AsyncSession):
    # The baseline here is the FLOOR of 25 (ten deltas of 10 median to 10),
    # so notable is >=75 and severe is >=200. 100 sits between them.
    await _steady_then(db_session, -100, 9_900)

    assert await count_alerts_repo.evaluate_source(
        db_session, DS_ID, _policy(min_severity="severe")) is None
    notice = await count_alerts_repo.evaluate_source(
        db_session, DS_ID, _policy(min_severity="notable"))
    assert notice is not None
    assert notice.severity == "notable"


async def test_the_worst_movement_wins_not_the_latest(db_session: AsyncSession):
    """A thrashing source produces several. The one worth someone's attention
    is the biggest; reporting the latest describes the aftershock."""
    for hours in range(20, 10, -1):
        await _snap(db_session, at=_iso(hours), nodes=10_000, delta=10)
    await _snap(db_session, at=_iso(5), nodes=100, delta=-9_900)   # the event
    await _snap(db_session, at=_iso(4), nodes=1_100, delta=1_000)  # aftershock

    notice = await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy())
    assert notice.node_delta == -9_900


# ── suppression ──────────────────────────────────────────────────────

async def test_a_second_pass_inside_the_cooldown_stays_quiet(
    db_session: AsyncSession,
):
    await _steady_then(db_session, -9_900, 100)

    assert await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy()) is not None
    # Same data, immediately re-judged — an incident must ring once.
    assert await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy()) is None
    assert len(await _alerts(db_session)) == 1


async def test_a_stale_movement_does_not_re_alert_after_the_cooldown(
    db_session: AsyncSession,
):
    """The cooldown elapsing is not new news. Without this the same incident
    re-alerts once per cooldown for as long as it stays in the lookback."""
    await _steady_then(db_session, -9_900, 100)
    assert await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy()) is not None

    # Cooldown of 0: the gate is now purely "has anything happened SINCE".
    assert await count_alerts_repo.evaluate_source(
        db_session, DS_ID, _policy(cooldown_secs=0)) is None


async def test_a_new_movement_after_the_cooldown_does_alert(
    db_session: AsyncSession,
):
    await _steady_then(db_session, -9_900, 100)
    assert await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy()) is not None

    await _snap(db_session, at=_iso(0.1), nodes=50, delta=-9_950)
    notice = await count_alerts_repo.evaluate_source(
        db_session, DS_ID, _policy(cooldown_secs=0))
    assert notice is not None
    assert notice.node_delta == -9_950
    assert len(await _alerts(db_session)) == 2


# ── the frozen verdict ───────────────────────────────────────────────

async def test_the_baseline_is_frozen_on_the_alert(db_session: AsyncSession):
    """The window moves. An alert recomputed later against a different
    baseline could quietly downgrade itself and contradict the notification
    that already went out."""
    await _steady_then(db_session, -9_900, 100)
    await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy())

    row = (await _alerts(db_session))[0]
    assert row.baseline > 0
    assert row.evidence is not None
    # Observed and detected are different instants: evaluation runs on a tick.
    assert row.observed_at != row.detected_at


async def test_the_alert_resolves_its_catalog_item_for_deep_linking(
    db_session: AsyncSession,
):
    db_session.add(ProviderORM(id="prov_a1", name="P", provider_type="falkordb"))
    db_session.add(CatalogItemORM(
        id="cat_a1", provider_id="prov_a1",
        source_identifier="alert-graph", name="Alerts",
    ))
    await db_session.flush()
    await _steady_then(db_session, -9_900, 100)

    notice = await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy())
    assert notice.catalog_item_id == "cat_a1"
    assert (await _alerts(db_session))[0].catalog_item_id == "cat_a1"


async def test_an_unregistered_graph_still_alerts_without_a_catalog_id(
    db_session: AsyncSession,
):
    """No catalog entry is not a reason to swallow the finding — the
    notification just falls back to a different destination."""
    await _steady_then(db_session, -9_900, 100)
    notice = await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy())
    assert notice is not None
    assert notice.catalog_item_id is None


# ── scanning + acknowledgement + retention ───────────────────────────

async def test_only_recently_observed_sources_are_scanned(
    db_session: AsyncSession,
):
    await _snap(db_session, at=_iso(1), nodes=10, ds_id="ds_recent")
    await _snap(db_session, at=_iso(24 * 40), nodes=10, ds_id="ds_dormant")

    assert await count_alerts_repo.sources_to_evaluate(db_session) == ["ds_recent"]


async def test_acknowledgement_records_who_and_is_idempotent(
    db_session: AsyncSession,
):
    await _steady_then(db_session, -9_900, 100)
    await count_alerts_repo.evaluate_source(db_session, DS_ID, _policy())
    alert_id = (await _alerts(db_session))[0].id

    first = await count_alerts_repo.acknowledge(db_session, alert_id, actor_id="u1")
    assert first.acknowledged_by == "u1"
    stamped = first.acknowledged_at

    # The FIRST acknowledgement wins — re-acknowledging must not rewrite who
    # actually looked at it.
    again = await count_alerts_repo.acknowledge(db_session, alert_id, actor_id="u2")
    assert again.acknowledged_by == "u1"
    assert again.acknowledged_at == stamped


async def test_acknowledging_something_that_is_not_there_returns_none(
    db_session: AsyncSession,
):
    assert await count_alerts_repo.acknowledge(
        db_session, "alr_missing", actor_id="u1") is None


async def test_purge_never_removes_an_unacknowledged_alert(
    db_session: AsyncSession,
):
    """An alert nobody has looked at is the one thing here that must not
    disappear quietly — that is losing the finding, not retention."""
    old = (datetime.now(timezone.utc) - timedelta(days=400)).isoformat()
    for i, ack in enumerate((None, old)):
        db_session.add(DataSourceCountAlertORM(
            id=f"alr_{i}", data_source_id=DS_ID, detected_at=old, observed_at=old,
            severity="severe", direction="drop", node_delta=-1, node_count=0,
            baseline=10, acknowledged_at=ack,
        ))
    await db_session.flush()

    removed = await count_alerts_repo.purge_alerts(db_session, retention_days=90)
    assert removed == 1
    survivors = await _alerts(db_session)
    assert [r.id for r in survivors] == ["alr_0"]


# ── policy resolution ────────────────────────────────────────────────

async def test_policy_falls_back_to_env(db_session: AsyncSession):
    policy = await count_alerts_repo.resolve_alert_policy(db_session)
    assert policy.enabled == policy.env_enabled
    assert policy.persisted_enabled is None


async def test_alerting_switched_off_is_a_real_setting(db_session: AsyncSession):
    """False and unset are different states — a truthiness check here would
    silently turn alerting back on."""
    from backend.app.db.models import PlatformSettingsORM

    db_session.add(PlatformSettingsORM(id=1, history_alerts_enabled=False))
    await db_session.flush()

    policy = await count_alerts_repo.resolve_alert_policy(db_session)
    assert policy.enabled is False
    assert policy.persisted_enabled is False


async def test_a_garbage_severity_falls_back_rather_than_disabling_alerts(
    db_session: AsyncSession,
):
    from backend.app.db.models import PlatformSettingsORM

    db_session.add(PlatformSettingsORM(id=1, history_alert_min_severity="nonsense"))
    await db_session.flush()

    policy = await count_alerts_repo.resolve_alert_policy(db_session)
    assert policy.min_severity == policy.env_min_severity


async def test_the_cooldown_is_floored(db_session: AsyncSession):
    """A cooldown of zero turns one incident into an alert per probe."""
    from backend.app.db.models import PlatformSettingsORM

    db_session.add(PlatformSettingsORM(id=1, history_alert_cooldown_secs=0))
    await db_session.flush()

    policy = await count_alerts_repo.resolve_alert_policy(db_session)
    assert policy.cooldown_secs >= 60


# ── the sweep ────────────────────────────────────────────────────────

async def test_the_sweep_rings_only_after_the_alerts_are_committed(monkeypatch):
    """The reconcile sweep's discipline, for the same reason: a best-effort
    fan-out over another domain's tables must never be able to roll back the
    findings it describes."""
    from backend.insights_service import scheduler

    order: list[str] = []

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): order.append("commit")
        async def rollback(self): return None

    notice = count_alerts_repo.PendingNotice(
        data_source_id=DS_ID, workspace_id="ws_a1", catalog_item_id="cat_a1",
        source_name="alert-graph", severity="severe", direction="drop",
        node_delta=-9_900,
    )

    async def fake_policy(_s): return _policy()
    async def fake_sources(_s): return [DS_ID]
    async def fake_evaluate(_s, _ds, _p): return notice
    async def fake_notify(_s, **_kw): order.append("notify"); return 1

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(count_alerts_repo, "resolve_alert_policy", fake_policy)
    monkeypatch.setattr(count_alerts_repo, "sources_to_evaluate", fake_sources)
    monkeypatch.setattr(count_alerts_repo, "evaluate_source", fake_evaluate)
    monkeypatch.setattr(
        "backend.app.db.repositories.notification_repo.notify_counts_anomaly",
        fake_notify,
    )
    monkeypatch.setattr(scheduler, "_ALERT_INTERVAL_SECS", 0.0)
    scheduler._alert_sweep_state["last_run_monotonic"] = 0.0

    await scheduler._maybe_evaluate_count_alerts()
    assert order[0] == "commit", "alerts must be durable before the bell rings"
    assert "notify" in order


async def test_the_sweep_respects_its_cadence(monkeypatch):
    from backend.insights_service import scheduler

    calls: list[int] = []

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): return None
        async def rollback(self): return None

    async def fake_policy(_s): return _policy()
    async def fake_sources(_s): calls.append(1); return []

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(count_alerts_repo, "resolve_alert_policy", fake_policy)
    monkeypatch.setattr(count_alerts_repo, "sources_to_evaluate", fake_sources)
    monkeypatch.setattr(scheduler, "_ALERT_INTERVAL_SECS", 3600.0)
    scheduler._alert_sweep_state["last_run_monotonic"] = 0.0

    await scheduler._maybe_evaluate_count_alerts()
    await scheduler._maybe_evaluate_count_alerts()
    assert calls == [1], "a second tick inside the interval must not re-scan"


async def test_the_sweep_does_nothing_when_alerting_is_off(monkeypatch):
    from backend.insights_service import scheduler

    scanned: list[int] = []

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): return None
        async def rollback(self): return None

    async def fake_policy(_s): return _policy(enabled=False)
    async def fake_sources(_s): scanned.append(1); return []

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(count_alerts_repo, "resolve_alert_policy", fake_policy)
    monkeypatch.setattr(count_alerts_repo, "sources_to_evaluate", fake_sources)
    monkeypatch.setattr(scheduler, "_ALERT_INTERVAL_SECS", 0.0)
    scheduler._alert_sweep_state["last_run_monotonic"] = 0.0

    await scheduler._maybe_evaluate_count_alerts()
    assert scanned == []


async def test_one_unreadable_source_does_not_cost_the_fleet_its_pass(monkeypatch):
    from backend.insights_service import scheduler

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): return None
        async def rollback(self): return None

    seen: list[str] = []

    async def fake_policy(_s): return _policy()
    async def fake_sources(_s): return ["ds_broken", "ds_fine"]

    async def fake_evaluate(_s, ds, _p):
        seen.append(ds)
        if ds == "ds_broken":
            raise RuntimeError("unreadable")
        return None

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(count_alerts_repo, "resolve_alert_policy", fake_policy)
    monkeypatch.setattr(count_alerts_repo, "sources_to_evaluate", fake_sources)
    monkeypatch.setattr(count_alerts_repo, "evaluate_source", fake_evaluate)
    monkeypatch.setattr(scheduler, "_ALERT_INTERVAL_SECS", 0.0)
    scheduler._alert_sweep_state["last_run_monotonic"] = 0.0

    await scheduler._maybe_evaluate_count_alerts()
    assert seen == ["ds_broken", "ds_fine"]


async def test_a_failed_fan_out_leaves_the_alerts_readable(monkeypatch):
    """The bell is best effort; the record is not."""
    from backend.insights_service import scheduler

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): return None
        async def rollback(self): return None

    notice = count_alerts_repo.PendingNotice(
        data_source_id=DS_ID, workspace_id=None, catalog_item_id=None,
        source_name="g", severity="severe", direction="drop", node_delta=-1,
    )

    async def fake_policy(_s): return _policy()
    async def fake_sources(_s): return [DS_ID]
    async def fake_evaluate(_s, _ds, _p): return notice
    async def boom(_s, **_kw): raise RuntimeError("bell is down")

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(count_alerts_repo, "resolve_alert_policy", fake_policy)
    monkeypatch.setattr(count_alerts_repo, "sources_to_evaluate", fake_sources)
    monkeypatch.setattr(count_alerts_repo, "evaluate_source", fake_evaluate)
    monkeypatch.setattr(
        "backend.app.db.repositories.notification_repo.notify_counts_anomaly", boom,
    )
    monkeypatch.setattr(scheduler, "_ALERT_INTERVAL_SECS", 0.0)
    scheduler._alert_sweep_state["last_run_monotonic"] = 0.0

    # Must not raise — the pass reports itself as having run.
    await scheduler._maybe_evaluate_count_alerts()
    assert scheduler.get_alert_sweep_status()["last_raised"] == 1


async def test_the_scan_puts_the_most_recently_active_sources_first(
    db_session: AsyncSession,
):
    """An unordered LIMIT would judge an arbitrary slice every pass, so on a
    fleet larger than the cap the rest would never be evaluated — and a source
    that is never judged looks exactly like one that never moved."""
    await _snap(db_session, at=_iso(20), nodes=10, ds_id="ds_stale")
    await _snap(db_session, at=_iso(1), nodes=10, ds_id="ds_fresh")
    await _snap(db_session, at=_iso(10), nodes=10, ds_id="ds_middle")

    assert await count_alerts_repo.sources_to_evaluate(db_session) == [
        "ds_fresh", "ds_middle", "ds_stale",
    ]


async def test_the_scan_cap_is_announced_rather_than_silent(
    db_session: AsyncSession, monkeypatch, caplog,
):
    monkeypatch.setattr(count_alerts_repo, "_SOURCE_SCAN_CAP", 2)
    for i in range(3):
        await _snap(db_session, at=_iso(i + 1), nodes=10, ds_id=f"ds_{i}")

    with caplog.at_level("WARNING"):
        picked = await count_alerts_repo.sources_to_evaluate(db_session)

    assert len(picked) == 2
    assert any("deferring the rest" in r.message for r in caplog.records)


async def test_a_poisoned_transaction_is_rolled_back_before_continuing(monkeypatch):
    """`continue` alone is not enough on Postgres: a failed statement poisons
    the transaction until rollback, so every subsequent source would fail too
    and the pass would lose everything it had found."""
    from backend.insights_service import scheduler

    events: list[str] = []

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): events.append("commit")
        async def rollback(self): events.append("rollback")

    notice = count_alerts_repo.PendingNotice(
        data_source_id="ds_ok", workspace_id=None, catalog_item_id=None,
        source_name="g", severity="severe", direction="drop", node_delta=-1,
    )

    async def fake_policy(_s): return _policy()
    async def fake_sources(_s): return ["ds_broken", "ds_ok"]

    async def fake_evaluate(_s, ds, _p):
        events.append(f"judge:{ds}")
        if ds == "ds_broken":
            raise RuntimeError("constraint violation")
        return notice

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(count_alerts_repo, "resolve_alert_policy", fake_policy)
    monkeypatch.setattr(count_alerts_repo, "sources_to_evaluate", fake_sources)
    monkeypatch.setattr(count_alerts_repo, "evaluate_source", fake_evaluate)
    monkeypatch.setattr(
        "backend.app.db.repositories.notification_repo.notify_counts_anomaly",
        lambda *_a, **_kw: None,
    )
    monkeypatch.setattr(scheduler, "_ALERT_INTERVAL_SECS", 0.0)
    scheduler._alert_sweep_state["last_run_monotonic"] = 0.0

    await scheduler._maybe_evaluate_count_alerts()
    assert events[:4] == [
        "judge:ds_broken", "rollback", "judge:ds_ok", "commit",
    ]


async def test_an_alert_is_committed_as_soon_as_it_lands(monkeypatch):
    """Bounding what a later failure can cost to the source being judged,
    rather than to the whole pass."""
    from backend.insights_service import scheduler

    events: list[str] = []

    class _Session:
        async def __aenter__(self): return self
        async def __aexit__(self, *exc): return False
        async def commit(self): events.append("commit")
        async def rollback(self): events.append("rollback")

    notice = count_alerts_repo.PendingNotice(
        data_source_id="ds_a", workspace_id=None, catalog_item_id=None,
        source_name="g", severity="severe", direction="drop", node_delta=-1,
    )

    async def fake_policy(_s): return _policy()
    async def fake_sources(_s): return ["ds_quiet", "ds_a"]
    async def fake_evaluate(_s, ds, _p):
        events.append(f"judge:{ds}")
        return None if ds == "ds_quiet" else notice
    async def fake_notify(_s, **_kw): events.append("notify"); return 1

    monkeypatch.setattr(scheduler, "get_jobs_session", lambda: _Session())
    monkeypatch.setattr(count_alerts_repo, "resolve_alert_policy", fake_policy)
    monkeypatch.setattr(count_alerts_repo, "sources_to_evaluate", fake_sources)
    monkeypatch.setattr(count_alerts_repo, "evaluate_source", fake_evaluate)
    monkeypatch.setattr(
        "backend.app.db.repositories.notification_repo.notify_counts_anomaly",
        fake_notify,
    )
    monkeypatch.setattr(scheduler, "_ALERT_INTERVAL_SECS", 0.0)
    scheduler._alert_sweep_state["last_run_monotonic"] = 0.0

    await scheduler._maybe_evaluate_count_alerts()
    # A quiet source costs no commit; the alert is durable before the bell.
    assert events.index("commit") < events.index("notify")
