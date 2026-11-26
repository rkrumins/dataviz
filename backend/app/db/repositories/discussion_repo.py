"""Repository: discussions, discussion_messages, discussion_participants and watches —
the ``collaboration`` domain's tables.

No business logic here — ``backend.app.services.discussions`` owns access, routing,
notifications and outbox events. This module wraps the tables' reads and writes:
keyset pages (``(last_activity_at, id)`` for threads, ``(created_at, id)`` for
messages, behind an opaque cursor like ``activity_repo``'s), the conditional UPDATEs
that keep a thread's counters and guard its version, and participant upserts.
"""
from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import and_, case, delete, exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from backend.app.db.models import (
    DiscussionMessageORM,
    DiscussionORM,
    DiscussionParticipantORM,
    WatchORM,
)

#: Replies a thread takes, at most (plus its question).
REPLIES_MAX = 500
#: People in one thread, at most.
PARTICIPANTS_MAX = 200

_CURSOR = re.compile(r"^(\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]+)\|([A-Za-z0-9_\-]+)$")


class InvalidCursor(ValueError):
    """A page cursor this API did not issue."""


class TooManyParticipants(Exception):
    """Adding someone would take a thread past :data:`PARTICIPANTS_MAX`."""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def encode_cursor(at: str, row_id: str) -> str:
    """Where the next page starts, opaque and URL-safe."""
    return base64.urlsafe_b64encode(f"{at}|{row_id}".encode()).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        raw = base64.urlsafe_b64decode((cursor or "") + "=" * (-len(cursor or "") % 4)).decode()
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise InvalidCursor(cursor)
    match = _CURSOR.match(raw)
    if not match:
        raise InvalidCursor(cursor)
    return match.group(1), match.group(2)


def before(at_col, id_col, cursor: Optional[str]):
    """Rows strictly before ``cursor`` in ``(at, id)`` descending order, or ``None``."""
    if not cursor:
        return None
    at, row_id = decode_cursor(cursor)
    return or_(at_col < at, and_(at_col == at, id_col < row_id))


def mentions_of(raw: Optional[str]) -> list[str]:
    try:
        value = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return [str(v) for v in value] if isinstance(value, list) else []


def names_of(raw: Optional[str]) -> Optional[list[str]]:
    """A thread's stored entity path: its names, or None when there is none (or it can't be read)."""
    try:
        value = json.loads(raw) if raw else None
    except (TypeError, ValueError):
        return None
    if not isinstance(value, list):
        return None
    return [str(v) for v in value] or None


# ── Threads ──────────────────────────────────────────────────────────


async def get(session: AsyncSession, discussion_id: str) -> Optional[DiscussionORM]:
    """One thread, deleted or not, as the database has it now."""
    return (await session.execute(
        select(DiscussionORM).where(DiscussionORM.id == discussion_id).execution_options(populate_existing=True)
    )).scalar_one_or_none()


def live():
    return and_(DiscussionORM.deleted_at.is_(None), DiscussionORM.archived_at.is_(None))


async def page(session: AsyncSession, *where, cursor: Optional[str], limit: int) -> tuple[list[DiscussionORM], bool]:
    """A page of live threads, most recently active first, and whether more follow."""
    stmt = select(DiscussionORM).where(live(), *where)
    after = before(DiscussionORM.last_activity_at, DiscussionORM.id, cursor)
    if after is not None:
        stmt = stmt.where(after)
    rows = list((await session.execute(
        stmt.order_by(DiscussionORM.last_activity_at.desc(), DiscussionORM.id.desc()).limit(limit + 1)
    )).scalars().all())
    return rows[:limit], len(rows) > limit


async def counts(session: AsyncSession, *where) -> tuple[dict[str, int], Optional[str], dict[str, dict[str, int]]]:
    """``({status: n}, newest updated_at, {entity_id: {open, total}})`` over live threads."""
    by_status = dict((await session.execute(
        select(DiscussionORM.status, func.count()).where(live(), *where).group_by(DiscussionORM.status)
    )).all())
    newest = await latest(session, *where)
    by_entity = {
        entity: {"open": int(n_open or 0), "total": int(n)}
        for entity, n, n_open in (await session.execute(
            select(DiscussionORM.entity_id, func.count(),
                   func.sum(case((DiscussionORM.status == "open", 1), else_=0)))
            .where(live(), DiscussionORM.entity_id.is_not(None), *where).group_by(DiscussionORM.entity_id)
        )).all()
    }
    return {k: int(v) for k, v in by_status.items()}, newest, by_entity


