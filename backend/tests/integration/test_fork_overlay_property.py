"""A fork read through its overlay is what its history says it is — Postgres and FalkorDB.

Random interleavings, from fixed seeds, of commits on a root graph (tables and columns made,
renamed, given properties, deleted; flows drawn, given properties, re-pointed, deleted; columns
moved to another table) and on a fork of it and a fork of that fork. The root is projected into a
FalkorDB key of its own after each of its commits, for real. After every step, each fork read
through its overlay over that key — as ContextEngine reads a fork while its root's projection holds
its head — equals the fork's state as Postgres composes it (``materialize_state``) entity by
entity and field by field, child counts included, and the node and edge counts agree.
"""
import asyncio
import os
import random

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService
from backend.common.models.graph import EdgeQuery, NodeQuery

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E") or os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="set GRAPHVER_E2E=1 and RUN_FALKOR_LIVE=1 with FalkorDB reachable")]

CONT = ["CONTAINS"]
EDGE_TYPES = ["CONTAINS", "FLOWS"]
STEPS = 36


def _node(eid, typ, name, op="create"):
    return {"op": op, "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": eid, "entityType": typ, "displayName": name,
                        "properties": {"note": name.lower()}}}


def _edge(eid, src, tgt, typ, w=0, op="create"):
    return {"op": op, "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": typ, "sourceEntityId": src, "targetEntityId": tgt,
                        "properties": {"w": w}}}


def _delete(eid, kind):
    return {"op": "delete", "entity_kind": kind, "entity_id": eid, "payload": None}


class _Writer:
    """Makes random edits to one graph's main that its state allows, with ids of its own."""

    def __init__(self, svc, gid, main, tag, rng):
        self.svc, self.gid, self.main, self.tag, self.rng = svc, gid, main, tag, rng
        self.n = 0

    def _id(self, kind):
        self.n += 1
        return f"{self.tag}{kind}{self.n}"

    async def step(self):
        state = await self.svc.materialize_state(graph_id=self.gid, branch_id=self.main)
        nodes, edges = state["nodes"], state["edges"]
        tables = sorted(e for e, p in nodes.items() if p["entityType"] == "Table")
        columns = sorted(e for e, p in nodes.items() if p["entityType"] == "Column")
        parent = {p["targetEntityId"]: (e, p["sourceEntityId"]) for e, p in edges.items()
                  if p["edgeType"] == "CONTAINS"}
        flows = {e: p for e, p in edges.items() if p["edgeType"] == "FLOWS"}
        pairs = {(p["sourceEntityId"], p["targetEntityId"]) for p in flows.values()}
        r = self.rng
        choices = ["table", "column"]
        if nodes:
            choices += ["rename"] * 2
        if columns:
            choices += ["delete_column", "move"]
        if len(columns) >= 2:
            choices += ["flow"] * 3
        if flows:
            choices += ["weigh"] * 3 + ["repoint", "unflow"]
        if parent:
            choices += ["weigh_parent"] * 2
        if len(tables) > 2:
            choices.append("delete_table")
        kind = r.choice(choices)
        if kind == "table" or (kind == "column" and not tables):
            t = self._id("t")
            ops = [_node(t, "Table", f"T {t}")]
        elif kind == "column":
            c, t = self._id("c"), r.choice(tables)
            ops = [_node(c, "Column", f"C {c}"), _edge(self._id("k"), t, c, "CONTAINS")]
        elif kind == "rename":
            e = r.choice(sorted(nodes))
            ops = [_node(e, nodes[e]["entityType"], f"{nodes[e]['displayName']}'", op="update")]
        elif kind == "delete_column":
            ops = [_delete(r.choice(columns), "node")]
        elif kind == "delete_table":
            ops = [_delete(r.choice(tables), "node")]
        elif kind == "move":
            c = r.choice(columns)
            to = [t for t in tables if t != parent.get(c, (None, None))[1]]
            if not to:
                return await self.step()
            ops = [{"op": "move", "entity_kind": "node", "entity_id": c,
                    "payload": {"parentEntityId": r.choice(to), "edgeType": "CONTAINS",
                                "edgeId": self._id("k")}}]
        elif kind == "flow":
            free = [(a, b) for a in columns for b in columns if a != b and (a, b) not in pairs]
            if not free:
                return await self.step()
            a, b = r.choice(free)
            ops = [_edge(self._id("f"), a, b, "FLOWS", w=r.randint(0, 9))]
        elif kind == "weigh":
            e = r.choice(sorted(flows))
            p = flows[e]
            ops = [_edge(e, p["sourceEntityId"], p["targetEntityId"], "FLOWS",
                         w=p["properties"]["w"] + 1, op="update")]
        elif kind == "weigh_parent":
            e, t = parent[r.choice(sorted(parent))]
            p = edges[e]
            ops = [_edge(e, t, p["targetEntityId"], "CONTAINS",
                         w=(p.get("properties") or {}).get("w", 0) + 1, op="update")]
        elif kind == "repoint":
            e = r.choice(sorted(flows))
            a = flows[e]["sourceEntityId"]
            to = [b for b in columns if b != a and (a, b) not in pairs]
            if not to:
                return await self.step()
            ops = [_edge(e, a, r.choice(to), "FLOWS", w=flows[e]["properties"]["w"], op="update")]
        else:                                                    # unflow
            ops = [_delete(r.choice(sorted(flows)), "edge")]
        await self.svc.apply_ops(graph_id=self.gid, actor=self.tag, message=kind, ops=ops,
                                 containment_edge_types=CONT)
        return kind


