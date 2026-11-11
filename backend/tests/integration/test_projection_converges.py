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
- A node whose urn changes moves to the new urn in place, with its edges, and the pass publishes:
  nothing is left under the old urn for the verify to hold it back for.
- The tombstone sweep clears a node main deleted that the cache still holds, and records how far
  it swept (``sweptSeq``), so the next sweep reads only later deletes.
- An entity whose every statement times out, even alone, is quarantined: the rest of its window
  lands and publishes, unverified, and the watermark lists it. A rebuild meanwhile holds it again,
  and hands the rollups to the aggregation job. Once the fault clears, the caught-up graph gets a
  pass of its own when the entity is due, which lands it and verifies again. With
  ``GRAPHVER_PROJECTION_QUARANTINE`` off, it fails the pass, as before.
- A paged window, and a streamed rebuild, under a pass time box that stops each pass after one
  page, resume from their cursor pass after pass until one publishes the whole of it.
- Drift a window cannot explain holds the pass back and rebuilds the graph on its own, and the
  third pressure failure in a row of one window does too; the rebuild then publishes.
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


async def _urn_change_and_sweep(svc):
    fake = TimeoutFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [
        _create("A", "a"), _create("B", "b"), _create("C", "c"),
        _link("AB", "A", "B"), _link("CA", "C", "A")], "seed")
    assert (await proj.project_graph(gid))["verify_error"] is None
    g = fake.graphs[next(iter(fake.graphs))]

    # A's urn changes: its node moves to the new urn with both its edges, and nothing is left
    # under the old one for the verify to hold the pass back for.
    await _edit_publish(svc, gid, "alice", [
        {"op": "update", "entity_kind": "node", "entity_id": "A",
         "payload": {"urn": "urn:t:A2"}}], "re-key A")
    proj._verified_at.clear()
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and not r["noop"], r
    assert "urn:t:A" not in g.nodes and g.nodes["urn:t:A2"]["entityId"] == "A"
    assert {(e["src"], e["tgt"]) for e in g.edges.values()} == {
        ("urn:t:A2", "urn:t:B"), ("urn:t:C", "urn:t:A2")}
    await _assert_matches_main(svc, fake, gid)

    # A node main deleted that the cache still holds is swept, and the sweep records how far it
    # has swept, so the next one reads only the deletes after it.
    await _edit_publish(svc, gid, "alice", [
        {"op": "delete", "entity_kind": "node", "entity_id": "B", "payload": None}], "drop B")
    assert (await proj.project_graph(gid))["verify_error"] is None
    g.nodes["urn:t:B"] = {"urn": "urn:t:B", "entityId": "B", "_label": "Dataset"}   # stranded
    g._id_of("urn:t:B")
    await _edit_publish(svc, gid, "alice", [_create("D", "d")], "one more")
    proj._verified_at.clear()
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None, r
    assert "urn:t:B" not in g.nodes
    assert g.swept_seq == r["projected"]
    await _assert_matches_main(svc, fake, gid)


async def _quarantine(svc, monkeypatch):
    from sqlalchemy import select, update

    from backend.app.services.versioning import config
    from backend.app.services.versioning.models import ProjectionQuarantineORM, ProjectionStateORM

    fake = TimeoutFalkor(poison={"urn:t:P"})
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [
        _create("A", "a"), _create("B", "b"), _link("AB", "A", "B")], "seed")
    assert (await proj.project_graph(gid))["verify_error"] is None
    g = fake.graphs[next(iter(fake.graphs))]

    # P's every statement times out, however small: it is held, and the rest of the window lands.
    await _edit_publish(svc, gid, "alice", [
        _create("P", "p"), _create("C", "c"), _link("PC", "P", "C"), _link("AC", "A", "C")],
        "with a poison entity")
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and r["unverified"] and r["quarantined"] == 2, r
    assert await _watermark(gid) == r["projected"]
    assert "urn:t:C" in g.nodes and "urn:t:P" not in g.nodes
    async with db.graphver_session() as s:
        held = {(q.statement, q.entity_key) for q in (await s.execute(
            select(ProjectionQuarantineORM).where(ProjectionQuarantineORM.graph_id == gid))).scalars()}
    assert held == {("node_merge", "urn:t:P"), ("edge_merge", "PC")}, held
    wm = await svc.projection_watermark(gid)
    assert wm["quarantine"]["count"] == 2 and wm["quarantine"]["entities"][0]["error"]

    # A rebuild while they are held hands the rollups to the job: they moved with P's window, which
    # the key lacked, so moving them by the rebuild's difference would count P's edge twice.
    stale = []

    async def rollups_stale(graph_id):
        stale.append(graph_id)

    proj._on_rollups_stale = rollups_stale
    assert await svc.request_projection_rebuild(gid)
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and r["quarantined"] == 2 and stale == [gid], (r, stale)
    proj._on_rollups_stale = None

    # The fault clears: a caught-up graph's held entities get a pass of their own once due.
    g.poison.clear()
    assert (await proj.project_graph(gid))["noop"], "not due yet"
    async with db.graphver_session() as s:
        due = (await s.get(ProjectionStateORM, gid)).quarantine_next_at
        assert due and due > "2026", due
        await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                        .values(quarantine_next_at="2000-01-01T00:00:00+00:00"))
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and not r.get("quarantined") and not r.get("unverified"), r
    assert (await svc.projection_watermark(gid))["quarantine"] is None
    async with db.graphver_session() as s:
        assert (await s.get(ProjectionStateORM, gid)).quarantine_next_at is None
    await _assert_matches_main(svc, fake, gid)

    # Off, a stuck entity fails the pass, as before.
    monkeypatch.setattr(config, "PROJECTION_QUARANTINE", False)
    g.poison.add("urn:t:Q")
    await _edit_publish(svc, gid, "alice", [_create("Q", "q")], "another")
    with pytest.raises(Exception, match="Query timed out"):
        await proj.project_graph(gid)


