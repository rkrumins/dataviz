"""Saving a layer rule that can never match (``view_repo.check_layer_rules``).

While ``placementContractEnabled`` is on, a NEW or CHANGED layer rule whose criteria make it inert
is refused with a 422 where rules are authored: ``POST /views`` and ``PUT /views/{id}/layout`` (the
base row and a draft's overlay alike), before anything is written. A rule stored earlier and sent
back unchanged always passes, because the canvas rewrites the whole layout on every gesture.
``PUT /views/{id}`` is not checked: the wizard's save sends back the layout it read, a draft's
overlay included, which need not match the base row. With the flag off every rule is accepted, as
before.
"""
from __future__ import annotations

import time

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ViewLayoutOverlayORM
from backend.app.services.feature_flags import feature_flags

_EMPTY = {"id": "r1", "name": "Unfinished", "priority": 10, "urnPattern": ""}
_VALID = {"id": "r2", "priority": 1, "entityTypes": ["dataset"]}


def _set_contract(on: bool) -> None:
    """Flip the flag the way a gate reads it: in the cache."""
    feature_flags._cache = {**(feature_flags._cache or {}), "placementContractEnabled": on}
    feature_flags._cache_ts = time.monotonic()


def _layout(*rules, layer_name="Gold") -> dict:
    return {
        "layers": [{"id": "l1", "name": layer_name, "order": 0, "entityTypes": [], "rules": list(rules)}],
        "assignments": {},
    }


def _config(layout=None) -> dict:
    config = {"content": {"entityScope": "all"}, "layout": {"type": "reference"}}
    if layout is not None:
        config["layout"]["referenceLayout"] = layout
    return config


async def _workspace(client: AsyncClient) -> str:
    resp = await client.post("/api/v1/admin/workspaces", json={"name": "Rules WS", "dataSources": []})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _create(client: AsyncClient, ws_id: str, config: dict):
    return await client.post("/api/v1/views/", json={
        "name": "Rules", "workspaceId": ws_id, "viewType": "reference", "config": config,
        "visibility": "private"})


async def _view_with(client: AsyncClient, layout: dict) -> str:
    """A view whose stored layout is ``layout``, saved while the flag is off."""
    _set_contract(False)
    created = await _create(client, await _workspace(client), _config(layout))
    assert created.status_code == 201, created.text
    return created.json()["id"]


async def _stored_rules(client: AsyncClient, view_id: str) -> list:
    body = (await client.get(f"/api/v1/views/{view_id}")).json()
    return body["config"]["layout"]["referenceLayout"]["layers"][0]["rules"]


# ── flag off: today's behaviour ─────────────────────────────────────────

async def test_flag_off_accepts_every_rule(test_client: AsyncClient):
    view_id = await _view_with(test_client, _layout(_EMPTY))
    assert (await test_client.put(f"/api/v1/views/{view_id}/layout",
                                  json={"referenceLayout": _layout(_EMPTY, {**_EMPTY, "id": "r3"})})).status_code == 200
    assert (await test_client.put(f"/api/v1/views/{view_id}/layout?branchId=br_off",
                                  json={"referenceLayout": _layout({**_EMPTY, "id": "r4"})})).status_code == 200
    assert (await test_client.put(f"/api/v1/views/{view_id}",
                                  json={"config": _config(_layout({**_EMPTY, "id": "r5"}))})).status_code == 200


# ── PUT /views/{id}/layout ──────────────────────────────────────────────

async def test_a_new_inert_rule_is_refused_and_nothing_is_written(test_client: AsyncClient):
    view_id = await _view_with(test_client, _layout(_VALID))
    _set_contract(True)

    resp = await test_client.put(f"/api/v1/views/{view_id}/layout",
                                 json={"referenceLayout": _layout(_VALID, _EMPTY)})

    assert resp.status_code == 422
    assert resp.json()["detail"] == "layer 'Gold': rule 'Unfinished' has no criteria, so it can never place anything"
    assert await _stored_rules(test_client, view_id) == [_VALID]


