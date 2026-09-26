"""A view waiting in a draft to go live shows up in no list, count or metric.

Queries over views filter on ``view_is_live()`` (not deleted, and not staged in a draft) rather
than on ``deleted_at`` alone. A few places reach staged views on purpose; they are listed here
with the reason, so a new query that filters on ``deleted_at`` alone fails this test and has to
choose which it means.
"""
from __future__ import annotations

from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"
PATTERN = "ViewORM.deleted_at.is_(None)"

ALLOWED = {
    # view_is_live itself.
    "db/models.py": 1,
    # One view by id, where access rules decide (a staged view is private to its importer); and
    # a person's own drafts, which include the view a draft holds.
    "api/v1/endpoints/views.py": 2,
    # Data freshness after a graph publish: a staged view is stamped too.
    "api/v1/endpoints/versioning.py": 2,
    # Sharing a staged view with the people reviewing its draft.
    "api/v1/endpoints/view_grants.py": 1,
    # Deleting a view: its importer can delete a staged one.
    "db/repositories/view_repo.py": 1,
    # Whether an identity is taken in a workspace: a staged view holds its identity.
    "services/view_transfer/importing.py": 1,
    # What a draft changes in views, which includes the views waiting in it.
    "services/draft_views.py": 2,
    # A view's library, by id, behind its route's access check: a view staged in a draft keeps
    # its rules on that draft (``branchId``).
    "services/view_library.py": 1,
}


def test_view_queries_leave_out_staged_views():
    found = {}
    for path in sorted(APP.rglob("*.py")):
        n = path.read_text(encoding="utf-8").count(PATTERN)
        if n:
            found[path.relative_to(APP).as_posix()] = n
    assert found == ALLOWED, (
        "A query filters views on deleted_at alone. Use view_is_live() so views staged in a "
        "draft stay out of it, or add it to ALLOWED with the reason it must see them."
    )
