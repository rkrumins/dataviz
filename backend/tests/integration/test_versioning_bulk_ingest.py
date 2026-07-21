"""Bulk ingest (P5) — needs Postgres.

Day-0 / large-delta import: ndjson rows → one ``import`` commit via chunked bulk
inserts. Verifies valid rows land (edge endpoints resolved by urn AND id), invalid
rows are reported (not fatal), the import is idempotent on a key, and the result
materializes + projects. Also drives the ndjson upload endpoint (malformed line
rejected).
"""
import asyncio
import os
from types import SimpleNamespace

import pytest
from sqlalchemy import select, text

from backend.app.services.versioning import db, models
from backend.app.services.versioning.models import CommitORM
from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.service import GraphVersioningService
from backend.tests.integration.test_versioning_projection import FakeFalkor

R, M = "workspace:datasource:read", "workspace:datasource:manage"


ROWS = [
    {"kind": "node", "id": "A", "urn": "urn:A", "entityType": "Dataset", "displayName": "Alpha"},
    {"kind": "node", "id": "B", "urn": "urn:B", "entityType": "Dataset", "displayName": "Beta"},
    {"kind": "node", "id": "C", "entityType": "Dataset", "displayName": "Gamma"},     # no urn → id ref
    {"kind": "edge", "id": "E1", "edgeType": "FLOWS_TO", "source": "urn:A", "target": "urn:B"},  # by urn
    {"kind": "edge", "id": "E2", "edgeType": "FLOWS_TO", "source": "B", "target": "C"},          # by id
    {"kind": "node", "displayName": "bad"},                       # rejected: no entityType
    {"kind": "edge", "edgeType": "X", "source": "urn:A"},         # rejected: no target
    {"kind": "weird"},                                           # rejected: unknown kind
]


async def _run() -> None:
    await models.create_schema_and_partitions()
    async with db.graphver_session() as s:
        await s.execute(text('ALTER TABLE graphver.commits ADD COLUMN IF NOT EXISTS idempotency_key text'))
    svc = GraphVersioningService()
    gid = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="a",
                                   falkor_graph_name="gvt_" + os.urandom(3).hex()))["graph_id"]
    mid = await svc.main_branch_id(gid)

    # ── import: valid rows land, invalid rows reported ───────────────────
    rep = await svc.bulk_ingest(graph_id=gid, rows=ROWS, actor="a", idempotency_key="k1")
    assert rep["nodes"] == 3 and rep["edges"] == 2 and rep["ingested"] == 5, rep
    assert len(rep["rejected"]) == 3, rep["rejected"]
    st = await svc.materialize_state(graph_id=gid, branch_id=mid)
    assert set(st["nodes"]) == {"A", "B", "C"} and set(st["edges"]) == {"E1", "E2"}
    assert st["edges"]["E1"]["sourceEntityId"] == "A" and st["edges"]["E1"]["targetEntityId"] == "B"
    assert st["edges"]["E2"]["sourceEntityId"] == "B" and st["edges"]["E2"]["targetEntityId"] == "C"  # resolved by id

    async with db.graphver_session() as s:
        c = await s.scalar(select(CommitORM).where(CommitORM.graph_id == gid, CommitORM.commit_seq == 2))
        assert c.kind == "import" and c.idempotency_key == "k1" and c.merkle_root

    # ── idempotent replay: same key → original commit, head not re-advanced ─
    rep2 = await svc.bulk_ingest(graph_id=gid, rows=ROWS, actor="a", idempotency_key="k1")
    assert rep2.get("idempotent_replay") is True and rep2["commit_id"] == rep["commit_id"]
    assert (await svc.get_graph(gid))["main_head_commit_seq"] == 2

    # ── the imported graph projects + reads fresh ───────────────────────
    # A cypher-interpreting fake (not a no-op): the post-Layer-A projector DROPs then content-verifies
    # the reseed and only advances the watermark when the projection faithfully equals committed main.
    proj = FalkorProjector(graph_client_factory=FakeFalkor())
    await proj.project_graph(gid)
    assert (await svc.projection_watermark(gid))["projected"] == 2

    # ── ndjson upload endpoint (malformed line is rejected, not fatal) ───
    from fastapi import FastAPI, Request
    from httpx import ASGITransport, AsyncClient
    import backend.app.auth.dependencies as deps
    from backend.app.auth.dependencies import get_current_user, get_permission_claims
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.api.v1.endpoints import versioning as V

    deps.get_revocation_service = lambda: SimpleNamespace(is_revoked=lambda sid: False)

    async def fake_user():
        return SimpleNamespace(id="u", email="u@x.com")

    async def fake_claims(request: Request):
        ws = request.path_params.get("ws_id") or "ws1"
        return PermissionClaims(sid="", global_perms=(), ws_perms={ws: (R, M)})

    app = FastAPI()
    app.include_router(V.router, prefix="/api/v1/{ws_id}/versioning")
    app.dependency_overrides[get_current_user] = fake_user
    app.dependency_overrides[get_permission_claims] = fake_claims

    gid2 = (await svc.create_graph(data_source_id="ds_" + os.urandom(4).hex(), workspace_id="ws1", actor="a",
                                    falkor_graph_name="gvt_" + os.urandom(3).hex()))["graph_id"]
    ndjson = (
        '{"kind":"node","id":"N1","entityType":"Dataset","displayName":"n1"}\n'
        'this is not json\n'
        '{"kind":"node","id":"N2","entityType":"Dataset","displayName":"n2"}\n'
        '{"kind":"edge","id":"X1","edgeType":"R","source":"N1","target":"N2"}\n'
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        resp = await c.post(
            f"/api/v1/ws1/versioning/graphs/{gid2}/bulk-ingest",
            params={"idempotencyKey": "up1"},
            content=ndjson.encode(), headers={"Content-Type": "application/x-ndjson"},
        )
        body = resp.json()
        assert resp.status_code == 200, body
        assert body["nodes"] == 2 and body["edges"] == 1 and len(body["rejected"]) == 1   # malformed line

    await db.dispose_engine()


@pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")
def test_versioning_bulk_ingest_e2e():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("versioning bulk ingest e2e: OK")
