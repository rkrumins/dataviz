"""``POST …/graphs/{gid}/identities/resolve``: what values name on the published graph, as an import
naming an identifier finds rows — the route's part. It checks the identifier (422 with the
grammar), takes ``prop.<the data source's identity property>`` as the urn it holds, answers 409
``identifier_not_indexed`` before an import has built a property's index, and anyone who reads the
graph may call it, an API key too (it changes nothing). The lookups themselves are pinned on
Postgres (``integration/test_import_identifier``, ``integration/test_ingest_standard_ids``).
"""
from __future__ import annotations

import time
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import versioning as V
from backend.app.auth import api_key_surface
from backend.app.main import app
from backend.app.services.feature_flags import feature_flags
from backend.app.services.versioning.import_export import keys

_PATH = "/api/v1/ws_1/versioning/graphs/g_1/identities/resolve"


class _Versioning:
    asked: list = []
    refuse = None

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws_1", "data_source_id": None, "provider_id": None}

    async def resolve_identities(self, **kwargs):
        if _Versioning.refuse:
            raise _Versioning.refuse
        _Versioning.asked.append(kwargs)
        return [{"value": v, "status": "none", "entityId": None} for v in kwargs["values"]]


@pytest.fixture
def versioning(monkeypatch):
    feature_flags._cache = {"versioningEnabled": True}
    feature_flags._cache_ts = time.monotonic()
    _Versioning.asked, _Versioning.refuse = [], None
    app.dependency_overrides[V.get_versioning_service] = _Versioning

    async def identity(_session, _meta):
        return SimpleNamespace(identity_property="asset_id")
    monkeypatch.setattr(V, "_node_identity_for_meta", identity)
    yield
    app.dependency_overrides.pop(V.get_versioning_service, None)
    feature_flags.invalidate()


async def test_it_answers_each_value_by_the_identifier_it_names(test_client, versioning):
    resp = await test_client.post(_PATH, json={"identifier": " prop.external_id ", "values": ["E1", "E2"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["identifier"] == "prop.external_id"
    assert [r["value"] for r in resp.json()["results"]] == ["E1", "E2"]
    assert _Versioning.asked == [{"graph_id": "g_1", "identifier": "prop.external_id", "values": ["E1", "E2"]}]


async def test_the_identity_property_is_the_urn_it_holds(test_client, versioning):
    resp = await test_client.post(_PATH, json={"identifier": "prop.asset_id", "values": ["A-1"]})
    assert resp.json()["identifier"] == "urn" and _Versioning.asked[0]["identifier"] == "urn"


@pytest.mark.parametrize("identifier", ["sap_id", "prop.urn", ""])
async def test_an_identifier_it_may_not_name_is_a_422(test_client, versioning, identifier):
    resp = await test_client.post(_PATH, json={"identifier": identifier, "values": ["x"]})
    assert resp.status_code == 422 and resp.json()["detail"]["type"] == "invalid_identifier", resp.text


async def test_a_property_no_import_has_indexed_is_a_409(test_client, versioning):
    _Versioning.refuse = keys.NotIndexed("no import has matched this graph's nodes by ext yet")
    resp = await test_client.post(_PATH, json={"identifier": "prop.ext", "values": ["x"]})
    assert resp.status_code == 409 and resp.json()["detail"]["type"] == "identifier_not_indexed"


async def test_more_than_ten_thousand_values_is_a_422(test_client, versioning):
    resp = await test_client.post(_PATH, json={"identifier": "urn", "values": ["u"] * 10001})
    assert resp.status_code == 422


def test_readers_and_keys_may_call_it():
    path = "/api/v1/{ws_id}/versioning/graphs/{graph_id}/identities/resolve"
    [(route, _dep)] = [(r, d) for m, p, r, d in api_key_surface.routes(app) if p == path and m == "POST"]
    rule = api_key_surface.SURFACE[(route.endpoint.__module__, route.endpoint.__name__)]
    assert rule.reads_only
