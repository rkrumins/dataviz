"""Fork → PR → merge e2e (copy-on-write) — needs Postgres.

Verifies the cross-team flow (plan §8): own a graph → someone forks it → they work
independently → raise a PR → it merges into the base, 3-way, with conflicts
surfaced.  Asserts the copy-on-write invariant directly (a fork copies **no**
version rows; only its divergence is stored).

Run: ``GRAPHVER_E2E=1 MANAGEMENT_DB_URL=... python backend/tests/integration/test_versioning_fork.py``
"""
import asyncio
import os

import pytest
from sqlalchemy import select

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import EdgeVersionORM, NodeVersionORM
from backend.app.services.versioning.service import GraphVersioningService, MergeConflict


async def _version_entity_ids(graph_id: str) -> set:
    """Distinct entity_ids that have *any* version row under this graph (proves
    copy-on-write: an inherited-but-untouched entity has none)."""
    out: set = set()
    async with db.graphver_session() as s:
        for model in (NodeVersionORM, EdgeVersionORM):
            ids = (await s.execute(
                select(model.entity_id).where(model.graph_id == graph_id).distinct()
            )).scalars().all()
            out.update(ids)
    return out


async def _seed(svc, graph_id, branch, actor, ops, msg):
    await svc.stage_changes(graph_id=graph_id, branch_id=branch, actor=actor, ops=ops)
    await svc.checkpoint(graph_id=graph_id, branch_id=branch, actor=actor)
    return await svc.publish(graph_id=graph_id, branch_id=branch, actor=actor, message=msg)


async def _edit_publish(svc, graph_id, actor, ops, msg):
    d = await svc.open_draft(graph_id=graph_id, owner=actor)
    return await _seed(svc, graph_id, d, actor, ops, msg)


async def _run() -> None:
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()

    # ── 1. parent graph P: A{f:1}, B, edge A->B ──────────────────────────
    P = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    pg, pmain = P["graph_id"], P["main_branch_id"]
    await _edit_publish(svc, pg, "alice", [
        {"op": "create", "entity_kind": "node", "entity_id": "A", "payload": {"entityType": "Dataset", "displayName": "A", "f": 1}},
        {"op": "create", "entity_kind": "node", "entity_id": "B", "payload": {"entityType": "Dataset", "displayName": "B"}},
        {"op": "create", "entity_kind": "edge", "entity_id": "E1", "payload": {"edgeType": "R", "sourceEntityId": "A", "targetEntityId": "B"}},
    ], "seed")

    # ── 2. fork (copy-on-write) ──────────────────────────────────────────
    F = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="bob")
    fg, fmain = F["graph_id"], F["main_branch_id"]
    st = await svc.materialize_state(graph_id=fg, branch_id=fmain)
    assert set(st["nodes"]) == {"A", "B"} and set(st["edges"]) == {"E1"}, st     # inherited
    assert st["nodes"]["A"]["f"] == 1
    assert await _version_entity_ids(fg) == set(), "fork must copy NO version rows"

    # ── 3. fork diverges: A.f 1->10, +C (intra-fork publish) ─────────────
    await _edit_publish(svc, fg, "bob", [
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f": 10}},
        {"op": "create", "entity_kind": "node", "entity_id": "C", "payload": {"entityType": "Dataset", "displayName": "C"}},
    ], "fork work")
    fst = await svc.materialize_state(graph_id=fg, branch_id=fmain)
    assert fst["nodes"]["A"]["f"] == 10 and set(fst["nodes"]) == {"A", "B", "C"}, fst
    pst = await svc.materialize_state(graph_id=pg, branch_id=pmain)
    assert pst["nodes"]["A"]["f"] == 1 and set(pst["nodes"]) == {"A", "B"}, pst    # parent untouched
    assert await _version_entity_ids(fg) == {"A", "C"}, "CoW stores only divergence (not B/E1)"

    # ── 4. parent advances independently: B->B2, +D ──────────────────────
    await _edit_publish(svc, pg, "alice", [
        {"op": "update", "entity_kind": "node", "entity_id": "B", "payload": {"displayName": "B2"}},
        {"op": "create", "entity_kind": "node", "entity_id": "D", "payload": {"entityType": "Dataset", "displayName": "D"}},
    ], "parent work")

    # ── 5. PR fork -> parent: non-overlapping, auto-merges clean ─────────
    pr = await svc.open_pr(source_graph_id=fg, actor="bob")
    assert (await svc.preview_pr(pr_id=pr))["clean"] is True
    assert await svc.merge_pr(pr_id=pr, actor="carol", message="merge fork")
    m = await svc.materialize_state(graph_id=pg, branch_id=pmain)
    assert m["nodes"]["A"]["f"] == 10, m                     # fork's edit landed
    assert m["nodes"]["B"]["displayName"] == "B2", m         # parent's edit preserved
    assert set(m["nodes"]) == {"A", "B", "C", "D"} and set(m["edges"]) == {"E1"}, m  # C(fork)+D(parent)

    # ── 6. conflict on the same field -> resolve ─────────────────────────
    F2 = await svc.fork_graph(parent_graph_id=pg, workspace_id="ws1", actor="dave")
    await _edit_publish(svc, F2["graph_id"], "dave", [
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f": 50}},
    ], "f2")
    await _edit_publish(svc, pg, "alice", [
        {"op": "update", "entity_kind": "node", "entity_id": "A", "payload": {"displayName": "A", "f": 99}},
    ], "p99")
    pr2 = await svc.open_pr(source_graph_id=F2["graph_id"], actor="dave")
    prev2 = await svc.preview_pr(pr_id=pr2)
    assert prev2["clean"] is False and any(c["entity_id"] == "A" for c in prev2["conflicts"]), prev2
    try:
        await svc.merge_pr(pr_id=pr2, actor="carol", message="merge f2")
        assert False, "expected MergeConflict"
    except MergeConflict as exc:
        assert any(c["entity_id"] == "A" and c["path"] == ["f"] for c in exc.conflicts), exc.conflicts
    assert await svc.merge_pr(pr_id=pr2, actor="carol", message="resolved", resolutions={"A": {"displayName": "A", "f": 77}})
    final = await svc.materialize_state(graph_id=pg, branch_id=pmain)
    assert final["nodes"]["A"]["f"] == 77, final

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_fork_e2e():
    asyncio.run(_run())


