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
