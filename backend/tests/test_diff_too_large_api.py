"""The Changes tree's routes for a draft too large to lay out as a tree: the summary says so
(``tooLarge``, its counts, no groups), and asking for a container's children is a 409 the panel
can explain, never a gigabyte built in the web process to answer it."""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.services.versioning.service import DiffTooLarge

BASE = "/api/v1/ws1/versioning/graphs/g1/branches/br_1/diff-vs-main"
NONE = {"added": 0, "modified": 0, "removed": 0}
COUNTED = {"groups": [], "groupTotal": 0, "counts": {**NONE, "modified": 5},
           "entityCounts": {**NONE, "modified": 5}, "edgeCounts": NONE,
           "impact": {"SchemaField": 5}, "tooLarge": {"changed": 5, "limit": 3}}


class _Versioning:
    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1", "provider_id": None}

    async def diff_branch_summary(self, **_kw):
        return COUNTED

    async def diff_branch_children(self, **_kw):
        raise DiffTooLarge(5, 3)


@pytest.fixture
def versioning():
    from backend.app.main import app

    app.dependency_overrides[get_versioning_service] = _Versioning
    yield
    app.dependency_overrides.pop(get_versioning_service, None)


async def test_a_draft_too_large_for_the_tree_is_counted(test_client, versioning):
    r = await test_client.get(f"{BASE}/summary")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tooLarge"] == {"changed": 5, "limit": 3}
    assert body["groups"] == [] and body["counts"]["modified"] == 5


async def test_its_tree_has_no_children_to_page(test_client, versioning):
    r = await test_client.get(f"{BASE}/children", params={"containerKey": "urn:D"})
    assert r.status_code == 409, r.text
    assert r.json()["detail"]["type"] == "too_large_for_tree"
    assert (r.json()["detail"]["changed"], r.json()["detail"]["limit"]) == (5, 3)