# ── the fork route: MANAGE, no caller-chosen data source, a live-fork cap ──
R = "workspace:datasource:read"
M = "workspace:datasource:manage"


def _client(perms: tuple):
    """The versioning router over in-process ASGI, the caller holding ``perms`` in ws1."""
    from types import SimpleNamespace

    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.auth.dependencies import get_current_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims

    async def _user():
        return SimpleNamespace(id="u_fork", email="f@example.com")

    async def _claims():
        return PermissionClaims(sid="", global_perms=(), ws_perms={"ws1": perms})

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_permission_claims] = _claims
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _parent(svc) -> str:
    await models.create_schema_and_partitions()
    P = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="alice")
    return P["graph_id"]


async def _fork(c, gid, body=None):
    return await c.post(f"/api/v1/ws1/versioning/graphs/{gid}/forks", json=body or {})


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_fork_needs_manage_and_ignores_a_data_source_id_e2e():
    async def go():
        svc = GraphVersioningService()
        gid = await _parent(svc)
        async with _client((R,)) as c:
            r = await _fork(c, gid)
            assert r.status_code == 403, r.text                      # a member without manage
        taken = "ds_" + os.urandom(4).hex()
        async with _client((R, M)) as c:
            r = await _fork(c, gid, {"dataSourceId": taken})
            assert r.status_code == 201, r.text
        fork = await svc.get_graph(r.json()["graphId"])
        assert fork["data_source_id"] != taken                       # the caller can't pick the key
        await db.dispose_engine()
    asyncio.run(go())


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_fork_cap_counts_live_forks_only_e2e(monkeypatch):
    from backend.app.services.versioning import config
    from backend.app.services.versioning.purge_worker import tombstone_graphs_for_data_source

    monkeypatch.setattr(config, "MAX_FORKS_PER_GRAPH", 2)

    async def go():
        svc = GraphVersioningService()
        gid = await _parent(svc)
        async with _client((R, M)) as c:
            forks = [(await _fork(c, gid)).json()["graphId"] for _ in range(2)]
            r = await _fork(c, gid)
            assert r.status_code == 409, r.text                      # cap reached
            assert r.json()["detail"]["type"] == "fork_limit"
            assert r.json()["detail"]["limit"] == 2
            # A tombstoned fork no longer counts: one slot comes back, and only one.
            gone = await svc.get_graph(forks[0])
            assert await tombstone_graphs_for_data_source(
                data_source_id=gone["data_source_id"], workspace_id="ws1", actor="alice") == 1
            assert (await _fork(c, gid)).status_code == 201
            assert (await _fork(c, gid)).status_code == 409
        await db.dispose_engine()
    asyncio.run(go())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning fork/PR e2e: OK")
