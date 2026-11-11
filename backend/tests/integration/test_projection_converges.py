"""A projection converges in one pass whatever size of statement FalkorDB can take (live Postgres,
the timing-out fake in ``_fake_falkor``).

Pins:
- A graph whose statements time out above 70 rows is seeded, and then takes a large window of
  creates, updates and deletes, each in one pass. The pass publishes, FalkorDB equals main, and
  its ``stats`` show the statements it split.
- A hub, a node with more relationships than one statement can delete, is deleted: its
  relationships go a page at a time, then the node, and the pass publishes.
- An edge created and deleted inside one window, which an earlier failed attempt at the window
  wrote, is deleted where that attempt put it, anchored on its ends: no statement scans the
  graph's relationships for an id.
- A graph backing off after a failed pass is left alone by a nudge or ``project_now``
  (``respect_backoff=True``), and projected by a rebuild. ``fits_inline`` counts the window no
  further than its limit.
- A verify that cannot count publishes, but answers ``unverified`` and is not taken as a clean
  one, so the next pass verifies again.
"""
from __future__ import annotations

import asyncio
import os

import pytest

from backend.app.services.versioning import db, models, projection
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration._fake_falkor import TimeoutFalkor
from backend.tests.integration.test_versioning_projection import (
    _assert_matches_main, _edge, _edit_publish, _node, _watermark,
)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")


def _create(eid, name):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {**_node(name), "urn": f"urn:t:{eid}"}}


def _link(eid, src, tgt):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid, "payload": _edge(src, tgt)}


async def _graph(svc):
    name = "gvt_" + os.urandom(3).hex()
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="alice", falkor_graph_name=name, owns_falkor_graph=True)
    return g["graph_id"]


async def _converges(svc):
    fake = TimeoutFalkor(max_rows=70)
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    n = 600
    await _edit_publish(svc, gid, "alice", [
        *(_create(f"N{i}", f"n{i}") for i in range(n)),
        *(_link(f"E{i}", f"N{i}", f"N{(i + 1) % n}") for i in range(n)),
    ], "seed")
    seeded = await proj.project_graph(gid)
    assert not seeded["noop"] and seeded["verify_error"] is None, seeded
    assert seeded["stats"]["shrinks"] > 0 and seeded["stats"]["minWidth"] <= 70, seeded["stats"]
    await _assert_matches_main(svc, fake, gid)

    # One window: 300 updates, 300 new nodes and edges, 150 deleted edges and 100 deleted nodes.
    await _edit_publish(svc, gid, "alice", [
        *({"op": "update", "entity_kind": "node", "entity_id": f"N{i}",
           "payload": {"displayName": f"n{i}-v2"}} for i in range(300)),
        *(_create(f"M{i}", f"m{i}") for i in range(300)),
        *(_link(f"F{i}", f"M{i}", f"N{i}") for i in range(300)),
        *({"op": "delete", "entity_kind": "edge", "entity_id": f"E{i}", "payload": None}
          for i in range(300, 450)),
        *({"op": "delete", "entity_kind": "node", "entity_id": f"N{i}", "payload": None}
          for i in range(500, 600)),
    ], "a large window")
    window = await proj.project_graph(gid)
    assert not window["noop"] and window["verify_error"] is None, window
    assert window["stats"]["shrinks"] > 0, window["stats"]
    assert await _watermark(gid) == window["projected"]
    g = await _assert_matches_main(svc, fake, gid)
    assert g.node("N0")["displayName"] == "n0-v2"

    # The widths that worked are kept: the next window of the same shape splits far less.
    first = g.timeouts
    await _edit_publish(svc, gid, "alice", [
        {"op": "update", "entity_kind": "node", "entity_id": f"N{i}",
         "payload": {"displayName": f"n{i}-v3"}} for i in range(300)], "the same again")
    again = await proj.project_graph(gid)
    assert again["verify_error"] is None, again
    assert g.timeouts - first < first / 4, (first, g.timeouts - first)
    await _assert_matches_main(svc, fake, gid)


