"""Counting what API keys do: in each process's memory, written in batches.

What a request counts as — by what became of it — is pinned on the wire in
``test_api_key_auth``; this is the counter, and the table it adds to.
"""
from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.dialects import postgresql

from backend.app.db.models import ApiKeyORM, ApiKeyUsageORM, UserORM
from backend.app.db.repositories import api_key_usage_repo
from backend.app.services import api_key_usage
from backend.app.services.api_key_usage import UsageRecorder


def _factory(session):
    @asynccontextmanager
    async def _scope():
        yield session
    return _scope


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


async def _rows(session) -> dict:
    return {
        (r.key_id, r.day): (r.requests, r.writes, r.refused, r.errors)
        for r in (await session.execute(select(ApiKeyUsageORM))).scalars().all()
    }


# ── The counter ─────────────────────────────────────────────────────


async def test_counts_add_up_across_flushes(db_session):
    recorder = UsageRecorder()
    recorder.record("apk_1", write=True, refused=False, error=False)
    recorder.record("apk_1", write=False, refused=True, error=False)
    assert await recorder.flush(_factory(db_session)) == 1
    recorder.record("apk_1", write=False, refused=False, error=True)
    recorder.record("apk_2", write=False, refused=False, error=False)
    assert await recorder.flush(_factory(db_session)) == 2
    assert await recorder.flush(_factory(db_session)) == 0, "nothing new, nothing written"
    assert await _rows(db_session) == {
        ("apk_1", _today()): (3, 1, 1, 1),
        ("apk_2", _today()): (1, 0, 0, 0),
    }


async def test_a_request_belongs_to_the_day_it_was_made(db_session, monkeypatch):
    class _JustBeforeMidnight(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 10, 12, 23, 59, 59, tzinfo=timezone.utc)

    recorder = UsageRecorder()
    monkeypatch.setattr(api_key_usage, "datetime", _JustBeforeMidnight)
    recorder.record("apk_1", write=False, refused=False, error=False)
    monkeypatch.setattr(api_key_usage, "datetime", datetime)  # flushed after midnight
    await recorder.flush(_factory(db_session))
    assert await _rows(db_session) == {("apk_1", "2026-10-12"): (1, 0, 0, 0)}


def test_what_is_held_between_flushes_is_bounded(monkeypatch):
    monkeypatch.setattr(api_key_usage, "MAX_PENDING", 2)
    recorder = UsageRecorder()
    for key in ("apk_1", "apk_2", "apk_3"):
        recorder.record(key, write=False, refused=False, error=False)
    # A key already held keeps counting; a new one waits for the next flush.
    recorder.record("apk_1", write=True, refused=False, error=False)
    assert recorder._pending == {
        ("apk_1", _today()): [2, 1, 0, 0],
        ("apk_2", _today()): [1, 0, 0, 0],
    }


async def test_counts_that_cannot_be_written_wait_for_the_next_flush(db_session):
    recorder = UsageRecorder()
    recorder.record("apk_1", write=True, refused=False, error=False)

    @asynccontextmanager
    async def _unavailable():
        raise ConnectionError("database unavailable")
        yield  # pragma: no cover — never reached

    assert await recorder.flush(_unavailable) == 0
    recorder.record("apk_1", write=False, refused=False, error=False)
    assert await recorder.flush(_factory(db_session)) == 1
    assert await _rows(db_session) == {("apk_1", _today()): (2, 1, 0, 0)}


@pytest.mark.parametrize("method, reads, status, counts", [
    ("GET", None, 200, [1, 0, 0, 0]),
    ("PUT", None, 200, [1, 1, 0, 0]),
    ("POST", True, 200, [1, 0, 0, 0]),       # a search: a POST that only reads
    ("PUT", False, 401, [1, 0, 1, 0]),
    ("PUT", False, 403, [1, 0, 1, 0]),
    ("GET", True, 429, [1, 0, 1, 0]),
    ("DELETE", False, 409, [1, 0, 0, 1]),
    ("GET", True, 500, [1, 0, 0, 1]),
])
def test_a_request_is_counted_by_what_became_of_it(monkeypatch, method, reads, status, counts):
    recorder = UsageRecorder()
    monkeypatch.setattr(api_key_usage, "recorder", recorder)
    context = None if reads is None else SimpleNamespace(reads=reads)
    request = SimpleNamespace(
        method=method, state=SimpleNamespace(api_key_id="apk_1", api_key=context),
    )
    api_key_usage.record_request(request, status)
    assert recorder._pending == {("apk_1", _today()): counts}


