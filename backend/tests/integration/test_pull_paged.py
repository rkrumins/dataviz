"""A draft past ``SQUASH_PAGED_ABOVE`` changes pulls main reading only what main changed too —
needs Postgres.

Pins: the paged pull (``_pull_paged``) leaves the draft as the pull that reads the whole draft
does, on the same history run into two graphs, one pulled each way:
- a field main changed merges with the draft's change of another field of the same node;
- an edge the draft made onto a node main deleted is deleted with it (the cascade);
- an edge the draft made onto a node of its own, which main changed nothing of, is kept, and an
  edge main changed that ends at a node of the draft's own passes the integrity check;
- what main made or changed that the draft never touched comes from main;
and a field both changed differently is the same conflict either way, writing nothing; a
resolution for an entity main didn't change since the last pull applies whole either way. Random
histories, on a graph and on a fork whose parent moves, pull alike both ways too: the same
outcome, the same draft, the same resolutions answered.
"""
import asyncio
import os
import random

import pytest

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


def _node(eid, **payload):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": "Table", "displayName": eid, **payload}}


def _edge(eid, a, b):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"sourceEntityId": a, "targetEntityId": b, "edgeType": "LINEAGE"}}


def _update(eid, kind="node", **payload):
    return {"op": "update", "entity_kind": kind, "entity_id": eid, "payload": payload}


def _delete(eid, kind="node"):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


async def _history(svc, *, conflict=False):
    """A graph, and a draft of it main moved past. Returns the graph and the draft."""
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    seed = await svc.open_draft(graph_id=gid, owner="alice")
    await svc.apply_ops(graph_id=gid, branch_id=seed, actor="alice", message="seed", ops=[
        *[_node(f"n{i}") for i in range(1, 7)], _edge("e12", "n1", "n2"), _edge("e34", "n3", "n4"),
        _edge("e56", "n5", "n6")])
    await svc.publish(graph_id=gid, branch_id=seed, actor="alice", message="seed")
    mine = await svc.open_draft(graph_id=gid, owner="bob")
    await svc.apply_ops(graph_id=gid, branch_id=mine, actor="bob", message="mine", ops=[
        _update("n1", description="bob's"),
        _node("n7"), _edge("e75", "n7", "n5"),           # onto a node main changes
        _edge("e23", "n2", "n3"),                        # onto a node main deletes
        _update("n6", displayName="bob's six"),
        _edge("e67", "n6", "n7")])                       # onto a node of the draft's own
    theirs = await svc.open_draft(graph_id=gid, owner="carol")
    await svc.apply_ops(graph_id=gid, branch_id=theirs, actor="carol", message="theirs", ops=[
        _update("n1", displayName="carol's one"),
        {"op": "delete", "entity_kind": "node", "entity_id": "n3"},
        _update("n5", displayName="carol's five"), _node("n8"),
        _update("e56", kind="edge", properties={"w": 2}),
        *([_update("n6", displayName="carol's six")] if conflict else [])])
    await svc.publish(graph_id=gid, branch_id=theirs, actor="carol", message="theirs")
    return gid, mine


async def _pulled(svc, monkeypatch, paged, *, conflict=False):
    gid, mine = await _history(svc, conflict=conflict)
    monkeypatch.setattr(config, "SQUASH_PAGED_ABOVE", 1 if paged else 10 ** 9)
    pulled = await svc.rebase_draft(graph_id=gid, branch_id=mine, actor="bob")
    state = await svc.materialize_state(graph_id=gid, branch_id=mine)
    return pulled, state


async def _run(monkeypatch):
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    whole, whole_state = await _pulled(svc, monkeypatch, paged=False)
    paged, paged_state = await _pulled(svc, monkeypatch, paged=True)
    assert whole["clean"] and paged["clean"], (whole, paged)
    assert paged["changes"] == whole["changes"]
    assert paged_state == whole_state
    nodes, edges = paged_state["nodes"], paged_state["edges"]
    assert (nodes["n1"]["displayName"], nodes["n1"]["description"]) == ("carol's one", "bob's")
    assert "n3" not in nodes and "e23" not in edges and "e34" not in edges
    assert {"e75", "e67", "e12", "e56"} <= set(edges)
    assert nodes["n5"]["displayName"] == "carol's five" and "n8" in nodes

    whole, _ = await _pulled(svc, monkeypatch, paged=False, conflict=True)
    paged, _ = await _pulled(svc, monkeypatch, paged=True, conflict=True)
    assert not whole["clean"] and not paged["clean"]
    assert [(c["entity_id"], c["path"]) for c in paged["conflicts"]] == [
        (c["entity_id"], c["path"]) for c in whole["conflicts"]] == [("n6", ["displayName"])]


