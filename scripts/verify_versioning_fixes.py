#!/usr/bin/env python3
"""Service-layer regression checks for the versioned-graph merge/enablement/concurrency fixes.

Unlike ``versioning_smoke.py`` (HTTP), this drives ``GraphVersioningService`` directly, so it
runs where the app deps + the graphver Postgres (and, for the projection check, FalkorDB) are
reachable — e.g. inside the viz-service container:

    docker exec -w /app -e PYTHONPATH=/app <viz-service> python scripts/verify_versioning_fixes.py

Covers:
  * Part 1A — node/edge kind stays authoritative; entities land in the right version table;
    entity history is create->update (NOT create->delete->create); partial updates preserve fields.
  * Part 1F — staged-but-uncommitted working changes survive publish AND merge_mr (auto-checkpoint).
  * Part 1F/D2 — rebase surfaces a delete/modify conflict instead of silently dropping a draft edit.
  * Part 1E — after projection, FalkorDB live counts reconcile with committed main; a node dropped
    from FalkorDB is bounded-healed via reseed (requires FalkorDB; skipped if unreachable).
  * Part 3  — concurrent apply_ops both land (commit-seq retry); concurrent publishes serialize
    (one wins, the loser gets a clean NotUpToDate — no crash, no loss).
  * Part 2A — enable_versioning imports a provider's full state into Postgres, atomically + idempotently.
  * Part 2C — resync_from_provider applies provider changes via 3-way merge without clobbering edits.
"""
from __future__ import annotations

import asyncio
import uuid

from backend.app.services.versioning.service import (
    GraphVersioningService, NotUpToDate, ConcurrencyError,
)
from backend.app.services.versioning import db
from backend.app.services.versioning.models import (
    EntityHeadORM, NodeVersionORM, EdgeVersionORM, GraphORM, BranchORM,
)
from backend.app.services.versioning.changeset import net_delta
from backend.common.models.graph import GraphNode, GraphEdge, NodeQuery, EdgeQuery
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

GREEN, RED, DIM, RESET = "\033[32m", "\033[31m", "\033[2m", "\033[0m"


def _node_op(urn, **extra):
    return {"op": "create", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": "dataset", "displayName": urn[-6:], **extra}}


class FakeProvider:
    def __init__(self, nodes, edges):
        self.nodes, self.edges = nodes, edges

    async def get_nodes(self, q: NodeQuery):
        return self.nodes if (q.offset or 0) == 0 else []

    async def get_edges(self, q: EdgeQuery):
        return self.edges if (q.offset or 0) == 0 else []


class Checks:
    def __init__(self):
        self.failures: list[str] = []
        self.n = 0

    def ok(self, msg):
        self.n += 1
        print(f"  {GREEN}✓{RESET} {msg}")

    def fail(self, msg):
        self.failures.append(msg)
        print(f"  {RED}✗{RESET} {msg}")

    def check(self, cond, ok_msg, fail_msg):
        self.ok(ok_msg) if cond else self.fail(fail_msg)


async def part_1a(svc, c, actor, ws):
    g = await svc.create_graph(data_source_id="ds_" + uuid.uuid4().hex[:8], workspace_id=ws,
                               kind="manual", actor=actor)
    gid, mid = g["graph_id"], g["main_branch_id"]
    ua, ub = (f"urn:li:dataset:A_{uuid.uuid4().hex[:6]}", f"urn:li:dataset:B_{uuid.uuid4().hex[:6]}")
    eid = "ent_e_" + uuid.uuid4().hex[:6]
    d1 = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=d1, actor=actor, ops=[
        _node_op(ua, properties={"k": "v"}), _node_op(ub),
        {"op": "create", "entity_kind": "edge", "entity_id": eid,
         "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": ua, "targetEntityId": ub}}])
    await svc.publish(graph_id=gid, branch_id=d1, actor=actor, message="v1")
    d2 = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor=actor, ops=[
        {"op": "update", "entity_kind": "node", "entity_id": ua,
         "payload": {"displayName": "A2", "properties": {"k": "v2"}}},
        {"op": "update", "entity_kind": "edge", "entity_id": eid,
         "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": ua, "targetEntityId": ub,
                     "confidence": 0.5}}])
    await svc.publish(graph_id=gid, branch_id=d2, actor=actor, message="v2")

    async with db.graphver_session() as s:
        heads = {r.entity_id: r for r in (await s.execute(select(EntityHeadORM).where(
            EntityHeadORM.graph_id == gid, EntityHeadORM.branch_id == mid))).scalars()}
        kinds_ok = (heads[ua].entity_kind == "node" and heads[ub].entity_kind == "node"
                    and heads[eid].entity_kind == "edge")
        edge_in_nodes = (await s.execute(select(NodeVersionORM.id).where(
            NodeVersionORM.graph_id == gid, NodeVersionORM.entity_id == eid))).first()
        edge_in_edges = (await s.execute(select(EdgeVersionORM.id).where(
            EdgeVersionORM.graph_id == gid, EdgeVersionORM.entity_id == eid))).first()
    c.check(kinds_ok, "1A: entity_kind authoritative (node/node/edge)", "1A: entity_kind flipped")
    c.check(edge_in_nodes is None and edge_in_edges is not None,
            "1A: edge in edge_versions only (right table)", "1A: edge landed in the wrong table")
    for x, label in ((ua, "node"), (eid, "edge")):
        ops = [h["op"] for h in await svc.entity_history(graph_id=gid, entity_id=x)
               if h["branch_id"] == mid]
        c.check(ops == ["create", "update"], f"1A: {label} history create->update",
                f"1A: {label} history = {ops} (delete/recreate churn)")
    av = await svc.entity_value(graph_id=gid, entity_id=ua, branch_id=mid)
    c.check(av and av.get("urn") == ua and av.get("displayName") == "A2",
            "1A: partial update preserved urn + applied displayName", f"1A: node A fields lost: {av}")


