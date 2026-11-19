"""LIVE FalkorDB: a view of everything twenty seeds reach — fifty thousand members —
made, opened and paged through the app's own routes.

The member-set test (``test_member_sets_live.py``) pins the resolution; this pins
what a person gets from it: Save as view answers 202 while the set is worked out
and makes the view once it is, after a short first turn; every answer, and each turn
that carries the view on, comes well inside the tier a request is cut off at; the
view holds every member exactly once, its own record stays small however many members
it has (they are in their own table, never its layout), and each layer of it pages
its members in name order, every one exactly once, with exact counts.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_member_views_live.py -q
"""
from __future__ import annotations

import os
import time
import uuid
from contextlib import asynccontextmanager

import pytest
import pytest_asyncio
from httpx import AsyncClient

from backend.tests.integration.test_member_sets_live import LINEAGE, SEEDS, LiveEngine, _expected, _graph
from backend.tests.test_views_from_members_api import flags, membership_on, workspace  # noqa: F401 — fixtures


def on():
    """The switches, read again: this runs longer than the flags' cache lives, and a
    re-read here would reach for the real database."""
    flags(viewMembershipEnabled=True, traceEnabled=True)

pytestmark = pytest.mark.skipif(
    os.getenv("RUN_FALKOR_LIVE") != "1",
    reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live test.",
)


class ViewEngine(LiveEngine):
    """The live graph as a view's pipeline and feed read it: nodes typed, chains read."""

    async def get_ancestor_chains(self, urns):
        return await self.provider.get_ancestor_chains(list(urns))


@pytest_asyncio.fixture()
async def live(db_session):
    from backend.app.api.v1.endpoints import view_membership as routes
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"member_views_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    nodes, edges = _graph()
    await p._graph.query("CREATE INDEX FOR (n:Domain) ON (n.urn)")
    await p._graph.query("CREATE INDEX FOR (n:Dataset) ON (n.urn)")
    await p._graph.query("UNWIND $rows AS r CREATE (:Domain {urn: r, displayName: r})",
                         {"rows": sorted(set(nodes.values()))})
    rows = [{"urn": u, "dom": d} for u, d in nodes.items()]
    for i in range(0, len(rows), 5000):
        await p._graph.query(
            "UNWIND $rows AS r MATCH (d:Domain {urn: r.dom}) "
            "CREATE (d)-[:CONTAINS]->(:Dataset {urn: r.urn, displayName: r.urn})", {"rows": rows[i:i + 5000]})
    pairs = [{"a": a, "b": b} for a, b in edges]
    for i in range(0, len(pairs), 5000):
        await p._graph.query(
            f"UNWIND $rows AS r MATCH (a:Dataset {{urn: r.a}}), (b:Dataset {{urn: r.b}}) "
            f"CREATE (a)-[:{LINEAGE}]->(b)", {"rows": pairs[i:i + 5000]})

    engine = ViewEngine(p)
    engine._db_session = db_session

    @asynccontextmanager
    async def scope(workspace_id, data_source_id, actor):
        yield engine

    async def _engine():
        return engine

    app.dependency_overrides[routes.get_engine_scope] = lambda: scope
    app.dependency_overrides[get_context_engine] = _engine
    try:
        yield nodes, edges
    finally:
        app.dependency_overrides.pop(routes.get_engine_scope, None)
        app.dependency_overrides.pop(get_context_engine, None)
        await p._graph.delete()


