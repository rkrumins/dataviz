"""One runner per pass for background loops that more than one process hosts.

The audit relay, the retention sweeps and the analytics warmer run in the
control plane, and in a dev monolith that runs everything; a production
deployment runs two control planes, and a rolling update briefly runs an
old and a new one side by side. Each pass therefore claims a Postgres
advisory lock first — the same technique the aggregation reconcilers use —
and skips the pass when another process holds it.
"""
from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def claim_this_pass(session: AsyncSession, name: str) -> bool:
    """Whether this process should run the pass called ``name`` now.

    The lock is transaction-scoped, so it lets go when ``session``'s
    transaction ends: hold the session open for the whole pass. Off
    Postgres (the SQLite test database) there is only ever one process,
    so the answer is always yes. A failure to ask raises, and the loop
    skips the pass rather than risk running it twice.
    """
    dialect = getattr(getattr(session, "bind", None), "dialect", None)
    if getattr(dialect, "name", None) != "postgresql":
        return True
    got = (await session.execute(
        text("SELECT pg_try_advisory_xact_lock(hashtextextended(:name, 0))"),
        {"name": name},
    )).scalar()
    return bool(got)
