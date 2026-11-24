"""People analytics — what each person does, day by day, across the platform or in one workspace.

Two kinds of read, and the line between them is what makes it scale:

* **Everyone at once** — the roster, its aggregates, the people active on a day, the activity
  lines of a page of people — comes ONLY from the daily rollup the people indexer maintains
  (see ``people_index_repo``). A roster reads ``person_daily_totals``, one row per person-day
  in its scope, and ``people_daily_facets``, which has no person: it costs people × days,
  whatever they did, and every aggregate is a ``GROUP BY`` in SQL. Lines, a day and a page's
  kinds read ``person_activity_daily``, per kind, for the people or the day they show.
  Nothing here reads an event table for everyone.
* **One person** — their page's totals, line and calendar come from the rollup too; the
  details only raw events hold (which types, which hours, which views) and their feed are read
  from the three stores through each one's actor index, so they cost what one person did.

LENSES. A document is built for a lens, never for a reader:

* ``full`` — everything, sign-ins included. For privileged readers, and for a person reading
  their own activity.
* ``workspace`` — what a workspace admin may know about their workspace: the rollup's ``_ws``
  columns, which count only what the Activity explorer would show them. No sign-ins: signing
  in is a platform event, not any one workspace's.

What one particular reader receives — addresses, view and workspace names — is decided on the
way out by the redactors at the bottom, so one computation serves every reader of a lens.
"""
from __future__ import annotations

import json
from bisect import bisect_right
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from statistics import median
from typing import Any, Iterable, Optional, Sequence

from sqlalchemy import and_, case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AuthAuditLogORM,
    PeopleDailyFacetORM,
    PersonActivityDailyORM,
    PersonDailyTotalORM,
    ProductEventORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
)
from backend.app.db.repositories import people_index_repo, user_repo
from backend.app.db.repositories.activity_repo import _punchcard
from backend.app.db.repositories.analytics_repo import (
    SEARCH_MISS,
    SEARCH_RUN,
    TRACE_EMPTY,
    TRACE_RUN,
    VIEW_OPENED,
    Window,
    _chunked,
    _delta,
    _insight,
    _pct,
    _plural,
    _window_label,
    build_window,
    members_by_workspace,
    previous_window,
)
from backend.app.db.repositories.people_kinds import (  # noqa: F401 — re-exported
    ACTION_KINDS,
    CALENDAR_DAYS,
    DAY_CAP,
    FULL,
    KINDS,
    LENSES,
    SECTION,
    SECTION_BITS,
    SECTION_KIND_PREFIX,
    SESSION_GAP_MINUTES,
    SIGN_IN,
    USAGE_KINDS,
    USAGE_LABELS,
    WORKSPACE,
    _ADMIN_VIEWED,
    _EDIT_META,
    _EDIT_PREFIX,
    _FAILED_SIGN_INS,
    _MIRRORED_LEDGER_PREFIX,
    _QUIET_LISTED,
    _TOP_TYPES,
    edit_type,
    kind_of,
    label_of,
    ledger_kind,
)
from backend.app.services.activity import catalogue
from backend.common.service_accounts import is_person, is_service_account

#: Ids a single ``lines`` request may ask for — a compare chart, or a grid page.
LINES_MAX = 100

A = PersonActivityDailyORM
T = PersonDailyTotalORM
F = PeopleDailyFacetORM
EVERYWHERE = people_index_repo.EVERYWHERE


# ── Scope over the rollup ─────────────────────────────────────────────


@dataclass(frozen=True)
class _Scope:
    """Which rollup rows a lens reads, for a workspace or the platform."""
    lens: str
    workspace_id: Optional[str]

    @property
    def ws_lens(self) -> bool:
        return self.lens == WORKSPACE

    @property
    def n(self):
        return A.n_ws if self.ws_lens else A.n

    @property
    def first(self):
        return A.first_ws_at if self.ws_lens else A.first_at

    @property
    def last(self):
        return A.last_ws_at if self.ws_lens else A.last_at

    @property
    def fn(self):
        return F.n_ws if self.ws_lens else F.n

    # The roster's reads: ``person_daily_totals``, whose rows for this scope are ``key``'s.

    @property
    def key(self) -> str:
        return self.workspace_id or EVERYWHERE

    @property
    def chunked(self) -> bool:
        """A full-lens workspace scope also counts its people's sign-ins, which happened in no
        workspace: their everywhere rows are read beside the workspace's, a chunk of people at
        a time. The scope's own rows are still the only ones its actions come from."""
        return self.workspace_id is not None and not self.ws_lens

    def where(self, people: Optional[Sequence[str]] = None) -> list:
        if not self.chunked or people is None:
            return [T.workspace_id == self.key]
        return [T.user_id.in_(people), T.workspace_id.in_([self.key, EVERYWHERE])]

    def _own(self, col, other):
        return case((T.workspace_id == self.key, col), else_=other) if self.chunked else col

    @property
    def acts(self):
        return self._own(T.actions_ws if self.ws_lens else T.actions, 0)

    @property
    def last_act(self):
        return self._own(T.last_action_ws_at if self.ws_lens else T.last_action_at, None)

    @property
    def sections(self):
        return self._own(T.sections, 0)

    def facet_where(self) -> list:
        return [F.workspace_id == self.key] + ([F.n_ws > 0] if self.ws_lens else [])


_ACTION = A.kind.in_(ACTION_KINDS)
_SIGNIN = A.kind == "signin"
_SECTION_ROW = A.kind.startswith(SECTION_KIND_PREFIX, autoescape=True)


def _span(w: Window) -> tuple[str, str]:
    """The window as whole UTC days, which is the rollup's grain."""
    return w.buckets[0], w.end[:10]


def _prev_span(w: Window) -> tuple[str, str]:
    first, last = _span(w)
    n = (date.fromisoformat(last) - date.fromisoformat(first)).days + 1
    start = date.fromisoformat(first) - timedelta(days=n)
    return start.isoformat(), (date.fromisoformat(first) - timedelta(days=1)).isoformat()


def _bucket(col, w: Window):
    """The bucket a rollup day falls in, as SQL. Daily windows ARE their days; a weekly window
    is a ``CASE`` over at most 53 bucket starts — portable, and grouped in the database."""
    if w.granularity == "day" or len(w.buckets) == 1:
        return col
    whens = [(col < w.buckets[i + 1], w.buckets[i]) for i in range(len(w.buckets) - 1)]
    return case(*whens, else_=w.buckets[-1])


async def _people_in_scope(session: AsyncSession, scope: _Scope, spans: Sequence[tuple[str, str]],
                           members: Iterable[str]) -> list[str]:
    """Everyone a full-lens workspace scope reads: its members, and whoever did something in
    it in any of the spans — the set its sign-ins are read for."""
    people = set(members)
    for first, last in spans:
        people.update(u for u in (await session.execute(
            select(T.user_id).where(T.workspace_id == scope.key,
                                    T.day >= first, T.day <= last).distinct()
        )).scalars().all() if u)
    return sorted(people)


async def _each_chunk(session: AsyncSession, scope: _Scope, people: Optional[list[str]], build):
    """Run ``build(where)`` once for the scope, or once per chunk of people when the scope
    needs them, and concatenate the rows. People never span chunks, so per-person groups and
    distinct counts add up exactly."""
    if not scope.chunked or people is None:
        return (await session.execute(build(scope.where()))).all()
    rows: list = []
    for chunk in _chunked(people or []):
        rows += (await session.execute(build(scope.where(chunk)))).all()
    return rows


# ── Shared reads ──────────────────────────────────────────────────────


def _hour(col):
    return func.substr(col, 1, 13)


def _bounds(col, since: str, until: Optional[str]) -> list:
    return [col >= since] + ([col < until] if until else [])


def _ledger_scope(lens: str, workspace_id: Optional[str]) -> list:
    """The ledger rows a lens may read.

    Platform scope (full lens only): everything people did. Workspace scope: rows in the
    workspace — every audience for the full lens, only the workspace audience for a workspace
    admin, exactly as the Activity explorer serves them. Sign-ins carry no workspace, so a
    full-lens workspace scope adds its people's sign-ins separately (:func:`_signin_rows`).
    """
    T = AuthAuditLogORM
    if workspace_id is None:
        return []
    clause = [T.workspace_id == workspace_id]
    if lens == WORKSPACE:
        clause.append(T.audience == catalogue.AUDIENCE_WORKSPACE)
    return clause


