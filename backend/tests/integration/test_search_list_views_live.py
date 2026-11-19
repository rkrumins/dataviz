"""LIVE FalkorDB: searching inside a view made from a query, and a subset that follows one,
on fifty thousand entities — through the app's own routes.

The base keeps its own layers: "Big", the datasets of three domains (past the search's
root cap, so read where its members are kept, and past a feed scan's session of 5,000
rows), and "Small", three hundred datasets of another domain, each with two columns. A
person also placed a domain there by hand ("Always include", not kept whole).

What it must hold:

* a subset that follows it lists each layer's members — and what is inside them — in
  name order, each once, paging past a scan's 5,000 rows with no ceiling; "Other
  matches" lists what no member places (the hand-placed domain's datasets), and no
  member; each count exact once the layer is read to its end;
* the base's property catalog completes past the root cap, reading its members where
  they are kept;
* ancestor counts after a search filtered to a layer are read from that search.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_list_views_live.py -q
"""
from __future__ import annotations

import json
import os
import time
import uuid

import pytest
import pytest_asyncio
from httpx import AsyncClient

from backend.common.models.search_view import REST_LAYER_ID
from backend.tests.integration.test_member_sets_live import _graph
from backend.tests.integration.test_member_views_live import ViewEngine
from backend.tests.test_views_from_members_api import flags, workspace

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live test.",
)

BIG_DOMAINS = ("urn:domain:0", "urn:domain:1", "urn:domain:2")
SMALL_DOMAIN, SMALL, COLUMNS = "urn:domain:10", 300, 2
PLACED = "urn:domain:19"


def on():
    """The switches, read again: this runs longer than the flags' cache lives."""
    flags(searchViewsEnabled=True, viewMembershipEnabled=True)


@pytest_asyncio.fixture()
async def live(db_session, test_client):
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.db.models import ViewORM
    from backend.app.db.repositories import view_members_repo, view_membership_repo
    from backend.app.main import app
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"search_list_views_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    nodes, _edges = _graph()
    big = sorted(u for u, d in nodes.items() if d in BIG_DOMAINS)
    small = sorted(u for u, d in nodes.items() if d == SMALL_DOMAIN)[:SMALL]
    columns = {f"{u}/col{j}": u for u in small for j in range(COLUMNS)}
    for label in ("Domain", "Dataset", "Column"):
        await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
    await p._graph.query("UNWIND $rows AS r CREATE (:Domain {urn: r, displayName: r})",
                         {"rows": sorted(set(nodes.values()))})
    rows = [{"urn": u, "dom": d} for u, d in nodes.items()]
    for i in range(0, len(rows), 5000):
        await p._graph.query(
            "UNWIND $rows AS r MATCH (d:Domain {urn: r.dom}) "
            "CREATE (d)-[:CONTAINS]->(:Dataset {urn: r.urn, displayName: r.urn})", {"rows": rows[i:i + 5000]})
    await p._graph.query(
        "UNWIND $rows AS r MATCH (t:Dataset {urn: r.t}) "
        "CREATE (t)-[:CONTAINS]->(:Column {urn: r.c, displayName: r.c})",
        {"rows": [{"c": c, "t": t} for c, t in columns.items()]})

    engine = ViewEngine(p)
    engine._db_session = db_session

    async def _engine():
        return engine

    app.dependency_overrides[get_context_engine] = _engine
    ws = await workspace(test_client, "Search list views")
    base = ViewORM(name="Everything they reach", workspace_id=ws, view_type="reference", visibility="workspace",
                   config=json.dumps({
                       "layoutType": "reference", "content": {"entityScope": "curated", "visibleEntityTypes": []},
                       "layout": {"type": "reference", "referenceLayout": {"layers": [
                           {"id": "big", "name": "Big", "order": 0}, {"id": "small", "name": "Small", "order": 1}],
                           "assignments": {PLACED: {"layerId": "small", "inheritsChildren": False,
                                                    "assignedBy": "user"}}}},
                       "membership": {"v": 1, "mode": "live", "layout": {"kind": "stages", "nest": False},
                                      "sources": [{"spec": {"seeds": {"urns": ["urn:seed:0"]}}}]}}))
    db_session.add(base)
    await db_session.flush()
    state = await view_membership_repo.ensure(db_session, base)
    await view_members_repo.insert(db_session, [
        {"view_id": base.id, "epoch": 1, "urn": urn, "layer_id": layer, "sort_key": view_members_repo.sort_key(urn, urn),
         "ord": i, "label": "Dataset", "label_ord": i, "whole": False, "covered": False}
        for i, (urn, layer) in enumerate([(u, "big") for u in big] + [(u, "small") for u in small])])
    state.epoch = state.members_epoch = 1
    state.member_count = len(big) + len(small)
    sub = ViewORM(name="All of it", workspace_id=ws, view_type="reference", visibility="workspace",
                  config=json.dumps({
                      "layoutType": "reference", "content": {"entityScope": "all"},
                      "layout": {"referenceLayout": {"layers": [], "assignments": {}}},
                      "search": {"v": 1, "predicate": {"kind": "all"}, "within": "view", "readIn": base.id,
                                 "layout": "inherit"}}))
    db_session.add(sub)
    await db_session.commit()
    try:
        yield {"ws": ws, "base": base.id, "sub": sub.id, "nodes": nodes, "big": big, "small": small,
               "columns": columns}
    finally:
        app.dependency_overrides.pop(get_context_engine, None)
        await p._graph.delete()