async def test_a_view_of_fifty_thousand_members(
    test_client: AsyncClient, db_session, membership_on, live,  # noqa: F811
):
    from sqlalchemy import select

    from backend.app.db.models import ViewMemberORM, ViewMembershipStateORM

    nodes, edges = live
    up, down = _expected(nodes, edges)
    members = SEEDS + len(up) + len(down)
    ws = await workspace(test_client)
    seeds = [f"urn:seed:{s}" for s in range(SEEDS)]
    body = {
        "name": "Everything twenty tables reach", "workspaceId": ws, "visibility": "private", "mode": "live",
        "sources": [{"spec": {"seeds": {"urns": seeds}, "expand": {"upstream": "all", "downstream": "all"}}}],
        "layout": {"kind": "stages", "nest": False}, "keep": "withResults",
        "provenance": {"origin": "trace"}, "waitMs": 5000,
    }

    # Save as view: 202 with progress until the set is worked out, then the view.
    started, asks, resolving, answers = time.monotonic(), 0, 0, []
    while True:
        asks += 1
        assert asks < 200
        on()
        asked = time.monotonic()
        resp = await test_client.post("/api/v1/views/from-members", json=body, headers={"Idempotency-Key": "live-1"})
        answers.append(time.monotonic() - asked)
        assert answers[-1] < 25, "every answer well inside the 30 s a /views request is cut off at"
        if resp.status_code == 202:
            resolving += 1
            assert resp.json()["status"] == "resolving"
            continue
        break
    assert resp.status_code == 201, resp.text
    made = resp.json()
    view_id = made["view"]["id"]
    assert made["membership"]["status"] == "updating", "fifty thousand members are more than one short turn"
    first = made["membership"]["detail"]
    assert (first["reason"], first["members"]) == ("placing", members) and 0 < first["placed"] < members

    # Saved again (its sets resolved, shared): the answer is a short first turn's.
    on()
    asked = time.monotonic()
    again = await test_client.post("/api/v1/views/from-members", json=body, headers={"Idempotency-Key": "live-2"})
    saved_in = time.monotonic() - asked
    assert again.status_code == 201, again.text
    assert saved_in < 8, f"saving took {saved_in:.1f} s"

    # Placing members outlasts the request: opening the view carries it on, a turn at a time.
    turns = []
    for _ in range(200):
        on()
        got = await test_client.get(f"/api/v1/views/{view_id}/membership")
        assert got.status_code == 200, got.text
        status = got.json()
        if status["status"] in ("ok", "partial"):
            break
        asked = time.monotonic()
        out = await test_client.post(f"/api/v1/views/{view_id}/membership/refresh", params={"trigger": "open"})
        turns.append(time.monotonic() - asked)
        assert out.status_code in (200, 202), out.text
        assert turns[-1] < 25, f"a turn took {turns[-1]:.1f} s"
    assert status["status"] == "ok", status
    assert status["counts"]["members"] == members
    elapsed = time.monotonic() - started
    epoch = (await db_session.execute(select(ViewMembershipStateORM.members_epoch).where(
        ViewMembershipStateORM.view_id == view_id))).scalar_one()
    placed = (await db_session.execute(select(ViewMemberORM.urn).where(
        ViewMemberORM.view_id == view_id, ViewMemberORM.epoch == epoch))).scalars().all()
    assert len(placed) == members and set(placed) == set(seeds) | set(up) | set(down), "every member, once"
    print(f"\nanswers to Save as view: {', '.join(f'{t:.1f}' for t in answers)} s (the last made it: "
          f"{first['placed']:,} of {members:,} placed); saved again in {saved_in:.1f} s; "
          f"turns to finish: {', '.join(f'{t:.1f}' for t in turns)} s")

    # The view's own record stays small: its members are not in its layout.
    view = await test_client.get(f"/api/v1/views/{view_id}")
    assert len(view.content) < 50_000
    listing = await test_client.get("/api/v1/views/", params={"workspaceId": ws})
    assert len(listing.content) < 100_000

    # Each layer pages its members in name order, every one once, its count exact.
    seen, pages, fed, totals = set(), 0, {}, {}
    for layer in view.json()["config"]["layout"]["referenceLayout"]["layers"]:
        cursor, names = None, []
        while True:
            pages += 1
            on()
            page = (await test_client.post(f"/api/v1/{ws}/graph/view-members", params={"viewId": view_id},
                                           json={"layerId": layer["id"], **({"cursor": cursor} if cursor else {}),
                                                 "limit": 500})).json()
            names += [n["displayName"] for n in page["nodes"]]
            for n in page["nodes"]:
                assert n["urn"] not in seen
                seen.add(n["urn"])
                fed[n["urn"]] = layer["id"]
            cursor = page.get("cursor")
            if not cursor:
                break
        assert names == sorted(names, key=lambda s: (s.lower(), s)) or len(names) == 0
        assert page["countStatus"] == "exact"
        assert len(names) == min(page["totalCount"], 5000)
        totals[layer["id"]] = page["totalCount"]
    print(f"\n{members:,} members: {resolving} answers of 202, view ready in {elapsed:.1f} s, "
          f"{len(seen):,} listed across {pages} pages (each layer lists up to 5,000)")

    # A trace over it: its cards placed where the view draws them — members in the layer
    # their feed lists them in, what it doesn't hold (the domains around them) in its
    # fallback layer: a stage holds only what the view does.
    sample = sorted(fed)[:1700]
    domains = sorted(set(nodes.values()))[:299]
    on()
    started = time.monotonic()
    placed = await test_client.post(f"/api/v1/{ws}/graph/view-placements", params={"viewId": view_id},
                                    json={"urns": [*sample, *domains, "urn:nowhere"]})
    took = time.monotonic() - started
    assert placed.status_code == 200, placed.text
    where = placed.json()["placements"]
    assert len(where) == len(sample) + len(domains) + 1
    assert all(where[u] == {"layerId": fed[u], "source": "member"} for u in sample)
    waiting = view.json()["config"]["membership"]["layout"].get("fallbackLayerId")
    outside = {"layerId": waiting, "source": "fallback"} if waiting else {"layerId": None, "source": "none"}
    assert all(where[u] == outside for u in [*domains, "urn:nowhere"]), [where[u] for u in domains[:3]]
    print(f"placements of {len(where):,} entities in {took * 1000:.0f} ms")

    # A layer filter finds exactly that layer: one listed among the search's roots, and one
    # too large to list, read where its members are kept.
    async def layer_search(layer_id: str) -> tuple:
        found, session, asks = set(), None, 0
        while True:
            asks += 1
            assert asks < 400
            on()
            resp = await test_client.post(f"/api/v1/{ws}/graph/search/advanced", json={
                "predicate": {"kind": "layer", "layerAssignment": layer_id},
                "scope": {"viewId": view_id, "scopeMode": "view"},
                "options": {"results": "hits", "pageSize": 500, "waitMs": 5000,
                            **({"sessionId": session} if session else {})}})
            assert resp.status_code == 200, resp.text
            page = resp.json()
            if page.get("status") != "running":
                break
            session = page["sessionId"]
        found = {h["node"]["urn"] for h in page["hits"] or []}
        return found, page["totalCount"]

    small = min((l for l in totals if totals[l]), key=lambda l: totals[l])
    started = time.monotonic()
    found, total = await layer_search(small)
    assert total == totals[small] and found == {u for u, l in fed.items() if l == small}, (small, total)
    large = max(totals, key=lambda l: totals[l])
    assert totals[large] > 5000, "past the root cap: read where its members are kept"
    found, total = await layer_search(large)
    assert total == totals[large] and found <= {u for u, l in fed.items() if l == large} | set(nodes)
    print(f"layer filters: {small} {totals[small]:,} and {large} {totals[large]:,} members, exactly, "
          f"in {time.monotonic() - started:.1f} s")


