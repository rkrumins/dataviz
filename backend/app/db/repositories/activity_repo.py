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
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable, Optional

from sqlalchemy import false, func, or_, select, text, tuple_, union_all
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import AuthAuditLogORM as L
from backend.app.db.models import OutboxEventORM
from backend.app.db.repositories.analytics_repo import Window

#: Per-request noise the default lens leaves out: a refused request is logged
#: on every 403, so at any real volume it would bury what people did.
NOISE_TYPES = frozenset({"user.access_denied"})

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

def _metric(current: int, previous: int) -> dict[str, Any]:
    delta = None if previous == 0 else round((current - previous) / previous, 4)
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


def _cadence(rows: list[tuple[str, Optional[str], str]]) -> list[dict[str, Any]]:
    """Per source: how many manual operations, the last, and the usual gap."""
    by_source: dict[str, list[str]] = defaultdict(list)
    workspace_of: dict[str, Optional[str]] = {}
    for ds, ws, at in rows:
        by_source[ds].append(at)
        workspace_of.setdefault(ds, ws)
    out = []
    for ds, stamps in by_source.items():
        stamps.sort()
        gaps = []
        for earlier, later in zip(stamps, stamps[1:]):
            try:
                gaps.append((datetime.fromisoformat(later) - datetime.fromisoformat(earlier)).total_seconds())
            except ValueError:
                continue
        out.append({
            "dataSourceId": ds,
            "workspaceId": workspace_of.get(ds),
            "count": len(stamps),
            "lastAt": stamps[-1],
            "medianGapHours": round(statistics.median(gaps) / 3600, 1) if gaps else None,
        })
    # Most operations first; among equals, the most recently touched.
    out.sort(key=lambda r: r["lastAt"], reverse=True)
    out.sort(key=lambda r: r["count"], reverse=True)
    return out[:_TOP]


# A summary is the merge of FOLDS: raw, mergeable counters over a span of
# time. Every day in a window but today is over, so the fold of the closed
# days is computed once and reused until the window moves on, and a request
# reads only today's rows. Counters rather than results, so any two folds
# merge exactly — people as an id→count map, not a count, because "distinct
# people" over two spans is not the sum of each span's.


async def _fold(
    session: AsyncSession, f: ActivityFilter, start: str, end: str, *, full: bool,
) -> dict[str, Any]:
    """The counters for ``[start, end)``: two grouped reads, or five.

    Reading the span's rows is the cost — a bare ``count(*)`` over a busy
    month takes as long as any grouping of it — which is why a closed span is
    folded once and reused (:func:`summary`), not made cheaper per read.
    (One read with ``GROUPING SETS`` was measured: 13% faster, not worth a
    second, Postgres-only way of counting.)
    """
    base = [*predicates(f, window=False), L.occurred_at >= start, L.occurred_at < end]
    is_user = L.actor_kind == "user"
    reasoned_kind = L.category.in_(REASONED_CATEGORIES) & is_user
    fold = _empty_fold()

    # Volume by hour × category × type: the series, the punchcard, the
    # action leaderboard and the totals, from one GROUP BY.
    hour = func.substr(L.occurred_at, 1, 13)
    for h, category, event_type, n in (await session.execute(
        select(hour, L.category, L.event_type, func.count())
        .where(*base).group_by(hour, L.category, L.event_type)
    )).all():
        cell = fold["hours"].setdefault(h, {})
        cell[category or "platform"] = cell.get(category or "platform", 0) + n
        fold["types"][event_type] = fold["types"].get(event_type, 0) + n
        fold["events"] += n
        if category == "operations":
            fold["operations"] += n

    # People: who, how often, and how many of their changes said why.
    for actor, n, changes, reasoned in (await session.execute(
        select(
            L.actor_id, func.count(),
            func.count().filter(reasoned_kind),
            func.count().filter(reasoned_kind & L.stated_reason.is_not(None)),
        ).where(*base, is_user, L.actor_id.is_not(None)).group_by(L.actor_id)
    )).all():
        fold["actors"][actor] = n
        fold["changes"] += changes or 0
        fold["reasoned"] += reasoned or 0
    if not full:
        return fold

    for target_type, target_id, label, n in (await session.execute(
        select(L.target_type, L.target_id, func.max(L.target_label), func.count())
        .where(*base, L.target_id.is_not(None))
        .group_by(L.target_type, L.target_id)
    )).all():
        fold["targets"].setdefault(target_type or "", {})[target_id] = [label, n]

    # Manual operations per source: rows, not groups, so capped — newest
    # first, so a capped answer is the recent past. Cheap: operations are
    # few, and the category index finds them.
    fold["ops"] = [list(r) for r in (await session.execute(
        select(L.data_source_id, L.workspace_id, L.occurred_at)
        .where(*base, L.category == "operations", L.data_source_id.is_not(None))
        .order_by(L.occurred_at.desc()).limit(_CADENCE_ROWS)
    )).all()]

    fold["reasons"] = {r: n for r, n in (await session.execute(
        select(L.stated_reason, func.count())
        .where(*base, L.stated_reason.is_not(None)).group_by(L.stated_reason)
    )).all()}
    return fold


def _empty_fold() -> dict[str, Any]:
    return {
        "hours": {}, "types": {}, "events": 0, "operations": 0,
        "actors": {}, "changes": 0, "reasoned": 0,
        "targets": {}, "ops": [], "reasons": {},
    }


