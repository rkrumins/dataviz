"""Reads of the activity ledger (``auth_audit_log``).

Every filter the explorer offers is a SQL predicate on a promoted, indexed
column — never a pass over JSON after the ``LIMIT``, which is what made the
audit lens return short or empty pages — and every list is a keyset page on
``(occurred_at, id)``, so page 400 costs what page one does.

Single-table by construction (the ledger and the outbox it drains are both the
events domain): people, workspaces and sources are named afterwards, a batched
lookup per kind (``services/activity/names``).
"""
from __future__ import annotations

import base64
import binascii
import re
import statistics
from collections import defaultdict
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Iterator, Optional, Protocol

from sqlalchemy import and_, false, func, or_, select, text, tuple_, union_all
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AuthAuditLogORM as L
from backend.app.db.models import OutboxEventORM
from backend.app.db.repositories.analytics_repo import Window

#: Per-request noise the default lens leaves out: a refused request is logged
#: on every 403, so at any real volume it would bury what people did.
NOISE_TYPES = frozenset({
    "user.access_denied",
    # A key refused for being out of date — expired, or its owner paused or
    # suspended — once per key an hour while a script keeps calling. The
    # suspicious refusals are ``identity.api_key.misuse``, which stay.
    "identity.api_key.rejected",
})

#: Kinds of change a person can give a reason for. Sign-ins and views do not
#: ask for one, so they are left out of the reason-coverage figure rather
#: than dragging it towards zero.
REASONED_CATEGORIES = ("operations", "access", "data", "platform")

#: How many operations the cadence figures read at most — a ceiling on the
#: one query that returns rows rather than groups.
_CADENCE_ROWS = 10_000

#: Outbox events counted before the count stops (the probe wants "lots").
_PENDING_CAP = 10_000

#: A backlog this deep is history being imported, not a moment of lag.
_BACKFILL_PENDING = 1_000

#: The live "N new" check looks this far behind the watermark for events
#: that were recorded late, and no further: an event recorded now that
#: OCCURRED last year is the relay importing history, not news.
_NEWER_LOOKBACK = timedelta(minutes=10)

#: Most per-value scans one page is answered with (see :func:`_branches`):
#: enough for every person a name search can match (200) in either role.
#: Each costs one short index scan — measured on ten million rows, 4 ms for
#: one person, 30 ms for 25, under a second for 200.
_MAX_BRANCHES = 400

#: Longest a free-text search may read for. Every other filter is an index
#: range that stops at a page; a search must read its window until a page
#: fills — no match in 30 days of a ten-million-row year took 1.4 s — so it
#: is the one read bounded by time instead.
_SEARCH_TIMEOUT_MS = 8_000
_QUERY_CANCELED = "57014"

_CURSOR = re.compile(r"^(\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]+)\|([A-Za-z0-9_\-]+)$")
_TOP = 10
#: Faces shown per hands-on source: who keeps doing it, not everyone who did.
_FACES = 3


class InvalidCursor(ValueError):
    """A page cursor this API did not issue."""


class SearchTooBroad(Exception):
    """A text search used its time budget before it filled a page."""


@dataclass(frozen=True)
class ActivityFilter:
    """What to read. Every field narrows; ``None`` means "no filter"."""

    since: Optional[str] = None
    until: Optional[str] = None
    categories: tuple[str, ...] = ()
    #: Exact types, or ``prefix.*``.
    event_types: tuple[str, ...] = ()
    #: People resolved from what was typed. An EMPTY set is a real answer —
    #: nobody matched — and filters to nothing; ``None`` is no filter.
    actor_ids: Optional[frozenset[str]] = None
    #: The people it happened TO.
    subject_ids: Optional[frozenset[str]] = None
    #: Actor OR subject: everything that involved these people.
    person_ids: Optional[frozenset[str]] = None
    workspace_id: Optional[str] = None
    data_source_id: Optional[str] = None
    target_type: Optional[str] = None
    target_id: Optional[str] = None
    outcome: Optional[str] = None
    has_reason: Optional[bool] = None
    #: Everything one API key did, and everything that happened to it.
    api_key_id: Optional[str] = None
    include_noise: bool = False
    text: Optional[str] = None
    #: Forced to ``workspace`` for a workspace admin's read.
    audience: Optional[str] = None


