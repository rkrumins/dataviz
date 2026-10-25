"""Who is asking, for a draft or review read (``viewer_ctx``).

A draft can be shared with a team, so for someone who doesn't manage the workspace's data the
caller's teams are read and carried on the ``Viewer``. A manager sees every draft, and a service
account is in no team: neither costs a query.
"""
from __future__ import annotations

from types import SimpleNamespace

from backend.app.api.v1.endpoints import versioning
from backend.app.services.versioning.service import Viewer


def _setup(monkeypatch, *, manages: bool):
    asked = []

    async def groups(session, user_id):
        asked.append(user_id)
        return ["grp_data", "grp_ops"]

    monkeypatch.setattr(versioning.user_repo, "get_groups_for_user", groups)
    monkeypatch.setattr(versioning, "has_permission", lambda claims, permission, workspace_id=None: manages)
    return asked


async def test_someone_who_doesnt_manage_carries_their_teams(monkeypatch):
    asked = _setup(monkeypatch, manages=False)
    viewer = await versioning.viewer_ctx("ws1", SimpleNamespace(id="usr_bob"), claims=None, session=None)
    assert viewer == Viewer("usr_bob", False, ("grp_data", "grp_ops"))
    assert asked == ["usr_bob"]


async def test_a_manager_sees_every_draft_without_reading_teams(monkeypatch):
    asked = _setup(monkeypatch, manages=True)
    viewer = await versioning.viewer_ctx("ws1", SimpleNamespace(id="usr_ada"), claims=None, session=None)
    assert viewer == Viewer("usr_ada", True, ()) and asked == []


async def test_a_service_account_is_in_no_team(monkeypatch):
    asked = _setup(monkeypatch, manages=False)
    viewer = await versioning.viewer_ctx("ws1", SimpleNamespace(id="svc_7be5998c6784"), claims=None,
                                         session=None)
    assert viewer == Viewer("svc_7be5998c6784", False, ()) and asked == []