async def latest(session: AsyncSession, *where) -> Optional[str]:
    """When anything in these live threads last changed."""
    return (await session.execute(select(func.max(DiscussionORM.updated_at)).where(live(), *where))).scalar()


def unread_for(user_id: str):
    """SQL: the thread has something new for ``user_id``, who is in it."""
    return and_(
        DiscussionParticipantORM.discussion_id == DiscussionORM.id,
        DiscussionParticipantORM.user_id == user_id,
        DiscussionORM.last_message_by != user_id,
        or_(DiscussionParticipantORM.last_read_at.is_(None),
            DiscussionORM.last_activity_at > DiscussionParticipantORM.last_read_at),
    )


async def count_unread(session: AsyncSession, user_id: str, *where) -> int:
    return int((await session.execute(
        select(func.count()).select_from(DiscussionORM).join(
            DiscussionParticipantORM, DiscussionParticipantORM.discussion_id == DiscussionORM.id,
        ).where(live(), unread_for(user_id), *where)
    )).scalar() or 0)


def _on(subject_type: str, subject_ids: Iterable[str]) -> list:
    return [DiscussionORM.subject_type == subject_type, DiscussionORM.subject_id.in_(sorted(set(subject_ids)))]


async def counts_by_subject(
    session: AsyncSession, subject_type: str, subject_ids: Iterable[str], seen,
) -> dict[str, dict[str, tuple[int, int]]]:
    """``{subject_id: {status: (live threads, those matching seen)}}`` in one GROUP BY —
    ``seen`` being what someone sees short of every private thread."""
    out: dict[str, dict[str, tuple[int, int]]] = {}
    for sid, status, n, n_seen in (await session.execute(
        select(DiscussionORM.subject_id, DiscussionORM.status, func.count(), func.sum(case((seen, 1), else_=0)))
        .where(live(), *_on(subject_type, subject_ids))
        .group_by(DiscussionORM.subject_id, DiscussionORM.status)
    )).all():
        out.setdefault(sid, {})[status] = (int(n), int(n_seen or 0))
    return out


async def unread_by_subject(
    session: AsyncSession, user_id: str, subject_type: str, subject_ids: Iterable[str],
) -> dict[str, int]:
    """:func:`count_unread` per subject, in one GROUP BY."""
    return {sid: int(n) for sid, n in (await session.execute(
        select(DiscussionORM.subject_id, func.count()).select_from(DiscussionORM).join(
            DiscussionParticipantORM, DiscussionParticipantORM.discussion_id == DiscussionORM.id,
        ).where(live(), unread_for(user_id), *_on(subject_type, subject_ids)).group_by(DiscussionORM.subject_id)
    )).all()}


async def bump_for_reply(session: AsyncSession, discussion_id: str, *, author_id: str, now: str) -> bool:
    """One reply's counters, in one conditional UPDATE: only while the thread is live,
    not closed and not full. ``first_response_at`` is the first reply by anyone but
    the asker. False when the thread can't take it."""
    result = await session.execute(
        update(DiscussionORM).where(
            DiscussionORM.id == discussion_id, live(), DiscussionORM.status != "closed",
            DiscussionORM.message_count <= REPLIES_MAX,
        ).values(
            message_count=DiscussionORM.message_count + 1, last_activity_at=now, last_message_by=author_id,
            updated_at=now,
            first_response_at=case(
                (and_(DiscussionORM.first_response_at.is_(None), DiscussionORM.asked_by != author_id), now),
                else_=DiscussionORM.first_response_at,
            ),
        ).execution_options(synchronize_session=False)
    )
    return (result.rowcount or 0) == 1


async def change(session: AsyncSession, discussion_id: str, *, expected_version: int, **values) -> bool:
    """A version-checked change to a live thread (status, answer, deletion), bumping
    ``version``. False when the thread moved on since ``expected_version``."""
    result = await session.execute(
        update(DiscussionORM).where(
            DiscussionORM.id == discussion_id, live(), DiscussionORM.version == expected_version,
        ).values(version=DiscussionORM.version + 1, **values).execution_options(synchronize_session=False)
    )
    return (result.rowcount or 0) == 1


async def drop_answer(session: AsyncSession, discussion_id: str, message_id: str, *, now: str) -> bool:
    """The accepted answer was deleted: un-accept it (an answered thread is open again;
    a closed one stays closed). False when it wasn't the answer."""
    answered = DiscussionORM.status == "answered"
    result = await session.execute(
        update(DiscussionORM).where(
            DiscussionORM.id == discussion_id, DiscussionORM.answer_message_id == message_id,
        ).values(
            answer_message_id=None, version=DiscussionORM.version + 1, updated_at=now,
            status=case((answered, "open"), else_=DiscussionORM.status),
            resolved_at=case((answered, None), else_=DiscussionORM.resolved_at),
            resolved_by=case((answered, None), else_=DiscussionORM.resolved_by),
        ).execution_options(synchronize_session=False)
    )
    return (result.rowcount or 0) == 1


