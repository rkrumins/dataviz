"""The Review Center across workspaces (``/review-inbox``).

It reads each workspace the reader can read exactly as that workspace's own inbox
does — with the reader's permissions THERE — and merges the pages. These pin that:
a workspace the reader can't read is never asked; each is asked with its own
Viewer; counts add up, with each workspace's own kept for the picker; the merge is
newest first and pages across workspaces; and naming workspaces narrows the read.

The versioning store itself is replaced by a fake that answers per workspace:
its queue logic has its own (integration) tests.
"""
from __future__ import annotations

import contextlib

import pytest
from httpx import AsyncClient

from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.models import WorkspaceORM
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User

ME = User(id="usr_me", email="me@example.com", first_name="Sam", last_name="Reader", role="user",
          status="active", created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


def _pr(pr_id: str, ws: str, activity: str) -> dict:
    return {
        "pr_id": pr_id, "graph_id": f"g_{ws}", "source_branch_id": f"b_{pr_id}", "target_graph_id": f"g_{ws}",
        "target_branch": "main", "status": "open", "created_at": activity, "updated_at": activity,
        "last_activity_at": activity, "actor": "usr_other", "target_data_source_id": None,
    }


# Each workspace's reviews, newest first (as the service orders them).
REVIEWS = {
    "ws_a": [_pr("pr_a2", "ws_a", "2026-11-03T00:00:00Z"), _pr("pr_a1", "ws_a", "2026-11-01T00:00:00Z")],
    "ws_b": [_pr("pr_b1", "ws_b", "2026-11-02T00:00:00Z")],
    "ws_c": [_pr("pr_c1", "ws_c", "2026-11-04T00:00:00Z")],
}


class FakeService:
    def __init__(self):
        self.asked: list = []

    async def review_inbox(self, *, workspace_id, viewer, queue="needs_review", rule_of=None,
                           q=None, data_source_id=None, author=None, sort="activity", limit=50, offset=0):
        self.asked.append((workspace_id, viewer.can_manage, viewer.can_read, limit))
        rows = REVIEWS[workspace_id]
        n = len(rows)
        return {
            "counts": {"needs_review": n, "open": n}, "unread": {"needs_review": 1}, "capped": workspace_id == "ws_b",
            "queue": queue, "items": [dict(r) for r in rows[offset:offset + limit]] if limit else [], "total": n,
        }


@contextlib.contextmanager
def _as(claims: PermissionClaims, svc: FakeService):
    from backend.app.main import app

    async def _user():
        return ME

    saved = {k: app.dependency_overrides.get(k) for k in (get_current_user, get_optional_user, get_permission_claims, get_versioning_service)}
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_optional_user] = _user
    app.dependency_overrides[get_permission_claims] = lambda: claims
    app.dependency_overrides[get_versioning_service] = lambda: svc
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is None:
                app.dependency_overrides.pop(k, None)
            else:
                app.dependency_overrides[k] = v


# A reader in ws_a (who manages its data) and ws_b (who only reads it) — not ws_c.
CLAIMS = PermissionClaims(sid="s_me", ws_perms={
    "ws_a": ("workspace:datasource:read", "workspace:datasource:manage"),
    "ws_b": ("workspace:datasource:read",),
})


@pytest.fixture
async def estate(db_session):
    for ws_id, name in (("ws_a", "Alpha"), ("ws_b", "Beta"), ("ws_c", "Gamma")):
        db_session.add(WorkspaceORM(id=ws_id, name=name))
    await db_session.commit()


@pytest.mark.asyncio
async def test_reads_only_the_workspaces_the_reader_can_and_each_with_its_own_permissions(test_client: AsyncClient, estate):
    svc = FakeService()
    with _as(CLAIMS, svc):
        r = await test_client.get("/api/v1/review-inbox")
    assert r.status_code == 200, r.text
    assert {a[0] for a in svc.asked} == {"ws_a", "ws_b"}
    assert {(ws, manage, read) for ws, manage, read, _ in svc.asked} == {("ws_a", True, True), ("ws_b", False, True)}
    body = r.json()
    assert [it["prId"] for it in body["items"]] == ["pr_a2", "pr_b1", "pr_a1"]   # newest first, merged
    assert {it["workspaceName"] for it in body["items"]} == {"Alpha", "Beta"}
    assert body["items"][0]["workspaceId"] == "ws_a"


@pytest.mark.asyncio
async def test_counts_add_up_and_each_workspace_keeps_its_own(test_client: AsyncClient, estate):
    with _as(CLAIMS, FakeService()):
        r = await test_client.get("/api/v1/review-inbox/counts")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["counts"] == {"needs_review": 3, "open": 3}
    assert body["unread"] == {"needs_review": 2}
    assert body["capped"] is True
    assert body["byWorkspace"]["ws_a"]["counts"]["needs_review"] == 2
    assert body["byWorkspace"]["ws_b"]["counts"]["needs_review"] == 1
    assert "ws_c" not in body["byWorkspace"]


@pytest.mark.asyncio
async def test_pages_across_workspaces(test_client: AsyncClient, estate):
    svc = FakeService()
    with _as(CLAIMS, svc):
        first = (await test_client.get("/api/v1/review-inbox", params={"limit": 2})).json()
        second = (await test_client.get("/api/v1/review-inbox", params={"limit": 2, "offset": 2})).json()
    assert [it["prId"] for it in first["items"]] == ["pr_a2", "pr_b1"]
    assert [it["prId"] for it in second["items"]] == ["pr_a1"]
    assert first["total"] == 3
    # Each workspace was asked for enough rows to fill the page it could land on.
    assert max(a[3] for a in svc.asked) == 4


@pytest.mark.asyncio
async def test_naming_workspaces_narrows_it_and_never_widens_it(test_client: AsyncClient, estate):
    svc = FakeService()
    with _as(CLAIMS, svc):
        r = await test_client.get("/api/v1/review-inbox", params=[("workspaceId", "ws_b"), ("workspaceId", "ws_c")])
    assert r.status_code == 200, r.text
    assert {a[0] for a in svc.asked} == {"ws_b"}   # ws_c named, but not readable
    assert [it["prId"] for it in r.json()["items"]] == ["pr_b1"]


@pytest.mark.asyncio
async def test_a_reader_with_no_workspaces_gets_an_empty_center(test_client: AsyncClient, estate):
    svc = FakeService()
    with _as(PermissionClaims(sid="s_none", ws_perms={}), svc):
        r = await test_client.get("/api/v1/review-inbox")
    assert r.status_code == 200, r.text
    assert r.json()["items"] == [] and r.json()["total"] == 0
    assert svc.asked == []
