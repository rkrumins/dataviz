"""Platform analytics — questions and conversations on views and data sources.

Backs ``/api/v1/admin/analytics/collaboration`` (the Collaboration tab), the
questions block of a workspace's drill-in, and two of the summary's findings.

**What counts.** A thread that is not deleted, not archived, and whose subject
is still there: a view that is live (not deleted, not waiting in a draft) or a
data source that is not deleted. Housekeeping archives the threads of subjects
that are gone for good; a soft-deleted subject is not gone, so it is filtered
here.

**How it reads.** The collaboration tables are one domain and are read
together — a thread with the author of its accepted answer, replies grouped by
thread and author. Views, sources, workspaces and people are other domains and
are looked up afterwards by id, never joined (``DOMAIN_OWNERSHIP.md``). The
whole document is a handful of reads whatever the volume: everything ranked is
folded in Python from them.

**What is measured over what.** Questions are counted by the day they were
asked. "Answered" is a thread with an accepted answer, whatever has happened to
it since (a thread closed after its answer was accepted is still answered).
Medians are over the questions asked in the window. "Waiting" and "open" are as
of now, whatever the window.

**Text.** The question's excerpt is read only for open threads that are not
private — the SQL selects it under that condition, so a private question's
words never leave the database, not even into the cached document an
administrator is served. Nobody but a privileged reader is shown any of it.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Optional

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    DiscussionMessageORM,
    DiscussionORM,
    ViewORM,
    WorkspaceDataSourceORM,
    view_is_live,
)
from backend.app.db.repositories.analytics_repo import (
    REDACTED_VIEW,
    REDACTED_WORKSPACE,
    TOP_N,
    Window,
    _chunked,
    _delta,
    _median,
    _metric,
    _parse,
    build_window,
)
from backend.app.db.repositories.analytics_data_repo import REDACTED_SOURCE, _workspace_names
from backend.app.db.repositories.discussion_repo import live
from backend.app.db.repositories.view_repo import resolve_user_ids

if TYPE_CHECKING:  # pragma: no cover — annotation only
    from backend.app.services.analytics_scope import ViewerScope

_D = DiscussionORM
_M = DiscussionMessageORM

#: An open question older than this has "waited over a week".
WAIT_DAYS = 7

#: Rows the drill-in's two rankings show.
_DRILL_IN_N = 5

#: How much of a question the longest-waiting list quotes.
_EXCERPT_CHARS = 160

Ref = tuple[str, str]   # (subject_type, subject_id)


# ── Reading ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Subject:
    type: str
    id: str
    name: str
    workspace_id: Optional[str]
    #: A view's tier; ``None`` for a data source.
    visibility: Optional[str]
    created_by: Optional[str]


@dataclass(frozen=True)
class _Thread:
    id: str
    ref: Ref
    private: bool
    status: str
    asked_by: str
    created_at: str
    first_response_at: Optional[str]
    resolved_at: Optional[str]
    answered: bool
    answer_author: Optional[str]
    replies: int
    #: Only ever set for an open thread that is not private.
    excerpt: Optional[str]


@dataclass
class _Fold:
    subjects: dict[Ref, _Subject]
    #: Every live thread on a live subject, all time.
    total: int
    #: The threads this document needs: asked in either window, still open, or
    #: active since the previous window opened. Live, on live subjects.
    threads: list[_Thread]
    #: ``(thread, author) → (replies this window, replies the window before)``.
    replies: dict[tuple[str, str], tuple[int, int]] = field(default_factory=dict)


def _subject_passes(subjects: Optional[dict[Ref, _Subject]]) -> list[list]:
    """The subject predicate for each round trip. ``None`` is platform-wide:
    one pass, no restriction. Otherwise one pass per chunk of each type's ids,
    so a subject's threads never split across passes."""
    if subjects is None:
        return [[]]
    passes: list[list] = []
    for kind in ("view", "data_source"):
        ids = sorted(i for t, i in subjects if t == kind)
        passes.extend(
            [_D.subject_type == kind, _D.subject_id.in_(chunk)] for chunk in _chunked(ids)
        )
    return passes


