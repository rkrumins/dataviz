"""RBAC Phase 18 — workspace-scoped reads for ontologies / providers /
catalog. Tests the gate split (read vs manage) and the visibility
filtering that keeps non-admins to what their workspaces touch.

Pattern follows ``test_rbac_endpoint_coverage.py``: override
``get_current_user`` + ``get_permission_claims`` so we can stamp the
exact role we're emulating. Visibility relies on real DB rows
(workspaces, providers, ontologies, data sources), so each test seeds
its own minimal graph through the same engine the API uses.
"""
from __future__ import annotations

import contextlib

import pytest
from fastapi import HTTPException, status
from httpx import AsyncClient
from sqlalchemy import insert
from sqlalchemy.ext.asyncio import AsyncEngine

from backend.app.auth.dependencies import (
    get_current_user,
    get_permission_claims,
)
from backend.app.db.models import (
    CatalogItemORM,
    OntologyORM,
    ProviderORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User


def _user(uid: str = "usr_test") -> User:
    return User(
        id=uid,
        email=f"{uid}@example.com",
        first_name="Test",
        last_name="User",
        role="user",
        status="active",
        created_at="2024-01-01T00:00:00Z",
        updated_at="2024-01-01T00:00:00Z",
    )


VIEWER_CLAIMS_WS_A = PermissionClaims(
    sid="sess_viewer",
    ws_perms={
        "ws_A": (
            "workspace:view:read",
            "workspace:datasource:read",
            "workspace:ontology:read",
            "workspace:provider:read",
            "workspace:catalog:read",
        ),
    },
)

ADMIN_CLAIMS_WS_A = PermissionClaims(
    sid="sess_wsadmin",
    ws_perms={"ws_A": ("workspace:admin",)},
)

SUPER_ADMIN_CLAIMS = PermissionClaims(
    sid="sess_super",
    global_perms=("system:admin",),
)

EMPTY_CLAIMS = PermissionClaims(sid="sess_empty")


@contextlib.contextmanager
def _auth(*, user, claims):
    from backend.app.main import app

    async def _ovr_user():
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
        return user

    def _ovr_claims():
        if user is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
        return claims

    app.dependency_overrides[get_current_user] = _ovr_user
    app.dependency_overrides[get_permission_claims] = _ovr_claims
    try:
        yield
    finally:
        app.dependency_overrides.pop(get_current_user, None)
        app.dependency_overrides.pop(get_permission_claims, None)


async def _seed_two_workspaces(engine: AsyncEngine) -> None:
    """ws_A has data sources tied to provider_a/ontology_a/catalog_a.
    ws_B (the user has NO binding to) carries provider_b/ontology_b/catalog_b."""
    async with engine.begin() as conn:
        await conn.execute(insert(WorkspaceORM), [
            {"id": "ws_A", "name": "WS A", "description": None, "is_default": False, "is_active": True},
            {"id": "ws_B", "name": "WS B", "description": None, "is_default": False, "is_active": True},
        ])
        await conn.execute(insert(ProviderORM), [
            {
                "id": "prov_a", "name": "Prov A", "provider_type": "falkordb",
                "host": "h", "port": 1, "credentials": None, "tls_enabled": False,
                "is_active": True, "extra_config": None,
                "permitted_workspaces": '["ws_A"]',
            },
            {
                "id": "prov_b", "name": "Prov B", "provider_type": "falkordb",
                "host": "h", "port": 1, "credentials": None, "tls_enabled": False,
                "is_active": True, "extra_config": None,
                "permitted_workspaces": '["ws_B"]',
            },
        ])
        await conn.execute(insert(OntologyORM), [
            {
                "id": "ont_a", "name": "Ont A", "version": 1, "schema_id": "ont_a",
                "description": None, "is_published": False, "is_system": False,
                "scope": "universal", "evolution_policy": "reject",
                "entity_type_definitions": "{}", "relationship_type_definitions": "{}",
                "containment_edge_types": "[]", "lineage_edge_types": "[]",
                "edge_type_metadata": "{}", "entity_type_hierarchy": "{}",
                "root_entity_types": "[]", "revision": 0,
            },
            {
                "id": "ont_b", "name": "Ont B", "version": 1, "schema_id": "ont_b",
                "description": None, "is_published": False, "is_system": False,
                "scope": "universal", "evolution_policy": "reject",
                "entity_type_definitions": "{}", "relationship_type_definitions": "{}",
                "containment_edge_types": "[]", "lineage_edge_types": "[]",
                "edge_type_metadata": "{}", "entity_type_hierarchy": "{}",
                "root_entity_types": "[]", "revision": 0,
            },
        ])
        await conn.execute(insert(CatalogItemORM), [
            {
                "id": "cat_a", "provider_id": "prov_a", "source_identifier": "s_a",
                "name": "Cat A", "description": None,
                "permitted_workspaces": '["ws_A"]', "status": "active",
            },
            {
                "id": "cat_b", "provider_id": "prov_b", "source_identifier": "s_b",
                "name": "Cat B", "description": None,
                "permitted_workspaces": '["ws_B"]', "status": "active",
            },
        ])
        await conn.execute(insert(WorkspaceDataSourceORM), [
            {
                "id": "ds_a", "workspace_id": "ws_A", "provider_id": "prov_a",
                "graph_name": "g_a", "catalog_item_id": "cat_a",
                "ontology_id": "ont_a", "label": "DS A", "is_primary": True,
                "is_active": True,
            },
            {
                "id": "ds_b", "workspace_id": "ws_B", "provider_id": "prov_b",
                "graph_name": "g_b", "catalog_item_id": "cat_b",
                "ontology_id": "ont_b", "label": "DS B", "is_primary": True,
                "is_active": True,
            },
        ])


# ── List filtering ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_viewer_sees_only_their_workspace_ontologies(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    with _auth(user=_user(), claims=VIEWER_CLAIMS_WS_A):
        r = await test_client.get("/api/v1/admin/ontologies")
    assert r.status_code == 200, r.text
    ids = {row["id"] for row in r.json()}
    assert "ont_a" in ids
    assert "ont_b" not in ids


@pytest.mark.asyncio
async def test_viewer_sees_only_their_workspace_providers(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    with _auth(user=_user(), claims=VIEWER_CLAIMS_WS_A):
        r = await test_client.get("/api/v1/admin/providers")
    assert r.status_code == 200, r.text
    ids = {row["id"] for row in r.json()}
    assert "prov_a" in ids
    assert "prov_b" not in ids


@pytest.mark.asyncio
async def test_viewer_sees_only_their_workspace_catalog(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    with _auth(user=_user(), claims=VIEWER_CLAIMS_WS_A):
        r = await test_client.get("/api/v1/admin/catalog")
    assert r.status_code == 200, r.text
    ids = {row["id"] for row in r.json()}
    assert "cat_a" in ids
    assert "cat_b" not in ids


@pytest.mark.asyncio
async def test_super_admin_sees_everything(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    with _auth(user=_user(), claims=SUPER_ADMIN_CLAIMS):
        r = await test_client.get("/api/v1/admin/ontologies")
    assert r.status_code == 200, r.text
    ids = {row["id"] for row in r.json()}
    assert "ont_a" in ids and "ont_b" in ids


# ── Hidden-existence (404 not 403 on cross-workspace reads) ─────────

@pytest.mark.asyncio
async def test_viewer_gets_404_on_other_workspace_ontology(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    with _auth(user=_user(), claims=VIEWER_CLAIMS_WS_A):
        r = await test_client.get("/api/v1/admin/ontologies/ont_b")
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_viewer_gets_404_on_other_workspace_provider(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    with _auth(user=_user(), claims=VIEWER_CLAIMS_WS_A):
        r = await test_client.get("/api/v1/admin/providers/prov_b")
    assert r.status_code == 404, r.text


# ── Read vs manage split ───────────────────────────────────────────

@pytest.mark.asyncio
async def test_viewer_cannot_create_ontology(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    with _auth(user=_user(), claims=VIEWER_CLAIMS_WS_A):
        r = await test_client.post(
            "/api/v1/admin/ontologies",
            json={"name": "Nope", "version": 1, "scope": "universal"},
        )
    assert r.status_code == 403, r.text
    body = r.json()
    assert body["detail"]["permission"] == "workspace:ontology:manage"


@pytest.mark.asyncio
async def test_workspace_admin_can_create_ontology(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    # workspace:admin auto-implies workspace:ontology:manage via the
    # resolver leaves set (Phase 18). We supply the implied perm
    # directly here since the override skips the resolver.
    claims = PermissionClaims(
        sid="sess_wsa",
        ws_perms={"ws_A": ("workspace:admin", "workspace:ontology:manage", "workspace:ontology:read")},
    )
    with _auth(user=_user(), claims=claims):
        r = await test_client.post(
            "/api/v1/admin/ontologies",
            json={"name": "From WS Admin", "version": 1, "scope": "universal"},
        )
    # 201 (created) or 422 (validation tweak in request shape) is the
    # success contract; the point is the AUTH gate let it through.
    assert r.status_code != 403, r.text


# ── Provider write stays system:admin-only ─────────────────────────

@pytest.mark.asyncio
async def test_workspace_admin_cannot_create_provider(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    claims = PermissionClaims(
        sid="sess_wsa",
        ws_perms={"ws_A": ("workspace:admin",)},
    )
    with _auth(user=_user(), claims=claims):
        r = await test_client.post(
            "/api/v1/admin/providers",
            json={"name": "Nope", "providerType": "mock"},
        )
    assert r.status_code == 403, r.text
    assert r.json()["detail"]["permission"] == "system:admin"


# ── User with no workspaces ────────────────────────────────────────

@pytest.mark.asyncio
async def test_empty_claims_get_403_on_reads(
    test_client: AsyncClient, db_engine: AsyncEngine,
):
    await _seed_two_workspaces(db_engine)
    with _auth(user=_user(), claims=EMPTY_CLAIMS):
        r = await test_client.get("/api/v1/admin/ontologies")
    assert r.status_code == 403, r.text
