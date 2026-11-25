"""Repository: ``graph_seen``, ``graph_watches`` and ``graph_watch_told`` — how far each person has
looked at each versioned graph, what in it they watch (``endpoints/graph_digest.py``): the graph,
entities by urn and relationships by id (``kind`` ``node`` / ``edge``), and how far each watched
graph's watchers have been told (``digest.tell_pending``).

Every function of ``graph_seen`` and ``graph_watches`` but :func:`watchers` acts on one person's
rows, named by the caller from the signed-in user, never from the request: nobody reads or moves
anyone else's marker or watches.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Dict, List, Optional, Set, Tuple

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import GraphSeenORM, GraphWatchORM, GraphWatchToldORM

#: The entities and relationships one person may watch in one graph: the digest and the telling
#: read them all.
ENTITIES_MAX = 200


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
    """What this person watches in this graph: the graph itself (``entity_urn`` None), the
    entities and the relationships, oldest first."""
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
                entity_urn: Optional[str], *, kind: str = "node") -> None:
    """Watch the graph (``entity_urn`` None), one entity in it (``kind`` ``node``, by its urn) or
    one relationship (``edge``, by its id). Watching twice is watching once."""
    stmt = _insert(session)(GraphWatchORM).values(   # ``id``: the column's own default
        user_id=user_id, data_source_id=data_source_id, entity_urn=entity_urn, entity_kind=kind,
        created_at=_now())
    await session.execute(stmt.on_conflict_do_nothing())


async def unwatch(session: AsyncSession, user_id: str, data_source_id: str,
                  entity_urn: Optional[str], *, kind: str = "node") -> bool:
    """Stop watching the graph (``entity_urn`` None), one entity in it or one relationship
    (``kind``, as :func:`watch`). False: it wasn't watched."""
    which = (GraphWatchORM.entity_urn.is_(None) if entity_urn is None
             else (GraphWatchORM.entity_urn == entity_urn) & (GraphWatchORM.entity_kind == kind))
    result = await session.execute(delete(GraphWatchORM).where(
        GraphWatchORM.user_id == user_id, GraphWatchORM.data_source_id == data_source_id, which))
    return bool(result.rowcount)


async def watchers(session: AsyncSession, data_source_id: str
                   ) -> Dict[str, Tuple[bool, Set[Tuple[str, str]]]]:
    """Everyone watching this graph or something in it, all of them (``ix_graph_watches_ds``):
    user → (whether they watch the whole graph, what they watch in it: ``(kind, urn)``, a
    relationship's id in place of a urn)."""
    out: Dict[str, Tuple[bool, Set[Tuple[str, str]]]] = {}
    for user_id, urn, kind in (await session.execute(
            select(GraphWatchORM.user_id, GraphWatchORM.entity_urn, GraphWatchORM.entity_kind)
            .where(GraphWatchORM.data_source_id == data_source_id))).all():
        whole, watched = out.get(user_id, (False, set()))
        if urn is None:
            whole = True
        else:
            watched.add((kind, urn))
        out[user_id] = (whole, watched)
    return out


# ── How far a graph's watchers have been told ─────────────────────────────────────────────────────
async def start_telling(session: AsyncSession, data_source_id: str, head: int) -> None:
    """Tell this graph's watchers of what its published line gains past ``head``, unless they are
    told already: its marker, made once, by the first watch of it."""
    stmt = _insert(session)(GraphWatchToldORM).values(
        data_source_id=data_source_id, told_seq=head, updated_at=_now())
    await session.execute(stmt.on_conflict_do_nothing(index_elements=["data_source_id"]))


async def markers(session: AsyncSession, *, after: str, limit: int
                  ) -> List[Tuple[str, Optional[int], Optional[int]]]:
    """Watched graphs' markers past the data source ``after``, at most ``limit``, in order (the
    primary key's range): ``(data_source_id, told_seq, round_to)``."""
    return [(ds, told, to) for ds, told, to in (await session.execute(
        select(GraphWatchToldORM.data_source_id, GraphWatchToldORM.told_seq,
               GraphWatchToldORM.round_to)
        .where(GraphWatchToldORM.data_source_id > after)
        .order_by(GraphWatchToldORM.data_source_id).limit(limit))).all()]


async def claim(session: AsyncSession, data_source_id: str) -> Optional[GraphWatchToldORM]:
    """This graph's marker, held until the transaction ends; None while another worker holds it
    (``SKIP LOCKED``), or when there is none."""
    return (await session.execute(
        select(GraphWatchToldORM).where(GraphWatchToldORM.data_source_id == data_source_id)
        .with_for_update(skip_locked=True))).scalar_one_or_none()
