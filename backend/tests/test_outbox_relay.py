"""Phase 0 — outbox relay drains ``outbox_events`` into the
append-only ``auth_audit_log``.

Uses the per-test ``db_session`` (SQLite, all tables created from the
ORM) so the relay logic is exercised without a live Postgres.
"""
from __future__ import annotations

import asyncio
import json

import pytest
from sqlalchemy import select

from backend.app.db.models import AuthAuditLogORM, OutboxEventORM
from backend.app.db.repositories import user_repo
from backend.app.services.outbox_relay import drain_once


@pytest.mark.asyncio
async def test_drain_records_and_marks_processed(db_session):
    await user_repo.create_outbox_event(
        db_session,
        event_type="user.logged_in",
        payload={"user_id": "usr_1", "email": "a@b.com"},
    )

    recorded = await drain_once(db_session)
    assert recorded == 1

    audit = (
        await db_session.execute(select(AuthAuditLogORM))
    ).scalars().all()
    assert len(audit) == 1
    assert audit[0].event_type == "user.logged_in"
    assert json.loads(audit[0].payload)["user_id"] == "usr_1"
    assert audit[0].occurred_at  # carried from the source event

    ev = (await db_session.execute(select(OutboxEventORM))).scalars().one()
    assert ev.processed is True

    # Re-draining is a no-op — the processed flag filters it out.
    assert await drain_once(db_session) == 0


@pytest.mark.asyncio
async def test_drain_is_idempotent_on_source_event_id(db_session):
    """A crash between the audit insert and the processed commit leaves
    the event unprocessed; the next drain must not double-record."""
    ev = await user_repo.create_outbox_event(
        db_session, event_type="user.logged_out", payload={"user_id": "usr_2"},
    )
    assert await drain_once(db_session) == 1

    # Simulate the crash: processed never committed.
    ev.processed = False
    await db_session.flush()

    assert await drain_once(db_session) == 0  # already audited
    audit = (
        await db_session.execute(
            select(AuthAuditLogORM).where(
                AuthAuditLogORM.source_event_id == ev.id
            )
        )
    ).scalars().all()
    assert len(audit) == 1
    ev_after = (
        await db_session.execute(select(OutboxEventORM))
    ).scalars().one()
    assert ev_after.processed is True


@pytest.mark.asyncio
async def test_drain_empty_outbox_returns_zero(db_session):
    assert await drain_once(db_session) == 0


# ── The activity ledger: projection, ordering, resilience ───────────
#
# The relay is the one writer of the activity ledger, and it now projects
# each event into the indexed columns every activity read filters on. What
# is pinned below is what makes that safe to run on every control-plane
# replica against a whole outbox history: the projection is right, the
# newest events land first, a bad event costs only itself, and history is
# re-projected in the background when the catalogue improves.

from contextlib import asynccontextmanager

from backend.app.common import activity_context
from backend.app.common.activity_context import ActivityContext, Provenance
from backend.app.services import outbox_relay
from backend.app.services.activity import catalogue, recorder
from backend.app.services.outbox_relay import (
    canonical_timestamp,
    reproject_once,
    run_relay,
)


async def _ledger(db_session) -> list[AuthAuditLogORM]:
    rows = (await db_session.execute(select(AuthAuditLogORM))).scalars().all()
    for row in rows:
        await db_session.refresh(row)
    return list(rows)


async def _one(db_session) -> AuthAuditLogORM:
    rows = await _ledger(db_session)
    assert len(rows) == 1
    return rows[0]


@pytest.mark.asyncio
async def test_an_rbac_event_is_projected_onto_the_ledger(db_session):
    token = activity_context.bind(ActivityContext("req_9", "joins the data team"))
    try:
        await user_repo.create_outbox_event(
            db_session, "rbac.group.member_added",
            {"group_id": "grp_1", "user_id": "usr_2", "actor_id": "usr_1"},
        )
    finally:
        activity_context.reset(token)

    assert await drain_once(db_session) == 1
    row = await _one(db_session)
    assert (row.category, row.audience, row.outcome) == ("access", "platform", "success")
    assert (row.actor_id, row.actor_kind, row.subject_id) == ("usr_1", "user", "usr_2")
    assert (row.target_type, row.target_id) == ("group", "grp_1")
    assert row.stated_reason == "joins the data team"
    assert row.correlation_id == "req_9"
    assert row.event_version == 1
    assert row.projection_version == catalogue.PROJECTION_VERSION


