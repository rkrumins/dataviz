"""The activity ledger's relay against a REAL Postgres.

What the SQLite suite cannot see: that ``FOR UPDATE SKIP LOCKED`` really keeps
two relays off each other's events, that ``pg_try_advisory_xact_lock`` really
makes the retention sweeps take turns, that asyncpg accepts the multi-row
insert and the by-primary-key re-projection, and that a value Postgres itself
refuses is isolated to its own event instead of wedging every batch after it.

Run against a migrated SCRATCH database — the relay drains every pending
event it finds, not just these tests' (the schema CI recipe builds one)::

    ACTIVITY_TEST_DATABASE_URL=postgresql+asyncpg://user:pw@localhost/scratch \\
      python -m pytest backend/tests/integration/test_activity_ledger_live.py -q
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid

import pytest
from sqlalchemy import delete, func, insert, select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from backend.app.db.models import AuthAuditLogORM, OutboxEventORM
from backend.app.db.repositories import activity_repo
from backend.app.db.repositories.activity_repo import ActivityFilter
from backend.app.db.singleton import try_xact_lock
from backend.app.services import outbox_relay
from backend.app.services.activity import catalogue

pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(
        not os.getenv("ACTIVITY_TEST_DATABASE_URL"),
        reason="ACTIVITY_TEST_DATABASE_URL is unset (needs a migrated Postgres)",
    ),
]


@pytest.fixture
async def factory():
    engine = create_async_engine(os.environ["ACTIVITY_TEST_DATABASE_URL"], pool_size=4)
    yield async_sessionmaker(bind=engine, expire_on_commit=False)
    await engine.dispose()


@pytest.fixture
async def run_id(factory):
    """A prefix for this test's rows, and a clean slate on both sides of it."""
    prefix = f"evt_live{uuid.uuid4().hex[:8]}_"

    async def _clear():
        async with factory() as s, s.begin():
            await s.execute(delete(AuthAuditLogORM).where(
                AuthAuditLogORM.source_event_id.like(f"{prefix}%")))
            await s.execute(delete(OutboxEventORM).where(
                OutboxEventORM.id.like(f"{prefix}%")))

    yield prefix
    await _clear()


async def _emit(factory, prefix: str, n: int, *, payload=None) -> None:
    rows = [
        {
            "id": f"{prefix}{i:06d}", "event_type": "rbac.group.member_added",
            "event_version": 1, "aggregate_type": "group", "aggregate_id": "grp_1",
            "payload": json.dumps(payload(i) if payload else {
                "group_id": "grp_1", "user_id": f"usr_{i}", "actor_id": "usr_admin",
            }),
            "processed": False,
            "created_at": f"2026-10-10T10:{i // 60 % 60:02d}:{i % 60:02d}.{i:06d}+00:00",
        }
        for i in range(n)
    ]
    async with factory() as s, s.begin():
        await s.execute(insert(OutboxEventORM), rows)


async def _drain_until_dry(factory) -> int:
    recorded = 0
    while True:
        async with factory() as s, s.begin():
            got, claimed = await outbox_relay._drain_batch(s)
        recorded += got
        if claimed == 0:
            return recorded


async def _ledger_count(factory, prefix: str) -> int:
    async with factory() as s:
        return (await s.execute(
            select(func.count()).select_from(AuthAuditLogORM)
            .where(AuthAuditLogORM.source_event_id.like(f"{prefix}%"))
        )).scalar()


async def test_two_relays_never_record_an_event_twice(factory, run_id):
    await _emit(factory, run_id, 2_400)

    first, second = await asyncio.gather(
        _drain_until_dry(factory), _drain_until_dry(factory),
    )

    assert first + second >= 2_400
    assert await _ledger_count(factory, run_id) == 2_400
    async with factory() as s:
        pending = (await s.execute(
            select(func.count()).select_from(OutboxEventORM)
            .where(OutboxEventORM.id.like(f"{run_id}%"), OutboxEventORM.processed.is_(False))
        )).scalar()
    assert pending == 0