async def _users(session: AsyncSession, ids: Iterable[str]) -> dict[str, dict]:
    """The people named in a document, chunked. Same display-name rule as
    ``view_repo.resolve_user_ids``; a deleted account keeps its name and says so."""
    out: dict[str, dict] = {}
    for chunk in _chunked(sorted({i for i in ids if i})):
        for row in (await session.execute(
            select(
                UserORM.id, UserORM.first_name, UserORM.last_name, UserORM.email,
                UserORM.status, UserORM.created_at, UserORM.deleted_at,
                UserORM.last_login_at, UserORM.last_seen_at, UserORM.last_active_at,
            ).where(UserORM.id.in_(chunk))
        )).all():
            uid, first, last, email, status, created, deleted, login, seen, active = row
            out[uid] = {
                "name": f"{first or ''} {last or ''}".strip() or email or uid,
                "email": email,
                "status": status,
                "createdAt": created,
                "deleted": deleted is not None,
                "lastLoginAt": login,
                "lastSeenAt": seen,
                "lastActiveAt": active,
            }
    return out


async def _views(session: AsyncSession, ids: Iterable[str]) -> dict[str, dict]:
    """Name, workspace and visibility for the views a document mentions — what the redactor
    needs to decide, per reader, whether the name may leave."""
    out: dict[str, dict] = {}
    for chunk in _chunked(sorted({i for i in ids if i})):
        for vid, name, ws, visibility, created_by, deleted in (await session.execute(
            select(ViewORM.id, ViewORM.name, ViewORM.workspace_id, ViewORM.visibility,
                   ViewORM.created_by, ViewORM.deleted_at)
            .where(ViewORM.id.in_(chunk))
        )).all():
            out[vid] = {"name": name, "workspaceId": ws, "visibility": visibility,
                        "createdBy": created_by, "deleted": deleted is not None}
    return out


# ── The roster ────────────────────────────────────────────────────────


async def people_doc(
    session: AsyncSession, *, days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None, workspace_id: Optional[str] = None,
    lens: str = FULL, scope: Any = None,
) -> dict:
    """Everyone's activity over one window: a summary row per person, the scope's aggregates,
    and who has gone quiet. Read entirely from the rollup — a handful of grouped queries whose
    results are bounded by people × buckets, never by events.

    The rows carry no per-period series and no dates: those are added per PAGE by
    :func:`enrich_page`, so the cached document stays small at ten thousand people.

    ``scope`` is accepted and ignored so the analytics warmer can build this like its other
    surfaces; the document is always unredacted, and redacted per reader by the endpoint.
    """
    del scope
    if lens not in LENSES:
        raise ValueError(f"unknown lens {lens!r}")
    if lens == WORKSPACE and not workspace_id:
        raise ValueError("the workspace lens needs a workspace")
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)
    sc = _Scope(lens, workspace_id)
    first, last = _span(w)
    pfirst, plast = _prev_span(w)

    members = (
        (await members_by_workspace(session, now=now, workspace_id=workspace_id)).get(
            workspace_id, set())
        if workspace_id else None
    )
    people = (await _people_in_scope(session, sc, [(first, last), (pfirst, plast)], members or ())
              if sc.chunked else None)
    bits = list(SECTION_BITS.values())

    # Per person: one row each — per (person, day) folded in a subquery, then per person. In a
    # full-lens workspace scope a person-day is two rows, the workspace's and everywhere's.
    def per_person(where):
        per_day = (
            select(
                T.user_id.label("u"), T.day.label("d"),
                func.sum(sc.acts).label("acts"), func.sum(T.signins).label("sins"),
                func.max(sc.last_act).label("last_act"),
                func.max(T.last_signin_at).label("last_sin"),
                func.max(sc.sections).label("sec"),
            )
            .where(T.day >= first, T.day <= last, *where)
            .group_by(T.user_id, T.day)
        ).subquery()
        return (
            select(
                per_day.c.u,
                func.sum(per_day.c.acts), func.sum(per_day.c.sins),
                func.sum(case((per_day.c.acts > 0, 1), else_=0)),
                func.sum(case((per_day.c.sins > 0, 1), else_=0)),
                func.sum(case((and_(per_day.c.sins > 0, per_day.c.acts == 0), 1), else_=0)),
                func.max(per_day.c.last_act), func.max(per_day.c.last_sin),
                *[func.max(case((per_day.c.sec.op("&")(bit) != 0, 1), else_=0)) for bit in bits],
            ).group_by(per_day.c.u)
        )

    rows = await _each_chunk(session, sc, people, per_person)
    prev_rows = await _each_chunk(session, sc, people, lambda where: (
        select(T.user_id, func.sum(sc.acts), func.sum(T.signins))
        .where(T.day >= pfirst, T.day <= plast, *where)
        .group_by(T.user_id)))

    previous = {uid: int(a or 0) for uid, a, _ in prev_rows}
    prev_signed = sum(1 for _, _, s in prev_rows if s)

    ids = {r[0] for r in rows if r[0] and not is_service_account(r[0])}
    users = await _users(session, ids | set(members or ()))
    if members is not None:
        # People with access today: a binding can outlive its account, and a group can hold a
        # service account, and neither is a member anyone needs to nudge.
        members = {m for m in members
                   if m in users and not users[m]["deleted"] and not is_service_account(m)}

    full = lens == FULL
    roster = []
    section_people: Counter = Counter()
    for uid, acts, sins, active_days, sin_days, idle, last_act, last_sin, *visited in rows:
        if uid not in ids:
            continue
        for name, hit in zip(SECTION_BITS, visited):
            section_people[name] += int(hit or 0)
        acts, sins = int(acts or 0), int(sins or 0)
        if not acts and not (full and sins):
            continue
        u = users.get(uid, {})
        prev = previous.get(uid, 0)
        roster.append({
            "userId": uid,
            "name": u.get("name") or uid,
            "deleted": bool(u.get("deleted")),
            "actions": acts,
            "previous": prev,
            "changePct": _delta(acts, prev),
            "activeDays": int(active_days or 0),
            "signIns": sins if full else None,
            "signInDays": int(sin_days or 0) if full else None,
            "idleSignInDays": int(idle or 0) if full else None,
            "lastActiveAt": last_act,
            "lastSignInAt": (last_sin or u.get("lastLoginAt")) if full else None,
            "joinedInWindow": bool(u.get("createdAt") and u["createdAt"] >= w.start),
        })
    roster.sort(key=lambda r: (-r["actions"], -(r["signIns"] or 0), r["name"].lower()))

    active_ids = {r["userId"] for r in roster if r["actions"]}
    sign_in_days = sum(r["signInDays"] or 0 for r in roster)
    idle_days = sum(r["idleSignInDays"] or 0 for r in roster)
    facets = await _scope_facets(session, sc, w)
    series, kinds = await _scope_series(session, sc, w, people, facets["byKind"])
    punchcard, types = facets["punchcard"], facets["types"]
    sections = [{"section": name, "count": n, "people": section_people[name]}
                for name, n in facets["sections"].most_common()]
    if sc.chunked:
        signin_total = sum(k["count"] for k in kinds if k["kind"] == "signin")
        if signin_total:
            types.append({"type": SIGN_IN, "kind": "signin", "label": label_of(SIGN_IN),
                          "count": signin_total})
            types.sort(key=lambda t: -t["count"])

    scope_key = workspace_id or people_index_repo.PLATFORM
    timeline = await people_index_repo.timeline_for_workspace(
        session, scope_key, set(members or ()) - active_ids) if members is not None else {}
    quiet = await _quiet(session, members=members, active=active_ids, users=users, lens=lens,
                         timeline=timeline, scope_key=scope_key, workspace_id=workspace_id)

    doc = {
        "generatedAt": now.isoformat(),
        "window": _window_doc(w),
        "scope": {"workspaceId": workspace_id, "lens": lens},
        "coverage": await _coverage(session, now),
        "totals": {
            "activePeople": _m(len(active_ids), sum(1 for v in previous.values() if v)),
            "signedIn": _m(sum(1 for r in roster if r["signIns"]), prev_signed) if full else None,
            "actions": _m(sum(r["actions"] for r in roster), sum(previous.values())),
            "avgActiveDays": (
                round(sum(r["activeDays"] for r in roster if r["actions"]) / len(active_ids), 1)
                if active_ids else None
            ),
            "idleSignIns": (
                {"days": idle_days, "signInDays": sign_in_days,
                 "rate": round(idle_days / sign_in_days, 3) if sign_in_days else None}
                if full else None
            ),
            "newcomers": sum(1 for r in roster if r["joinedInWindow"] and r["actions"]),
            "members": len(members) if members is not None else None,
            "quiet": quiet["count"],
        },
        "series": series,
        "kinds": kinds,
        "types": types[:_TOP_TYPES] + (
            [{"type": "other", "kind": "other", "label": "Everything else",
              "count": sum(t["count"] for t in types[_TOP_TYPES:])}]
            if len(types) > _TOP_TYPES else []),
        "punchcard": punchcard,
        "sections": sections,
        "people": roster,
        "quiet": quiet,
    }
    doc["insights"] = _people_insights(doc, w)
    return doc


