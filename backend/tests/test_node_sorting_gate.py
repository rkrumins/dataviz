"""``nodeSortingEnabled`` is enforced by the server, not just hidden in the UI.

The flag had no backend half at all: an admin could switch node sorting off,
the canvas would hide the sort menu, and anyone posting to the view-layout
endpoint directly would still set sort modes and custom orders. A toggle that
only hides a button is decoration — which is precisely what
``test_feature_wiring`` exists to prevent, and why this flag could not be given
a wiring entry until the gate existed.

Enforcement STRIPS rather than refuses. The canvas rewrites the whole
``referenceLayout`` on every gesture, so a payload still carrying a
``nodeSortMode`` from before the switch was thrown is the normal case, not an
attack — refusing it would 403 somebody for dragging a node.
"""
from __future__ import annotations

import copy
import json
from contextlib import asynccontextmanager

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from backend.app.db.models import ViewORM
from backend.app.services.layout_config import strip_node_ordering


# ── the pure stripper ────────────────────────────────────────────────


def _ordered_layout() -> dict:
    return {
        "layers": [
            {"id": "l1", "name": "L1", "order": 0, "nodeSortMode": "custom"},
            {"id": "l2", "name": "L2", "order": 1, "nodeSortMode": "alpha-asc"},
        ],
        "assignments": {
            "urn:a": {"layerId": "l1", "inheritsChildren": True, "orderKey": "a1"},
            "urn:b": {"layerId": "l2", "inheritsChildren": True},
        },
        "defaultNodeSortMode": "alpha-desc",
        "displayRules": [{"id": "r1"}],
    }


def test_strip_removes_every_ordering_field():
    out = strip_node_ordering(_ordered_layout())

    assert "defaultNodeSortMode" not in out
    assert all("nodeSortMode" not in l for l in out["layers"])
    assert all("orderKey" not in e for e in out["assignments"].values())


def test_strip_keeps_everything_that_is_not_ordering():
    """Layers, assignments and display rules are the user's actual work —
    the switch governs how nodes are ORDERED, nothing else."""
    out = strip_node_ordering(_ordered_layout())

    assert [l["id"] for l in out["layers"]] == ["l1", "l2"]
    assert out["layers"][0]["name"] == "L1"
    assert set(out["assignments"]) == {"urn:a", "urn:b"}
    assert out["assignments"]["urn:a"]["layerId"] == "l1"
    assert out["displayRules"] == [{"id": "r1"}]


def test_strip_never_mutates_its_input():
    original = _ordered_layout()
    before = copy.deepcopy(original)
    strip_node_ordering(original)
    assert original == before


def test_strip_returns_the_same_object_when_there_is_nothing_to_strip():
    clean = {"layers": [{"id": "l1", "order": 0}], "assignments": {}}
    assert strip_node_ordering(clean) is clean


def test_strip_tolerates_junk():
    assert strip_node_ordering(None) is None
    assert strip_node_ordering({"layers": "not-a-list"}) == {"layers": "not-a-list"}


# ── end to end, through the endpoint ─────────────────────────────────


@asynccontextmanager
async def _node_sorting(enabled: bool):
    from backend.app.services import feature_flags as ff_mod

    original = ff_mod.feature_flags.is_enabled

    async def _stub(key, session, default=False):
        if key == "nodeSortingEnabled":
            return enabled
        return await original(key, session, default=default)

    ff_mod.feature_flags.is_enabled = _stub
    try:
        yield
    finally:
        ff_mod.feature_flags.is_enabled = original


async def _create_view(client: AsyncClient) -> str:
    ws = await client.post(
        "/api/v1/admin/workspaces",
        json={"name": "Sort Gate WS", "dataSources": []},
    )
    assert ws.status_code == 201
    resp = await client.post("/api/v1/views/", json={
        "name": "Sort Gate View",
        "workspaceId": ws.json()["id"],
        "viewType": "reference",
        "config": {
            "content": {
                "visibleEntityTypes": ["domain"], "visibleRelationshipTypes": [],
                "defaultDepth": 5, "maxDepth": 10, "rootEntityTypes": ["domain"],
            },
            "filters": {
                "entityTypeFilters": [], "fieldFilters": [],
                "searchableFields": [], "quickFilters": [],
            },
            "layout": {"type": "reference", "lod": {"enabled": False, "levels": []}},
        },
        "visibility": "private",
    })
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


