"""A provider's blank models and versioned graphs guard it.

* Delete is refused while anything still depends on the provider: a manual data source on it (a
  blank model's, which has no catalog item), or a versioned graph pinned to it, even one whose
  data source is gone.
* The impact report lists them: the manual source's workspace and every pinned graph's key.
* An edit that moves the provider to another server is refused with 409
  ``versioned_graphs_pinned`` while live versioned graphs are projected there, unless it says
  ``confirmReseed=true``. Then their watermarks are reset, so each graph is reseeded on the new
  server. An edit that keeps the server, such as a rename, is never refused.
* ``POST /versioning/graphs`` refuses a data source on a provider that cannot be copied.

The graphver store is faked at ``versioned_sources.graphs_pinned_to`` and at the versioning
service; ``integration/test_provider_versioned_graphs_live.py`` runs the real read.
"""
from types import SimpleNamespace

import pytest
from httpx import AsyncClient

from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.db.models import WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services import versioned_sources

_PROVIDERS = "/api/v1/admin/providers"


def _graph(graph_id: str, key: str, trashed: bool = False):
    return SimpleNamespace(graph_id=graph_id, falkor_graph_name=key, trashed=trashed)


class _Versioning:
    def __init__(self):
        self.resets: list = []
        self.created: list = []

    async def reset_projection_watermarks(self, *, provider, actor):
        self.resets.append(provider)
        return ["g_live"]

    async def create_graph(self, **kw):
        self.created.append(kw)
        return {"graph_id": "g_new", "main_branch_id": "b_main", "genesis_commit_id": "c_1"}


@pytest.fixture
def pinned(monkeypatch):
    """provider id → the versioned graphs pinned to it."""
    pins: dict = {}

    async def graphs_pinned_to(provider_id):
        return pins.get(provider_id, [])

    monkeypatch.setattr(versioned_sources, "graphs_pinned_to", graphs_pinned_to)
    return pins


@pytest.fixture
def versioning():
    from backend.app.main import app

    svc = _Versioning()
    app.dependency_overrides[get_versioning_service] = lambda: svc
    yield svc
    app.dependency_overrides.pop(get_versioning_service, None)


async def _provider(client: AsyncClient, provider_type: str = "falkordb") -> str:
    resp = await client.post(_PROVIDERS, json={
        "name": f"{provider_type} provider", "providerType": provider_type,
        "host": "falkor-a", "port": 6379, "tlsEnabled": False})
    assert resp.status_code in (200, 201), resp.text
    return resp.json()["id"]


async def _manual_source(db_session, provider_id: str, ws: str, ds: str) -> None:
    db_session.add(WorkspaceORM(id=ws, name=f"Workspace {ws}"))
    await db_session.flush()
    db_session.add(WorkspaceDataSourceORM(id=ds, workspace_id=ws, provider_id=provider_id,
                                          graph_name=f"blank_{ds}"))
    await db_session.flush()


async def test_a_blank_models_manual_data_source_blocks_delete(
        test_client, db_session, pinned):
    prov = await _provider(test_client)
    await _manual_source(db_session, prov, "ws_blank", "ds_blank")

    resp = await test_client.delete(f"{_PROVIDERS}/{prov}")
    assert resp.status_code == 409, resp.text
    assert (await test_client.get(f"{_PROVIDERS}/{prov}")).status_code == 200


async def test_a_versioned_graph_alone_blocks_delete(test_client, pinned):
    prov = await _provider(test_client)
    pinned[prov] = [_graph("g_fork", "gvf_g_fork")]   # a fork: its data source is no row

    resp = await test_client.delete(f"{_PROVIDERS}/{prov}")
    assert resp.status_code == 409, resp.text
    assert (await test_client.get(f"{_PROVIDERS}/{prov}")).status_code == 200


async def test_impact_lists_manual_sources_and_pinned_graphs(test_client, db_session, pinned):
    prov = await _provider(test_client)
    await _manual_source(db_session, prov, "ws_imp", "ds_imp")
    pinned[prov] = [_graph("g_blank", "blank_ds_imp"), _graph("g_old", "gv_old", trashed=True)]

    resp = await test_client.get(f"{_PROVIDERS}/{prov}/impact")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["workspaces"] == [{"id": "ws_imp", "name": "Workspace ws_imp", "type": "workspace"}]
    assert body["versionedGraphs"] == [
        {"id": "g_blank", "name": "blank_ds_imp", "type": "versioned_graph"},
        {"id": "g_old", "name": "gv_old (in trash)", "type": "versioned_graph"},
    ]


async def test_moving_a_provider_with_pinned_graphs_needs_confirm_then_reseeds(
        test_client, pinned, versioning):
    prov = await _provider(test_client)
    pinned[prov] = [_graph("g_live", "customer360"), _graph("g_old", "gv_old", trashed=True)]

    resp = await test_client.put(f"{_PROVIDERS}/{prov}", json={"host": "falkor-b"})
    assert resp.status_code == 409, resp.text
    detail = resp.json()["detail"]
    assert detail["type"] == "versioned_graphs_pinned"
    assert detail["graphs"] == [{"id": "g_live", "name": "customer360", "type": "versioned_graph"}], \
        "a trashed graph is not reseeded, so it is not listed"
    assert (await test_client.get(f"{_PROVIDERS}/{prov}")).json()["host"] == "falkor-a"
    assert versioning.resets == []

    resp = await test_client.put(f"{_PROVIDERS}/{prov}?confirmReseed=true", json={"host": "falkor-b"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["host"] == "falkor-b"
    assert versioning.resets == [prov]


async def test_a_topology_change_moves_the_provider_too(test_client, pinned, versioning):
    prov = await _provider(test_client)
    pinned[prov] = [_graph("g_live", "customer360")]

    resp = await test_client.put(f"{_PROVIDERS}/{prov}", json={"extraConfig": {
        "falkordbConnection": {"mode": "cluster",
                               "cluster": {"startupNodes": [["falkor-c", 6379]]}}}})
    assert resp.status_code == 409, resp.text
    assert resp.json()["detail"]["type"] == "versioned_graphs_pinned"


async def test_an_edit_that_keeps_the_server_is_never_refused(test_client, pinned, versioning):
    """Regression guard: passes before the change too."""
    prov = await _provider(test_client)
    pinned[prov] = [_graph("g_live", "customer360")]

    resp = await test_client.put(f"{_PROVIDERS}/{prov}",
                                 json={"name": "Renamed", "host": "falkor-a", "port": 6379})
    assert resp.status_code == 200, resp.text
    assert versioning.resets == []


async def test_moving_a_provider_nothing_is_pinned_to_is_not_refused(
        test_client, pinned, versioning):
    """Regression guard: passes before the change too."""
    prov = await _provider(test_client)

    resp = await test_client.put(f"{_PROVIDERS}/{prov}", json={"host": "falkor-b"})
    assert resp.status_code == 200, resp.text
    assert versioning.resets == []


async def test_versioning_a_source_on_a_provider_that_cannot_be_copied_is_refused(
        test_client, db_session, versioning):
    prov = await _provider(test_client, "neo4j")
    await _manual_source(db_session, prov, "ws_neo", "ds_neo")

    resp = await test_client.post("/api/v1/ws_neo/versioning/graphs",
                                  json={"dataSourceId": "ds_neo", "workspaceId": "ws_neo"})
    assert resp.status_code == 422, resp.text
    assert resp.json()["detail"]["type"] == "provider_unsupported"
    assert versioning.created == []