async def _scope_series(session: AsyncSession, sc: _Scope, w: Window,
                        people: Optional[list[str]],
                        by_kind: dict[str, list[int]]) -> tuple[dict, list[dict]]:
    """Per bucket: each kind's events (from the facets), and how many distinct people were
    active and signed in (from the totals: one row per person-day, grouped per bucket)."""
    first, last = _span(w)
    idx = {b: i for i, b in enumerate(w.buckets)}
    bucket = _bucket(T.day, w).label("b")
    in_window = [T.day >= first, T.day <= last]

    active = [0] * len(w.buckets)
    for b, n in (await session.execute(
        select(bucket, func.count(func.distinct(T.user_id)))
        .where(*in_window, T.workspace_id == sc.key,
               (T.actions_ws if sc.ws_lens else T.actions) > 0)
        .group_by("b")
    )).all():
        if b in idx:
            active[idx[b]] += int(n or 0)

    signed: Optional[list[int]] = None
    if sc.lens == FULL:
        # Everywhere's rows hold the sign-ins: all of them for the platform; for a workspace,
        # its people's, a chunk at a time — and the facets have none of theirs to count.
        signed = [0] * len(w.buckets)
        for b, n, total in await _each_chunk(session, sc, people, lambda where: (
            select(bucket, func.count(func.distinct(T.user_id)), func.sum(T.signins))
            .where(*in_window, T.signins > 0, T.workspace_id == EVERYWHERE, *where)
            .group_by("b"))):
            if b in idx:
                signed[idx[b]] += int(n or 0)
                if sc.chunked:
                    by_kind["signin"][idx[b]] += int(total or 0)

    shown = [k for k in KINDS if not (k == "signin" and sc.ws_lens)]
    series = {
        "buckets": list(w.buckets),
        "byKind": [{"kind": k, "values": by_kind[k]} for k in shown],
        "activePeople": active,
        "signedIn": signed,
    }
    return series, [{"kind": k, "count": sum(by_kind[k])} for k in shown]


async def _scope_facets(session: AsyncSession, sc: _Scope, w: Window) -> dict:
    """Everything about the scope that needs no one's name, from the facet rollup: the
    punchcard, "what people do" by name, each kind per bucket, and visits per section. At most
    days × (hours + types + kinds + sections) rows."""
    first, last = _span(w)
    by_hour: Counter = Counter()
    by_type: Counter = Counter()
    sections: Counter = Counter()
    by_kind = {k: [0] * len(w.buckets) for k in KINDS}
    for facet, value, day, n in (await session.execute(
        select(F.facet, F.value, F.day, func.sum(sc.fn))
        .where(F.day >= first, F.day <= last, *sc.facet_where())
        .group_by(F.facet, F.value, F.day)
    )).all():
        n = int(n or 0)
        if facet == "hour":
            by_hour[f"{day}T{value}"] += n
        elif facet == "type":
            by_type[value] += n
        elif facet == "kind" and value in by_kind:
            i = bisect_right(w.buckets, day) - 1
            if i >= 0:
                by_kind[value][i] += n
        elif facet == "section":
            sections[value] += n
    types = [{"type": t, "kind": kind_of(t), "label": label_of(t), "count": int(n)}
             for t, n in by_type.most_common() if n]
    return {"punchcard": _punchcard(by_hour), "types": types, "byKind": by_kind,
            "sections": +sections}


async def _quiet(
    session: AsyncSession, *, members: Optional[set[str]], active: set[str],
    users: dict[str, dict], lens: str, timeline: dict[str, dict], scope_key: str,
    workspace_id: Optional[str],
) -> dict:
    """Who has access and did nothing in the window: an exact count, and the most recently
    active of them by name — at most ``_QUIET_LISTED``, in any scope. A list of thousands is
    one nobody reads past the first screen.

    ``lastActiveAt`` is their last activity IN THIS SCOPE, from the index. When they last
    signed in, or did anything anywhere, is presence a workspace admin is not told.
    """
    def _row(uid: str, u: dict) -> dict:
        here = timeline.get(uid, {}).get("lastActiveAt")
        return {
            "userId": uid, "name": u.get("name") or uid, "email": u.get("email"),
            "joinedAt": timeline.get(uid, {}).get("joinedAt")
            or (u.get("createdAt") if workspace_id is None else None),
            "lastLoginAt": u.get("lastLoginAt") if lens == FULL else None,
            "lastActiveAt": here or (u.get("lastActiveAt") if lens == FULL and workspace_id is None
                                     else None),
        }

    if members is not None:
        quiet_ids = sorted((m for m in members if m not in active),
                           key=lambda m: (timeline.get(m, {}).get("lastActiveAt") or ""),
                           reverse=True)
        joins = await people_index_repo.join_candidates(session, workspace_id=workspace_id)
        for uid in quiet_ids[:_QUIET_LISTED]:
            t = timeline.setdefault(uid, {})
            t["joinedAt"] = people_index_repo.merge_join(t, joins.get((uid, workspace_id)))
        return {"count": len(quiet_ids),
                "people": [_row(m, users.get(m, {})) for m in quiet_ids[:_QUIET_LISTED]]}

    live = [UserORM.deleted_at.is_(None), is_person(UserORM.id),
            UserORM.status == "active", UserORM.is_system_account.is_not(True)]
    total_live = int((await session.execute(
        select(func.count()).select_from(UserORM).where(*live))).scalar() or 0)
    live_active = 0
    for chunk in _chunked(sorted(active)):
        live_active += int((await session.execute(
            select(func.count()).select_from(UserORM).where(*live, UserORM.id.in_(chunk))
        )).scalar() or 0)
    # Over-fetch by the number of active people so the cap survives skipping them, without
    # reading the whole users table.
    candidates = (await session.execute(
        select(UserORM.id).where(*live)
        .order_by(UserORM.last_active_at.desc().nulls_last(), UserORM.id)
        .limit(_QUIET_LISTED + len(active))
    )).scalars().all()
    wanted = [c for c in candidates if c not in active][:_QUIET_LISTED]
    named = await _users(session, wanted)
    timeline.update(await people_index_repo.timeline_for_workspace(session, scope_key, wanted))
    return {"count": max(total_live - live_active, 0),
            "people": [_row(uid, named.get(uid, {})) for uid in wanted]}


async def _coverage(session: AsyncSession, now: datetime) -> dict:
    """How far the figures reach: the newest ledger row (sign-ins and operations come from
    there), when section visits began being recorded, and how much of history the rollup
    holds. Each is an index seek or a scan of at most a year of day rows."""
    return {
        "ledgerThrough": (await session.execute(
            select(func.max(AuthAuditLogORM.occurred_at)))).scalar(),
        "sectionsSince": (await session.execute(
            select(func.min(ProductEventORM.created_at))
            .where(ProductEventORM.event_type == SECTION))).scalar(),
        "index": await people_index_repo.coverage(session, now=now),
    }


