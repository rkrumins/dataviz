"""Every view route that takes a ``branchId`` asks version control about that branch first
(VIEWS-5, VIEWS-3), whatever ``RBAC_ENFORCE_VIEWS`` says.

The branch must be a draft of the view's own graph that the caller can read, else 404; a write
also needs it open (409 branch_closed) and the caller able to edit it (403). The literal
``'main'`` reads the published view and refuses a write (409 main_write_forbidden). Before this,
any string was taken as a branch: a write to a merged or someone else's draft made an overlay
nobody would ever publish. Unit level: version control is a recording fake; the live rules are
in ``integration/test_view_branch_scope_live.py``.
"""
import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.db.models import ProviderORM, ViewLayoutOverlayORM, WorkspaceDataSourceORM
from backend.app.services.permission_service import KeyScope, PermissionClaims
from backend.app.services.versioning.errors import BranchNotOpen
from backend.app.services.versioning.service import AccessDenied
from backend.tests.test_view_library import _as, _rule, _user

LAYOUT = {"referenceLayout": {
    "layers": [{"id": "l1", "name": "Layer 1", "entityTypes": [], "order": 0}],
    "assignments": {"urn:a": {"layerId": "l1", "inheritsChildren": True, "assignedBy": "user"}},
}}


class _Gate:
    """Version control that records what each route asks, and answers with ``error``."""

    def __init__(self):
        self.calls: list = []
        self.error: Exception | None = None

    async def check_view_branch(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error


@pytest.fixture
def gate():
    from backend.app.main import app

    fake = _Gate()
    app.dependency_overrides[get_versioning_service] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_versioning_service, None)


