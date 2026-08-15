"""Publishing a change happens after the commit, or not at all.

This is the sharpest edge in the change feed, and the failure it guards
against is silent. Announce a change while its transaction is still
open and:

    1. the client is told version 12 and refetches at once
    2. it reads pre-commit state — the new row is not visible yet
    3. it records "I hold version 12" and stops asking
    4. the transaction commits; nobody is ever told again

The client is now permanently stale, showing old data, with no error
anywhere. Nothing in a log, nothing in a metric, and a reproduction that
depends on winning a race.

Getting this wrong is also the *default* in this codebase, which is why
the timing is not left to call sites: ``get_db_session`` commits in the
dependency's teardown, after the handler returns, so no line a handler
could write would be post-commit.
"""
from __future__ import annotations

import asyncio

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.changes import publish as publish_mod
from backend.app.changes.registry import InMemoryChangeRegistry


@pytest.fixture
def registry(monkeypatch):
    """Swap in a registry we can inspect, and drain scheduled bumps."""
    reg = InMemoryChangeRegistry()
    monkeypatch.setattr(publish_mod, "get_registry", lambda: reg)
    return reg


async def _drain():
    """Let the fire-and-forget bump tasks run.

    ``publish_change_after_commit`` schedules rather than awaits, because
    it fires from SQLAlchemy's synchronous ``after_commit`` hook and must
    not block the committing path.
    """
    for _ in range(5):
        await asyncio.sleep(0)


async def test_nothing_is_published_before_the_commit(
    db_session: AsyncSession, registry
):
    publish_mod.publish_change_after_commit(db_session, "announcements")
    await _drain()

    assert await registry.snapshot(["announcements"]) == {"announcements": 0}, (
        "the change was announced while the transaction was still open — a "
        "client refetching now would read pre-commit state and record the "
        "new version anyway"
    )


async def test_published_once_the_commit_lands(db_session: AsyncSession, registry):
    publish_mod.publish_change_after_commit(db_session, "announcements")
    await db_session.commit()
    await _drain()

    assert await registry.snapshot(["announcements"]) == {"announcements": 1}


async def test_a_rollback_publishes_nothing(db_session: AsyncSession, registry):
    """A write that did not happen is not a change.

    The write below is not decoration. Without an open transaction to
    roll back, SQLAlchemy never emits ``after_soft_rollback`` and this
    test passes whether or not the listener works at all — it passed
    against a listener with the wrong signature, which raised TypeError
    from inside every real rollback and wedged the session.
    """
    from backend.app.db.models import AnnouncementORM

    db_session.add(
        AnnouncementORM(
            id="ann_rollback_probe",
            title="never committed",
            message="never committed",
            banner_type="info",
            is_active=True,
        )
    )
    await db_session.flush()

    publish_mod.publish_change_after_commit(db_session, "announcements")
    await db_session.rollback()
    await _drain()

    assert await registry.snapshot(["announcements"]) == {"announcements": 0}


async def test_repeated_topics_publish_once_per_commit(
    db_session: AsyncSession, registry
):
    """Several writers in one request should not mean several bumps.

    ``notify`` alone can be called more than once per handler, and a
    version that advances three times where one change happened is not
    wrong — but it does cost every connected client a needless refetch.
    """
    publish_mod.publish_change_after_commit(db_session, "announcements")
    publish_mod.publish_change_after_commit(db_session, "announcements")
    publish_mod.publish_change_after_commit(db_session, "features")
    await db_session.commit()
    await _drain()

    assert await registry.snapshot(["announcements", "features"]) == {
        "announcements": 1,
        "features": 1,
    }


async def test_a_second_transaction_publishes_independently(
    db_session: AsyncSession, registry
):
    """The pending set must be cleared by the commit that drained it.

    The listener is attached once per session but the pending set is
    per-transaction. If the set leaked across commits, the second commit
    would re-announce the first one's topics — an ever-growing set of
    phantom changes on a long-lived session.
    """
    publish_mod.publish_change_after_commit(db_session, "announcements")
    await db_session.commit()
    await _drain()

    publish_mod.publish_change_after_commit(db_session, "features")
    await db_session.commit()
    await _drain()

    assert await registry.snapshot(["announcements", "features"]) == {
        "announcements": 1,   # NOT 2 — it must not ride along a second time
        "features": 1,
    }


async def test_publishing_no_topics_is_a_no_op(db_session: AsyncSession, registry):
    publish_mod.publish_change_after_commit(db_session)
    await db_session.commit()
    await _drain()

    assert await registry.snapshot(["announcements"]) == {"announcements": 0}