# ── A page of people, and their lines ─────────────────────────────────


async def lines(
    session: AsyncSession, user_ids: Sequence[str], *, days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None, now: Optional[datetime] = None,
    workspace_id: Optional[str] = None, lens: str = FULL,
) -> dict:
    """Each person's activity line: their actions per bucket of the window, in the scope.

    One grouped read of the rollup through ``(user_id, day)``: at most people × buckets rows,
    for a page or a compare chart — never for everyone. In a workspace a line counts only what
    happened there."""
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)
    out, _ = await _drawn(session, user_ids, w, _Scope(lens, workspace_id))
    return {"buckets": list(w.buckets), "granularity": w.granularity, "lines": out}


async def _drawn(session: AsyncSession, user_ids: Sequence[str], w: Window,
                 sc: _Scope) -> tuple[dict[str, list[int]], dict[str, Optional[str]]]:
    """Some people's actions per bucket, and the kind each did most: one read grouped by
    person, bucket and kind — people × buckets × kinds rows at most."""
    first, last = _span(w)
    idx = {b: i for i, b in enumerate(w.buckets)}
    bucket = _bucket(A.day, w).label("b")
    out = {uid: [0] * len(w.buckets) for uid in user_ids}
    per_kind: dict[str, Counter] = {}
    where = ([A.workspace_id == sc.workspace_id] + ([A.n_ws > 0] if sc.ws_lens else [])
             if sc.workspace_id else [])
    for chunk in _chunked(sorted(set(user_ids))):
        for uid, b, kind, n in (await session.execute(
            select(A.user_id, bucket, A.kind, func.sum(sc.n))
            .where(A.user_id.in_(chunk), A.day >= first, A.day <= last, _ACTION, *where)
            .group_by(A.user_id, "b", A.kind)
        )).all():
            n = int(n or 0)
            if uid in out and b in idx:
                out[uid][idx[b]] += n
                per_kind.setdefault(uid, Counter())[kind] += n
    top = {uid: min(((k, n) for k, n in c.items() if n),
                    key=lambda kn: (-kn[1], KINDS.index(kn[0])), default=(None, 0))[0]
           for uid, c in per_kind.items()}
    return out, top


async def enrich_page(
    session: AsyncSession, rows: list[dict], *, days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None, now: Optional[datetime] = None,
    workspace_id: Optional[str] = None, lens: str = FULL, emails: bool = False,
) -> list[dict]:
    """What a page of roster rows needs beyond the cached summary: each person's activity line
    and the kind they did most, when they joined and were first and last active in the scope, and — for a reader allowed
    it — their address. Bounded by the page, never by everyone."""
    ids = [r["userId"] for r in rows]
    if not ids:
        return rows
    w = build_window(days, start=start, end=end, now=now or datetime.now(timezone.utc))
    drawn, top_kind = await _drawn(session, ids, w, _Scope(lens, workspace_id))
    scope_key = workspace_id or people_index_repo.PLATFORM
    timeline = await people_index_repo.timeline_for_workspace(session, scope_key, ids)
    joins = ({uid: at for (uid, _ws), at in (await people_index_repo.join_candidates(
        session, workspace_id=workspace_id)).items()} if workspace_id else {})
    users = await _users(session, ids)
    out = []
    for r in rows:
        uid = r["userId"]
        t = timeline.get(uid, {})
        u = users.get(uid, {})
        out.append({
            **r,
            "line": drawn.get(uid, []),
            "topKind": top_kind.get(uid),
            "joinedAt": (people_index_repo.merge_join(t, joins.get(uid)) if workspace_id
                         else u.get("createdAt")),
            "firstActiveAt": t.get("firstActiveAt"),
            "lastActiveEverAt": t.get("lastActiveAt") or r.get("lastActiveAt"),
            **({"email": u.get("email")} if emails else {}),
        })
    return out


async def scope_day(
    session: AsyncSession, day: str, *, workspace_id: Optional[str] = None, lens: str = FULL,
    limit: int = 200,
) -> dict:
    """Everyone active on one UTC day in the scope — exactly, not a sample: one grouped read of
    that day's rollup rows, then the most active ``limit`` named."""
    sc = _Scope(lens, workspace_id)
    where = ([A.workspace_id == workspace_id] + ([A.n_ws > 0] if sc.ws_lens else [])
             if workspace_id else [])
    per: dict[str, dict] = {}
    kinds: Counter = Counter()
    for uid, kind, n in (await session.execute(
        select(A.user_id, A.kind, func.sum(sc.n))
        .where(A.day == day, ~_SECTION_ROW, *where).group_by(A.user_id, A.kind)
    )).all():
        n = int(n or 0)
        if not n:
            continue
        p = per.setdefault(uid, {"actions": 0, "signIns": 0, "kinds": {}})
        if kind == "signin":
            p["signIns"] += n
        else:
            p["actions"] += n
        p["kinds"][kind] = p["kinds"].get(kind, 0) + n
        kinds[kind] += n
    active = sorted((u for u, p in per.items() if p["actions"]),
                    key=lambda u: (-per[u]["actions"], u))
    named = await _users(session, active[:limit])
    return {
        "day": day,
        "scope": {"workspaceId": workspace_id, "lens": lens},
        "active": len(active),
        # Sign-ins happened in no workspace; a workspace's day does not read them.
        "signedIn": None if workspace_id else sum(1 for p in per.values() if p["signIns"]),
        "kinds": [{"kind": k, "count": int(kinds[k])} for k in KINDS if kinds.get(k)],
        "people": [
            {"userId": u, "name": named.get(u, {}).get("name") or u,
             "actions": per[u]["actions"],
             "signIns": None if workspace_id else per[u]["signIns"],
             "kinds": per[u]["kinds"]}
            for u in active[:limit]
        ],
    }


# ── Shaping ───────────────────────────────────────────────────────────


def _type_list(types: Counter, kinds: dict[str, str]) -> list[dict]:
    ranked = types.most_common()
    head = ranked[:_TOP_TYPES]
    out = [
        {"type": t, "kind": kinds.get(t) or kind_of(t), "label": label_of(t), "count": int(n)}
        for t, n in head
    ]
    tail = sum(n for _, n in ranked[_TOP_TYPES:])
    if tail:
        out.append({"type": "other", "kind": "other", "label": "Everything else", "count": int(tail)})
    return out


def _window_doc(w: Window) -> dict:
    return {"days": w.days, "start": w.start, "end": w.end,
            "granularity": w.granularity, "buckets": list(w.buckets)}


def _streaks(days: set[str], *, last_day: str) -> tuple[int, int]:
    """(longest run of consecutive active days, the run ending on ``last_day`` or the day
    before — a streak is not broken by today not being over yet)."""
    if not days:
        return 0, 0
    ordered = sorted(date.fromisoformat(d) for d in days)
    longest = run = 1
    for prev, cur in zip(ordered, ordered[1:]):
        run = run + 1 if (cur - prev).days == 1 else 1
        longest = max(longest, run)
    end = date.fromisoformat(last_day)
    current = 0
    cursor = end if end in set(ordered) else end - timedelta(days=1)
    have = set(ordered)
    while cursor in have:
        current += 1
        cursor -= timedelta(days=1)
    return longest, current


def _minute_of_day(ts: str) -> Optional[int]:
    try:
        at = datetime.fromisoformat(ts)
    except (TypeError, ValueError):
        return None
    at = at.astimezone(timezone.utc) if at.tzinfo else at
    return at.hour * 60 + at.minute


def _m(current: int, previous: int) -> dict:
    return {"current": int(current), "previous": int(previous),
            "changePct": _delta(int(current), int(previous))}