def test_a_request_without_a_key_the_platform_knows_is_nobodys_usage(monkeypatch):
    recorder = UsageRecorder()
    monkeypatch.setattr(api_key_usage, "recorder", recorder)
    api_key_usage.record_request(SimpleNamespace(method="GET", state=SimpleNamespace()), 401)
    assert recorder._pending == {}


# ── The table ───────────────────────────────────────────────────────


class _Postgres:
    """A session on Postgres that keeps what it is asked to run."""

    def __init__(self):
        self.executed = []

    def get_bind(self):
        return SimpleNamespace(dialect=postgresql.dialect())

    async def execute(self, stmt):
        self.executed.append(stmt)


async def test_on_postgres_a_flush_adds_to_the_day_without_reading_it():
    """Any number of processes add to the same key and day: an increment
    in the insert itself, never a read and a write."""
    session = _Postgres()
    await api_key_usage_repo.add(session, [
        ("apk_b", "2026-10-13", 2, 1, 0, 0), ("apk_a", "2026-10-13", 1, 0, 0, 0),
    ])
    compiled = session.executed[0].compile(dialect=postgresql.dialect())
    sql = str(compiled)
    assert "ON CONFLICT (key_id, day) DO UPDATE SET" in sql
    for name in ("requests", "writes", "refused", "errors"):
        assert f"{name} = (api_key_usage.{name} + excluded.{name})" in sql
    # In key order, so two processes take their row locks in the same order.
    assert [compiled.params["key_id_m0"], compiled.params["key_id_m1"]] == ["apk_a", "apk_b"]

    session.executed.clear()
    await api_key_usage_repo.add(session, [
        (f"apk_{i:04}", "2026-10-13", 1, 0, 0, 0) for i in range(501)
    ])
    assert len(session.executed) == 2, "written in chunks"


async def test_a_keys_days_are_read_for_the_window_asked(db_session):
    days = api_key_usage_repo.last_days(31)
    await api_key_usage_repo.add(db_session, [
        ("apk_1", days[0], 9, 0, 0, 0),           # 30 days ago: outside
        ("apk_1", days[-1], 1, 1, 0, 0),
        ("apk_2", days[-1], 4, 0, 0, 0),
    ])
    assert await api_key_usage_repo.by_day(db_session, ["apk_1"], days=30) == {
        "apk_1": {days[-1]: (1, 1, 0, 0)},
    }
    assert await api_key_usage_repo.by_day(db_session, [], days=30) == {}


async def test_old_counts_and_counts_of_deleted_keys_are_pruned(db_session):
    db_session.add(UserORM(
        id="usr_p", email="p@example.com", password_hash="x", first_name="P",
        last_name="Q", status="active",
    ))
    await db_session.flush()
    db_session.add(ApiKeyORM(
        id="apk_live", user_id="usr_p", kind="personal", name="n",
        token_prefix="nxpat_aaaaaaaa", token_hash="h" * 64, permissions="{}",
        resources='"all"', created_at=datetime.now(timezone.utc).isoformat(),
    ))
    await db_session.flush()
    today = datetime.now(timezone.utc).date()
    kept = (today - timedelta(days=api_key_usage_repo.RETENTION_DAYS)).isoformat()
    gone = (today - timedelta(days=api_key_usage_repo.RETENTION_DAYS + 1)).isoformat()
    await api_key_usage_repo.add(db_session, [
        ("apk_live", today.isoformat(), 1, 0, 0, 0),
        ("apk_live", kept, 1, 0, 0, 0),
        ("apk_live", gone, 1, 0, 0, 0),
        ("apk_deleted", today.isoformat(), 1, 0, 0, 0),
    ])
    assert await api_key_usage_repo.prune(db_session) == 2
    assert set(await _rows(db_session)) == {("apk_live", today.isoformat()), ("apk_live", kept)}
