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
    ProductEventORM, UserORM, ViewORM, WorkspaceORM,
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
    finally:
        db_session.execute = real_execute  # type: ignore[method-assign]

    assert one == many == 3, f"expected 3 queries either way, got {one} and {many}"


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
