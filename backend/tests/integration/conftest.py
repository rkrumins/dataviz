"""Session cleanup for the versioning integration suite.

These tests share the dev Postgres with a LIVE viz-service whose projection worker polls
every graph where ``projected < target``. Tests that pin a FalkorDB name (the ``gvt_*``
convention) and finish lagging — evicted states, never-projected seeds — would otherwise be
picked up by that worker and materialised as tiny orphan keys in the real FalkorDB. Unpin
every ``gvt_*`` row at session end (unpinned graphs are never projected) and best-effort
drop any ``gvt_*`` keys the worker already created during the run.
"""
import asyncio
import os

import pytest


async def _cleanup() -> None:
    from sqlalchemy import select
    from backend.app.services.versioning import db as gvdb
    from backend.app.services.versioning.models import ProjectionStateORM

    async with gvdb.graphver_session() as s:
        rows = (await s.execute(
            select(ProjectionStateORM).where(
                ProjectionStateORM.falkor_graph_name.like("gvt_%")))).scalars().all()
        for ps in rows:
            ps.falkor_graph_name = None
    try:                                                 # best-effort: FalkorDB may be absent
        from redis.asyncio import ConnectionPool
        from falkordb.asyncio import FalkorDB

        pool = ConnectionPool(
            host=os.getenv("FALKORDB_HOST", "localhost"),
            port=int(os.getenv("FALKORDB_PORT", "6379")), max_connections=2)
        handle = FalkorDB(connection_pool=pool)
        for key in await handle.list_graphs():
            name = key.decode() if isinstance(key, bytes) else key
            if name.startswith("gvt_"):
                try:
                    await handle.select_graph(name).delete()
                except Exception:
                    pass
    except Exception:
        pass


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session, exitstatus):
    if os.getenv("GRAPHVER_E2E") != "1":
        return
    try:
        asyncio.run(_cleanup())
    except Exception:
        pass


@pytest.fixture(autouse=True)
def _fresh_graphver_engine():
    """Start every test on a fresh versioning engine.

    Each e2e test runs its own event loop (``asyncio.run``), and the versioning engine is a
    module-level cache whose pooled connections belong to the loop that opened them. A test
    that fails before its own ``dispose_engine()`` would hand the next test connections on a
    closed loop ("attached to a different loop"), failing it for no reason of its own.
    The management engines, the broker client and the process-wide FalkorDB client
    cache are cached the same way, so they are reset too.
    """
    from backend.app.db import engine as mgmt_engine
    from backend.app.providers import falkordb_connection
    from backend.app.services.versioning import db as gvdb
    from backend.app.services.versioning import messaging

    gvdb._engine = None
    gvdb._session_factory = None
    mgmt_engine._engines.clear()
    mgmt_engine._session_factories.clear()
    messaging._client = None
    falkordb_connection._GRAPH_CLIENTS = falkordb_connection.TopologyGraphClients()
    yield


@pytest.fixture(autouse=True)
def _keep_revocation_service():
    """Some harnesses stub ``get_revocation_service`` in place (no Redis here) and never put it
    back. Restore it after each test, so a later test in the same run that authenticates for real
    still gets a revocation check it can await."""
    from backend.app.auth import dependencies as deps

    original = deps.get_revocation_service
    yield
    deps.get_revocation_service = original


@pytest.fixture
def data_sources(monkeypatch):
    """POST /graphs resolves its data source in the management DB and pins the new graph to that
    data source's FalkorDB graph. The harnesses post ids that exist nowhere: here every id answers
    as a data source in ``ws1``, pinned to the graph name this dict maps it to (unpinned if none)."""
    from types import SimpleNamespace
    from backend.app.db.repositories import data_source_repo

    pins: dict = {}

    async def get_data_source_orm(session, data_source_id, **_kw):
        return SimpleNamespace(id=data_source_id, workspace_id="ws1",
                               graph_name=pins.get(data_source_id), provider_id=None)

    monkeypatch.setattr(data_source_repo, "get_data_source_orm", get_data_source_orm)
    return pins
