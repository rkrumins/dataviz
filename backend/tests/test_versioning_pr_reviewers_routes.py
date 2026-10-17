"""Asking for reviewers: who can be asked, and asking after a PR is open.

``GET …/reviewers`` lists the workspace's members who could approve (approve needs manage), bound
directly or through a group, and never the caller, who is the author of the PR they are raising.
Both PR PATCH routes take ``reviewers`` and hand them to ``update_pr``; a PATCH that leaves them
out leaves them alone.
"""
from __future__ import annotations

import pytest

from backend.app.api.v1.endpoints.versioning import get_versioning_service
from backend.app.db.models import (
    GroupMemberORM, GroupORM, RoleBindingORM, UserORM, WorkspaceORM,
)

BASE = "/api/v1/ws1/versioning"


class _Versioning:
    def __init__(self):
        self.updates = []

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1"}

    async def get_pr(self, pr_id):
        return {"pr_id": pr_id, "target_graph_id": "g1", "actor": "u_author"}

    async def update_pr(self, **kw):
        self.updates.append(kw)
        return {"pr_id": kw["pr_id"], "graph_id": "g1", "source_branch_id": "br_1",
                "target_graph_id": "g1", "target_branch": "main", "status": "mergeable",
                "reviewers": kw.get("reviewers"), "created_at": "t", "updated_at": "t"}


@pytest.fixture
def svc():
    from backend.app.main import app

    fake = _Versioning()
    app.dependency_overrides[get_versioning_service] = lambda: fake
    yield fake
    app.dependency_overrides.pop(get_versioning_service, None)


@pytest.mark.parametrize("route", ["pulls", "merge-requests"])
async def test_both_pr_patch_routes_take_reviewers(test_client, svc, route):
    r = await test_client.patch(f"{BASE}/{route}/pr_1", json={"reviewers": ["carol", "dave"]})
    assert r.status_code == 200, r.text
    assert r.json()["reviewers"] == ["carol", "dave"]
    r = await test_client.patch(f"{BASE}/{route}/pr_1", json={"title": "Tidy"})
    assert r.status_code == 200, r.text
    assert [u["reviewers"] for u in svc.updates] == [["carol", "dave"], None]


async def test_reviewer_candidates_are_the_members_who_can_approve(test_client, db_session, fake_user):
    db_session.add(WorkspaceORM(id="ws1", name="One"))
    for uid, first in (("u_carol", "Carol"), ("u_dave", "Dave"), ("u_vic", "Vic"), ("u_sus", "Sus")):
        db_session.add(UserORM(id=uid, email=f"{uid}@example.com", password_hash="x",
                               first_name=first, last_name="X",
                               status="suspended" if uid == "u_sus" else "active"))
    db_session.add(GroupORM(id="grp_eng", name="Eng"))
    await db_session.flush()
    db_session.add(GroupMemberORM(group_id="grp_eng", user_id="u_dave"))
    for subject_type, subject_id, role in (
        ("user", "u_carol", "workspace_member"),        # manage: can approve
        ("group", "grp_eng", "workspace_admin"),        # admin implies manage
        ("user", "u_vic", "workspace_viewer"),          # read only: cannot approve
        ("user", "u_sus", "workspace_member"),          # suspended account
        ("user", fake_user.id, "workspace_member"),     # the caller: the author
    ):
        db_session.add(RoleBindingORM(subject_type=subject_type, subject_id=subject_id,
                                      role_name=role, scope_type="workspace", scope_id="ws1"))
    await db_session.commit()

    r = await test_client.get(f"{BASE}/reviewers")
    assert r.status_code == 200, r.text
    assert r.json() == [
        {"userId": "u_carol", "displayName": "Carol X", "email": "u_carol@example.com"},
        {"userId": "u_dave", "displayName": "Dave X", "email": "u_dave@example.com"},
    ]
