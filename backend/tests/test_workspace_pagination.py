"""
Server-side workspace paging: the View wizard's workspace rail asks for one page
at a time instead of pulling every workspace (and its nested data sources) to
render ten rows.

The contract that matters is the TOTAL: it must be computed against the same
filters — including RBAC — that produced the page, or the pager renders the
wrong number of pages for anyone who can't see everything.
"""
from backend.app.db.repositories import workspace_repo
from backend.common.models.management import WorkspaceCreateRequest


async def _seed(session, names):
    created = []
    for name in names:
        created.append(await workspace_repo.create_workspace(
            session,
            WorkspaceCreateRequest(name=name, description=None, data_sources=[]),
        ))
    await session.flush()
    return created


# ── paging ───────────────────────────────────────────────────────────

async def test_pages_are_alphabetical_and_bounded(db_session):
    await _seed(db_session, ["pg-charlie", "pg-alpha", "pg-bravo", "pg-delta"])

    page1, total = await workspace_repo.list_workspaces_page(db_session, limit=2, offset=0)
    page2, total2 = await workspace_repo.list_workspaces_page(db_session, limit=2, offset=2)

    assert total == total2 >= 4
    assert len(page1) == 2 and len(page2) == 2
    # Stable, human-scannable ordering by name — and no row appears twice.
    names = [w.name for w in page1 + page2]
    assert names == sorted(names)
    assert len({w.id for w in page1 + page2}) == 4


async def test_search_filters_and_counts_together(db_session):
    await _seed(db_session, ["srch-finance", "srch-finance-eu", "srch-marketing"])

    page, total = await workspace_repo.list_workspaces_page(
        db_session, limit=10, offset=0, search="srch-finance",
    )

    assert total == 2
    assert {w.name for w in page} == {"srch-finance", "srch-finance-eu"}


async def test_search_is_case_insensitive(db_session):
    await _seed(db_session, ["Case-Sensitive-WS"])

    page, total = await workspace_repo.list_workspaces_page(
        db_session, limit=10, offset=0, search="case-sensitive",
    )

    assert total == 1
    assert page[0].name == "Case-Sensitive-WS"


# ── RBAC scoping (the reason the count lives in SQL) ─────────────────

async def test_total_counts_only_permitted_workspaces(db_session):
    seeded = await _seed(db_session, ["rbac-a", "rbac-b", "rbac-c"])
    permitted = [seeded[0].id, seeded[1].id]

    page, total = await workspace_repo.list_workspaces_page(
        db_session, limit=10, offset=0, permitted_ids=permitted,
    )

    # The page AND the total describe what this caller can actually see —
    # otherwise the pager would offer pages of workspaces they can't open.
    assert total == 2
    assert {w.id for w in page} == set(permitted)


async def test_no_permissions_means_no_rows(db_session):
    await _seed(db_session, ["rbac-none"])

    page, total = await workspace_repo.list_workspaces_page(
        db_session, limit=10, offset=0, permitted_ids=[],
    )

    # An empty permitted list is "you can see nothing", NOT "no restriction".
    assert page == []
    assert total == 0
