"""Server-side sort ordering for the Explorer view list (view_repo).

Verifies ordering runs across the whole result set (not a client page) and that
views whose DATA was never published (data_updated_at NULL) sort last for the
data-* keys.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import view_repo
from backend.app.db.models import WorkspaceORM, ViewORM
from backend.common.models.management import ViewCreateRequest


async def _ws(session: AsyncSession) -> WorkspaceORM:
    ws = WorkspaceORM(name="Sort WS")
    session.add(ws)
    await session.flush()
    return ws


async def _view(session: AsyncSession, ws_id: str, name: str):
    return await view_repo.create_view(
        session,
        ViewCreateRequest(name=name, workspace_id=ws_id, view_type="graph", visibility="private"),
        user_id="u1",
    )


async def _set_times(session, view_id, *, data_updated_at, updated_at=None):
    row = (await session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    row.data_updated_at = data_updated_at
    if updated_at is not None:
        row.updated_at = updated_at
    await session.flush()


async def test_sort_data_newest_nulls_last(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    b = await _view(db_session, ws.id, "B")
    c = await _view(db_session, ws.id, "C")
    await _set_times(db_session, a.id, data_updated_at="2026-03-01T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-07-01T00:00:00+00:00")
    await _set_times(db_session, c.id, data_updated_at=None)

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="data-newest", limit=50)
    order = [v.name for v in resp.items]
    assert order.index("B") < order.index("A")   # Jul before Mar
    assert order[-1] == "C"                       # never-published last


async def test_sort_data_oldest_nulls_last(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    b = await _view(db_session, ws.id, "B")
    c = await _view(db_session, ws.id, "C")
    await _set_times(db_session, a.id, data_updated_at="2026-03-01T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-07-01T00:00:00+00:00")
    await _set_times(db_session, c.id, data_updated_at=None)

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="data-oldest", limit=50)
    order = [v.name for v in resp.items]
    assert order.index("A") < order.index("B")   # Mar before Jul
    assert order[-1] == "C"                       # never-published last


async def test_sort_recently_modified_uses_freshest_of_data_or_settings(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")  # recent settings edit, no data publish
    b = await _view(db_session, ws.id, "B")  # old settings, recent data publish
    await _set_times(db_session, a.id, data_updated_at=None, updated_at="2026-07-10T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-07-20T00:00:00+00:00", updated_at="2026-01-01T00:00:00+00:00")

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="recently-modified", limit=50)
    order = [v.name for v in resp.items]
    assert order[0] == "B"   # B's data (Jul 20) is fresher than A's settings (Jul 10)


async def test_sort_recently_modified_prefers_a_settings_edit_newer_than_an_old_publish(db_session: AsyncSession):
    """The later of the two, not "the publish if there was one": a view whose data
    was published long ago and whose settings were edited today is recent."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")  # old publish, settings edited recently
    b = await _view(db_session, ws.id, "B")  # publish in between, settings old
    await _set_times(db_session, a.id, data_updated_at="2026-01-05T00:00:00+00:00", updated_at="2026-08-01T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-05-01T00:00:00+00:00", updated_at="2026-01-01T00:00:00+00:00")

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="recently-modified", limit=50)
    assert [v.name for v in resp.items] == ["A", "B"]


SORTS = ["recently-modified", "modified-asc", "newest", "oldest", "updated", "updated-asc", "data-newest",
         "data-oldest", "az", "za", "popular", "likes-asc", "type-az", "type-za",
         "owner-az", "owner-za", "most-opened"]


import pytest  # noqa: E402


@pytest.mark.parametrize("sort", SORTS)
async def test_paging_is_stable_when_every_sort_key_ties(db_session: AsyncSession, sort):
    """Offset paging over rows whose sort key is identical (one publish stamps the
    same time on every view of a source; names repeat) must neither skip nor repeat
    a row: every sort breaks ties on the id."""
    ws = await _ws(db_session)
    ids = set()
    for _ in range(7):
        v = await _view(db_session, ws.id, "Same name")
        await _set_times(db_session, v.id, data_updated_at="2026-03-01T00:00:00+00:00",
                         updated_at="2026-03-01T00:00:00+00:00")
        row = (await db_session.execute(select(ViewORM).where(ViewORM.id == v.id))).scalar_one()
        row.created_at = "2026-03-01T00:00:00+00:00"
        ids.add(v.id)
    await db_session.flush()

    seen = []
    for offset in range(0, 7, 2):
        page = await view_repo.list_views_filtered(
            db_session, workspace_id=ws.id, sort=sort, limit=2, offset=offset)
        seen += [v.id for v in page.items]
    assert sorted(seen) == sorted(ids)