async def test_a_trace_saved_as_a_subset_that_follows_its_view(test_client: AsyncClient, membership_on, live):  # noqa: F811
    """Save as view from a trace, as the sheet does by default: the new view follows the
    view it was traced in — its layers served from there, live, and each member drawn
    inside the containers that view draws in the same layer."""
    nodes, edges = live
    ws = await workspace(test_client)
    base = await test_client.post("/api/v1/views/", json={
        "name": "Lineage base", "workspaceId": ws, "viewType": "reference", "visibility": "private",
        "config": {"layout": {"type": "reference", "referenceLayout": {"layers": [
            {"id": "b_data", "name": "Data", "order": 0, "entityTypes": ["domain", "dataset"]},
        ], "assignments": {}}}, "content": {"entityScope": "all"}},
    })
    assert base.status_code == 201, base.text
    base_id = base.json()["id"]
    seeds = ["urn:seed:0", "urn:seed:1"]
    spec = {"seeds": {"urns": seeds}, "expand": {"upstream": 0, "downstream": "all"}}
    layout = {"kind": "follow", "sourceViewId": base_id, "nest": True}

    # The preview, as the sheet asks it: no wait sent, the base's layers in the answer.
    for _ in range(100):
        on()
        plan = await test_client.post(f"/api/v1/{ws}/graph/members/plan", params={"viewId": base_id},
                                      json={"sources": [{"spec": spec}], "layout": layout, "keep": "all"})
        if plan.status_code != 202:
            break
    assert plan.status_code == 200, plan.text
    assert [l["name"] for l in plan.json()["layers"]][:1] == ["Data"]
    reached = {u for u in nodes if any(u == s or u.startswith(f"urn:d:{s[-1]}:") for s in seeds)}
    assert plan.json()["members"] >= len(reached) - len(seeds)

    body = {"name": "Two tables, downstream", "workspaceId": ws, "visibility": "private", "mode": "live",
            "sources": [{"spec": spec}], "layout": layout, "provenance": {"origin": "trace", "viewId": base_id}}
    for _ in range(100):
        on()
        made = await test_client.post("/api/v1/views/from-members", json=body, headers={"Idempotency-Key": "live-follow"})
        if made.status_code != 202:
            break
    assert made.status_code == 201, made.text
    view_id = made.json()["view"]["id"]
    for _ in range(100):
        on()
        status = (await test_client.get(f"/api/v1/views/{view_id}/membership")).json()
        if status["status"] in ("ok", "partial"):
            break
        await test_client.post(f"/api/v1/views/{view_id}/membership/refresh", params={"trigger": "open"})
    assert status["status"] == "ok", status
    assert status["follows"] == {"viewId": base_id, "name": "Lineage base", "available": True}

    # Its layers are the base's, as they are there now.
    async def layers():
        on()
        got = await test_client.get(f"/api/v1/views/{view_id}")
        return [(l["id"], l["name"]) for l in got.json()["config"]["layout"]["referenceLayout"]["layers"]]
    assert (await layers())[0] == ("b_data", "Data")
    await test_client.put(f"/api/v1/views/{base_id}/layout", json={"referenceLayout": {"layers": [
        {"id": "b_data", "name": "Everything they feed", "order": 0, "entityTypes": ["domain", "dataset"]},
    ], "assignments": {}}})
    assert (await layers())[0] == ("b_data", "Everything they feed")

    # Each member sits inside its domain, drawn in the same layer.
    on()
    page = (await test_client.post(f"/api/v1/{ws}/graph/view-members", params={"viewId": view_id},
                                   json={"layerId": "b_data", "limit": 500})).json()
    assert page["nodes"], page
    for n in page["nodes"]:
        assert n.get("inLayer") == 1, n
        assert [a["urn"] for a in n["ancestorPath"]] == [nodes[n["urn"]]], n

    # The base lists it among its subsets.
    on()
    subsets = (await test_client.get(f"/api/v1/views/{base_id}/subsets")).json()
    assert any(i["viewId"] == view_id and i["layout"] == "inherit" for i in subsets["items"]), subsets
    print(f"\nfollowing view: {status['counts']['members']:,} members, every one inside its domain")
