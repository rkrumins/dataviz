"""GET /api/v1/admin/users — server-side paging, search, sort and totals — and
GET /api/v1/admin/users/stats.

The admin table used to fetch one page (the endpoint's default ``limit=50``)
and search, sort and count it in the browser, so account 51 onwards could be
neither seen nor found, and every KPI undercounted. These pin the server
doing all of it across every account.

``test_client`` already holds one account — ``usr_test000000``, an active
``super_admin`` created 2024-01-01 — so totals below include it and searches
are scoped to strings only these tests' accounts carry.
"""
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from backend.app.db.models import UserORM, UserRoleORM

URL = "/api/v1/admin/users"


def _user(uid: str, *, first="Pat", last="Doe", email=None, status="active",
          created_at="2025-01-01T00:00:00+00:00", **extra) -> UserORM:
    return UserORM(
        id=uid, email=email or f"{uid}@paging.example", password_hash="x",
        first_name=first, last_name=last, status=status,
        created_at=created_at, updated_at=created_at, **extra,
    )


def _ids(resp) -> list[str]:
    return [u["id"] for u in resp.json()]


# ── Paging ────────────────────────────────────────────────────────────

async def test_pages_reach_every_account_past_the_first_fifty(
    test_client: AsyncClient, db_session,
):
    # One shared created_at: only the id tiebreak keeps the pages disjoint.
    db_session.add_all([_user(f"usr_page{i:03d}") for i in range(80)])
    await db_session.commit()

    seen: list[str] = []
    for offset in (0, 25, 50, 75):
        resp = await test_client.get(URL, params={"limit": 25, "offset": offset})
        assert resp.status_code == 200
        assert resp.headers["x-total-count"] == "81"
        seen += _ids(resp)
    assert len(seen) == 81
    assert len(set(seen)) == 81


async def test_search_finds_an_account_beyond_the_first_page(
    test_client: AsyncClient, db_session,
):
    db_session.add(_user(
        "usr_oldest", first="Zelda", last="Quill",
        created_at="2020-01-01T00:00:00+00:00",
    ))
    db_session.add_all([
        _user(f"usr_new{i:03d}", created_at="2025-06-01T00:00:00+00:00")
        for i in range(60)
    ])
    await db_session.commit()

    # Newest first, fifty to a page: the first page — all the admin table
    # ever fetched — never reaches Zelda.
    assert "usr_oldest" not in _ids(await test_client.get(URL))

    resp = await test_client.get(URL, params={"search": "zELDA"})
    assert resp.status_code == 200
    assert _ids(resp) == ["usr_oldest"]
    assert resp.headers["x-total-count"] == "1"


# ── Search ────────────────────────────────────────────────────────────

@pytest.fixture()
async def search_target(db_session):
    """One account carrying every searchable field, plus a decoy that
    matches none of the terms below."""
    from backend.app.db.repositories import idp_provider_repo, user_identity_repo

    db_session.add(_user(
        "usr_findme01", first="Jane", last="Findme",
        email="target.person@fields.example", display_name="Captain Nova",
    ))
    db_session.add(UserRoleORM(user_id="usr_findme01", role_name="org_admin"))
    db_session.add(_user(
        "usr_decoy01", first="Other", last="Person", email="decoy@fields.example",
    ))
    await db_session.flush()
    provider = await idp_provider_repo.create_provider(
        db_session, slug="corp-entra", display_name="Corporate Entra",
        kind="oidc", settings={},
    )
    await user_identity_repo.create_identity(
        db_session, user_id="usr_findme01", provider_id=provider.id,
        external_id="ext-findme",
    )
    await db_session.commit()


@pytest.mark.parametrize("term", [
    "findme01",          # id
    "target.person",     # email
    "captain nova",      # display-name override
    "jane findme",       # first + last
    "org_admin",         # role
    "Corporate Entra",   # linked provider's name
    "corp-entra",        # linked provider's slug
])
async def test_search_matches_every_field_a_row_shows(
    test_client: AsyncClient, search_target, term,
):
    resp = await test_client.get(URL, params={"search": term})
    assert resp.status_code == 200
    assert _ids(resp) == ["usr_findme01"]
    assert resp.headers["x-total-count"] == "1"


async def test_search_by_default_role_matches_accounts_without_a_role_row(
    test_client: AsyncClient, search_target,
):
    # No ``user_roles`` row displays as "user" — so it searches as "user".
    ids = _ids(await test_client.get(URL, params={"search": "user"}))
    assert "usr_decoy01" in ids
    assert "usr_findme01" not in ids