async def soft_delete(session: AsyncSession, discussion_id: str, *, actor_id: str, now: str) -> None:
    await session.execute(
        update(DiscussionORM).where(DiscussionORM.id == discussion_id, DiscussionORM.deleted_at.is_(None))
        .values(deleted_at=now, deleted_by=actor_id, updated_at=now, version=DiscussionORM.version + 1)
        .execution_options(synchronize_session=False)
    )


async def touch(session: AsyncSession, discussion_id: str, now: str, **values) -> None:
    """Note that something in the thread changed (a pollers' ``updatedSince``)."""
    await session.execute(
        update(DiscussionORM).where(DiscussionORM.id == discussion_id).values(updated_at=now, **values)
        .execution_options(synchronize_session=False)
    )


# ── Messages ─────────────────────────────────────────────────────────


async def message(session: AsyncSession, message_id: str) -> Optional[DiscussionMessageORM]:
    return (await session.execute(
        select(DiscussionMessageORM).where(DiscussionMessageORM.id == message_id)
        .execution_options(populate_existing=True)
    )).scalar_one_or_none()


async def message_by_key(session: AsyncSession, author_id: str, client_key: str) -> Optional[DiscussionMessageORM]:
    """What this author already posted with this key — a retry's original."""
    return (await session.execute(
        select(DiscussionMessageORM).where(
            DiscussionMessageORM.author_id == author_id, DiscussionMessageORM.client_key == client_key,
        )
    )).scalar_one_or_none()


async def soft_delete_messages(session: AsyncSession, discussion_id: str, *, actor_id: str, now: str) -> None:
    """Delete a thread's question and replies in one UPDATE (one deleted before keeps its
    own stamp), so retention blanks them all."""
    await session.execute(
        update(DiscussionMessageORM).where(
            DiscussionMessageORM.discussion_id == discussion_id, DiscussionMessageORM.deleted_at.is_(None),
        ).values(deleted_at=now, deleted_by=actor_id, version=DiscussionMessageORM.version + 1)
        .execution_options(synchronize_session=False)
    )


async def messages(
    session: AsyncSession, discussion_id: str, *, cursor: Optional[str], since: Optional[str], limit: int,
) -> tuple[list[DiscussionMessageORM], Optional[str]]:
    """Oldest → newest. The newest ``limit``, or those before ``cursor``, with the cursor
    of the page before them; or everything created, edited or deleted after ``since``."""
    stmt = select(DiscussionMessageORM).where(DiscussionMessageORM.discussion_id == discussion_id)
    if since:
        rows = (await session.execute(stmt.where(or_(
            DiscussionMessageORM.created_at > since, DiscussionMessageORM.edited_at > since,
            DiscussionMessageORM.deleted_at > since,
        )).order_by(DiscussionMessageORM.created_at, DiscussionMessageORM.id).limit(limit))).scalars().all()
        return list(rows), None
    after = before(DiscussionMessageORM.created_at, DiscussionMessageORM.id, cursor)
    if after is not None:
        stmt = stmt.where(after)
    rows = list((await session.execute(
        stmt.order_by(DiscussionMessageORM.created_at.desc(), DiscussionMessageORM.id.desc()).limit(limit + 1)
    )).scalars().all())
    older = encode_cursor(rows[limit - 1].created_at, rows[limit - 1].id) if len(rows) > limit else None
    return list(reversed(rows[:limit])), older


async def edit_message(session: AsyncSession, message_id: str, *, expected_version: int, **values) -> bool:
    result = await session.execute(
        update(DiscussionMessageORM).where(
            DiscussionMessageORM.id == message_id, DiscussionMessageORM.deleted_at.is_(None),
            DiscussionMessageORM.version == expected_version,
        ).values(version=DiscussionMessageORM.version + 1, **values).execution_options(synchronize_session=False)
    )
    return (result.rowcount or 0) == 1


# ── Participants ─────────────────────────────────────────────────────


async def participant(
    session: AsyncSession, discussion_id: str, user_id: str,
) -> Optional[DiscussionParticipantORM]:
    return (await session.execute(
        select(DiscussionParticipantORM).where(
            DiscussionParticipantORM.discussion_id == discussion_id,
            DiscussionParticipantORM.user_id == user_id,
        ).execution_options(populate_existing=True)
    )).scalar_one_or_none()


