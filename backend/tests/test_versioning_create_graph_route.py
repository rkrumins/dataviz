"""POST /graphs pins a new versioned graph to its data source's own FalkorDB graph.

The pin decides which FalkorDB key the projector writes, so it is never the caller's to choose:
the data source must be the path workspace's (404 otherwise, existence not leaked), an API key
must cover it, and the graph name and provider come from the data source — a body that names
another key is ignored. The claim looks under every provider on the data source's server, and a
key another versioned graph already projects into is a 409 ``graph_key_in_use`` — the claim's
refusal, or ``uq_ps_key`` when a concurrent claim won — as enabling version control answers.

The rebuild route's 409 while version control is still being enabled is pinned here too.

Pure unit tests — the route coroutines are called directly with a stub service and a stubbed
data-source lookup.
"""
import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError

import backend.app.api.v1.endpoints.versioning as V
from backend.app.auth import api_key_auth
from backend.app.db.repositories import provider_repo
from backend.app.services.versioning.service import ConcurrencyError

_DS = {"ds1": SimpleNamespace(id="ds1", workspace_id="ws1", graph_name="ds1_graph", provider_id="prov_A"),
       "ds_other": SimpleNamespace(id="ds_other", workspace_id="ws2", graph_name="theirs",
                                   provider_id="prov_A")}


@pytest.fixture(autouse=True)
def _no_key(monkeypatch):
    async def get_ds(session, ds_id, **_kw):
        return _DS.get(ds_id)

    async def no_key(request):
        return None

    async def falkordb(session, provider_id):
        return SimpleNamespace(id=provider_id, provider_type="falkordb")

    async def same_server(session, provider_id):
        return [provider_id, "prov_A_too"]

    monkeypatch.setattr(V.data_source_repo, "get_data_source_orm", get_ds)
    monkeypatch.setattr(api_key_auth, "acting", no_key)
    # The route refuses a provider it cannot project into; prov_A is FalkorDB.
    monkeypatch.setattr(provider_repo, "get_provider_orm", falkordb)
    # prov_A_too is another provider row for prov_A's server.
    monkeypatch.setattr(V, "same_server_providers", same_server)


def _create(body: dict, create=None):
    captured = {}

    async def fake_create_graph(**kwargs):
        captured.update(kwargs)
        if create is not None:
            await create()
        return {"graph_id": "g1", "main_branch_id": "b1", "genesis_commit_id": "c1"}

    svc = SimpleNamespace(create_graph=fake_create_graph)
    asyncio.run(V.create_graph("ws1", V.CreateGraphRequest(**body), SimpleNamespace(),
                               user=SimpleNamespace(id="u1"), svc=svc, session=object()))
    return captured


@pytest.mark.parametrize("ds_id", ["ds_other", "ds_missing"])
def test_a_data_source_outside_the_workspace_is_404(ds_id):
    with pytest.raises(HTTPException) as caught:
        _create({"dataSourceId": ds_id, "workspaceId": "ws1"})
    assert caught.value.status_code == 404


def test_the_pin_and_provider_come_from_the_data_source():
    got = _create({"dataSourceId": "ds1", "workspaceId": "ws1",
                   "falkorGraphName": "victim", "falkorProvider": "p2"})
    assert (got["falkor_graph_name"], got["falkor_provider"]) == ("ds1_graph", "prov_A")
    assert got["data_source_id"] == "ds1" and got["workspace_id"] == "ws1"


def test_the_claim_looks_under_every_provider_on_the_data_sources_server():
    got = _create({"dataSourceId": "ds1", "workspaceId": "ws1"})
    assert got["provider_aliases"] == ["prov_A", "prov_A_too"]


_IN_USE = "another versioned data source already projects into this FalkorDB graph"


@pytest.mark.parametrize("refusal", [
    ConcurrencyError(_IN_USE),
    IntegrityError("INSERT INTO graphver.projection_state", {}, Exception(
        'duplicate key value violates unique constraint "uq_ps_key"')),
], ids=["claim", "uq_ps_key"])
def test_a_key_already_projected_into_is_409_graph_key_in_use(refusal):
    async def taken():
        raise refusal

    with pytest.raises(HTTPException) as caught:
        _create({"dataSourceId": "ds1", "workspaceId": "ws1"}, create=taken)
    assert caught.value.status_code == 409
    assert caught.value.detail == {"type": "graph_key_in_use", "message": _IN_USE}


def test_another_integrity_error_is_not_a_key_in_use():
    # Regression guard (passes before the change): a lost race for the data source is not one.
    async def lost():
        raise IntegrityError("INSERT INTO graphver.graphs", {}, Exception(
            'duplicate key value violates unique constraint "uq_graphs_data_source"'))

    with pytest.raises(IntegrityError):
        _create({"dataSourceId": "ds1", "workspaceId": "ws1"}, create=lost)


def test_an_api_key_that_does_not_cover_the_data_source_is_refused(monkeypatch):
    scope = SimpleNamespace(selects_data_source=lambda ds_id, ws_id: ds_id != "ds1")

    async def key(request):
        return SimpleNamespace(claims=SimpleNamespace(key_scope=scope))

    monkeypatch.setattr(api_key_auth, "acting", key)
    with pytest.raises(HTTPException) as caught:
        _create({"dataSourceId": "ds1", "workspaceId": "ws1"})
    assert caught.value.status_code == 403
    assert caught.value.detail["error"] == "api_key_out_of_scope", caught.value.detail


def test_rebuild_while_version_control_is_being_enabled_is_409(monkeypatch):
    # Regression guard (passes before the change): main's 409 {type: 'bootstrapping'}.
    async def repaired(graph_id):
        return None

    async def watermark(graph_id):
        return {"falkor_graph_name": "ds1_graph"}

    async def refuse(graph_id):
        raise ConcurrencyError("version control is still being enabled for this data source")

    monkeypatch.setattr(V, "_repair_projection_target", repaired)
    svc = SimpleNamespace(projection_watermark=watermark, request_projection_rebuild=refuse)
    with pytest.raises(HTTPException) as caught:
        asyncio.run(V.rebuild_projection("ws1", "g1", background=None, _user=None, _meta={}, svc=svc))
    assert caught.value.status_code == 409 and caught.value.detail["type"] == "bootstrapping"
