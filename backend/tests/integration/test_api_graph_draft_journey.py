"""HTTP e2e of the draft journey over the real ``/graph`` + ``/versioning`` routers (Postgres).

This is the frontend-facing seam the provider/engine tests don't cover: it drives the *actual
HTTP endpoints* end to end — create a versioned graph, import an existing one (ndjson), open a
draft, edit it through the normal graph endpoints with ``?branchId=``, read-your-writes, and
publish — proving branchId flows through ``get_context_engine`` → ``for_workspace`` → provider
selection → (de)serialization, and that a draft is isolated from main until published.

Postgres-only, no FalkorDB/Redis: the live ``main`` provider is an empty stub (the draft path is
pure Postgres and never queries it) and the read cache is stubbed (writes only call
``bump_generation``). Main reads here therefore go through the empty stub — so published state is
verified via the versioning ``/state`` endpoint (the full-stack guide verifies it through
``/graph`` after FalkorDB projection). Gated by ``GRAPHVER_E2E=1`` + a reachable Postgres.
"""
import asyncio
import json
import os
from types import SimpleNamespace

import pytest

from backend.app.services.versioning import db, models


class _StubLiveProvider:
    """Stands in for the FalkorDB 'main' provider — empty; the draft path never queries it."""
    name = "stub-live"

    async def get_nodes(self, query=None):
        return []

    async def get_edges(self, query=None):
        return []

    async def get_node(self, urn):
        return None

    async def search_nodes(self, query, limit: int = 10, offset: int = 0):
        return []

    async def get_ontology_metadata(self):
        raise NotImplementedError


class _StubManager:
    async def get_provider_for_workspace(self, workspace_id, session, data_source_id=None):
        return _StubLiveProvider()


class _StubCache:
    async def bump_generation(self, scope):
        return None


def _build_app():
    from fastapi import FastAPI, Request
    import backend.app.auth.dependencies as deps
    from backend.app.auth.dependencies import (
        get_current_user, get_optional_user, get_permission_claims,
    )
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.db.engine import get_db_session
    from backend.app.api.v1.endpoints import versioning as V
    from backend.app.api.v1.endpoints import graph as G

    # No Redis in the test env: neutralise the revocation lookup (claims carry an empty sid).
    deps.get_revocation_service = lambda: SimpleNamespace(is_revoked=lambda sid: False)

    async def fake_user():
        return SimpleNamespace(id="u_test", email="t@example.com")

    async def fake_claims(request: Request):
        ws = request.path_params.get("ws_id") or "ws1"
        return PermissionClaims(
            sid="", global_perms=(),
            ws_perms={ws: ("workspace:datasource:read", "workspace:datasource:manage")})

    async def fake_db():
        # for_workspace only uses this session for ontology resolution (degrades gracefully
        # when the management ontology tables are absent); the draft path uses the versioning
        # service's own sessions.
        async with db.graphver_session() as s:
            yield s

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.include_router(G.router, prefix="/api/v1/{ws_id}/graph")
    app.dependency_overrides[get_current_user] = fake_user
    app.dependency_overrides[get_optional_user] = fake_user
    app.dependency_overrides[get_permission_claims] = fake_claims
    app.dependency_overrides[get_db_session] = fake_db
    return app, G


# An "existing graph" to import: a Domain containing a Table, on main.
_IMPORT_NDJSON = "\n".join(json.dumps(r) for r in [
    {"kind": "node", "id": "urn:t:root", "urn": "urn:t:root", "entityType": "Domain", "displayName": "Imported Root"},
    {"kind": "node", "id": "urn:t:child", "urn": "urn:t:child", "entityType": "Table", "displayName": "Imported Child"},
    {"kind": "edge", "id": "e_root_child", "edgeType": "CONTAINS", "source": "urn:t:root", "target": "urn:t:child"},
])


