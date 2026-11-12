"""A projection converges in one pass whatever size of statement FalkorDB can take (live Postgres,
the timing-out fake in ``_fake_falkor``).

Pins:
- A graph whose statements time out above 70 rows is seeded, and then takes a large window of
  creates, updates and deletes, each in one pass. The pass publishes, FalkorDB equals main, and
  its ``stats`` show the statements it split.
- A hub, a node with more relationships than one statement can delete, is deleted: its
  relationships go a page at a time, then the node, and the pass publishes. So is a hub main deleted
  that the key still holds, by the tombstone sweep, and a hub main never held, by a rebuild of a
  graph too large to hold.
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
  lands and publishes, unverified, and the watermark lists it. An edge of a held node the key
  lacks is held with it, and stays held while the node's retry fails. A rebuild meanwhile holds
  them again, and hands the rollups to the aggregation job, even when the rebuild that cleared what
  was held failed before it published. Once the fault clears, the caught-up graph gets a pass of
  its own when the entity is due, which lands it, then its edge, and verifies again. With
  ``GRAPHVER_PROJECTION_QUARANTINE`` off, it fails the pass, as before.
- A held update of a node the key holds keeps its edges: an edge to it, in its window or a later
  one, is written, and only the update is held.
- A held delete of an edge where it was is kept when the edge is written where it now is, and
  lands once the fault clears.
- A paged window, and a streamed rebuild, under a pass time box that stops each pass after one
  page, resume from their cursor pass after pass until one publishes the whole of it. A resumed
  rebuild retries what its earlier passes held, rather than dropping it.
- Drift a window cannot explain holds the pass back and rebuilds the graph on its own, and the
  third pressure failure in a row of one window does too; the rebuild then publishes. A window that
  moved the lineage summaries before it escalated owes its rebuild them
  (``projection_state.rollup_state.moved``), which an ask recorded meanwhile keeps: the rebuild
  hands them to the job rather than moving them by its difference, and its publish clears it.
- A summaries state that is not a JSON object (the JSON ``null`` a cleared ask left before) owes
  nothing: an ask is recorded over it, a window publishes over it, and what an escalation or a
  rebuild that clears what is held owes over it is an object, handed over and cleared as above. A
  cleared ask leaves SQL NULL.
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


async def _stale_hubs(svc, monkeypatch):
    from backend.app.services.versioning import config

    fake = TimeoutFalkor(hub_degree=50)
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [
        _create("HUB", "hub"),
        *(_create(f"L{i}", f"leaf{i}") for i in range(120)),
        *(_link(f"H{i}", "HUB", f"L{i}") for i in range(120)),
    ], "a hub")
    assert (await proj.project_graph(gid))["verify_error"] is None
    g = fake.graphs[next(iter(fake.graphs))]
    hub, spokes = dict(g.nodes["urn:t:HUB"]), {k: dict(e) for k, e in g.edges.items()}
    await _edit_publish(svc, gid, "alice", [
        {"op": "delete", "entity_kind": "node", "entity_id": "HUB", "payload": None}], "drop it")
    assert (await proj.project_graph(gid))["verify_error"] is None

    # The key holds the hub main deleted again, with its relationships (a restored snapshot): the
    # tombstone sweep deletes them a page at a time, then the hub, and the pass publishes.
    g.nodes["urn:t:HUB"] = hub
    g._id_of("urn:t:HUB")
    g.edges.update(spokes)
    await _edit_publish(svc, gid, "alice", [_create("D", "d")], "one more")
    proj._verified_at.clear()
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and not r.get("quarantined"), r
    assert "urn:t:HUB" not in g.nodes and not g.edges
    await _assert_matches_main(svc, fake, gid)

    # A rebuild of a graph too large to hold, whose key holds a hub main never had: the same.
    streamed_above = config.PROJECTION_RECONCILE_STREAMED_ABOVE
    monkeypatch.setattr(config, "PROJECTION_RECONCILE_STREAMED_ABOVE", 5)
    g.nodes["urn:t:STALE"] = {**hub, "urn": "urn:t:STALE", "entityId": "STALE"}
    g._id_of("urn:t:STALE")
    g.edges.update({f"S{i}": {**e, "src": "urn:t:STALE"} for i, e in enumerate(spokes.values())})
    assert await svc.request_projection_rebuild(gid)
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and not r["noop"], r
    assert "urn:t:STALE" not in g.nodes and not g.edges
    await _assert_matches_main(svc, fake, gid)
    monkeypatch.setattr(config, "PROJECTION_RECONCILE_STREAMED_ABOVE", streamed_above)


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

    async def make_due():
        async with db.graphver_session() as s:
            await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                            .values(quarantine_next_at="2000-01-01T00:00:00+00:00"))

    async def held_rows():
        async with db.graphver_session() as s:
            return {(q.statement, q.entity_key): q.error for q in (await s.execute(
                select(ProjectionQuarantineORM)
                .where(ProjectionQuarantineORM.graph_id == gid))).scalars()}

    async def owed():
        async with db.graphver_session() as s:
            return ((await s.get(ProjectionStateORM, gid)).rollup_state or {}).get("moved")

    # P's every statement times out, however small: it is held, and the rest of the window lands.
    # Its edge PC, which would match no node, is held with it.
    await _edit_publish(svc, gid, "alice", [
        _create("P", "p"), _create("C", "c"), _link("PC", "P", "C"), _link("AC", "A", "C")],
        "with a poison entity")
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and r["unverified"] and r["quarantined"] == 2, r
    assert await _watermark(gid) == r["projected"]
    assert "urn:t:C" in g.nodes and "urn:t:P" not in g.nodes
    held = await held_rows()
    pc = ("edge_merge", "PC@FLOWS_TO:urn:t:P->urn:t:C")
    assert set(held) == {("node_merge", "urn:t:P"), pc}, held
    assert "end node is held" in held[pc], held
    wm = await svc.projection_watermark(gid)
    assert wm["quarantine"]["count"] == 2 and wm["quarantine"]["entities"][0]["error"]

    # Unloaded, nothing retries them: neither the gauge nor the watermark counts them.
    from backend.app.jobs import metrics

    gauges = {}
    monkeypatch.setattr(metrics, "gauge_set", lambda name, value, **_k: gauges.update({name: value}))

    async def status(to):
        async with db.graphver_session() as s:
            await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                            .values(status=to))

    for _ in range(3):                       # other graphs' rows may come and go meanwhile
        await proj._report_lag()
        loaded = gauges["graphver_projection_quarantined"]
        await status("evicted")
        await proj._report_lag()
        unloaded = gauges["graphver_projection_quarantined"]
        await status("idle")
        if loaded - unloaded == 2:
            break
    assert loaded - unloaded == 2, (loaded, unloaded)
    await status("evicted")
    assert (await svc.projection_watermark(gid))["quarantine"] is None
    await status("idle")

    # Due while P still fails: PC is not tried without it, and stays held.
    await make_due()
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and r["quarantined"] == 2, r
    assert set(await held_rows()) == {("node_merge", "urn:t:P"), pc}

    # A rebuild while they are held hands the rollups to the job: they moved with P's window, which
    # the key lacked, so moving them by the rebuild's difference would count P's edge twice. The
    # rebuild that cleared the rows owes the job that until one publishes, though it fails first.
    stale = []

    async def rollups_stale(graph_id):
        stale.append(graph_id)

    proj._on_rollups_stale = rollups_stale
    reconcile = proj._reconcile_in_place

    async def fails(*_a, **_k):
        raise Exception("Query timed out")

    proj._reconcile_in_place = fails
    assert await svc.request_projection_rebuild(gid)
    with pytest.raises(Exception, match="Query timed out"):
        await proj.project_graph(gid)
    assert not await held_rows() and await owed()
    moved = []

    async def records(*a, **k):
        moved.append(k.get("rollups_moved_this_pass"))
        return await reconcile(*a, **k)

    proj._reconcile_in_place = records
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and r["quarantined"] == 2 and stale == [gid], (r, stale)
    assert moved == [True] and not await owed(), moved
    proj._reconcile_in_place = reconcile
    proj._on_rollups_stale = None

    # The fault clears: a caught-up graph's held entities get a pass of their own once due.
    g.poison.clear()
    assert (await proj.project_graph(gid))["noop"], "not due yet"
    async with db.graphver_session() as s:
        due = (await s.get(ProjectionStateORM, gid)).quarantine_next_at
        assert due and due > "2026", due
    await make_due()
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


async def _held_delete_where_an_edge_was(svc):
    from sqlalchemy import update

    from backend.app.services.versioning.models import ProjectionStateORM

    fake = TimeoutFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [
        _create("A", "a"), _create("B", "b"), _create("C", "c"), _link("E", "A", "B")], "seed")
    assert (await proj.project_graph(gid))["verify_error"] is None
    g = fake.graphs[next(iter(fake.graphs))]

    # E moves from A->B to A->C: written where it now is, and its delete where it was times out,
    # even alone, and is held.
    g.poison.add("urn:t:A->urn:t:B")
    await _edit_publish(svc, gid, "alice", [
        {"op": "update", "entity_kind": "edge", "entity_id": "E", "payload": _edge("A", "C")}],
        "move E")
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and r["quarantined"] == 1, r

    # E written again where it now is supersedes nothing where it was: the delete stays held.
    await _edit_publish(svc, gid, "alice", [
        {"op": "update", "entity_kind": "edge", "entity_id": "E",
         "payload": {**_edge("A", "C"), "properties": {"tier": "gold"}}}], "touch E")
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and r["quarantined"] == 1, r

    # The fault clears: the delete lands once due.
    g.poison.clear()
    async with db.graphver_session() as s:
        await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                        .values(quarantine_next_at="2000-01-01T00:00:00+00:00"))
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and not r.get("quarantined"), r
    await _assert_matches_main(svc, fake, gid)


async def _a_held_update_keeps_its_edges(svc):
    from sqlalchemy import select, update

    from backend.app.services.versioning.models import ProjectionQuarantineORM, ProjectionStateORM

    fake = TimeoutFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [
        _create("A", "a"), _create("X", "x"), _link("AX", "A", "X")], "seed")
    assert (await proj.project_graph(gid))["verify_error"] is None
    g = fake.graphs[next(iter(fake.graphs))]

    # X's update times out, even alone, and is held. X stays in the key as it was, so an edge to it
    # still matches: Y->X, and B->X a window later while X's retry still fails, are written.
    g.poison.add("urn:t:X")
    await _edit_publish(svc, gid, "alice", [
        {"op": "update", "entity_kind": "node", "entity_id": "X", "payload": {"displayName": "x2"}},
        _create("Y", "y"), _link("YX", "Y", "X")], "update X, add Y->X")
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and r["quarantined"] == 1, r
    await _edit_publish(svc, gid, "alice", [_create("B", "b"), _link("BX", "B", "X")], "add B->X")
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and r["quarantined"] == 1, r
    assert sorted(g.edges) == ["AX", "BX", "YX"], g.edges
    async with db.graphver_session() as s:
        held = {(q.statement, q.entity_key) for q in (await s.execute(
            select(ProjectionQuarantineORM)
            .where(ProjectionQuarantineORM.graph_id == gid))).scalars()}
    assert held == {("node_merge", "urn:t:X")}, held

    # The fault clears: X's update lands once due, and the graph verifies.
    g.poison.clear()
    async with db.graphver_session() as s:
        await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                        .values(quarantine_next_at="2000-01-01T00:00:00+00:00"))
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and not r.get("quarantined") and not r.get("unverified"), r
    await _assert_matches_main(svc, fake, gid)


async def _resumed_rebuild_keeps_what_it_held(svc, monkeypatch):
    from sqlalchemy import update

    from backend.app.services.versioning import config
    from backend.app.services.versioning.models import ProjectionStateORM

    fake = TimeoutFalkor(poison={"urn:t:P"})
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [
        _create("P", "p"), *(_create(f"R{i}", f"r{i}") for i in range(50))], "seed")
    saved = {k: getattr(config, k) for k in ("PROJECTION_RECONCILE_STREAMED_ABOVE",
                                              "PROJECTION_PAGE", "PROJECTION_PASS_MAX_SECS")}
    monkeypatch.setattr(config, "PROJECTION_RECONCILE_STREAMED_ABOVE", 5)
    monkeypatch.setattr(config, "PROJECTION_PAGE", 20)
    monkeypatch.setattr(config, "PROJECTION_PASS_MAX_SECS", 1e-6)

    # A first seed too large to hold, stopped after each page: P, held on the first page, is
    # retried by each pass that resumes, not dropped, and the last publishes with it held.
    passes = []
    while True:
        r = await proj.project_graph(gid)
        passes.append(r)
        if not r.get("partial"):
            break
        assert len(passes) < 20
    assert len(passes) >= 3 and r["verify_error"] is None and r["quarantined"] == 1, passes
    for k, v in saved.items():
        monkeypatch.setattr(config, k, v)

    # The fault clears: P lands once due, and the graph verifies.
    fake.graphs[next(iter(fake.graphs))].poison.clear()
    async with db.graphver_session() as s:
        await s.execute(update(ProjectionStateORM).where(ProjectionStateORM.graph_id == gid)
                        .values(quarantine_next_at="2000-01-01T00:00:00+00:00"))
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and not r.get("quarantined") and not r.get("unverified"), r
    await _assert_matches_main(svc, fake, gid)


async def _an_escalation_owes_its_rebuild_the_summaries(svc):
    from backend.app.services.versioning.models import ProjectionStateORM

    fake = TimeoutFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [
        _create("A", "a"), _create("B", "b"), _link("AB", "A", "B")], "seed")
    assert (await proj.project_graph(gid))["verify_error"] is None

    async def rollup_state():
        async with db.graphver_session() as s:
            return (await s.get(ProjectionStateORM, gid)).rollup_state or {}

    # A window that moved the summaries escalates, while an earlier ask is still owed: the rebuild
    # owes the job them too, and an ask recorded meanwhile keeps that.
    await svc.note_rollup_ask(gid, "active")
    async with db.graphver_session() as s:
        epoch = (await s.get(ProjectionStateORM, gid)).epoch
    assert await proj._escalate(gid, epoch, "it holds less than history", "drift",
                                summaries_moved=True)
    owed = await rollup_state()
    assert owed["moved"] and owed["pending"] == "active", owed
    await svc.note_rollup_ask(gid, "queued")
    assert (await rollup_state()).keys() == {"moved"}

    # The rebuild hands them to the job rather than moving them by its difference, and its
    # publish takes what was owed.
    stale, moved = [], []
    reconcile = proj._reconcile_in_place

    async def records(*a, **k):
        moved.append(k.get("rollups_moved_this_pass"))
        return await reconcile(*a, **k)

    async def rollups_stale(graph_id):
        stale.append(graph_id)

    proj._reconcile_in_place, proj._on_rollups_stale = records, rollups_stale
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and moved == [True] and stale == [gid], (r, moved, stale)
    async with db.graphver_session() as s:
        assert (await s.get(ProjectionStateORM, gid)).rollup_state is None
    await _assert_matches_main(svc, fake, gid)


async def _a_summaries_state_that_is_no_object_owes_nothing(svc):
    from sqlalchemy import JSON, func, select, update

    from backend.app.services.versioning.models import ProjectionStateORM as PS

    fake = TimeoutFalkor()
    proj = FalkorProjector(graph_client_factory=fake, batch_size=500)
    gid = await _graph(svc)
    await _edit_publish(svc, gid, "alice", [_create("A", "a")], "seed")
    assert (await proj.project_graph(gid))["verify_error"] is None
    g = fake.graphs[next(iter(fake.graphs))]
    stale = []

    async def rollups_stale(graph_id):
        stale.append(graph_id)

    proj._on_rollups_stale = rollups_stale

    async def state():
        async with db.graphver_session() as s:
            return tuple((await s.execute(
                select(func.jsonb_typeof(PS.rollup_state), PS.rollup_state)
                .where(PS.graph_id == gid))).one())

    async def store(value):
        async with db.graphver_session() as s:
            await s.execute(update(PS).where(PS.graph_id == gid).values(rollup_state=value))

    async def a_window_publishes(name):
        await _edit_publish(svc, gid, "alice", [_create(name, name.lower())], name)
        r = await proj.project_graph(gid)
        assert r["verify_error"] is None and await _watermark(gid) == r["projected"], r

    # An owed ask later queued leaves nothing owed: SQL NULL, not JSON null.
    await svc.note_rollup_ask(gid, "active")
    await svc.note_rollup_ask(gid, "queued")
    assert await state() == (None, None)

    # A state that is not an object (the JSON null a clear left before, or anything else) owes
    # nothing: an ask is recorded over it, and a window publishes over it and leaves NULL.
    for i, legacy in enumerate((JSON.NULL, [None, {"moved": "2026-01-01T00:00:00+00:00"}])):
        await store(legacy)
        await svc.note_rollup_ask(gid, "active")
        assert (await state())[1]["pending"] == "active"
        await store(legacy)
        await a_window_publishes(f"W{i}")
        assert await state() == (None, None)

    # Owed over JSON null, by an escalation: an object, which the rebuild hands to the job and its
    # publish clears.
    await store(JSON.NULL)
    async with db.graphver_session() as s:
        epoch = (await s.get(PS, gid)).epoch
    assert await proj._escalate(gid, epoch, "it holds less than history", "drift",
                                summaries_moved=True)
    kind, owed = await state()
    assert kind == "object" and owed.keys() == {"moved"}, (kind, owed)
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and stale == [gid] and await state() == (None, None), r

    # And by a rebuild that clears what is held: the same, and the next window publishes.
    g.poison.add("urn:t:P")
    await _edit_publish(svc, gid, "alice", [_create("P", "p")], "held")
    assert (await proj.project_graph(gid))["quarantined"] == 1
    g.poison.clear()
    await store(JSON.NULL)
    assert await svc.request_projection_rebuild(gid)
    r = await proj.project_graph(gid)
    assert r["verify_error"] is None and stale == [gid, gid] and await state() == (None, None), r
    await a_window_publishes("Last")
    await _assert_matches_main(svc, fake, gid)


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
            await _stale_hubs(svc, monkeypatch)
            await _created_and_deleted_in_one_window(svc)
            await _backoff_and_honest_verify(svc)
            await _urn_change_and_sweep(svc)
            await _held_delete_where_an_edge_was(svc)
            await _a_held_update_keeps_its_edges(svc)
            await _resumed_rebuild_keeps_what_it_held(svc, monkeypatch)
            await _an_escalation_owes_its_rebuild_the_summaries(svc)
            await _a_summaries_state_that_is_no_object_owes_nothing(svc)
            await _quarantine(svc, monkeypatch)
            await _resumable_and_self_healing(svc, monkeypatch)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