async def part_1f(svc, c, actor, ws):
    g = await svc.create_graph(data_source_id="ds_" + uuid.uuid4().hex[:8], workspace_id=ws,
                               kind="manual", actor=actor)
    gid, mid = g["graph_id"], g["main_branch_id"]
    d = await svc.open_draft(graph_id=gid, owner=actor)
    u = f"urn:li:dataset:staged_{uuid.uuid4().hex[:6]}"
    await svc.stage_changes(graph_id=gid, branch_id=d, actor=actor, ops=[_node_op(u)])  # NO checkpoint
    await svc.publish(graph_id=gid, branch_id=d, actor=actor, message="v1")
    v = await svc.entity_value(graph_id=gid, entity_id=u, branch_id=mid)
    c.check(bool(v), "1F: staged-but-uncommitted change survives publish (auto-checkpoint)",
            "1F: publish dropped a staged change")


async def part_d2(svc, c, actor, ws):
    g = await svc.create_graph(data_source_id="ds_" + uuid.uuid4().hex[:8], workspace_id=ws,
                               kind="manual", actor=actor)
    gid = g["graph_id"]
    u = f"urn:li:dataset:d2_{uuid.uuid4().hex[:6]}"
    d0 = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor=actor, ops=[_node_op(u)])
    await svc.publish(graph_id=gid, branch_id=d0, actor=actor, message="seed")
    dA = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=dA, actor=actor, ops=[
        {"op": "update", "entity_kind": "node", "entity_id": u, "payload": {"displayName": "edited"}}])
    dB = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=dB, actor=actor, ops=[
        {"op": "delete", "entity_kind": "node", "entity_id": u, "payload": None}])
    await svc.publish(graph_id=gid, branch_id=dB, actor=actor, message="delete")
    res = await svc.rebase_draft(graph_id=gid, branch_id=dA, actor=actor)
    c.check(res.get("clean") is False and bool(res.get("conflicts")),
            "D2: rebase surfaces delete/modify conflict (no silent drop)",
            f"D2: rebase silently resolved: {res}")


