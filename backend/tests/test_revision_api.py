"""``GET /graphs/{gid}/revisions/{seq}`` — one revision of main, and what opening it takes.

Against a fake service: the revision's commit, how many entities main changed since, and whether
the canvas can read the graph as it was then — not when it is too far back, nor a fork's. What the
count is is covered against Postgres in ``integration/test_revision_overlay_reads.py``.
"""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints.versioning import get_versioning_service

BASE = "/api/v1/ws1/versioning/graphs/g1"


def _commit(seq):
    return {"commit_id": f"cmt_{seq}", "commit_seq": seq, "kind": "squash_publish",
            "message": "Quarter close", "actor": "u1", "created_at": "2026-10-31T17:42:00+00:00",
            "stats": {"create": 3}}


class _Versioning:
    plan: dict = {}

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1",
                "provider_id": None}

    async def revision_read_plan(self, graph_id, seq):
        if seq > 9:
            raise ValueError(f"no revision {seq} on this graph's main")
        return {"main_id": "br_main", "head": 9, "commit_id": f"cmt_{seq}", "changed": 12,
                "too_far": False, "fork": False, **_Versioning.plan}

    async def commit_log_page(self, *, graph_id, limit, before, viewer, **kw):
        assert limit == 1 and viewer is not None
        return [_commit(before - 1)], True


@pytest.fixture
def versioning():
    from backend.app.main import app

    _Versioning.plan = {}
    app.dependency_overrides[get_versioning_service] = _Versioning
    yield _Versioning
    app.dependency_overrides.pop(get_versioning_service, None)


async def test_a_revision_and_what_opening_it_takes(test_client, versioning):
    r = await test_client.get(f"{BASE}/revisions/4")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["commit"]["commit_id"] == "cmt_4" and body["commit"]["commit_seq"] == 4
    assert body["headSeq"] == 9 and body["changedSince"] == 12 and body["limit"] == 100_000
    assert body["openable"] is True and body["reason"] is None
    assert "userNames" in body


@pytest.mark.parametrize("plan, reason", [({"too_far": True, "changed": 200_002}, "too_far"),
                                          ({"fork": True}, "fork")])
async def test_a_revision_the_canvas_cant_open_says_why(test_client, versioning, plan, reason):
    versioning.plan = plan
    body = (await test_client.get(f"{BASE}/revisions/4")).json()
    assert body["openable"] is False and body["reason"] == reason


async def test_an_unknown_revision_is_not_found(test_client, versioning):
    assert (await test_client.get(f"{BASE}/revisions/12")).status_code == 404
    assert (await test_client.get(f"{BASE}/revisions/-1")).status_code == 422
