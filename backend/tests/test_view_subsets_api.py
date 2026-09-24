"""``POST /views/{id}/subsets`` — carving a subset view out of a Context View.

Pins the contract end to end: one write builds a curated Context View from
the source's layers, stores where it came from and the RESOLVED data source,
records the creation on the new view's timeline only, and is gated like any
create (read the source or 404, ``workspace:view:create`` or 403, the flag or
403). The provenance read never discloses a source the caller cannot open.
"""
from __future__ import annotations

import json
import time

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import (
    ProviderORM, ViewActivityLogORM, ViewORM, WorkspaceDataSourceORM, WorkspaceORM,
)
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user

WS = "ws_subset"
OTHER_WS = "ws_elsewhere"
OWNER = _user("usr_owner")
MEMBER = _user("usr_member")
STRANGER = _user("usr_stranger")

_MEMBER_LEAVES = (
    "workspace:view:create", "workspace:view:edit", "workspace:view:delete",
    "workspace:view:read", "workspace:datasource:*",
)
OWNER_CLAIMS = PermissionClaims(sid="s_owner", ws_perms={WS: _MEMBER_LEAVES})
READ_ONLY_CLAIMS = PermissionClaims(sid="s_member", ws_perms={WS: ("workspace:view:read",)})
STRANGER_CLAIMS = PermissionClaims(sid="s_stranger", ws_perms={OTHER_WS: _MEMBER_LEAVES})


def _flag(on: bool) -> None:
    feature_flags._cache = {**(feature_flags._cache or {}), "viewSubsetsEnabled": on}
    feature_flags._cache_ts = time.monotonic()


def _config() -> dict:
    return {
        "content": {"visibleEntityTypes": ["table"], "entityScope": "curated"},
        "layout": {
            "type": "reference",
            "referenceLayout": {
                "layers": [
                    {"id": "raw", "name": "Raw", "order": 0,
                     "rules": [{"id": "x", "urnPattern": "urn:unpicked", "priority": 1}]},
                    {"id": "marts", "name": "Marts", "order": 1},
                ],
                "assignments": {
                    "urn:A": {"layerId": "raw", "inheritsChildren": True},
                    "urn:B": {"layerId": "raw", "inheritsChildren": True},
                    "urn:C": {"layerId": "marts", "inheritsChildren": True},
                },
            },
        },
    }


async def _seed(db_session, *, visibility="private", view_type="reference", with_source=True) -> str:
    db_session.add(WorkspaceORM(id=WS, name="Subset WS"))
    db_session.add(WorkspaceORM(id=OTHER_WS, name="Elsewhere"))
    if with_source:
        db_session.add(ProviderORM(id="prov_subset", name="P", provider_type="falkordb"))
        await db_session.flush()
        db_session.add(WorkspaceDataSourceORM(
            id="ds_primary", workspace_id=WS, provider_id="prov_subset",
            graph_name="g", label="Primary", is_primary=True, is_active=True,
        ))
    db_session.add(ViewORM(
        id="view_source", name="Finance lineage", workspace_id=WS, data_source_id=None,
        view_type=view_type, config=json.dumps(_config()), visibility=visibility,
        created_by=OWNER.id,
    ))
    await db_session.commit()
    return "view_source"


def _body(**overrides) -> dict:
    body = {
        "name": "Revenue story",
        "description": "Just the flow finance cares about",
        "visibility": "private",
        "members": [
            {"urn": "urn:A", "layerId": "raw"},
            {"urn": "urn:C", "layerId": "marts", "inheritsChildren": False},
        ],
        "connectivity": {"mode": "bridged", "maxHops": 6},
    }
    body.update(overrides)
    return body