async def participants(
    session: AsyncSession, discussion_id: str, user_ids: Optional[Iterable[str]] = None,
) -> dict[str, DiscussionParticipantORM]:
    stmt = select(DiscussionParticipantORM).where(DiscussionParticipantORM.discussion_id == discussion_id)
    if user_ids is not None:
        stmt = stmt.where(DiscussionParticipantORM.user_id.in_(sorted(set(user_ids))))
    return {p.user_id: p for p in (await session.execute(stmt)).scalars().all()}


async def mine(session: AsyncSession, discussion_ids: list[str], user_id: str) -> dict[str, DiscussionParticipantORM]:
    """The caller's participant row in each of a page of threads."""
    if not discussion_ids:
        return {}
    rows = (await session.execute(select(DiscussionParticipantORM).where(
        DiscussionParticipantORM.discussion_id.in_(discussion_ids), DiscussionParticipantORM.user_id == user_id,
    ))).scalars().all()
    return {p.discussion_id: p for p in rows}


async def recent_people(session: AsyncSession, discussion_ids: list[str], *, per: int = 6) -> dict[str, list[str]]:
    """The ``per`` people most recently active in each thread, in one read."""
    if not discussion_ids:
        return {}
    at = func.coalesce(DiscussionParticipantORM.posted_at, DiscussionParticipantORM.created_at)
    ranked = select(
        DiscussionParticipantORM.discussion_id, DiscussionParticipantORM.user_id, at.label("at"),
        func.row_number().over(partition_by=DiscussionParticipantORM.discussion_id,
                               order_by=(at.desc(), DiscussionParticipantORM.user_id)).label("rn"),
    ).where(DiscussionParticipantORM.discussion_id.in_(discussion_ids)).subquery()
    out: dict[str, list[str]] = {d: [] for d in discussion_ids}
    for did, uid, _at, _rn in (await session.execute(
        select(ranked).where(ranked.c.rn <= per).order_by(ranked.c.discussion_id, ranked.c.rn)
    )).all():
        out[did].append(uid)
    return out


async def join(
    session: AsyncSession, thread_id: str, user_id: str, joined_via: str, *, now: str, **fields,
) -> Optional[DiscussionParticipantORM]:
    """Add someone to a thread, counting them in its ``participant_count`` — unless it
    already has :data:`PARTICIPANTS_MAX` (:class:`TooManyParticipants`). ``None`` when
    they were already in it (a concurrent join won)."""
    try:
        async with session.begin_nested():
            bumped = await session.execute(
                update(DiscussionORM).where(
                    DiscussionORM.id == thread_id, DiscussionORM.participant_count < PARTICIPANTS_MAX,
                ).values(participant_count=DiscussionORM.participant_count + 1)
                .execution_options(synchronize_session=False)
            )
            if (bumped.rowcount or 0) != 1:
                raise TooManyParticipants(thread_id)
            row = DiscussionParticipantORM(discussion_id=thread_id, user_id=user_id, joined_via=joined_via,
                                           created_at=now, **fields)
            session.add(row)
            await session.flush()
            return row
    except IntegrityError:
        return None


# ── Watches ──────────────────────────────────────────────────────────


async def is_watching(session: AsyncSession, user_id: str, subject_type: str, subject_id: str) -> bool:
    return (await session.execute(select(WatchORM.id).where(
        WatchORM.user_id == user_id, WatchORM.subject_type == subject_type, WatchORM.subject_id == subject_id,
    ))).first() is not None


async def watch(session: AsyncSession, user_id: str, subject_type: str, subject_id: str, *, now: str) -> None:
    """Start watching (already watching is fine, even when a concurrent request won)."""
    try:
        async with session.begin_nested():
            session.add(WatchORM(user_id=user_id, subject_type=subject_type, subject_id=subject_id, created_at=now))
            await session.flush()
    except IntegrityError:
        pass                                            # already watching: nothing to add


async def unwatch(session: AsyncSession, user_id: str, subject_type: str, subject_id: str) -> None:
    await session.execute(delete(WatchORM).where(
        WatchORM.user_id == user_id, WatchORM.subject_type == subject_type, WatchORM.subject_id == subject_id,
    ))


