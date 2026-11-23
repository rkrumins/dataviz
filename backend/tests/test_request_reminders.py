"""Data requests and identity-provider link requests left waiting are brought up again.

These pin, for a data request: it is brought up to the workspace's admins (and whoever took
it on), then to the platform team, each once, sooner the sooner it is needed — this week
after a day and three, this month after three and seven, no rush after a week and two;
counted from when it was asked; never to the person who asked; never once it is connected,
declined or withdrawn; nothing while the Data requests switch is off. For a link request:
the platform administrators are reminded after three days and, a last time, after a week.
Both are stamped with their notices, so a second pass at the same moment sends nothing, and
a row already brought up never holds up the rest of a batch.
"""
from __future__ import annotations

import asyncio
import contextlib
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from backend.app.db.models import (
    DataRequestORM,
    GroupMemberORM,
    GroupORM,
    IdpLinkRequestORM,
    NotificationORM,
    RoleBindingORM,
    UserORM,
    WorkspaceORM,
)
from backend.app.services import access_housekeeping as hk
from backend.app.services.feature_flags import feature_flags

WS, GONE = "ws_fin", "ws_gone"
ASKED = datetime(2026, 11, 2, 9, 0, tzinfo=timezone.utc)
T0 = "2026-10-01T00:00:00+00:00"
HOUR = timedelta(hours=1)
DAY = timedelta(days=1)
# Ada asks; Walt is Finance's admin, Wren one through a group; Ben only reads it;
# Olga is an Org Admin and Root a Super Admin — both create workspaces, only Root links groups.
ADA, BEN, WALT, WREN, OLGA, ROOT = "usr_ada", "usr_ben", "usr_walt", "usr_wren", "usr_olga", "usr_root"
WS_LINK = f"/workspaces/{WS}?tab=data&section=sources"
QUEUE = "/workspaces?tab=requests"


@pytest.fixture
def switch_on():
    feature_flags._cache["dataRequestsEnabled"] = True
    yield
    feature_flags._cache["dataRequestsEnabled"] = False


@pytest.fixture
async def world(db_session, switch_on):
    for uid in (ADA, BEN, WALT, WREN, OLGA, ROOT):
        db_session.add(UserORM(id=uid, email=f"{uid}@example.com", password_hash="x", first_name=uid[4:].title(),
                               last_name="T", status="active", created_at=T0, updated_at=T0))
    db_session.add_all([
        WorkspaceORM(id=WS, name="Finance"),
        WorkspaceORM(id=GONE, name="Gone", deleted_at=T0),
        GroupORM(id="grp_admins", name="Finance admins"),
        GroupORM(id="grp_eng", name="Finance · Engineers"),
    ])
    await db_session.flush()
    db_session.add_all([
        GroupMemberORM(group_id="grp_admins", user_id=WREN),
        RoleBindingORM(subject_type="user", subject_id=OLGA, role_name="org_admin", scope_type="global"),
        RoleBindingORM(subject_type="user", subject_id=ROOT, role_name="super_admin", scope_type="global"),
        RoleBindingORM(subject_type="user", subject_id=WALT, role_name="workspace_admin",
                       scope_type="workspace", scope_id=WS),
        RoleBindingORM(subject_type="group", subject_id="grp_admins", role_name="workspace_admin",
                       scope_type="workspace", scope_id=WS),
        RoleBindingORM(subject_type="user", subject_id=ADA, role_name="workspace_viewer",
                       scope_type="workspace", scope_id=WS),
        RoleBindingORM(subject_type="user", subject_id=BEN, role_name="workspace_viewer",
                       scope_type="workspace", scope_id=WS),
    ])
    await db_session.commit()


def _data_request(session, rid: str, *, urgency: str = "this_month", status: str = "pending", by: str = ADA,
                  assignee: str | None = None, ws: str = WS, asked: datetime = ASKED) -> None:
    closed = status in ("connected", "declined", "withdrawn")
    session.add(DataRequestORM(
        id=rid, workspace_id=ws, requested_by=by, title=f"Ledger marts {rid}", system="snowflake",
        urgency=urgency, status=status, assignee_id=assignee, created_at=asked.isoformat(),
        updated_at=asked.isoformat(), resolved_at=asked.isoformat() if closed else None,
        resolved_by=WALT if closed else None,
    ))


