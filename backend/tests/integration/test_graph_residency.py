"""Graph residency against Postgres, Redis and this lane's FalkorDB (doc 17).

Needs ``GRAPHVER_E2E=1`` and the live services; the FalkorDB cases also ``RUN_FALKOR_LIVE=1``.
Each case puts the platform settings row back as it found it.
"""
from __future__ import annotations

import os

import pytest

from backend.app.db.engine import get_async_session
from backend.app.db.models import PlatformSettingsORM
from backend.app.services.versioning import db, models, residency_policy
from backend.app.services.versioning.messaging import close_broker_redis
from backend.app.services.versioning.models import ProjectionStateORM
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + live Postgres + Redis to run")


async def _set_policy(**columns) -> dict:
    """Save policy columns on the platform settings row; returns what they were."""
    async with get_async_session() as s:
        row = await s.get(PlatformSettingsORM, 1)
        if row is None:
            row = PlatformSettingsORM(id=1)
            s.add(row)
        before = {name: getattr(row, name) for name in columns}
        for name, value in columns.items():
            setattr(row, name, value)
        await s.commit()
    residency_policy.invalidate()
    return before


@pytest.fixture
async def store():
    await models.create_schema_and_partitions()
    yield GraphVersioningService()
    residency_policy.invalidate()
    await close_broker_redis()
    await db.dispose_engine()


async def _residency(gid: str) -> str:
    async with db.graphver_session() as s:
        return (await s.get(ProjectionStateORM, gid)).residency


async def test_a_new_graph_gets_the_class_the_policy_names(store):
    svc = store
    before = await _set_policy(gv_default_residency="coldline")
    try:
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                      workspace_id="ws_res", actor="a"))["graph_id"]
        assert await _residency(gid) == "coldline"
        await _set_policy(gv_default_residency=None)
        other = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                        workspace_id="ws_res", actor="a"))["graph_id"]
        assert await _residency(other) == "standard"
    finally:
        await _set_policy(**before)
