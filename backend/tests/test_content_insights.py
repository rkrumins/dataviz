"""Usage on the content: the access rule, and the cost.

The dashboard's redaction machinery does not apply here, because this endpoint
returns no identities at all. What DOES apply is the view read rule — if you
may not open a view, this must not admit it exists — and the batching, because
a per-card fetch is the whole reason the endpoint takes a list.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.db.models import (
    ProductEventORM, UserORM, ViewORM, ViewVisitORM, WorkspaceORM,
)
from backend.app.db.repositories import analytics_repo

pytestmark = pytest.mark.asyncio

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)


def _iso(days_ago: int) -> str:
    return (NOW - timedelta(days=days_ago)).isoformat()


async def _seed(session):
    session.add_all([
        WorkspaceORM(id="ws_a", name="A", created_at=_iso(60)),
        WorkspaceORM(id="ws_b", name="B", created_at=_iso(60)),
    ])
    session.add_all([
        UserORM(id="usr_1", email="one@x.io", password_hash="x", first_name="One",
                last_name="User", status="active", created_at=_iso(50)),
        UserORM(id="usr_2", email="two@x.io", password_hash="x", first_name="Two",
                last_name="User", status="active", created_at=_iso(50)),
    ])
    session.add_all([
        # Reachable by a member of ws_a.
        ViewORM(id="view_open", workspace_id="ws_a", name="Open", view_type="reference",
                visibility="workspace", created_by="usr_1",
                created_at=_iso(40)),
        # In a workspace the caller is NOT in.
        ViewORM(id="view_other", workspace_id="ws_b", name="Other", view_type="reference",
                visibility="workspace", created_by="usr_2",
                created_at=_iso(40)),
        # Soft-deleted: never reported on, whoever asks.
        ViewORM(id="view_gone", workspace_id="ws_a", name="Gone", view_type="reference",
                visibility="workspace", created_by="usr_1", deleted_at=_iso(2),
                created_at=_iso(40)),
    ])
    events = []
    for i in range(5):
        events.append(ProductEventORM(
            id=f"pev_a{i}", event_type="view.opened", actor_id=f"usr_{i % 2 + 1}",
            subject_id="view_open", payload=json.dumps({"viewId": "view_open"}),
            created_at=_iso(1 + i)))
    events.append(ProductEventORM(
        id="pev_b", event_type="view.opened", actor_id="usr_2",
        subject_id="view_other", payload=json.dumps({"viewId": "view_other"}),
        created_at=_iso(1)))
    events.append(ProductEventORM(
        id="pev_gone", event_type="view.opened", actor_id="usr_1",
        subject_id="view_gone", payload=json.dumps({"viewId": "view_gone"}),
        created_at=_iso(1)))
    # Outside the window.
    events.append(ProductEventORM(
        id="pev_old", event_type="view.opened", actor_id="usr_1",
        subject_id="view_open", payload=json.dumps({"viewId": "view_open"}),
        created_at=_iso(200)))
    session.add_all(events)
    await session.commit()


async def test_counts_and_a_trend_for_a_view_you_can_read(db_session):
    await _seed(db_session)
    usage = await analytics_repo.view_usage(
        db_session, ["view_open"], days=30, now=NOW)

    row = usage["view_open"]
    assert row["opens"] == 5, "the 200-day-old open is outside the window"
    assert row["uniqueViewers"] == 2
    assert row["lastOpenedAt"].startswith("2026-06-14")
    assert sum(row["trend"]) == row["opens"], "the trend must total the count"
    assert len(row["trend"]) >= 28, "a 30-day window buckets by day"


async def test_a_view_you_cannot_read_is_absent_not_refused(db_session):
    """Absence, not a 403 — and the same answer a made-up id gets, so this
    cannot be used to probe for what exists."""
    await _seed(db_session)
    only_ws_a = ViewORM.workspace_id == "ws_a"

    usage = await analytics_repo.view_usage(
        db_session, ["view_open", "view_other", "view_invented"],
        days=30, now=NOW, readable=only_ws_a,
    )
    assert set(usage) == {"view_open"}


async def test_a_deleted_view_is_never_reported_on(db_session):
    await _seed(db_session)
    usage = await analytics_repo.view_usage(
        db_session, ["view_gone"], days=30, now=NOW)
    assert usage == {}


async def test_a_view_nobody_opened_answers_zero_rather_than_vanishing(db_session):
    """A readable view with no traffic is a FINDING — "nobody opens this" — and
    dropping it would make the caller unable to tell it apart from one they
    cannot see."""
    await _seed(db_session)
    db_session.add(ViewORM(
        id="view_quiet", workspace_id="ws_a", name="Quiet", view_type="reference",
        visibility="workspace", created_by="usr_1",
                created_at=_iso(40)))
    await db_session.commit()

    usage = await analytics_repo.view_usage(
        db_session, ["view_quiet"], days=30, now=NOW)
    assert usage["view_quiet"]["opens"] == 0
    assert usage["view_quiet"]["lastOpenedAt"] is None
    assert set(usage["view_quiet"]["trend"]) == {0}


async def test_a_batch_costs_the_same_as_a_single(db_session):
    """The property the endpoint exists for. If this ever becomes O(ids), a
    gallery goes from two queries to two per tile."""
    await _seed(db_session)

    counted = {"n": 0}
    real_execute = db_session.execute

    async def counting(*args, **kwargs):
        counted["n"] += 1
        return await real_execute(*args, **kwargs)

    db_session.execute = counting  # type: ignore[method-assign]
    try:
        await analytics_repo.view_usage(db_session, ["view_open"], days=30, now=NOW)
        one = counted["n"]
        counted["n"] = 0
        await analytics_repo.view_usage(
            db_session, ["view_open", "view_other", "view_gone"], days=30, now=NOW)
        many = counted["n"]
        counted["n"] = 0
        await analytics_repo.view_usage(
            db_session, ["view_open", "view_other", "view_gone"], days=30, now=NOW,
            viewer_id="usr_1")
        personal = counted["n"]
    finally:
        db_session.execute = real_execute  # type: ignore[method-assign]

    # CONSTANT is the property, not the constant. Five buys: what the reader
    # may see, the windowed totals, the daily trend, lifetime opens, and the
    # distinct openers behind "only its author". Asking for the reader's own
    # usage adds two more — their opens and their last visit — and neither
    # number grows with the batch, which is the whole point of taking a list.
    assert one == many == 5, f"expected 5 queries either way, got {one} and {many}"
    assert personal == 7, f"expected 7 with a viewer, got {personal}"


async def test_a_huge_batch_is_capped(db_session):
    """A caller passing ten thousand ids must not be able to turn a page render
    into an export."""
    await _seed(db_session)
    usage = await analytics_repo.view_usage(
        db_session,
        [f"view_{i}" for i in range(5_000)] + ["view_open"],
        days=30, now=NOW,
    )
    # `view_open` is beyond the cap, so it is not read — the cap is what is
    # under test, not which ids survive it.
    assert len(usage) <= analytics_repo.MAX_USAGE_IDS


async def test_duplicate_ids_are_asked_for_once(db_session):
    await _seed(db_session)
    usage = await analytics_repo.view_usage(
        db_session, ["view_open"] * 10, days=30, now=NOW)
    assert set(usage) == {"view_open"}
    assert usage["view_open"]["opens"] == 5


# ── "Is this used, and by how many people?" ──────────────────────────
#
# The question somebody asks about a view they have never seen. A count alone
# cannot answer it: 340 opens by one person is a scratchpad, 340 by twelve is
# something a team relies on, and only the DISTINCT figure separates them.


async def test_distinct_people_separates_a_shared_view_from_a_scratchpad(db_session):
    await _seed(db_session)
    # `view_open` was opened five times, alternating between two people.
    usage = await analytics_repo.view_usage(
        db_session, ["view_open"], days=30, now=NOW)
    assert usage["view_open"]["opens"] == 5
    assert usage["view_open"]["uniqueViewers"] == 2
    assert usage["view_open"]["onlyAuthor"] is False


async def test_a_view_only_its_author_has_opened_says_so(db_session):
    """The one qualitative signal worth stating, because a number cannot: two
    opens by two people and two opens by the author are both "2"."""
    await _seed(db_session)
    db_session.add_all([
        ViewORM(id="view_solo", workspace_id="ws_a", name="Solo",
                view_type="reference", visibility="workspace",
                created_by="usr_1", created_at=_iso(40)),
        ProductEventORM(
            id="pev_solo1", event_type="view.opened", actor_id="usr_1",
            subject_id="view_solo", payload=json.dumps({"viewId": "view_solo"}),
            created_at=_iso(2)),
        ProductEventORM(
            id="pev_solo2", event_type="view.opened", actor_id="usr_1",
            subject_id="view_solo", payload=json.dumps({"viewId": "view_solo"}),
            created_at=_iso(1)),
    ])
    await db_session.commit()

    usage = await analytics_repo.view_usage(
        db_session, ["view_solo", "view_open"], days=30, now=NOW)
    assert usage["view_solo"]["onlyAuthor"] is True
    assert usage["view_open"]["onlyAuthor"] is False


async def test_a_view_nobody_has_opened_is_not_the_author_case(db_session):
    """Never opened and only-the-author are different states, and `opens == 0`
    already says the first one."""
    await _seed(db_session)
    db_session.add(ViewORM(
        id="view_untouched", workspace_id="ws_a", name="Untouched",
        view_type="reference", visibility="workspace", created_by="usr_1",
        created_at=_iso(40)))
    await db_session.commit()

    usage = await analytics_repo.view_usage(
        db_session, ["view_untouched"], days=30, now=NOW)
    assert usage["view_untouched"]["opens"] == 0
    assert usage["view_untouched"]["onlyAuthor"] is False


async def test_lifetime_reaches_past_the_window(db_session):
    """`pev_old` is 200 days back — outside a 30-day window and inside the
    lifetime figure, which is the whole difference between the two."""
    await _seed(db_session)
    usage = await analytics_repo.view_usage(
        db_session, ["view_open"], days=30, now=NOW)
    assert usage["view_open"]["opens"] == 5
    assert usage["view_open"]["lifetimeOpens"] == 6


async def test_your_own_usage_is_yours_alone(db_session):
    """"New to you" is only sayable if we know what you have already seen."""
    await _seed(db_session)
    db_session.add(ViewVisitORM(
        id="vis_1", view_id="view_open", user_id="usr_1", visited_at=_iso(1)))
    await db_session.commit()

    mine = await analytics_repo.view_usage(
        db_session, ["view_open"], days=30, now=NOW, viewer_id="usr_1")
    theirs = await analytics_repo.view_usage(
        db_session, ["view_open"], days=30, now=NOW, viewer_id="usr_2")

    # Three of the five alternating opens were usr_1's, two were usr_2's.
    assert mine["view_open"]["yourOpens"] == 3
    assert theirs["view_open"]["yourOpens"] == 2
    # The platform-wide figures are the same for both, which is what makes the
    # personal line an ADDITION rather than a different set of numbers.
    assert mine["view_open"]["opens"] == theirs["view_open"]["opens"] == 5
    assert mine["view_open"]["yourLastOpenedAt"] == _iso(1)
    assert theirs["view_open"]["yourLastOpenedAt"] is None


async def test_asking_for_nobody_leaves_the_personal_fields_empty(db_session):
    await _seed(db_session)
    usage = await analytics_repo.view_usage(
        db_session, ["view_open"], days=30, now=NOW)
    assert usage["view_open"]["yourOpens"] == 0
    assert usage["view_open"]["yourLastOpenedAt"] is None


# ── Workspace rollups ────────────────────────────────────────────────


async def test_a_workspace_rollup_says_whether_anyone_is_there(db_session):
    await _seed(db_session)
    rollup = await analytics_repo.workspace_usage(
        db_session, ["ws_a", "ws_b"], days=30, now=NOW)

    # ws_a holds `view_open` (5 opens, 2 people) and the soft-deleted one,
    # which is never counted.
    assert rollup["ws_a"]["views"] == 1
    assert rollup["ws_a"]["opens"] == 5
    assert rollup["ws_a"]["uniqueViewers"] == 2
    assert rollup["ws_a"]["topView"]["viewId"] == "view_open"
    assert rollup["ws_a"]["topView"]["name"] == "Open"


async def test_a_rollup_counts_only_what_the_reader_may_read(db_session):
    """Two readers seeing different totals for one workspace is the access rule
    showing through, not a bug — and the alternative leaks. A top view named
    back to somebody who cannot open it turns a usage endpoint into the way to
    learn that a view exists."""
    await _seed(db_session)
    everything = await analytics_repo.workspace_usage(
        db_session, ["ws_b"], days=30, now=NOW)
    assert everything["ws_b"]["opens"] == 1
    assert everything["ws_b"]["topView"]["viewId"] == "view_other"

    blind = await analytics_repo.workspace_usage(
        db_session, ["ws_b"], days=30, now=NOW,
        readable=ViewORM.workspace_id == "ws_a",
    )
    assert blind["ws_b"]["views"] == 0
    assert blind["ws_b"]["opens"] == 0
    assert blind["ws_b"]["topView"] is None


async def test_a_workspace_with_nothing_in_it_still_answers(db_session):
    """A missing key would make the caller guess; zeros say "nobody, yet"."""
    await _seed(db_session)
    rollup = await analytics_repo.workspace_usage(
        db_session, ["ws_nonexistent"], days=30, now=NOW)
    assert rollup["ws_nonexistent"]["opens"] == 0
    assert rollup["ws_nonexistent"]["topView"] is None


async def test_people_are_not_summed_across_views(db_session):
    """One person opening three views is one person. Summing per-view distinct
    counts would report three, which is the classic way a rollup lies."""
    await _seed(db_session)
    db_session.add_all([
        ViewORM(id="view_two", workspace_id="ws_a", name="Two",
                view_type="reference", visibility="workspace",
                created_by="usr_1", created_at=_iso(40)),
        ProductEventORM(
            id="pev_two", event_type="view.opened", actor_id="usr_1",
            subject_id="view_two", payload=json.dumps({"viewId": "view_two"}),
            created_at=_iso(1)),
    ])
    await db_session.commit()

    rollup = await analytics_repo.workspace_usage(
        db_session, ["ws_a"], days=30, now=NOW)
    assert rollup["ws_a"]["views"] == 2
    assert rollup["ws_a"]["opens"] == 6
    # usr_1 and usr_2 across both views — still two people, not three.
    assert rollup["ws_a"]["uniqueViewers"] == 2
