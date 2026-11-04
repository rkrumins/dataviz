"""The restore dialog's preview says when its counts are approximate. Past
``_RESTORE_PREVIEW_MAX_TOUCHED`` entities the service prices a restore by how many entities it
touches instead of reading them all, and the dialog says "roughly N items" — but only if the route
passes ``approximate`` and ``touchedEstimate`` through. Its response model used to drop them, so a
restore over a large import showed "nothing would change"."""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints.versioning import get_versioning_service

URL = "/api/v1/ws1/versioning/graphs/g1/commits/cmt_1/restore-preview"
ZERO = {"create": 0, "update": 0, "delete": 0}


def _service(preview: dict):
    class _Versioning:
        async def get_graph(self, graph_id):
            return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1",
                    "provider_id": None}

        async def restore_preview(self, **_kw):
            return preview

    return _Versioning


@pytest.fixture
def serve():
    from backend.app.main import app

    def _install(preview: dict) -> None:
        app.dependency_overrides[get_versioning_service] = _service(preview)

    yield _install
    app.dependency_overrides.pop(get_versioning_service, None)


async def test_an_approximate_preview_says_so_and_how_many(test_client, serve):
    serve({"commitsUndone": 3, "approximate": True, "touchedEstimate": 250_000,
           "nodes": ZERO, "edges": ZERO})
    r = await test_client.get(URL)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["approximate"] is True
    assert body["touchedEstimate"] == 250_000
    assert body["commitsUndone"] == 3


async def test_an_exact_preview_is_not_approximate(test_client, serve):
    serve({"commitsUndone": 1, "approximate": False,
           "nodes": {"create": 2, "update": 0, "delete": 1}, "edges": ZERO})
    r = await test_client.get(URL)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["approximate"] is False
    assert body["touchedEstimate"] is None
    assert body["nodes"] == {"create": 2, "update": 0, "delete": 1}