def _merge(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in a.keys() | b.keys():
        x, y = a.get(key), b.get(key)
        if x is None or y is None:
            out[key] = x if y is None else y
        elif isinstance(x, list):
            out[key] = x + y
        elif isinstance(x, dict):
            out[key] = {k: _merge_value(x.get(k), y.get(k)) for k in x.keys() | y.keys()}
        else:
            out[key] = x + y
    return out


def _merge_value(x: Any, y: Any) -> Any:
    if x is None or y is None:
        return x if y is None else y
    if isinstance(x, dict):
        return {k: _merge_value(x.get(k), y.get(k)) for k in x.keys() | y.keys()}
    if isinstance(x, list):  # a target: [label, count]
        return [x[0] or y[0], x[1] + y[1]]
    return x + y


def _midnight(ts: str) -> str:
    return f"{ts[:10]}T00:00:00+00:00"


async def _backfilling(session: AsyncSession) -> bool:
    """Whether the relay is still importing history into closed days."""
    inner = select(OutboxEventORM.id).where(
        OutboxEventORM.processed.is_(False)).limit(_BACKFILL_PENDING).subquery()
    return int((await session.execute(
        select(func.count()).select_from(inner))).scalar() or 0) >= _BACKFILL_PENDING


#: A span that ended this recently may still be receiving its last events
#: from the relay, so it is not reused yet.
_SETTLE = timedelta(minutes=10)


#: How a caller lets closed folds be reused: ``reuse(key, build)`` returns
#: the document under ``key``, building it at most once.
Reuse = Callable[[str, Callable[[], Awaitable[dict[str, Any]]]], Awaitable[dict[str, Any]]]


async def _closed_fold(
    session: AsyncSession, f: ActivityFilter, start: str, end: str, *,
    full: bool, reuse: Optional[Reuse], now: datetime,
) -> dict[str, Any]:
    """A fold over days that are over, reused until the window moves on."""
    if start >= end:
        return _empty_fold()

    async def _build() -> dict[str, Any]:
        return await _fold(session, f, start, end, full=full)

    settled = datetime.fromisoformat(end) <= now - _SETTLE
    if reuse is None or not settled:
        return await _build()
    return await reuse(f"{'full' if full else 'totals'}:{start}:{end}", _build)


async def summary(
    session: AsyncSession, f: ActivityFilter, w: Window, *,
    reuse: Optional[Reuse] = None, now: Optional[datetime] = None,
) -> dict[str, Any]:
    """The insight band over ``w``, aligned to whole UTC days.

    Volume, the current-vs-previous totals, the weekday×hour punchcard, the
    leaderboards, the cadence of manual operations per source and the
    reasons people gave, all under the same predicates as the timeline, so
    the band describes what the list below it shows.

    Cost: the closed days of the window, and the whole previous window, are
    folds a caller may ``reuse`` until midnight (``None`` reuses nothing).
    What a request then reads itself is today: five grouped reads over one
    day's rows, however long the window — not a pass over every row in it.
    """
    now = now or datetime.now(timezone.utc)
    if reuse is not None and await _backfilling(session):
        # History is still arriving for closed days; a fold of them now
        # would be reused short.
        reuse = None
    day0 = _midnight(w.start)
    today0 = min(_midnight(now.isoformat()), w.end)
    previous0 = _midnight(w.previous_start)

    closed = await _closed_fold(
        session, f, day0, today0, full=True, reuse=reuse, now=now,
    )
    live = (
        await _fold(session, f, today0, w.end, full=True) if today0 < w.end else _empty_fold()
    )
    previous = await _closed_fold(
        session, f, previous0, day0, full=False, reuse=reuse, now=now,
    )
    cur = _merge(closed, live)

    by_day_cat: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    by_hour: dict[str, int] = {}
    for h, cells in cur["hours"].items():
        by_hour[h] = sum(cells.values())
        for category, n in cells.items():
            by_day_cat[category][h[:10]] += n

    targets = [
        {"type": t or None, "id": i, "label": label, "count": n}
        for t, ids in cur["targets"].items() for i, (label, n) in ids.items()
    ]
    targets.sort(key=lambda r: (-r["count"], r["id"]))
    ops = sorted(cur["ops"], key=lambda r: r[2], reverse=True)[:_CADENCE_ROWS]

    return {
        "window": {
            "days": w.days, "start": day0, "end": w.end,
            "granularity": w.granularity, "buckets": w.buckets,
            "previousStart": previous0,
        },
        "totals": {
            "events": _metric(cur["events"], previous["events"]),
            "people": _metric(len(cur["actors"]), len(previous["actors"])),
            "operations": _metric(cur["operations"], previous["operations"]),
            "reasons": {
                "given": cur["reasoned"], "of": cur["changes"],
                "share": round(cur["reasoned"] / cur["changes"], 4) if cur["changes"] else None,
            },
        },
        "volume": [
            {"category": c, "values": w.align(dict(per_day))}
            for c, per_day in sorted(by_day_cat.items())
        ],
        "punchcard": _punchcard(by_hour),
        "topPeople": [
            {"id": a, "count": n}
            for a, n in sorted(cur["actors"].items(), key=lambda kv: (-kv[1], kv[0]))[:_TOP]
        ],
        "topTargets": targets[:_TOP],
        "topActions": [
            {"type": t, "count": n}
            for t, n in sorted(cur["types"].items(), key=lambda kv: (-kv[1], kv[0]))[:_TOP]
        ],
        "handsOnSources": _cadence([tuple(r) for r in ops]),
        "topReasons": [
            {"reason": r, "count": n}
            for r, n in sorted(cur["reasons"].items(), key=lambda kv: (-kv[1], kv[0]))[:5]
        ],
        "cadenceCapped": len(cur["ops"]) >= _CADENCE_ROWS,
    }
