"""Tests for refresh_events_repo — the audit trail for freshness/refresh
operations (script, connector, api, drift, reconcile origins), the
foundation for the OPS Freshness Cockpit.

Covers: emit opens its OWN session and returns an id; the row round-trips
via the reader; a broken session factory is swallowed (returns None,
never raises); latest_refresh_event_map returns the newest row per data
source in one query.
"""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from backend.app.db.repositories import refresh_events_repo


def _session_factory(db_engine: AsyncEngine):
    """A standalone session factory bound to the SAME test engine as
    ``db_session`` — standing in for the production ``get_async_session``
    so emit_refresh_event exercises its own-session code path."""
    return async_sessionmaker(bind=db_engine, class_=AsyncSession, expire_on_commit=False)


async def test_emit_returns_id_and_row_round_trips(
    db_session: AsyncSession, db_engine: AsyncEngine,
):
    event_id = await refresh_events_repo.emit_refresh_event(
        _session_factory(db_engine),
        workspace_id="ws1",
        data_source_id="ds1",
        provider_id="prov1",
        origin="script",
        actor="internal",
        scope="full",
        gate="changed",
        actions={"nodes": 10},
        outcome="completed",
        detail="ok",
    )

    assert event_id is not None
    rows = await refresh_events_repo.list_refresh_events(db_session, "ds1")
    assert len(rows) == 1
    row = rows[0]
    assert row.id == event_id
    assert row.workspace_id == "ws1"
    assert row.data_source_id == "ds1"
    assert row.provider_id == "prov1"
    assert row.origin == "script"
    assert row.actor == "internal"
    assert row.scope == "full"
    assert row.gate == "changed"
    assert row.outcome == "completed"
    assert row.detail == "ok"


async def test_emit_swallows_broken_session_factory():
    def _broken_factory():
        raise RuntimeError("boom")

    event_id = await refresh_events_repo.emit_refresh_event(
        _broken_factory,
        workspace_id="ws1",
        data_source_id="ds1",
        origin="script",
        scope="full",
        gate="changed",
        actions=None,
        outcome="error",
    )
    assert event_id is None


async def test_latest_refresh_event_map_returns_newest_per_ds(
    db_session: AsyncSession, db_engine: AsyncEngine,
):
    factory = _session_factory(db_engine)
    await refresh_events_repo.emit_refresh_event(
        factory, workspace_id="ws1", data_source_id="ds1", origin="script",
        scope="full", gate="changed", actions=None, outcome="completed",
        detail="first",
    )
    await refresh_events_repo.emit_refresh_event(
        factory, workspace_id="ws1", data_source_id="ds1", origin="drift",
        scope="auto", gate="unchanged", actions=None, outcome="noop",
        detail="second",
    )
    await refresh_events_repo.emit_refresh_event(
        factory, workspace_id="ws1", data_source_id="ds2", origin="api",
        scope="rollups", gate="forced", actions=None, outcome="accepted",
        detail="other",
    )

    latest = await refresh_events_repo.latest_refresh_event_map(
        db_session, ["ds1", "ds2"],
    )
    assert set(latest) == {"ds1", "ds2"}
    assert latest["ds1"].detail == "second"
    assert latest["ds2"].detail == "other"