async def test_an_unchanged_stored_inert_rule_still_saves(test_client: AsyncClient):
    """An older view's inert rule never blocks a gesture that did not touch it."""
    view_id = await _view_with(test_client, _layout(_EMPTY))
    _set_contract(True)

    resp = await test_client.put(f"/api/v1/views/{view_id}/layout", json={"referenceLayout": {
        **_layout(_EMPTY, _VALID), "assignments": {"urn:a": {"layerId": "l1"}}}})

    assert resp.status_code == 200, resp.text
    assert await _stored_rules(test_client, view_id) == [_EMPTY, _VALID]


async def test_a_changed_inert_rule_is_refused(test_client: AsyncClient):
    view_id = await _view_with(test_client, _layout(_EMPTY))
    _set_contract(True)

    resp = await test_client.put(f"/api/v1/views/{view_id}/layout",
                                 json={"referenceLayout": _layout({**_EMPTY, "priority": 20})})
    assert resp.status_code == 422

    fixed = await test_client.put(f"/api/v1/views/{view_id}/layout",
                                  json={"referenceLayout": _layout({**_EMPTY, "urnPattern": "urn:li:*"})})
    assert fixed.status_code == 200, fixed.text


async def test_every_inert_rule_is_named(test_client: AsyncClient):
    view_id = await _view_with(test_client, _layout())
    _set_contract(True)
    bad_operator = {"id": "r6", "priority": 1, "propertyMatch": {"field": "owner", "operator": "matches", "value": "x"}}
    no_text = {"id": "r7", "priority": 1, "conditions": [{"field": "name", "operator": "contains", "value": ""}]}

    resp = await test_client.put(f"/api/v1/views/{view_id}/layout",
                                 json={"referenceLayout": _layout(bad_operator, no_text, layer_name="")})

    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail.startswith("layer 'l1': rule 'r6' uses an unknown operator matches; layer 'l1': rule 'r7' ")
    assert "cannot compare 'name'" in detail


# ── PUT /views/{id}/layout?branchId= (the draft's overlay) ─────────────

async def test_the_overlay_refuses_a_new_inert_rule_without_creating_itself(
    test_client: AsyncClient, db_session: AsyncSession,
):
    view_id = await _view_with(test_client, _layout(_VALID))
    _set_contract(True)

    resp = await test_client.put(f"/api/v1/views/{view_id}/layout?branchId=br_d1",
                                 json={"referenceLayout": _layout(_VALID, _EMPTY)})

    assert resp.status_code == 422
    overlay = (await db_session.execute(select(ViewLayoutOverlayORM).where(
        ViewLayoutOverlayORM.view_id == view_id))).scalar_one_or_none()
    assert overlay is None


async def test_the_overlay_compares_with_the_draft_then_the_base(test_client: AsyncClient):
    """A first draft write compares with the published base; later ones with the draft itself."""
    view_id = await _view_with(test_client, _layout(_EMPTY))
    _set_contract(True)
    url = f"/api/v1/views/{view_id}/layout?branchId=br_d2"

    assert (await test_client.put(url, json={"referenceLayout": _layout(_EMPTY, _VALID)})).status_code == 200
    assert (await test_client.put(url, json={"referenceLayout": _layout(_EMPTY)})).status_code == 200
    assert (await test_client.put(url, json={"referenceLayout": _layout({**_EMPTY, "id": "r8"})})).status_code == 422


# ── POST /views and PUT /views/{id} ─────────────────────────────────────

async def test_create_refuses_an_inert_rule(test_client: AsyncClient):
    ws_id = await _workspace(test_client)
    _set_contract(True)
    refused = await _create(test_client, ws_id, _config(_layout(_EMPTY)))
    assert refused.status_code == 422
    assert "rule 'Unfinished' has no criteria" in refused.json()["detail"]
    assert (await _create(test_client, ws_id, _config(_layout(_VALID)))).status_code == 201
    assert (await _create(test_client, ws_id, _config())).status_code == 201  # no layout at all


async def test_update_does_not_check_layer_rules(test_client: AsyncClient):
    """The wizard renames a draft by sending the layout it read: base plus overlay, whose inert
    rule the base row does not hold."""
    view_id = await _view_with(test_client, _layout(_VALID))
    _set_contract(True)

    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "name": "Renamed", "config": _config(_layout(_VALID, _EMPTY))})

    assert resp.status_code == 200, resp.text