async def _lookup_subjects(session: AsyncSession, refs: set[Ref]) -> dict[Ref, _Subject]:
    """The live subjects among ``refs``, by id — two reads, one per domain."""
    out: dict[Ref, _Subject] = {}
    views = sorted(i for t, i in refs if t == "view")
    sources = sorted(i for t, i in refs if t == "data_source")
    for chunk in _chunked(views):
        for vid, name, ws, visibility, created_by in (await session.execute(
            select(ViewORM.id, ViewORM.name, ViewORM.workspace_id, ViewORM.visibility,
                   ViewORM.created_by)
            .where(ViewORM.id.in_(chunk), view_is_live())
        )).all():
            out[("view", vid)] = _Subject("view", vid, name, ws, visibility or "private", created_by)
    for chunk in _chunked(sources):
        for sid, label, graph, ws, created_by in (await session.execute(
            select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label,
                   WorkspaceDataSourceORM.graph_name, WorkspaceDataSourceORM.workspace_id,
                   WorkspaceDataSourceORM.created_by)
            .where(WorkspaceDataSourceORM.id.in_(chunk), WorkspaceDataSourceORM.deleted_at.is_(None))
        )).all():
            out[("data_source", sid)] = _Subject(
                "data_source", sid, label or graph or sid, ws, None, created_by)
    return out


async def workspace_subjects(session: AsyncSession, workspace_id: str) -> dict[Ref, _Subject]:
    """Every live view and source in one workspace — what its threads are about.
    A source that moved here brings its threads with it: a thread never stores
    a workspace, so where its subject is now is where it counts."""
    out: dict[Ref, _Subject] = {}
    for vid, name, visibility, created_by in (await session.execute(
        select(ViewORM.id, ViewORM.name, ViewORM.visibility, ViewORM.created_by)
        .where(ViewORM.workspace_id == workspace_id, view_is_live())
    )).all():
        out[("view", vid)] = _Subject("view", vid, name, workspace_id, visibility or "private", created_by)
    for sid, label, graph, created_by in (await session.execute(
        select(WorkspaceDataSourceORM.id, WorkspaceDataSourceORM.label,
               WorkspaceDataSourceORM.graph_name, WorkspaceDataSourceORM.created_by)
        .where(WorkspaceDataSourceORM.workspace_id == workspace_id,
               WorkspaceDataSourceORM.deleted_at.is_(None))
    )).all():
        out[("data_source", sid)] = _Subject(
            "data_source", sid, label or graph or sid, workspace_id, None, created_by)
    return out