def _like(term: str) -> str:
    escaped = term.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def predicates(f: ActivityFilter, *, window: bool = True) -> list[Any]:
    """``f`` as SQL. ``window=False`` leaves out the time bounds."""
    out: list[Any] = []
    if window and f.since:
        out.append(L.occurred_at >= f.since)
    if window and f.until:
        out.append(L.occurred_at < f.until)
    if f.audience:
        out.append(L.audience == f.audience)
    if f.categories:
        out.append(L.category.in_(f.categories))
    if f.event_types:
        exact = [t for t in f.event_types if not t.endswith("*")]
        clauses = [L.event_type.in_(exact)] if exact else []
        clauses += [
            L.event_type.startswith(t[:-1], autoescape=True)
            for t in f.event_types if t.endswith("*")
        ]
        out.append(or_(*clauses))
    if f.actor_ids is not None:
        out.append(L.actor_id.in_(sorted(f.actor_ids)) if f.actor_ids else false())
    if f.subject_ids is not None:
        out.append(L.subject_id.in_(sorted(f.subject_ids)) if f.subject_ids else false())
    if f.person_ids is not None:
        ids = sorted(f.person_ids)
        out.append(or_(L.actor_id.in_(ids), L.subject_id.in_(ids)) if ids else false())
    if f.workspace_id:
        out.append(L.workspace_id == f.workspace_id)
    if f.data_source_id:
        out.append(L.data_source_id == f.data_source_id)
    if f.target_type:
        out.append(L.target_type == f.target_type)
    if f.target_id:
        out.append(L.target_id == f.target_id)
    if f.outcome:
        out.append(L.outcome == f.outcome)
    if f.has_reason is True:
        out.append(L.stated_reason.is_not(None))
    elif f.has_reason is False:
        out.append(L.stated_reason.is_(None))
    if f.api_key_id:
        out.append(or_(
            L.api_key_id == f.api_key_id,
            and_(L.target_type == "api_key", L.target_id == f.api_key_id),
        ))
    if not f.include_noise:
        out.append(L.event_type.notin_(sorted(NOISE_TYPES)))
    if f.text:
        like = _like(f.text)
        out.append(or_(
            func.lower(L.target_label).like(like, escape="\\"),
            func.lower(L.stated_reason).like(like, escape="\\"),
            func.lower(L.event_type).like(like, escape="\\"),
            func.lower(L.payload).like(like, escape="\\"),
        ))
    return out


def _dialect(session: AsyncSession) -> Optional[str]:
    return getattr(getattr(getattr(session, "bind", None), "dialect", None), "name", None)


def encode_cursor(row: Any) -> str:
    """Where the next page starts, opaque and URL-safe.

    Base64url, because the position holds a timestamp whose ``+00:00`` a
    client that forgets to encode a query string turns into a space.
    """
    raw = f"{row.occurred_at}|{row.id}".encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(cursor: str) -> tuple[str, str]:
    try:
        raw = base64.urlsafe_b64decode((cursor or "") + "=" * (-len(cursor or "") % 4)).decode()
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise InvalidCursor(cursor)
    match = _CURSOR.match(raw)
    if not match:
        raise InvalidCursor(cursor)
    return match.group(1), match.group(2)


def _branches(f: ActivityFilter) -> Optional[tuple[ActivityFilter, list[tuple[Any, str]]]]:
    """``f`` as one ordered index scan per value, when it names values.

    "Newest first, fifty at a time" over a filter on WHO (or on a list of
    event types) is the shape Postgres plans worst. It cannot read
    ``actor_id IN (…) OR subject_id IN (…)`` in timeline order from any one
    index, so it estimates how common those people are and, when the guess
    is "common enough", walks the whole timeline newest-first filtering as it
    goes. For a person with few events — or none — that is every row in the
    ledger: measured at over 80 seconds on ten million.

    One scan per (column, value) on that column's ``(…, occurred_at)``
    index, each stopping at a page, cannot do that: a scan ends where its
    value's range ends, so a page costs the same whether the person did
    nothing or everything — 0.2 ms either way, where the timeline walk took
    80 s. Returns the filter left over and the scans, or ``None`` when ``f``
    names no values, or more than ``_MAX_BRANCHES``.
    """
    people = [
        (columns, ids) for columns, ids in (
            ((L.actor_id, L.subject_id), f.person_ids),
            ((L.actor_id,), f.actor_ids),
            ((L.subject_id,), f.subject_ids),
        ) if ids
    ]
    if len(people) > 1:
        return None
    if people:
        [(columns, ids)] = people
        scans = [(column, value) for column in columns for value in sorted(ids)]
        rest = replace(f, person_ids=None, actor_ids=None, subject_ids=None)
    elif f.event_types and not any(t.endswith("*") for t in f.event_types):
        scans = [(L.event_type, t) for t in sorted(f.event_types)]
        rest = replace(f, event_types=())
    else:
        return None
    if len(scans) > _MAX_BRANCHES:
        return None
    return rest, scans


