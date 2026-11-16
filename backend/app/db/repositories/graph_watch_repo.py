"""Repository: ``graph_seen`` and ``graph_watches`` — how far each person has looked at each
versioned graph, and what in it they watch (``endpoints/graph_digest.py``).

Every function but :func:`watchers` acts on one person's rows, named by the caller from the
signed-in user, never from the request: nobody reads or moves anyone else's marker or watches.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional, Tuple

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import GraphSeenORM, GraphWatchORM

#: The entities one person may watch in one graph: the digest and a publish read them all.
ENTITIES_MAX = 200
#: The watches a publish reads, at most: who to tell is bounded however many watch.
WATCHERS_MAX = 5000


def _insert(session: AsyncSession):
    if session.get_bind().dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        from sqlalchemy.dialects.postgresql import insert
    return insert


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def seen(session: AsyncSession, user_id: str, data_source_id: str) -> Optional[GraphSeenORM]:
    """This person's marker for this graph, or None: they never marked it seen."""
    return await session.get(GraphSeenORM, (user_id, data_source_id))


async def mark_seen(session: AsyncSession, user_id: str, data_source_id: str, seq: int, *,
                    head: int) -> GraphSeenORM:
    """Move this person's marker to ``seq``. It only moves forward — save from past ``head``: such
    a marker is of an earlier graph of this data source (one deleted, then version control turned
    on again), whose versions were numbered afresh."""
    insert = _insert(session)
    stmt = insert(GraphSeenORM).values(user_id=user_id, data_source_id=data_source_id,
                                       seen_seq=seq, seen_at=_now())
    stmt = stmt.on_conflict_do_update(
        index_elements=["user_id", "data_source_id"],
        set_={"seen_seq": stmt.excluded.seen_seq, "seen_at": stmt.excluded.seen_at},
        where=(GraphSeenORM.seen_seq < stmt.excluded.seen_seq) | (GraphSeenORM.seen_seq > head),
    )
    await session.execute(stmt)
    await session.flush()
    row = await session.get(GraphSeenORM, (user_id, data_source_id), populate_existing=True)
    assert row is not None
    return row


async def advance_if_caught_up(session: AsyncSession, user_id: str, data_source_id: str,
                               seq: int) -> bool:
    """Someone who had seen everything before their own version ``seq`` has seen it too: their
    marker moves to it. Anyone else's stays where it was."""
    result = await session.execute(
        update(GraphSeenORM)
        .where(GraphSeenORM.user_id == user_id, GraphSeenORM.data_source_id == data_source_id,
               GraphSeenORM.seen_seq == seq - 1)
        .values(seen_seq=seq, seen_at=_now()))
    return bool(result.rowcount)


async def watches(session: AsyncSession, user_id: str, data_source_id: str) -> List[GraphWatchORM]:
    """What this person watches in this graph: the graph itself (``entity_urn`` None) and the
    entities, oldest first."""
    return list((await session.execute(
        select(GraphWatchORM)
        .where(GraphWatchORM.user_id == user_id, GraphWatchORM.data_source_id == data_source_id)
        .order_by(GraphWatchORM.created_at, GraphWatchORM.id)
        .limit(ENTITIES_MAX + 1)
    )).scalars().all())


async def entity_count(session: AsyncSession, user_id: str, data_source_id: str) -> int:
    return int(await session.scalar(
        select(func.count()).select_from(GraphWatchORM).where(
            GraphWatchORM.user_id == user_id, GraphWatchORM.data_source_id == data_source_id,
            GraphWatchORM.entity_urn.is_not(None))) or 0)


async def watch(session: AsyncSession, user_id: str, data_source_id: str,
                entity_urn: Optional[str]) -> None:
    """Watch the graph (``entity_urn`` None) or one entity in it. Watching twice is watching once."""
    stmt = _insert(session)(GraphWatchORM).values(   # ``id``: the column's own default
        user_id=user_id, data_source_id=data_source_id, entity_urn=entity_urn, created_at=_now())
    await session.execute(stmt.on_conflict_do_nothing())


async def unwatch(session: AsyncSession, user_id: str, data_source_id: str,
                  entity_urn: Optional[str]) -> bool:
    """Stop watching the graph (``entity_urn`` None) or one entity in it. False: it wasn't watched."""
    which = (GraphWatchORM.entity_urn.is_(None) if entity_urn is None
             else GraphWatchORM.entity_urn == entity_urn)
    result = await session.execute(delete(GraphWatchORM).where(
        GraphWatchORM.user_id == user_id, GraphWatchORM.data_source_id == data_source_id, which))
    return bool(result.rowcount)


async def watchers(session: AsyncSession, data_source_id: str) -> List[Tuple[str, Optional[str]]]:
    """Everyone watching this graph or an entity in it: ``(user_id, entity_urn)``, a graph watch's
    urn None. At most ``WATCHERS_MAX`` rows (``ix_graph_watches_ds``)."""
    return [(u, urn) for u, urn in (await session.execute(
        select(GraphWatchORM.user_id, GraphWatchORM.entity_urn)
        .where(GraphWatchORM.data_source_id == data_source_id)
        .limit(WATCHERS_MAX)
    )).all()]