async def _run() -> None:
    from httpx import ASGITransport, AsyncClient

    await models.create_schema_and_partitions()
    app, G = _build_app()
    orig_pm, orig_cache = G.provider_manager, G.get_graph_cache
    G.provider_manager = _StubManager()
    G.get_graph_cache = lambda: _StubCache()

    ds = "ds_" + os.urandom(4).hex()
    V1, GP = "/api/v1/ws1/versioning", "/api/v1/ws1/graph"
    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            # 1. create a versioned graph for the data source
            r = await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"})
            assert r.status_code == 201, r.text
            gid, main_id = r.json()["graphId"], r.json()["mainBranchId"]

            # 2. IMPORT an existing graph (ndjson → one import commit on main)
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_IMPORT_NDJSON)
            assert r.status_code == 200, r.text
            assert r.json()["ingested"] == 3, r.text          # 2 nodes + 1 edge

            # 3. open a draft
            draft = (await c.post(f"{V1}/graphs/{gid}/branches", json={})).json()["branchId"]

            # 4. EDIT on the draft through the NORMAL graph endpoints (the cohesion proof)
            qd = {"dataSourceId": ds, "branchId": draft}
            r = await c.post(f"{GP}/nodes/create", params=qd, json={
                "entityType": "Table", "displayName": "Draft Node", "parentUrn": "urn:t:root"})
            assert r.status_code == 200 and r.json()["success"] is True, r.text
            new_urn = r.json()["node"]["urn"]
            r = await c.post(f"{GP}/edges", params=qd, json={
                "sourceUrn": "urn:t:child", "targetUrn": new_urn, "edgeType": "LINEAGE"})
            assert r.status_code == 201, r.text

            # 5. read-your-writes on the draft (uncached endpoints — no Redis needed)
            nodes = (await c.post(f"{GP}/nodes/query", params=qd, json={"query": {}})).json()
            assert {"urn:t:root", "urn:t:child", new_urn} <= {n["urn"] for n in nodes}
            edges = (await c.post(f"{GP}/edges/query", params=qd, json={"query": {}})).json()
            assert any(e["edgeType"] == "LINEAGE" for e in edges), edges

            # 5b. UI-shaped diff of the draft vs its base — the added node + edges come back
            #     as whole payloads (what the canvas overlay / Changes panel render).
            dvm = (await c.get(f"{V1}/graphs/{gid}/branches/{draft}/diff-vs-main")).json()
            added_nodes = [e for e in dvm["added"] if e["kind"] == "node"]
            added_edges = [e for e in dvm["added"] if e["kind"] == "edge"]
            assert any(e["after"]["urn"] == new_urn for e in added_nodes), dvm
            assert any(e["after"].get("edgeType") == "LINEAGE" for e in added_edges), dvm
            assert dvm["removed"] == [] and dvm["modified"] == [], dvm

            # 5c. ATOMIC draft save via POST /graph/changes — create + partial-merge update
            #     in one commit. The update sends ONLY displayName; the server must merge
            #     it onto current state (entityType must survive — full-replace would clobber it).
            batch = {"ops": [
                {"op": "create", "kind": "node", "id": "urn:t:batch", "ref": "tmp1",
                 "payload": {"urn": "urn:t:batch", "entityType": "Table", "displayName": "Batch Node"}},
                {"op": "update", "kind": "node", "id": "urn:t:child",
                 "payload": {"displayName": "Child v2"}},
            ], "message": "batch edit"}
            r = await c.post(f"{GP}/changes", params={"dataSourceId": ds, "branchId": draft}, json=batch)
            assert r.status_code == 200, r.text
            assert r.json()["commitId"], r.text
            assert r.json()["assigned"].get("tmp1") == "urn:t:batch", r.json()
            st_b = (await c.get(f"{V1}/graphs/{gid}/branches/{draft}/state")).json()["nodes"]
            assert "urn:t:batch" in st_b, list(st_b)
            assert st_b["urn:t:child"]["displayName"] == "Child v2", st_b["urn:t:child"]
            assert st_b["urn:t:child"]["entityType"] == "Table", st_b["urn:t:child"]  # merge kept it

            # 6. routing isolation: the same read on MAIN (no branchId) hits the live stub (empty)
            main_nodes = (await c.post(f"{GP}/nodes/query", params={"dataSourceId": ds}, json={"query": {}})).json()
            assert {n["urn"] for n in main_nodes} == set(), main_nodes

            # 7. store isolation: versioning main state has the import but NOT the draft node yet
            st = (await c.get(f"{V1}/graphs/{gid}/branches/{main_id}/state")).json()
            assert "urn:t:root" in st["nodes"] and new_urn not in st["nodes"]

            # 8. unknown branch on a versioned graph → 404
            bad = await c.post(f"{GP}/nodes/query",
                               params={"dataSourceId": ds, "branchId": "br_bogus"}, json={"query": {}})
            assert bad.status_code == 404, bad.text

            # 9. publish the draft → main (squashes the apply_ops commits the graph writes made)
            r = await c.post(f"{V1}/graphs/{gid}/branches/{draft}/publish", json={"message": "publish draft"})
            assert r.status_code == 200, r.text

            # 10. main now carries the imported graph + the draft edit
            st2 = (await c.get(f"{V1}/graphs/{gid}/branches/{main_id}/state")).json()
            assert {"urn:t:root", "urn:t:child", new_urn} <= set(st2["nodes"])
    finally:
        G.provider_manager, G.get_graph_cache = orig_pm, orig_cache
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_api_graph_draft_journey_e2e():
    asyncio.run(_run())