async def test_sort_by_type_follows_the_label_people_read(db_session: AsyncSession):
    """Type sorts by the label in the column — ``reference`` reads "Context View" —
    across the whole result, not the loaded page."""
    ws = await _ws(db_session)
    for name, kind in [("H", "hierarchy"), ("G", "graph"), ("R", "reference")]:
        await view_repo.create_view(db_session, ViewCreateRequest(
            name=name, workspace_id=ws.id, view_type=kind, visibility="private"), user_id="u1")

    az = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="type-az", limit=50)
    assert [v.name for v in az.items] == ["R", "G", "H"]   # Context View, Graph, Hierarchy
    za = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="type-za", limit=50)
    assert [v.name for v in za.items] == ["H", "G", "R"]


async def test_sort_by_owner_uses_their_name(db_session: AsyncSession):
    from backend.app.db.models import UserORM
    ws = await _ws(db_session)
    db_session.add_all([
        UserORM(id="usr_z", email="z@x.io", password_hash="x", first_name="Zoe", last_name="Ng"),
        UserORM(id="usr_a", email="a@x.io", password_hash="x", first_name="Ada", last_name="Lo"),
    ])
    await db_session.flush()
    for name, owner in [("by_zoe", "usr_z"), ("by_ada", "usr_a")]:
        await view_repo.create_view(db_session, ViewCreateRequest(
            name=name, workspace_id=ws.id, view_type="graph", visibility="private"), user_id=owner)

    az = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="owner-az", limit=50)
    assert [v.name for v in az.items] == ["by_ada", "by_zoe"]
    za = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="owner-za", limit=50)
    assert [v.name for v in za.items] == ["by_zoe", "by_ada"]


async def test_sort_likes_ascending(db_session: AsyncSession):
    from backend.app.db.models import ViewFavouriteORM
    ws = await _ws(db_session)
    # Plain is the OLDER edit, so the old fallback (last edit first) put it last.
    plain = await _view(db_session, ws.id, "Plain")
    loved = await _view(db_session, ws.id, "Loved")
    await _set_times(db_session, plain.id, data_updated_at=None, updated_at="2026-01-01T00:00:00+00:00")
    await _set_times(db_session, loved.id, data_updated_at=None, updated_at="2026-06-01T00:00:00+00:00")
    db_session.add_all([ViewFavouriteORM(view_id=loved.id, user_id=f"u{i}") for i in range(3)])
    await db_session.flush()

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="likes-asc", limit=50)
    assert [v.name for v in resp.items] == ["Plain", "Loved"]


async def test_sort_most_opened_ranks_the_whole_result_by_recent_opens(db_session: AsyncSession):
    """Ranked on the server over the last 30 days, so a heavily-opened view on what
    would be page 3 still comes first; opens older than the window don't count."""
    from datetime import datetime, timedelta, timezone
    from backend.app.db.models import ProductEventORM
    ws = await _ws(db_session)
    quiet = await _view(db_session, ws.id, "Quiet")
    busy = await _view(db_session, ws.id, "Busy")
    stale = await _view(db_session, ws.id, "Stale")
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(days=2)).isoformat()
    old = (now - timedelta(days=90)).isoformat()
    events = [ProductEventORM(event_type="view.opened", subject_id=busy.id, actor_id=f"u{i}", created_at=recent)
              for i in range(4)]
    events += [ProductEventORM(event_type="view.opened", subject_id=quiet.id, actor_id="u1", created_at=recent)]
    events += [ProductEventORM(event_type="view.opened", subject_id=stale.id, actor_id=f"u{i}", created_at=old)
               for i in range(9)]
    db_session.add_all(events)
    await db_session.flush()

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="most-opened", limit=50)
    assert [v.name for v in resp.items] == ["Busy", "Quiet", "Stale"]


async def test_sort_modified_ascending_is_the_updated_column_reversed(db_session: AsyncSession):
    """The list's Updated column shows the later of the two changes; sorting it
    ascending orders by that same time."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    b = await _view(db_session, ws.id, "B")
    await _set_times(db_session, a.id, data_updated_at="2026-09-01T00:00:00+00:00", updated_at="2026-01-01T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at=None, updated_at="2026-05-01T00:00:00+00:00")

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="modified-asc", limit=50)
    assert [v.name for v in resp.items] == ["B", "A"]   # May before A's September publish


async def test_stats_last_activity_counts_a_data_publish(db_session: AsyncSession):
    """"Last activity" is the freshest change the cards show — a publish newer than
    every settings edit counts."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    await _set_times(db_session, a.id, data_updated_at="2026-09-09T00:00:00+00:00",
                     updated_at="2026-01-01T00:00:00+00:00")
    stats = await view_repo.get_view_stats(db_session, workspace_id=ws.id)
    assert stats.last_activity_at == "2026-09-09T00:00:00+00:00"


