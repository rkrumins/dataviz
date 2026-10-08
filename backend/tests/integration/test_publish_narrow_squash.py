"""The narrow squash publishes exactly what the full merge does (live Postgres).

An up-to-date draft of a non-fork graph, published with no conflict resolutions, takes the narrow
squash: planned from content hashes, gated on version-row columns, rows copied inside Postgres
(``GraphVersioningService._squash_up_to_date``). Every scenario here runs on two identical graphs
— the full path on one (``GRAPHVER_NARROW_SQUASH`` off), the narrow one on the other — and the
outcome must be the same to the byte: main's heads, the squash commit's rows (payloads, identity
columns, hashes and pre-images), its stats and Merkle root, the draft's state, and any refusal
(the same violations, in the same order). Scenarios: randomized drafts of updates, retypes,
creates, deletes and reverts, with and without an ontology that canonicalizes type spellings,
under strict enforcement that refuses some of them, published directly or through a merge
request; a draft whose deleted node still has edges on main (the squash cascades them); and one
whose edge lost its end (refused).
"""
import asyncio
import os
import random

import pytest
from sqlalchemy import delete, select, update

from backend.app.services.versioning import config, db, models
from backend.app.services.versioning.models import (
    BranchORM, CommitORM, EdgeVersionORM, EntityHeadORM, GraphORM, NodeVersionORM,
)
from backend.app.services.versioning.ontology import EdgeRule, EntityRule, OntologyRules
from backend.app.services.versioning.service import GraphVersioningService

CONT = ["CONTAINS"]
_TYPES = {"Schema": EntityRule(), "Table": EntityRule(), "Column": EntityRule(), "View": EntityRule()}
_EDGES = {"CONTAINS": EdgeRule(is_containment=True), "LINEAGE": EdgeRule()}
# Canonicalizes spellings: a draft's "table"/"Lineage"-spelled rows are rewritten at publish.
CANON = OntologyRules(entity_types=_TYPES, edge_types=_EDGES, containment_edge_types=frozenset(CONT),
                      edge_type_canonical={"CONTAINS": "CONTAINS", "LINEAGE": "Lineage"})
# Strict: no View, and only a Schema may sit at the top level.
STRICT = OntologyRules(entity_types={k: v for k, v in _TYPES.items() if k != "View"}, edge_types=_EDGES,
                       containment_edge_types=frozenset(CONT), root_entity_types=frozenset({"Schema"}))


def _node(eid, typ, name=None):
    return {"op": "create", "entity_kind": "node", "entity_id": eid,
            "payload": {"urn": f"urn:{eid}", "entityType": typ, "displayName": name or eid,
                        "qualifiedName": f"q.{eid}", "properties": {"rank": len(eid)}}}


def _edge(eid, src, tgt, typ):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": typ, "sourceEntityId": src, "targetEntityId": tgt,
                        "confidence": 0.5, "properties": {"w": 1}}}


def _seed_ops():
    ops, schemas, tables, columns = [], [f"S{i}" for i in range(3)], [], []
    for s in schemas:
        ops.append(_node(s, "Schema"))
    for i in range(8):
        t = f"T{i}"
        tables.append(t)
        ops += [_node(t, "Table"), _edge(f"c_{t}", schemas[i % 3], t, "CONTAINS")]
        for j in range(3):
            c = f"{t}.C{j}"
            columns.append(c)
            ops += [_node(c, "Column"), _edge(f"c_{c}", t, c, "CONTAINS")]
    lineage = {}
    for k in range(20):
        a, b = columns[k], columns[(k * 7 + 3) % len(columns)]
        if a != b and (a, b) not in lineage:
            lineage[(a, b)] = f"l{k}"
            ops.append(_edge(f"l{k}", a, b, "LINEAGE"))
    return ops, schemas, tables, columns, lineage


