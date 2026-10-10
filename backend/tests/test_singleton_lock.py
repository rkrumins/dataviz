"""``try_xact_lock``: one replica at a time, for housekeeping every replica runs.

The retention sweeps run on every control-plane replica. The lock is what makes
them take turns instead of contending for the same rows, so its contract is
pinned here: a lock another transaction holds is skipped, never waited for; an
error on Postgres fails CLOSED (skipping one pass is strictly cheaper than two
replicas doing it); and a backend with no advisory locks is one process, so it
always proceeds. ``integration/test_activity_ledger_live.py`` exercises the
real Postgres function.
"""
from __future__ import annotations

import types

import pytest

from backend.app.db.singleton import try_xact_lock
from backend.app.services import product_event_gc, refresh_token_gc


class _Result:
    def __init__(self, value):
        self._value = value

    def scalar(self):
        return self._value


class _PgSession:
    """A session on Postgres whose advisory-lock answer is scripted."""

    def __init__(self, answer):
        self.bind = types.SimpleNamespace(dialect=types.SimpleNamespace(name="postgresql"))
        self._answer = answer
        self.statements: list[tuple[str, dict]] = []

    async def execute(self, stmt, params=None):
        self.statements.append((str(stmt), params or {}))
        if isinstance(self._answer, Exception):
            raise self._answer
        return _Result(self._answer)


async def test_the_lock_holder_proceeds():
    session = _PgSession(True)
    assert await try_xact_lock(session, "gc:product-events") is True
    sql, params = session.statements[0]
    assert "pg_try_advisory_xact_lock" in sql and "hashtextextended" in sql
    assert params == {"key": "gc:product-events"}


async def test_a_lock_another_replica_holds_is_skipped():
    assert await try_xact_lock(_PgSession(False), "gc:product-events") is False


async def test_an_error_on_postgres_fails_closed():
    assert await try_xact_lock(_PgSession(RuntimeError("boom")), "gc:x") is False


async def test_a_backend_without_advisory_locks_always_proceeds(db_session):
    # SQLite: a single process, so there is nobody to take turns with.
    assert await try_xact_lock(db_session, "gc:product-events") is True


@pytest.mark.parametrize("module, purge", [
    (product_event_gc, "purge_older_than"),
    (refresh_token_gc, "purge_expired"),
])
async def test_a_sweep_that_loses_the_lock_deletes_nothing(module, purge, monkeypatch):
    async def _never(*_a, **_k):
        raise AssertionError("swept without the lock")

    monkeypatch.setattr(module, purge, _never)
    assert await module.sweep_once(_PgSession(False)) == 0


@pytest.mark.parametrize("module, purge", [
    (product_event_gc, "purge_older_than"),
    (refresh_token_gc, "purge_expired"),
])
async def test_a_sweep_that_holds_the_lock_sweeps(module, purge, monkeypatch):
    async def _purge(*_a, **_k):
        return 7

    monkeypatch.setattr(module, purge, _purge)
    assert await module.sweep_once(_PgSession(True)) == 7


def test_each_sweep_has_its_own_key():
    # A shared key would make one sweep skip whenever the other ran.
    assert product_event_gc._LOCK_KEY != refresh_token_gc._LOCK_KEY