def _people_insights(doc: dict, w: Window) -> list[dict]:
    """What a reader should notice, in sentences. Pure: a function of the finished document,
    so no sentence can contradict the chart beneath it. Every rule is guarded on enough
    people that a young install gets silence rather than findings made of three users."""
    out: list[dict] = []
    totals = doc["totals"]
    label = _window_label(w)

    members, quiet = totals.get("members"), totals.get("quiet")
    if members and members >= 5 and quiet:
        share = quiet / members
        out.append(_insight(
            "people-quiet-members", "watch" if share >= 0.25 else "neutral",
            f"{quiet} of {members} members did nothing here {label}",
            "They still have access. A nudge, or a review of who needs it, is the next step.",
            score=share * 10,
        ))

    idle = totals.get("idleSignIns")
    if idle and idle["signInDays"] >= 20 and idle["rate"] and idle["rate"] >= 0.25:
        out.append(_insight(
            "people-idle-sign-ins", "watch",
            f"{_pct(idle['rate'] * 100)} of sign-in days led to nothing",
            "People signed in and left without opening, tracing or changing anything. "
            "Check what they land on.",
            score=idle["rate"] * 8,
        ))

    active = totals["activePeople"]
    change = active.get("changePct")
    if active["previous"] >= 5 and change is not None and abs(change) >= 15:
        up = change > 0
        out.append(_insight(
            "people-active-change", "good" if up else "bad",
            f"Active people {'up' if up else 'down'} {_pct(change)} {label}",
            f"{active['current']} {_plural(active['current'], 'person', 'people')} did something, "
            f"against {active['previous']} in the period before.",
            score=abs(change) / 10, spark=doc["series"]["activePeople"],
        ))

    people = [p for p in doc["people"] if p["actions"]]
    if len(people) >= 10:
        top = max(1, len(people) // 10)
        share = sum(p["actions"] for p in people[:top]) / max(1, sum(p["actions"] for p in people))
        if share >= 0.5:
            out.append(_insight(
                "people-concentration", "watch",
                f"The most active 10% of people do {_pct(share * 100)} of the work",
                "Usage leans on a few people. If they move on, so does the habit.",
                score=share * 6,
            ))

    grid = doc["punchcard"]
    busiest = max(((d, h, grid[d][h]) for d in range(7) for h in range(24)),
                  key=lambda t: t[2], default=(0, 0, 0))
    if sum(map(sum, grid)) >= 50 and busiest[2] > 0:
        weekday = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday",
                   "Saturday", "Sunday")[busiest[0]]
        out.append(_insight(
            "people-peak-hour", "neutral",
            f"Busiest on {weekday}s around {busiest[1]:02d}:00 UTC",
            "A good time for changes people should see, and a bad time for maintenance.",
            score=1,
        ))

    out.sort(key=lambda i: -i["_score"])
    for item in out:
        item.pop("_score", None)
    return out


# ── One person ────────────────────────────────────────────────────────


def _person_where(user_id: str, workspace_id: Optional[str], lens: str) -> list:
    where = [A.user_id == user_id]
    if workspace_id is None:
        return where
    if lens == WORKSPACE:
        return where + [A.workspace_id == workspace_id, A.n_ws > 0]
    return where + [or_(A.workspace_id == workspace_id,
                        and_(A.workspace_id == people_index_repo.PLATFORM, A.kind == "signin"))]


async def _raw_person_details(
    session: AsyncSession, user_id: str, w: Window, *, workspace_id: Optional[str], lens: str,
) -> tuple[Counter, dict[str, str], Counter, Counter]:
    """What only raw events hold, for one person over one window, each a small grouped read
    through that store's actor index: counts by event type, actions by hour, and the views they
    opened. Bounded by what one person did."""
    types: Counter = Counter()
    type_kinds: dict[str, str] = {}
    by_hour: Counter = Counter()
    opens: Counter = Counter()

    P = ProductEventORM
    where = [P.actor_id == user_id, P.created_at >= w.start, P.created_at < w.end,
             P.event_type.in_(list(USAGE_KINDS))]
    if workspace_id:
        where.append(P.workspace_id == workspace_id)
    for t, n in (await session.execute(
        select(P.event_type, func.count()).where(*where).group_by(P.event_type))).all():
        types[t] += int(n)
        type_kinds[t] = USAGE_KINDS[t]
    for h, n in (await session.execute(
        select(_hour(P.created_at).label("h"), func.count()).where(*where).group_by("h"))).all():
        by_hour[h] += int(n)
    for vid, n in (await session.execute(
        select(P.subject_id, func.count()).where(*where, P.event_type == VIEW_OPENED,
                                                 P.subject_id.is_not(None))
        .group_by(P.subject_id))).all():
        opens[vid] += int(n)

    E = ViewActivityLogORM
    ewhere = [E.actor == user_id, E.created_at >= w.start, E.created_at < w.end]
    if workspace_id:
        ewhere.append(E.workspace_id == workspace_id)
    if lens == WORKSPACE:
        ewhere.append(E.action != _ADMIN_VIEWED)
    for action, h, n in (await session.execute(
        select(E.action, _hour(E.created_at).label("h"), func.count())
        .where(*ewhere).group_by(E.action, "h"))).all():
        t = edit_type(action)
        types[t] += int(n)
        type_kinds[t] = kind_of(t)
        by_hour[h] += int(n)

    L = AuthAuditLogORM
    lwhere = [L.actor_id == user_id, L.actor_kind == "user",
              L.occurred_at >= w.start, L.occurred_at < w.end,
              ~L.event_type.startswith(_MIRRORED_LEDGER_PREFIX, autoescape=True)]
    scoped = _ledger_scope(lens, workspace_id)
    if workspace_id and lens == FULL:
        # Their sign-ins happened in no workspace; the full lens shows them beside the rest.
        lwhere.append(or_(and_(*scoped), L.event_type == SIGN_IN))
    else:
        lwhere += scoped
    if lens == WORKSPACE:
        lwhere.append(L.event_type != SIGN_IN)
    for t, category, h, n in (await session.execute(
        select(L.event_type, L.category, _hour(L.occurred_at).label("h"), func.count())
        .where(*lwhere).group_by(L.event_type, L.category, "h"))).all():
        types[t] += int(n)
        kind = ledger_kind(t, category)
        type_kinds[t] = kind
        if kind != "signin":
            by_hour[h] += int(n)
    return types, type_kinds, by_hour, opens


