"""create_graph defaults falkor_provider to the data source's provider_id so the
worker's per-provider cache eviction scopes correctly. An explicit falkorProvider
wins, and resolution is best-effort: a missing data source or a lookup error
falls back to the "default" provider (None) rather than failing graph creation.

Pure unit test — drives the handler directly with a fake service + data-source
repo, no DB or HTTP.
"""
import asyncio
from types import SimpleNamespace

import backend.app.api.v1.endpoints.versioning as V
from backend.app.api.v1.endpoints.versioning import CreateGraphRequest


def _resolved_provider(*, explicit=None, ds_provider="__none__", raises=False, monkeypatch):
    body = CreateGraphRequest(
        dataSourceId="ds1", workspaceId="ws1",
        **({"falkorProvider": explicit} if explicit is not None else {}),
    )
    captured = {}

    async def fake_create_graph(**kwargs):
        captured.update(kwargs)
        return {"graph_id": "g1", "main_branch_id": "b1", "genesis_commit_id": "c1"}

    async def fake_get_ds(session, ds_id):
        if raises:
            raise RuntimeError("relation \"workspace_data_sources\" does not exist")
        return None if ds_provider == "__none__" else SimpleNamespace(provider_id=ds_provider)

    monkeypatch.setattr(V.data_source_repo, "get_data_source_orm", fake_get_ds)
    svc = SimpleNamespace(create_graph=fake_create_graph)
    asyncio.run(V.create_graph("ws1", body, user=SimpleNamespace(id="u1"), svc=svc, session=object()))
    return captured["falkor_provider"]


def test_provider_defaults_to_data_source(monkeypatch):
    assert _resolved_provider(ds_provider="prov_A", monkeypatch=monkeypatch) == "prov_A"


def test_explicit_provider_wins(monkeypatch):
    # explicit request value is used even when the data source has a different provider
    assert _resolved_provider(explicit="prov_x", ds_provider="prov_A", monkeypatch=monkeypatch) == "prov_x"


def test_unknown_data_source_falls_back_to_default(monkeypatch):
    assert _resolved_provider(ds_provider="__none__", monkeypatch=monkeypatch) is None


def test_lookup_error_falls_back_to_default(monkeypatch):
    assert _resolved_provider(raises=True, monkeypatch=monkeypatch) is None
