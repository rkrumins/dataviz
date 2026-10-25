"""Who is asking, for a draft or review read (``viewer_ctx``), and where their teams come from.

A draft can be shared with a team. ``viewer_ctx`` reads no teams: the service looks the caller's up
itself (``_load_actor_groups``), only when a team's row could decide. A manager's draft reads never
need them, and a service account — in no team — costs no query.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import versioning
from backend.app.db import engine
from backend.app.services.versioning import service
from backend.app.services.versioning.service import GraphVersioningService, Viewer

_TEAM_SHARED = SimpleNamespace(id="br_1", kind="draft", owner="usr_owner", is_shared=True)


def _no_lookup(*args, **kwargs):
    raise AssertionError("teams were looked up")


def _lookups_fail(monkeypatch):
    monkeypatch.setattr(versioning.user_repo, "get_groups_for_user", _no_lookup)
    monkeypatch.setattr(service, "_load_actor_groups", _no_lookup)


@pytest.mark.parametrize("manages", [False, True])
@pytest.mark.parametrize("actor", ["usr_bob", "svc_7be5998c6784"])
async def test_viewer_ctx_reads_no_teams(monkeypatch, manages, actor):
    _lookups_fail(monkeypatch)
    monkeypatch.setattr(versioning, "has_permission", lambda claims, permission, workspace_id=None: manages)
    viewer = await versioning.viewer_ctx("ws1", SimpleNamespace(id=actor), claims=None)
    assert viewer == Viewer(actor, manages, ())


async def test_a_manager_reads_a_team_shared_draft_without_reading_teams(monkeypatch):
    _lookups_fail(monkeypatch)
    assert await GraphVersioningService()._branch_readable(None, _TEAM_SHARED, Viewer("usr_ada", True))


async def test_a_service_account_is_in_no_team_and_costs_no_query(monkeypatch):
    monkeypatch.setattr(engine, "get_readonly_session", _no_lookup)
    assert await service._load_actor_groups("svc_7be5998c6784") == ()


class _Rows:
    def __init__(self, rows):
        self._rows = rows

    def scalars(self):
        return self

    def all(self):
        return self._rows


class _Session:
    """The draft's member rows: one for a team, none for the caller."""

    async def execute(self, stmt):
        return _Rows([SimpleNamespace(branch_id="br_1", subject_type="group", subject_id="grp_data",
                                      role="viewer")])


async def test_someone_who_doesnt_manage_reads_through_their_team(monkeypatch):
    asked = []

    async def groups(actor):
        asked.append(actor)
        return ("grp_data",)

    monkeypatch.setattr(service, "_load_actor_groups", groups)
    assert await GraphVersioningService()._branch_readable(_Session(), _TEAM_SHARED, Viewer("usr_bob", False))
    assert asked == ["usr_bob"], "looked up once, as the team's row could decide"
