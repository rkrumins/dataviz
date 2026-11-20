"""An export of entities picked on the canvas, with what is inside them: ``POST …/exports``.

Pins, through the API: the ids may come in the body (a selection too long for a URL) as well as in
the query, both kept; ``withChildren`` hands the job the ontology's containment, so it exports the
selection's contents too; and without it, or without ids, the job is given none. The job's own
export is ``integration/test_offline_round_trip.py``'s (``selection``).
"""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints import versioning as versioning_endpoints
from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service

URL = "/api/v1/ws1/versioning/graphs/g1/exports"


class _Versioning:
    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1", "provider_id": None}


class _Exports:
    def __init__(self):
        self.created: list = []

    async def find_job(self, **_):
        return None

    async def create_export_job(self, **kwargs):
        self.created.append(kwargs)
        return {"job_id": f"vjob_{len(self.created)}", "result_uri": "ws1/ds1/g1/export.csv"}

    async def start_export(self, job_id):
        return "pending"


@pytest.fixture
def exports(monkeypatch):
    from backend.app.main import app

    async def _containment(session, ws_id, data_source_id):
        assert (ws_id, data_source_id) == ("ws1", "ds1")
        return {"CONTAINS": False, "BELONGS_TO": True}

    monkeypatch.setattr(versioning_endpoints, "_live_containment_map", _containment)
    service = _Exports()
    app.dependency_overrides[get_versioning_service] = _Versioning
    app.dependency_overrides[get_import_export_service] = lambda: service
    yield service
    app.dependency_overrides.pop(get_versioning_service, None)
    app.dependency_overrides.pop(get_import_export_service, None)


async def test_a_selection_in_the_body_is_exported_with_what_is_inside_it(test_client, exports):
    r = await test_client.post(URL, params={"format": "csv", "ids": "urn:q", "withChildren": "true"},
                               json={"ids": ["urn:a", "gv:e1"]})
    assert r.status_code == 202, r.text
    (job,) = exports.created
    assert job["select_ids"] == ["urn:q", "urn:a", "gv:e1"]
    assert job["select_children"] == {"CONTAINS": False, "BELONGS_TO": True}


async def test_without_children_or_ids_the_job_follows_no_containment(test_client, exports):
    assert (await test_client.post(URL, json={"ids": ["urn:a"]})).status_code == 202
    assert (await test_client.post(URL, params={"withChildren": "true"})).status_code == 202
    first, second = exports.created
    assert first["select_ids"] == ["urn:a"] and first["select_children"] is None
    assert second["select_ids"] == [] and second["select_children"] is None
