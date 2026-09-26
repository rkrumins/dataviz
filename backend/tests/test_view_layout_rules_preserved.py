"""No layout or config save changes a view's display rules.

Every view writer replaces ``referenceLayout`` wholesale and the rules live inside it, so a
caller that edits layers only (the View Wizard, a config save built from a normalised layout)
used to wipe every rule on the view — and one that sent back the rules it had read put back
rules someone had since changed. Rules are now written only through the view's library, one at
a time; every other writer keeps the stored ones, whatever it sends. Same fixtures as
``test_view_layout_endpoint.py``.
"""
from httpx import AsyncClient

RULE = {"id": "rule_1", "name": "PII", "color": "#6366f1", "enabled": True,
        "predicate": {"kind": "hasProperty", "key": "pii"}, "createdAt": "2026-09-23T00:00:00Z"}
STALE = {**RULE, "id": "rule_old", "name": "Old"}

LAYOUT = {
    "layers": [{"id": "l1", "name": "Layer 1", "entityTypes": [], "order": 0}],
    "assignments": {"urn:a": {"layerId": "l1", "inheritsChildren": True, "assignedBy": "user"}},
}


async def _view(client: AsyncClient, view_type: str = "reference") -> str:
    ws = await client.post("/api/v1/admin/workspaces", json={"name": "Rules WS", "dataSources": []})
    assert ws.status_code == 201
    resp = await client.post("/api/v1/views/", json={
        "name": "Rules View", "workspaceId": ws.json()["id"], "viewType": view_type,
        "config": {"layout": {"type": view_type}}, "visibility": "private",
    })
    assert resp.status_code == 201
    return resp.json()["id"]


async def _add_rule(client: AsyncClient, view_id: str, branch: str | None = None) -> None:
    params = {"branchId": branch} if branch else None
    resp = await client.put(f"/api/v1/views/{view_id}/library/rules/{RULE['id']}",
                            params=params, json=RULE)
    assert resp.status_code == 200, resp.text


async def _rules(client: AsyncClient, view_id: str) -> list:
    body = (await client.get(f"/api/v1/views/{view_id}")).json()
    return body["config"]["layout"]["referenceLayout"].get("displayRules")


async def test_layout_save_without_rules_keeps_them(test_client: AsyncClient):
    view_id = await _view(test_client)
    await _add_rule(test_client, view_id)

    # The View Wizard's shape: layers and assignments, no rules.
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout", json={"referenceLayout": LAYOUT})
    assert resp.status_code == 200
    assert [r["id"] for r in await _rules(test_client, view_id)] == ["rule_1"]


async def test_a_layout_save_cannot_change_the_rules(test_client: AsyncClient):
    view_id = await _view(test_client)
    await _add_rule(test_client, view_id)
    for sent in ([], [STALE]):
        resp = await test_client.put(f"/api/v1/views/{view_id}/layout", json={
            "referenceLayout": {**LAYOUT, "displayRules": sent}, "displayRules": sent})
        assert resp.status_code == 200
        assert [r["id"] for r in await _rules(test_client, view_id)] == ["rule_1"]


async def test_draft_layout_save_keeps_the_drafts_rules(test_client: AsyncClient):
    view_id = await _view(test_client)
    await _add_rule(test_client, view_id, branch="br_rules")
    resp = await test_client.put(f"/api/v1/views/{view_id}/layout?branchId=br_rules",
                                 json={"referenceLayout": LAYOUT, "displayRules": []})
    assert resp.status_code == 200
    eff = resp.json()["config"]["layout"]["referenceLayout"]
    assert [r["id"] for r in eff["displayRules"]] == ["rule_1"]


async def test_config_save_keeps_the_rules_it_was_not_told_about(test_client: AsyncClient):
    view_id = await _view(test_client)
    await _add_rule(test_client, view_id)
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "config": {"layout": {"type": "reference", "referenceLayout": LAYOUT}},
    })
    assert resp.status_code == 200
    assert [r["id"] for r in await _rules(test_client, view_id)] == ["rule_1"]


async def test_config_save_from_a_stale_copy_keeps_the_current_rules(test_client: AsyncClient):
    view_id = await _view(test_client)
    await _add_rule(test_client, view_id)
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "config": {"layout": {"type": "reference",
                              "referenceLayout": {**LAYOUT, "displayRules": [STALE]}}},
    })
    assert resp.status_code == 200
    assert [r["id"] for r in await _rules(test_client, view_id)] == ["rule_1"]


async def test_a_graph_views_config_save_keeps_its_rules(test_client: AsyncClient):
    # The wizard saves a graph view with no referenceLayout at all.
    view_id = await _view(test_client, view_type="graph")
    await _add_rule(test_client, view_id)
    resp = await test_client.put(f"/api/v1/views/{view_id}", json={
        "config": {"layout": {"type": "graph", "graphLayout": {"algorithm": "dagre"}}},
    })
    assert resp.status_code == 200
    library = (await test_client.get(f"/api/v1/views/{view_id}/library")).json()
    assert [r["id"] for r in library["displayRules"]] == ["rule_1"]