async def watches_page(session: AsyncSession, user_id: str, *, cursor: Optional[str],
                       limit: int) -> tuple[list[WatchORM], bool]:
    """What someone watches, newest first, and whether more follow."""
    stmt = select(WatchORM).where(WatchORM.user_id == user_id)
    after = before(WatchORM.created_at, WatchORM.id, cursor)
    if after is not None:
        stmt = stmt.where(after)
    rows = list((await session.execute(
        stmt.order_by(WatchORM.created_at.desc(), WatchORM.id.desc()).limit(limit + 1)
    )).scalars().all())
    return rows[:limit], len(rows) > limit


async def watchers_after(session: AsyncSession, subject_type: str, subject_id: str, after: Optional[str],
                         limit: int) -> list[str]:
    """The next ``limit`` watchers of a subject after ``after``, in the unique index's order."""
    stmt = select(WatchORM.user_id).where(WatchORM.subject_type == subject_type, WatchORM.subject_id == subject_id)
    if after:
        stmt = stmt.where(WatchORM.user_id > after)
    return list((await session.execute(stmt.order_by(WatchORM.user_id).limit(limit))).scalars().all())


def visible_to(user_id: str):
    """SQL: a thread anyone who reads its subject sees — open — or a private one ``user_id``
    is in. (The subject's maintainers and admins see more; that is decided per subject.)"""
    them = aliased(DiscussionParticipantORM)   # its own name: a caller may join the table too
    return or_(
        DiscussionORM.visibility == "open",
        exists(select(them.id).where(them.discussion_id == DiscussionORM.id, them.user_id == user_id)),
    )


async def open_counts(session: AsyncSession, refs: Iterable[tuple[str, str]], user_id: str) -> dict[tuple[str, str], int]:
    """Open threads ``user_id`` sees on each subject, in one GROUP BY."""
    refs = sorted(set(refs))
    if not refs:
        return {}
    rows = (await session.execute(
        select(DiscussionORM.subject_type, DiscussionORM.subject_id, func.count()).where(
            live(), DiscussionORM.status == "open", visible_to(user_id),
            or_(*[and_(DiscussionORM.subject_type == t, DiscussionORM.subject_id == i) for t, i in refs]),
        ).group_by(DiscussionORM.subject_type, DiscussionORM.subject_id)
    )).all()
    return {(t, i): int(n) for t, i, n in rows}


# ── Someone's own conversations ──────────────────────────────────────

BOXES = ("to-me", "mine", "mentions", "watching")


def box(name: str, user_id: str):
    """SQL for one of a person's boxes: asked of them, asked by them, mentioning them,
    or on what they watch (open threads, and private ones they are in)."""
    them = aliased(DiscussionParticipantORM)

    def theirs(*conds):
        return exists(select(them.id).where(them.discussion_id == DiscussionORM.id, them.user_id == user_id, *conds))

    if name == "to-me":
        return theirs(them.asked_to.is_(True))
    if name == "mine":
        return DiscussionORM.asked_by == user_id
    if name == "mentions":
        return theirs(them.mentioned_at.is_not(None))
    if name == "watching":
        return and_(exists(select(WatchORM.id).where(
            WatchORM.user_id == user_id, WatchORM.subject_type == DiscussionORM.subject_type,
            WatchORM.subject_id == DiscussionORM.subject_id,
        )), visible_to(user_id))
    raise ValueError(f"box must be one of {BOXES}, got {name!r}")


async def my_counts(session: AsyncSession, user_id: str) -> list:
    """Per subject, what is waiting for ``user_id`` in the threads they are in:
    ``(subject_type, subject_id, to_me_unread, waiting, mine_unread, mine_open,
    mentions_unread, unread)``. One GROUP BY over their participant rows."""
    p = DiscussionParticipantORM
    unread = and_(DiscussionORM.last_message_by != user_id,
                  or_(p.last_read_at.is_(None), DiscussionORM.last_activity_at > p.last_read_at))

    def n(*conds):
        return func.sum(case((and_(*conds), 1), else_=0))

    return list((await session.execute(
        select(
            DiscussionORM.subject_type, DiscussionORM.subject_id,
            n(p.asked_to.is_(True), unread),
            n(p.asked_to.is_(True), DiscussionORM.status == "open", p.posted_at.is_(None)),
            n(DiscussionORM.asked_by == user_id, unread),
            n(DiscussionORM.asked_by == user_id, DiscussionORM.status == "open"),
            n(p.mentioned_at.is_not(None), unread),
            n(unread),
        ).select_from(DiscussionORM).join(p, p.discussion_id == DiscussionORM.id)
        .where(p.user_id == user_id, live())
        .group_by(DiscussionORM.subject_type, DiscussionORM.subject_id)
    )).all())
