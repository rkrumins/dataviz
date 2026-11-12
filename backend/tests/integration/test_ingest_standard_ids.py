"""``/bulk-ingest`` and ``/sync`` mint new ids as imports do, and still find what they named before —
needs Postgres.

Every id a versioned graph gains is a platform ``urn:uuid`` (doc 18 §3): the routes pass
``standard_ids``, so a new entity takes the id an import would give it — a ``urn:uuid`` the row
brings, else one derived from its urn (as an import by urn derives it) or its own id, an edge's
from its ends and type. An entity made before, whatever its id (a provider urn, ``ent_…``, a sync's
``sync:e:…``), is found as ever — by its urn, by its edge's ends, or by the id it has — so it is
updated and deleted, and keeps that id. The id a row's urn derives is never reused when another
node holds it; the node holding the id a row with no urn derives is the one that row made,
whatever urn it carries now, so the same rows sent again change nothing. A node with no urn an
earlier sync named by its id is left as it is. A sync's edge names a new node by its urn or its
own id, as given or canonical. An entity a sync deleted that a later one sends again comes back
under its id: a node by the urn it last had, an edge by the ends and type it last joined, found by
plans made for the graph each time. A fork's ``resolve_identities`` answers from its main as an
import into it reads it, what it inherits included. Without ``standard_ids`` (the bootstrap) a
node is named by its id or urn as given, as before.
"""
import asyncio
import os

import pytest
from sqlalchemy import TextClause, text

from backend.app.services.versioning import db, models
from backend.app.services.versioning.ids import uuid_urn
from backend.app.services.versioning.import_export.keys import NotOnAFork
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


async def _the_same_rows_again_change_nothing(svc):
    # A row with no urn, and one naming its urn:uuid in another case: what /bulk-ingest made of
    # them, and what a /sync made, is the node the same rows name next time.
    rows = [_node(id="file-1", displayName="by its file id"),
            _node(entity_id=_GIVEN, displayName="given"),
            _node("urn:li:a", displayName="a"),
            _edge("file-1", "urn:li:a"), _edge(_GIVEN, "file-1")]
    bulk, synced = await _graph(svc), await _graph(svc)
    await svc.bulk_ingest(graph_id=bulk, actor="ext", standard_ids=True, rows=rows)
    await svc.sync_ingest(graph_id=synced, actor="ext", standard_ids=True, rows=rows)
    for gid in (bulk, synced):
        scope = await svc.identity_scope(gid)
        made = await _state(svc, gid)
        assert set(made["nodes"]) == {pointer_id(scope, "file-1"), uuid_urn(_GIVEN),
                                      pointer_id(scope, "urn:li:a")}, made["nodes"].keys()
        for _ in range(2):
            again = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=rows)
            assert not again["rejected"] and not again["applied"], again
        st = await _state(svc, gid)
        assert (set(st["nodes"]), set(st["edges"])) == (set(made["nodes"]), set(made["edges"]))


async def _a_urn_less_rows_node_keeps_its_id_whatever_urn_it_has_now(svc):
    # The node a row with no urn made holds the id that row derives, whatever urn it has by now:
    # one a later row named by its id with a urn of its own, or one a person gave a urn.
    first = [_node(id="file-1"), _node("urn:li:b"), _edge("file-1", "urn:li:b")]
    gid = await _graph(svc)
    f1 = pointer_id(await svc.identity_scope(gid), "file-1")
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=first)
    made = await _state(svc, gid)
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=[
        _node("urn:li:f", entity_id=f1), _node("urn:li:b"), _edge("urn:li:f", "urn:li:b")])
    assert (await _state(svc, gid))["nodes"][f1]["urn"] == "urn:li:f"
    back = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=first)
    assert back["applied"] == 1 and not back["rejected"], back             # its urn: its id again
    again = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=first)
    assert not again["applied"], again
    st = await _state(svc, gid)
    assert (set(st["nodes"]), set(st["edges"])) == (set(made["nodes"]), set(made["edges"]))
    assert st["nodes"][f1]["urn"] == f1

    gid = await _graph(svc)
    f1 = pointer_id(await svc.identity_scope(gid), "file-1")
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=first)
    made = await _state(svc, gid)
    await svc.apply_ops(graph_id=gid, actor="alice", message="names it", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": f1, "payload": {"urn": "urn:li:p"}}])
    for _ in range(2):
        r = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True,
                                  strategy="external_wins", rows=first)
        assert not r["applied"] and not r["rejected"], r
    st = await _state(svc, gid)
    assert (set(st["nodes"]), set(st["edges"])) == (set(made["nodes"]), set(made["edges"]))
    assert st["nodes"][f1]["urn"] == "urn:li:p", "the person's urn stays"


