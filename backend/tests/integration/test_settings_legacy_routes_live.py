"""The old build and residency routes against Postgres and Redis, now that they save through the
settings store (PUT ``/admin/versioning/build-policy`` and ``/residency-policy``).

Pins:
- A PUT saves in the store with its history: ``legacy_api``, who, and the reason the person gave.
- In the same transaction it writes the old storage through (the JSON, the ``gv_*`` columns), so
  the previous image, rolled back to, behaves as configured; and it records its activity event.
- ``-1`` still clears a value: inherit (NULL) in the store, NULL in the old column.
- A refused PUT saves nothing anywhere, a change to the residency class among them (it is the
  class every graph inherits now, set in Admin → Versioned graphs); sent back as it is, it passes.
- PUTs at once go one at a time, under the store's writer lock, and the last one wins, as before.
- This process reads the change at once.

Needs ``GRAPHVER_E2E=1``, ``MANAGEMENT_DB_URL`` (a role that may create databases) and the bus
Redis, as ``test_settings_store_live.py``, whose helpers it uses.
"""
from __future__ import annotations

import asyncio
import json
import os
from types import SimpleNamespace
from typing import Iterator

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import versioning_admin as va
from backend.app.common import activity_context
from backend.app.services.versioning import build_policy, config, residency_policy
from backend.tests.common.settings_world import use_the_database
from backend.tests.integration.test_settings_store_live import (  # noqa: F401 — fixtures
    engines_at, query, redis_bus, scratch_database, upgrade_cli)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres and Redis")

_ADMIN = SimpleNamespace(id="usr_admin")
_REASON = "Make room for the quarter-end load"


@pytest.fixture(scope="module")
def routes_db() -> Iterator[str]:
    with scratch_database("settings_routes") as name:
        upgrade_cli(name, "upgrade")
        yield name


@pytest.fixture
async def db(routes_db, engines_at, redis_bus, monkeypatch):
    """The module's database, the real settings snapshot, and a signed-in administrator who gave
    a reason (``X-Activity-Reason``)."""
    engines_at(routes_db)
    use_the_database(monkeypatch)
    token = activity_context.bind(activity_context.ActivityContext(actor_id=_ADMIN.id,
                                                                   stated_reason=_REASON))
    yield routes_db
    activity_context.reset(token)


async def _put(route, body) -> dict:
    from backend.app.db.engine import get_async_session

    async with get_async_session() as session:
        return await route(body, user=_ADMIN, session=session)


def _platform(db: str, prefix: str) -> dict:
    return dict(query(db, "SELECT key, value FROM setting_values "
                          "WHERE scope = 'platform' AND key LIKE :p", p=f"{prefix}%"))


def _history(db: str, prefix: str) -> set:
    return {(c.key, json.dumps(c.before_value), json.dumps(c.after_value), c.source, c.actor,
             c.reason)
            for c in query(db, "SELECT key, before_value, after_value, source, actor, reason "
                               "FROM setting_changes WHERE key LIKE :p", p=f"{prefix}%")}


async def test_the_old_build_policy_put_saves_in_the_store_and_writes_the_old_json(db):
    out = await _put(va.put_build_policy, {"copyMarginPct": 150, "copyMaxBytes": 0})
    assert out["values"]["copyMarginPct"] == {
        "saved": 150, "default": config.PROJECTION_COPY_MARGIN_PCT, "effective": 150}
    assert out["values"]["copyMaxBytes"]["saved"] == 0
    assert out["updatedBy"] == "usr_admin" and out["updatedAt"]
    assert _platform(db, "builds.") == {"builds.copyRoomPct": 150,
                                        "builds.copyMaxBytes": "unlimited"}
    assert _history(db, "builds.") == {
        ("builds.copyRoomPct", "null", "150", "legacy_api", "usr_admin", _REASON),
        ("builds.copyMaxBytes", "null", '"unlimited"', "legacy_api", "usr_admin", _REASON)}
    (row,) = query(db, "SELECT gv_build_policy, updated_by FROM platform_settings WHERE id = 1")
    saved = json.loads(row.gv_build_policy)
    assert saved["values"] == {"copyMarginPct": 150, "copyMaxBytes": 0}
    assert saved["updatedBy"] == "usr_admin" and row.updated_by == "usr_admin"
    assert len(query(db, "SELECT 1 FROM outbox_events "
                         "WHERE event_type = 'platform.build_policy.updated'")) == 1
    assert build_policy.current()["copyMarginPct"] == 150          # this process, at once


async def test_the_old_residency_put_saves_in_the_store_and_writes_the_old_columns(db):
    with pytest.raises(HTTPException) as caught:          # the class is set elsewhere now
        await _put(va.put_residency_policy, {"highWaterPct": 75, "defaultResidency": "coldline"})
    assert (caught.value.status_code, caught.value.detail["field"]) == (422, "defaultResidency")
    assert _platform(db, "residency.") == {}
    out = await _put(va.put_residency_policy, {"highWaterPct": 75, "defaultResidency": "standard"})
    assert out["values"]["highWaterPct"]["effective"] == 75 and out["updatedBy"] == "usr_admin"
    assert _platform(db, "residency.") == {"residency.unloadStartPct": 75}
    (row,) = query(db, "SELECT gv_high_water_pct, gv_default_residency, gv_policy_updated_by, "
                       "gv_policy_updated_at FROM platform_settings WHERE id = 1")
    assert (row.gv_high_water_pct, row.gv_default_residency, row.gv_policy_updated_by) == (
        75, None, "usr_admin")
    assert row.gv_policy_updated_at
    assert (await residency_policy.resolve()).high_water_pct == 75

    await _put(va.put_residency_policy, {"highWaterPct": -1})        # back to the default
    assert _platform(db, "residency.unloadStartPct") == {"residency.unloadStartPct": None}
    assert query(db, "SELECT gv_high_water_pct FROM platform_settings WHERE id = 1")[0][0] is None
    assert ("residency.unloadStartPct", "75", "null", "legacy_api", "usr_admin",
            _REASON) in _history(db, "residency.")
    assert len(query(db, "SELECT 1 FROM outbox_events "
                         "WHERE event_type = 'platform.residency_policy.updated'")) == 2


async def test_a_refused_put_saves_nothing_anywhere(db):
    with pytest.raises(HTTPException) as caught:
        await _put(va.put_build_policy, {"pgReadsPerGraph": 9, "pgReadsPerProcess": 8})
    assert caught.value.status_code == 422
    assert caught.value.detail["type"] == "invalid_build_policy"
    assert caught.value.detail["field"] == "pgReadsPerGraph"
    assert _platform(db, "database.") == {} and _history(db, "database.") == set()


async def test_puts_at_once_go_one_at_a_time_and_the_last_one_wins(db):
    await asyncio.gather(_put(va.put_build_policy, {"buildMaxAttempts": 4}),
                         _put(va.put_build_policy, {"buildMaxAttempts": 5}))
    (row,) = query(db, "SELECT value, version FROM setting_values "
                       "WHERE key = 'builds.maxAttempts' AND scope = 'platform'")
    assert row.value in (4, 5) and row.version == 2
    assert len(_history(db, "builds.maxAttempts")) == 2