def _batches(rng, schemas, tables, columns, lineage, *, clean):
    """A random draft as batches of ops: edits, creates, deletes, then a revert of some edits.
    Not ``clean``: some of it a strict ontology refuses (an undeclared type, a case-variant retype,
    a table at the top level)."""
    nodes = schemas + tables + columns
    edits, reverts = [], []
    for eid in rng.sample(nodes, 12):
        roll = rng.random()
        if roll < 0.35:
            edits.append({"op": "update", "entity_kind": "node", "entity_id": eid,
                          "payload": {"displayName": f"{eid} v2"}})
            if rng.random() < 0.5:                       # changed, then changed back: no change
                reverts.append({"op": "update", "entity_kind": "node", "entity_id": eid,
                                "payload": {"displayName": eid}})
        elif roll < 0.6:
            edits.append({"op": "update", "entity_kind": "node", "entity_id": eid,
                          "payload": {"properties": {"x": rng.randint(0, 3)}}})
        elif roll < 0.8 and eid in tables and not clean:
            edits.append({"op": "update", "entity_kind": "node", "entity_id": eid,
                          "payload": {"entityType": "table"}})        # a case-variant retype
        else:
            edits.append({"op": "update", "entity_kind": "node", "entity_id": eid,
                          "payload": {"displayName": eid}})          # a no-op
    creates = []
    for i in range(6):
        t = f"N{i}"
        typ = "Table" if clean else rng.choice(["Table", "table", "View"])
        creates.append(_node(t, typ))
        if clean or rng.random() < 0.8:                  # else at the top level
            creates.append(_edge(f"c_{t}", rng.choice(schemas), t, rng.choice(["CONTAINS", "contains"])))
    for i in range(6):
        a, b = rng.sample(columns, 2)
        if (a, b) not in lineage:
            lineage[(a, b)] = f"nl{i}"
            creates.append(_edge(f"nl{i}", a, b, rng.choice(["LINEAGE", "Lineage", "lineage"])))
    gone = rng.sample(columns, 3)
    deletes = [{"op": "delete", "entity_kind": "node", "entity_id": c, "payload": None} for c in gone]
    deletes += [{"op": "delete", "entity_kind": "edge", "entity_id": eid, "payload": None}
                for (a, b), eid in rng.sample(sorted(lineage.items()), 3)
                if a not in gone and b not in gone and not eid.startswith("nl")]
    edge_edits = [{"op": "update", "entity_kind": "edge", "entity_id": eid,
                   "payload": {"properties": {"w": 2}, "confidence": 0.9}}
                  for (a, b), eid in rng.sample(sorted(lineage.items()), 3)
                  if a not in gone and b not in gone and not eid.startswith("nl")]
    return [edits, creates, deletes, edge_edits, reverts]


async def _twins(svc):
    """Two graphs holding the same main, and a draft on each."""
    ops, *shape = _seed_ops()
    pair = []
    for _ in range(2):
        gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1",
                                      actor="alice"))["graph_id"]
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=ops,
                            containment_edge_types=CONT)
        pair.append((gid, await svc.open_draft(graph_id=gid, owner="alice")))
    return pair, shape


async def _same(*calls):
    """Run each call; all must succeed alike or fail alike. Returns the outcomes."""
    out = []
    for call in calls:
        try:
            out.append(("ok", await call()))
        except Exception as exc:                          # noqa: BLE001 — compared below
            out.append((type(exc).__name__, getattr(exc, "violations", None) or str(exc)))
    kinds = {o[0] for o in out}
    assert len(kinds) == 1, out
    return out


async def _outcome(gid, draft):
    """What a publish left: main's heads, the squash commit and its rows, the draft."""
    async with db.graphver_session() as s:
        graph = await s.get(GraphORM, gid)
        main = (await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == gid, BranchORM.kind == "main"))).scalar_one()
        heads = {r.entity_id: (r.entity_kind, r.content_hash, r.is_tombstone) for r in (await s.execute(
            select(EntityHeadORM).where(EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == main)
        )).scalars()}
        commit = (await s.execute(select(CommitORM).where(
            CommitORM.graph_id == gid, CommitORM.branch_id == main)
            .order_by(CommitORM.commit_seq.desc()).limit(1))).scalar_one()
        nodes = {r.entity_id: (r.op, r.content_hash, r.prev_content_hash, r.payload, r.urn, r.entity_type,
                               r.display_name, r.qualified_name, r.actor, r.commit_seq)
                 for r in (await s.execute(select(NodeVersionORM).where(
                     NodeVersionORM.graph_id == gid, NodeVersionORM.commit_id == commit.id))).scalars()}
        edges = {r.entity_id: (r.op, r.content_hash, r.prev_content_hash, r.payload, r.source_entity_id,
                               r.target_entity_id, r.edge_type, r.confidence, r.discriminator, r.actor)
                 for r in (await s.execute(select(EdgeVersionORM).where(
                     EdgeVersionORM.graph_id == gid, EdgeVersionORM.commit_id == commit.id))).scalars()}
        branch = await s.get(BranchORM, draft)
        return {"seq": graph.main_head_commit_seq, "heads": heads, "kind": commit.kind,
                "stats": commit.stats, "merkle": commit.merkle_root, "nodes": nodes, "edges": edges,
                "contributors": commit.contributors, "source_count": commit.source_commit_count,
                "draft": (branch.status, branch.base_commit_seq)}


async def _heads_resolve(gid):
    """Every head on main points at a version row of its own kind with its own hash."""
    async with db.graphver_session() as s:
        main = (await s.execute(select(BranchORM.id).where(
            BranchORM.graph_id == gid, BranchORM.kind == "main"))).scalar_one()
        for model, kind in ((NodeVersionORM, "node"), (EdgeVersionORM, "edge")):
            rows = (await s.execute(
                select(EntityHeadORM.entity_id, EntityHeadORM.content_hash, model.content_hash, model.entity_id)
                .join(model, (model.graph_id == EntityHeadORM.graph_id)
                      & (model.id == EntityHeadORM.head_version_id))
                .where(EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == main,
                       EntityHeadORM.entity_kind == kind))).all()
            assert all(h == v and e == ve for e, h, v, ve in rows), rows
        dangling = (await s.execute(
            select(EntityHeadORM.entity_id).where(
                EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == main,
                ~EntityHeadORM.head_version_id.in_(select(NodeVersionORM.id).where(NodeVersionORM.graph_id == gid)),
                ~EntityHeadORM.head_version_id.in_(select(EdgeVersionORM.id).where(EdgeVersionORM.graph_id == gid)))
        )).scalars().all()
        assert not dangling, dangling