async def test_a_subset_is_one_write_of_a_curated_context_view(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session)
    resp = await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body())
    assert resp.status_code == 201, resp.text
    view = resp.json()
    assert view["viewType"] == "reference"
    assert view["derivedFromViewId"] == source_id
    assert view["workspaceId"] == WS
    assert view["dataSourceId"] == "ds_primary"          # resolved, never NULL
    assert view["visibility"] == "private"
    content = view["config"]["content"]
    assert content["entityScope"] == "curated"
    assert content["connectivity"] == {"mode": "bridged", "maxHops": 6}
    ref = view["config"]["layout"]["referenceLayout"]
    assert set(ref["assignments"]) == {"urn:A", "urn:C"}
    assert ref["assignments"]["urn:C"]["inheritsChildren"] is False
    assert ref["layers"][0]["rules"] == []                # the exact-urn rule did not come along

    rows = (await db_session.execute(select(ViewActivityLogORM))).scalars().all()
    assert [(r.view_id, r.action) for r in rows] == [(view["id"], "created")]
    assert json.loads(rows[0].changes)["derivedFrom"] == source_id


async def test_the_single_read_names_its_source(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session)
    created = (await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body())).json()
    view = (await test_client.get(f"/api/v1/views/{created['id']}")).json()
    assert view["derivedFrom"] == {"id": source_id, "name": "Finance lineage", "accessible": True}
    assert view["access"]["canCreateSubset"] is True


async def test_a_source_the_reader_cannot_open_is_never_named(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session, visibility="private")
    with _auth(user=OWNER, claims=OWNER_CLAIMS):
        created = await test_client.post(
            f"/api/v1/views/{source_id}/subsets", json=_body(visibility="workspace"),
        )
    assert created.status_code == 201, created.text
    member_claims = PermissionClaims(sid="s_m", ws_perms={WS: ("workspace:view:read",)})
    with _auth(user=MEMBER, claims=member_claims):
        view = (await test_client.get(f"/api/v1/views/{created.json()['id']}")).json()
    assert view["derivedFrom"] == {"id": source_id, "name": None, "accessible": False}


async def test_the_subsets_of_a_view_are_listed_by_filter(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session)
    first = (await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body(name="One"))).json()
    second = (await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body(name="Two"))).json()
    listed = (await test_client.get("/api/v1/views/", params={"derivedFrom": source_id})).json()
    assert {v["id"] for v in listed["items"]} == {first["id"], second["id"]}
    assert all(v["derivedFromViewId"] == source_id for v in listed["items"])


async def test_a_stranger_cannot_find_a_private_source(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session, visibility="private")
    with _auth(user=STRANGER, claims=STRANGER_CLAIMS):
        resp = await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body())
    assert resp.status_code == 404


async def test_reading_is_not_enough_to_create(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session, visibility="workspace")
    with _auth(user=MEMBER, claims=READ_ONLY_CLAIMS):
        resp = await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body())
    assert resp.status_code == 403
    assert "workspace:view:create" in resp.text


async def test_only_a_context_view_can_be_subset(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session, view_type="graph")
    resp = await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body())
    assert resp.status_code == 422
    view = (await test_client.get(f"/api/v1/views/{source_id}")).json()
    assert view["access"]["canCreateSubset"] is False


async def test_picks_that_no_longer_fit_the_source_are_refused(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session)
    resp = await test_client.post(
        f"/api/v1/views/{source_id}/subsets",
        json=_body(members=[{"urn": "urn:A", "layerId": "vanished"}]),
    )
    assert resp.status_code == 422
    assert "layers changed" in resp.text


@pytest.mark.parametrize("patch", [
    {"members": []},
    {"name": ""},
    {"visibility": "everyone"},
    {"connectivity": {"mode": "bridged", "maxHops": 21}},
    {"members": [{"urn": f"urn:{i}", "layerId": "raw"} for i in range(1001)]},
])
async def test_the_body_is_bounded(test_client: AsyncClient, db_session, patch):
    source_id = await _seed(db_session)
    resp = await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body(**patch))
    assert resp.status_code == 422


async def test_refused_while_the_flag_is_off(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session)
    _flag(False)
    resp = await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body())
    assert resp.status_code == 403
    assert "viewSubsetsEnabled" in resp.text


async def test_a_workspace_without_a_source_still_gets_its_subset(test_client: AsyncClient, db_session):
    source_id = await _seed(db_session, with_source=False)
    resp = await test_client.post(f"/api/v1/views/{source_id}/subsets", json=_body())
    assert resp.status_code == 201
    assert resp.json()["dataSourceId"] is None