async def _load(
    session: AsyncSession, w: Window, *, subjects: Optional[dict[Ref, _Subject]] = None,
) -> _Fold:
    """Read what every figure is folded from. Platform-wide when ``subjects``
    is ``None``; otherwise only the threads about those subjects."""
    scoped = subjects is not None
    per_subject: Counter = Counter()
    rows: list = []
    # The excerpt is selected only where it may ever be shown. A private
    # question's text is not read at all, so it cannot reach a cache entry.
    quotable = case(
        (and_(_D.visibility == "open", _D.status == "open"), _D.excerpt), else_=None,
    )
    for where in _subject_passes(subjects):
        per_subject.update({
            (t, i): int(n) for t, i, n in (await session.execute(
                select(_D.subject_type, _D.subject_id, func.count())
                .where(live(), *where)
                .group_by(_D.subject_type, _D.subject_id)
            )).all()
        })
        rows.extend((await session.execute(
            # The accepted answer's author, from the same domain's message row.
            select(
                _D.id, _D.subject_type, _D.subject_id, _D.visibility, _D.status, _D.asked_by,
                _D.created_at, _D.first_response_at, _D.resolved_at, _D.answer_message_id,
                _D.message_count, quotable, _M.author_id,
            )
            .outerjoin(_M, _M.id == _D.answer_message_id)
            .where(
                live(), *where,
                or_(_D.created_at >= w.previous_start, _D.status == "open",
                    _D.last_activity_at >= w.previous_start),
            )
        )).all())

    if subjects is None:
        subjects = await _lookup_subjects(session, set(per_subject))
    threads = [
        _Thread(
            id=tid, ref=(stype, sid), private=visibility == "private", status=status,
            asked_by=asked_by, created_at=created, first_response_at=first,
            resolved_at=resolved, answered=answer_id is not None, answer_author=author,
            replies=max(0, int(count or 1) - 1),
            excerpt=(excerpt or "")[:_EXCERPT_CHARS] or None,
        )
        for (tid, stype, sid, visibility, status, asked_by, created, first, resolved,
             answer_id, count, excerpt, author) in rows
        if (stype, sid) in subjects
    ]

    # Replies in both windows, per thread and author. A reply posted in a
    # window moved its thread's last activity into it, so every live thread
    # with one is among those loaded above.
    in_window = and_(_M.created_at >= w.start, _M.created_at < w.end)
    before = _M.created_at < w.start
    passes = [[]] if not scoped else [
        [_M.discussion_id.in_(chunk)] for chunk in _chunked(sorted(t.id for t in threads))
    ]
    replies: dict[tuple[str, str], tuple[int, int]] = {}
    for where in passes:
        for tid, author, now_n, before_n in (await session.execute(
            select(
                _M.discussion_id, _M.author_id,
                func.sum(case((in_window, 1), else_=0)),
                func.sum(case((before, 1), else_=0)),
            )
            .where(
                _M.kind == "reply", _M.deleted_at.is_(None),
                _M.created_at >= w.previous_start, _M.created_at < w.end, *where,
            )
            .group_by(_M.discussion_id, _M.author_id)
        )).all():
            replies[(tid, author)] = (int(now_n or 0), int(before_n or 0))

    live_ids = {t.id for t in threads}
    return _Fold(
        subjects=subjects,
        total=sum(n for ref, n in per_subject.items() if ref in subjects),
        threads=threads,
        replies={k: v for k, v in replies.items() if k[0] in live_ids},
    )


# ── Folding ──────────────────────────────────────────────────────────

def _within(ts: Optional[str], start: str, end: str) -> bool:
    return bool(ts) and start <= ts < end


def _hours(earlier: Optional[str], later: Optional[str]) -> Optional[float]:
    a, b = _parse(earlier), _parse(later)
    if a is None or b is None or b < a:
        return None
    return (b - a).total_seconds() / 3600


def _median_or_none(values: list[float]) -> Optional[float]:
    return round(_median(values), 1) if values else None


def _rate(part: int, whole: int) -> Optional[float]:
    return round(part / whole, 3) if whole else None


@dataclass
class _Measures:
    """What one set of questions adds up to."""

    asked: list[_Thread]

    @property
    def answered(self) -> int:
        return sum(1 for t in self.asked if t.answered)

    @property
    def first_response(self) -> list[float]:
        return [h for t in self.asked if (h := _hours(t.created_at, t.first_response_at)) is not None]

    @property
    def to_answer(self) -> list[float]:
        # ``resolved_at`` is the acceptance only while the thread stays
        # answered; closing it afterwards overwrites it with the close.
        return [
            h for t in self.asked
            if t.status == "answered" and (h := _hours(t.created_at, t.resolved_at)) is not None
        ]


def _timed(current: list[float], previous: list[float]) -> dict:
    now_m, before_m = _median_or_none(current), _median_or_none(previous)
    return {
        "current": now_m,
        "previous": before_m,
        "changePct": _delta(now_m, before_m) if now_m is not None and before_m is not None else None,
        "measured": len(current),
    }