async def test_the_retention_lock_is_single_flight(factory):
    async with factory() as a, factory() as b:
        async with a.begin():
            assert await try_xact_lock(a, "gc:live-test") is True
            async with b.begin():
                assert await try_xact_lock(b, "gc:live-test") is False
        # A's commit released it.
        async with b.begin():
            assert await try_xact_lock(b, "gc:live-test") is True


async def test_a_value_postgres_refuses_costs_only_its_own_projection(
    factory, run_id, monkeypatch,
):
    real = catalogue.project

    def _project(**kwargs):
        out = real(**kwargs)
        if '"usr_1"' in (kwargs.get("payload") or ""):
            out["target_label"] = "nul\x00byte"  # Postgres TEXT refuses a NUL
        return out

    monkeypatch.setattr(catalogue, "project", _project)
    await _emit(factory, run_id, 3)

    await _drain_until_dry(factory)

    async with factory() as s:
        rows = {
            r.source_event_id: r for r in (await s.execute(
                select(AuthAuditLogORM)
                .where(AuthAuditLogORM.source_event_id.like(f"{run_id}%"))
            )).scalars()
        }
    assert len(rows) == 3
    refused = rows[f"{run_id}000001"]
    assert (refused.category, refused.target_label, refused.actor_id) == ("access", None, None)
    assert rows[f"{run_id}000002"].actor_id == "usr_admin"


async def test_history_is_reprojected_in_place(factory, run_id):
    await _emit(factory, run_id, 5)
    await _drain_until_dry(factory)
    async with factory() as s, s.begin():
        await s.execute(
            AuthAuditLogORM.__table__.update()
            .where(AuthAuditLogORM.source_event_id.like(f"{run_id}%"))
            .values(projection_version=0, category=None, actor_id=None)
        )

    while True:
        async with factory() as s, s.begin():
            if await outbox_relay.reproject_once(s) == 0:
                break

    async with factory() as s:
        rows = (await s.execute(
            select(AuthAuditLogORM)
            .where(AuthAuditLogORM.source_event_id.like(f"{run_id}%"))
        )).scalars().all()
    assert {(r.category, r.actor_id, r.projection_version) for r in rows} == {
        ("access", "usr_admin", catalogue.PROJECTION_VERSION),
    }


async def test_a_person_filter_never_walks_the_timeline(factory):
    """Newest-first over "this person, as actor or subject" is the query
    Postgres plans worst: it can walk the whole timeline index filtering row
    by row, which for a person with no events is every row in the ledger
    (80 s on ten million). The page must be read through the per-person
    indexes instead, one bounded scan each."""
    stmt = activity_repo.page_statement(
        ActivityFilter(person_ids=frozenset({"usr_nobody", "usr_somebody"})), limit=50,
    )
    sql = str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    async with factory() as s, s.begin():
        # A scratch ledger is too small for the planner to bother with
        # indexes at all; this asks which ones it reaches for when it must.
        await s.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join((await s.execute(text("EXPLAIN " + sql))).scalars())
    assert "idx_aal_actor_occurred" in plan and "idx_aal_subject_occurred" in plan, plan
    assert "idx_aal_occurred " not in plan and "idx_aal_occurred\n" not in plan, plan


async def test_the_workspace_lens_reads_its_own_index(factory):
    """A workspace admin reads only workspace-audience rows, and a workspace's
    view and group activity can far outnumber them. Through the full
    workspace index a page scanned past all of those first; the partial
    index holds exactly the rows the lens reads."""
    stmt = activity_repo.page_statement(
        ActivityFilter(audience="workspace", workspace_id="ws_lens_test"), limit=50,
    )
    sql = str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    async with factory() as s, s.begin():
        await s.execute(text("SET LOCAL enable_seqscan = off"))
        plan = "\n".join((await s.execute(text("EXPLAIN " + sql))).scalars())
    assert "idx_aal_workspace_lens" in plan, plan