async def test_tag_counts_match_the_case_blind_tag_filter(db_session: AsyncSession):
    """Filtering by a tag ignores case (``PII`` finds ``pii``), so its count does too:
    the number on the tag is the number of views the tag then shows."""
    ws = await _ws(db_session)
    for name, tags in [("A", ["PII"]), ("B", ["pii"]), ("C", ["pii", "PII"]), ("D", ["finance"])]:
        v = await _view(db_session, ws.id, name)
        row = (await db_session.execute(select(ViewORM).where(ViewORM.id == v.id))).scalar_one()
        row.tags = __import__("json").dumps(tags)
    await db_session.flush()

    facets = await view_repo.get_view_facets(db_session, workspace_id=ws.id)
    counts = {t.value.lower(): t.count for t in facets.tags}
    assert counts == {"pii": 3, "finance": 1}
    shown = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, tags=["PII"], limit=50)
    assert shown.total == counts["pii"]


async def test_search_treats_percent_and_underscore_as_text(db_session: AsyncSession):
    ws = await _ws(db_session)
    await _view(db_session, ws.id, "Growth 100% plan")
    await _view(db_session, ws.id, "Plain")
    await _view(db_session, ws.id, "snake_case model")
    await _view(db_session, ws.id, "snakeXcase")

    pct = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, search="%", limit=50)
    assert [v.name for v in pct.items] == ["Growth 100% plan"]
    under = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, search="snake_case", limit=50)
    assert [v.name for v in under.items] == ["snake_case model"]


# ── Sorts and filters follow the last change, settings or data ─────────────


def _days_ago(n: int) -> str:
    from datetime import datetime, timedelta, timezone
    return (datetime.now(timezone.utc) - timedelta(days=n)).isoformat()


