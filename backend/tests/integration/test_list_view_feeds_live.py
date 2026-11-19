"""LIVE FalkorDB: a list view's largest layer — 50,820 members — paged to its last member,
and where the view draws entities, served with their nodes.

``test_member_views_live.py`` pins making the view and its layer filters; this pins what the
canvas reads of it once there is no ceiling on a layer: a layer lists every member, each
once, in name order, its cursor on until the last, never ``capped``, each page quick; a
batch of 500 entities is placed with its nodes, as the layer pages list them, inside a
second; and a column of a member table, no member itself, is drawn under its table, in its
layer.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_list_view_feeds_live.py -q -s
"""
from __future__ import annotations

import os
import time

import pytest
from httpx import AsyncClient

from backend.tests.integration.test_member_sets_live import SEEDS, _expected
from backend.tests.integration.test_member_views_live import live, on  # noqa: F401 — fixtures
from backend.tests.test_views_from_members_api import membership_on, workspace  # noqa: F401 — fixtures

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live test.",
)

#: Consumers two hops and more below the twenty seeds: (21 + 63 + 189 + 567 + 1,701) × 20.
FAR_DOWNSTREAM = 50_820


async def _made(client: AsyncClient, ws: str) -> str:
    """Everything twenty tables reach, by lineage stage: Save as view, then its members placed
    a turn at a time, as opening it carries them on."""
    body = {
        "name": "Everything twenty tables reach", "workspaceId": ws, "visibility": "private", "mode": "live",
        "sources": [{"spec": {"seeds": {"urns": [f"urn:seed:{s}" for s in range(SEEDS)]},
                              "expand": {"upstream": "all", "downstream": "all"}}}],
        "layout": {"kind": "stages", "nest": False}, "keep": "withResults",
        "provenance": {"origin": "trace"}, "waitMs": 5000,
    }
    for _ in range(200):
        on()
        resp = await client.post("/api/v1/views/from-members", json=body, headers={"Idempotency-Key": "feeds-live"})
        if resp.status_code != 202:
            break
    assert resp.status_code == 201, resp.text
    view_id = resp.json()["view"]["id"]
    for _ in range(200):
        on()
        status = (await client.get(f"/api/v1/views/{view_id}/membership")).json()
        if status["status"] in ("ok", "partial"):
            break
        out = await client.post(f"/api/v1/views/{view_id}/membership/refresh", params={"trigger": "open"})
        assert out.status_code in (200, 202), out.text
    assert status["status"] == "ok", status
    return view_id


async def test_a_list_views_largest_layer_and_its_served_placements(
    test_client: AsyncClient, membership_on, live,  # noqa: F811
):
    nodes, edges = live
    up, down = _expected(nodes, edges)
    ws = await workspace(test_client)
    started = time.monotonic()
    view_id = await _made(test_client, ws)
    made_in = time.monotonic() - started

    # The far-downstream stage pages to its last member at 500 a page.
    cursor, seen, keys, took, pages = None, set(), [], [], []
    while True:
        on()
        asked = time.monotonic()
        resp = await test_client.post(f"/api/v1/{ws}/graph/view-members", params={"viewId": view_id},
                                      json={"layerId": "stage-down2", "limit": 500,
                                            **({"cursor": cursor} if cursor else {})})
        took.append(time.monotonic() - asked)
        assert resp.status_code == 200, resp.text
        page = resp.json()
        pages.append(page)
        for n in page["nodes"]:
            assert n["urn"] not in seen, n["urn"]
            seen.add(n["urn"])
            keys.append((n["displayName"].lower(), n["urn"]))
        cursor = page.get("cursor")
        if not cursor:
            break
    assert {p["totalCount"] for p in pages} == {FAR_DOWNSTREAM}
    assert not any(p["capped"] for p in pages), "no ceiling: never capped"
    assert pages[-1]["delivered"] == len(seen) == FAR_DOWNSTREAM, "every member, once"
    assert seen == {u for u, hops in down.items() if hops >= 2}
    assert keys == sorted(keys), "name order never goes backwards"
    ranked = sorted(took)
    p95 = ranked[int(len(ranked) * 0.95) - 1]
    print(f"\nview of {SEEDS + len(up) + len(down):,} members made in {made_in:.1f} s; stage-down2: "
          f"{len(seen):,} members in {len(pages)} pages of 500, {sum(took):.1f} s in all, "
          f"p50 {ranked[len(ranked) // 2] * 1000:.0f} ms, p95 {p95 * 1000:.0f} ms, max {ranked[-1] * 1000:.0f} ms")
    assert p95 < 2.0, f"p95 page {p95:.2f} s"

    # 500 entities placed with their nodes, inside a second: as the layer's pages list them.
    listed = {n["urn"]: n for p in pages for n in p["nodes"]}
    sample = sorted(listed)[::len(listed) // 500][:500]
    on()
    asked = time.monotonic()
    resp = await test_client.post(f"/api/v1/{ws}/graph/view-placements", params={"viewId": view_id},
                                  json={"urns": sample, "nodes": True})
    with_nodes = time.monotonic() - asked
    assert resp.status_code == 200, resp.text
    answer = resp.json()
    assert all(answer["placements"][u] == {"layerId": "stage-down2", "source": "member", "inLayer": 0}
               for u in sample)
    assert set(answer["nodes"]) == set(sample)
    assert all(answer["nodes"][u] == listed[u] for u in sample), "the node its layer's page lists"
    print(f"placements of 500 with their nodes in {with_nodes * 1000:.0f} ms")
    assert with_nodes < 1.0, f"{with_nodes:.2f} s"

    # A column of a member table — no member itself — is drawn under it, in its layer.
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app

    table = sample[0]
    provider = (await app.dependency_overrides[get_context_engine]()).provider
    await provider._graph.query(
        "MATCH (t:Dataset {urn: $t}) CREATE (t)-[:CONTAINS]->(:Column {urn: $c, displayName: 'amount'})",
        {"t": table, "c": f"{table}/amount"})
    on()
    resp = await test_client.post(f"/api/v1/{ws}/graph/view-placements", params={"viewId": view_id},
                                  json={"urns": [f"{table}/amount"], "nodes": True})
    assert resp.status_code == 200, resp.text
    column = resp.json()
    assert column["placements"][f"{table}/amount"] == {"layerId": "stage-down2", "source": "inside", "inLayer": 1}
    assert [a["urn"] for a in column["nodes"][f"{table}/amount"]["ancestorPath"]] == [nodes[table], table]
    assert column["nodes"][f"{table}/amount"]["inLayer"] == 1