def page_statement(
    f: ActivityFilter, *, cursor: Optional[str] = None, limit: int = 50,
) -> Any:
    """The SELECT for one page — ``limit + 1`` rows, newest first."""
    after = (
        [tuple_(L.occurred_at, L.id) < tuple_(*decode_cursor(cursor))] if cursor else []
    )
    newest_first = (L.occurred_at.desc(), L.id.desc())
    branched = _branches(f)
    if branched is None:
        stmt = select(L).where(*predicates(f), *after)
    else:
        rest, scans = branched
        shared = [*predicates(rest), *after]
        pages = [
            select(L.id, L.occurred_at)
            .where(column == value, *shared)
            .order_by(*newest_first).limit(limit + 1)
            .subquery()
            for column, value in scans
        ]
        merged = union_all(*(select(p.c.id, p.c.occurred_at) for p in pages)).subquery()
        # A row can arrive from two scans (a person who did something to
        # themselves): grouping keeps it once.
        top = (
            select(merged.c.id)
            .group_by(merged.c.id, merged.c.occurred_at)
            .order_by(merged.c.occurred_at.desc(), merged.c.id.desc())
            .limit(limit + 1)
        )
        stmt = select(L).where(L.id.in_(top))
    return stmt.order_by(*newest_first).limit(limit + 1)


async def list_events(
    session: AsyncSession, f: ActivityFilter, *,
    cursor: Optional[str] = None, limit: int = 50,
) -> tuple[list[Any], Optional[str]]:
    """One page, newest first, and the cursor of the next (``None`` at the end).

    Raises :class:`SearchTooBroad` when a text search runs out of time.
    """
    searching = bool(f.text) and _dialect(session) == "postgresql"
    if searching:
        # For the rest of this transaction only.
        await session.execute(text(f"SET LOCAL statement_timeout = {_SEARCH_TIMEOUT_MS}"))
    try:
        rows = list((await session.execute(
            page_statement(f, cursor=cursor, limit=limit)
        )).scalars())
    except DBAPIError as exc:
        if searching and getattr(exc.orig, "sqlstate", None) == _QUERY_CANCELED:
            raise SearchTooBroad() from exc
        raise
    more = len(rows) > limit
    rows = rows[:limit]
    return rows, (encode_cursor(rows[-1]) if more and rows else None)


async def iter_events(
    session: AsyncSession, f: ActivityFilter, *, chunk: int, cap: int,
):
    """Every matching row, newest first, ``chunk`` at a time, at most ``cap``."""
    cursor: Optional[str] = None
    sent = 0
    while sent < cap:
        rows, cursor = await list_events(
            session, f, cursor=cursor, limit=min(chunk, cap - sent),
        )
        if not rows:
            return
        sent += len(rows)
        yield rows
        if cursor is None:
            return


async def count_newer(
    session: AsyncSession, f: ActivityFilter, *, watermark: str, cap: int = 100,
) -> int:
    """How many matching events were recorded after ``watermark`` (≤ ``cap``+1).

    Recorded, not occurred: an event the relay records a few seconds late
    still counts. But only events that also OCCURRED near the watermark — the
    relay imports history newest-first, and an event from last year that it
    records now is not news.
    """
    try:
        floor = (datetime.fromisoformat(watermark) - _NEWER_LOOKBACK).isoformat()
    except ValueError:
        raise InvalidCursor(watermark)
    inner = (
        select(L.id)
        .where(*predicates(f, window=False), L.recorded_at > watermark, L.occurred_at >= floor)
        .limit(cap + 1)
        .subquery()
    )
    return int((await session.execute(select(func.count()).select_from(inner))).scalar() or 0)


async def get_event(session: AsyncSession, event_id: str, f: ActivityFilter) -> Optional[Any]:
    """One event, if ``f``'s scope may see it (time and noise filters aside)."""
    scope = ActivityFilter(audience=f.audience, workspace_id=f.workspace_id, include_noise=True)
    return (await session.execute(
        select(L).where(L.id == event_id, *predicates(scope))
    )).scalars().first()