async def part_3(svc, c, actor, ws):
    g = await svc.create_graph(data_source_id="ds_" + uuid.uuid4().hex[:8], workspace_id=ws,
                               kind="manual", actor=actor)
    gid, mid = g["graph_id"], g["main_branch_id"]
    u1, u2 = (f"urn:li:dataset:c_{uuid.uuid4().hex[:6]}", f"urn:li:dataset:c_{uuid.uuid4().hex[:6]}")
    res = await asyncio.gather(
        svc.apply_ops(graph_id=gid, ops=[_node_op(u1)], actor=actor, message="n1"),
        svc.apply_ops(graph_id=gid, ops=[_node_op(u2)], actor=actor, message="n2"),
        return_exceptions=True)
    crashed = [r for r in res if isinstance(r, Exception)]
    both = await svc.entity_value(graph_id=gid, entity_id=u1, branch_id=mid) and \
        await svc.entity_value(graph_id=gid, entity_id=u2, branch_id=mid)
    c.check(not crashed and both, "3: concurrent apply_ops both land (commit-seq retry)",
            f"3: concurrent apply_ops failed/lost (crashed={crashed})")

    base = f"urn:li:dataset:base_{uuid.uuid4().hex[:6]}"
    d0 = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor=actor, ops=[_node_op(base)])
    await svc.publish(graph_id=gid, branch_id=d0, actor=actor, message="seed")
    dA, dB = await svc.open_draft(graph_id=gid, owner=actor), await svc.open_draft(graph_id=gid, owner=actor)
    ua, ub = f"urn:li:dataset:A_{uuid.uuid4().hex[:6]}", f"urn:li:dataset:B_{uuid.uuid4().hex[:6]}"
    await svc.apply_ops(graph_id=gid, branch_id=dA, actor=actor, ops=[_node_op(ua)])
    await svc.apply_ops(graph_id=gid, branch_id=dB, actor=actor, ops=[_node_op(ub)])
    pubs = await asyncio.gather(
        svc.publish(graph_id=gid, branch_id=dA, actor=actor, message="A"),
        svc.publish(graph_id=gid, branch_id=dB, actor=actor, message="B"),
        return_exceptions=True)
    errs = [p for p in pubs if isinstance(p, Exception)]
    st = await svc.materialize_state(graph_id=gid, branch_id=mid)
    # WS-3: disjoint concurrent merges both land (the stale one auto-rebases) — no NotUpToDate.
    c.check(not errs and ua in st["nodes"] and ub in st["nodes"],
            "3: concurrent independent merges -> both land (auto-rebase, no silent loss)",
            f"3: concurrent publish bad outcome errs={[type(e).__name__ for e in errs]} "
            f"A_in={ua in st['nodes']} B_in={ub in st['nodes']}")

    # OCC: concurrent SAME-field edits on one draft -> exactly one wins + one MergeConflict.
    from backend.app.services.versioning.service import MergeConflict
    dO = await svc.open_draft(graph_id=gid, owner=actor)
    occ = f"urn:li:dataset:occ_{uuid.uuid4().hex[:6]}"
    await svc.apply_ops(graph_id=gid, branch_id=dO, actor=actor, ops=[_node_op(occ, displayName="v0")])
    tok = None
    async with db.graphver_session() as s:
        tok = await svc._effective_head_hash(s, gid, dO, occ)
    occ_res = await asyncio.gather(
        svc.apply_ops(graph_id=gid, branch_id=dO, actor="alice",
                      ops=[{"op": "update", "entity_kind": "node", "entity_id": occ,
                            "payload": {"displayName": "alice"}, "base_version": tok}]),
        svc.apply_ops(graph_id=gid, branch_id=dO, actor="bob",
                      ops=[{"op": "update", "entity_kind": "node", "entity_id": occ,
                            "payload": {"displayName": "bob"}, "base_version": tok}]),
        return_exceptions=True)
    c.check(sum(isinstance(r, MergeConflict) for r in occ_res) == 1
            and sum(not isinstance(r, Exception) for r in occ_res) == 1,
            "3: concurrent same-field edit -> exactly one wins + one MergeConflict (OCC)",
            f"3: OCC same-field not enforced: {[type(r).__name__ for r in occ_res]}")