async def _stale_resolution(svc, monkeypatch, paged):
    """A conflict answered twice: kept, then (a second, stale answer) deleted after main moved on
    elsewhere. The second resolution names an entity main didn't change since the first pull."""
    monkeypatch.setattr(config, "SQUASH_PAGED_ABOVE", 0 if paged else 10 ** 9)
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_node("A"), _node("B"), _node("C")])
    mine = await svc.open_draft(graph_id=gid, owner="bob")
    await svc.apply_ops(graph_id=gid, branch_id=mine, actor="bob", message="mine", ops=[
        _update("C", description="bob's"), _edge("dCA", "C", "A")])
    await svc.apply_ops(graph_id=gid, actor="carol", message="m", ops=[_delete("C")])
    assert not (await svc.rebase_draft(graph_id=gid, branch_id=mine, actor="bob"))["clean"]
    async with db.graphver_session() as s:
        kept = (await svc._current_values(s, gid, mine, ["C"]))["C"]
    assert (await svc.rebase_draft(graph_id=gid, branch_id=mine, actor="bob", resolutions={"C": kept}))["clean"]
    await svc.apply_ops(graph_id=gid, actor="carol", message="m2", ops=[_update("B", displayName="b2")])
    stale = await svc.rebase_draft(graph_id=gid, branch_id=mine, actor="bob", resolutions={"C": None})
    state = await svc.materialize_state(graph_id=gid, branch_id=mine)
    return stale["changes"], sorted(state["nodes"]), sorted(state["edges"])


def _ops(rng, who, nodes, edges, n):
    """``n`` random writes over a view of the graph (``nodes``, ``edges`` {id: (a, b)}), kept up."""
    ops = []
    for _ in range(n):
        r, live = rng.random(), sorted(nodes)
        if r < 0.25 and live:
            ops.append(_update(rng.choice(live), **{rng.choice(["displayName", "description"]):
                                                    f"{who}{rng.randint(0, 2)}"}))
        elif r < 0.37 and live:
            eid = rng.choice(live)
            ops.append(_delete(eid))
            nodes.discard(eid)
            for k, ends in list(edges.items()):
                if eid in ends:
                    del edges[k]
        elif r < 0.5:                      # an id both sides may make: created again, or alike
            eid = rng.choice([f"s{i}" for i in range(4)] + [f"{who}n{rng.randint(0, 9)}"])
            if eid not in nodes:
                ops.append(_node(eid))
                nodes.add(eid)
        elif r < 0.72 and len(live) >= 2:
            a, b = rng.sample(live, 2)
            eid = rng.choice([f"se{i}" for i in range(4)] + [f"{who}e{rng.randint(0, 9)}"])
            if eid not in edges and (a, b) not in edges.values():
                ops.append(_edge(eid, a, b))
                edges[eid] = (a, b)
        elif r < 0.82 and edges:
            eid = rng.choice(sorted(edges))
            ops.append(_delete(eid, "edge"))
            del edges[eid]
        elif edges and len(live) >= 2:     # an edge's properties, or its ends, change
            eid = rng.choice(sorted(edges))
            a, b = edges[eid] if r < 0.92 else rng.sample(live, 2)
            if r < 0.92 or (a, b) not in edges.values():
                ops.append(_update(eid, kind="edge", sourceEntityId=a, targetEntityId=b,
                                   edgeType="LINEAGE", properties={"w": rng.randint(0, 3)}))
                edges[eid] = (a, b)
    return ops


def _plan(seed):
    rng = random.Random(seed)
    nodes, edges = {f"n{i}" for i in range(6)}, {}
    seed_ops = [_node(n) for n in sorted(nodes)]
    for i in range(6):
        a, b = rng.sample(sorted(nodes), 2)
        if (a, b) not in edges.values():
            edges[f"e{i}"] = (a, b)
            seed_ops.append(_edge(f"e{i}", a, b))
    dn, de, mn, me = set(nodes), dict(edges), set(nodes), dict(edges)
    mine = _ops(rng, "d", dn, de, rng.randint(2, 8))
    theirs = [_ops(rng, "m", mn, me, rng.randint(1, 5)) for _ in range(rng.randint(1, 3))]
    later = _ops(rng, "d", dn, de, rng.randint(0, 2)) if rng.random() < 0.3 else []
    return seed_ops, mine, theirs, later, random.Random(seed * 7)