async def related(
    session: AsyncSession, row: Any, f: ActivityFilter, *, limit: int = 20,
) -> tuple[list[Any], list[Any]]:
    """Events from the same request, and the latest to the same target."""
    scope = predicates(
        ActivityFilter(audience=f.audience, workspace_id=f.workspace_id, include_noise=True),
    )
    same_request: list[Any] = []
    if row.correlation_id:
        same_request = list((await session.execute(
            select(L).where(L.correlation_id == row.correlation_id, L.id != row.id, *scope)
            .order_by(L.occurred_at, L.id).limit(limit)
        )).scalars())
    same_target: list[Any] = []
    if row.target_id:
        same_target = list((await session.execute(
            select(L).where(
                L.target_type == row.target_type, L.target_id == row.target_id,
                L.id != row.id, *scope,
            ).order_by(L.occurred_at.desc(), L.id.desc()).limit(limit)
        )).scalars())
    return same_request, same_target


async def ledger_health(session: AsyncSession) -> dict[str, Any]:
    """How far the ledger trails the outbox: three indexed reads."""
    pending_q = select(OutboxEventORM.id).where(
        OutboxEventORM.processed.is_(False)).limit(_PENDING_CAP + 1).subquery()
    pending = int((await session.execute(
        select(func.count()).select_from(pending_q))).scalar() or 0)
    oldest = (await session.execute(
        select(func.min(OutboxEventORM.created_at))
        .where(OutboxEventORM.processed.is_(False))
    )).scalar()
    watermark = (await session.execute(select(func.max(L.recorded_at)))).scalar()
    lag = None
    if oldest:
        try:
            then = datetime.fromisoformat(oldest)
            then = then if then.tzinfo else then.replace(tzinfo=timezone.utc)
            lag = round(max(0.0, (datetime.now(timezone.utc) - then).total_seconds()), 1)
        except ValueError:
            lag = None
    return {
        "pending": min(pending, _PENDING_CAP),
        "pendingCapped": pending > _PENDING_CAP,
        "lagSeconds": lag,
        "backfilling": pending >= _BACKFILL_PENDING,
        "watermark": watermark,
    }


# ── Summary ──────────────────────────────────────────────────────────

def _metric(current: int, previous: Optional[int]) -> dict[str, Any]:
    """``previous`` is ``None`` when there is nothing honest to compare with."""
    delta = None if not previous else round((current - previous) / previous, 4)
    return {"current": current, "previous": previous, "delta": delta}


def _punchcard(by_hour: dict[str, int]) -> list[list[int]]:
    """``{YYYY-MM-DDTHH: n}`` → 7×24, Monday first, in UTC."""
    grid = [[0] * 24 for _ in range(7)]
    for hour, count in by_hour.items():
        try:
            at = datetime.strptime(hour, "%Y-%m-%dT%H")
        except ValueError:
            continue
        grid[at.weekday()][at.hour] += count
    return grid


def _cadence(rows: list[tuple], *, people: bool = False) -> list[dict[str, Any]]:
    """Per source: how many manual operations, the last and the usual gap.

    With ``people``, each row ends with who did it, and each source names
    the people who keep doing it, most first. Analytics asks without: its
    documents decide for themselves who may see a person.
    """
    by_source: dict[str, list[str]] = defaultdict(list)
    workspace_of: dict[str, Optional[str]] = {}
    people_of: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for ds, ws, at, *actor in rows:
        by_source[ds].append(at)
        workspace_of.setdefault(ds, ws)
        if people and actor[0]:
            people_of[ds][actor[0]] += 1
    out = []
    for ds, stamps in by_source.items():
        stamps.sort()
        gaps = []
        for earlier, later in zip(stamps, stamps[1:]):
            try:
                gaps.append((datetime.fromisoformat(later) - datetime.fromisoformat(earlier)).total_seconds())
            except ValueError:
                continue
        row = {
            "dataSourceId": ds,
            "workspaceId": workspace_of.get(ds),
            "count": len(stamps),
            "lastAt": stamps[-1],
            "medianGapHours": round(statistics.median(gaps) / 3600, 1) if gaps else None,
        }
        if people:
            row["people"] = [
                {"id": a, "count": n}
                for a, n in sorted(people_of[ds].items(), key=lambda kv: (-kv[1], kv[0]))[:_FACES]
            ]
        out.append(row)
    # Most operations first; among equals, the most recently touched.
    out.sort(key=lambda r: r["lastAt"], reverse=True)
    out.sort(key=lambda r: r["count"], reverse=True)
    return out[:_TOP]