async def part_2(svc, c, actor, ws):
    ds = "ds_" + uuid.uuid4().hex[:8]
    ua, ub, uc = (f"urn:li:dataset:E_{uuid.uuid4().hex[:6]}" for _ in range(3))
    prov = FakeProvider([GraphNode(urn=ua, entityType="dataset", displayName="A"),
                         GraphNode(urn=ub, entityType="dataset", displayName="B")],
                        [GraphEdge(id="e_" + uuid.uuid4().hex[:6], sourceUrn=ua, targetUrn=ub,
                                   edgeType="FLOWS_TO")])
    r1 = await svc.enable_versioning(data_source_id=ds, workspace_id=ws, actor=actor, provider=prov)
    gid, mid = r1["graph_id"], await svc.main_branch_id(r1["graph_id"])
    st = await svc.materialize_state(graph_id=gid, branch_id=mid)
    c.check(set(st["nodes"]) == {ua, ub} and len(st["edges"]) == 1 and not r1["already_enabled"],
            "2A: enable_versioning imported provider's full state to PG", f"2A: import incomplete: {st}")
    r2 = await svc.enable_versioning(data_source_id=ds, workspace_id=ws, actor=actor, provider=prov)
    c.check(r2.get("already_enabled") and r2["graph_id"] == gid,
            "2A: enable_versioning is idempotent", f"2A: not idempotent: {r2}")

    await svc.apply_ops(graph_id=gid, branch_id=mid, actor="alice", ops=[
        {"op": "update", "entity_kind": "node", "entity_id": ua, "payload": {"displayName": "A-user"}}])
    prov.nodes = [GraphNode(urn=ua, entityType="dataset", displayName="A"),
                  GraphNode(urn=ub, entityType="dataset", displayName="B2"),
                  GraphNode(urn=uc, entityType="dataset", displayName="C")]
    await svc.resync_from_provider(graph_id=gid, provider=prov, actor="sync-bot")
    st2 = await svc.materialize_state(graph_id=gid, branch_id=mid)
    a, b = st2["nodes"].get(ua) or {}, st2["nodes"].get(ub) or {}
    c.check(a.get("displayName") == "A-user" and b.get("displayName") == "B2" and uc in st2["nodes"],
            "2C: resync applied provider changes + preserved user edit",
            f"2C: resync wrong (A={a.get('displayName')}, B={b.get('displayName')}, C in={uc in st2['nodes']})")


async def part_1b(svc, c, actor, ws):
    """Bounded merge: deltas IDENTICAL to the full merge, and a real publish via the bounded
    path handles partial update / node-delete cascade / edge between two UNCHANGED nodes."""
    g = await svc.create_graph(data_source_id="ds_" + uuid.uuid4().hex[:8], workspace_id=ws,
                               kind="manual", actor=actor)
    gid, mid = g["graph_id"], g["main_branch_id"]
    A, B, C, D = (f"urn:li:dataset:{x}_{uuid.uuid4().hex[:6]}" for x in "ABCD")
    e_CD = "ent_eCD_" + uuid.uuid4().hex[:5]
    d0 = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor=actor, ops=[
        _node_op(A), _node_op(B), _node_op(C), _node_op(D),
        {"op": "create", "entity_kind": "edge", "entity_id": e_CD,
         "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": C, "targetEntityId": D}}])
    await svc.publish(graph_id=gid, branch_id=d0, actor=actor, message="seed")
    E = f"urn:li:dataset:E_{uuid.uuid4().hex[:6]}"
    e_BD = "ent_eBD_" + uuid.uuid4().hex[:5]
    dft = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=dft, actor=actor, ops=[
        {"op": "update", "entity_kind": "node", "entity_id": A, "payload": {"displayName": "A-v2"}},
        {"op": "delete", "entity_kind": "node", "entity_id": C, "payload": None},
        {"op": "create", "entity_kind": "edge", "entity_id": e_BD,
         "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": B, "targetEntityId": D}},
        _node_op(E)])
    async with db.graphver_session() as s:
        graph, draft = await s.get(GraphORM, gid), await s.get(BranchORM, dft)
        main_id = await svc._main_branch_id(s, gid)
        mf, cf, tf = await svc._compute_merge(s, gid, graph, draft, main_id, {})
        mb, cb, tb = await svc._compute_merge_bounded(s, gid, graph, draft, main_id, {})
    df = {(d.entity_id, d.op) for d in net_delta(tf, mf)}
    dbnd = {(d.entity_id, d.op) for d in net_delta(tb, mb)}
    c.check(df == dbnd, "1B: bounded deltas == full deltas",
            f"1B: deltas differ (full-only={df - dbnd}, bounded-only={dbnd - df})")
    await svc.publish(graph_id=gid, branch_id=dft, actor=actor, message="rich")
    st = await svc.materialize_state(graph_id=gid, branch_id=mid)
    a = st["nodes"].get(A) or {}
    c.check(a.get("displayName") == "A-v2" and C not in st["nodes"] and e_CD not in st["edges"]
            and e_BD in st["edges"] and E in st["nodes"],
            "1B: publish via bounded path -> correct main (update/cascade/cross-node edge/add)",
            f"1B: bounded publish wrong main (A={a.get('displayName')}, C_gone={C not in st['nodes']}, "
            f"eCD_gone={e_CD not in st['edges']}, eBD={e_BD in st['edges']}, E={E in st['nodes']})")