async def _each(svc, gid, branch, actor, ops):
    """Write ``ops`` one at a time; a write the graph refuses (an id taken, an end gone) is part of
    the history, the same in both graphs."""
    told = []
    for op in ops:
        try:
            await svc.apply_ops(graph_id=gid, actor=actor, message="w", ops=[op],
                                **({"branch_id": branch} if branch else {}))
            told.append("ok")
        except Exception as exc:  # noqa: BLE001 — recorded, and compared across the two graphs
            told.append(type(exc).__name__)
    return told


async def _random_history(svc, plan, fork):
    seed_ops, mine, theirs, later, rng = plan
    parent = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                     actor="alice"))["graph_id"]
    told = await _each(svc, parent, None, "alice", seed_ops)
    gid = (await svc.fork_graph(parent_graph_id=parent, workspace_id="ws1", actor="bob"))["graph_id"] \
        if fork else parent
    draft = await svc.open_draft(graph_id=gid, owner="bob")
    if fork:                               # main moves with its parent, and on its own
        for batch in theirs:
            on_parent = rng.random() < 0.6
            told += await _each(svc, parent if on_parent else gid, None, "carol", batch)
            if on_parent:
                try:
                    await svc.update_fork_from_parent(fork_graph_id=gid, actor="bob")
                    told.append("updated")
                except Exception as exc:  # noqa: BLE001 — both sides changed one entity: as written
                    told.append(type(exc).__name__)
    told += await _each(svc, gid, draft, "bob", mine)
    if not fork:
        for batch in theirs:
            told += await _each(svc, gid, None, "carol", batch)
    told += await _each(svc, gid, draft, "bob", later)
    return gid, draft, told


async def _pull_one(svc, monkeypatch, gid, draft, paged, resolutions=None):
    monkeypatch.setattr(config, "SQUASH_PAGED_ABOVE", 0 if paged else 10 ** 9)
    try:
        r = await svc.rebase_draft(graph_id=gid, branch_id=draft, actor="bob", resolutions=resolutions)
        out = ("pulled", r["clean"], r.get("changes"),
               sorted((c["entity_id"], tuple(c["path"]), c["kind"]) for c in r["conflicts"]))
    except Exception as exc:  # noqa: BLE001 — a refusal, which must be the same both ways
        out = ("refused", type(exc).__name__, str(exc)[:200])
    async with db.graphver_session() as s:
        own = await svc._branch_own_payloads(s, gid, draft)
    return out, await svc.materialize_state(graph_id=gid, branch_id=draft), own


async def _alike(svc, monkeypatch, seed, fork):
    plan = _plan(seed)
    (ga, da, ta), (gb, db_, tb) = [await _random_history(svc, _plan(seed), fork) for _ in range(2)]
    assert ta == tb, seed
    whole = await _pull_one(svc, monkeypatch, ga, da, False)
    paged = await _pull_one(svc, monkeypatch, gb, db_, True)
    assert paged == whole, (seed, fork)
    if whole[0][0] == "pulled" and not whole[0][1]:      # conflicts: answer them alike, both ways
        rng = plan[4]
        answers = {eid: rng.random() < 0.4 for eid, _p, _k in whole[0][3]}
        resolved = []
        for gid, draft, paged_ in ((ga, da, False), (gb, db_, True)):
            async with db.graphver_session() as s:
                ours = await svc._current_values(s, gid, draft, sorted(answers))
            res = {eid: None if drop else ours.get(eid) for eid, drop in answers.items()}
            resolved.append(await _pull_one(svc, monkeypatch, gid, draft, paged_, res))
        assert resolved[1] == resolved[0], (seed, fork)
    return whole[0][0] + ":" + str(whole[0][1])


def test_a_large_draft_pulls_main_as_a_whole_draft_does(monkeypatch):
    async def run():
        try:
            await _run(monkeypatch)
            svc = GraphVersioningService()
            assert await _stale_resolution(svc, monkeypatch, True) == \
                await _stale_resolution(svc, monkeypatch, False)
        finally:
            await db.dispose_engine()
    asyncio.run(run())


def test_random_histories_pull_alike_either_way(monkeypatch):
    async def run():
        await models.create_schema_and_partitions()
        svc = GraphVersioningService()
        seen = {}
        try:
            for seed, fork in [*((i, False) for i in range(1, 31)), *((i, True) for i in range(101, 116))]:
                outcome = await _alike(svc, monkeypatch, seed, fork)
                seen[outcome] = seen.get(outcome, 0) + 1
        finally:
            await db.dispose_engine()
        assert {"pulled:True", "pulled:False"} <= set(seen), seen       # clean pulls and conflicts
    asyncio.run(run())
