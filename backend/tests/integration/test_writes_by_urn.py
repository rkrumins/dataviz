"""A save that names entities by urn edits the entities those urns name — needs Postgres.

The canvas knows a node only by its urn and sends that as the op's id and as an edge's ends. Every
node it created or bootstrapped is keyed by its urn, so that worked; a node an import brought in is
keyed by a minted id (``ent_…``). A save naming one missed it: a link to it or a child under it
failed the whole batch as dangling, a rename was "not on this draft", a retype made a phantom node,
a delete did nothing yet answered saved. A save now resolves a urn that isn't an entity id to the
one live node carrying it, inside the batch's lock, and answers in the names it was sent.

A create also never silently replaces what holds its id, nor turns an edge into a node.
"""
import os

import pytest

from backend.tests.integration.test_fork_overlay_delta import _d, _run

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

CONT = ["CONTAINS"]


def _node(eid, urn, etype="Table", name=None):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": urn, "entityType": etype, "displayName": name or urn.split(":")[-1]}}


def _edge(eid, src, tgt, etype):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


async def _seeded(svc):
    """main: schemas P and Q, P holding table T, and table L — every id an import's."""
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                  workspace_id="ws1", actor="alice"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", containment_edge_types=CONT,
                        ops=[_node("ent_P", "urn:P", "Schema"), _node("ent_Q", "urn:Q", "Schema"),
                             _node("ent_T", "urn:T"), _node("ent_L", "urn:L"),
                             _edge("ent_cT", "ent_P", "ent_T", "CONTAINS")])
    return gid, await svc.open_draft(graph_id=gid, owner="alice")


async def _save(svc, gid, draft, ops, **kw):
    return await svc.apply_ops_detailed(graph_id=gid, branch_id=draft, actor="alice",
                                        message="canvas", containment_edge_types=CONT, ops=ops,
                                        from_client=True, **kw)


async def _values(svc, gid, draft, ids):
    async with svc._session() as s:
        return await svc._current_values(s, gid, draft, ids)


def test_a_rename_by_urn_edits_the_imported_node_and_answers_by_urn():
    async def case(svc):
        gid, draft = await _seeded(svc)
        res = await _save(svc, gid, draft, [{"op": "update", "entity_kind": "node",
                                              "entity_id": "urn:T", "payload": {"displayName": "T2"}}])
        vals = await _values(svc, gid, draft, ["ent_T", "urn:T"])
        assert vals["ent_T"]["displayName"] == "T2"
        assert "urn:T" not in vals, "a phantom node was created under the urn"
        assert res.names == {"ent_T": "urn:T"}
    _run(case)


def test_a_retype_by_urn_never_makes_a_phantom_node():
    async def case(svc):
        gid, draft = await _seeded(svc)
        await _save(svc, gid, draft, [{"op": "update", "entity_kind": "node", "entity_id": "urn:L",
                                       "payload": {"entityType": "View"}}])
        vals = await _values(svc, gid, draft, ["ent_L", "urn:L"])
        assert vals["ent_L"]["entityType"] == "View" and "urn:L" not in vals
    _run(case)


def test_a_delete_by_urn_deletes_the_node_and_its_edges():
    async def case(svc):
        gid, draft = await _seeded(svc)
        res = await _save(svc, gid, draft, [_d("urn:T")])
        assert res.commit_id is not None, "a delete by urn changed nothing"
        vals = await _values(svc, gid, draft, ["ent_T", "ent_cT"])
        assert vals["ent_T"] is None and vals["ent_cT"] is None
    _run(case)


def test_a_link_and_a_child_by_urn_land_on_the_imported_nodes():
    async def case(svc):
        gid, draft = await _seeded(svc)
        await _save(svc, gid, draft, [
            _edge("lin1", "urn:T", "urn:L", "LINEAGE"),
            _node("urn:N", "urn:N"), _edge("cN", "urn:P", "urn:N", "CONTAINS")])
        vals = await _values(svc, gid, draft, ["lin1", "cN"])
        assert (vals["lin1"]["sourceEntityId"], vals["lin1"]["targetEntityId"]) == ("ent_T", "ent_L")
        assert (vals["cN"]["sourceEntityId"], vals["cN"]["targetEntityId"]) == ("ent_P", "urn:N")
    _run(case)


