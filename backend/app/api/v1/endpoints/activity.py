"""Activity API — who did what, where, when and why, across the platform.

One set of handlers, mounted twice:

* ``/api/v1/admin/activity`` — the whole ledger, for ``system:audit:read``.
* ``/api/v1/admin/workspaces/{ws_id}/activity`` — one workspace's
  workspace-audience events, for that workspace's admins. The scope is forced
  on the server (``audience = 'workspace' AND workspace_id = :ws``), so no
  query parameter can widen it, and the raw payload is never returned there.

Each has ``events`` (keyset pages, newest first), ``events/newer`` (the live
"N new" count), ``events/{id}`` (one event and what else happened with it),
``summary`` (the insight band, cached for a minute), ``catalogue`` (what can be
filtered on) and ``export.csv`` (streamed, capped, and itself recorded).

Every filter is a SQL predicate on an indexed ledger column
(``activity_repo``); people, workspaces and sources are named afterwards, one
batched lookup per kind per page (``services/activity/names``). Reads take the
READONLY pool: an activity page is left open and polled, and must not sit in
the pool that serves the rest of the product.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.common.activity_context import provenance_for
from backend.app.db.engine import get_db_session, get_readonly_db_session
from backend.app.db.repositories import activity_repo, analytics_repo, user_repo
from backend.app.db.repositories.activity_repo import ActivityFilter
from backend.app.services import analytics_cache
from backend.app.services.activity import catalogue, names, recorder
from backend.auth_service.interface import User
from backend.common.models.activity import (
    ActivityCatalogue,
    ActivityCatalogueEntry,
    ActivityEvent,
    ActivityEventDetail,
    ActivityNewer,
    ActivityPage,
    ActivityPerson,
    ActivityTarget,
)

logger = logging.getLogger(__name__)

router = APIRouter()
workspace_router = APIRouter()

#: Free-text search reads payloads, so it is held to a window this long.
_SEARCH_MAX_DAYS = 92
#: Rows an export may carry. Past this, narrow the filters.
_EXPORT_CAP = 50_000
_EXPORT_CHUNK = 1_000
#: How long a summary is reused. Activity is read for what just happened, so
#: this is far shorter than the analytics documents' epoch.
_SUMMARY_TTL_SECONDS = 60.0
#: How long a fold of closed days is kept: the span is day-aligned, so it is
#: asked for until the next UTC midnight moves every window on.
_FOLD_TTL_SECONDS = 26 * 3600.0
_MAX_EVENT_TYPES = 25


# ── Scope ────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Scope:
    """Whose activity this request may read, and who is reading."""

    user: User
    #: ``None`` is the whole ledger.
    workspace_id: Optional[str] = None

    @property
    def full(self) -> bool:
        return self.workspace_id is None

    def bound(self, f: ActivityFilter) -> ActivityFilter:
        if self.full:
            return f
        return replace(
            f, audience=catalogue.AUDIENCE_WORKSPACE, workspace_id=self.workspace_id,
        )


async def _platform_scope(
    user: User = Depends(requires("system:audit:read")),
) -> _Scope:
    return _Scope(user=user)


async def _workspace_scope(
    ws_id: str = Path(..., max_length=128),
    user: User = Depends(requires("workspace:admin", workspace="ws_id")),
) -> _Scope:
    return _Scope(user=user, workspace_id=ws_id)


# ── Filters ──────────────────────────────────────────────────────────

@dataclass(frozen=True)
class _Params:
    days: Optional[int]
    date_from: Optional[str]
    date_to: Optional[str]
    categories: tuple[str, ...]
    event_types: tuple[str, ...]
    person: Optional[str]
    person_role: str
    workspace_id: Optional[str]
    data_source_id: Optional[str]
    target_type: Optional[str]
    target_id: Optional[str]
    outcome: Optional[str]
    has_reason: Optional[bool]
    include_noise: bool
    q: Optional[str]

    def key(self) -> str:
        """A stable digest of every filter, for cache keys."""
        return hashlib.sha1(
            json.dumps(self.__dict__, sort_keys=True, default=str).encode()
        ).hexdigest()[:20]


def _csv(raw: Optional[str]) -> tuple[str, ...]:
    return tuple(dict.fromkeys(v.strip() for v in (raw or "").split(",") if v.strip()))


def _params(
    days: Optional[int] = Query(None, ge=1, le=365, description="Trailing window, in days."),
    date_from: Optional[str] = Query(None, alias="from", description="Range start (YYYY-MM-DD)."),
    date_to: Optional[str] = Query(None, alias="to", description="Range end, inclusive (YYYY-MM-DD)."),
    category: Optional[str] = Query(None, max_length=200, description="Comma-separated categories."),
    event_type: Optional[str] = Query(
        None, alias="eventType", max_length=2000,
        description="Comma-separated event types; `family.*` for a prefix.",
    ),
    person: Optional[str] = Query(
        None, max_length=200, description="A user id, or text matched to names and emails.",
    ),
    person_role: Literal["any", "actor", "subject"] = Query("any", alias="personRole"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId", max_length=128),
    data_source_id: Optional[str] = Query(None, alias="dataSourceId", max_length=128),
    target_type: Optional[str] = Query(None, alias="targetType", max_length=64),
    target_id: Optional[str] = Query(None, alias="targetId", max_length=256),
    outcome: Optional[Literal["success", "failure", "denied"]] = Query(None),
    has_reason: Optional[bool] = Query(None, alias="hasReason"),
    include_noise: bool = Query(False, alias="includeNoise"),
    q: Optional[str] = Query(None, max_length=200, description="Free-text search."),
) -> _Params:
    categories = _csv(category)
    unknown = [c for c in categories if c not in catalogue.CATEGORIES]
    if unknown:
        raise HTTPException(422, f"Unknown categories: {', '.join(unknown)}.")
    event_types = _csv(event_type)
    if len(event_types) > _MAX_EVENT_TYPES:
        raise HTTPException(422, f"At most {_MAX_EVENT_TYPES} event types at once.")
    return _Params(
        days=days, date_from=date_from, date_to=date_to,
        categories=categories, event_types=event_types,
        person=(person or "").strip() or None, person_role=person_role,
        workspace_id=workspace_id, data_source_id=data_source_id,
        target_type=target_type, target_id=target_id, outcome=outcome,
        has_reason=has_reason, include_noise=include_noise,
        q=(q or "").strip() or None,
    )


def _window(p: _Params, *, default_days: Optional[int]) -> Optional[analytics_repo.Window]:
    if not (p.days or p.date_from or p.date_to or default_days):
        return None
    try:
        if p.date_from or p.date_to:
            return analytics_repo.build_window(start=p.date_from, end=p.date_to)
        return analytics_repo.build_window(p.days or default_days)
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(422, str(exc)) from exc


async def _people(session: AsyncSession, term: str) -> frozenset[str]:
    """What a person filter means as ids. An exact id needs no lookup; text
    is matched to names and emails, and matching nobody filters to nothing —
    never to everybody."""
    try:
        matches = await user_repo.find_user_ids_matching(session, term)
    except Exception:  # noqa: BLE001
        logger.warning("activity: could not resolve the person filter %r", term, exc_info=True)
        matches = set()
    return frozenset(matches | ({term} if term.startswith("usr_") else set()))


async def _filter(
    session: AsyncSession, p: _Params, scope: _Scope, *, default_days: Optional[int] = None,
) -> tuple[ActivityFilter, Optional[analytics_repo.Window]]:
    window = _window(p, default_days=default_days)
    if p.q:
        if window is None:
            window = analytics_repo.build_window(30)
        elif window.days > _SEARCH_MAX_DAYS:
            raise HTTPException(
                422, f"Searching text needs a window of {_SEARCH_MAX_DAYS} days or less.",
            )
    ids = await _people(session, p.person) if p.person else None
    f = ActivityFilter(
        since=window.start if window else None,
        until=window.end if window else None,
        categories=p.categories,
        event_types=p.event_types,
        actor_ids=ids if p.person_role == "actor" else None,
        subject_ids=ids if p.person_role == "subject" else None,
        person_ids=ids if p.person_role == "any" else None,
        workspace_id=p.workspace_id,
        data_source_id=p.data_source_id,
        target_type=p.target_type,
        target_id=p.target_id,
        outcome=p.outcome,
        has_reason=p.has_reason,
        include_noise=p.include_noise,
        text=p.q,
    )
    return scope.bound(f), window


# ── Rows → events ────────────────────────────────────────────────────

def _payload(row: Any) -> dict[str, Any]:
    try:
        value = json.loads(row.payload) if row.payload else {}
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _person(person_id: Optional[str], page: names.PageNames) -> Optional[ActivityPerson]:
    if not person_id:
        return None
    who = page.people.get(person_id)
    if not who:
        return ActivityPerson(id=person_id)
    return ActivityPerson(
        id=person_id, name=who.get("name") or None, email=who.get("email"),
        deleted=bool(who.get("deleted")),
    )


async def _events(
    session: AsyncSession, rows: list[Any], *, full: bool,
) -> list[ActivityEvent]:
    """Rows as events, every id named in one batched pass for the page."""
    staged = []
    people: set[str] = set()
    workspaces: set[str] = set()
    references: set[str] = set()
    for row in rows:
        payload = _payload(row)
        severity, summary = catalogue.summarize(row.event_type, payload)
        refs = set(names.REF_ID.findall(summary))
        if full:
            refs |= set(names.REF_ID.findall(row.payload or ""))
        people |= {i for i in (row.actor_id, row.subject_id) if i}
        if row.workspace_id:
            workspaces.add(row.workspace_id)
        if row.data_source_id:
            references.add(row.data_source_id)
        if row.target_id and not row.target_label:
            references.add(row.target_id)
        references |= refs
        staged.append((row, payload, severity, summary, refs))

    page = await names.name_page(
        session, people=people, workspaces=workspaces, references=references,
    )

    out = []
    for row, payload, severity, summary, refs in staged:
        details = payload.get("details") if (row.event_version or 1) >= recorder.ENVELOPE_VERSION else None
        out.append(ActivityEvent(
            id=row.id,
            event_type=row.event_type,
            label=catalogue.label_of(row.event_type),
            category=row.category or catalogue.category_of(row.event_type),
            severity=row.severity or severity,
            outcome=row.outcome or "success",
            summary=names.REF_ID.sub(lambda m: page.names.get(m.group(0), m.group(0)), summary),
            occurred_at=row.occurred_at,
            recorded_at=row.recorded_at,
            actor_kind=row.actor_kind or "system",
            actor=_person(row.actor_id, page),
            subject=_person(row.subject_id, page),
            target=ActivityTarget(
                type=row.target_type, id=row.target_id,
                label=row.target_label or page.names.get(row.target_id or ""),
            ) if (row.target_type or row.target_id) else None,
            workspace_id=row.workspace_id,
            workspace_name=page.workspaces.get(row.workspace_id or ""),
            data_source_id=row.data_source_id,
            data_source_name=page.names.get(row.data_source_id or ""),
            stated_reason=row.stated_reason,
            correlation_id=row.correlation_id,
            details=details if isinstance(details, dict) else {},
            resolved_names={r: page.names[r] for r in refs if r in page.names},
            payload=payload if full else None,
        ))
    return out


async def _name_summary(session: AsyncSession, doc: dict[str, Any]) -> dict[str, Any]:
    """Name the leaderboards: one batched lookup per kind, like a page."""
    page = await names.name_page(
        session,
        people={r["id"] for r in doc["topPeople"]},
        workspaces={r["workspaceId"] for r in doc["handsOnSources"] if r.get("workspaceId")},
        references={r["dataSourceId"] for r in doc["handsOnSources"]}
        | {r["id"] for r in doc["topTargets"] if r.get("id") and not r.get("label")},
    )
    for row in doc["topPeople"]:
        who = page.people.get(row["id"]) or {}
        row.update(name=who.get("name") or None, email=who.get("email"),
                   deleted=bool(who.get("deleted")))
    for row in doc["topTargets"]:
        row["label"] = row.get("label") or page.names.get(row.get("id") or "")
    for row in doc["handsOnSources"]:
        row["name"] = page.names.get(row["dataSourceId"])
        row["workspaceName"] = page.workspaces.get(row.get("workspaceId") or "")
    for row in doc["topActions"]:
        row.update(label=catalogue.label_of(row["type"]), category=catalogue.category_of(row["type"]))
    return doc


# ── CSV ──────────────────────────────────────────────────────────────

_CSV_COLUMNS = (
    "occurredAt", "eventType", "label", "category", "outcome", "severity",
    "actorKind", "actorId", "actorName", "actorEmail", "subjectId", "subjectName",
    "targetType", "targetId", "targetLabel", "workspaceId", "workspaceName",
    "dataSourceId", "dataSourceName", "statedReason", "correlationId", "summary",
)


def _cell(value: Any) -> str:
    """A CSV cell a spreadsheet will not execute.

    A cell opening with ``=``, ``+``, ``-``, ``@`` (or a tab or carriage
    return) is a formula to Excel and Sheets — and a group name, a target
    label and a stated reason are all text someone typed.
    """
    text = "" if value is None else str(value)
    return f"'{text}" if text[:1] in ("=", "+", "-", "@", "\t", "\r") else text


def _csv_row(e: ActivityEvent) -> list[str]:
    actor, subject, target = e.actor, e.subject, e.target
    return [_cell(v) for v in (
        e.occurred_at, e.event_type, e.label, e.category, e.outcome, e.severity,
        e.actor_kind, actor and actor.id, actor and actor.name, actor and actor.email,
        subject and subject.id, subject and subject.name,
        target and target.type, target and target.id, target and target.label,
        e.workspace_id, e.workspace_name, e.data_source_id, e.data_source_name,
        e.stated_reason, e.correlation_id, e.summary,
    )]


# ── Routes ───────────────────────────────────────────────────────────

def _mount(r: APIRouter, scope_dependency) -> None:
    """Register every activity route on ``r``, scoped by ``scope_dependency``."""

    @r.get("/events", response_model=ActivityPage, response_model_by_alias=True)
    async def list_activity(
        scope: _Scope = Depends(scope_dependency),
        p: _Params = Depends(_params),
        cursor: Optional[str] = Query(None, max_length=200),
        limit: int = Query(50, ge=1, le=200),
        session: AsyncSession = Depends(get_readonly_db_session),
    ) -> ActivityPage:
        """A page of events, newest first. Pass ``nextCursor`` back for more."""
        f, _ = await _filter(session, p, scope)
        try:
            rows, next_cursor = await activity_repo.list_events(
                session, f, cursor=cursor, limit=limit,
            )
        except activity_repo.InvalidCursor:
            raise HTTPException(400, "Malformed cursor")
        except activity_repo.SearchTooBroad:
            raise HTTPException(422, detail={
                "code": "search_too_broad",
                "message": "Searching that window took too long. Narrow the dates "
                           "or add a filter, then search again.",
            })
        return ActivityPage(
            events=await _events(session, rows, full=scope.full),
            next_cursor=next_cursor,
            ledger=await activity_repo.ledger_health(session) if cursor is None else None,
        )

    @r.get("/events/newer", response_model=ActivityNewer, response_model_by_alias=True)
    async def count_newer_activity(
        since: str = Query(..., max_length=64, description="The page's ``ledger.watermark``."),
        scope: _Scope = Depends(scope_dependency),
        p: _Params = Depends(_params),
        session: AsyncSession = Depends(get_readonly_db_session),
    ) -> ActivityNewer:
        """How many matching events arrived since the page was loaded."""
        f, _ = await _filter(session, p, scope)
        try:
            n = await activity_repo.count_newer(
                session, replace(f, since=None, until=None), watermark=since, cap=100,
            )
        except activity_repo.InvalidCursor:
            raise HTTPException(400, "Malformed watermark")
        return ActivityNewer(count=min(n, 100), capped=n > 100)

    @r.get(
        "/events/{event_id}", response_model=ActivityEventDetail,
        response_model_by_alias=True,
    )
    async def get_activity_event(
        event_id: str = Path(..., max_length=64),
        scope: _Scope = Depends(scope_dependency),
        session: AsyncSession = Depends(get_readonly_db_session),
    ) -> ActivityEventDetail:
        """One event, the rest of the request it came from, and the latest
        other events on the same target."""
        f = scope.bound(ActivityFilter())
        row = await activity_repo.get_event(session, event_id, f)
        if row is None:
            raise HTTPException(404, "No such event")
        same_request, same_target = await activity_repo.related(session, row, f)
        events = await _events(session, [row, *same_request, *same_target], full=scope.full)
        split = 1 + len(same_request)
        return ActivityEventDetail(
            event=events[0], same_request=events[1:split], same_target=events[split:],
        )

    @r.get("/summary")
    async def activity_summary(
        scope: _Scope = Depends(scope_dependency),
        p: _Params = Depends(_params),
        session: AsyncSession = Depends(get_readonly_db_session),
    ) -> dict[str, Any]:
        """The insight band: volume, totals against the previous period, the
        weekday×hour punchcard, leaderboards, manual-operation cadence per
        source and the reasons given. Thirty days unless a range is passed.

        It describes the selection, not a text search within it: a search
        reads every payload in the window, and the band is seven reads.
        """
        p = replace(p, q=None)
        f, window = await _filter(session, p, scope, default_days=30)
        # The window's own bounds stay out of the key: a fold covers whole
        # days, and two windows over the same days share their folds.
        selection = replace(p, days=None, date_from=None, date_to=None).key()
        key = f"activity:v1:{scope.workspace_id or 'all'}:{p.key()}"

        async def _reuse(span: str, build):
            # Redis only: a fold holds every person and target in its span,
            # too large to keep a copy of in every worker.
            return await analytics_cache.cached(
                f"activity:fold:v1:p{catalogue.PROJECTION_VERSION}:"
                f"{scope.workspace_id or 'all'}:{selection}:{span}",
                build, ttl=_FOLD_TTL_SECONDS, memory=False,
            )

        async def _build() -> dict[str, Any]:
            doc = await activity_repo.summary(session, f, window, reuse=_reuse)
            doc["generatedAt"] = datetime.now(timezone.utc).isoformat()
            return await _name_summary(session, doc)

        return await analytics_cache.cached(key, _build, ttl=_SUMMARY_TTL_SECONDS)

    @r.get("/catalogue", response_model=ActivityCatalogue, response_model_by_alias=True)
    async def activity_catalogue(
        scope: _Scope = Depends(scope_dependency),
    ) -> ActivityCatalogue:
        """Every event type there is to filter on, and how each reads."""
        entries = catalogue.catalogue_entries()
        if not scope.full:
            entries = [e for e in entries if e["workspaceVisible"]]
        return ActivityCatalogue(
            categories=list(catalogue.CATEGORIES),
            event_types=[ActivityCatalogueEntry(**e) for e in entries],
        )

    @r.get("/export.csv")
    async def export_activity(
        scope: _Scope = Depends(scope_dependency),
        p: _Params = Depends(_params),
        session: AsyncSession = Depends(get_readonly_db_session),
        write: AsyncSession = Depends(get_db_session),
    ) -> StreamingResponse:
        """The filtered events as CSV, newest first, at most 50,000 rows.

        The export is itself recorded, and committed, before a byte is sent:
        who took a copy of the activity log, and of what, is activity too.
        The rows stream in keyset chunks, each named in one batched pass, on
        the request's read session — which stays open until the response
        has been sent.
        """
        f, _ = await _filter(session, p, scope)
        filters = {k: v for k, v in p.__dict__.items() if v not in (None, (), False, "any")}
        await recorder.record_activity(
            write, event_type="platform.activity.exported",
            provenance=provenance_for(scope.user),
            workspace_id=scope.workspace_id,
            target_type="workspace" if scope.workspace_id else None,
            target_id=scope.workspace_id,
            details={"format": "csv", "cap": _EXPORT_CAP, "filters": filters},
        )
        await write.commit()

        async def _rows():
            header = io.StringIO()
            csv.writer(header).writerow(_CSV_COLUMNS)
            yield header.getvalue()
            async for chunk in activity_repo.iter_events(
                session, f, chunk=_EXPORT_CHUNK, cap=_EXPORT_CAP,
            ):
                buf = io.StringIO()
                writer = csv.writer(buf)
                for event in await _events(session, chunk, full=False):
                    writer.writerow(_csv_row(event))
                yield buf.getvalue()

        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
        where = scope.workspace_id or "platform"
        return StreamingResponse(
            _rows(), media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="activity-{where}-{stamp}.csv"'},
        )


_mount(router, _platform_scope)
_mount(workspace_router, _workspace_scope)