async def person_doc(
    session: AsyncSession, user_id: str, *, days: Optional[int] = None,
    start: Optional[str] = None, end: Optional[str] = None,
    now: Optional[datetime] = None, workspace_id: Optional[str] = None,
    lens: str = FULL,
) -> Optional[dict]:
    """One person over one window. ``None`` when there is no such account."""
    now = now or datetime.now(timezone.utc)
    w = build_window(days, start=start, end=end, now=now)
    prev_w = previous_window(w)
    who = await profile(session, user_id)
    if who is None:
        return None
    sc = _Scope(lens, workspace_id)
    first, last = _span(w)
    pfirst, plast = _prev_span(w)
    where = _person_where(user_id, workspace_id, lens)

    # Their days, from the rollup: at most two windows of days × kinds.
    day_rows = (await session.execute(
        select(A.day, A.kind, func.sum(sc.n), func.min(sc.first), func.max(sc.last))
        .where(A.day >= pfirst, A.day <= last, *where).group_by(A.day, A.kind)
    )).all()
    n_b = len(w.buckets)
    by_kind = {k: [0] * n_b for k in KINDS}
    actions_line, prev_line, signins_line = [0] * n_b, [0] * len(prev_w.buckets), [0] * n_b
    idx = {b: i for i, b in enumerate(w.buckets)}
    pidx = {b: i for i, b in enumerate(prev_w.buckets)}
    kinds_total: Counter = Counter()
    prev_kinds: Counter = Counter()
    sections: Counter = Counter()
    active_days: set[str] = set()
    signin_days: set[str] = set()
    prev_active: set[str] = set()
    actions = prev_actions = signins = prev_signins = 0
    first_by_day: dict[str, str] = {}
    last_by_day: dict[str, str] = {}
    last_action: Optional[str] = None
    for day, kind, n, f_at, l_at in day_rows:
        n = int(n or 0)
        if not n:
            continue
        current = day >= first
        if kind.startswith(SECTION_KIND_PREFIX):
            if current:
                sections[kind[len(SECTION_KIND_PREFIX):]] += n
            continue
        if not current:
            prev_kinds[kind] += n
            if kind == "signin":
                prev_signins += n
            else:
                prev_actions += n
                prev_active.add(day)
                b = prev_w.bucket_of(day)
                if b in pidx:
                    prev_line[pidx[b]] += n
            continue
        b = w.bucket_of(day)
        i = idx.get(b) if b else None
        kinds_total[kind] += n
        if i is not None:
            by_kind[kind][i] += n
        if kind == "signin":
            signins += n
            signin_days.add(day)
            if i is not None:
                signins_line[i] += n
            continue
        actions += n
        active_days.add(day)
        if i is not None:
            actions_line[i] += n
        if f_at and (day not in first_by_day or f_at < first_by_day[day]):
            first_by_day[day] = f_at
        if l_at and (day not in last_by_day or l_at > last_by_day[day]):
            last_by_day[day] = l_at
        if l_at and (last_action is None or l_at > last_action):
            last_action = l_at

    firsts = [m for m in map(_minute_of_day, first_by_day.values()) if m is not None]
    lasts = [m for m in map(_minute_of_day, last_by_day.values()) if m is not None]
    longest, current_streak = _streaks(active_days, last_day=last)

    by_ws = Counter({ws: int(n or 0) for ws, n in (await session.execute(
        select(A.workspace_id, func.sum(sc.n))
        .where(A.day >= first, A.day <= last, _ACTION, *where,
               A.workspace_id != people_index_repo.PLATFORM)
        .group_by(A.workspace_id))).all()})

    types, type_kinds, by_hour, opens = await _raw_person_details(
        session, user_id, w, workspace_id=workspace_id, lens=lens)

    # Every workspace they belong to or were ever active in, with when they joined it and were
    # first and last active there — from the index, so it reaches past the window and past
    # raw-event retention.
    timeline = await people_index_repo.timeline_for_person(session, user_id)
    platform_row = timeline.pop(people_index_repo.PLATFORM, {})
    joins = {ws: at for (_uid, ws), at in (await people_index_repo.join_candidates(
        session, user_id=user_id, workspace_id=workspace_id)).items()}
    ws_ids = set(by_ws) | set(timeline) | set(joins)
    if workspace_id:
        ws_ids &= {workspace_id}
    ws_names = await user_repo.get_workspace_names_by_ids(session, sorted(ws_ids))
    ws_rows = []
    for ws in ws_ids:
        t = timeline.get(ws, {})
        ws_rows.append({
            "workspaceId": ws, "name": ws_names.get(ws), "actions": int(by_ws.get(ws, 0)),
            "joinedAt": people_index_repo.merge_join(t, joins.get(ws)),
            "firstActiveAt": t.get("firstActiveAt"),
            "lastActiveAt": t.get("lastActiveAt"),
            "member": ws in joins,
        })
    # Busiest in the window first, then most recently active.
    ws_rows.sort(key=lambda r: (r["actions"], r["lastActiveAt"] or ""), reverse=True)
    top_views = [vid for vid, _ in opens.most_common(10)]
    view_meta = await _views(session, top_views)

    def _count(names: Sequence[str]) -> int:
        return int(sum(types.get(t, 0) for t in names))

    # Opens, traces and searches from the rollup's kinds — the same measurement in both
    # periods; the raw types only split a trace that found lineage from one that did not.
    traces, searches = int(kinds_total.get("trace", 0)), int(kinds_total.get("search", 0))
    full = lens == FULL
    shown = [k for k in KINDS if not (k == "signin" and not full)]
    doc = {
        "generatedAt": now.isoformat(),
        "window": _window_doc(w),
        "scope": {"workspaceId": workspace_id, "lens": lens},
        "coverage": await _coverage(session, now),
        "profile": {**who,
                    "firstActiveAt": platform_row.get("firstActiveAt") if not workspace_id
                    else (timeline.get(workspace_id) or {}).get("firstActiveAt")},
        "totals": {
            "actions": _m(actions, prev_actions),
            "activeDays": _m(len(active_days), len(prev_active)),
            "signIns": _m(signins, prev_signins) if full else None,
            "idleSignInDays": len(signin_days - active_days) if full else None,
            "viewsOpened": _m(int(kinds_total.get("browse", 0)), int(prev_kinds.get("browse", 0))),
            "distinctViews": len(opens),
            "traces": _m(traces, int(prev_kinds.get("trace", 0))),
            "traceEmptyRate": (round(_count((TRACE_EMPTY,)) / _count((TRACE_RUN, TRACE_EMPTY)), 3)
                               if _count((TRACE_RUN, TRACE_EMPTY)) else None),
            "searches": _m(searches, int(prev_kinds.get("search", 0))),
            "searchMissRate": (round(_count((SEARCH_MISS,)) / _count((SEARCH_RUN, SEARCH_MISS)), 3)
                               if _count((SEARCH_RUN, SEARCH_MISS)) else None),
            "longestStreak": longest,
            "currentStreak": current_streak,
            "lastActiveAt": last_action,
        },
        "series": {
            "buckets": list(w.buckets),
            "byKind": [{"kind": k, "values": by_kind[k]} for k in shown],
            "activePeople": [1 if v else 0 for v in actions_line],
            "signedIn": [1 if v else 0 for v in signins_line] if full else None,
            # Their activity line, the period before it index-aligned for the ghost, and their
            # sign-ins beside it.
            "actions": actions_line,
            "previousActions": prev_line,
            "signIns": signins_line if full else None,
        },
        "kinds": [{"kind": k, "count": int(kinds_total.get(k, 0))} for k in shown],
        "types": _type_list(types, type_kinds),
        "punchcard": _punchcard(by_hour),
        "sections": [{"section": s, "count": int(n), "people": 1} for s, n in sections.most_common()],
        "typicalDay": {
            "firstMinute": int(median(firsts)) if firsts else None,
            "lastMinute": int(median(lasts)) if lasts else None,
            "days": len(firsts),
        },
        "workspaces": ws_rows,
        "views": [
            {"viewId": vid, "opens": int(opens[vid]), **view_meta.get(vid, {"name": None,
             "workspaceId": None, "visibility": None, "createdBy": None, "deleted": True})}
            for vid in top_views
        ],
        "signIns": (await _sign_in_detail(session, user_id, w) if full else None),
    }
    return doc


async def person_calendar(
    session: AsyncSession, user_id: str, *, now: Optional[datetime] = None,
    workspace_id: Optional[str] = None, lens: str = FULL,
) -> dict:
    """The last year, a day at a time, from the rollup — independent of the range picker, so
    the calendar on a person's page always shows the whole year around the selected window."""
    now = now or datetime.now(timezone.utc)
    last = now.date()
    first = last - timedelta(days=CALENDAR_DAYS - 1)
    sc = _Scope(lens, workspace_id)
    actions: Counter = Counter()
    sign_ins: Counter = Counter()
    for day, acts, sins in (await session.execute(
        select(A.day, func.sum(case((_ACTION, sc.n), else_=0)),
               func.sum(case((_SIGNIN, sc.n), else_=0)))
        .where(A.day >= first.isoformat(), A.day <= last.isoformat(),
               *_person_where(user_id, workspace_id, lens))
        .group_by(A.day)
    )).all():
        actions[day] += int(acts or 0)
        sign_ins[day] += int(sins or 0)
    days = [(first + timedelta(days=i)).isoformat() for i in range(CALENDAR_DAYS)]
    return {
        "generatedAt": now.isoformat(),
        "scope": {"workspaceId": workspace_id, "lens": lens},
        "days": days,
        "actions": [int(actions.get(d, 0)) for d in days],
        "signIns": [int(sign_ins.get(d, 0)) for d in days] if lens == FULL else None,
    }


async def profile(session: AsyncSession, user_id: str) -> Optional[dict]:
    users = await _users(session, [user_id])
    u = users.get(user_id)
    if u is None:
        return None
    return {"userId": user_id, **u}


def _method(payload: dict) -> str:
    """How a sign-in happened, as the ledger recorded it: an SSO provider's slug, or how a
    local sign-in got in (``via``), or ``local``."""
    return str(payload.get("provider_slug") or payload.get("via") or payload.get("provider")
               or "local")