def _large_rows(n_nodes: int, n_edges: int) -> list:
    """A graph big enough that one commit's edge INSERT exceeds the bind-param cap
    unless batches are sized by column count (17 cols × 5000 = 85k)."""
    rows = [{"kind": "node", "id": f"urn:n:{i}", "urn": f"urn:n:{i}",
             "entityType": "Table", "displayName": f"N{i}"} for i in range(n_nodes)]
    for k in range(n_edges):
        a, b = k % n_nodes, (k * 7 + 1) % n_nodes
        if a == b:
            b = (b + 1) % n_nodes
        rows.append({"kind": "edge", "id": f"e_{k}", "edgeType": "LINEAGE",
                     "source": f"urn:n:{a}", "target": f"urn:n:{b}"})
    return rows


def _large_ndjson(n_nodes: int, n_edges: int) -> str:
    return "\n".join(json.dumps(r) for r in _large_rows(n_nodes, n_edges))


async def _run_bulk_param_limit() -> None:
    from httpx import ASGITransport, AsyncClient
    await models.create_schema_and_partitions()
    app, _G = _build_app()
    ds = "ds_" + os.urandom(4).hex()
    V1 = "/api/v1/ws1/versioning"
    try:
        c = AsyncClient(transport=ASGITransport(app=app), base_url="http://test")
        async with c:
            gid = (await c.post(f"{V1}/graphs", json={"dataSourceId": ds, "workspaceId": "ws1"})).json()["graphId"]
            # 100 nodes + 5000 edges in ONE commit → 5000×17 = 85k params if unchunked.
            r = await c.post(f"{V1}/graphs/{gid}/bulk-ingest", content=_large_ndjson(100, 5000))
            assert r.status_code == 200, r.text
            assert r.json()["ingested"] == 5100, r.json()
    finally:
        await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_bulk_ingest_respects_pg_param_limit():
    asyncio.run(_run_bulk_param_limit())


