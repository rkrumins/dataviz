"""Phase-1 scale fixes on a live Postgres: the write gate at import-window size, payload-free
reads, no Merkle on drafts, and the two guards that keep a half-enabled graph intact.

  * ``_current_skeletons`` answers exactly what ``_current_values`` does about liveness, urn,
    type and edge ends — on main, on a draft over main, as-of, after deletes;
  * an import-sized edge window (lineage into targets that already hold containment edges)
    and its publish with containment types both finish in seconds, not minutes or hours;
  * draft commits write no ``merkle_nodes`` rows and carry no root; main commits still do;
  * a projection rebuild is refused while "enable version control" is unfinished;
  * cache eviction never offers a graph still at genesis.

Run: GRAPHVER_E2E=1 MANAGEMENT_DB_URL=postgresql+asyncpg://… python -m pytest
     backend/tests/integration/test_versioning_scale_gate.py
"""
import asyncio
import os
import time

import pytest
from sqlalchemy import func, select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import CommitORM, JobORM, MerkleNodeORM, ProjectionStateORM
from backend.app.services.versioning.service import ConcurrencyError, GraphVersioningService

CET = ["CONTAINS"]


def _node(urn, etype="dataset"):
    return {"op": "create", "entity_kind": "node", "entity_id": urn,
            "payload": {"urn": urn, "entityType": etype, "displayName": urn[-8:]}}


def _edge(eid, src, tgt, etype="CONTAINS"):
    return {"op": "create", "entity_kind": "edge", "entity_id": eid,
            "payload": {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt}}


async def _skeleton_parity(svc: GraphVersioningService) -> None:
    sfx = os.urandom(3).hex()
    g = await svc.create_graph(data_source_id="ds_sk_" + sfx, workspace_id="ws_sk", actor="bot")
    gid = g["graph_id"]
    a, b, c = (f"urn:sk:{x}_{sfx}" for x in "abc")
    seed = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=seed, actor="bot", ops=[
        _node(a), _node(b), _node(c), _edge(f"ab_{sfx}", a, b), _edge(f"bc_{sfx}", b, c, "FLOWS")])
    await svc.publish(graph_id=gid, branch_id=seed, actor="bot", message="seed", containment_edge_types=CET)
    d = await svc.open_draft(graph_id=gid, owner="bot")
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot", ops=[
        {"op": "delete", "entity_kind": "edge", "entity_id": f"bc_{sfx}", "payload": None},
        {"op": "update", "entity_kind": "node", "entity_id": c,
         "payload": {"urn": c, "entityType": "table", "displayName": "c"}},
        _node(f"urn:sk:d_{sfx}", "chart")])
    ids = [a, b, c, f"urn:sk:d_{sfx}", f"ab_{sfx}", f"bc_{sfx}", "absent"]
    main_id = await svc.main_branch_id(gid)
    async with db.graphver_session() as s:
        for branch, as_of in ((main_id, None), (d, None), (main_id, 1)):
            vals = await svc._current_values(s, gid, branch, ids, as_of)
            sk = await svc._current_skeletons(s, gid, branch, ids, as_of)
            assert set(vals) == set(sk), (branch, as_of)
            for eid, v in vals.items():
                k = sk[eid]
                assert (v is None) == (k is None), eid
                if v is None:
                    continue
                for key in ("urn", "entityType", "edgeType", "sourceEntityId", "targetEntityId"):
                    assert v.get(key) == k.get(key), (eid, key)


async def _import_sized_window(svc: GraphVersioningService) -> None:
    n = int(os.getenv("SCALE_GATE_N", "10000"))
    sfx = os.urandom(3).hex()
    g = await svc.create_graph(data_source_id="ds_sg_" + sfx, workspace_id="ws_sg", actor="bot")
    gid = g["graph_id"]
    d = await svc.open_draft(graph_id=gid, owner="bot")
    root = f"urn:sg:root_{sfx}"
    nodes = [_node(root)] + [_node(f"urn:sg:t{i}_{sfx}") for i in range(n)] + \
        [_node(f"urn:sg:s{i}_{sfx}") for i in range(n)]
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot", ops=nodes, containment_edge_types=CET)
    # Window 1: every target gets a containment parent. Window 2: a lineage edge INTO every one
    # of those targets — each created edge used to scan all n incident edges (n² steps).
    t0 = time.perf_counter()
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot", message="import",
                        ops=[_edge(f"c{i}_{sfx}", root, f"urn:sg:t{i}_{sfx}") for i in range(n)])
    await svc.apply_ops(graph_id=gid, branch_id=d, actor="bot", message="import",
                        ops=[_edge(f"l{i}_{sfx}", f"urn:sg:s{i}_{sfx}", f"urn:sg:t{i}_{sfx}", "FLOWS")
                             for i in range(n)])
    windows = time.perf_counter() - t0

    async with db.graphver_session() as s:
        draft_rows = await s.scalar(select(func.count()).select_from(MerkleNodeORM).where(
            MerkleNodeORM.graph_id == gid, MerkleNodeORM.branch_id == d))
        draft_roots = (await s.execute(select(CommitORM.merkle_root).where(
            CommitORM.graph_id == gid, CommitORM.branch_id == d))).scalars().all()
    assert draft_rows == 0 and not any(draft_roots), "draft commits must carry no Merkle"

    # Publish with containment types: the cycle check used to climb per edge per level.
    t1 = time.perf_counter()
    await svc.publish(graph_id=gid, branch_id=d, actor="bot", message="import", containment_edge_types=CET)
    publish = time.perf_counter() - t1
    main_id = await svc.main_branch_id(gid)
    async with db.graphver_session() as s:
        root_hash = await s.scalar(select(CommitORM.merkle_root).where(
            CommitORM.graph_id == gid, CommitORM.branch_id == main_id)
            .order_by(CommitORM.commit_seq.desc()).limit(1))
    assert root_hash, "main commits keep their fingerprint"
    print(f"scale gate n={n}: windows {windows:.1f}s, publish {publish:.1f}s")
    assert windows < 60 and publish < 90, (windows, publish)


async def _bootstrap_guards(svc: GraphVersioningService) -> None:
    from backend.app.services.versioning.cache_manager import CacheManager

    sfx = os.urandom(3).hex()
    g = await svc.create_graph(data_source_id="ds_bg_" + sfx, workspace_id="ws_bg", actor="bot")
    gid = g["graph_id"]
    async with db.graphver_session() as s:
        s.add(JobORM(job_type="bootstrap", graph_id=gid, status="pending"))
        ps = await s.get(ProjectionStateORM, gid)
        ps.status = "idle"
    try:
        await svc.request_projection_rebuild(gid)
    except ConcurrencyError:
        pass
    else:
        raise AssertionError("a rebuild must be refused while enabling version control is unfinished")

    class _NoProjector:
        pass

    cm = CacheManager(_NoProjector())
    assert gid not in await cm.lru_candidates(limit=100_000), "a graph at genesis must never be evicted"


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    await _skeleton_parity(svc)
    await _import_sized_window(svc)
    await _bootstrap_guards(svc)
    await db.dispose_engine()


@pytest.mark.skipif(os.getenv("GRAPHVER_E2E") != "1", reason="needs Postgres (set GRAPHVER_E2E=1)")
def test_versioning_scale_gate():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
