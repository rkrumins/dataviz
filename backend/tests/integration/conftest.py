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
    """
    from backend.app.services.versioning import db as gvdb

    gvdb._engine = None
    gvdb._session_factory = None
    yield