async def _run_ingest_atomic_across_chunks() -> None:
    """A failure AFTER the chunked inserts (here: during the Merkle update) must roll
    back the WHOLE commit — every insert chunk, the commit row, the head bump. No
    partial state is left behind."""
    from backend.app.services.versioning.service import GraphVersioningService
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()
    gid = (await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u"))["graph_id"]

    orig = svc._commit_merkle
    async def _boom(*a, **k):  # fails after _bulk_insert_versions has run its chunks
        raise RuntimeError("injected mid-commit failure")
    svc._commit_merkle = _boom  # type: ignore[assignment]
    raised = False
    try:
        await svc.bulk_ingest(graph_id=gid, rows=_large_rows(100, 5000), actor="u")
    except RuntimeError:
        raised = True
    finally:
        svc._commit_merkle = orig  # type: ignore[assignment]

    assert raised, "ingest should have raised"
    # Whole commit rolled back: main is still at genesis (seq 1), nothing imported.
    assert (await svc.get_graph(gid))["main_head_commit_seq"] == 1
    log = await svc.commit_log(graph_id=gid)
    assert all(c["kind"] != "import" for c in log), log
    # A clean retry (no injected failure) then fully succeeds.
    rep = await svc.bulk_ingest(graph_id=gid, rows=_large_rows(100, 5000), actor="u")
    assert rep["ingested"] == 5100, rep
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_ingest_atomic_across_chunks():
    asyncio.run(_run_ingest_atomic_across_chunks())


async def _run_bootstrap_create_and_seed_atomic() -> None:
    """create-graph + seed share ONE transaction, so a seed failure also rolls back the
    graph creation — never a half-enabled (graph-exists-but-empty) state."""
    from backend.app.services.versioning.service import GraphVersioningService
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    ds = "ds_" + os.urandom(4).hex()

    orig = svc._commit_merkle
    async def _boom(*a, **k):
        raise RuntimeError("injected seed failure")
    svc._commit_merkle = _boom  # type: ignore[assignment]
    raised = False
    try:
        async with svc._session() as s:  # mirrors the bootstrap endpoint's atomic scope
            gid = (await svc.create_graph(
                data_source_id=ds, workspace_id="ws1", actor="u", session=s))["graph_id"]
            await svc.bulk_ingest(
                graph_id=gid, rows=_large_rows(10, 20), actor="u",
                idempotency_key=f"bootstrap:{gid}", session=s)
    except RuntimeError:
        raised = True
    finally:
        svc._commit_merkle = orig  # type: ignore[assignment]

    assert raised, "seed should have raised"
    # The graph creation rolled back with the failed seed — no half-enabled graph.
    assert await svc.get_graph_by_data_source(ds) is None
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_bootstrap_create_and_seed_atomic():
    asyncio.run(_run_bootstrap_create_and_seed_atomic())


# Domain → Dataset → Table → Column via a CUSTOM containment edge type ("OWNS", not the
# literal "CONTAINS" — proving the cascade is ontology-driven, not hardcoded), plus an
# outgoing lineage edge (col→out) and an incoming one (out2→tbl) to prove edge cleanup is
# source-AND-target and that lineage *neighbours* survive (only their edges are cleaned).
_CET = "OWNS"


def _cascade_tree_rows() -> list:
    n = lambda u, t: {"kind": "node", "id": u, "urn": u, "entityType": t, "displayName": u}
    e = lambda i, et, s, t: {"kind": "edge", "id": i, "edgeType": et, "source": s, "target": t}
    return [
        n("urn:dom", "Domain"), n("urn:ds", "Dataset"), n("urn:tbl", "Table"),
        n("urn:col", "Column"), n("urn:out", "Table"), n("urn:out2", "Table"),
        e("e_d_ds", _CET, "urn:dom", "urn:ds"), e("e_ds_t", _CET, "urn:ds", "urn:tbl"),
        e("e_t_c", _CET, "urn:tbl", "urn:col"),
        e("e_lin_out", "LINEAGE", "urn:col", "urn:out"),   # subtree node is the SOURCE
        e("e_lin_in", "LINEAGE", "urn:out2", "urn:tbl"),   # subtree node is the TARGET
    ]


async def _seed_cascade_graph(svc):
    ds = "ds_" + os.urandom(4).hex()
    created = await svc.create_graph(data_source_id=ds, workspace_id="ws1", actor="u")
    await svc.bulk_ingest(graph_id=created["graph_id"], rows=_cascade_tree_rows(), actor="u")
    draft = await svc.open_draft(graph_id=created["graph_id"], owner="u")
    return created["graph_id"], created["main_branch_id"], draft


async def _run_cascade_delete_apply_ops() -> None:
    """Deleting a node removes its whole containment subtree + every incident edge (source or
    target, any type); lineage neighbours survive; the cascade is ontology-driven (custom
    containment type); the draft delete leaves main untouched."""
    from backend.app.services.versioning.service import GraphVersioningService
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid, main_id, draft = await _seed_cascade_graph(svc)

    # Read-only preview == what the commit will do.
    impact = await svc.delete_impact(
        graph_id=gid, branch_id=draft, root_urn="urn:dom", containment_edge_types=[_CET])
    assert {n.get("urn") for n in impact["nodes"]} == {"urn:dom", "urn:ds", "urn:tbl", "urn:col"}, impact
    assert {"e_d_ds", "e_ds_t", "e_t_c", "e_lin_out", "e_lin_in"} <= {e["entityId"] for e in impact["edges"]}

    # Commit the delete on the draft, ontology-driven by the custom containment type.
    await svc.apply_ops(
        graph_id=gid, branch_id=draft, actor="u", containment_edge_types=[_CET],
        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "urn:dom", "payload": None}])

    st = await svc.materialize_state(graph_id=gid, branch_id=draft)
    assert set(st["nodes"]) == {"urn:out", "urn:out2"}, st["nodes"]   # subtree gone, lineage nbrs live
    assert set(st["edges"]) == set(), st["edges"]                     # every incident edge cleaned
    main = await svc.materialize_state(graph_id=gid, branch_id=main_id)
    assert {"urn:dom", "urn:col"} <= set(main["nodes"]), main["nodes"]  # draft-only — main untouched
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_cascade_delete_apply_ops():
    asyncio.run(_run_cascade_delete_apply_ops())


