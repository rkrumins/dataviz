"""``/bulk-ingest`` and ``/sync`` mint new ids as imports do, and still find what they named before —
needs Postgres.

Every id a versioned graph gains is a platform ``urn:uuid`` (doc 18 §3): the routes pass
``standard_ids``, so a new entity takes the id an import would give it — a ``urn:uuid`` the row
brings, else one derived from its urn (as an import by urn derives it) or its own id, an edge's
from its ends and type. An entity made before, whatever its id (a provider urn, ``ent_…``, a sync's
``sync:e:…``), is found as ever — by its urn, by its edge's ends, or by the id it has — so it is
updated and deleted, and keeps that id. A derived id another node holds is never reused. Without
``standard_ids`` (the bootstrap) a node is named by its id or urn as given, as before.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.ids import uuid_urn
from backend.app.services.versioning.import_export.resolve import edge_pointer_id, pointer_id
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

_GIVEN = "urn:uuid:0192F5A4-7B3C-7D2E-8F1A-2B3C4D5E6F70"


def _node(urn=None, **kw):
    return {"kind": "node", "entityType": "Dataset", **({"urn": urn} if urn else {}), **kw}


def _edge(src, tgt, **kw):
    return {"kind": "edge", "edgeType": "FLOWS_TO", "source": src, "target": tgt, **kw}


async def _graph(svc):
    return (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                   actor="ext"))["graph_id"]


async def _state(svc, gid):
    return await svc.materialize_state(graph_id=gid, branch_id=await svc.main_branch_id(gid))


async def _bulk_mints_as_an_import_does(svc):
    gid = await _graph(svc)
    scope = await svc.identity_scope(gid)
    report = await svc.bulk_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=[
        _node("urn:li:a", displayName="a"),
        _node(entity_id=_GIVEN, displayName="given"),                 # a urn:uuid of its own: kept
        _node(id="file-1", displayName="by its file id"),
        _node(displayName="nothing"),
        _edge("urn:li:a", "file-1"),
        _edge("file-1", "urn:li:a", id="e-own"),
        _node("urn:li:a", displayName="again"),                       # the same urn: one node
    ])
    assert report["ingested"] == 6 and [r["row"] for r in report["rejected"]] == [6], report
    st = await _state(svc, gid)
    a, given = pointer_id(scope, "urn:li:a"), uuid_urn(_GIVEN)
    f1 = pointer_id(scope, "file-1")
    assert {a, given, f1} <= set(st["nodes"]), st["nodes"].keys()
    assert all(uuid_urn(eid) == eid for eid in [*st["nodes"], *st["edges"]]), "every id a urn:uuid"
    assert st["nodes"][a]["urn"] == "urn:li:a", "the urn as given"
    assert edge_pointer_id(scope, a, f1, "FLOWS_TO") in st["edges"]
    assert len(st["edges"]) == 2
    by_urn = await svc.resolve_identities(graph_id=gid, identifier="urn", values=["urn:li:a", "urn:li:no"])
    assert [(r["status"], r["entityId"]) for r in by_urn] == [("found", a), ("none", None)]
    by_id = await svc.resolve_identities(graph_id=gid, identifier="entity_id", values=[given, "ent_no"])
    assert [r["status"] for r in by_id] == ["found", "none"]


async def _sync_finds_what_was_made_before(svc):
    gid = await _graph(svc)
    scope = await svc.identity_scope(gid)
    # Made before, as the bootstrap names things: ids as given.
    await svc.bulk_ingest(graph_id=gid, actor="ext", rows=[
        _node("urn:li:old", displayName="old"), _node("urn:li:gone", displayName="gone"),
        _node("urn:li:x", entity_id="ent_x", displayName="x"),
        _edge("urn:li:old", "urn:li:gone", entity_id="legacy-edge"),
        _edge("urn:li:old", "ent_x", entity_id="kept-edge")])

    def snapshot(*more):
        return [_node("urn:li:old", displayName="old v2"),                      # by its urn
                _node("urn:li:x2", entity_id="ent_x", displayName="x by id"),   # by the id it has
                _edge("urn:li:old", "ent_x"),                                   # by its ends
                *more]

    r = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=snapshot(
        _node("urn:li:new", displayName="new"), _edge("urn:li:new", "urn:li:old")))
    assert r["commit_id"] and not r["rejected"], r
    st = await _state(svc, gid)
    new = pointer_id(scope, "urn:li:new")
    assert st["nodes"]["urn:li:old"]["displayName"] == "old v2", "a legacy id, updated in place"
    assert (st["nodes"]["ent_x"]["displayName"], st["nodes"]["ent_x"]["urn"]) == ("x by id", "urn:li:x2")
    assert "urn:li:gone" not in st["nodes"] and "legacy-edge" not in st["edges"], "and deleted"
    assert "kept-edge" in st["edges"], "a legacy edge found by its ends keeps its id"
    assert new in st["nodes"] and edge_pointer_id(scope, new, "urn:li:old", "FLOWS_TO") in st["edges"]

    # The same snapshot again: nothing changes.
    again = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=snapshot(
        _node("urn:li:new", displayName="new"), _edge("urn:li:new", "urn:li:old")))
    assert not again.get("applied"), again

    # The new node's urn moves; a row bringing its old urn later is another node, never the one
    # holding the id that urn derives.
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=snapshot(
        _node("urn:li:moved", entity_id=new, displayName="new")))
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=snapshot(
        _node("urn:li:moved", entity_id=new, displayName="new"), _node("urn:li:new", displayName="2nd")))
    st = await _state(svc, gid)
    assert st["nodes"][new]["urn"] == "urn:li:moved"
    second = next(eid for eid, p in st["nodes"].items() if p.get("urn") == "urn:li:new")
    assert second != new and uuid_urn(second) == second


def test_the_ingest_routes_mint_new_ids_as_imports_do_and_find_what_they_named_before():
    async def run():
        await models.create_schema_and_partitions()
        try:
            svc = GraphVersioningService()
            await _bulk_mints_as_an_import_does(svc)
            await _sync_finds_what_was_made_before(svc)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