async def _what_an_earlier_sync_named_by_its_id_changes_nothing(svc):
    # A sync without standard ids (before them) named a node with no urn by its id and gave it
    # none: a sync with them finds it by that id and leaves it as it is.
    gid = await _graph(svc)
    rows = [_node(id="file-1", displayName="f"), _node("urn:li:b"), _edge("file-1", "urn:li:b")]
    await svc.sync_ingest(graph_id=gid, actor="ext", rows=rows)
    made = await _state(svc, gid)
    assert "urn" not in made["nodes"]["file-1"], made["nodes"]["file-1"]
    for _ in range(2):
        r = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=rows)
        assert not r["applied"] and not r["rejected"], r
    assert await _state(svc, gid) == made


async def _a_sync_edge_names_a_new_node_by_its_own_id(svc):
    gid = await _graph(svc)
    scope = await svc.identity_scope(gid)
    rows = [_node("urn:li:old"), _node(entity_id="n1"), _node("urn:li:n2", entity_id="n2"),
            _node(entity_id=_GIVEN),
            _edge("n1", "urn:li:old"), _edge("n2", "urn:li:old"), _edge(_GIVEN, "urn:li:old"),
            _edge(uuid_urn(_GIVEN), "n1")]
    r = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=rows)
    assert r["commit_id"] and not r["rejected"], r
    old, n1, n2 = (pointer_id(scope, v) for v in ("urn:li:old", "n1", "urn:li:n2"))
    given = uuid_urn(_GIVEN)
    ends = {(e["sourceEntityId"], e["targetEntityId"]) for e in (await _state(svc, gid))["edges"].values()}
    assert ends == {(n1, old), (n2, old), (given, old), (given, n1)}, ends
    again = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=rows)
    assert not again["rejected"] and not again["applied"], again

    # An edge named by its urn:uuid in another case is that edge, wherever its ends go.
    edge = "urn:uuid:0192F5A4-7B3C-7D2E-8F1A-2B3C4D5E6F71"
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True,
                          rows=rows + [_edge("n1", "n2", entity_id=edge)])
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True,
                          rows=rows + [_edge("n2", "n1", entity_id=edge)])
    moved = (await _state(svc, gid))["edges"].get(uuid_urn(edge)) or {}
    assert (moved.get("sourceEntityId"), moved.get("targetEntityId")) == (n2, n1), moved


async def _a_deleted_entity_sent_again_comes_back_under_its_id(svc):
    gid = await _graph(svc)
    scope = await svc.identity_scope(gid)
    await svc.bulk_ingest(graph_id=gid, actor="ext", rows=[       # made before: ids as given
        _node("urn:li:old"), _node("urn:li:b"),
        _edge("urn:li:old", "urn:li:b", entity_id="legacy-edge")])
    full = [_node("urn:li:old"), _node("urn:li:b"), _node("urn:li:a"), _node(id="file-1"),
            _edge("urn:li:old", "urn:li:b"), _edge("urn:li:a", "urn:li:b"), _edge("file-1", "urn:li:b")]
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=full)
    made = await _state(svc, gid)
    a, f1, b = pointer_id(scope, "urn:li:a"), pointer_id(scope, "file-1"), "urn:li:b"
    assert set(made["nodes"]) == {"urn:li:old", b, a, f1}
    assert set(made["edges"]) == {"legacy-edge", edge_pointer_id(scope, a, b, "FLOWS_TO"),
                                  edge_pointer_id(scope, f1, b, "FLOWS_TO")}
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=[_node("urn:li:b")])
    st = await _state(svc, gid)
    assert set(st["nodes"]) == {b} and not st["edges"], "the snapshot dropped them: deleted"
    back = await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=full)
    assert not back["rejected"], back
    st = await _state(svc, gid)
    assert (set(st["nodes"]), set(st["edges"])) == (set(made["nodes"]), set(made["edges"])), \
        "each comes back under the id it had"


