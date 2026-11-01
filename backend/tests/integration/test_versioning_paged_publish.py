"""A publish too large to hold at once goes a page at a time, and lands what one batch would — needs
Postgres.

A draft that changed more than ``SQUASH_PAGED_ABOVE`` entities is squashed ``SQUASH_PAGE`` heads at
a time (``_squash_paged``), so a publish of millions fits the worker. Each scenario here publishes
the same draft on twin graphs, once in one batch and once in pages of two — so every page boundary
a scenario has is crossed — and requires the same outcome: the same values on ``main``, the same
change counts and Merkle root, or the same refusal.
"""
import asyncio
import os

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules
from backend.app.services.versioning.service import (
    ConcurrencyError, GraphVersioningService, OntologyViolation)

pytestmark = pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"),
                                reason="set GRAPHVER_E2E=1 + a live Postgres to run")
CONT = ["CONTAINS"]


def _node(eid, etype="Dataset", **kw):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": f"{eid} name", "entityType": etype, **kw}}


def _upd(eid, etype="Dataset", **kw):
    return {"op": "update", "entity_kind": "node", "entity_id": eid,
            "payload": {"displayName": f"{eid} name", "entityType": etype, **kw}}


def _edge(eid, src, tgt, etype="FLOWS_TO", op="create"):
    return {"op": op, "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


def _del(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


async def _graph(svc, baseline):
    g = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                               actor="u")
    if baseline:
        d = await svc.open_draft(graph_id=g["graph_id"], owner="u")
        await svc.apply_ops(graph_id=g["graph_id"], branch_id=d, actor="u", ops=baseline)
        await svc.publish(graph_id=g["graph_id"], branch_id=d, actor="u", message="baseline",
                          containment_edge_types=CONT)
    return g["graph_id"], g["main_branch_id"]


async def _publish(svc, baseline, ops, *, paged, rules=None, strict=False):
    """The draft's publish on a fresh graph: ``(state of main, stats, root)`` or the refusal."""
    gid, main = await _graph(svc, baseline)
    if strict:
        async with db.graphver_session() as s, s.begin():
            g = await s.get(models.GraphORM, gid)
            g.ontology_enforcement = "strict"
    d = await svc.open_draft(graph_id=gid, owner="u")
    for batch in (ops if ops and isinstance(ops[0], list) else [ops]):    # one save per batch
        await svc.apply_ops(graph_id=gid, branch_id=d, actor="u", ops=batch)
    saved = (config.SQUASH_PAGED_ABOVE, config.SQUASH_PAGE)
    config.SQUASH_PAGED_ABOVE, config.SQUASH_PAGE = (0, 2) if paged else (10 ** 9, 10 ** 9)
    try:
        commit = await svc.publish(graph_id=gid, branch_id=d, actor="u", message="draft",
                                   containment_edge_types=CONT, ontology_rules=rules)
    except (ConcurrencyError, OntologyViolation) as exc:
        return type(exc).__name__
    finally:
        config.SQUASH_PAGED_ABOVE, config.SQUASH_PAGE = saved
    ids = sorted({o["entity_id"] for o in baseline + [o for b in (
        ops if ops and isinstance(ops[0], list) else [ops]) for o in b]})
    async with db.graphver_session() as s:
        state = await svc._current_values(s, gid, main, ids)
        row = await s.get(models.CommitORM, (gid, commit)) if commit else None
    return state, (row.stats if row else None), (row.merkle_root if row else None)


async def _same(svc, baseline, ops, **kw):
    one = await _publish(svc, baseline, ops, paged=False, **kw)
    paged = await _publish(svc, baseline, ops, paged=True, **kw)
    assert paged == one, (paged, one)
    return one


BASE = ([_node(f"N{i}") for i in range(8)] + [_node("S", "Schema")]
        + [_edge(f"E{i}", f"N{i}", f"N{i + 1}") for i in range(7)]
        + [_edge(f"C{i}", "S", f"N{i}", "CONTAINS") for i in range(4)])


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    # Creates, updates and deletes of nodes and edges; a deleted node takes the edges on it that
    # the draft left alone (E2, E3, C3), and a new edge on it goes too (EX); a no-op publishes nothing.
    state, stats, root = await _same(svc, BASE, [
        _node("A"), _node("B"), _edge("EA", "A", "B"), _upd("N1", description="x"),
        _del("N3"), _edge("EX", "N0", "N3"), _del("E6", "edge"), _edge("C9", "S", "A", "CONTAINS")])
    assert state["N3"] is None and state["E2"] is None and state["E3"] is None, state
    assert state["C3"] is None and state.get("EX") is None and state["EA"] is not None, state
    assert stats == {"create": 4, "update": 1, "delete": 5} and root, stats
    _, stats, root = await _same(svc, BASE, [])
    assert stats is None and root is None

    # A child moved to a new parent, its old link deleted: never "a second parent", whichever page
    # each lands on. Two new parents for one child: refused, whichever page each lands on.
    state, _, _ = await _same(svc, BASE, [
        _node("T", "Schema"), _edge("C0", "S", "N0", "CONTAINS", op="delete"),
        _edge("CT", "T", "N0", "CONTAINS")])
    assert state["C0"] is None and state["CT"] is not None, state
    assert await _same(svc, BASE, [
        _node("T", "Schema"), _node("U", "Schema"), _edge("CT", "T", "N5", "CONTAINS"),
        _edge("CU0", "T", "N6", "CONTAINS"), _edge("CV", "U", "N5", "CONTAINS")]) == "OntologyViolation"

    # An edge re-pointed away, then a new one where it was: not a duplicate.
    state, _, _ = await _same(svc, BASE, [
        [_edge("E0", "N0", "N2", op="update")], [_edge("EZ", "N0", "N1")]])
    assert state["E0"]["targetEntityId"] == "N2" and state["EZ"] is not None, state

    # Strict: an edge between a node created on one page and a node retyped on another is judged
    # by their new types (DERIVES joins Tables only); a type nothing declares is refused alike.
    both = frozenset({"Dataset", "Table"})
    rules = OntologyRules(
        entity_types={"Dataset": EntityRule(), "Schema": EntityRule(), "Table": EntityRule()},
        edge_types={"FLOWS_TO": EdgeRule(both, both),
                    "DERIVES": EdgeRule(frozenset({"Table"}), frozenset({"Table"})),
                    "CONTAINS": EdgeRule(is_containment=True)},
        containment_edge_types=frozenset({"CONTAINS"}))
    state, _, _ = await _same(svc, BASE, [
        _node("A", "Table"), _upd("N6", "Table"), _edge("EA", "A", "N6", "DERIVES")],
        rules=rules, strict=True)
    assert state["EA"] is not None and state["N6"]["entityType"] == "Table", state
    assert await _same(svc, BASE, [_node("A", "Nope")], rules=rules,
                       strict=True) == "OntologyViolation"

    # Strict, Schemas alone at the top: new nodes whose parent links land on later pages are
    # inside a parent; a new node with none is refused alike.
    rooted = OntologyRules(entity_types=rules.entity_types, edge_types=rules.edge_types,
                           containment_edge_types=rules.containment_edge_types,
                           root_entity_types=frozenset({"Schema"}))
    state, _, _ = await _same(svc, BASE, [
        _node("A"), _node("B1"), _node("B2"), _edge("ZB1", "S", "B1", "CONTAINS"),
        _edge("ZB2", "S", "B2", "CONTAINS"), _edge("ZC", "S", "A", "CONTAINS")],
        rules=rooted, strict=True)
    assert state["ZC"] is not None, state
    assert await _same(svc, BASE, [_node("A"), _node("B1"), _edge("ZB1", "S", "B1", "CONTAINS")],
                       rules=rooted, strict=True) == "OntologyViolation"

    # Above the Merkle cap the root is left unset, the rows all the same.
    saved = config.BOOTSTRAP_MERKLE_INLINE_MAX
    config.BOOTSTRAP_MERKLE_INLINE_MAX = 1
    try:
        _, stats, root = await _publish(svc, BASE, [_node("A"), _node("B")], paged=True)
    finally:
        config.BOOTSTRAP_MERKLE_INLINE_MAX = saved
    assert stats == {"create": 2, "update": 0, "delete": 0} and root is None
    await db.dispose_engine()


def test_a_paged_publish_lands_what_one_batch_would():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning paged publish e2e: OK")