async def _publish_both(svc, pair, *, rules=None, via_mr=False, monkeypatch):
    """The full path on the first graph, the narrow one on the second."""
    async def run(gid, draft, narrow):
        monkeypatch.setattr(config, "NARROW_SQUASH", narrow)
        if via_mr:
            mr = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="alice", title="t")
            return await svc.merge_mr(mr_id=mr, actor="bob", message="merge",
                                      containment_edge_types=CONT, ontology_rules=rules)
        return await svc.publish(graph_id=gid, branch_id=draft, actor="bob", message="publish",
                                 containment_edge_types=CONT, ontology_rules=rules)
    (ga, da), (gb, db_) = pair
    out = await _same(lambda: run(ga, da, False), lambda: run(gb, db_, True))
    if out[0][0] != "ok":
        assert out[0] == out[1], out                      # the same refusal, the same violations
        return out[0]
    a, b = await _outcome(ga, da), await _outcome(gb, db_)
    assert a == b, {k: (a[k], b[k]) for k in a if a[k] != b[k]}
    await _heads_resolve(gb)
    return a


async def _randomized(svc, seed, monkeypatch) -> str:
    rng = random.Random(seed)
    variant = ("plain", "canon", "strict_rules", "strict_spec", "mr")[seed % 5]
    pair, (schemas, tables, columns, lineage) = await _twins(svc)
    clean = not variant.startswith("strict") or (seed // 5) % 2 == 1
    for ops in _batches(rng, schemas, tables, columns, lineage, clean=clean):
        await _same(*(lambda g=g, d=d: svc.apply_ops(graph_id=g, branch_id=d, actor="alice", ops=ops,
                                                     containment_edge_types=CONT)
                      for g, d in pair))
    rules = {"canon": CANON, "strict_rules": STRICT}.get(variant)
    if variant.startswith("strict"):
        async with db.graphver_session() as s:
            await s.execute(update(GraphORM).where(GraphORM.id.in_([g for g, _ in pair])).values(
                ontology_enforcement="strict",
                ontology_spec={"entity_types": ["Schema", "Table", "Column"]} if variant == "strict_spec" else None))
    out = await _publish_both(svc, pair, rules=rules, via_mr=variant == "mr", monkeypatch=monkeypatch)
    return variant if isinstance(out, dict) else f"{variant}:{out[0]}"


async def _cascade_from_main(svc, monkeypatch) -> None:
    """A draft deleted a node but holds nothing for its edges (a draft written before deletes
    cascaded): the squash deletes them from main all the same."""
    pair, (_s, _t, columns, lineage) = await _twins(svc)
    victim = next(a for (a, _b) in lineage)
    for gid, draft in pair:
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", containment_edge_types=CONT,
                            ops=[{"op": "delete", "entity_kind": "node", "entity_id": victim, "payload": None}])
        async with db.graphver_session() as s:          # forget the cascade the delete wrote
            edges = (await s.execute(select(EntityHeadORM.entity_id).where(
                EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == draft,
                EntityHeadORM.entity_kind == "edge"))).scalars().all()
            assert edges, "the delete cascaded to the node's edges"
            await s.execute(delete(EntityHeadORM).where(
                EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == draft,
                EntityHeadORM.entity_id.in_(edges)))
    out = await _publish_both(svc, pair, monkeypatch=monkeypatch)
    assert {eid for eid, row in out["edges"].items() if row[0] == "delete"} == set(edges), out["edges"]


async def _dangling(svc, monkeypatch) -> None:
    """A draft edge whose end is gone from the draft and from main is refused."""
    pair, (schemas, _t, _c, _l) = await _twins(svc)
    for gid, draft in pair:
        await svc.apply_ops(graph_id=gid, branch_id=draft, actor="alice", containment_edge_types=CONT,
                            ops=[_node("Z", "Table"), _edge("c_Z", schemas[0], "Z", "CONTAINS")])
        async with db.graphver_session() as s:          # the node's own head is lost
            await s.execute(delete(EntityHeadORM).where(
                EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == draft, EntityHeadORM.entity_id == "Z"))
    out = await _publish_both(svc, pair, monkeypatch=monkeypatch)
    assert out[0] == "ConcurrencyError" and "c_Z" in out[1], out


async def _run(monkeypatch) -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    seen = [await _randomized(svc, seed, monkeypatch) for seed in range(15)]
    # every variant ran, and strict enforcement refused some drafts and passed others
    assert {v.split(":")[0] for v in seen} == {"plain", "canon", "strict_rules", "strict_spec", "mr"}, seen
    assert {"strict_rules", "strict_spec", "strict_rules:OntologyViolation",
            "strict_spec:OntologyViolation"} <= set(seen), seen
    await _cascade_from_main(svc, monkeypatch)
    await _dangling(svc, monkeypatch)
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_the_narrow_squash_publishes_what_the_full_merge_does(monkeypatch):
    asyncio.run(_run(monkeypatch))
