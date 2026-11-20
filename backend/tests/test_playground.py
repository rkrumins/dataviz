"""The Playground: one shared sandbox anyone may join to build their own graphs.

These pin what makes it safe to open to everyone: it is off until an administrator
turns it on and sets it up; joining grants the Playground member role and nothing
else; no production data can be attached or moved in; each person changes only what
they made; nothing in it is published to everyone; blank graphs go only on its
sandbox provider, within a quota; and its starter data models are visible to its
members only. A standard workspace is untouched by every one of these.
"""
from __future__ import annotations

import contextlib
import json

import pytest
from fastapi import HTTPException
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import (
    OntologyORM, ProviderORM, RoleBindingORM, RoleORM, ViewORM, WorkspaceDataSourceORM, WorkspaceORM,
)
from backend.app.services import playground_policy, workspace_visibility
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

PG = "ws_play"
STD = "ws_team"
MEMBER_PERMS = (
    "workspace:datasource:manage", "workspace:datasource:read", "workspace:ontology:read",
    "workspace:provider:read", "workspace:view:create", "workspace:view:delete",
    "workspace:view:edit", "workspace:view:read",
)


def _user(uid: str) -> User:
    return User(id=uid, email=f"{uid}@example.com", first_name="T", last_name="U", role="user",
                status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


ADA, BEN = _user("usr_ada"), _user("usr_ben")
MEMBER = PermissionClaims(sid="s_m", ws_perms={PG: MEMBER_PERMS, STD: MEMBER_PERMS})
ADMIN = PermissionClaims(sid="s_a", global_perms=("system:admin",), ws_perms={})


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
def flag_on():
    feature_flags._cache["playgroundEnabled"] = True
    yield
    feature_flags._cache["playgroundEnabled"] = False


@pytest.fixture
async def estate(db_session):
    """A playground and a team workspace, a sandbox provider and a production one, a published
    starter data model, and one graph of Ada's in each workspace."""
    now = "2026-11-20T00:00:00+00:00"
    if await db_session.get(RoleORM, playground_policy.PLAYGROUND_ROLE) is None:
        db_session.add(RoleORM(name=playground_policy.PLAYGROUND_ROLE, description="Playground member",
                               scope_type="global", scope_id=None, is_system=True, created_at=now, updated_at=now))
    db_session.add_all([
        ProviderORM(id="prov_sandbox", name="Sandbox", provider_type="falkordb", permitted_workspaces='["ws_lab"]'),
        ProviderORM(id="prov_prod", name="Production", provider_type="falkordb"),
        OntologyORM(id="ont_start", name="Starter", version=1, is_published=True),
        WorkspaceORM(id=PG, name="Playground", kind="playground", request_policy="open", publish_policy="request",
                     playground_settings=json.dumps({"sandboxProviderId": "prov_sandbox",
                                                     "starterOntologyIds": ["ont_start"], "graphQuota": 2})),
        WorkspaceORM(id=STD, name="Team"),
    ])
    await db_session.flush()
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_ada_pg", workspace_id=PG, provider_id="prov_sandbox", graph_name="blank_a",
                               label="Ada's experiment", created_by=ADA.id),
        WorkspaceDataSourceORM(id="ds_ada_std", workspace_id=STD, provider_id="prov_prod", graph_name="sales",
                               label="Sales", created_by=ADA.id),
        ViewORM(id="v_ada_pg", name="Ada's view", workspace_id=PG, data_source_id="ds_ada_pg", view_type="graph",
                visibility="private", created_by=ADA.id, config="{}"),
    ])
    await db_session.commit()


# ── Finding and joining it ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_off_by_default_and_joining_is_refused(test_client: AsyncClient, estate):
    with _as(BEN, PermissionClaims(sid="s_b", ws_perms={})):
        info = (await test_client.get("/api/v1/playground")).json()
        join = await test_client.post("/api/v1/playground/join")
    assert info == {**info, "enabled": False}
    assert "workspaceId" not in info or info["workspaceId"] is None   # nothing named while it's off
    assert join.status_code == 403


@pytest.mark.asyncio
async def test_joining_grants_the_playground_member_role_and_nothing_else(test_client: AsyncClient, estate, db_session, flag_on):
    with _as(BEN, PermissionClaims(sid="s_b", ws_perms={})):
        r = await test_client.post("/api/v1/playground/join")
        again = await test_client.post("/api/v1/playground/join")
    assert r.status_code == 200, r.text
    assert r.json()["joined"] is True and r.json()["workspaceId"] == PG
    assert r.json()["sandboxProviderId"] == "prov_sandbox"   # where their wizard starts a graph
    assert again.status_code == 200
    bindings = (await db_session.execute(select(RoleBindingORM).where(RoleBindingORM.subject_id == BEN.id))).scalars().all()
    assert [(b.role_name, b.scope_id) for b in bindings] == [(playground_policy.PLAYGROUND_ROLE, PG)]