def _link_request(session, rid: str, *, status: str = "pending", group: str = "grp_eng", by: str = WALT,
                  asked: datetime = ASKED) -> None:
    session.add(IdpLinkRequestORM(
        id=rid, group_id=group, workspace_id=WS, idp_group="ML-Engineers", requested_by=by,
        requested_at=asked.isoformat(), status=status,
        resolved_at=None if status == "pending" else asked.isoformat(),
        resolved_by=None if status == "pending" else ROOT,
    ))


async def _told(session, kind: str) -> dict[str, list[str]]:
    """``{user: the links of their notices of this kind}``."""
    rows = (await session.execute(
        select(NotificationORM).where(NotificationORM.kind == kind).order_by(NotificationORM.user_id)
        .execution_options(populate_existing=True)
    )).scalars().all()
    out: dict[str, list[str]] = {}
    for n in rows:
        out.setdefault(n.user_id, []).append(n.link)
    return out


async def _stored(session, model, rid: str):
    return (await session.execute(
        select(model).where(model.id == rid).execution_options(populate_existing=True)
    )).scalar_one()


# ── Data requests ────────────────────────────────────────────────────────


@pytest.mark.asyncio
@pytest.mark.parametrize("urgency, remind_days, escalate_days", [
    ("this_week", 1, 3), ("this_month", 3, 7), ("no_rush", 7, 14),
])
async def test_a_data_request_is_brought_up_then_taken_further_once_each_as_soon_as_it_is_needed(
    world, db_session, urgency, remind_days, escalate_days,
):
    _data_request(db_session, "dr_1", urgency=urgency)
    await db_session.commit()
    nudge = hk.nudge_waiting_data_requests

    assert await nudge(db_session, now=ASKED + remind_days * DAY - HOUR) == (0, 0)
    assert await nudge(db_session, now=ASKED + remind_days * DAY) == (1, 0)
    assert await _told(db_session, "data_request.reminder") == {WALT: [WS_LINK], WREN: [WS_LINK]}
    assert await nudge(db_session, now=ASKED + remind_days * DAY + HOUR) == (0, 0)   # once
    assert await nudge(db_session, now=ASKED + escalate_days * DAY - HOUR) == (0, 0)
    assert await nudge(db_session, now=ASKED + escalate_days * DAY) == (0, 1)
    assert await _told(db_session, "data_request.escalated") == {OLGA: [QUEUE], ROOT: [QUEUE]}
    assert await nudge(db_session, now=ASKED + 60 * DAY) == (0, 0)
    assert len(await _told(db_session, "data_request.reminder")) == 2

    row = await _stored(db_session, DataRequestORM, "dr_1")
    assert (row.reminded_at, row.escalated_at) == (
        (ASKED + remind_days * DAY).isoformat(), (ASKED + escalate_days * DAY).isoformat())


@pytest.mark.asyncio
async def test_the_reminder_names_who_is_waiting_for_what_and_how_soon(world, db_session):
    _data_request(db_session, "dr_1", urgency="this_week")
    await db_session.commit()
    await hk.nudge_waiting_data_requests(db_session, now=ASKED + DAY + HOUR)
    note = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.kind == "data_request.reminder", NotificationORM.user_id == WALT)
    )).scalar_one()
    assert note.title == "Ada T is still waiting for data in Finance: Ledger marts dr_1"
    assert note.body == "Asked 1 day ago, needed this week. Review it under Data → Sources."
    assert (note.resource_type, note.resource_id) == ("data_request", "dr_1")


@pytest.mark.asyncio
async def test_one_left_long_enough_is_brought_up_and_taken_further_in_the_same_pass(world, db_session):
    _data_request(db_session, "dr_1", urgency="no_rush")
    await db_session.commit()
    assert await hk.nudge_waiting_data_requests(db_session, now=ASKED + 20 * DAY) == (1, 1)
    assert set(await _told(db_session, "data_request.reminder")) == {WALT, WREN}
    assert set(await _told(db_session, "data_request.escalated")) == {OLGA, ROOT}