def _props(props) -> dict:
    """The properties a writer here sets: the rest is what a reader adds (``childCount``)."""
    return {k: v for k, v in (props or {}).items() if k in ("note", "w")}


async def _check(svc, base, gid, main, urns, label):
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider

    state = await svc.materialize_state(graph_id=gid, branch_id=main)
    nodes = {p["urn"]: p for p in state["nodes"].values()}
    edges = state["edges"]
    children: dict = {}
    for p in edges.values():
        if p["edgeType"] == "CONTAINS":
            children[p["sourceEntityId"]] = children.get(p["sourceEntityId"], 0) + 1

    overlay = DraftOverlayProvider(base, svc=svc, graph_id=gid, branch_id=main, fork=True)
    overlay.set_containment_edge_types(CONT)
    got = {n.urn: n for n in await overlay.get_nodes(NodeQuery(urns=sorted(urns), limit=len(urns)))}
    assert sorted(got) == sorted(nodes), label
    for urn, n in got.items():
        want = nodes[urn]
        assert (n.entity_type, n.display_name, _props(n.properties), n.child_count or 0) == (
            want["entityType"], want["displayName"], _props(want.get("properties")),
            children.get(urn, 0)), (label, urn)
    got_edges = {e.id: e for e in await overlay.get_edges(EdgeQuery(edge_types=EDGE_TYPES,
                                                                    limit=10_000))}
    assert sorted(got_edges) == sorted(edges), label
    for eid, e in got_edges.items():
        want = edges[eid]
        assert (e.source_urn, e.target_urn, e.edge_type, _props(e.properties)) == (
            want["sourceEntityId"], want["targetEntityId"], want["edgeType"],
            _props(want.get("properties"))), (label, eid)


async def _run(seed: int) -> None:
    from falkordb.asyncio import FalkorDB
    from redis.asyncio import ConnectionPool

    from backend.app.providers.falkordb_provider import FalkorDBProvider
    from backend.app.services.versioning.projection import FalkorProjector

    await models.create_schema_and_partitions()
    host, port = os.getenv("FALKORDB_HOST", "localhost"), int(os.getenv("FALKORDB_PORT", "6379"))
    rng = random.Random(seed)
    svc = GraphVersioningService()
    key = "gvt_prop_" + os.urandom(4).hex()
    pool = ConnectionPool(host=host, port=port, max_connections=4)
    handle = FalkorDB(connection_pool=pool)
    base = FalkorDBProvider(host=host, port=port, graph_name=key)
    base.set_containment_edge_types(CONT)
    try:
        root = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(),
                                       workspace_id="ws1", actor="alice", falkor_graph_name=key,
                                       owns_falkor_graph=True))["graph_id"]
        projector = FalkorProjector(lambda _name, _provider=None: handle.select_graph(key))
        writers = {"root": _Writer(svc, root, await svc.main_branch_id(root), "r", rng)}
        for _ in range(6):
            await writers["root"].step()
        await projector.project_graph(root)
        fork = await svc.fork_graph(parent_graph_id=root, workspace_id="ws1", actor="bob")
        writers["fork"] = _Writer(svc, fork["graph_id"], fork["main_branch_id"], "f", rng)
        forks = [writers["fork"]]
        for step in range(STEPS):
            if step == 4:                                        # a fork of the fork, then on
                leaf = await svc.fork_graph(parent_graph_id=fork["graph_id"], workspace_id="ws1",
                                            actor="carol")
                writers["leaf"] = _Writer(svc, leaf["graph_id"], leaf["main_branch_id"], "l", rng)
                forks.append(writers["leaf"])
            who = rng.choice(sorted(writers))
            kind = await writers[who].step()
            if who == "root":
                result = await projector.project_graph(root)
                assert not result.get("verify_error"), result
            urns = {n for w in writers.values() for n in await _urns(svc, w)}
            for w in forks:
                await _check(svc, base, w.gid, w.main, urns,
                             f"seed {seed} step {step} ({who} {kind}): {w.tag}")
    finally:
        try:
            await handle.select_graph(key).delete()
        except Exception:
            pass  # cleanup is best effort: the key may already be gone
        await pool.disconnect()
        await db.dispose_engine()


async def _urns(svc, writer):
    """Every node urn the writer's graph has ever had: one the overlay must leave out is asked
    for too."""
    from sqlalchemy import select

    from backend.app.services.versioning.models import NodeVersionORM
    async with db.graphver_session() as s:
        return set((await s.execute(select(NodeVersionORM.urn).where(
            NodeVersionORM.graph_id == writer.gid, NodeVersionORM.urn.isnot(None))
            .distinct())).scalars())


@pytest.mark.parametrize("seed", [7, 2026])
def test_a_forks_overlay_reads_what_its_history_says(seed):
    asyncio.run(_run(seed))