class _Stats:
    """Everything the documents report, folded from one read."""

    def __init__(self, fold: _Fold, w: Window, now: datetime) -> None:
        self.fold, self.w, self.now = fold, w, now
        self.by_id = {t.id: t for t in fold.threads}
        self.current = _Measures([t for t in fold.threads if _within(t.created_at, w.start, w.end)])
        self.previous = _Measures([
            t for t in fold.threads if _within(t.created_at, w.previous_start, w.start)
        ])
        self.open_now = [t for t in fold.threads if t.status == "open"]
        cutoff = now.timestamp() - WAIT_DAYS * 86400
        self.waiting = [
            t for t in self.open_now
            if (at := _parse(t.created_at)) is not None and at.timestamp() < cutoff
        ]
        self.replies_now: Counter = Counter()
        self.replies_before: Counter = Counter()
        for (tid, _author), (n_now, n_before) in fold.replies.items():
            self.replies_now[tid] += n_now
            self.replies_before[tid] += n_before

    def answerers(self, *, previous: bool = False) -> Counter:
        """Replies to someone ELSE's question, per author. Following up on your
        own question is a reply, and it does not make you someone who answers."""
        out: Counter = Counter()
        for (tid, author), (n_now, n_before) in self.fold.replies.items():
            n = n_before if previous else n_now
            if n and author and author != self.by_id[tid].asked_by:
                out[author] += n
        return out

    def kpis(self) -> dict:
        cur, prev = self.current, self.previous
        n_now, n_before = sum(self.replies_now.values()), sum(self.replies_before.values())
        askers_now = len({t.asked_by for t in cur.asked})
        askers_before = len({t.asked_by for t in prev.asked})
        answerers_now, answerers_before = len(self.answerers()), len(self.answerers(previous=True))
        return {
            "asked": _metric(self.fold.total, len(cur.asked), len(prev.asked)),
            "answerRate": {
                "current": _rate(cur.answered, len(cur.asked)),
                "previous": _rate(prev.answered, len(prev.asked)),
                "answered": cur.answered,
            },
            "firstResponseHours": _timed(cur.first_response, prev.first_response),
            "answerHours": _timed(cur.to_answer, prev.to_answer),
            "waitingOverWeek": {"total": len(self.waiting)},
            "open": {"total": len(self.open_now)},
            # Window-only measures: their "total" is the window's, as on the
            # drill-in, rather than a fabricated all-time figure.
            "askers": _metric(askers_now, askers_now, askers_before),
            "answerers": _metric(answerers_now, answerers_now, answerers_before),
            "replies": _metric(n_now, n_now, n_before),
            "privateShare": {
                "current": _rate(sum(t.private for t in cur.asked), len(cur.asked)),
                "previous": _rate(sum(t.private for t in prev.asked), len(prev.asked)),
            },
        }

    def series(self) -> dict:
        asked = Counter(t.created_at[:10] for t in self.current.asked)
        answered = Counter(t.created_at[:10] for t in self.current.asked if t.answered)
        return {
            "buckets": self.w.buckets,
            "asked": self.w.align(asked),
            # Of the questions asked in each period, how many are answered now —
            # so the two lines sum to the KPIs, and the gap between them is the
            # answer rate period by period.
            "answered": self.w.align(answered),
        }

    def subjects_ranked(self, kind: str, limit: int = TOP_N) -> list[dict]:
        """Views or sources by how much was said about them in the window:
        questions asked plus replies posted."""
        questions: Counter = Counter()
        replies: Counter = Counter()
        answered: Counter = Counter()
        open_now: Counter = Counter()
        for t in self.fold.threads:
            if t.ref[0] != kind:
                continue
            replies[t.ref] += self.replies_now.get(t.id, 0)
            open_now[t.ref] += 1 if t.status == "open" else 0
        for t in self.current.asked:
            if t.ref[0] == kind:
                questions[t.ref] += 1
                answered[t.ref] += 1 if t.answered else 0
        scored = [ref for ref in set(questions) | set(replies) if questions[ref] + replies[ref] > 0]
        scored.sort(key=lambda r: (-(questions[r] + replies[r]), -questions[r], r[1]))
        rows = []
        for ref in scored[:limit]:
            s = self.fold.subjects[ref]
            counts = {
                "name": s.name,
                "workspaceId": s.workspace_id,
                "workspaceName": None,   # filled in once names are read
                "questions": questions[ref],
                "replies": replies[ref],
                "messages": questions[ref] + replies[ref],
                "answered": answered[ref],
                "open": open_now[ref],
                "canOpen": True,
            }
            rows.append(
                {"viewId": s.id, **counts, "visibility": s.visibility, "createdBy": s.created_by}
                if kind == "view" else {"dataSourceId": s.id, **counts}
            )
        return rows

    def workspaces_ranked(self) -> list[dict]:
        asked: dict[str, list[_Thread]] = defaultdict(list)
        replies: Counter = Counter()
        for t in self.current.asked:
            if ws := self.fold.subjects[t.ref].workspace_id:
                asked[ws].append(t)
        for t in self.fold.threads:
            if ws := self.fold.subjects[t.ref].workspace_id:
                replies[ws] += self.replies_now.get(t.id, 0)
        rows = []
        for ws in sorted(asked, key=lambda ws: (-len(asked[ws]), ws))[:TOP_N]:
            m = _Measures(asked[ws])
            rows.append({
                "workspaceId": ws,
                "name": None,
                "questions": len(m.asked),
                "answered": m.answered,
                "answerRate": _rate(m.answered, len(m.asked)),
                "firstResponseHours": _median_or_none(m.first_response),
                "replies": replies[ws],
                "canOpen": True,
            })
        return rows

    def answerers_ranked(self) -> list[dict]:
        accepted: Counter = Counter(
            t.answer_author for t in self.current.asked if t.answered and t.answer_author
        )
        replies = self.answerers()
        ranked = sorted(set(accepted) | set(replies), key=lambda u: (-accepted[u], -replies[u], u))
        return [
            {"userId": u, "name": None, "accepted": accepted[u], "replies": replies[u]}
            for u in ranked[:TOP_N]
        ]

    def waiting_ranked(self) -> list[dict]:
        """The open questions that have waited longest, oldest first."""
        rows = []
        for t in sorted(self.open_now, key=lambda t: (t.created_at, t.id))[:TOP_N]:
            s = self.fold.subjects[t.ref]
            asked = _parse(t.created_at)
            rows.append({
                "discussionId": t.id,
                "subjectType": s.type,
                "subjectId": s.id,
                "subjectName": s.name,
                "workspaceId": s.workspace_id,
                "workspaceName": None,
                "askedAt": t.created_at,
                "ageDays": int((self.now - asked).total_seconds() // 86400) if asked else None,
                "replies": t.replies,
                "private": t.private,
                # Read only for open, non-private threads — see `_load`.
                "excerpt": None if t.private else t.excerpt,
                "askedBy": t.asked_by,
                "askedByName": None,
                # For the redactor: a view's own reach rules. Never shown.
                "subjectVisibility": s.visibility,
                "subjectCreatedBy": s.created_by,
                "canOpen": True,
            })
        return rows


async def _name_rows(
    session: AsyncSession, boards: dict, *, workspace_names: Optional[dict[str, str]] = None,
) -> None:
    """Fill in workspace and people names after ranking — one read each."""
    if workspace_names is None:
        ids = {
            r.get("workspaceId") for key in ("views", "sources", "workspaces", "waiting")
            for r in boards.get(key, [])
        }
        workspace_names = await _workspace_names(session, {i for i in ids if i})
    for key in ("views", "sources", "waiting"):
        for row in boards.get(key, []):
            row["workspaceName"] = workspace_names.get(row.get("workspaceId") or "")
    for row in boards.get("workspaces", []):
        row["name"] = workspace_names.get(row["workspaceId"]) or row["workspaceId"]

    people = {r["userId"] for r in boards.get("answerers", [])} | {
        r["askedBy"] for r in boards.get("waiting", [])
    }
    names = await resolve_user_ids(session, people) if people else {}
    for row in boards.get("answerers", []):
        row["name"] = (names.get(row["userId"]) or (None, None))[0] or row["userId"]
    for row in boards.get("waiting", []):
        row["askedByName"] = (names.get(row.pop("askedBy")) or (None, None))[0]


# ── The documents ────────────────────────────────────────────────────

async def collaboration_doc(
    session: AsyncSession, *,
    days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None,
    scope: Optional["ViewerScope"] = None,
) -> dict:
    """The Collaboration tab: questions asked and answered, how fast, about
    what, in which workspaces, and who answers."""
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)
    stats = _Stats(await _load(session, w), w, now)

    boards = {
        "views": stats.subjects_ranked("view"),
        "sources": stats.subjects_ranked("data_source"),
        "workspaces": stats.workspaces_ranked(),
        "answerers": stats.answerers_ranked(),
        "waiting": stats.waiting_ranked(),
    }
    await _name_rows(session, boards)
    doc = {
        "windowDays": days,
        "generatedAt": now.isoformat(),
        "range": {
            "from": w.start, "to": w.end,
            "previousFrom": w.previous_start, "previousTo": w.start,
        },
        "bucket": w.granularity,
        "kpis": stats.kpis(),
        "series": stats.series(),
        "leaderboards": boards,
    }
    return redact_collaboration(doc, scope) if scope is not None else doc