@pytest.mark.asyncio
async def test_a_recorded_operation_files_under_its_workspace(db_session):
    await recorder.record_activity(
        db_session, event_type="aggregation.job.triggered",
        provenance=Provenance("usr_9", "upstream fixed", "req_7"),
        workspace_id="ws_1", data_source_id="ds_1",
        target_type="data_source", target_id="ds_1", target_label="Sales lineage",
    )
    await db_session.flush()

    assert await drain_once(db_session) == 1
    row = await _one(db_session)
    assert (row.category, row.audience) == ("operations", "workspace")
    assert (row.workspace_id, row.data_source_id) == ("ws_1", "ds_1")
    assert (row.target_type, row.target_id, row.target_label) == (
        "data_source", "ds_1", "Sales lineage",
    )
    assert (row.actor_id, row.stated_reason) == ("usr_9", "upstream fixed")
    assert row.event_version == recorder.ENVELOPE_VERSION


@pytest.mark.asyncio
async def test_a_malformed_payload_is_recorded_not_fatal(db_session):
    db_session.add(OutboxEventORM(
        id="evt_bad", event_type="rbac.group.member_added",
        payload="{not json", processed=False,
    ))
    await user_repo.create_outbox_event(db_session, "user.logged_in", {"user_id": "usr_1"})
    await db_session.flush()

    assert await drain_once(db_session) == 2
    bad = next(r for r in await _ledger(db_session) if r.source_event_id == "evt_bad")
    assert bad.payload == "{not json"  # the record is verbatim
    assert bad.category == "access"    # the projection is what the type implies
    assert bad.actor_id is None


@pytest.mark.asyncio
async def test_hostile_values_are_cleaned_before_they_reach_a_column(db_session):
    """A failed sign-in carries whatever the stranger typed. A lone surrogate
    or a NUL is a value Postgres refuses, which would wedge every batch it
    lands in; a bidi override would make the record read as something else."""
    await user_repo.create_outbox_event(
        db_session, "user.login_failed",
        {"email": "\ud800evil‮@x.io\x00", "reason": "bad_password"},
    )

    assert await drain_once(db_session) == 1
    row = await _one(db_session)
    assert row.target_label == "evil @x.io"
    assert (row.actor_id, row.actor_kind, row.outcome) == (None, "anonymous", "failure")
    assert "\\ud800" in row.payload  # the record keeps exactly what was emitted


@pytest.mark.asyncio
async def test_the_newest_events_are_recorded_first(db_session, monkeypatch):
    """An install upgrading into the relay has its whole history pending; the
    activity people come looking for is today's, so it must not wait behind
    a year of backlog."""
    monkeypatch.setattr(outbox_relay, "_BATCH", 2)
    for event_id, created in (
        ("evt_jan", "2026-01-01T00:00:00+00:00"),
        ("evt_mar", "2026-03-01T00:00:00+00:00"),
        ("evt_feb", "2026-02-01T00:00:00+00:00"),
    ):
        db_session.add(OutboxEventORM(
            id=event_id, event_type="user.logged_in", payload="{}",
            processed=False, created_at=created,
        ))
    await db_session.flush()

    assert await drain_once(db_session) == 2
    recorded = {r.source_event_id for r in await _ledger(db_session)}
    assert recorded == {"evt_mar", "evt_feb"}
    assert await drain_once(db_session) == 1


@pytest.mark.asyncio
async def test_a_partly_recorded_batch_records_only_the_rest(db_session):
    first = await user_repo.create_outbox_event(
        db_session, "user.logged_in", {"user_id": "usr_1"},
    )
    assert await drain_once(db_session) == 1
    first.processed = False  # the crash: the flag never committed
    await user_repo.create_outbox_event(db_session, "user.logged_out", {"user_id": "usr_1"})

    assert await drain_once(db_session) == 1
    assert len(await _ledger(db_session)) == 2
    pending = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.processed.is_(False))
    )).scalars().all()
    assert pending == []


