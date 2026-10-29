"""A projection that FAILED is retried by ``project_pending`` and reaches the committed head.

THE OUTAGE. The retry select was ``projected_commit_seq < target_commit_seq``, and the failure
path held BOTH counters at the last good seq, so a graph that failed to verify came to rest at
``projected == target`` below its committed ``main_head_commit_seq``. Meanwhile the read path's
freshness check is ``projected >= main_head`` (service.py), which stayed false forever, so every
main read routed to Postgres, which serves no rollups. Escaping took a hand-written UPDATE,
14 hours later. Selecting on the head (6fcf2d6f / 51b9dae9) re-selected the graph, but the pass
still projected only up to the pinned target: a no-op, every poll, forever.

So a pass aims at ``max(target, head)``, a failure leaves ``target`` alone and backs off
(``failed_attempts`` / ``next_retry_at``), and the retry after the backoff applies the window.
Runs the real ``project_graph`` over FakeFalkor. Needs Postgres.
"""
import asyncio
import os
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService

from backend.tests.integration.test_versioning_projection import (
    FakeFalkor,
    _edit_publish,
    _node,
)


async def _seed_published_pinned(svc, name: str) -> tuple:
    """A graph pinned to a REAL FalkorDB target (unpinned graphs are never projected)
    with two nodes published to main. Returns ``(graph_id, main_head_commit_seq)``."""
    G = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name)
    gid = G["graph_id"]
    await _edit_publish(svc, gid, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": _node("Alpha")},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": _node("Beta")},
    ], "seed")
    async with db.graphver_session() as s:
        head = (await s.get(GraphORM, gid)).main_head_commit_seq
    assert head > 0, "premise: the publish must advance the committed head"
    return gid, head


async def _counters(gid: str) -> tuple:
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        return ps.projected_commit_seq, ps.target_commit_seq


async def _pending(proj: FalkorProjector, gid: str) -> list:
    """Run the real ``project_pending`` select; only this test's graph is projected — the shared
    dev Postgres holds other graphs."""
    picked: list = []
    real = proj.project_graph

    async def _only_ours(g, *a, **kw):
        picked.append(g)
        return await real(g) if g == gid else {"graph_id": g, "noop": True}

    proj.project_graph = _only_ours
    try:
        await proj.project_pending(limit=100_000)
    finally:
        proj.project_graph = real
    return [g for g in picked if g == gid]


async def _run_failed_projection_reaches_the_head() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    proj = FalkorProjector(graph_client_factory=FakeFalkor())
    gid, head = await _seed_published_pinned(svc, "gvt_" + os.urandom(3).hex())
    start, _ = await _counters(gid)

    # One verify that finds an extra entity: the pass is held back.
    real_counts = proj._falkor_counts

    async def _extra(client, owned=True):
        n, e = await real_counts(client, owned)
        return n + 1, e
    proj._falkor_counts = _extra
    r = await proj.project_graph(gid)
    assert r["verify_error"], r
    assert await _counters(gid) == (start, head), "held back, with the target left at the head"

    # The cause is gone. Within the backoff the poll leaves the graph alone; after it, the retry
    # APPLIES the window — no new commit needed.
    del proj._falkor_counts
    assert await _pending(proj, gid) == []
    async with db.graphver_session() as s:
        (await s.get(ProjectionStateORM, gid)).next_retry_at = (
            datetime.now(timezone.utc) - timedelta(seconds=1)).isoformat()
    assert await _pending(proj, gid) == [gid]
    assert (await _counters(gid))[0] == head, (
        "a graph held back below main_head never caught up — every main read stays on Postgres "
        "until someone writes an UPDATE by hand")

    # …and a caught-up graph is left alone (the select did not simply become "everything").
    assert await _pending(proj, gid) == [], "project_pending must not churn"
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_a_failed_projection_reaches_the_head_after_its_backoff_e2e():
    asyncio.run(_run_failed_projection_reaches_the_head())
