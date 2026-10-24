"""How often browsers check for changes: an admin setting, served by the manifest.

The interval used to be a frontend constant. It is a platform setting now,
edited on the Live updates switch's page and returned with every manifest,
so it reaches every browser at its next check, with no reload.
"""
from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import select

from backend.app.changes import cadence
from backend.app.db.models import OutboxEventORM, PlatformSettingsORM

URL = "/api/v1/admin/platform/live-updates"


@pytest.fixture(autouse=True)
def fresh_cache():
    cadence._cache.update(value=None, at=0.0, reading=False)
    yield
    cadence._cache.update(value=None, at=0.0, reading=False)


@pytest.fixture
def in_memory_registry(monkeypatch):
    from backend.app.api.v1.endpoints import changes as changes_endpoint
    from backend.app.changes.registry import InMemoryChangeRegistry

    registry = InMemoryChangeRegistry()
    monkeypatch.setattr(changes_endpoint, "get_registry", lambda: registry)


@pytest.fixture
def reads_the_test_db(monkeypatch, db_session):
    """Point the cadence reader's own session at the test database, as
    ``tests/common/api_key_world.py`` does for the resource fence."""
    from backend.app.db import engine as db_engine

    @asynccontextmanager
    async def _session():
        yield db_session

    monkeypatch.setattr(db_engine, "get_async_session", _session)


# ── The admin setting ──────────────────────────────────────────────────


async def test_unset_reads_as_the_default_and_says_what_the_bounds_are(test_client):
    resp = await test_client.get(URL)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["checkIntervalSeconds"] is None
    assert (body["defaultCheckIntervalSeconds"], body["minCheckIntervalSeconds"],
            body["maxCheckIntervalSeconds"]) == (60, 15, 600)


async def test_an_admin_sets_it_and_the_change_is_recorded(test_client, db_session):
    resp = await test_client.put(URL, json={"checkIntervalSeconds": 30})

    assert resp.status_code == 200, resp.text
    assert resp.json()["checkIntervalSeconds"] == 30
    rows = (await db_session.execute(
        select(OutboxEventORM)
        .where(OutboxEventORM.event_type == "platform.live_updates.updated")
    )).scalars().all()
    assert [json.loads(r.payload)["details"] for r in rows] == [{"from": None, "to": 30}]


@pytest.mark.parametrize("seconds", [0, 14, 601])
async def test_a_value_outside_the_bounds_is_refused(test_client, seconds):
    resp = await test_client.put(URL, json={"checkIntervalSeconds": seconds})

    assert resp.status_code == 422, resp.text


async def test_null_clears_it_back_to_the_default(test_client):
    await test_client.put(URL, json={"checkIntervalSeconds": 120})

    resp = await test_client.put(URL, json={"checkIntervalSeconds": None})

    assert resp.status_code == 200, resp.text
    assert resp.json()["checkIntervalSeconds"] is None


async def test_an_absent_field_leaves_it_alone(test_client):
    await test_client.put(URL, json={"checkIntervalSeconds": 120})

    resp = await test_client.put(URL, json={})

    assert resp.json()["checkIntervalSeconds"] == 120


async def test_only_a_system_admin_reads_or_changes_it(test_client):
    from backend.app.auth.dependencies import get_permission_claims
    from backend.app.services.permission_service import PermissionClaims

    app = test_client._transport.app  # type: ignore[attr-defined]
    fixture_override = app.dependency_overrides[get_permission_claims]
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_viewer", global_perms=(), ws_perms={},
    )
    try:
        assert (await test_client.get(URL)).status_code == 403
        assert (await test_client.put(URL, json={"checkIntervalSeconds": 30})).status_code == 403
    finally:
        app.dependency_overrides[get_permission_claims] = fixture_override


# ── Served to browsers ─────────────────────────────────────────────────


async def test_the_manifest_carries_the_setting(test_client, reads_the_test_db, in_memory_registry):
    await test_client.put(URL, json={"checkIntervalSeconds": 120})

    resp = await test_client.get("/api/v1/changes")

    assert resp.status_code == 200, resp.text
    assert resp.json()["checkAfterSeconds"] == 120


async def test_the_manifest_says_60_while_it_is_unset(test_client, reads_the_test_db, in_memory_registry):
    resp = await test_client.get("/api/v1/changes")

    assert resp.json()["checkAfterSeconds"] == 60


async def test_a_stored_value_outside_the_bounds_is_clamped(db_session, reads_the_test_db):
    db_session.add(PlatformSettingsORM(id=1, change_check_interval_secs=5))
    await db_session.commit()

    assert await cadence.check_interval_seconds() == 15


async def test_it_is_read_once_per_ttl_unless_invalidated(db_session, reads_the_test_db):
    db_session.add(PlatformSettingsORM(id=1, change_check_interval_secs=90))
    await db_session.commit()
    assert await cadence.check_interval_seconds() == 90

    row = await db_session.get(PlatformSettingsORM, 1)
    row.change_check_interval_secs = 200
    await db_session.commit()
    assert await cadence.check_interval_seconds() == 90

    cadence.invalidate_cache()
    assert await cadence.check_interval_seconds() == 200


async def test_an_unreadable_setting_answers_the_default_without_raising_or_retrying(monkeypatch):
    """The manifest is the hottest read in the app. A database that is down
    must cost it nothing: one failed read per TTL, not one per request."""
    from backend.app.db import engine as db_engine

    attempts = []

    @asynccontextmanager
    async def _unreachable():
        attempts.append(1)
        raise ConnectionError("database unreachable")
        yield  # pragma: no cover — never reached

    monkeypatch.setattr(db_engine, "get_async_session", _unreachable)

    assert await cadence.check_interval_seconds() == 60
    assert await cadence.check_interval_seconds() == 60
    assert len(attempts) == 1


async def test_one_read_at_a_time_and_nobody_waits_behind_it(monkeypatch):
    """With the database slow, every manifest that missed the cache would
    open a session of its own, and a burst of them could hold the pool that
    readiness checks need. One reads; the rest answer at once, with the last
    value read, which a failed read keeps rather than resetting to 60."""
    from backend.app.db import engine as db_engine

    sessions = []
    release = asyncio.Event()

    @asynccontextmanager
    async def _slow_then_down():
        sessions.append(1)
        await release.wait()
        raise ConnectionError("database unreachable")
        yield  # pragma: no cover — never reached

    monkeypatch.setattr(db_engine, "get_async_session", _slow_then_down)
    # Read as 90 a while ago, and expired since.
    cadence._cache.update(value=90, at=time.monotonic() - cadence._TTL_S - 1)

    first = asyncio.create_task(cadence.check_interval_seconds())
    await asyncio.sleep(0)
    assert len(sessions) == 1

    assert await asyncio.wait_for(cadence.check_interval_seconds(), 0.5) == 90
    assert len(sessions) == 1

    release.set()
    assert await first == 90
    assert await cadence.check_interval_seconds() == 90
    assert len(sessions) == 1