async def _hub(svc):
    fake = TimeoutFalkor(hub_degree=50)
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [
        _create("HUB", "hub"),
        *(_create(f"L{i}", f"leaf{i}") for i in range(120)),
        *(_link(f"H{i}", "HUB", f"L{i}") for i in range(120)),
    ], "a hub")
    assert (await proj.project_graph(gid))["verify_error"] is None
    await _edit_publish(svc, gid, "alice", [
        {"op": "delete", "entity_kind": "node", "entity_id": "HUB", "payload": None}], "drop it")
    r = await proj.project_graph(gid)
    assert not r["noop"] and r["verify_error"] is None, r
    g = await _assert_matches_main(svc, fake, gid)
    assert "HUB" not in g.entity_ids() and not g.edges


async def _created_and_deleted_in_one_window(svc):
    fake = TimeoutFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [_create("A", "a"), _create("B", "b")], "ends")
    assert (await proj.project_graph(gid))["verify_error"] is None
    await _edit_publish(svc, gid, "alice", [_link("X", "A", "B")], "add X")
    await _edit_publish(svc, gid, "alice", [
        {"op": "delete", "entity_kind": "edge", "entity_id": "X", "payload": None}], "drop X")
    # An earlier attempt at this window wrote X, then failed before the delete.
    g = fake.graphs[next(iter(fake.graphs))]
    g.edges["X"] = {"src": "urn:t:A", "tgt": "urn:t:B", "type": "FLOWS_TO", "props": "{}",
                    "conf": None, "gvHash": 0}
    g.cyphers.clear()
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None, r
    assert "X" not in g.edges
    assert not any("MATCH ()-[r {id:" in c or "MATCH ()-[r]->() WHERE id(r)" in c
                   for c in g.cyphers), [c for c in g.cyphers if "()-[r" in c]
    await _assert_matches_main(svc, fake, gid)


async def _backoff_and_honest_verify(svc):
    from sqlalchemy import update

    from backend.app.services.versioning.models import ProjectionStateORM

    fake = TimeoutFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [_create("A", "a")], "one")
    assert (await proj.project_graph(gid))["verify_error"] is None
    await _edit_publish(svc, gid, "alice", [_create("B", "b"), _create("C", "c")], "two")
    before = await _watermark(gid)

    # A graph backing off is left alone by a nudge or project_now, and not by a rebuild.
    async with db.graphver_session() as s:
        await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                        .values(next_retry_at="2999-01-01T00:00:00+00:00", failed_attempts=2))
    r = await proj.project_graph(gid, respect_backoff=True)
    assert r["skipped"] == "backoff" and r["noop"], r
    assert await _watermark(gid) == before
    assert not await proj.fits_inline(gid, limit=1)          # two version rows to project
    assert await proj.fits_inline(gid, limit=2)
    r = await proj.project_graph(gid)                         # a rebuild, a load: at once
    assert r["verify_error"] is None and not r["noop"], r
    assert await proj.fits_inline(gid, limit=0)               # caught up

    # A verify that cannot count publishes, but is not taken as a clean one.
    await _edit_publish(svc, gid, "alice", [_create("D", "d")], "three")

    async def cannot_count(*_a, **_k):
        raise Exception("Query timed out")

    proj._verified_at.clear()
    proj._falkor_counts = cannot_count
    r = await proj.project_graph(gid)
    assert r["unverified"] and r["verify_error"] is None, r
    assert gid not in proj._verified_at
    await _assert_matches_main(svc, fake, gid)


def test_a_projection_converges_in_one_pass_whatever_its_statements_can_take(monkeypatch):
    async def no_wait(_seconds):
        return None

    monkeypatch.setattr(projection, "_sleep", no_wait)
    projection._WIDTHS.clear()

    async def run():
        await models.create_schema_and_partitions()
        svc = GraphVersioningService()
        try:
            await _converges(svc)
            await _hub(svc)
            await _created_and_deleted_in_one_window(svc)
            await _backoff_and_honest_verify(svc)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