async def test_status_and_search_combine_and_deleted_accounts_stay_out(
    test_client: AsyncClient, db_session,
):
    db_session.add_all([
        _user("usr_combo_active", last="Combo", status="active"),
        _user("usr_combo_pending", last="Combo", status="pending"),
        _user("usr_combo_gone", last="Combo", deleted_at="2025-02-01T00:00:00+00:00"),
    ])
    await db_session.commit()

    resp = await test_client.get(URL, params={"search": "combo", "status": "active"})
    assert _ids(resp) == ["usr_combo_active"]
    assert resp.headers["x-total-count"] == "1"

    resp = await test_client.get(URL, params={"search": "combo"})
    assert set(_ids(resp)) == {"usr_combo_active", "usr_combo_pending"}
    assert resp.headers["x-total-count"] == "2"


# ── Sort ──────────────────────────────────────────────────────────────

@pytest.fixture()
async def sortable(db_session):
    """Three accounts whose order differs for every sort key."""
    db_session.add_all([
        _user("usr_sort_a", first="Bravo", last="One", email="a@sort.example",
              status="suspended", created_at="2025-01-02T00:00:00+00:00"),
        # The override must win the name sort over "Zulu Zed".
        _user("usr_sort_b", first="Zulu", last="Zed", email="c@sort.example",
              display_name="Alpha Override", status="pending",
              created_at="2025-01-03T00:00:00+00:00"),
        _user("usr_sort_c", first="Charlie", last="Two", email="b@sort.example",
              status="active", created_at="2025-01-01T00:00:00+00:00"),
    ])
    db_session.add_all([
        UserRoleORM(user_id="usr_sort_a", role_name="org_admin"),
        UserRoleORM(user_id="usr_sort_b", role_name="super_admin"),
        # usr_sort_c has no row, so shows (and sorts) as "user".
    ])
    await db_session.commit()


@pytest.mark.parametrize("sort,order,expected", [
    ("name", "asc", ["b", "a", "c"]),
    ("name", "desc", ["c", "a", "b"]),
    ("email", "asc", ["a", "c", "b"]),
    ("status", "asc", ["c", "b", "a"]),
    ("role", "asc", ["a", "b", "c"]),
    ("createdAt", "asc", ["c", "a", "b"]),
    ("createdAt", "desc", ["b", "a", "c"]),
])
async def test_sort_orders_by_what_the_column_shows(
    test_client: AsyncClient, sortable, sort, order, expected,
):
    resp = await test_client.get(
        URL, params={"search": "sort.example", "sort": sort, "order": order},
    )
    assert resp.status_code == 200
    assert [i.removeprefix("usr_sort_") for i in _ids(resp)] == expected


@pytest.mark.parametrize("params", [{"sort": "bogus"}, {"order": "up"}])
async def test_unknown_sort_or_order_is_rejected(test_client: AsyncClient, params):
    assert (await test_client.get(URL, params=params)).status_code == 422


# ── Stats ─────────────────────────────────────────────────────────────

async def test_stats_count_every_account_not_just_a_page(
    test_client: AsyncClient, db_session,
):
    now = datetime.now(timezone.utc)
    db_session.add_all([
        _user("usr_st_p1", status="pending", reset_token_hash="__requested__"),
        _user("usr_st_p2", status="pending"),
        _user("usr_st_p3", status="pending"),
        _user("usr_st_s1", status="suspended"),
        _user("usr_st_s2", status="suspended"),
        _user("usr_st_a1"),
        _user("usr_st_a2", reset_token_hash="live",
              reset_token_expires_at=(now + timedelta(hours=1)).isoformat()),
        _user("usr_st_a3", reset_token_hash="stale",
              reset_token_expires_at=(now - timedelta(hours=1)).isoformat()),
        _user("usr_st_a4"),
        # Soft-deleted: counted nowhere, not even as an admin or a reset.
        _user("usr_st_gone", deleted_at=now.isoformat(),
              reset_token_hash="__requested__"),
    ])
    db_session.add_all([
        UserRoleORM(user_id="usr_st_s1", role_name="super_admin"),
        UserRoleORM(user_id="usr_st_a1", role_name="org_admin"),
        # A workspace role in the legacy table is not a platform admin.
        UserRoleORM(user_id="usr_st_a4", role_name="workspace_admin"),
        UserRoleORM(user_id="usr_st_gone", role_name="super_admin"),
    ])
    await db_session.commit()

    resp = await test_client.get(f"{URL}/stats")
    assert resp.status_code == 200
    # usr_test000000 is the fifth active account and the third admin.
    assert resp.json() == {
        "total": 10,
        "pending": 3,
        "active": 5,
        "suspended": 2,
        "admins": 3,
        "resetRequested": 2,
    }
