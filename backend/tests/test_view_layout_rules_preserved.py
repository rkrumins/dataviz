"""A save that says nothing about display rules must not delete them.

Every view writer replaces ``referenceLayout`` wholesale and the rules live inside it, so a
caller that edits layers only (the View Wizard, a config save built from a normalised layout)
used to wipe every rule on the view. An absent ``displayRules`` now inherits the stored ones;
an explicit list — including ``[]`` — still wins. Same fixtures as
``test_view_layout_endpoint.py``.
"""
from httpx import AsyncClient

RULE = {"id": "rule_1", "name": "PII", "color": "#6366f1", "enabled": True,
        "predicate": {"kind": "hasProperty", "key": "pii"}, "createdAt": "2026-09-23T00:00:00Z"}

LAYOUT = {
    "layers": [{"id": "l1", "name": "Layer 1", "entityTypes": [], "order": 0}],
    "assignments": {"urn:a": {"layerId": "l1", "inheritsChildren": True, "assignedBy": "user"}},
}


async def _view(client: AsyncClient) -> str:
    ws = await client.post("/api/v1/admin/workspaces", json={"name": "Rules WS", "dataSources": []})
    assert ws.status_code == 201
    resp = await client.post("/api/v1/views/", json={
        "name": "Rules View", "workspaceId": ws.json()["id"], "viewType": "reference",
        "config": {"layout": {"type": "reference"}}, "visibility": "private",
    })
    assert resp.status_code == 201
    return resp.json()["id"]


async def _rules(client: AsyncClient, view_id: str) -> list:
    body = (await client.get(f"/api/v1/views/{view_id}")).json()
    return body["config"]["layout"]["referenceLayout"].get("displayRules")


async def test_layout_save_without_rules_keeps_them(test_client: AsyncClient):
    view_id = await _view(test_client)
    first = await test_client.put(f"/api/v1/views/{view_id}/layout",
                                  json={"referenceLayout": LAYOUT, "displayRules": [RULE]})
    assert first.status_code == 200

    # The View Wizard's shape: layers and assignments, no rules.
    second = await test_client.put(f"/api/v1/views/{view_id}/layout", json={"referenceLayout": LAYOUT})
    assert second.status_code == 200
    assert [r["id"] for r in await _rules(test_client, view_id)] == ["rule_1"]


async def test_explicit_empty_rules_still_clear_them(test_client: AsyncClient):
    view_id = await _view(test_client)
    await test_client.put(f"/api/v1/views/{view_id}/layout",
                          json={"referenceLayout": LAYOUT, "displayRules": [RULE]})
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout",
                                 json={"referenceLayout": LAYOUT, "displayRules": []})
    assert resp.status_code == 200
    assert await _rules(test_client, view_id) == []


async def test_draft_layout_save_without_rules_keeps_them(test_client: AsyncClient):
    view_id = await _view(test_client)
    url = f"/api/v1/views/{view_id}/layout?branchId=br_rules"
    await test_client.put(url, json={"referenceLayout": LAYOUT, "displayRules": [RULE]})
    resp = await test_client.put(url, json={"referenceLayout": LAYOUT})
    assert resp.status_code == 200
    eff = resp.json()["config"]["layout"]["referenceLayout"]
    assert [r["id"] for r in eff["displayRules"]] == ["rule_1"]


async def test_config_save_without_rules_keeps_them(test_client: AsyncClient):
    view_id = await _view(test_client)
    await test_client.put(f"/api/v1/views/{view_id}/layout",
                          json={"referenceLayout": LAYOUT, "displayRules": [RULE]})
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "config": {"layout": {"type": "reference", "referenceLayout": LAYOUT}},
    })
    assert resp.status_code == 200
    assert [r["id"] for r in await _rules(test_client, view_id)] == ["rule_1"]
