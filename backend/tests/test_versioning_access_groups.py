"""A shared draft's member through a group is found without any route passing groups.

``_branch_role`` looks the caller's groups up itself (``_load_actor_groups``, the management DB),
and only when a group row could decide the answer: the owner, a private draft and a direct member
whose own row already meets the role asked for never touch the management DB. A lookup that fails
is ``GroupsUnavailable`` (503), never "no groups", so an outage can't read as a refusal. Rows left
on a private draft grant nothing, and so does a deleted group. The draft's member rows and the group
lookup are faked here, except where a deleted group is looked up.
"""
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import OperationalError

from backend.app.services.versioning import service
from backend.app.services.versioning.errors import DraftRoleRequired, GroupsUnavailable
from backend.app.services.versioning.service import GraphVersioningService

pytestmark = pytest.mark.asyncio


class _Session:
    """Answers the member-rows query with ``rows``."""

    def __init__(self, rows):
        self._rows = rows

    async def execute(self, _stmt):
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: list(self._rows)))


def _row(subject_type, subject_id, role):
    return SimpleNamespace(subject_type=subject_type, subject_id=subject_id, role=role)


def _draft(shared=True):
    return SimpleNamespace(id="br_1", kind="draft", owner="alice", is_shared=shared)


@pytest.fixture
def loads(monkeypatch):
    """The group lookup, counted: erin and bob are in ``grp``. ``fail`` makes it raise."""
    calls = []
    state = SimpleNamespace(calls=calls, fail=False)

    async def load(actor):
        calls.append(actor)
        if state.fail:
            raise GroupsUnavailable()
        return ("grp",) if actor in ("erin", "bob") else ()
    monkeypatch.setattr(service, "_load_actor_groups", load)
    return state


_SVC = GraphVersioningService.__new__(GraphVersioningService)


async def test_the_owner_is_a_maintainer_without_a_lookup(loads):
    assert await _SVC._branch_role(_Session([]), _draft(), "alice", need="maintainer") == "maintainer"
    assert loads.calls == []


async def test_rows_left_on_a_private_draft_grant_nothing(loads):
    s = _Session([_row("user", "bob", "maintainer"), _row("group", "grp", "maintainer")])
    assert await _SVC._branch_role(s, _draft(shared=False), "bob") is None
    assert loads.calls == []


async def test_a_direct_member_whose_row_suffices_needs_no_lookup(loads):
    s = _Session([_row("user", "bob", "editor"), _row("group", "grp", "editor")])
    assert await _SVC._branch_role(s, _draft(), "bob", need="editor") == "editor"
    await _SVC._require_edit(s, _draft(), "bob", ())
    assert loads.calls == []


async def test_a_member_through_a_group_is_looked_up_once(loads):
    s = _Session([_row("user", "bob", "editor"), _row("group", "grp", "editor")])
    assert await _SVC._branch_role(s, _draft(), "erin", need="editor") == "editor"
    assert loads.calls == ["erin"]


async def test_the_exact_role_looks_up_a_group_that_ranks_higher(loads):
    s = _Session([_row("user", "bob", "viewer"), _row("group", "grp", "editor")])
    assert await _SVC._branch_role(s, _draft(), "bob") == "editor"
    assert loads.calls == ["bob"]


async def test_a_group_row_below_the_role_asked_for_is_never_looked_up(loads):
    s = _Session([_row("group", "grp", "viewer")])
    with pytest.raises(DraftRoleRequired) as info:
        await _SVC._require_edit(s, _draft(), "erin", ())
    assert info.value.detail["required"] == "editor"
    assert loads.calls == []


async def test_an_editor_who_manages_is_refused_naming_maintainer(loads):
    s = _Session([_row("user", "bob", "editor")])
    with pytest.raises(DraftRoleRequired) as info:
        await _SVC._require_manage(s, _draft(), "bob", ())
    assert info.value.detail["required"] == "maintainer"


async def test_a_failed_lookup_is_groups_unavailable_not_a_refusal(loads):
    loads.fail = True
    s = _Session([_row("group", "grp", "editor")])
    with pytest.raises(GroupsUnavailable):
        await _SVC._require_edit(s, _draft(), "erin", ())


async def test_groups_the_caller_passes_replace_the_lookup(loads):
    s = _Session([_row("group", "eng", "editor")])
    assert await _SVC._branch_role(s, _draft(), "erin", ("eng",), need="editor") == "editor"
    assert loads.calls == []


async def test_the_lookup_raises_groups_unavailable_when_the_management_db_is_down(monkeypatch):
    from contextlib import asynccontextmanager
    from backend.app.db import engine

    @asynccontextmanager
    async def down():
        raise OperationalError("SELECT 1", None, ConnectionRefusedError())
        yield  # pragma: no cover
    monkeypatch.setattr(engine, "get_readonly_session", down)
    with pytest.raises(GroupsUnavailable):
        await service._load_actor_groups("erin")


async def test_a_deleted_group_grants_its_ex_members_nothing(db_session, monkeypatch):
    """Deleting a group keeps its member rows and the draft's row for it, so the lookup leaves it out."""
    from contextlib import asynccontextmanager
    from backend.app.db import engine
    from backend.app.db.models import GroupMemberORM, UserORM
    from backend.app.db.repositories import group_repo

    db_session.add(UserORM(id="erin", email="erin@example.com", password_hash="x",
                           first_name="Erin", last_name="E", status="active"))
    live = await group_repo.create_group(db_session, name="Eng")
    gone = await group_repo.create_group(db_session, name="Contractors")
    db_session.add_all([GroupMemberORM(group_id=g.id, user_id="erin") for g in (live, gone)])
    await group_repo.soft_delete_group(db_session, gone.id)
    await db_session.commit()

    @asynccontextmanager
    async def readonly():
        yield db_session
    monkeypatch.setattr(engine, "get_readonly_session", readonly)
    assert await service._load_actor_groups("erin") == (live.id,)
    s = _Session([_row("group", gone.id, "maintainer")])
    assert await _SVC._branch_role(s, _draft(), "erin", need="viewer") is None
    with pytest.raises(DraftRoleRequired):
        await _SVC._require_manage(s, _draft(), "erin", ())
