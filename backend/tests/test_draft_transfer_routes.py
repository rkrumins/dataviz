"""Who has left a workspace, and who a draft can be handed to — decided on the management database
(SQLite here), for ``POST …/transfer`` and ``GET …/drafts/owner-left``.

* A draft's owner has left the workspace when their account is gone, deleted or no longer active,
  or they no longer read its data sources.
* A draft goes only to an active person who changes them: else 422 ``ineligible_owner``, saying why.
* Handing on a draft needs manage; listing the drafts whose owner left needs workspace admin.
  Neither is for an API key.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.app.api.v1.endpoints.versioning import _assert_owner_eligible, _owners_who_left
from backend.app.db.models import RoleBindingORM, UserORM, WorkspaceORM
from backend.app.main import app
from backend.app.auth import api_key_surface
from backend.app.services.versioning.errors import HTTP_MAPPED, IneligibleOwner

from test_drafts_policy import _gate_perms


@pytest.fixture
async def people(db_session):
    db_session.add_all([WorkspaceORM(id="ws1", name="One"), WorkspaceORM(id="ws2", name="Two")])
    gone = datetime.now(timezone.utc).isoformat()
    for uid, status, deleted_at in (("u_here", "active", None), ("u_viewer", "active", None),
                                    ("u_sus", "suspended", None), ("u_new", "pending", None),
                                    ("u_gone", "active", gone), ("u_elsewhere", "active", None)):
        db_session.add(UserORM(id=uid, email=f"{uid}@example.com", password_hash="x", first_name=uid,
                               last_name="X", status=status, deleted_at=deleted_at))
    await db_session.flush()
    for uid, role, ws in (("u_here", "workspace_member", "ws1"), ("u_viewer", "workspace_viewer", "ws1"),
                          ("u_sus", "workspace_member", "ws1"), ("u_new", "workspace_member", "ws1"),
                          ("u_gone", "workspace_member", "ws1"), ("u_elsewhere", "workspace_member", "ws2")):
        db_session.add(RoleBindingORM(subject_type="user", subject_id=uid, role_name=role,
                                      scope_type="workspace", scope_id=ws))
    await db_session.commit()


async def test_who_has_left_the_workspace(db_session, people):
    owners = ["u_here", "u_viewer", "u_sus", "u_new", "u_gone", "u_elsewhere", "u_never"]
    assert await _owners_who_left(db_session, "ws1", owners) == {
        "u_sus", "u_new", "u_gone", "u_elsewhere", "u_never"}
    assert await _owners_who_left(db_session, "ws1", []) == set()


@pytest.mark.parametrize("who, reason", [
    ("svc_0123456789ab", "service_account"),
    ("u_never", "unknown_user"),
    ("u_gone", "unknown_user"),
    ("u_sus", "inactive"),
    ("u_new", "inactive"),
    ("u_viewer", "no_manage"),
    ("u_elsewhere", "no_manage"),
])
async def test_a_draft_goes_only_to_an_active_person_who_changes_the_data_source(
        db_session, people, who, reason):
    with pytest.raises(IneligibleOwner) as refused:
        await _assert_owner_eligible(db_session, "ws1", who)
    assert isinstance(refused.value, HTTP_MAPPED) and refused.value.status_code == 422
    assert {k: refused.value.detail[k] for k in ("type", "userId", "reason")} == {
        "type": "ineligible_owner", "userId": who, "reason": reason}


async def test_an_active_person_who_changes_the_data_source_may_own_a_draft(db_session, people):
    await _assert_owner_eligible(db_session, "ws1", "u_here")


@pytest.mark.parametrize("path, method, permission", [
    ("/api/v1/{ws_id}/versioning/graphs/{graph_id}/branches/{branch_id}/transfer", "POST",
     "workspace:datasource:manage"),
    ("/api/v1/{ws_id}/versioning/drafts/owner-left", "GET", "workspace:admin"),
])
def test_handing_on_and_listing_leavers_drafts_is_for_people(path, method, permission):
    found = [(r, d) for m, p, r, d in api_key_surface.routes(app) if p == path and m == method]
    assert len(found) == 1, found
    route, dependant = found[0]
    assert permission in _gate_perms(dependant)
    assert (route.endpoint.__module__, route.endpoint.__name__) not in api_key_surface.SURFACE