@pytest.mark.asyncio
async def test_answered_withdrawn_and_connected_requests_are_left_alone(world, db_session):
    for status in ("connected", "declined", "withdrawn"):
        _data_request(db_session, f"dr_{status}", status=status)
    await db_session.commit()
    assert await hk.nudge_waiting_data_requests(db_session, now=ASKED + 30 * DAY) == (0, 0)
    for status in ("connected", "declined", "withdrawn"):
        row = await _stored(db_session, DataRequestORM, f"dr_{status}")
        assert (row.reminded_at, row.escalated_at) == (None, None)
    assert await _told(db_session, "data_request.reminder") == {}


@pytest.mark.asyncio
async def test_one_being_connected_reminds_whoever_took_it_on_too(world, db_session):
    # Olga (platform team, not one of Finance's admins) took it on; she hears on her queue.
    _data_request(db_session, "dr_1", status="in_progress", assignee=OLGA)
    await db_session.commit()
    assert await hk.nudge_waiting_data_requests(db_session, now=ASKED + 3 * DAY) == (1, 0)
    assert await _told(db_session, "data_request.reminder") == {OLGA: [QUEUE], WALT: [WS_LINK], WREN: [WS_LINK]}


@pytest.mark.asyncio
async def test_the_person_who_asked_is_never_told_to_answer_it(world, db_session):
    # Walt, an admin of Finance, asked; Olga, on the platform team, asked another.
    _data_request(db_session, "dr_walt", by=WALT)
    _data_request(db_session, "dr_olga", by=OLGA)
    await db_session.commit()
    assert await hk.nudge_waiting_data_requests(db_session, now=ASKED + 8 * DAY) == (2, 2)
    reminded = await _told(db_session, "data_request.reminder")
    escalated = await _told(db_session, "data_request.escalated")
    assert reminded == {WALT: [WS_LINK], WREN: [WS_LINK, WS_LINK]}   # Walt for Olga's only
    assert escalated == {OLGA: [QUEUE], ROOT: [QUEUE, QUEUE]}         # Olga for Walt's only
    assert BEN not in reminded and ADA not in reminded


@pytest.mark.asyncio
async def test_nothing_is_brought_up_while_the_switch_is_off(world, db_session):
    _data_request(db_session, "dr_1", urgency="this_week")
    await db_session.commit()
    feature_flags._cache["dataRequestsEnabled"] = False
    assert await hk.nudge_waiting_data_requests(db_session, now=ASKED + 5 * DAY) == (0, 0)
    row = await _stored(db_session, DataRequestORM, "dr_1")
    assert (row.reminded_at, row.escalated_at) == (None, None)
    feature_flags._cache["dataRequestsEnabled"] = True
    assert await hk.nudge_waiting_data_requests(db_session, now=ASKED + 5 * DAY) == (1, 1)


@pytest.mark.asyncio
async def test_a_request_in_a_deleted_workspace_is_marked_done_without_a_word(world, db_session):
    _data_request(db_session, "dr_1", ws=GONE)
    await db_session.commit()
    assert await hk.nudge_waiting_data_requests(db_session, now=ASKED + 10 * DAY) == (0, 0)
    row = await _stored(db_session, DataRequestORM, "dr_1")
    assert row.reminded_at and row.escalated_at
    assert await _told(db_session, "data_request.reminder") == {}


@pytest.mark.asyncio
async def test_a_request_already_brought_up_never_holds_up_the_rest(world, db_session, monkeypatch):
    monkeypatch.setattr(hk, "_BATCH", 1)
    # The oldest has been reminded and isn't due its escalation yet; the newer one is due its reminder.
    _data_request(db_session, "dr_old", urgency="no_rush", asked=ASKED - DAY)
    _data_request(db_session, "dr_new", urgency="this_week", asked=ASKED)
    await db_session.commit()
    assert await hk.nudge_waiting_data_requests(db_session, now=ASKED + 7 * DAY - HOUR) == (1, 0)
    assert await hk.nudge_waiting_data_requests(db_session, now=ASKED + 7 * DAY - HOUR) == (1, 1)
    assert (await _stored(db_session, DataRequestORM, "dr_new")).escalated_at is not None


# ── Identity-provider link requests ──────────────────────────────────────