def _payload() -> dict:
    return {
        "referenceLayout": {
            "layers": [
                {"id": "l1", "name": "Layer 1", "entityTypes": [], "order": 0,
                 "nodeSortMode": "custom"},
            ],
            "assignments": {
                "urn:a": {
                    "layerId": "l1", "inheritsChildren": True,
                    "assignedBy": "user", "orderKey": "a1",
                },
            },
            "defaultNodeSortMode": "alpha-desc",
        },
    }


async def _stored_layout(db_session, view_id: str) -> dict:
    row = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )).scalar_one()
    await db_session.refresh(row)
    return json.loads(row.config)["layout"]["referenceLayout"]


@pytest.mark.asyncio
async def test_ordering_is_persisted_when_the_flag_is_on(
    test_client: AsyncClient, db_session,
):
    view_id = await _create_view(test_client)

    async with _node_sorting(True):
        r = await test_client.put(f"/api/v1/views/{view_id}/layout", json=_payload())
    assert r.status_code == 200, r.text

    stored = await _stored_layout(db_session, view_id)
    assert stored["defaultNodeSortMode"] == "alpha-desc"
    assert stored["layers"][0]["nodeSortMode"] == "custom"
    assert stored["assignments"]["urn:a"]["orderKey"] == "a1"


@pytest.mark.asyncio
async def test_ordering_cannot_be_written_when_the_flag_is_off(
    test_client: AsyncClient, db_session,
):
    """The whole point: hiding the sort menu is not enforcement. A direct
    API call must not be able to set an order the admin disabled."""
    view_id = await _create_view(test_client)

    async with _node_sorting(False):
        r = await test_client.put(f"/api/v1/views/{view_id}/layout", json=_payload())

    # Accepted, not refused — the rest of the layout is legitimate work.
    assert r.status_code == 200, r.text

    stored = await _stored_layout(db_session, view_id)
    assert "defaultNodeSortMode" not in stored
    assert "nodeSortMode" not in stored["layers"][0]
    assert "orderKey" not in stored["assignments"]["urn:a"]

    # ...and the layout itself survived intact.
    assert stored["layers"][0]["id"] == "l1"
    assert stored["assignments"]["urn:a"]["layerId"] == "l1"


@pytest.mark.asyncio
async def test_an_order_saved_earlier_is_left_alone(
    test_client: AsyncClient, db_session,
):
    """The flag's admin copy promises that orders already saved keep
    rendering as curated. Turning the switch off must not retroactively
    erase anybody's published curation — only stop new writes."""
    view_id = await _create_view(test_client)

    async with _node_sorting(True):
        await test_client.put(f"/api/v1/views/{view_id}/layout", json=_payload())

    async with _node_sorting(False):
        read_back = await test_client.get(f"/api/v1/views/{view_id}")

    assert read_back.status_code == 200
    stored = await _stored_layout(db_session, view_id)
    assert stored["layers"][0]["nodeSortMode"] == "custom"
    assert stored["assignments"]["urn:a"]["orderKey"] == "a1"


@pytest.mark.asyncio
async def test_the_gate_fails_open_when_the_flag_cannot_be_read(
    test_client: AsyncClient, db_session,
):
    """A capability flag, so an unreadable value keeps the feature
    working: silently discarding somebody's curation over a database
    hiccup would be a worse failure than the one being defended against."""
    from backend.app.services import feature_flags as ff_mod

    view_id = await _create_view(test_client)
    original = ff_mod.feature_flags.is_enabled

    async def _unreadable(key, session, default=False):
        return default

    ff_mod.feature_flags.is_enabled = _unreadable
    try:
        r = await test_client.put(f"/api/v1/views/{view_id}/layout", json=_payload())
    finally:
        ff_mod.feature_flags.is_enabled = original

    assert r.status_code == 200, r.text
    stored = await _stored_layout(db_session, view_id)
    assert stored["layers"][0]["nodeSortMode"] == "custom"