@pytest.mark.asyncio
async def test_an_event_the_database_refuses_does_not_hold_back_the_batch(
    db_session, monkeypatch,
):
    """Defence in depth behind the cleaning: if the database refuses a row
    anyway, the batch is bisected down to the refused event, which is recorded
    with its type's projection — never left to block every batch after it."""
    real = catalogue.project

    def _project(**kwargs):
        out = real(**kwargs)
        if "poison" in (kwargs.get("payload") or ""):
            out["target_label"] = {"not": "storable"}  # the driver refuses it
        return out

    monkeypatch.setattr(catalogue, "project", _project)
    for i in range(6):
        await user_repo.create_outbox_event(db_session, "user.logged_in", {"user_id": f"usr_{i}"})
    await user_repo.create_outbox_event(
        db_session, "rbac.group.created", {"group_id": "grp_1", "note": "poison"},
    )

    assert await drain_once(db_session) == 7
    rows = await _ledger(db_session)
    assert sorted(r.actor_id for r in rows if r.event_type == "user.logged_in") == [
        f"usr_{i}" for i in range(6)
    ]
    refused = next(r for r in rows if r.event_type == "rbac.group.created")
    assert (refused.category, refused.target_label) == ("access", None)


def test_timestamps_are_canonical_so_text_order_is_time_order():
    assert canonical_timestamp("2026-10-10T10:00:00+00:00") == "2026-10-10T10:00:00.000000+00:00"
    assert canonical_timestamp("2026-10-10T12:00:00.5+02:00") == "2026-10-10T10:00:00.500000+00:00"
    assert canonical_timestamp("2026-10-10T10:00:00Z") == "2026-10-10T10:00:00.000000+00:00"
    assert canonical_timestamp("2026-10-10T10:00:00") == "2026-10-10T10:00:00.000000+00:00"
    assert canonical_timestamp("not a time") == "not a time"


@pytest.mark.asyncio
async def test_rows_recorded_under_an_older_catalogue_are_reprojected(db_session):
    payload = json.dumps({"group_id": "grp_1", "user_id": "usr_2", "actor_id": "usr_1"})
    db_session.add(AuthAuditLogORM(
        source_event_id="evt_old", event_type="rbac.group.member_added",
        payload=payload, occurred_at="2026-01-01T00:00:00.000000+00:00",
        projection_version=0,
    ))
    await db_session.flush()

    assert await reproject_once(db_session) == 1
    row = await _one(db_session)
    assert (row.category, row.actor_id, row.subject_id) == ("access", "usr_1", "usr_2")
    assert row.projection_version == catalogue.PROJECTION_VERSION
    # The record is never touched; only the projection is rebuilt.
    assert (row.payload, row.occurred_at) == (payload, "2026-01-01T00:00:00.000000+00:00")
    assert await reproject_once(db_session) == 0


@pytest.mark.asyncio
async def test_the_relay_drains_a_backlog_without_waiting_between_batches(
    db_session, monkeypatch,
):
    monkeypatch.setattr(outbox_relay, "_BATCH", 2)
    for i in range(5):
        await user_repo.create_outbox_event(db_session, "user.logged_in", {"user_id": f"usr_{i}"})

    @asynccontextmanager
    async def _factory():
        yield db_session

    # The relay turns to re-projection only once a batch comes back short —
    # that is, once the backlog is gone.
    idle = asyncio.Event()
    real_reproject = outbox_relay.reproject_once

    async def _reproject(session):
        idle.set()
        return await real_reproject(session)

    monkeypatch.setattr(outbox_relay, "reproject_once", _reproject)
    shutdown = asyncio.Event()
    # One tick is a minute: anything short of greedy draining would still be
    # waiting for its second batch when this gives up.
    task = asyncio.create_task(run_relay(_factory, shutdown, interval=60))
    await asyncio.wait_for(idle.wait(), timeout=2)
    shutdown.set()
    await asyncio.wait_for(task, timeout=2)
    assert len(await _ledger(db_session)) == 5