async def part_revert(svc, c, actor, ws):
    g = await svc.create_graph(data_source_id="ds_" + uuid.uuid4().hex[:8], workspace_id=ws,
                               kind="manual", actor=actor)
    gid, mid = g["graph_id"], g["main_branch_id"]
    A, B = f"urn:li:dataset:A_{uuid.uuid4().hex[:6]}", f"urn:li:dataset:B_{uuid.uuid4().hex[:6]}"
    eAB = "ent_eAB_" + uuid.uuid4().hex[:5]
    d0 = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=d0, actor=actor, ops=[_node_op(A, displayName="A")])
    await svc.publish(graph_id=gid, branch_id=d0, actor=actor, message="seed")
    dk = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=dk, actor=actor, ops=[
        {"op": "update", "entity_kind": "node", "entity_id": A, "payload": {"displayName": "A2"}},
        _node_op(B), {"op": "create", "entity_kind": "edge", "entity_id": eAB,
                      "payload": {"edgeType": "FLOWS_TO", "sourceEntityId": A, "targetEntityId": B}}])
    ck = await svc.publish(graph_id=gid, branch_id=dk, actor=actor, message="K")
    await svc.revert_commit(graph_id=gid, commit_id=ck, actor=actor, message="undo")
    st = await svc.materialize_state(graph_id=gid, branch_id=mid)
    a = st["nodes"].get(A) or {}
    c.check(a.get("displayName") == "A" and B not in st["nodes"] and eAB not in st["edges"],
            "revert: restores touched entity + cascades created node/edge",
            f"revert wrong (A={a.get('displayName')}, B_gone={B not in st['nodes']}, eAB_gone={eAB not in st['edges']})")