async def _what_a_sync_deleted_is_found_by_plans_made_for_its_graph(svc):
    # A prepared statement comes to a generic plan after five runs. That plan takes `graph_id = $1`
    # for a few rows, so it read the whole graph and tested each row against every key: seconds a
    # chunk on a graph of 50,000 versions. The lookup is planned for its graph and keys each time.
    gid = await _graph(svc)
    scope = await svc.identity_scope(gid)
    a, b, c = (pointer_id(scope, u) for u in ("urn:li:a", "urn:li:b", "urn:li:c"))
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=[
        _node("urn:li:a"), _node("urn:li:b"), _node("urn:li:c"), _edge("urn:li:a", "urn:li:b")])
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=[
        _node("urn:li:a"), _node("urn:li:b"), _node("urn:li:c2", entity_id=c),     # c's urn moves
        _edge("urn:li:a", "urn:li:b")])
    await svc.sync_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=[_node("urn:li:b")])
    async with svc._session() as s:
        main_id = await svc._main_branch_id(s, gid)
        await s.execute(text("SELECT set_config('plan_cache_mode', 'force_generic_plan', true)"))
        planned, execute = set(), s.execute

        async def noting(stmt, *args, **kwargs):
            if not isinstance(stmt, TextClause):
                planned.add((await execute(text("SHOW plan_cache_mode"))).scalar())
            return await execute(stmt, *args, **kwargs)
        s.execute = noting
        nodes = await svc._deleted_by(s, gid, main_id, models.NodeVersionORM, ("urn",),
                                      ["urn:li:a", "urn:li:b", "urn:li:c", "urn:li:c2", "urn:li:no"])
        edges = await svc._deleted_by(s, gid, main_id, models.EdgeVersionORM,
                                      ("source_entity_id", "target_entity_id", "edge_type"),
                                      [(a, b, "FLOWS_TO"), (b, a, "FLOWS_TO")])
        s.execute = execute
        after = (await s.execute(text("SHOW plan_cache_mode"))).scalar()
    assert nodes == {"urn:li:a": {a}, "urn:li:c2": {c}}, nodes        # by the urn each last had
    assert edges == {(a, b, "FLOWS_TO"): {edge_pointer_id(scope, a, b, "FLOWS_TO")}}, edges
    assert planned == {"force_custom_plan"} and after == "force_generic_plan", (planned, after)


async def _a_fork_resolves_what_it_inherits(svc):
    gid = await _graph(svc)
    scope = await svc.identity_scope(gid)
    await svc.bulk_ingest(graph_id=gid, actor="ext", standard_ids=True, rows=[
        _node("urn:li:a"), _node(id="file-1"), _node("urn:li:b")])
    a, f1, b = pointer_id(scope, "urn:li:a"), pointer_id(scope, "file-1"), pointer_id(scope, "urn:li:b")
    fork = (await svc.fork_graph(parent_graph_id=gid, workspace_id="ws1", actor="bob"))["graph_id"]
    await svc.apply_ops(graph_id=fork, actor="bob", message="the fork deletes b", ops=[
        {"op": "delete", "entity_kind": "node", "entity_id": b, "payload": None}])
    await svc.apply_ops(graph_id=gid, actor="alice", message="after the fork", ops=[
        {"op": "create", "entity_kind": "node", "entity_id": "late",
         "payload": {"urn": "urn:li:late", "entityType": "Dataset"}}])
    by_urn = await svc.resolve_identities(graph_id=fork, identifier="urn",
                                          values=["urn:li:a", "file-1", "urn:li:b", "urn:li:late"])
    assert [(r["status"], r["entityId"]) for r in by_urn] == [
        ("found", a), ("found", f1), ("none", None), ("none", None)], by_urn
    by_id = await svc.resolve_identities(graph_id=fork, identifier="entity_id", values=[a, f1, b, "late"])
    assert [r["status"] for r in by_id] == ["found", "found", "none", "none"], by_id
    on_parent = await svc.resolve_identities(graph_id=gid, identifier="entity_id", values=[b, "late"])
    assert [r["status"] for r in on_parent] == ["found", "found"], on_parent
    with pytest.raises(NotOnAFork):
        await svc.resolve_identities(graph_id=fork, identifier="prop.ext", values=["x"])


def test_the_ingest_routes_mint_new_ids_as_imports_do_and_find_what_they_named_before():
    async def run():
        await models.create_schema_and_partitions()
        try:
            svc = GraphVersioningService()
            await _bulk_mints_as_an_import_does(svc)
            await _sync_finds_what_was_made_before(svc)
            await _the_same_rows_again_change_nothing(svc)
            await _a_urn_less_rows_node_keeps_its_id_whatever_urn_it_has_now(svc)
            await _what_an_earlier_sync_named_by_its_id_changes_nothing(svc)
            await _a_sync_edge_names_a_new_node_by_its_own_id(svc)
            await _a_deleted_entity_sent_again_comes_back_under_its_id(svc)
            await _what_a_sync_deleted_is_found_by_plans_made_for_its_graph(svc)
            await _a_fork_resolves_what_it_inherits(svc)
        finally:
            await db.dispose_engine()
    asyncio.run(run())