# A summary is the sum of FOLDS: raw, additive counters over whole UTC days.
# A day that is over never changes, so each is folded once and kept, and any
# span — a preset window, a zoom, the period before either — is the sum of
# its days: a span nobody asked for before costs a sum of kept days, not a
# pass over its rows. Counters rather than results, so any two folds add up
# exactly — people as an id→count map, not a count, because "distinct people"
# over two spans is not the sum of each span's.

#: Most days one pass folds. Days not kept yet are folded in passes of at
#: most this many, each kept as it lands: a build cut short by its request's
#: deadline leaves what it folded to the next, so a cold year comes ready
#: over a few requests rather than timing out every time.
_DAYS_PER_PASS = 14


class FoldStore(Protocol):
    """Where folds of days that are over are kept, for :func:`summary`."""

    async def span(
        self, key: str, build: Callable[[], Awaitable[dict[str, Any]]],
    ) -> dict[str, Any]:
        """The fold of a span of days, built at most once."""

    async def days(self, days: list[str]) -> dict[str, dict[str, Any]]:
        """The kept folds of ``days`` (``YYYY-MM-DD``); a day not kept is absent."""

    async def keep(self, folds: dict[str, dict[str, Any]]) -> None:
        """Keep each day's fold."""


def _empty_fold() -> dict[str, Any]:
    return {
        "days": {}, "punchcard": [[0] * 24 for _ in range(7)], "types": {},
        "events": 0, "operations": 0,
        "actors": {}, "changes": 0, "reasoned": 0,
        "targets": {}, "reasons": {},
    }


def _add(total: dict[str, Any], fold: dict[str, Any]) -> None:
    """Add ``fold`` into ``total``. ``fold`` is never changed: kept folds are shared."""
    for day, cells in fold["days"].items():
        mine = total["days"].setdefault(day, {})
        for category, n in cells.items():
            mine[category] = mine.get(category, 0) + n
    for row, more in zip(total["punchcard"], fold["punchcard"]):
        for hour, n in enumerate(more):
            row[hour] += n
    for key in ("types", "actors", "reasons"):
        mine = total[key]
        for k, n in fold[key].items():
            mine[k] = mine.get(k, 0) + n
    for key in ("events", "operations", "changes", "reasoned"):
        total[key] += fold[key]
    for target_type, ids in fold["targets"].items():
        mine = total["targets"].setdefault(target_type, {})
        for target_id, (label, n) in ids.items():
            had = mine.get(target_id)
            mine[target_id] = [had[0] or label, had[1] + n] if had else [label, n]


async def _fold_days(
    session: AsyncSession, f: ActivityFilter, start: str, end: str,
) -> dict[str, dict[str, Any]]:
    """Each day's counters in ``[start, end)``: four grouped reads, however
    many days. A day without events has no entry.

    Reading the span's rows is the cost — a bare ``count(*)`` over a busy
    month takes as long as any grouping of it — which is why a day is folded
    once and kept (:func:`summary`), not made cheaper per read. (One read with
    ``GROUPING SETS`` was measured: 13% faster, not worth a second,
    Postgres-only way of counting.)
    """
    base = [*predicates(f, window=False), L.occurred_at >= start, L.occurred_at < end]
    is_user = L.actor_kind == "user"
    reasoned_kind = L.category.in_(REASONED_CATEGORIES) & is_user
    day = func.substr(L.occurred_at, 1, 10)
    folds: dict[str, dict[str, Any]] = defaultdict(_empty_fold)

    # Volume by hour × category × type: the series, the punchcard, the
    # action leaderboard and the totals, from one GROUP BY.
    hour = func.substr(L.occurred_at, 1, 13)
    for h, category, event_type, n in (await session.execute(
        select(hour, L.category, L.event_type, func.count())
        .where(*base).group_by(hour, L.category, L.event_type)
    )).all():
        fold = folds[h[:10]]
        cells = fold["days"].setdefault(h[:10], {})
        cells[category or "platform"] = cells.get(category or "platform", 0) + n
        try:
            at = datetime.strptime(h, "%Y-%m-%dT%H")
            fold["punchcard"][at.weekday()][at.hour] += n
        except ValueError:
            pass
        fold["types"][event_type] = fold["types"].get(event_type, 0) + n
        fold["events"] += n
        if category == "operations":
            fold["operations"] += n

    # People: who, how often, and how many of their changes said why.
    for d, actor, n, changes, reasoned in (await session.execute(
        select(
            day, L.actor_id, func.count(),
            func.count().filter(reasoned_kind),
            func.count().filter(reasoned_kind & L.stated_reason.is_not(None)),
        ).where(*base, is_user, L.actor_id.is_not(None)).group_by(day, L.actor_id)
    )).all():
        fold = folds[d]
        fold["actors"][actor] = n
        fold["changes"] += changes or 0
        fold["reasoned"] += reasoned or 0

    for d, target_type, target_id, label, n in (await session.execute(
        select(day, L.target_type, L.target_id, func.max(L.target_label), func.count())
        .where(*base, L.target_id.is_not(None))
        .group_by(day, L.target_type, L.target_id)
    )).all():
        folds[d]["targets"].setdefault(target_type or "", {})[target_id] = [label, n]

    for d, reason, n in (await session.execute(
        select(day, L.stated_reason, func.count())
        .where(*base, L.stated_reason.is_not(None)).group_by(day, L.stated_reason)
    )).all():
        folds[d]["reasons"][reason] = n
    return dict(folds)


