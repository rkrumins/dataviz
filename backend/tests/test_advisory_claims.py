"""``claim_this_pass``: one process at a time, for loops several processes host.

The outbox relay, the retention sweeps and the analytics warmer run on every
control-plane replica, and in a dev monolith. The claim is what makes them take
turns, so its contract is pinned here: it is Postgres' transaction-scoped
advisory lock, asked for without waiting; a pass whose claim cannot be answered
is skipped, never run unguarded; and every loop claims its own lock, so one
never skips because another ran. ``test_housekeeping_loops.py`` pins that a
claim another process holds skips the pass, and
``integration/test_activity_ledger_live.py`` exercises the real function.
"""
from __future__ import annotations

import asyncio
import types
from contextlib import asynccontextmanager

import pytest

from backend.app.db.advisory import claim_this_pass
from backend.app.services import (
    analytics_warmer,
    outbox_relay,
    product_event_gc,
    refresh_token_gc,
)

_LOOPS = [
    (outbox_relay, "run_relay", "drain_once"),
    (refresh_token_gc, "run_sweeper", "sweep_once"),
    (product_event_gc, "run_sweeper", "sweep_once"),
    (analytics_warmer, "run_warmer", "warm_once"),
]


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
        return _Result(self._answer)


def _factory():
    @asynccontextmanager
    async def _scope():
        yield types.SimpleNamespace()
    return _scope


async def test_the_claim_is_a_transaction_lock_that_never_waits():
    session = _PgSession(True)
    assert await claim_this_pass(session, "outbox:relay") is True
    sql, params = session.statements[0]
    assert "pg_try_advisory_xact_lock" in sql and "hashtextextended" in sql
    assert params == {"name": "outbox:relay"}


async def test_a_claim_another_process_holds_is_refused():
    assert await claim_this_pass(_PgSession(False), "outbox:relay") is False


@pytest.mark.parametrize("module,loop,work", _LOOPS)
async def test_a_claim_that_cannot_be_answered_skips_the_pass(
    module, loop, work, monkeypatch,
):
    """The database went away mid-question: skipping one pass is strictly
    cheaper than two processes running it."""
    shutdown = asyncio.Event()

    async def _unanswerable(_session, _name):
        shutdown.set()
        raise RuntimeError("the database went away")

    async def _must_not_run(*_a, **_k):
        raise AssertionError(f"{module.__name__} ran a pass it could not claim")

    monkeypatch.setattr(module, "claim_this_pass", _unanswerable)
    monkeypatch.setattr(module, work, _must_not_run)
    await asyncio.wait_for(
        getattr(module, loop)(_factory(), shutdown, interval=3600), timeout=10,
    )


async def test_every_loop_claims_its_own_lock(monkeypatch):
    """A shared name would make one loop skip whenever another ran."""
    names: dict[str, str] = {}
    for module, loop, _work in _LOOPS:
        shutdown = asyncio.Event()

        async def _record(_session, name, _module=module, _shutdown=shutdown):
            names[_module.__name__] = name
            _shutdown.set()
            return False

        monkeypatch.setattr(module, "claim_this_pass", _record)
        await asyncio.wait_for(
            getattr(module, loop)(_factory(), shutdown, interval=3600), timeout=10,
        )
    assert len(names) == len(_LOOPS)
    assert len(set(names.values())) == len(_LOOPS), names