async def _run_cascade_delete_checkpoint() -> None:
    """All-paths: the same parent-delete through the stage+checkpoint path cascades
    identically (not apply_ops-only)."""
    from backend.app.services.versioning.service import GraphVersioningService
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    gid, _main_id, draft = await _seed_cascade_graph(svc)

    await svc.stage_changes(
        graph_id=gid, branch_id=draft, actor="u",
        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "urn:dom"}])
    await svc.checkpoint(graph_id=gid, branch_id=draft, actor="u", containment_edge_types=[_CET])

    st = await svc.materialize_state(graph_id=gid, branch_id=draft)
    assert set(st["nodes"]) == {"urn:out", "urn:out2"}, st["nodes"]
    assert set(st["edges"]) == set(), st["edges"]
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_cascade_delete_checkpoint():
    asyncio.run(_run_cascade_delete_checkpoint())


async def _run_cascade_shared_child() -> None:
    """Multi-parent containment: a child with two parents survives while either parent lives
    (only its edge to the deleted parent is cleaned); it's deleted only once ALL its
    containment parents are gone."""
    from backend.app.services.versioning.service import GraphVersioningService
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    n = lambda u: {"kind": "node", "id": u, "urn": u, "entityType": "T", "displayName": u}
    e = lambda i, s, t: {"kind": "edge", "id": i, "edgeType": _CET, "source": s, "target": t}
    rows = [
        n("urn:p1"), n("urn:p2"), n("urn:shared"), n("urn:only1"),
        e("e_p1_shared", "urn:p1", "urn:shared"),   # shared has TWO containment parents
        e("e_p2_shared", "urn:p2", "urn:shared"),
        e("e_p1_only1", "urn:p1", "urn:only1"),      # only1 has just p1
    ]
    created = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = created["graph_id"]
    await svc.bulk_ingest(graph_id=gid, rows=rows, actor="u")
    draft = await svc.open_draft(graph_id=gid, owner="u")

    # Deleting p1: only1 (sole-parent) cascades; shared SURVIVES (p2 still owns it).
    impact = await svc.delete_impact(graph_id=gid, branch_id=draft, root_urn="urn:p1", containment_edge_types=[_CET])
    assert {x.get("urn") for x in impact["nodes"]} == {"urn:p1", "urn:only1"}, impact
    await svc.apply_ops(
        graph_id=gid, branch_id=draft, actor="u", containment_edge_types=[_CET],
        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "urn:p1", "payload": None}])
    st = await svc.materialize_state(graph_id=gid, branch_id=draft)
    assert {"urn:shared", "urn:p2"} <= set(st["nodes"]), st["nodes"]            # shared kept
    assert "urn:p1" not in st["nodes"] and "urn:only1" not in st["nodes"], st["nodes"]
    assert "e_p1_shared" not in st["edges"] and "e_p2_shared" in st["edges"], st["edges"]  # only p1's edge cleaned

    # Deleting the remaining parent p2: shared now has no surviving parent → it goes.
    await svc.apply_ops(
        graph_id=gid, branch_id=draft, actor="u", containment_edge_types=[_CET],
        ops=[{"op": "delete", "entity_kind": "node", "entity_id": "urn:p2", "payload": None}])
    st2 = await svc.materialize_state(graph_id=gid, branch_id=draft)
    assert "urn:shared" not in st2["nodes"], st2["nodes"]
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_cascade_delete_shared_child():
    asyncio.run(_run_cascade_shared_child())


