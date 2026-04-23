"""Contract test: /graph/stats and /graph/metadata/schema never call the live provider.

The two handlers in ``backend/app/api/v1/endpoints/graph.py`` were
historically written as cache-first but with a live-provider fallthrough
on cache miss. On 1M+ node graphs that fallthrough guaranteed HTTP 504.

The cache-only refactor deleted the fallthrough. This test is the
regression guard — it patches the provider entry points to raise, then
hits both endpoints with a cold cache and asserts that the response is
still 200 with a well-formed envelope (``status=computing``) rather
than an exception from a re-introduced provider call.
"""
from __future__ import annotations

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import WorkspaceORM, WorkspaceDataSourceORM


pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


_WS_ID = "ws_contract_test"
_DS_ID = "ds_contract_test"


@pytest.fixture()
async def workspace_with_datasource(db_session: AsyncSession):
    """Minimal workspace + data source so the handlers can resolve the ds_id."""
    ws = WorkspaceORM(
        id=_WS_ID,
        name="Contract Test WS",
        created_by="usr_test000000",
        created_at="2024-01-01T00:00:00Z",
        updated_at="2024-01-01T00:00:00Z",
    )
    db_session.add(ws)
    await db_session.flush()
    ds = WorkspaceDataSourceORM(
        id=_DS_ID,
        workspace_id=_WS_ID,
        provider_id=None,
        graph_name="test-graph",
        is_active=True,
        is_primary=True,
        created_at="2024-01-01T00:00:00Z",
        updated_at="2024-01-01T00:00:00Z",
    )
    db_session.add(ds)
    await db_session.commit()
    return ws, ds


def _install_provider_tripwires(monkeypatch):
    """Make every live-provider entry point raise if the handler touches it."""
    def _forbid(*args, **kwargs):  # noqa: ARG001
        raise AssertionError(
            "Cache-only handler must not reach the live provider — "
            "live fallthrough was re-introduced."
        )

    async def _forbid_async(*args, **kwargs):  # noqa: ARG001
        raise AssertionError(
            "Cache-only handler must not reach the live provider — "
            "live fallthrough was re-introduced."
        )

    from backend.app.services import context_engine as ctx_mod

    monkeypatch.setattr(ctx_mod.ContextEngine, "for_workspace", _forbid_async)
    monkeypatch.setattr(ctx_mod.ContextEngine, "for_connection", _forbid_async)
    monkeypatch.setattr(ctx_mod.ContextEngine, "get_stats", _forbid_async, raising=False)
    monkeypatch.setattr(ctx_mod.ContextEngine, "get_schema_stats", _forbid_async, raising=False)
    monkeypatch.setattr(ctx_mod.ContextEngine, "get_graph_schema", _forbid_async, raising=False)
    monkeypatch.setattr(ctx_mod.ContextEngine, "get_ontology_metadata", _forbid_async, raising=False)


def _stub_out_redis_enqueue(monkeypatch):
    """Tests run without a real Redis — make enqueue a no-op."""
    async def _noop(*args, **kwargs):  # noqa: ARG001
        return None

    from backend.stats_service import enqueue as enqueue_mod

    monkeypatch.setattr(enqueue_mod, "enqueue_stats_job", _noop)


async def test_stats_endpoint_never_calls_provider(
    test_client, workspace_with_datasource, monkeypatch,
):
    """/graph/stats with cold cache returns 200 + computing envelope, no provider call."""
    _install_provider_tripwires(monkeypatch)
    _stub_out_redis_enqueue(monkeypatch)

    resp = await test_client.get(
        f"/api/v1/{_WS_ID}/graph/stats?dataSourceId={_DS_ID}"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "data" in body
    assert "meta" in body
    assert body["meta"]["status"] in ("computing", "fresh", "stale")
    # Cold cache: no row exists yet in data_source_stats
    assert body["meta"]["status"] == "computing"
    assert body["data"] is None


async def test_schema_endpoint_never_calls_provider(
    test_client, workspace_with_datasource, monkeypatch,
):
    """/graph/metadata/schema with cold cache returns 200 + envelope, no provider call."""
    _install_provider_tripwires(monkeypatch)
    _stub_out_redis_enqueue(monkeypatch)

    resp = await test_client.get(
        f"/api/v1/{_WS_ID}/graph/metadata/schema?dataSourceId={_DS_ID}"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert "data" in body
    assert "meta" in body
    # Without an ontology assigned, cold cache → computing.
    # (With an ontology, we'd see "partial" + source=ontology.)
    assert body["meta"]["status"] in ("computing", "partial")
    assert body["meta"]["source"] in ("none", "ontology")


async def test_stats_envelope_shape_matches_contract(
    test_client, workspace_with_datasource, monkeypatch,
):
    """Response always carries a ``meta`` object with the expected keys."""
    _install_provider_tripwires(monkeypatch)
    _stub_out_redis_enqueue(monkeypatch)

    resp = await test_client.get(
        f"/api/v1/{_WS_ID}/graph/stats?dataSourceId={_DS_ID}"
    )
    assert resp.status_code == 200
    body = resp.json()
    required_meta_keys = {
        "status", "source", "age_seconds", "ttl_seconds", "missing_fields",
    }
    assert required_meta_keys.issubset(body["meta"].keys())