def operations_statement(f: ActivityFilter, start: str, end: str):
    """Manual operations on a source in ``[start, end)``, for their cadence:
    rows, not groups, so capped — newest first, so a capped answer is the
    recent past.

    Answered from ``idx_aal_cadence`` alone: it leads with the time and
    carries what this selects and filters on, so the read walks back from
    ``end`` and stops at the cap. Through the category index it fetched
    every operation in the window from the table first."""
    return (
        select(L.data_source_id, L.workspace_id, L.occurred_at, L.actor_id)
        .where(
            *predicates(f, window=False), L.occurred_at >= start, L.occurred_at < end,
            L.category == "operations", L.data_source_id.is_not(None),
        )
        .order_by(L.occurred_at.desc()).limit(_CADENCE_ROWS)
    )


async def _operations(
    session: AsyncSession, f: ActivityFilter, start: str, end: str,
) -> list[tuple]:
    if f.categories and "operations" not in f.categories:
        return []
    return [tuple(r) for r in (await session.execute(operations_statement(f, start, end))).all()]


def _midnight(ts: str) -> str:
    return f"{ts[:10]}T00:00:00+00:00"


def _next_day(day: str) -> str:
    return (date.fromisoformat(day) + timedelta(days=1)).isoformat()


def _iter_days(first: str, end: str) -> Iterator[str]:
    """``YYYY-MM-DD`` from ``first`` up to, not including, ``end``."""
    day = first
    while day < end:
        yield day
        day = _next_day(day)


def _runs(days: list[str]) -> list[list[str]]:
    """Ascending days as runs of consecutive ones."""
    runs: list[list[str]] = []
    for day in days:
        if runs and _next_day(runs[-1][-1]) == day:
            runs[-1].append(day)
        else:
            runs.append([day])
    return runs


async def _backfilling(session: AsyncSession) -> bool:
    """Whether the relay is still importing history into closed days."""
    inner = select(OutboxEventORM.id).where(
        OutboxEventORM.processed.is_(False)).limit(_BACKFILL_PENDING).subquery()
    return int((await session.execute(
        select(func.count()).select_from(inner))).scalar() or 0) >= _BACKFILL_PENDING


async def _closed_fold(
    session: AsyncSession, f: ActivityFilter, start: str, end: str, *,
    folds: Optional[FoldStore],
) -> dict[str, Any]:
    """The fold of whole days that are over, ``[start, end)``: the sum of
    its days' folds, itself kept, so the same span again is one read.

    Read and added up a fortnight at a time, so a long span holds one
    running total and one fortnight of days, never all of them at once."""
    if start >= end:
        return _empty_fold()
    days = list(_iter_days(start[:10], end[:10]))

    async def _build() -> dict[str, Any]:
        total = _empty_fold()
        for i in range(0, len(days), _DAYS_PER_PASS):
            chunk = days[i:i + _DAYS_PER_PASS]
            kept = await folds.days(chunk) if folds else {}
            for run in _runs([d for d in chunk if d not in kept]):
                got = await _fold_days(session, f, _midnight(run[0]), _midnight(_next_day(run[-1])))
                fresh = {d: got.get(d) or _empty_fold() for d in run}
                if folds:
                    await folds.keep(fresh)
                kept.update(fresh)
            for fold in kept.values():
                _add(total, fold)
        return total

    return await folds.span(f"{start[:10]}:{end[:10]}", _build) if folds else await _build()