async def test_the_default_order_is_recently_modified(db_session: AsyncSession):
    """No sort is the documented default, the later of a settings edit and a data
    publish — not settings edits alone, which put a view published today last."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "Edited in July")
    b = await _view(db_session, ws.id, "Published in August")
    await _set_times(db_session, a.id, data_updated_at=None, updated_at="2026-07-01T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-08-01T00:00:00+00:00",
                     updated_at="2026-01-01T00:00:00+00:00")

    default = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, limit=50)
    assert [v.name for v in default.items] == ["Published in August", "Edited in July"]
    unknown = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="no-such-sort", limit=50)
    assert [v.name for v in unknown.items] == ["Published in August", "Edited in July"]


@pytest.mark.parametrize("sort, expected", [
    ("az", ["apple", "Banana", "cherry"]),
    ("za", ["cherry", "Banana", "apple"]),
])
async def test_name_sorts_ignore_case(db_session: AsyncSession, sort, expected):
    ws = await _ws(db_session)
    for name in ("cherry", "Banana", "apple"):
        await _view(db_session, ws.id, name)
    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort=sort, limit=50)
    assert [v.name for v in resp.items] == expected


async def test_popular_breaks_ties_by_the_last_change(db_session: AsyncSession):
    """Equal likes: the view whose data changed most recently first, though its
    settings are the older."""
    from backend.app.db.models import ViewFavouriteORM
    ws = await _ws(db_session)
    edited = await _view(db_session, ws.id, "Edited")
    published = await _view(db_session, ws.id, "Published")
    await _set_times(db_session, edited.id, data_updated_at=None, updated_at="2026-06-01T00:00:00+00:00")
    await _set_times(db_session, published.id, data_updated_at="2026-09-01T00:00:00+00:00",
                     updated_at="2026-01-01T00:00:00+00:00")
    db_session.add_all([ViewFavouriteORM(view_id=v.id, user_id="u9") for v in (edited, published)])
    await db_session.flush()

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="popular", limit=50)
    assert [v.name for v in resp.items] == ["Published", "Edited"]


async def test_needs_attention_and_the_stale_badge_count_a_data_publish(db_session: AsyncSession):
    """Settings untouched since spring but data published last week is not stale —
    in the "needs attention" filter and in the badge alike."""
    ws = await _ws(db_session)
    fed = await _view(db_session, ws.id, "Fed weekly")
    idle = await _view(db_session, ws.id, "Idle")
    await _set_times(db_session, fed.id, data_updated_at=_days_ago(7), updated_at=_days_ago(200))
    await _set_times(db_session, idle.id, data_updated_at=_days_ago(150), updated_at=_days_ago(200))

    attention = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, attention_only=True, limit=50)
    assert [v.name for v in attention.items] == ["Idle"]
    everything = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, limit=50)
    health = {v.name: v.health.status for v in everything.items}
    assert health == {"Fed weekly": "healthy", "Idle": "stale"}
    idle_reason = next(v.health.reason for v in everything.items if v.name == "Idle")
    assert idle_reason == "Not updated in 150 days"
    stats = await view_repo.get_view_stats(db_session, workspace_id=ws.id)
    assert stats.needs_attention == 1


async def test_a_tag_with_accents_matches_however_it_was_stored(db_session: AsyncSession):
    """Before 2026-11 tags were stored with every non-ASCII character escaped; now as
    typed. The filter finds both, and a new view stores its tags as typed."""
    import json
    ws = await _ws(db_session)
    old = await _view(db_session, ws.id, "Old")
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == old.id))).scalar_one()
    row.tags = json.dumps(["Café"])                      # "Caf\u00e9", as written before
    await db_session.flush()
    new = await view_repo.create_view(db_session, ViewCreateRequest(
        name="New", workspace_id=ws.id, view_type="graph", visibility="private", tags=["Café", "Ünits"],
    ), user_id="u1")
    stored = (await db_session.execute(select(ViewORM.tags).where(ViewORM.id == new.id))).scalar_one()
    assert stored == '["Café", "Ünits"]'
    await _view(db_session, ws.id, "Other")

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, tags=["Café"], limit=50)
    assert {v.name for v in resp.items} == {"Old", "New"}


async def test_stats_count_recent_views_from_the_cutoff_the_list_uses(db_session: AsyncSession):
    ws = await _ws(db_session)
    for name, age in (("Three days", 3), ("Six days", 6), ("Ten days", 10)):
        v = await _view(db_session, ws.id, name)
        row = (await db_session.execute(select(ViewORM).where(ViewORM.id == v.id))).scalar_one()
        row.created_at = _days_ago(age)
    await db_session.flush()

    assert (await view_repo.get_view_stats(db_session, workspace_id=ws.id)).recently_added == 2
    pinned = await view_repo.get_view_stats(db_session, workspace_id=ws.id, recent_since=_days_ago(5))
    assert pinned.recently_added == 1


async def test_a_data_change_reaches_every_view_that_reads_the_source(db_session: AsyncSession):
    """Its own views, and views with no source of their own in a workspace whose
    default it is — never another source's, a deleted one, or a settings field."""
    from backend.app.db.models import ProviderORM, ViewActivityLogORM, WorkspaceDataSourceORM
    ws = await _ws(db_session)
    other_ws = WorkspaceORM(name="Elsewhere")
    db_session.add(other_ws)
    db_session.add(ProviderORM(id="prov_t", name="p", provider_type="falkordb"))
    await db_session.flush()
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_main", workspace_id=ws.id, provider_id="prov_t", label="Main",
                               is_primary=True),
        WorkspaceDataSourceORM(id="ds_side", workspace_id=ws.id, provider_id="prov_t", label="Side"),
        WorkspaceDataSourceORM(id="ds_far", workspace_id=other_ws.id, provider_id="prov_t", label="Far",
                               is_primary=True),
    ])
    await db_session.flush()
    views = {}
    for key, ws_id, ds_id in (("own", ws.id, "ds_main"), ("defaulted", ws.id, None),
                              ("side", ws.id, "ds_side"), ("far_default", other_ws.id, None),
                              ("deleted", ws.id, "ds_main")):
        views[key] = (await _view(db_session, ws_id, key)).id
        row = (await db_session.execute(select(ViewORM).where(ViewORM.id == views[key]))).scalar_one()
        row.data_source_id = ds_id
        await _set_times(db_session, views[key], data_updated_at=None, updated_at="2026-01-01T00:00:00+00:00")
    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == views["deleted"]))).scalar_one()
    row.deleted_at = "2026-02-01T00:00:00+00:00"
    await db_session.flush()

    stamped = await view_repo.touch_views_data_updated(db_session, "ds_main", "usr_pub")
    assert stamped == 2
    rows = {r.name: r for r in (await db_session.execute(select(ViewORM).where(ViewORM.id.in_(views.values()))))
            .scalars()}
    for name in rows:
        await db_session.refresh(rows[name])
    assert {n for n, r in rows.items() if r.data_updated_at} == {"own", "defaulted"}
    assert rows["own"].data_updated_by == "usr_pub"
    assert {rows[n].updated_at for n in ("own", "defaulted")} == {"2026-01-01T00:00:00+00:00"}, \
        "never a settings edit"
    logged = (await db_session.execute(
        select(ViewActivityLogORM.view_id).where(ViewActivityLogORM.action == "data_changed"))).scalars().all()
    assert sorted(logged) == sorted([views["own"], views["defaulted"]])

    # A source that is not its workspace's default reaches only its own views.
    assert await view_repo.touch_views_data_updated(db_session, "ds_side", None) == 1
