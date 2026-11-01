"""Forks are opt-in — needs Postgres (management and graphver).

``forksEnabled`` (Admin → Features) ships off. While it is off no fork is made, and a fork is
read-only: its drafts take no change and publish nothing, and its reviews are neither opened nor
merged. Listing a graph's forks, reading one, and moving it to the trash and back still work, and
nothing is deleted: turning forks on again picks up where they were. The gates, route by route, are
in ``tests/test_forks_feature_flag.py``.
"""
import os
import time
from types import SimpleNamespace

import pytest
from sqlalchemy import select

from backend.app.config.features_seed import REFUSAL_MESSAGES
from backend.app.services.feature_flags import FeatureDisabledError, feature_flags
from backend.tests.integration.test_fork_data_sources import M, R, WS, _mgmt, _parent, _row, _run
from backend.tests.integration.test_fork_overlay_delta import _n, _u

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]

V = f"/api/v1/{WS}/versioning"
REFUSED = {"type": "feature_disabled", "feature": "forksEnabled",
           "message": REFUSAL_MESSAGES["forksEnabled"]}


def _forks(on: bool) -> None:
    feature_flags._cache = {**(feature_flags._cache or {}), "forksEnabled": on}
    feature_flags._cache_ts = time.monotonic()


def _client():
    """The versioning router over in-process ASGI, the caller holding read, manage and publish in
    ``WS``, and a switched-off feature answered as ``main.py`` answers it."""
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse
    from httpx import ASGITransport, AsyncClient

    from backend.app.api.v1.endpoints import versioning as Vr
    from backend.app.auth.dependencies import get_current_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims

    async def _user():
        return SimpleNamespace(id="u_forker", email="f@example.com")

    async def _claims():
        return PermissionClaims(sid="", global_perms=(), ws_perms={
            WS: (R, M, "workspace:datasource:publish")})

    async def _refused(_request, exc):
        return JSONResponse(status_code=403, content={"detail": {
            "type": "feature_disabled", "feature": exc.feature, "message": exc.message}})

    app = FastAPI()
    app.include_router(Vr.router, prefix="/api/v1/{ws_id}/versioning")
    app.add_exception_handler(FeatureDisabledError, _refused)
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_permission_claims] = _claims
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _refused(resp) -> bool:
    return resp.status_code == 403 and resp.json()["detail"] == REFUSED


def test_a_fork_is_made_only_once_forks_are_turned_on():
    from backend.app.db.models import WorkspaceDataSourceORM

    async def case(svc):
        parent_ds, gid = await _parent(svc)
        async with _client() as c:
            assert _refused(await c.post(f"{V}/graphs/{gid}/forks", json={"name": "Plan"}))
            assert await svc.list_forks(graph_id=gid, workspace_id=WS, limit=10) == []
            async with _mgmt() as s:
                assert (await s.execute(select(WorkspaceDataSourceORM.id).where(
                    WorkspaceDataSourceORM.fork_of_data_source_id == parent_ds))).all() == []
            _forks(True)
            r = await c.post(f"{V}/graphs/{gid}/forks", json={"name": "Plan"})
            assert r.status_code == 201, r.text
            assert (await _row(r.json()["dataSourceId"])).label == "Sales · Plan"
    _run(case)


def test_a_fork_stays_readable_and_goes_to_the_trash_and_back_while_forks_are_off():
    async def case(svc):
        _, gid = await _parent(svc)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A")])
        _forks(True)
        async with _client() as c:
            fork = (await c.post(f"{V}/graphs/{gid}/forks", json={})).json()
            fgid, main = fork["graphId"], fork["mainBranchId"]
            await svc.apply_ops(graph_id=fgid, actor="u_forker", message="fork", ops=[_u("A", "A fork")])
            _forks(False)
            listed = await c.get(f"{V}/graphs/{gid}/forks")
            assert listed.status_code == 200 and [f["graphId"] for f in listed.json()] == [fgid]
            assert (await c.get(f"{V}/graphs/{fgid}")).status_code == 200
            log = await c.get(f"{V}/graphs/{fgid}/commits")
            assert log.status_code == 200 and log.json()["commits"][0]["message"] == "fork"
            state = await c.get(f"{V}/graphs/{fgid}/branches/{main}/state")
            assert state.status_code == 200, state.text
            assert {k: n["displayName"] for k, n in state.json()["nodes"].items()} == {"A": "A fork"}
            assert (await c.delete(f"{V}/graphs/{fgid}")).status_code == 204
            assert (await _row(fork["dataSourceId"])).deleted_at is not None
            assert (await c.post(f"{V}/graphs/{fgid}/restore")).status_code == 204
            assert (await _row(fork["dataSourceId"])).deleted_at is None
    _run(case)


def test_a_forks_drafts_and_reviews_take_no_change_while_forks_are_off():
    async def case(svc):
        _, gid = await _parent(svc)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A"), _n("B")])
        _forks(True)
        async with _client() as c:
            fork = (await c.post(f"{V}/graphs/{gid}/forks", json={})).json()
            fgid = fork["graphId"]
            draft = (await c.post(f"{V}/graphs/{fgid}/branches", json={})).json()["branchId"]
            await svc.apply_ops(graph_id=fgid, branch_id=draft, actor="u_forker", message="draft",
                                ops=[_u("B", "B draft")])
            await svc.apply_ops(graph_id=fgid, actor="u_forker", message="fork", ops=[_u("A", "A fork")])
            _forks(False)
            stage = {"ops": [{"op": "update", "entityKind": "node", "entityId": "B",
                              "payload": {"displayName": "B again"}}]}
            assert _refused(await c.post(f"{V}/graphs/{fgid}/branches/{draft}/changes", json=stage))
            assert _refused(await c.post(f"{V}/graphs/{fgid}/branches/{draft}/publish",
                                         json={"message": "m"}))
            assert _refused(await c.post(f"{V}/graphs/{fgid}/pulls", json={}))
            assert await svc.list_pulls(target_graph_id=gid, limit=10) == []
            _forks(True)                         # a review opened while forks were on
            r = await c.post(f"{V}/graphs/{fgid}/pulls", json={})
            assert r.status_code == 201, r.text
            pr = r.json()["prId"]
            _forks(False)
            for route in ("pulls", "merge-requests"):
                assert _refused(await c.post(f"{V}/{route}/{pr}/approve", json={}))
                assert _refused(await c.post(f"{V}/{route}/{pr}/merge", json={"message": "m"}))
            # Nothing moved: the parent's main, the fork's draft and its review are as they were.
            assert (await svc.get_pr(pr))["status"] not in ("merged", "closed")
            head = (await svc.get_graph(gid))["main_head_commit_seq"]
            draft_state = await c.get(f"{V}/graphs/{fgid}/branches/{draft}/state")
            assert {k: n["displayName"] for k, n in draft_state.json()["nodes"].items()} == {
                "A": "A", "B": "B draft"}
            # Turned back on, the review merges.
            _forks(True)
            r = await c.post(f"{V}/merge-requests/{pr}/merge", json={"message": "m"})
            assert r.status_code == 200, r.text
            assert (await svc.get_graph(gid))["main_head_commit_seq"] > head
    _run(case)