async def _layer(client: AsyncClient, ws: str, view_id: str, layer: str, *, limit: int = 1000):
    """Every row of a subset's layer, page by page (a running scan followed by its
    session), with the last page and the slowest page's seconds."""
    rows, cursor, session, last, slowest, asks = [], None, None, None, 0.0, 0
    while True:
        asks += 1
        assert asks < 500
        on()
        started = time.monotonic()
        resp = await client.post(f"/api/v1/{ws}/graph/search/view-feed", params={"viewId": view_id}, json={
            "layerId": layer, "limit": limit, "waitMs": 5000,
            **({"cursor": cursor} if cursor else {}), **({"sessionId": session} if session else {})})
        slowest = max(slowest, time.monotonic() - started)
        assert resp.status_code == 200, resp.text
        last = resp.json()
        if last["status"] == "running":
            session = last["sessionId"]
            continue
        session = None
        rows += last["nodes"]
        assert not last["capped"], "no ceiling by default"
        if last["cursor"] is None:
            return rows, last, slowest
        assert last["countStatus"] == "lowerBound", "a count read so far until the layer's end"
        cursor = last["cursor"]


async def test_a_subset_of_a_list_view_lists_each_layers_members(test_client: AsyncClient, live):
    ws, sub, nodes = live["ws"], live["sub"], live["nodes"]
    big, small, columns = set(live["big"]), set(live["small"]), live["columns"]
    assert len(big) > 5000, "past the root cap, and past a scan's session"

    started = time.monotonic()
    rows, last, slowest = await _layer(test_client, ws, sub, "big")
    urns = [n["urn"] for n in rows]
    assert set(urns) == big and len(urns) == len(big), "its members, each once"
    assert urns == sorted(urns), "name order, across every scan"
    assert (last["totalCount"], last["countStatus"], last["delivered"]) == (len(big), "exact", len(big))
    print(f"Big: {len(urns):,} rows in {time.monotonic() - started:.1f} s, slowest page {slowest:.2f} s")

    started = time.monotonic()
    rows, last, _slowest = await _layer(test_client, ws, sub, "small")
    found = {n["urn"]: n for n in rows}
    assert set(found) == small | set(columns) | {PLACED}, "its members, what is inside them, its entry"
    assert all(found[c].get("inLayer", 0) >= 1 for c in columns), "drawn under their member"
    assert (last["totalCount"], last["countStatus"]) == (len(small) + len(columns) + 1, "exact")
    print(f"Small: {len(rows):,} rows in {time.monotonic() - started:.1f} s")

    started = time.monotonic()
    rows, last, _slowest = await _layer(test_client, ws, sub, REST_LAYER_ID)
    other = {n["urn"] for n in rows}
    placed_by_hand = {u for u, d in nodes.items() if d == PLACED}
    assert other == placed_by_hand and not other & (big | small), "what no member places, and no member"
    assert (last["totalCount"], last["countStatus"]) == (len(placed_by_hand), "exact")
    print(f"Other matches: {len(other):,} rows in {time.monotonic() - started:.1f} s")


async def test_search_in_a_list_view_past_the_root_cap(test_client: AsyncClient, live):
    ws, base, nodes = live["ws"], live["base"], live["nodes"]
    big, small = live["big"], live["small"]

    # The catalog: its members where they are kept, and the domain placed by hand with
    # everything inside it — never refused for its size.
    started, session, asks = time.monotonic(), None, 0
    while True:
        asks += 1
        assert asks < 200
        on()
        resp = await test_client.post(f"/api/v1/{ws}/graph/search/catalog", json={
            "scope": {"viewId": base}, "waitMs": 5000, **({"sessionId": session} if session else {})})
        assert resp.status_code == 200, resp.text
        catalog = resp.json()
        if catalog["status"] == "complete":
            break
        session = catalog["sessionId"]
    inside_placed = sum(1 for d in nodes.values() if d == PLACED)
    assert catalog["entities"] == len(big) + len(small) + 1 + inside_placed
    print(f"catalog of {catalog['entities']:,} entities in {time.monotonic() - started:.1f} s")

    # A search filtered to a layer, tallying what its matches sit in; then any container's count.
    started, session, asks = time.monotonic(), None, 0
    while True:
        asks += 1
        assert asks < 200
        on()
        resp = await test_client.post(f"/api/v1/{ws}/graph/search/advanced", json={
            "predicate": {"kind": "layer", "layerAssignment": "Big"},
            "scope": {"viewId": base, "scopeMode": "view"},
            "options": {"results": "both", "aggregations": [{"by": "ancestor"}], "pageSize": 50,
                        "waitMs": 5000, **({"sessionId": session} if session else {})}})
        assert resp.status_code == 200, resp.text
        page = resp.json()
        session = page["sessionId"]
        if page["status"] != "running":
            break
    assert page["totalCount"] == len(big)
    resp = await test_client.post(f"/api/v1/{ws}/graph/search/ancestor-counts", json={
        "scope": {"viewId": base}, "sessionId": session, "urns": list(BIG_DOMAINS)})
    assert resp.status_code == 200, resp.text
    counts = resp.json()
    assert counts["status"] == "complete", "read from the layer's own search"
    assert {u: counts["counts"][u]["count"] for u in BIG_DOMAINS} == {
        d: sum(1 for u in big if nodes[u] == d) for d in BIG_DOMAINS}
    print(f"layer search and its ancestor counts in {time.monotonic() - started:.1f} s")
