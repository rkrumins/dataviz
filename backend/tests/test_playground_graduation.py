"""Graduating a Playground experiment: what was built there goes with it into a workspace.

A sample started in the Playground — its views, their saved queries, display rules and
versions, its example draft waiting for review, its data source's details and contacts — is
moved into a workspace two ways: by its maker, who administers the destination (the
Playground's maker stands where a source admin would, ``data_source_transfer``), and by an
approved workspace request carrying the graph (``workspace_requests``). Either way nothing
built on it is left behind or lost: the views and what hangs off them are keyed by the view, the
details and contacts by the data source, and the version history — the draft and its review with
it — moves as one graph.

The version store is faked twice over, as the samples and transfer tests fake it.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.api.v1.endpoints import playground as playground_endpoints
from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import (DataSourceContactORM, ProviderORM, RoleBindingORM, RoleORM, RolePermissionORM,
                                   UserORM, ViewLayoutOverlayORM, ViewORM, ViewSavedQueryORM, ViewVersionORM,
                                   WorkspaceDataSourceORM, WorkspaceORM)
from backend.app.providers.manager import provider_manager
from backend.app.services import playground_policy, view_library
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.versioning import purge_worker
from backend.auth_service.interface import User
from tests.common.transfer_world import fake_version_store
from tests.test_playground_samples import _VersionStore

PG, LAB = "ws_play", "ws_lab"
SANDBOX = "prov_sandbox"
T0 = "2026-11-20T00:00:00+00:00"
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)
ADMIN_PERMS = MEMBER_PERMS + ("workspace:admin", "workspace:datasource:publish")


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name=uid[4:].title(), last_name="T", role="user",
                status="active", created_at=T0, updated_at=T0)


ADA, BEN, OLGA = _user("usr_ada"), _user("usr_ben"), _user("usr_olga")
#: Ada: a Playground member, and the Lab's admin.
ADA_CLAIMS = PermissionClaims(sid="s_ada", ws_perms={PG: MEMBER_PERMS, LAB: ADMIN_PERMS})
APPROVER = PermissionClaims(sid="s_o", global_perms=("system:org-admin", "system:workspaces:create"), ws_perms={})


@contextlib.contextmanager
def _as(user: User, claims: PermissionClaims):
    from backend.app.main import app

    async def _u():
        return user

    saved = {k: app.dependency_overrides.get(k) for k in (get_current_user, get_optional_user, get_permission_claims)}
    app.dependency_overrides[get_current_user] = _u
    app.dependency_overrides[get_optional_user] = _u
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                app.dependency_overrides.pop(k, None)
            else:
                app.dependency_overrides[k] = v


@pytest.fixture
async def experiment(test_client: AsyncClient, db_session, monkeypatch):
    """Ada's retail sample in the Playground — where Ben, a fellow member, reads its views —
    named Ada its owner and Ben a steward, and a Lab workspace Ada administers. Returns what the
    sample answered."""
    from backend.app.main import app

    for key in ("playgroundEnabled", "blankModelsEnabled", "versioningEnabled", "workspaceRequestsEnabled"):
        feature_flags._cache[key] = True
    if await db_session.get(RoleORM, playground_policy.PLAYGROUND_ROLE) is None:
        db_session.add(RoleORM(name=playground_policy.PLAYGROUND_ROLE, description="Playground member",
                               scope_type="global", scope_id=None, is_system=True, created_at=T0, updated_at=T0))
        await db_session.flush()
        db_session.add(RolePermissionORM(role_name=playground_policy.PLAYGROUND_ROLE,
                                         permission_id="workspace:view:read"))
    for user in (ADA, BEN, OLGA):
        db_session.add(UserORM(id=user.id, email=user.email, password_hash="x", first_name=user.first_name,
                               last_name="T", status="active", created_at=T0, updated_at=T0))
    db_session.add_all([
        ProviderORM(id=SANDBOX, name="Sandbox", provider_type="falkordb", host="sandbox", port=6379),
        WorkspaceORM(id=PG, name="Playground", kind="playground", request_policy="open", publish_policy="request",
                     playground_settings=json.dumps({"sandboxProviderId": SANDBOX, "graphQuota": 5})),
        WorkspaceORM(id=LAB, name="Lab"),
    ])
    await db_session.flush()
    db_session.add_all([
        RoleBindingORM(subject_type="user", subject_id=OLGA.id, role_name="org_admin", scope_type="global"),
        RoleBindingORM(subject_type="user", subject_id=ADA.id, role_name=playground_policy.PLAYGROUND_ROLE,
                       scope_type="workspace", scope_id=PG),
        RoleBindingORM(subject_type="user", subject_id=BEN.id, role_name=playground_policy.PLAYGROUND_ROLE,
                       scope_type="workspace", scope_id=PG),
        RoleBindingORM(subject_type="user", subject_id=ADA.id, role_name="workspace_admin",
                       scope_type="workspace", scope_id=LAB),
    ])
    await db_session.commit()
    provider_manager.warmup_cache[SANDBOX] = {"ok": True}

    started = _VersionStore()

    async def _nothing(*_args, **_kwargs):
        return None

    monkeypatch.setattr(playground_endpoints, "project_now", _nothing)
    app.dependency_overrides[get_versioning_service] = lambda: started
    try:
        with _as(ADA, ADA_CLAIMS):
            r = await test_client.post("/api/v1/playground/samples/retail-pipeline")
    finally:
        app.dependency_overrides.pop(get_versioning_service, None)
        provider_manager.warmup_cache.pop(SANDBOX, None)
    assert r.status_code == 201, r.text
    made = r.json()
    db_session.add_all([
        DataSourceContactORM(data_source_id=made["dataSourceId"], role="owner", subject_type="user",
                             subject_id=ADA.id, added_by=ADA.id),
        DataSourceContactORM(data_source_id=made["dataSourceId"], role="steward", subject_type="user",
                             subject_id=BEN.id, added_by=ADA.id),
    ])
    await db_session.commit()
    store = fake_version_store(monkeypatch)
    store.facts = {"graphId": "g_1", "activeJobs": [], "commits": 3, "forks": 0, "openReviews": 1,
                   "openDrafts": [{"id": made["draftId"], "name": "Add Finance overview", "owner": ADA.id}]}
    monkeypatch.setattr(purge_worker, "create_purge_job", _nothing)
    return {**made, "store": store}


async def _what_was_built(db_session, made: dict) -> dict:
    """Everything the experiment was built with, as it stands now."""
    fresh = {"execution_options": {"populate_existing": True}}

    async def rows(query):
        return (await db_session.execute(query.execution_options(**fresh["execution_options"]))).scalars().all()

    ds = (await rows(select(WorkspaceDataSourceORM).where(WorkspaceDataSourceORM.id == made["dataSourceId"])))[0]
    views = await rows(select(ViewORM).where(ViewORM.id.in_(list(made["viewIds"].values()))))
    context = next(v for v in views if v.id == made["viewId"])
    return {
        "workspace": ds.workspace_id,
        "views": sorted((v.id, v.workspace_id, v.data_source_id, v.view_type, v.deleted_at) for v in views),
        "queries": sorted((q.view_id, q.name) for q in await rows(select(ViewSavedQueryORM))),
        "rules": [r["name"] for r in view_library._rules_of(view_library._published_layout(json.loads(context.config)))],
        "versions": sorted((v.view_id, v.version) for v in await rows(select(ViewVersionORM))),
        "draft overlays": sorted((o.view_id, o.branch_id) for o in await rows(select(ViewLayoutOverlayORM))),
        "details": (ds.description, json.loads(ds.tags), json.loads(ds.links), ds.metadata_updated_by),
        "contacts": sorted((c.role, c.subject_id) for c in await rows(
            select(DataSourceContactORM).where(DataSourceContactORM.data_source_id == ds.id))),
    }


def _moved(before: dict, after: dict, to: str) -> None:
    """``after`` is ``before`` moved to ``to``: in the new workspace, and nothing else changed."""
    assert (before["workspace"], after["workspace"]) == (PG, to)
    assert [v[1] for v in before["views"]] == [PG, PG, PG]
    assert after["views"] == [(vid, to, ds, kind, None) for vid, _ws, ds, kind, _gone in before["views"]]
    for key in ("queries", "rules", "versions", "draft overlays", "details", "contacts"):
        assert after[key] == before[key], key
    assert len(before["queries"]) == 4 and before["rules"] == ["Personal data"]
    assert len(before["versions"]) == 3 and len(before["draft overlays"]) == 1
    assert before["contacts"] == [("owner", ADA.id), ("steward", BEN.id)]


@pytest.mark.asyncio
async def test_its_maker_moves_it_into_a_workspace_with_everything_built_on_it(
        test_client: AsyncClient, experiment, db_session):
    before = await _what_was_built(db_session, experiment)
    src = f"/api/v1/admin/workspaces/{PG}/data-sources/{experiment['dataSourceId']}"
    with _as(ADA, ADA_CLAIMS):
        preview = await test_client.get(f"{src}/move-preview", params={"to": LAB})
        assert preview.status_code == 200, preview.text
        assert preview.json()["mode"] == "direct"
        r = await test_client.post(f"{src}/move", json={"targetWorkspaceId": LAB,
                                                        "previewToken": preview.json()["token"]},
                                   headers={"X-Activity-Reason": "Graduating the experiment"})
    assert r.status_code == 200, r.text
    _moved(before, await _what_was_built(db_session, experiment), LAB)
    # Its version history — the example draft and its review in it — moved as one graph.
    assert experiment["store"].relocations == [(experiment["dataSourceId"], LAB, True)]


@pytest.mark.asyncio
async def test_an_approved_workspace_request_carries_it_in_with_everything_built_on_it(
        test_client: AsyncClient, experiment, db_session):
    before = await _what_was_built(db_session, experiment)
    with _as(ADA, PermissionClaims(sid="s_ada", ws_perms={PG: MEMBER_PERMS})):
        asked = await test_client.post("/api/v1/workspace-requests", json={
            "name": "Retail Lab", "purpose": "project", "description": "Our retail lineage",
            "teammateIds": [], "playgroundSourceIds": [experiment["dataSourceId"]]})
    assert asked.status_code == 201, asked.text
    with _as(OLGA, APPROVER):
        r = await test_client.post(f"/api/v1/admin/workspace-requests/{asked.json()['id']}/approve", json={})
    assert r.status_code == 200, r.text
    outcome = r.json()["outcome"]
    assert (outcome["movedSources"], outcome["failedSources"]) == ([experiment["dataSourceId"]], [])
    _moved(before, await _what_was_built(db_session, experiment), outcome["workspaceId"])
    assert experiment["store"].relocations == [(experiment["dataSourceId"], outcome["workspaceId"], True)]
