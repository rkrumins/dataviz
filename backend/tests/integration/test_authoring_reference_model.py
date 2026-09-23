"""Randomized authoring against a reference model: whatever sequence of creates, edits, renames,
retypes and deletes a user makes — nodes and relationships, several ops on one entity in one save,
through either save path (canvas ``apply_ops`` or stage → checkpoint), then publish — the stored
state equals what a plain in-memory model of those edits says, after every step.

The model is deliberately naive (a dict per entity; an update is a patch; deleting a node removes
its relationships), so any divergence is the service losing, inventing or mangling data.
"""
import asyncio
import os
import random

import pytest

from backend.app.services.versioning import db, models
from backend.app.services.versioning.service import GraphVersioningService

TYPES = ["domain", "dataset", "column"]
CSET = ["CONTAINS"]
SEEDS = [1, 7, 42]
STEPS = 30


class Model:
    def __init__(self):
        self.nodes: dict = {}
        self.edges: dict = {}
        self.n = 0

    def fresh(self, prefix):
        self.n += 1
        return f"{prefix}{self.n}"

    def children(self, nid):
        return [v["targetEntityId"] for v in self.edges.values()
                if v["edgeType"] == "CONTAINS" and v["sourceEntityId"] == nid]

    def parent(self, nid):
        return next((v["sourceEntityId"] for v in self.edges.values()
                     if v["edgeType"] == "CONTAINS" and v["targetEntityId"] == nid), None)

    def apply(self, op):
        eid, kind, p = op["entity_id"], op["entity_kind"], op.get("payload")
        store = self.nodes if kind == "node" else self.edges
        if op["op"] == "delete":
            store.pop(eid, None)
            if kind == "node":
                for child in self.children(eid):       # the containment subtree goes with it
                    self.apply({"op": "delete", "entity_kind": "node", "entity_id": child})
                for e in [e for e, v in self.edges.items()
                          if eid in (v["sourceEntityId"], v["targetEntityId"])]:
                    self.edges.pop(e)
        elif op["op"] == "update":
            store[eid] = {**store[eid], **p}
        else:
            store[eid] = dict(p)


def _batch(rng: random.Random, m: Model) -> list:
    """1–4 ops that are valid against the model, applied to it as they are generated."""
    ops = []
    for _ in range(rng.randint(1, 4)):
        live_n, live_e = list(m.nodes), list(m.edges)
        r = rng.random()
        if r < 0.3 or len(live_n) < 2:
            eid = m.fresh("n")
            op = {"op": "create", "entity_kind": "node", "entity_id": eid,
                  "payload": {"urn": f"urn:{eid}", "entityType": rng.choice(TYPES),
                              "displayName": eid, "properties": {"k": rng.randint(0, 9)}}}
        elif r < 0.45:
            op = {"op": "update", "entity_kind": "node", "entity_id": rng.choice(live_n),
                  "payload": {"displayName": f"renamed-{rng.randint(0, 999)}"}}
        elif r < 0.55:
            op = {"op": "update", "entity_kind": "node", "entity_id": rng.choice(live_n),
                  "payload": {"entityType": rng.choice(TYPES), "description": "retyped"}}
        elif r < 0.62:
            op = {"op": "delete", "entity_kind": "node", "entity_id": rng.choice(live_n),
                  "payload": None}
        elif r < 0.85:
            src, tgt = rng.sample(live_n, 2)
            etype = "CONTAINS" if rng.random() < 0.4 else "FLOWS_TO"
            if any((v["sourceEntityId"], v["targetEntityId"], v["edgeType"]) == (src, tgt, etype)
                   for v in m.edges.values()):
                continue                                   # no duplicate relationship
            if etype == "CONTAINS":                       # one parent, no loop
                anc, a = set(), src
                while a is not None and a not in anc:
                    anc.add(a)
                    a = m.parent(a)
                if m.parent(tgt) is not None or tgt in anc:
                    continue
            eid = m.fresh("e")
            op = {"op": "create", "entity_kind": "edge", "entity_id": eid,
                  "payload": {"sourceEntityId": src, "targetEntityId": tgt, "edgeType": etype}}
        elif r < 0.89:                                    # move a child, then delete its old parent
            kids = [n for n in live_n if m.parent(n) is not None]
            if not kids:
                continue
            kid = rng.choice(kids)
            old_p = m.parent(kid)
            old_e = next(e for e, v in m.edges.items()
                         if v["edgeType"] == "CONTAINS" and v["targetEntityId"] == kid)
            under_kid, stack = set(), [kid]
            while stack:
                x = stack.pop()
                under_kid.add(x)
                stack.extend(m.children(x))
            new_p = rng.choice([n for n in live_n if n not in under_kid and n != old_p] or [None])
            if new_p is None or old_p in under_kid:
                continue
            anc, a = set(), new_p                          # the new parent must survive old_p's delete
            while a is not None and a not in anc:
                anc.add(a)
                a = m.parent(a)
            if old_p in anc:
                continue
            eid = m.fresh("e")
            for op in ({"op": "delete", "entity_kind": "edge", "entity_id": old_e, "payload": None},
                       {"op": "create", "entity_kind": "edge", "entity_id": eid,
                        "payload": {"sourceEntityId": new_p, "targetEntityId": kid,
                                    "edgeType": "CONTAINS"}},
                       {"op": "delete", "entity_kind": "node", "entity_id": old_p, "payload": None}):
                m.apply(op)
                ops.append(op)
            continue
        elif live_e and r < 0.95:
            op = {"op": "update", "entity_kind": "edge", "entity_id": rng.choice(live_e),
                  "payload": {"properties": {"w": rng.randint(0, 9)}}}
        elif live_e:
            op = {"op": "delete", "entity_kind": "edge", "entity_id": rng.choice(live_e),
                  "payload": None}
        else:
            continue
        m.apply(op)
        ops.append(op)
    return ops


def _strip(state: dict) -> dict:
    return {k: v for k, v in state.items() if v is not None}


async def _check(svc, gid, bid, m: Model, where: str) -> None:
    st = await svc.materialize_state(graph_id=gid, branch_id=bid)
    assert _strip(st["nodes"]) == m.nodes, where
    assert _strip(st["edges"]) == m.edges, where


async def _run(seed: int) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                  actor="alice"))["graph_id"]
    main = await svc.main_branch_id(gid)
    rng, m = random.Random(seed), Model()
    for draft_no in range(2):                              # two draft → publish rounds
        d = await svc.open_draft(graph_id=gid, owner="alice", shared=bool(draft_no))
        for step in range(STEPS):
            ops = _batch(rng, m)
            if not ops:
                continue
            if rng.random() < 0.5:
                await svc.apply_ops(graph_id=gid, branch_id=d, actor="alice", ops=ops,
                                    containment_edge_types=CSET)
            else:
                await svc.stage_changes(graph_id=gid, branch_id=d, actor="alice", ops=ops)
                await svc.checkpoint(graph_id=gid, branch_id=d, actor="alice",
                                     containment_edge_types=CSET)
            await _check(svc, gid, d, m, f"seed={seed} draft={draft_no} step={step} ops={ops}")
        await svc.publish(graph_id=gid, branch_id=d, actor="alice", message=f"round {draft_no}",
                          containment_edge_types=CSET)
        await _check(svc, gid, main, m, f"seed={seed} after publish {draft_no}")
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
@pytest.mark.parametrize("seed", SEEDS)
def test_random_authoring_matches_the_model(seed):
    asyncio.run(_run(seed))