async def workspace_block(
    session: AsyncSession, w: Window, workspace_id: str, workspace_name: str, *, now: datetime,
) -> dict:
    """One workspace's questions, for its drill-in."""
    subjects = await workspace_subjects(session, workspace_id)
    stats = _Stats(await _load(session, w, subjects=subjects), w, now)
    kpis = stats.kpis()
    boards = {
        "views": stats.subjects_ranked("view", _DRILL_IN_N),
        "sources": stats.subjects_ranked("data_source", _DRILL_IN_N),
    }
    await _name_rows(session, boards, workspace_names={workspace_id: workspace_name})
    return {
        **{k: kpis[k] for k in ("asked", "answerRate", "firstResponseHours", "waitingOverWeek", "open")},
        **boards,
    }


async def headline(session: AsyncSession, w: Window, *, now: datetime) -> dict:
    """What the summary's findings quote: how many questions are waiting, and
    what was talked about most. The same fold as the tab, so a finding and the
    tab it links to cannot disagree."""
    stats = _Stats(await _load(session, w), w, now)
    top = sorted(
        stats.subjects_ranked("view", 1) + stats.subjects_ranked("data_source", 1),
        key=lambda r: (-r["messages"], -r["questions"]),
    )
    lead = top[0] if top else None
    return {
        "asked": len(stats.current.asked),
        "waitingOverWeek": len(stats.waiting),
        "mostDiscussed": {
            "name": lead["name"],
            "kind": "view" if "viewId" in lead else "data_source",
            "questions": lead["questions"],
            "replies": lead["replies"],
        } if lead else None,
    }