async def _sign_in_detail(session: AsyncSession, user_id: str, w: Window) -> dict:
    """Their own sign-ins, how they were made, and the failures against their account. Only on
    the full lens: a workspace admin is told nothing about anyone's sign-ins."""
    T = AuthAuditLogORM
    rows = (await session.execute(
        select(T.occurred_at, T.payload)
        .where(T.actor_id == user_id, T.event_type == SIGN_IN,
               *_bounds(T.occurred_at, w.start, w.end))
        .order_by(T.occurred_at.desc())
        .limit(500)
    )).all()
    methods: Counter = Counter()
    recent = []
    for at, raw in rows:
        try:
            payload = json.loads(raw) if raw else {}
        except (TypeError, ValueError):
            payload = {}
        method = _method(payload if isinstance(payload, dict) else {})
        methods[method] += 1
        if len(recent) < 10:
            recent.append({"at": at, "method": method})
    failed = int((await session.execute(
        select(func.count()).select_from(T).where(
            T.subject_id == user_id, T.event_type.in_(_FAILED_SIGN_INS),
            *_bounds(T.occurred_at, w.start, w.end),
        )
    )).scalar() or 0)
    return {
        "methods": [{"key": k, "count": int(n)} for k, n in methods.most_common()],
        "recent": recent,
        "failed": failed,
        "capped": len(rows) >= 500,
    }


# ── One person's events ───────────────────────────────────────────────

#: What a feed can be filtered to: the activity kinds, and section moves.
FEED_KINDS: tuple[str, ...] = KINDS + ("section",)


_BUILD_PREFIXES = ("ontology.", "workspace.versioning.", "visualization.")


def _usage_types_for(kinds: Optional[set[str]]) -> list[str]:
    types = [t for t, k in USAGE_KINDS.items() if kinds is None or k in kinds]
    if kinds is None or "section" in kinds:
        types.append(SECTION)
    return types


def _edit_actions_for(kinds: Optional[set[str]]) -> Optional[list[str]]:
    """``None`` for every action; a list (maybe empty) for the kinds asked for."""
    if kinds is None:
        return None
    return [a for a, (_label, k) in _EDIT_META.items() if k in kinds]


def _ledger_kinds_clause(kinds: Optional[set[str]]):
    """:func:`ledger_kind` as SQL, so a filtered feed pages through the ledger in the
    database rather than discarding rows after reading them."""
    if kinds is None:
        return None
    L = AuthAuditLogORM
    build = or_(*[L.event_type.startswith(p, autoescape=True) for p in _BUILD_PREFIXES])
    operating = L.category.in_(("operations", "data"))
    clauses = {
        "signin": L.event_type == SIGN_IN,
        "build": and_(L.event_type != SIGN_IN, build),
        "operate": and_(L.event_type != SIGN_IN, ~build, operating),
        "other": and_(L.event_type != SIGN_IN, ~build,
                      or_(L.category.is_(None), ~operating)),
    }
    picked = [clauses[k] for k in kinds if k in clauses]
    return or_(*picked) if picked else False


def _keyset(ts_col, id_col, before: Optional[tuple[str, str]]) -> list:
    if not before:
        return []
    at, eid = before
    return [or_(ts_col < at, and_(ts_col == at, id_col < eid))]


async def person_events(
    session: AsyncSession, user_id: str, *, since: Optional[str] = None,
    until: Optional[str] = None, before: Optional[tuple[str, str]] = None,
    limit: int = 50, newest_first: bool = True, workspace_id: Optional[str] = None,
    lens: str = FULL, kinds: Optional[set[str]] = None,
) -> tuple[list[dict], Optional[tuple[str, str]]]:
    """One person's individual events from all three stores, merged in time order.

    Keyset-paged on ``(at, id)``: each store is read through its actor index for at most
    ``limit + 1`` rows past the cursor, the merge keeps the first ``limit``, and the next
    cursor is the last row KEPT — so paging can never skip a row or loop, whichever store the
    rows came from. Returns ``(events, next_cursor)``; no cursor means the end.

    In a workspace, a view open with no workspace yet (recorded in the last minutes, before
    the indexer has placed it) is read and then placed through its view, so the feed is
    current without waiting for the index. A page can then come back short; the cursor
    still moves, and the next page carries on.
    """
    direction = (lambda c: c.desc()) if newest_first else (lambda c: c.asc())
    candidates: list[tuple[str, str, str, tuple]] = []

    P = ProductEventORM
    types = _usage_types_for(kinds)
    if types:
        where = [P.actor_id == user_id, P.event_type.in_(types),
                 *_bounds(P.created_at, since or "", until), *_keyset(P.created_at, P.id, before)]
        if workspace_id:
            where.append(or_(P.workspace_id == workspace_id,
                             and_(P.workspace_id.is_(None), P.event_type == VIEW_OPENED)))
        for row in (await session.execute(
            select(P.id, P.created_at, P.event_type, P.subject_id, P.workspace_id)
            .where(*where).order_by(direction(P.created_at), direction(P.id)).limit(limit + 1)
        )).all():
            candidates.append((row[1], row[0], "usage", tuple(row)))

    E = ViewActivityLogORM
    actions = _edit_actions_for(kinds)
    if actions is None or actions:
        where = [E.actor == user_id, *_bounds(E.created_at, since or "", until),
                 *_keyset(E.created_at, E.id, before)]
        if actions is not None:
            where.append(E.action.in_(actions))
        if workspace_id:
            where.append(E.workspace_id == workspace_id)
        if lens == WORKSPACE:
            where.append(E.action != _ADMIN_VIEWED)
        for row in (await session.execute(
            select(E.id, E.created_at, E.action, E.view_id, E.workspace_id, E.summary)
            .where(*where).order_by(direction(E.created_at), direction(E.id)).limit(limit + 1)
        )).all():
            candidates.append((row[1], row[0], "edit", tuple(row)))

    L = AuthAuditLogORM
    kinds_clause = _ledger_kinds_clause(kinds)
    if kinds_clause is not False:
        where = [
            L.actor_id == user_id, L.actor_kind == "user",
            *_bounds(L.occurred_at, since or "", until), *_keyset(L.occurred_at, L.id, before),
            ~L.event_type.startswith(_MIRRORED_LEDGER_PREFIX, autoescape=True),
        ]
        if kinds_clause is not None:
            where.append(kinds_clause)
        if lens == WORKSPACE:
            where.append(L.event_type != SIGN_IN)
        if workspace_id:
            scoped = and_(*_ledger_scope(lens, workspace_id))
            where.append(or_(scoped, L.event_type == SIGN_IN) if lens == FULL else scoped)
        for row in (await session.execute(
            select(L.id, L.occurred_at, L.event_type, L.category, L.target_type, L.target_id,
                   L.target_label, L.workspace_id, L.outcome)
            .where(*where).order_by(direction(L.occurred_at), direction(L.id)).limit(limit + 1)
        )).all():
            candidates.append((row[1], row[0], "ledger", tuple(row)))

    candidates.sort(key=lambda c: (c[0], c[1]), reverse=newest_first)
    kept = candidates[:limit]
    next_cursor = (kept[-1][0], kept[-1][1]) if len(candidates) > limit and kept else None

    opened = {row[3] for _, _, src, row in kept if src == "usage" and row[2] == VIEW_OPENED}
    edited = {row[3] for _, _, src, row in kept if src == "edit" and row[3]}
    views = await _views(session, opened | edited)

    events: list[dict] = []
    for at, eid, src, row in kept:
        if src == "usage":
            _id, _at, t, subject, ws = row
            if t == VIEW_OPENED:
                ws = ws or views.get(subject, {}).get("workspaceId")
            if workspace_id and ws != workspace_id:
                continue
            events.append({
                "id": eid, "at": at, "type": t,
                "kind": "section" if t == SECTION else USAGE_KINDS[t],
                "label": "Went to a section" if t == SECTION else USAGE_LABELS[t],
                "workspaceId": ws,
                "section": subject if t == SECTION else None,
                "viewId": subject if t == VIEW_OPENED else None,
            })
        elif src == "edit":
            _id, _at, action, view_id, ws, summary = row
            t = edit_type(action)
            events.append({
                "id": eid, "at": at, "type": t, "kind": kind_of(t), "label": label_of(t),
                "workspaceId": ws, "viewId": view_id, "summary": summary,
            })
        else:
            _id, _at, t, category, target_type, target_id, target_label, ws, outcome = row
            events.append({
                "id": eid, "at": at, "type": t, "kind": ledger_kind(t, category),
                "label": catalogue.label_of(t), "workspaceId": ws, "outcome": outcome,
                "target": ({"type": target_type, "id": target_id, "label": target_label}
                           if target_type or target_label else None),
            })

    ws_names = await user_repo.get_workspace_names_by_ids(
        session, sorted({e["workspaceId"] for e in events if e.get("workspaceId")}))
    for e in events:
        if e.get("viewId"):
            meta = views.get(e["viewId"], {})
            e["view"] = {"id": e["viewId"], "name": meta.get("name"),
                         "workspaceId": meta.get("workspaceId"),
                         "visibility": meta.get("visibility"),
                         "createdBy": meta.get("createdBy"),
                         "deleted": meta.get("deleted", True)}
        if e.get("workspaceId"):
            e["workspaceName"] = ws_names.get(e["workspaceId"])
    return events, next_cursor


