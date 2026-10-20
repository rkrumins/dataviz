"""A graph in the trash answers none of its routes.

Deleting a data source tombstones its versioned graph, which is meant to hide it from every
read at once; one whose purge is running is being taken apart row by row. Its id kept working
all the same — history, state, drafts and reviews — because the lookup behind every graph route
didn't look at the tombstone. Now that route, and the base-graph check behind every review
request route, answer 404 for it, the same answer as a graph that never existed.
"""
import pytest

from backend.app.api.v1.endpoints.versioning import get_versioning_service

WS = "ws_a"
GRAPH = f"/api/v1/{WS}/versioning/graphs/graph_a"


class _Versioning:
    def __init__(self, deleted_at=None):
        self.deleted_at = deleted_at

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": WS, "data_source_id": "ds_a",
                "kind": "manual", "main_head_commit_seq": 3, "created_at": "2026-10-01T00:00:00+00:00",
                "deleted_at": self.deleted_at}

    async def get_pr(self, pr_id):
        return {"pr_id": pr_id, "graph_id": "graph_a", "source_branch_id": "br_a",
                "target_graph_id": "graph_a", "target_branch": "main", "status": "open",
                "actor": "usr_a", "created_at": "2026-10-01T00:00:00+00:00",
                "updated_at": "2026-10-01T00:00:00+00:00"}

    async def commit_log_page(self, **_kw):
        return [], False


@pytest.fixture
def versioning():
    from backend.app.main import app

    def use(**kw):
        app.dependency_overrides[get_versioning_service] = lambda: _Versioning(**kw)

    yield use
    app.dependency_overrides.pop(get_versioning_service, None)


async def test_a_live_graph_answers(test_client, versioning):
    versioning()
    assert (await test_client.get(GRAPH)).status_code == 200
    assert (await test_client.get(f"{GRAPH}/commits")).status_code == 200
    assert (await test_client.get(f"/api/v1/{WS}/versioning/pulls/pr_a")).status_code == 200


@pytest.mark.parametrize("path", [GRAPH, f"{GRAPH}/commits", f"{GRAPH}/watermark",
                                  f"{GRAPH}/branches"])
async def test_a_graph_in_the_trash_is_not_found(test_client, versioning, path):
    versioning(deleted_at="2026-10-19T12:00:00+00:00")
    r = await test_client.get(path)
    assert r.status_code == 404, r.text
    assert r.json()["detail"] == "graph not found in workspace"


@pytest.mark.parametrize("path", ["pulls/pr_a", "merge-requests/pr_a"])
async def test_a_review_of_a_graph_in_the_trash_is_not_found(test_client, versioning, path):
    versioning(deleted_at="2026-10-19T12:00:00+00:00")
    r = await test_client.get(f"/api/v1/{WS}/versioning/{path}")
    assert r.status_code == 404, r.text