# ── Redaction ────────────────────────────────────────────────────────
# Allow-lists, as everywhere in Analytics: what may leave is named, so a field
# added to a row later is withheld until someone decides otherwise.

_VIEW_FIELDS = (
    "viewId", "name", "workspaceId", "workspaceName", "visibility",
    "questions", "replies", "messages", "answered", "open",
)
_SOURCE_FIELDS = (
    "dataSourceId", "name", "workspaceId", "workspaceName",
    "questions", "replies", "messages", "answered", "open",
)
_WORKSPACE_FIELDS = (
    "workspaceId", "name", "questions", "answered", "answerRate", "firstResponseHours", "replies",
)
#: No excerpt and no asker: what was asked, and by whom, is for privileged
#: readers only.
_WAITING_FIELDS = (
    "discussionId", "subjectType", "subjectId", "subjectName", "workspaceId", "workspaceName",
    "askedAt", "ageDays", "replies", "private",
)


def _place(row: dict, scope) -> dict:
    """The workspace a row sits in, named only where it may be reported."""
    ws = row.get("workspaceId")
    if scope.can_see(ws):
        return {"workspaceId": ws, "workspaceName": row.get("workspaceName")}
    return {"workspaceId": None, "workspaceName": REDACTED_WORKSPACE}


def _redact_view(row: dict, scope) -> dict:
    """A discussed view, named only where ``can_see_view`` says the reader may
    already know it — the rule the popular-views ranking follows."""
    public = {k: row.get(k) for k in _VIEW_FIELDS}
    ws = row.get("workspaceId")
    if scope.can_see_view(
        workspace_id=ws, visibility=row.get("visibility"), created_by=row.get("createdBy"),
    ):
        return {
            **public, **_place(row, scope),
            "canOpen": row.get("visibility") == "enterprise" or scope.can_open(ws),
        }
    # The counts stay: they are what ranks it, and they name nothing.
    return {
        **public, "viewId": None, "name": REDACTED_VIEW, "workspaceId": None,
        "workspaceName": REDACTED_WORKSPACE, "visibility": "restricted",
        "redacted": True, "canOpen": False,
    }