async def _resumable_and_self_healing(svc, monkeypatch):
    from sqlalchemy import update

    from backend.app.services.versioning import config
    from backend.app.services.versioning.models import ProjectionStateORM

    fake = TimeoutFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [_create("A", "a")], "seed")
    assert (await proj.project_graph(gid))["verify_error"] is None
    g = fake.graphs[next(iter(fake.graphs))]

    # A window too large to hold, written a page at a time, and a pass time box so short that each
    # pass stops after one page: each resumes where the last stopped, until one publishes.
    monkeypatch.setattr(config, "PROJECTION_PAGED_ABOVE", 10)
    monkeypatch.setattr(config, "PROJECTION_PAGE", 20)
    monkeypatch.setattr(config, "PROJECTION_PASS_MAX_SECS", 1e-6)
    await _edit_publish(svc, gid, "alice", [
        *(_create(f"W{i}", f"w{i}") for i in range(60)),
        *(_link(f"WL{i}", f"W{i}", "A") for i in range(60))], "a paged window")
    before, passes = await _watermark(gid), []
    while True:
        r = await proj.project_graph(gid)
        passes.append(r)
        if not r.get("partial"):
            break
        assert await _watermark(gid) == before and g.cursor["from"] == before, (r, g.cursor)
        assert len(passes) < 20
    assert r["verify_error"] is None and len(passes) >= 4, passes
    assert g.cursor is None
    await _assert_matches_main(svc, fake, gid)

    # A rebuild too large to hold, a page at a time: the same.
    monkeypatch.setattr(config, "PROJECTION_RECONCILE_STREAMED_ABOVE", 5)
    monkeypatch.setattr(FalkorProjector, "_SCAN_PAGE", 25)
    for k in [k for k in g.nodes if k.startswith("urn:t:W")][:5]:
        g._drop_node(k)                                  # some of it lost
    assert await svc.request_projection_rebuild(gid)
    passes = []
    while True:
        r = await proj.project_graph(gid)
        passes.append(r)
        if not r.get("partial"):
            break
        assert len(passes) < 40
    assert r["verify_error"] is None and len(passes) >= 3, passes
    await _assert_matches_main(svc, fake, gid)
    monkeypatch.setattr(config, "PROJECTION_PASS_MAX_SECS", 0)

    # Drift a window cannot explain: the pass holds back and the graph is rebuilt on its own.
    g._drop_node("urn:t:A")
    await _edit_publish(svc, gid, "alice", [_create("B", "b")], "one more")
    proj._verified_at.clear()
    r = await proj.project_graph(gid)
    assert r["verify_error"] and "rebuilding in place" in r["verify_error"], r
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        assert (ps.projected_commit_seq, ps.status) == (0, "rebuilding"), (ps.projected_commit_seq,
                                                                          ps.status)
        assert ps.last_error.startswith("rebuilding on its own"), ps.last_error
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and not r["noop"], r
    await _assert_matches_main(svc, fake, gid)

    # A window that keeps failing under pressure the ladder cannot absorb (nothing held back):
    # its third failure in a row rebuilds the graph, which projects once the store takes it.
    monkeypatch.setattr(config, "PROJECTION_QUARANTINE", False)
    g.poison.add("urn:t:Z")
    await _edit_publish(svc, gid, "alice", [_create("Z", "z")], "a heavy one")
    async with db.graphver_session() as s:
        await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                        .values(failed_attempts=2))
    with pytest.raises(Exception, match="Query timed out"):
        await proj.project_graph(gid)
    async with db.graphver_session() as s:
        ps = await s.get(ProjectionStateORM, gid)
        assert (ps.projected_commit_seq, ps.failed_attempts, ps.next_retry_at) == (0, 0, None)
    g.poison.clear()
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None, r
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
            await _urn_change_and_sweep(svc)
            await _quarantine(svc, monkeypatch)
            await _resumable_and_self_healing(svc, monkeypatch)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