async def person_day(
    session: AsyncSession, user_id: str, day: str, *,
    workspace_id: Optional[str] = None, lens: str = FULL, cap: int = DAY_CAP,
) -> dict:
    """Everything one person did on one UTC day, in order, split into sessions.

    Not cached and not grouped: one person and one day, read through each table's actor
    index — the one place besides the feed where a reader sees individual events."""
    the_day = date.fromisoformat(day)
    since = datetime.combine(the_day, datetime.min.time(), tzinfo=timezone.utc).isoformat()
    until = datetime.combine(the_day + timedelta(days=1), datetime.min.time(),
                             tzinfo=timezone.utc).isoformat()
    events, more = await person_events(
        session, user_id, since=since, until=until, limit=cap, newest_first=False,
        workspace_id=workspace_id, lens=lens,
    )
    return {
        "day": day,
        "scope": {"workspaceId": workspace_id, "lens": lens},
        "events": events,
        "sessions": sessions_of(events),
        "truncated": more is not None,
        "kinds": dict(Counter(e["kind"] for e in events)),
    }


def sessions_of(events: Sequence[dict], *, gap_minutes: int = SESSION_GAP_MINUTES) -> list[dict]:
    """Split a day's events wherever nothing happened for ``gap_minutes``.

    Derived, not tracked: the platform records no "session started", and the gap rule is the
    conventional web-analytics definition. Section moves count toward a session's span — being
    around is being around — but not toward its action count.
    """
    out: list[dict] = []
    gap = timedelta(minutes=gap_minutes)
    current: Optional[dict] = None
    last_at: Optional[datetime] = None
    for e in events:
        try:
            at = datetime.fromisoformat(e["at"])
        except (TypeError, ValueError):
            continue
        if current is None or last_at is None or at - last_at > gap:
            current = {"start": e["at"], "end": e["at"], "actions": 0, "kinds": Counter()}
            out.append(current)
        current["end"] = e["at"]
        if e["kind"] not in ("section", "signin"):
            current["actions"] += 1
        current["kinds"][e["kind"]] += 1
        last_at = at
    for s in out:
        s["kinds"] = dict(s["kinds"])
    return out


# ── Redaction ─────────────────────────────────────────────────────────
#
# Each redactor builds what leaves from an explicit allow-list of fields, never a spread of
# the cached row, so a field added to a builder above is withheld until someone names it here.
# ``viewer`` is an ``analytics_scope.ViewerScope``.

_ROSTER_FIELDS = (
    "userId", "name", "deleted", "actions", "previous", "changePct", "activeDays", "signIns",
    "signInDays", "idleSignInDays", "lastActiveAt", "lastSignInAt", "joinedInWindow",
)
#: What page enrichment adds to a roster row. Email is added only for privileged readers.
PAGE_FIELDS = ("line", "topKind", "joinedAt", "firstActiveAt", "lastActiveEverAt")
_QUIET_FIELDS = ("userId", "name", "joinedAt", "lastLoginAt", "lastActiveAt")


def _with_email(row: dict, src: dict, viewer) -> dict:
    if viewer.privileged:
        row["email"] = src.get("email")
    return row


def redact_people(doc: dict, viewer) -> dict:
    out = {k: doc[k] for k in ("generatedAt", "window", "scope", "coverage", "totals",
                               "series", "kinds", "types", "punchcard", "sections", "insights")}
    out["people"] = [{k: p.get(k) for k in _ROSTER_FIELDS} for p in doc["people"]]
    out["quiet"] = {
        "count": doc["quiet"]["count"],
        "people": [
            _with_email({k: q.get(k) for k in _QUIET_FIELDS}, q, viewer)
            for q in doc["quiet"]["people"]
        ],
    }
    return out


def _view_out(meta: dict, viewer) -> dict:
    visible = viewer.can_see_view(
        workspace_id=meta.get("workspaceId"), visibility=meta.get("visibility"),
        created_by=meta.get("createdBy"),
    )
    return {
        "id": meta.get("id") or meta.get("viewId"),
        "name": meta.get("name") if visible else None,
        "locked": not visible,
        "deleted": bool(meta.get("deleted")),
        "workspaceId": meta.get("workspaceId") if visible else None,
        "canOpen": visible and not meta.get("deleted"),
    }


def _workspace_out(ws_id: Optional[str], name: Optional[str], viewer) -> dict:
    visible = viewer.can_see(ws_id)
    return {
        "workspaceId": ws_id if visible else None,
        "name": name if visible else None,
        "locked": not visible,
        "canOpen": viewer.can_open(ws_id),
    }


def redact_person(doc: dict, viewer, *, is_self: bool) -> dict:
    out = {k: doc[k] for k in ("generatedAt", "window", "scope", "coverage", "totals",
                               "series", "kinds", "types", "punchcard", "sections",
                               "typicalDay", "signIns")}
    prof = doc["profile"]
    out["profile"] = {k: prof.get(k) for k in (
        "userId", "name", "status", "createdAt", "deleted", "lastLoginAt", "lastSeenAt",
        "lastActiveAt", "firstActiveAt")}
    if doc["scope"]["lens"] != FULL:
        # Signing in, and being seen or active anywhere on the platform, are not any one
        # workspace's to report. Their activity HERE is in ``totals.lastActiveAt``.
        for key in ("lastLoginAt", "lastSeenAt", "lastActiveAt"):
            out["profile"][key] = None
    if viewer.privileged or is_self:
        out["profile"]["email"] = prof.get("email")
    out["workspaces"] = [
        {**_workspace_out(w["workspaceId"], w["name"], viewer),
         **{k: w.get(k) for k in ("actions", "joinedAt", "firstActiveAt", "lastActiveAt",
                                  "member")}}
        for w in doc["workspaces"]
    ]
    out["views"] = [
        {**_view_out({**v, "id": v["viewId"]}, viewer), "opens": v["opens"]}
        for v in doc["views"]
    ]
    return out


def redact_events(events: Sequence[dict], viewer) -> list[dict]:
    out = []
    for e in events:
        row = {k: e.get(k) for k in ("id", "at", "type", "kind", "label", "section",
                                     "outcome", "target")}
        ws = _workspace_out(e.get("workspaceId"), e.get("workspaceName"), viewer)
        row["workspace"] = ws if e.get("workspaceId") else None
        if e.get("view"):
            row["view"] = _view_out(e["view"], viewer)
            # An edit's summary names the view; it goes where the name goes.
            row["summary"] = e.get("summary") if not row["view"]["locked"] else None
        else:
            row["view"] = None
            row["summary"] = e.get("summary")
        out.append(row)
    return out


def redact_day(doc: dict, viewer) -> dict:
    return {**{k: doc[k] for k in ("day", "scope", "sessions", "truncated", "kinds")},
            "events": redact_events(doc["events"], viewer)}
