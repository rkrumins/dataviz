"""A draft's level decides who writes it, and every branch says what its reader may do with it.

* Writing: the owner; an editor or maintainer member; on a public draft, anyone who may change the
  data source. A reader who may not write is refused (403), naming the owner or the role.
* Publishing a draft needs its owner or a maintainer, at either level.
* ``access`` on a branch: whether its reader may read it, write it and manage it, from the role the
  list already loaded and the draft's level — so a client never works it out for itself.

Decided on the draft's row and its member rows (faked here): no Postgres.
"""
from types import SimpleNamespace

import pytest

from backend.app.services.versioning.errors import DraftRoleRequired, NotDraftOwner
from backend.app.services.versioning.service import GraphVersioningService, Viewer

pytestmark = pytest.mark.asyncio

_SVC = GraphVersioningService.__new__(GraphVersioningService)


class _Members:
    """A session holding the draft's member rows, and no review naming anyone."""

    def __init__(self, *rows):
        self._rows = [SimpleNamespace(subject_type="user", subject_id=who, role=role) for who, role in rows]

    async def execute(self, _stmt):
        return SimpleNamespace(scalars=lambda: SimpleNamespace(all=lambda: list(self._rows)),
                               first=lambda: None)


def _draft(visibility="public", *, shared=False):
    return SimpleNamespace(id="br_1", kind="draft", owner="alice", is_shared=shared,
                           visibility=visibility, status="open")


async def test_anyone_who_changes_the_data_source_writes_a_public_draft():
    await _SVC._require_edit(_Members(), _draft(), "bob", ())


async def test_a_public_draft_is_not_written_without_changing_the_data_source():
    """A view route checks the view's own permission, not the data source's: writing a public
    draft through it still needs the data source's."""
    with pytest.raises(NotDraftOwner):
        await _SVC._require_edit(_Members(), _draft(), "bob", (), can_manage=False)
    await _SVC._require_edit(_Members(), _draft(), "alice", (), can_manage=False)   # the owner's own


async def test_publishing_a_draft_needs_its_owner_or_a_maintainer_at_either_level():
    for visibility in ("public", "private"):
        await _SVC._require_publish(_Members(), _draft(visibility), "alice", ())
    with pytest.raises(NotDraftOwner):                  # writes it, may not publish it
        await _SVC._require_publish(_Members(), _draft(), "bob", ())
    team = _draft(shared=True)
    with pytest.raises(DraftRoleRequired) as refused:
        await _SVC._require_publish(_Members(("bob", "editor")), team, "bob", ())
    assert refused.value.detail["required"] == "maintainer"
    await _SVC._require_publish(_Members(("bob", "maintainer")), team, "bob", ())


@pytest.mark.parametrize("branch, role, manages, expected", [
    (SimpleNamespace(kind="main", visibility="public"), None, True, (True, False, False)),
    (_draft("private"), "owner", True, (True, True, True)),
    (_draft("private"), "maintainer", True, (True, True, True)),
    (_draft("private"), "editor", True, (True, True, False)),
    (_draft("private"), "viewer", True, (True, False, False)),
    (_draft("private"), None, True, (True, False, False)),          # on its review
    (_draft("public"), None, True, (True, True, False)),
    (_draft("public"), None, False, (True, False, False)),
    (_draft("public"), "viewer", True, (True, True, False)),
])
async def test_each_branch_says_what_its_reader_may_do(branch, role, manages, expected):
    access = GraphVersioningService._access(branch, role, Viewer("bob", manages, can_read=True))
    assert (access["canRead"], access["canWrite"], access["canManage"]) == expected


async def test_a_refused_publish_says_to_open_a_merge_request():
    """Who may not publish a draft directly is told how they can still land it: a merge request on
    it, which anyone who may publish there merges, whoever owns the draft."""
    for members, branch in ((_Members(), _draft()), (_Members(("bob", "editor")), _draft(shared=True))):
        with pytest.raises((NotDraftOwner, DraftRoleRequired)) as refused:
            await _SVC._require_publish(members, branch, "bob", ())
        assert refused.value.detail["hint"] == "merge_request"
        assert "merge request" in refused.value.detail["message"]
        assert refused.value.detail["type"] == "access_denied"


async def test_abandoning_someone_elses_draft_is_refused_without_a_merge_request_hint():
    """Only publishing has another way in. Abandoning a draft or managing its members needs its
    owner or a maintainer, and nothing else does them."""
    with pytest.raises(NotDraftOwner) as refused:
        await _SVC._require_manage(_Members(), _draft(), "bob", ())
    assert "hint" not in refused.value.detail


async def test_a_refused_publish_folds_nothing_under_the_callers_name():
    """A public draft's other writers may stage on it, but not publish it. Their publish is refused
    before the draft's staged edits are folded into a checkpoint: that fold is written under the
    caller's name, and would commit the owner's work as someone else's."""
    from contextlib import asynccontextmanager

    svc = GraphVersioningService.__new__(GraphVersioningService)
    folded = []

    @asynccontextmanager
    async def _session():
        yield _Members()

    async def _get_branch(_s, _graph_id, _branch_id):
        return _draft()

    async def _flush(**kwargs):
        folded.append(kwargs["actor"])

    svc._session, svc._get_branch, svc._flush_pending_changes = _session, _get_branch, _flush
    with pytest.raises(NotDraftOwner) as refused:
        await svc.publish(graph_id="g_1", branch_id="br_1", actor="bob", message="m")
    assert folded == []
    assert refused.value.detail["hint"] == "merge_request"
