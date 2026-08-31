"""``project_pending`` must retry a graph whose projection FAILED, not only one that lags.

THE OUTAGE (fixed in 6fcf2d6f / 51b9dae9, previously untested). The retry select was
``projected_commit_seq < target_commit_seq``. But the failure path deliberately holds
BOTH counters at the last good seq, so a graph that fails to verify comes to rest at
``projected == target``, below its committed ``main_head_commit_seq`` — a state where
that predicate is permanently false. Meanwhile the read path's freshness check is
``projected >= main_head`` (service.py), which stays false forever, so every main read
routes to Postgres, which serves no rollups. Nothing in the system could select the row
again: escaping took a hand-written UPDATE, 14 hours later.

Lag must therefore be measured against the COMMITTED HEAD. Needs Postgres.
"""
import asyncio
import os

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


async def _set_counters(gid: str, projected: int, target: int) -> None:
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        ps.projected_commit_seq = projected
        ps.target_commit_seq = target


async def _selected_ids(proj: FalkorProjector) -> list:
    """Run the real ``project_pending`` select with the per-graph work stubbed out — the
    predicate is what is under test, and the shared dev Postgres must not be projected."""
    picked: list = []

    async def _record(gid, *a, **kw):
        picked.append(gid)
        return {"graph_id": gid, "noop": True}

    proj.project_graph = _record
    await proj.project_pending()
    return picked


async def _run_wedged_graph_is_reselected() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    proj = FalkorProjector(graph_client_factory=FakeFalkor())
    gid, head = await _seed_published_pinned(svc, "gvt_" + os.urandom(3).hex())

    # THE WEDGE, exactly as the failure path leaves it: both counters pinned at the last
    # good seq, below the committed head. `projected < target` is FALSE here forever.
    # Re-armed per attempt because the dev viz-service runs its own projection poll every
    # 5s and may catch up the row between our write and our select.
    for _ in range(3):
        await _set_counters(gid, projected=0, target=0)
        if gid in await _selected_ids(proj):
            break
    else:
        pytest.fail(
            "a graph at projected == target < main_head was NOT re-selected by "
            "project_pending — it can never be retried, the read path's "
            "`projected >= main_head` stays false, and every main read falls back to "
            "Postgres until someone writes an UPDATE by hand"
        )

    # …and a genuinely caught-up graph is still left alone (the select did not simply
    # become "everything", which would make the assertion above meaningless).
    await _set_counters(gid, projected=head, target=head)
    assert gid not in await _selected_ids(proj), (
        "a fresh graph was queued for re-projection — project_pending must not churn"
    )
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_project_pending_reselects_a_failed_projection_e2e():
    asyncio.run(_run_wedged_graph_is_reselected())