async def summary(
    session: AsyncSession, f: ActivityFilter, w: Window, *,
    folds: Optional[FoldStore] = None, now: Optional[datetime] = None,
    kept_from: Optional[datetime] = None,
) -> dict[str, Any]:
    """The insight band over ``w``, aligned to whole UTC days.

    Volume, the current-vs-previous totals, the weekday×hour punchcard, the
    leaderboards, the cadence of manual operations per source and the
    reasons people gave, all under the same predicates as the timeline, so
    the band describes what the list below it shows.

    Cost: the days of the window that are over, and the whole previous
    window, are sums of day folds a caller may keep in ``folds`` (``None``
    keeps nothing): each day is read once, ever, whatever spans it is in.
    What a request then reads itself is yesterday and today — four grouped
    reads over at most two days' rows, however long the window — and its
    manual operations, newest first.
    """
    now = now or datetime.now(timezone.utc)
    if folds is not None and await _backfilling(session):
        # History is still arriving for closed days; a fold of them now
        # would be kept short.
        folds = None
    day0 = _midnight(w.start)
    # The closed days end where yesterday begins, and yesterday is read live
    # with today: its last events may still be on their way from the relay
    # after midnight. So a day is kept only once nothing more can arrive
    # for it, and is kept from the moment it is folded.
    live0 = min(_midnight((now - timedelta(days=1)).isoformat()), w.end)
    previous0 = _midnight(w.previous_start)
    # A previous period reaching back past the retention horizon was partly
    # swept away. No comparison is better than a false one — and it is not
    # read at all.
    comparable = kept_from is None or datetime.fromisoformat(previous0) >= kept_from

    closed = await _closed_fold(session, f, day0, live0, folds=folds)
    live = await _fold_days(session, f, live0, w.end) if live0 < w.end else {}
    cur = _empty_fold()
    for fold in (closed, *live.values()):
        _add(cur, fold)
    previous = (
        await _closed_fold(session, f, previous0, day0, folds=folds) if comparable else None
    )
    ops = await _operations(session, f, day0, w.end)

    by_day_cat: dict[str, dict[str, int]] = defaultdict(dict)
    for day, cells in cur["days"].items():
        for category, n in cells.items():
            by_day_cat[category][day] = n

    targets = [
        {"type": t or None, "id": i, "label": label, "count": n}
        for t, ids in cur["targets"].items() for i, (label, n) in ids.items()
    ]
    targets.sort(key=lambda r: (-r["count"], r["id"]))

    return {
        "window": {
            "days": w.days, "start": day0, "end": w.end,
            "granularity": w.granularity, "buckets": w.buckets,
            "previousStart": previous0,
            # Set when the comparison was dropped: history before it is gone.
            "keptFrom": None if comparable else kept_from.isoformat(),
        },
        "totals": {
            "events": _metric(cur["events"], previous and previous["events"]),
            "people": _metric(len(cur["actors"]), previous and len(previous["actors"])),
            "operations": _metric(cur["operations"], previous and previous["operations"]),
            "reasons": {
                "given": cur["reasoned"], "of": cur["changes"],
                "share": round(cur["reasoned"] / cur["changes"], 4) if cur["changes"] else None,
            },
        },
        "volume": [
            {"category": c, "values": w.align(per_day)}
            for c, per_day in sorted(by_day_cat.items())
        ],
        "punchcard": cur["punchcard"],
        "topPeople": [
            {"id": a, "count": n}
            for a, n in sorted(cur["actors"].items(), key=lambda kv: (-kv[1], kv[0]))[:_TOP]
        ],
        "topTargets": targets[:_TOP],
        "topActions": [
            {"type": t, "count": n}
            for t, n in sorted(cur["types"].items(), key=lambda kv: (-kv[1], kv[0]))[:_TOP]
        ],
        "handsOnSources": _cadence(ops, people=True),
        "topReasons": [
            {"reason": r, "count": n}
            for r, n in sorted(cur["reasons"].items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        ],
        "cadenceCapped": len(ops) >= _CADENCE_ROWS,
    }