def test_a_move_by_urn_moves_the_imported_node():
    async def case(svc):
        gid, draft = await _seeded(svc)
        await _save(svc, gid, draft, [{"op": "move", "entity_kind": "node", "entity_id": "urn:T",
                                       "payload": {"parentEntityId": "urn:Q", "edgeType": "CONTAINS",
                                                   "edgeId": "cQT"}}])
        vals = await _values(svc, gid, draft, ["ent_cT", "cQT"])
        assert vals["ent_cT"] is None, "the old link stayed"
        assert (vals["cQT"]["sourceEntityId"], vals["cQT"]["targetEntityId"]) == ("ent_Q", "ent_T")
    _run(case)


def test_a_urn_two_live_nodes_carry_is_refused_by_name():
    async def case(svc):
        from backend.app.services.versioning.errors import AmbiguousUrn
        gid, draft = await _seeded(svc)
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="dupe",
                            ops=[_node("ent_D1", "urn:D"), _node("ent_D2", "urn:D")])
        with pytest.raises(AmbiguousUrn) as exc:
            await _save(svc, gid, draft, [{"op": "update", "entity_kind": "node", "entity_id": "urn:D",
                                           "payload": {"displayName": "D"}}])
        assert "urn:D" in str(exc.value)
    _run(case)


def test_a_replay_answers_in_the_names_it_was_sent():
    async def case(svc):
        gid, draft = await _seeded(svc)
        ops = [{"op": "update", "entity_kind": "node", "entity_id": "urn:T",
                "payload": {"displayName": "T3"}}]
        first = await _save(svc, gid, draft, ops, idempotency_key="k1")
        again = await _save(svc, gid, draft, ops, idempotency_key="k1")
        assert again.commit_id == first.commit_id
        assert again.names == first.names == {"ent_T": "urn:T"}
        assert again.written["ent_T"][1]["displayName"] == "T3"
    _run(case)


def test_a_create_never_replaces_what_holds_its_id():
    async def case(svc):
        from backend.app.services.versioning.errors import EntityExists
        gid, draft = await _seeded(svc)
        with pytest.raises(EntityExists):          # a live node
            await _save(svc, gid, draft, [_node("ent_T", "urn:T2")])
        with pytest.raises(EntityExists):          # a live edge turned into a node
            await _save(svc, gid, draft, [_node("ent_cT", "urn:X")])
        assert (await _values(svc, gid, draft, ["ent_T"]))["ent_T"]["urn"] == "urn:T"
    _run(case)


def test_an_edge_create_without_both_ends_is_refused():
    async def case(svc):
        gid, draft = await _seeded(svc)
        with pytest.raises(ValueError):
            await _save(svc, gid, draft, [{"op": "create", "entity_kind": "edge", "entity_id": "e1",
                                           "payload": {"edgeType": "LINEAGE",
                                                       "sourceEntityId": "ent_T"}}])
    _run(case)


def test_restoring_a_deleted_imported_node_by_urn_brings_the_same_entity_back():
    async def case(svc):
        gid, draft = await _seeded(svc)
        await _save(svc, gid, draft, [_d("urn:L")])
        await _save(svc, gid, draft, [_node("urn:L", "urn:L")])
        vals = await _values(svc, gid, draft, ["ent_L", "urn:L"])
        assert vals["ent_L"] is not None and vals["ent_L"]["urn"] == "urn:L"
        assert "urn:L" not in vals, "a second entity with the same urn"
    _run(case)


def test_a_node_with_no_urn_is_named_gv_and_restored_as_itself():
    """A node with no urn reads as ``gv:<id>``: a link to it, and a restore of it once deleted, name
    it so — and land on it, never on a new node, and never write ``gv:`` into its urn."""
    async def case(svc):
        gid, draft = await _seeded(svc)
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", message="urn-less",
                            ops=[{"op": "create", "entity_kind": "node", "entity_id": "ent_U",
                                  "payload": {"entityType": "Table", "displayName": "U"}}])
        await _save(svc, gid, draft, [_edge("lin_u", "gv:ent_U", "urn:L", "LINEAGE")])
        vals = await _values(svc, gid, draft, ["lin_u"])
        assert vals["lin_u"]["sourceEntityId"] == "ent_U"
        await _save(svc, gid, draft, [_d("gv:ent_U")])
        await _save(svc, gid, draft, [{"op": "create", "entity_kind": "node", "entity_id": "gv:ent_U",
                                       "payload": {"urn": "gv:ent_U", "entityType": "Table",
                                                   "displayName": "U"}}])
        vals = await _values(svc, gid, draft, ["ent_U", "gv:ent_U"])
        assert vals["ent_U"] is not None and "urn" not in vals["ent_U"], vals
        assert "gv:ent_U" not in vals, "a second entity for the urn-less node"
    _run(case)