def _redact_source(row: dict, scope) -> dict:
    """A source's name says what its workspace is working on, so it follows
    the workspace, as the Data tab's movers do."""
    public = {k: row.get(k) for k in _SOURCE_FIELDS}
    ws = row.get("workspaceId")
    if scope.can_see(ws):
        return {**public, "canOpen": scope.can_open(ws)}
    return {
        **public, "dataSourceId": None, "name": REDACTED_SOURCE, "workspaceId": None,
        "workspaceName": REDACTED_WORKSPACE, "redacted": True, "canOpen": False,
    }


def _redact_workspace(row: dict, scope) -> dict:
    public = {k: row.get(k) for k in _WORKSPACE_FIELDS}
    if scope.can_see(row.get("workspaceId")):
        return {**public, "canOpen": scope.can_open(row.get("workspaceId"))}
    return {**public, "name": REDACTED_WORKSPACE, "redacted": True, "canOpen": False}


def _redact_waiting(row: dict, scope) -> dict:
    """A waiting question keeps its age — the point of the list — and says
    what it is about only when the reader may see that subject and the
    question is not private. A private question is described to nobody here:
    its people, the subject's maintainers and the workspace's admins see it
    where it lives."""
    public = {k: row.get(k) for k in _WAITING_FIELDS}
    ws = row.get("workspaceId")
    if row.get("subjectType") == "view":
        sees = scope.can_see_view(
            workspace_id=ws, visibility=row.get("subjectVisibility"),
            created_by=row.get("subjectCreatedBy"),
        )
        opens = row.get("subjectVisibility") == "enterprise" or scope.can_open(ws)
    else:
        sees, opens = scope.can_see(ws), scope.can_open(ws)
    if sees and not row.get("private"):
        return {**public, **_place(row, scope), "canOpen": opens}
    named = scope.can_see(ws)
    return {
        **public, "discussionId": None, "subjectId": None, "subjectName": None,
        "workspaceId": ws if named else None,
        "workspaceName": row.get("workspaceName") if named else None,
        "redacted": True, "canOpen": False,
    }


def redact_collaboration(doc: dict, scope) -> dict:
    """Apply ``scope`` to the Collaboration document.

    Totals and series describe the platform and stay. Rankings keep every row
    — so they agree with the totals above them — and lose the names of what
    the reader may not know about. Who answers, who asked and what they asked
    are withheld from every non-privileged reader at every privacy level:
    individual activity is not shown to them (``analytics_scope``).
    """
    if scope is None or scope.privileged:
        return doc
    doc = dict(doc)
    boards = doc["leaderboards"]
    doc["leaderboards"] = {
        "views": [_redact_view(r, scope) for r in boards.get("views", [])],
        "sources": [_redact_source(r, scope) for r in boards.get("sources", [])],
        "workspaces": [_redact_workspace(r, scope) for r in boards.get("workspaces", [])],
        "answerers": [],
        "waiting": [_redact_waiting(r, scope) for r in boards.get("waiting", [])],
    }
    doc["redaction"] = {
        "applied": True,
        "showsPeople": False,
        "reportsAllWorkspaces": scope.reports_all_workspaces,
        "hidden": ["Who answers most", "What was asked, and by whom"],
    }
    return doc


def redact_workspace_block(block: dict, scope) -> dict:
    """The drill-in's questions block. The reader already passed the
    workspace's own gate; the views' reach rules still apply."""
    if scope is None or scope.privileged:
        return block
    return {
        **block,
        "views": [_redact_view(r, scope) for r in block.get("views", [])],
        "sources": [_redact_source(r, scope) for r in block.get("sources", [])],
    }