@pytest.mark.asyncio
async def test_only_a_platform_admin_sets_it_up(test_client: AsyncClient, estate, db_session):
    body = {"name": "Sandbox", "sandboxProviderId": "prov_sandbox", "starterOntologyIds": ["ont_start"], "graphQuota": 3}
    with _as(BEN, MEMBER):
        refused = await test_client.put("/api/v1/playground", json=body)
    with _as(ADA, ADMIN):
        done = await test_client.put("/api/v1/playground", json=body)
    assert refused.status_code == 403
    assert done.status_code == 200, done.text
    assert done.json()["name"] == "Sandbox" and done.json()["graphQuota"] == 3
    assert done.json()["sandboxProviderId"] == "prov_sandbox"
    # The sandbox provider lets the Playground in, beside the workspaces it already named.
    provider = await db_session.get(ProviderORM, "prov_sandbox")
    await db_session.refresh(provider)
    assert json.loads(provider.permitted_workspaces) == ["ws_lab", PG]


# ── What it allows ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_nothing_can_be_attached_to_the_playground(test_client: AsyncClient, estate):
    with _as(BEN, MEMBER):
        r = await test_client.post(f"/api/v1/admin/workspaces/{PG}/data-sources",
                                   json={"providerId": "prov_prod", "graphName": "sales"})
    assert r.status_code == 403
    assert r.json()["detail"]["type"] == "playground_no_attach"


@pytest.mark.asyncio
async def test_a_member_changes_only_what_they_made(test_client: AsyncClient, estate):
    with _as(BEN, MEMBER):
        not_hers = await test_client.put(f"/api/v1/admin/workspaces/{PG}/data-sources/ds_ada_pg", json={"label": "Mine now"})
        view = await test_client.put("/api/v1/views/v_ada_pg", json={"name": "Mine now"})
        delete = await test_client.delete("/api/v1/views/v_ada_pg")
    assert not_hers.status_code == 403 and not_hers.json()["detail"]["type"] == "playground_not_yours"
    assert view.status_code == 403 and view.json()["detail"]["type"] == "playground_not_yours"
    assert delete.status_code == 403 and delete.json()["detail"]["type"] == "playground_not_yours"
    with _as(ADA, MEMBER):
        own = await test_client.put(f"/api/v1/admin/workspaces/{PG}/data-sources/ds_ada_pg", json={"label": "Renamed"})
    assert own.status_code == 200, own.text


@pytest.mark.asyncio
async def test_nothing_in_it_is_published_to_everyone(test_client: AsyncClient, estate):
    with _as(ADA, MEMBER):
        r = await test_client.put("/api/v1/views/v_ada_pg/visibility", json={"visibility": "enterprise"})
        asked = await test_client.post("/api/v1/views/v_ada_pg/publish-request", json={"note": "please"})
        view = await test_client.get("/api/v1/views/v_ada_pg")
    assert r.status_code == 403
    assert r.json()["detail"]["type"] == "playground_not_public"
    # Nor by asking someone who could: there is nothing to ask for.
    assert asked.status_code == 403 and asked.json()["detail"]["type"] == "playground_not_public"
    assert view.status_code == 200, view.text
    assert view.json()["access"]["enterpriseAvailable"] is False
    assert view.json()["access"]["canRequestPublish"] is False


@pytest.mark.asyncio
async def test_its_doors_stay_as_they_are(test_client: AsyncClient, estate):
    claims = PermissionClaims(sid="s_x", ws_perms={PG: ("workspace:admin",)})
    with _as(ADA, claims):
        r = await test_client.put(f"/api/v1/admin/workspaces/{PG}", json={"publishPolicy": "open"})
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_blank_graphs_go_on_its_sandbox_provider_within_the_quota(db_session, estate):
    with pytest.raises(HTTPException) as wrong:
        await playground_policy.assert_blank_graph(db_session, PG, "prov_prod", BEN.id)
    assert wrong.value.detail["type"] == "playground_provider"
    await playground_policy.assert_blank_graph(db_session, PG, "prov_sandbox", ADA.id)   # 1 of 2
    db_session.add(WorkspaceDataSourceORM(id="ds_ada_pg2", workspace_id=PG, provider_id="prov_sandbox",
                                          graph_name="blank_b", label="Second", created_by=ADA.id))
    await db_session.flush()
    with pytest.raises(HTTPException) as full:
        await playground_policy.assert_blank_graph(db_session, PG, "prov_sandbox", ADA.id)
    assert full.value.status_code == 409 and full.value.detail["type"] == "playground_quota"


@pytest.mark.asyncio
async def test_its_starter_data_models_are_its_members_own(db_session, estate):
    member = await workspace_visibility.compute_visible_ontology_ids(db_session, MEMBER)
    outsider = await workspace_visibility.compute_visible_ontology_ids(
        db_session, PermissionClaims(sid="s_o", ws_perms={STD: MEMBER_PERMS}))
    assert "ont_start" in member
    assert "ont_start" not in (outsider or set())


@pytest.mark.asyncio
async def test_a_standard_workspace_is_untouched(db_session, estate):
    await playground_policy.assert_can_attach(db_session, STD)
    await playground_policy.assert_owner(db_session, STD, ADA.id, BEN.id, MEMBER)
    await playground_policy.assert_visibility(db_session, STD, "enterprise")
    await playground_policy.assert_blank_graph(db_session, STD, "prov_prod", BEN.id)