async def part_1e(svc, c, actor, ws):
    try:
        from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory
        factory = make_falkor_graph_factory()
        proj = FalkorProjector(factory)
    except Exception as exc:                                   # pragma: no cover
        print(f"  {DIM}- 1E skipped (FalkorDB unavailable: {exc}){RESET}")
        return
    # Pin an explicit test graph name: the projector (correctly) no longer projects UNPINNED
    # graphs into the synthetic gv_<id> fallback — nothing reads those keys and they leaked
    # one empty FalkorDB graph per test run. 1E tests reconcile/heal mechanics, so give it a
    # real (test-scoped) target and drop it in the finally below.
    name = "gvtest_1e_" + uuid.uuid4().hex[:8]
    g = await svc.create_graph(data_source_id="ds_" + uuid.uuid4().hex[:8], workspace_id=ws,
                               kind="manual", actor=actor, falkor_graph_name=name)
    gid = g["graph_id"]
    client = factory(name)
    urns = [f"urn:li:dataset:p_{i}_{uuid.uuid4().hex[:6]}" for i in range(3)]
    d = await svc.open_draft(graph_id=gid, owner=actor)
    await svc.apply_ops(graph_id=gid, branch_id=d, actor=actor, ops=[_node_op(u) for u in urns])
    await svc.publish(graph_id=gid, branch_id=d, actor=actor, message="seed")
    try:
        r1 = await proj.project_graph(gid)
        fn = (await client.query("MATCH (n) RETURN count(n) AS c")).result_set[0][0]
        c.check(not r1.get("verify_error") and fn == 3,
                "1E: FalkorDB reconciles with committed main after projection",
                f"1E: post-seed counts/verify off (n={fn}, err={r1.get('verify_error')})")
        await client.query("MATCH (n {urn: $u}) DETACH DELETE n", params={"u": urns[2]})
        u4 = f"urn:li:dataset:p_4_{uuid.uuid4().hex[:6]}"
        d2 = await svc.open_draft(graph_id=gid, owner=actor)
        await svc.apply_ops(graph_id=gid, branch_id=d2, actor=actor, ops=[_node_op(u4)])
        await svc.publish(graph_id=gid, branch_id=d2, actor=actor, message="n4")
        await proj.project_graph(gid)
        fn2 = (await client.query("MATCH (n) RETURN count(n) AS c")).result_set[0][0]
        c.check(fn2 == 4, "1E: a dropped FalkorDB node is bounded-healed (reseed)",
                f"1E: heal did not restore the dropped node (n={fn2})")

        # A node deleted on main but STRANDED in the cache (an incremental delete the cache missed —
        # the reported "deleted entity still in FalkorDB") must be swept on heal, while a legacy
        # (never-versioned) node is left for bootstrap. Delete urns[1], project (removes it), then
        # forcibly re-insert it as a strand and project an unrelated change: heal sweeps the strand.
        d3 = await svc.open_draft(graph_id=gid, owner=actor)
        await svc.apply_ops(graph_id=gid, branch_id=d3, actor=actor,
                            ops=[{"op": "delete", "entity_kind": "node", "entity_id": urns[1], "payload": None}])
        await svc.publish(graph_id=gid, branch_id=d3, actor=actor, message="del urns[1]")
        await proj.project_graph(gid)
        await client.query("MERGE (n {urn: $u}) SET n.entityId = $u, n.displayName = 'strand'",
                           params={"u": urns[1]})           # resurrect the deleted node in the cache
        ghost = f"urn:li:dataset:legacy_{uuid.uuid4().hex[:6]}"
        await client.query("MERGE (n {urn: $u}) SET n.entityId = $u, n.displayName = 'legacy'",
                           params={"u": ghost})              # never-versioned legacy node (no tombstone)
        u5 = f"urn:li:dataset:p_5_{uuid.uuid4().hex[:6]}"
        d4 = await svc.open_draft(graph_id=gid, owner=actor)
        await svc.apply_ops(graph_id=gid, branch_id=d4, actor=actor, ops=[_node_op(u5)])
        await svc.publish(graph_id=gid, branch_id=d4, actor=actor, message="n5")
        await proj.project_graph(gid)                        # urns[1] is outside this window — only heal can clear it
        strand_gone = (await client.query("MATCH (n {urn: $u}) RETURN count(n) AS c",
                                          params={"u": urns[1]})).result_set[0][0] == 0
        legacy_kept = (await client.query("MATCH (n {urn: $u}) RETURN count(n) AS c",
                                          params={"u": ghost})).result_set[0][0] == 1
        c.check(strand_gone and legacy_kept,
                "1E: tombstoned-but-stranded node swept on heal; legacy node preserved",
                f"1E: tombstone sweep off (strand_gone={strand_gone}, legacy_kept={legacy_kept})")
    finally:
        try:
            await client.delete()
        except Exception:
            pass


async def run() -> int:
    svc = GraphVersioningService()
    actor = "verify-bot"
    ws = "ws_verify_" + uuid.uuid4().hex[:8]
    c = Checks()
    for name, fn in (("Part 1A — kind authoritative", part_1a),
                     ("Part 1B — bounded merge (equivalence + behavioral)", part_1b),
                     ("Part 1F — staged survives publish", part_1f),
                     ("Part 1F/D2 — rebase conflict", part_d2),
                     ("Revert — bounded revert restore + cascade", part_revert),
                     ("Part 3 — concurrency", part_3),
                     ("Part 2A/2C — enable + resync", part_2),
                     ("Part 1E — projection reconcile/heal", part_1e)):
        print(f"{DIM}{name}{RESET}")
        await fn(svc, c, actor, ws)
    if c.failures:
        print(f"\n{RED}FAIL{RESET} — {len(c.failures)} check(s) failed")
        return 1
    print(f"\n{GREEN}PASS{RESET} — {c.n} checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