async def _view(client: AsyncClient, db_session, *, own_source: bool = True) -> tuple[str, str]:
    """A reference view and its data source: its own, or (``own_source=False``) none, so the
    workspace's primary stands in."""
    ws = (await client.post("/api/v1/admin/workspaces", json={"name": "Scope WS", "dataSources": []})).json()["id"]
    provider = ProviderORM(name=f"falkor-{ws}", provider_type="falkordb")
    db_session.add(provider)
    await db_session.flush()
    ds = WorkspaceDataSourceORM(workspace_id=ws, provider_id=provider.id, graph_name="lineage")
    db_session.add(ds)
    await db_session.flush()
    resp = await client.post("/api/v1/views/", json={
        "name": "Scoped", "workspaceId": ws, "viewType": "reference",
        "config": {"layout": {"type": "reference"}}, "visibility": "private",
        **({"dataSourceId": ds.id} if own_source else {}),
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["id"], ds.id


async def _overlays(db_session, view_id: str) -> list:
    return (await db_session.execute(
        select(ViewLayoutOverlayORM.branch_id).where(ViewLayoutOverlayORM.view_id == view_id)
    )).scalars().all()


async def _every_branch_route(client: AsyncClient, view_id: str, params: dict) -> list:
    v = f"/api/v1/views/{view_id}"
    pack = (await client.get(f"{v}/library/export")).json()
    return [
        await client.get(v, params=params),
        await client.put(f"{v}/layout", params=params, json=LAYOUT),
        await client.get(f"{v}/library", params=params),
        await client.put(f"{v}/library/rules/r1", params=params, json=_rule("r1", "PII")),
        await client.delete(f"{v}/library/rules/r1", params=params),
        await client.put(f"{v}/library/rules", params=params, json={"ids": []}),
        await client.get(f"{v}/library/export", params=params),
        await client.post(f"{v}/library/import", params={**params, "dryRun": "true"}, json=pack),
        await client.post(f"{v}/library/import", params={**params, "dryRun": "false"}, json=pack),
    ]


async def test_every_branch_route_asks_the_gate_with_the_right_write_flag(test_client, db_session, gate):
    view_id, ds = await _view(test_client, db_session)
    for resp in await _every_branch_route(test_client, view_id, {}):
        assert resp.status_code < 300, resp.text
    assert gate.calls == [], "no branchId, no question"

    for resp in await _every_branch_route(test_client, view_id, {"branchId": "br_x"}):
        assert resp.status_code < 300, resp.text
    assert [c["write"] for c in gate.calls] == [False, True, False, True, True, True, False, False, True]
    assert {(c["data_source_id"], c["branch_id"]) for c in gate.calls} == {(ds, "br_x")}


async def test_a_write_to_a_closed_draft_is_409_and_writes_nothing(test_client, db_session, gate):
    view_id, _ = await _view(test_client, db_session)
    gate.error = BranchNotOpen("br_x", "merged")
    for resp in (
        await test_client.put(f"/api/v1/views/{view_id}/layout", params={"branchId": "br_x"}, json=LAYOUT),
        await test_client.put(f"/api/v1/views/{view_id}/library/rules/r1", params={"branchId": "br_x"},
                              json=_rule("r1", "PII")),
    ):
        assert resp.status_code == 409
        assert {k: resp.json()["detail"][k] for k in ("type", "status", "branchId")} == \
            {"type": "branch_closed", "status": "merged", "branchId": "br_x"}
    assert await _overlays(db_session, view_id) == []


async def test_a_foreign_or_unreadable_draft_is_404(test_client, db_session, gate):
    view_id, _ = await _view(test_client, db_session)
    gate.error = ValueError("unknown branch")
    assert (await test_client.get(f"/api/v1/views/{view_id}", params={"branchId": "br_x"})).status_code == 404
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout", params={"branchId": "br_x"}, json=LAYOUT)
    assert resp.status_code == 404
    assert await _overlays(db_session, view_id) == []


async def test_a_reader_of_a_shared_draft_cannot_write(test_client, db_session, gate):
    view_id, _ = await _view(test_client, db_session)
    gate.error = AccessDenied("bob lacks editor access to draft br_x")
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout", params={"branchId": "br_x"}, json=LAYOUT)
    assert resp.status_code == 403
    assert resp.json()["detail"]["type"] == "access_denied"
    assert await _overlays(db_session, view_id) == []


async def test_the_gate_runs_with_RBAC_ENFORCE_VIEWS_off(test_client, db_session, gate, monkeypatch):
    monkeypatch.setenv("RBAC_ENFORCE_VIEWS", "false")
    view_id, _ = await _view(test_client, db_session)
    gate.error = BranchNotOpen("br_x", "abandoned")
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout", params={"branchId": "br_x"}, json=LAYOUT)
    assert resp.status_code == 409
    assert resp.json()["detail"]["type"] == "branch_closed"
    assert await _overlays(db_session, view_id) == []


async def test_a_view_without_a_data_source_is_checked_against_the_workspace_primary(
    test_client, db_session, gate,
):
    view_id, ds = await _view(test_client, db_session, own_source=False)
    assert (await test_client.get(f"/api/v1/views/{view_id}", params={"branchId": "br_x"})).status_code == 200
    assert [c["data_source_id"] for c in gate.calls] == [ds]


async def test_main_reads_the_published_view_and_refuses_a_write(test_client, db_session, gate):
    view_id, _ = await _view(test_client, db_session)
    await test_client.put(f"/api/v1/views/{view_id}/layout", json=LAYOUT)

    resp = await test_client.get(f"/api/v1/views/{view_id}", params={"branchId": "main"})
    assert resp.status_code == 200
    assert resp.json()["config"]["layout"]["referenceLayout"]["layers"][0]["id"] == "l1"
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout", params={"branchId": "main"}, json=LAYOUT)
    assert resp.status_code == 409
    assert resp.json()["detail"]["type"] == "main_write_forbidden"
    assert gate.calls == [] and await _overlays(db_session, view_id) == []


async def test_an_api_key_is_asked_about_as_its_owner_with_the_keys_reach(
    test_client, db_session, gate, monkeypatch,
):
    monkeypatch.setenv("RBAC_ENFORCE_VIEWS", "false")     # the view's own checks are not under test
    view_id, _ = await _view(test_client, db_session)
    ws = (await test_client.get(f"/api/v1/views/{view_id}")).json()["workspaceId"]
    for data, manages in (("read", False), ("write", True)):
        key = KeyScope(key_id=f"key_{data}", views="write", data=data, all_resources=True)
        claims = PermissionClaims(sid="", ws_perms={ws: tuple(key.permissions)},
                                  key_scope=key)
        with _as(_user("usr_owner"), claims):
            resp = await test_client.get(f"/api/v1/views/{view_id}", params={"branchId": "br_x"})
        assert resp.status_code == 200, resp.text
        assert gate.calls[-1]["viewer"].actor == "usr_owner"
        assert gate.calls[-1]["viewer"].can_manage is manages