@pytest.mark.asyncio
async def test_a_link_request_reminds_the_platform_administrators_then_a_last_time(world, db_session):
    _link_request(db_session, "ilr_1")
    await db_session.commit()
    nudge = hk.nudge_waiting_idp_links

    assert await nudge(db_session, now=ASKED + 3 * DAY - HOUR) == (0, 0)
    assert await nudge(db_session, now=ASKED + 3 * DAY) == (1, 0)
    assert await _told(db_session, "idp_link.reminder") == {ROOT: [QUEUE]}   # not Olga: linking is system:admin
    assert await nudge(db_session, now=ASKED + 3 * DAY + HOUR) == (0, 0)
    assert await nudge(db_session, now=ASKED + 7 * DAY - HOUR) == (0, 0)
    assert await nudge(db_session, now=ASKED + 7 * DAY) == (0, 1)
    assert await _told(db_session, "idp_link.escalated") == {ROOT: [QUEUE]}
    assert await nudge(db_session, now=ASKED + 60 * DAY) == (0, 0)
    assert WALT not in await _told(db_session, "idp_link.reminder")

    notes = (await db_session.execute(
        select(NotificationORM).where(NotificationORM.kind.like("idp_link.%")).order_by(NotificationORM.kind)
    )).scalars().all()
    assert [(n.kind, n.title) for n in notes] == [
        ("idp_link.escalated", "Last reminder: Walt T is still waiting for Finance · Engineers to be linked to ML-Engineers"),
        ("idp_link.reminder", "Walt T is still waiting for Finance · Engineers to be linked to ML-Engineers"),
    ]
    assert {(n.resource_type, n.resource_id) for n in notes} == {("idp_link_request", "ilr_1")}


@pytest.mark.asyncio
async def test_answered_link_requests_are_left_alone_and_the_switch_does_not_matter(world, db_session):
    for status in ("linked", "declined", "cancelled"):
        _link_request(db_session, f"ilr_{status}", status=status, group=f"grp_{status}")
    _link_request(db_session, "ilr_waiting")
    await db_session.commit()
    feature_flags._cache["dataRequestsEnabled"] = False
    assert await hk.nudge_waiting_idp_links(db_session, now=ASKED + 10 * DAY) == (1, 1)
    for status in ("linked", "declined", "cancelled"):
        row = await _stored(db_session, IdpLinkRequestORM, f"ilr_{status}")
        assert (row.reminded_at, row.escalated_at) == (None, None)


@pytest.mark.asyncio
async def test_a_platform_administrator_who_asked_is_not_reminded_of_their_own(world, db_session):
    _link_request(db_session, "ilr_1", by=ROOT)
    await db_session.commit()
    assert await hk.nudge_waiting_idp_links(db_session, now=ASKED + 4 * DAY) == (1, 0)
    assert await _told(db_session, "idp_link.reminder") == {}


# ── The hourly pass ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_the_sweeper_sends_both_counts_them_and_a_second_run_sends_nothing(world, db_session, monkeypatch):
    from backend.app.jobs import metrics
    from tests.common.discussions_world import Counted

    counted = Counted()
    monkeypatch.setattr(metrics, "_backend", counted)
    now = datetime.now(timezone.utc)
    _data_request(db_session, "dr_1", urgency="this_week", asked=now - 4 * DAY)
    _link_request(db_session, "ilr_1", asked=now - 4 * DAY)
    await db_session.commit()

    async def sweep_once() -> None:
        shutdown = asyncio.Event()

        @contextlib.asynccontextmanager
        async def _open():
            yield db_session
            shutdown.set()   # one pass, then stop

        await asyncio.wait_for(hk.run_sweeper(_open, shutdown, interval=60), timeout=30)

    await sweep_once()
    await sweep_once()
    assert {k: len(v) for k, v in (await _told(db_session, "data_request.reminder")).items()} == {WALT: 1, WREN: 1}
    assert set(await _told(db_session, "data_request.escalated")) == {OLGA, ROOT}
    assert set(await _told(db_session, "idp_link.reminder")) == {ROOT}
    assert await _told(db_session, "idp_link.escalated") == {}
    assert counted.counts == {
        "data_requests_reminders_total": 1, "data_requests_escalated_total": 1,
        "idp_link_requests_reminders_total": 1,
    }