async def _run_pr_diff_matches_preview() -> None:
    """A draft MR's itemised diff (the review center's Files Changed) classifies the draft's
    add/modify/delete with whole-payload before/after, and its item counts equal the
    preview's change counts (same 3-way computation backs both)."""
    from backend.app.services.versioning.service import GraphVersioningService
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    n = lambda u, name: {"kind": "node", "id": u, "urn": u, "entityType": "T", "displayName": name}
    created = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="u")
    gid = created["graph_id"]
    await svc.bulk_ingest(graph_id=gid, rows=[n("urn:a", "A"), n("urn:b", "B"), n("urn:c", "C")], actor="u")
    draft = await svc.open_draft(graph_id=gid, owner="u")
    await svc.apply_ops(
        graph_id=gid, branch_id=draft, actor="u",
        ops=[
            {"op": "create", "entity_kind": "node", "entity_id": "urn:d", "payload": n("urn:d", "D")},
            {"op": "update", "entity_kind": "node", "entity_id": "urn:a", "payload": n("urn:a", "A2")},
            {"op": "delete", "entity_kind": "node", "entity_id": "urn:c", "payload": None},
        ])
    mr_id = await svc.open_draft_mr(graph_id=gid, branch_id=draft, actor="u")

    diff = await svc.diff_pr(pr_id=mr_id)
    assert {e["entityId"] for e in diff["added"]} == {"urn:d"}, diff
    assert {e["entityId"] for e in diff["modified"]} == {"urn:a"}, diff
    assert {e["entityId"] for e in diff["removed"]} == {"urn:c"}, diff
    assert diff["modified"][0]["before"] and diff["modified"][0]["after"]            # full payloads
    assert diff["modified"][0]["before"] != diff["modified"][0]["after"]            # content changed
    assert diff["removed"][0]["before"]                                             # ghost payload present

    prev = await svc.preview_mr(mr_id=mr_id)
    assert prev["clean"] is True, prev
    assert (len(diff["added"]), len(diff["modified"]), len(diff["removed"])) == (
        prev["changes"]["create"], prev["changes"]["update"], prev["changes"]["delete"]), (diff, prev)
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_pr_diff_matches_preview():
    asyncio.run(_run_pr_diff_matches_preview())


async def _run_pr_metadata() -> None:
    """PR title + description and the raised/merged/closed who-and-when are persisted and
    surfaced on the PR record."""
    from backend.app.services.versioning.service import GraphVersioningService
    await models.create_schema_and_partitions()
    svc = GraphVersioningService()
    n = lambda u, name: {"kind": "node", "id": u, "urn": u, "entityType": "T", "displayName": name}
    created = await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="raiser")
    gid = created["graph_id"]
    await svc.bulk_ingest(graph_id=gid, rows=[n("urn:a", "A")], actor="raiser")

    # Open with title + description (raised by 'raiser'); merge as a different actor.
    d1 = await svc.open_draft(graph_id=gid, owner="raiser")
    await svc.apply_ops(graph_id=gid, branch_id=d1, actor="raiser",
        ops=[{"op": "update", "entity_kind": "node", "entity_id": "urn:a", "payload": n("urn:a", "A2")}])
    mr = await svc.open_draft_mr(graph_id=gid, branch_id=d1, actor="raiser",
                                 title="Rename A", description="Because reasons.")
    meta = await svc.get_pr(mr)
    assert meta["title"] == "Rename A" and meta["description"] == "Because reasons.", meta
    assert meta["actor"] == "raiser" and meta["created_at"], meta          # raised by + when
    assert meta["merged_at"] is None and meta["closed_at"] is None, meta

    await svc.merge_mr(mr_id=mr, actor="merger", message="merge it")
    meta = await svc.get_pr(mr)
    assert meta["status"] == "merged", meta
    assert meta["merged_by"] == "merger" and meta["merged_at"], meta       # merged by + when

    # A second MR, closed (not merged) by someone else.
    d2 = await svc.open_draft(graph_id=gid, owner="raiser")
    await svc.apply_ops(graph_id=gid, branch_id=d2, actor="raiser",
        ops=[{"op": "update", "entity_kind": "node", "entity_id": "urn:a", "payload": n("urn:a", "A3")}])
    mr2 = await svc.open_draft_mr(graph_id=gid, branch_id=d2, actor="raiser", title="Another")
    closed = await svc.close_pr(pr_id=mr2, actor="closer")
    assert closed["status"] == "closed", closed
    assert closed["closed_by"] == "closer" and closed["closed_at"], closed  # closed by + when
    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_pr_metadata():
    asyncio.run(_run_pr_metadata())


if __name__ == "__main__":
    asyncio.run(_run())
    print("API graph draft journey (HTTP create→import→draft-edit→read→publish) e2e: OK")
