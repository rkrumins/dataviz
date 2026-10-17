"""Announcing a change, at the only moment it is safe to announce it.

The rule this module exists to enforce: **a change is published after
its transaction commits, never before.** Publishing early is not a
latency optimisation, it is a correctness bug that produces permanently
stale clients with nothing in any log to show for it —

    1. the handler bumps ``notif:u_7`` while its transaction is open
    2. the client is told version 12 and refetches immediately
    3. it reads the pre-commit state — the new row is not visible yet
    4. it records "I have version 12" and stops asking
    5. the transaction commits; nobody is ever told again

— and in this codebase that mistake is not merely easy to make, it is
the default. ``get_db_session`` commits in the dependency's teardown,
*after* the handler returns (``db/engine.py``'s ``_session_scope``:
``yield session`` then ``await session.commit()``). So there is no line
a handler could put an explicit publish on that would be post-commit.

Hence :func:`publish_change_after_commit`, which registers the intent on
the session and lets SQLAlchemy fire it when the commit actually lands.
Callers state *what changed* next to the code that changed it; *when to
say so* is not their problem. A rollback discards the intent, so a
failed write announces nothing.

Delivery is best-effort by design — see ``registry`` for why a bump must
never be able to fail a write that already succeeded.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Iterable

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession

from .registry import get_registry

logger = logging.getLogger(__name__)

__all__ = ["publish_change_after_commit", "publish_change"]


_LISTENER_KEY = "_change_feed_listener_registered"
_PENDING_KEY = "_change_feed_pending_topics"

#: Strong references to in-flight bump tasks. ``asyncio`` only holds weak
#: references to tasks, so a fire-and-forget task with no owner can be
#: garbage-collected mid-await and vanish silently.
_inflight: set[asyncio.Task] = set()


def _schedule(topics: Iterable[str]) -> None:
    """Fire the bumps without blocking the committing path."""
    registry = get_registry()
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        # No loop (a synchronous script, a test driving the ORM
        # directly). Nothing is listening for changes in that world, so
        # dropping the notification is correct rather than fatal.
        return
    for topic in topics:
        task = loop.create_task(registry.bump(topic))
        _inflight.add(task)
        task.add_done_callback(_inflight.discard)


def _on_after_commit(sync_session) -> None:
    topics = sync_session.info.pop(_PENDING_KEY, None)
    if topics:
        _schedule(topics)


def _on_after_rollback(sync_session, previous_transaction) -> None:
    # The write did not happen, so neither did the change.
    #
    # Two positional arguments, not one: ``after_soft_rollback`` is
    # called as ``(session, previous_transaction)``. Getting this wrong
    # does not fail quietly — SQLAlchemy raises TypeError from inside the
    # rollback, which leaves the session wedged and cascades into
    # unrelated errors on every test that shares it.
    sync_session.info.pop(_PENDING_KEY, None)


def publish_change_after_commit(session: AsyncSession, *topics: str) -> None:
    """Publish ``topics`` when ``session``'s current transaction commits.

    Safe to call more than once per request and with overlapping topics:
    they accumulate into a set and each is published once. If the
    transaction rolls back, nothing is published.
    """
    if not topics:
        return
    sync_session = session.sync_session
    if not sync_session.info.get(_LISTENER_KEY):
        sync_session.info[_LISTENER_KEY] = True
        event.listen(sync_session, "after_commit", _on_after_commit)
        # ``after_soft_rollback`` rather than ``after_rollback``: it fires
        # for both a real rollback and the "rollback with nothing to undo"
        # case, and we want the pending set cleared either way.
        event.listen(sync_session, "after_soft_rollback", _on_after_rollback)
    pending = sync_session.info.setdefault(_PENDING_KEY, set())
    pending.update(topics)


async def publish_change(*topics: str) -> None:
    """Publish ``topics`` right now.

    For changes that are not part of a database transaction at all — a
    provider health sweep flipping state, an in-memory cache being
    invalidated. If a database write is involved, use
    :func:`publish_change_after_commit` instead; see this module's
    docstring for what publishing early costs.
    """
    registry = get_registry()
    for topic in topics:
        await registry.bump(topic)
