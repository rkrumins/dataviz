"""People analytics API — who did what, when, per person and per workspace.

Mounted at ``/api/v1/admin/analytics/people``:

* ``GET /`` — everyone's activity in a scope (the platform, or one workspace): aggregates,
  insights and one page of the roster, each person on it with their activity line.
* ``GET /lines`` — the activity lines of up to 24 people, to compare them.
* ``GET /days/{day}`` — everyone active on one day in the scope.
* ``GET /{user_id}`` — one person over the window. ``me`` is the caller.
* ``GET /{user_id}/calendar`` — their last year, a day at a time.
* ``GET /{user_id}/days/{day}`` — every event of one UTC day, split into sessions.
* ``GET /{user_id}/events`` — everything they did, newest first, a page at a time.

Who may ask, and what they are told, is ``services/people_scope``: analytics administrators
see everyone; a workspace admin sees their workspace's people through the ``workspace`` lens,
with no sign-ins; everyone sees themselves.

Documents are computed once per (scope, lens, window) and redacted per reader on the way out,
through the same ``_serve`` the rest of Analytics uses — so a few hundred readers cost one
aggregation, not a few hundred. Reads take the READONLY pool: these are dashboards left open.

Looking at somebody else is recorded in the activity ledger (``platform.people_activity.
viewed``), at most once per reader, person and scope every half hour.
"""
from __future__ import annotations

import logging
import time
from datetime import date
from types import SimpleNamespace
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.analytics import (
    _DAYS,
    _FROM,
    _TO,
    _at_epoch,
    _serve,
    _window_args,
)
from backend.app.common.activity_context import provenance_for
from backend.app.db.engine import get_db_session, get_readonly_db_session
from backend.app.db.repositories import analytics_repo, user_repo
from backend.app.db.repositories import people_activity_repo as repo
from backend.app.services import analytics_cache
from backend.app.services.activity import recorder
from backend.app.services.people_scope import (
    PeopleAccess,
    PeopleReader,
    person_access,
    resolve_people_reader,
    roster_access,
)

logger = logging.getLogger(__name__)

router = APIRouter()

_WORKSPACE = Query(None, description="Restrict to one workspace.")

SortKey = Literal["actions", "activeDays", "lastActiveAt", "name", "change", "signIns"]

#: How long one reader looking at one person counts as one look.
_AUDIT_WINDOW_SECONDS = 30 * 60
_AUDIT_MAX_KEYS = 10_000
_audited: dict[tuple[str, str, str], float] = {}


def _scope_key(access: PeopleAccess) -> str:
    return f"{access.workspace_id or 'all'}:{access.lens}"


def roster_key(args: dict[str, Any], access: PeopleAccess, epoch) -> str:
    """Shared with the warmer, which must write the exact key a reader looks up."""
    return analytics_cache.document_key(f"people:{_scope_key(access)}", args, epoch=epoch)


async def _workspace_exists(session: AsyncSession, workspace_id: Optional[str]) -> None:
    if workspace_id and not await user_repo.get_workspace_names_by_ids(session, [workspace_id]):
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")


async def _roster(
    session: AsyncSession, args: dict[str, Any], access: PeopleAccess,
) -> tuple[Any, dict[str, Any]]:
    epoch, build_args = _at_epoch(args)
    key = roster_key(args, access, epoch)

    def build():
        return repo.people_doc(
            session, workspace_id=access.workspace_id, lens=access.lens, **build_args)
    return key, build


def _sort(people: list[dict], sort: str, order: str) -> list[dict]:
    reverse = order == "desc"
    if sort == "name":
        return sorted(people, key=lambda p: (p.get("name") or "").lower(), reverse=reverse)

    def numeric(p: dict) -> tuple:
        value = {
            "actions": p.get("actions"),
            "activeDays": p.get("activeDays"),
            "signIns": p.get("signIns"),
            "change": p.get("changePct"),
            "lastActiveAt": p.get("lastActiveAt"),
        }[sort]
        # Missing values sort last whichever way the column is ordered.
        missing = value is None
        return (missing if reverse else not missing, value if value is not None else 0)

    ranked = sorted(people, key=lambda p: (p.get("name") or "").lower())
    ranked.sort(key=numeric, reverse=reverse)
    if reverse:
        # ``reverse`` also flipped "missing last"; put the gaps back at the end.
        ranked = [p for p in ranked if numeric(p)[1] is not None and _has(p, sort)] + [
            p for p in ranked if not _has(p, sort)]
    return ranked


def _has(p: dict, sort: str) -> bool:
    field = {"change": "changePct"}.get(sort, sort)
    return p.get(field) is not None


@router.get("")
async def people_roster(
    days: int = _DAYS,
    date_from: Optional[str] = _FROM,
    date_to: Optional[str] = _TO,
    workspace: Optional[str] = _WORKSPACE,
    q: Optional[str] = Query(None, max_length=100, description="Filter people by name."),
    sort: SortKey = Query("actions"),
    order: Literal["asc", "desc"] = Query("desc"),
    offset: int = Query(0, ge=0),
    limit: int = Query(25, ge=1, le=100),
    reader: PeopleReader = Depends(resolve_people_reader),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> dict[str, Any]:
    """Everyone's activity in a scope, and one page of the people in it."""
    access = roster_access(reader, workspace)
    await _workspace_exists(session, workspace)
    args = _window_args(days, date_from, date_to)
    try:
        key, build = await _roster(session, args, access)
        doc = await _serve(key, build, repo.redact_people, reader.viewer)
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    people = doc["people"]
    if q:
        needle = q.strip().lower()
        people = [p for p in people if needle in (p.get("name") or "").lower()]
    ranked = _sort(people, sort, order)
    # The cached summary carries no series, dates or addresses — at ten thousand people they
    # would be most of it. The page's own people get theirs here, a page at a time.
    _epoch, build_args = _at_epoch(args)
    doc["people"] = await repo.enrich_page(
        session, ranked[offset:offset + limit], workspace_id=access.workspace_id,
        lens=access.lens, emails=reader.privileged, **build_args)
    doc["page"] = {"offset": offset, "limit": limit, "total": len(ranked)}
    return doc


#: A compare chart's people, or a grid's — never everyone.
_LINES_MAX = 24


@router.get("/lines")
async def people_lines(
    ids: str = Query(..., description=f"Comma-separated user ids, at most {_LINES_MAX}."),
    days: int = _DAYS,
    date_from: Optional[str] = _FROM,
    date_to: Optional[str] = _TO,
    workspace: Optional[str] = _WORKSPACE,
    reader: PeopleReader = Depends(resolve_people_reader),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> dict[str, Any]:
    """The activity lines of a few people, on one axis, to compare them.

    The same access as the roster. A workspace admin is answered only about people in their
    workspace — its members, or anyone who did something there in the window — so this cannot
    be used to learn who else has an account."""
    access = roster_access(reader, workspace)
    wanted = [i for i in dict.fromkeys(x.strip() for x in ids.split(",")) if i]
    if not wanted or len(wanted) > _LINES_MAX:
        raise HTTPException(status_code=422, detail=f"Ask for 1 to {_LINES_MAX} people.")
    await _workspace_exists(session, workspace)
    args = _window_args(days, date_from, date_to)
    epoch, build_args = _at_epoch(args)
    try:
        drawn = await repo.lines(session, wanted, workspace_id=access.workspace_id,
                                 lens=access.lens, **build_args)
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if access.lens == repo.WORKSPACE:
        members = (await analytics_repo.members_by_workspace(
            session, now=epoch, workspace_id=access.workspace_id)).get(access.workspace_id, set())
        drawn["lines"] = {uid: line for uid, line in drawn["lines"].items()
                          if uid in members or any(line)}
    names = await repo._users(session, list(drawn["lines"]))
    drawn["names"] = {uid: names.get(uid, {}).get("name") or uid for uid in drawn["lines"]}
    drawn["scope"] = {"workspaceId": access.workspace_id, "lens": access.lens}
    return drawn


@router.get("/days/{day}")
async def people_on_day(
    day: str = Path(..., description="A UTC day, YYYY-MM-DD."),
    workspace: Optional[str] = _WORKSPACE,
    limit: int = Query(200, ge=1, le=500),
    reader: PeopleReader = Depends(resolve_people_reader),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> dict[str, Any]:
    """Everyone who did something on one day in the scope, most active first — exactly, from
    that day's rollup rows."""
    access = roster_access(reader, workspace)
    try:
        date.fromisoformat(day)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Days are ISO 'YYYY-MM-DD'.") from exc
    await _workspace_exists(session, workspace)
    return await repo.scope_day(session, day, workspace_id=access.workspace_id,
                                lens=access.lens, limit=limit)


async def _reach(
    session: AsyncSession, access: PeopleAccess, *, now, has_activity: bool,
) -> None:
    """A workspace admin may read a person who is a member of the workspace, or who did
    something in it. Anyone else is a 404 — the same answer an id that does not exist gets, so
    the endpoint cannot be walked to learn who has an account."""
    if not access.needs_reach_check or has_activity:
        return
    members = await analytics_repo.members_by_workspace(
        session, now=now, workspace_id=access.workspace_id)
    if access.target not in members.get(access.workspace_id, set()):
        raise HTTPException(status_code=404, detail="Person not found in this workspace")


def _standing(roster: Optional[dict], target: str) -> Optional[dict]:
    """Where this person sits among everyone active in the same scope and window.

    Guarded on five active people: a percentile out of three is an identification, not a
    statistic."""
    if not roster:
        return None
    active = [p for p in roster.get("people", []) if p.get("actions")]
    me = next((p for p in active if p["userId"] == target), None)
    if me is None or len(active) < 5:
        return None
    fewer = sum(1 for p in active if p["actions"] < me["actions"])
    more = sum(1 for p in active if p["actions"] > me["actions"])
    return {"rank": more + 1, "of": len(active),
            "percentile": round(100 * fewer / len(active))}


async def _audit(
    write: AsyncSession, reader: PeopleReader, access: PeopleAccess, name: Optional[str],
) -> None:
    """Record that ``reader`` looked at ``access.target`` — best-effort, and once per half hour
    per reader, person and scope, so paging through a range is one look and not twelve."""
    if access.is_self or not reader.user_id or not access.target:
        return
    key = (reader.user_id, access.target, access.workspace_id or "")
    now = time.monotonic()
    if now - _audited.get(key, -_AUDIT_WINDOW_SECONDS - 1) < _AUDIT_WINDOW_SECONDS:
        return
    if len(_audited) >= _AUDIT_MAX_KEYS:
        cutoff = now - _AUDIT_WINDOW_SECONDS
        for k in [k for k, at in _audited.items() if at < cutoff]:
            del _audited[k]
    try:
        await recorder.record_activity(
            write, event_type="platform.people_activity.viewed",
            provenance=provenance_for(SimpleNamespace(id=reader.user_id)),
            workspace_id=access.workspace_id,
            target_type="user", target_id=access.target, target_label=name,
            details={"lens": access.lens}, best_effort=True,
        )
        await write.commit()
        _audited[key] = now
    except Exception:  # noqa: BLE001 — a failed record must not take the page down
        logger.warning("people analytics: could not record a view of %s", access.target,
                       exc_info=True)


@router.get("/{user_id}")
async def person_activity(
    user_id: str = Path(..., description="The person, or 'me'."),
    days: int = _DAYS,
    date_from: Optional[str] = _FROM,
    date_to: Optional[str] = _TO,
    workspace: Optional[str] = _WORKSPACE,
    reader: PeopleReader = Depends(resolve_people_reader),
    session: AsyncSession = Depends(get_readonly_db_session),
    write: AsyncSession = Depends(get_db_session),
) -> dict[str, Any]:
    """One person over one window."""
    access = person_access(reader, user_id, workspace)
    await _workspace_exists(session, workspace)
    args = _window_args(days, date_from, date_to)
    epoch, build_args = _at_epoch(args)
    key = analytics_cache.document_key(
        f"person:{access.target}:{_scope_key(access)}", args, epoch=epoch)
    try:
        doc = await _serve(
            key,
            lambda: repo.person_doc(
                session, access.target, workspace_id=access.workspace_id, lens=access.lens,
                **build_args),
            lambda d, viewer: repo.redact_person(d, viewer, is_self=access.is_self),
            reader.viewer,
        )
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if doc is None:
        raise HTTPException(status_code=404, detail="Person not found")
    await _reach(session, access, now=epoch,
                 has_activity=bool(doc["totals"]["actions"]["current"]))

    # Their standing among everyone in the same scope: read from the roster the People tab
    # caches anyway, never computed for one person.
    roster_scope = PeopleAccess(lens=access.lens, workspace_id=access.workspace_id)
    try:
        rkey, rbuild = await _roster(session, args, roster_scope)
        doc["standing"] = _standing(await analytics_cache.cached(rkey, rbuild), access.target)
    except Exception:  # noqa: BLE001 — a missing percentile is not a broken page
        logger.warning("people analytics: no standing for %s", access.target, exc_info=True)
        doc["standing"] = None

    await _audit(write, reader, access, doc["profile"].get("name"))
    doc["viewer"] = {"isSelf": access.is_self, "privileged": reader.privileged}
    return doc


@router.get("/{user_id}/calendar")
async def person_calendar(
    user_id: str = Path(..., description="The person, or 'me'."),
    workspace: Optional[str] = _WORKSPACE,
    reader: PeopleReader = Depends(resolve_people_reader),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> dict[str, Any]:
    """Their last year, one day at a time, whatever range the page is showing."""
    access = person_access(reader, user_id, workspace)
    await _workspace_exists(session, workspace)
    epoch = analytics_cache.epoch_start()
    key = analytics_cache.document_key(
        f"personcal:{access.target}:{_scope_key(access)}",
        {"days": repo.CALENDAR_DAYS}, epoch=epoch)
    if await repo.profile(session, access.target) is None:
        raise HTTPException(status_code=404, detail="Person not found")
    doc = await _serve(
        key,
        lambda: repo.person_calendar(
            session, access.target, now=epoch, workspace_id=access.workspace_id,
            lens=access.lens),
        lambda d, _viewer: d,
        reader.viewer,
    )
    await _reach(session, access, now=epoch, has_activity=any(doc["actions"]))
    return doc


@router.get("/{user_id}/days/{day}")
async def person_day(
    user_id: str = Path(..., description="The person, or 'me'."),
    day: str = Path(..., description="A UTC day, YYYY-MM-DD."),
    workspace: Optional[str] = _WORKSPACE,
    reader: PeopleReader = Depends(resolve_people_reader),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> dict[str, Any]:
    """Everything they did on one day, in order, in sessions. Not cached: one person, one
    day, read by index."""
    access = person_access(reader, user_id, workspace)
    try:
        date.fromisoformat(day)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Days are ISO 'YYYY-MM-DD'.") from exc
    await _workspace_exists(session, workspace)
    if await repo.profile(session, access.target) is None:
        raise HTTPException(status_code=404, detail="Person not found")
    doc = await repo.person_day(session, access.target, day,
                                workspace_id=access.workspace_id, lens=access.lens)
    await _reach(session, access, now=analytics_cache.epoch_start(),
                 has_activity=bool(doc["events"]))
    return repo.redact_day(doc, reader.viewer)


_FEED_KINDS = Query(None, description="Comma-separated kinds to keep: " + ", ".join(repo.FEED_KINDS))
_CURSOR = Query(None, description="The 'next' value of the previous page.")


def _cursor(raw: Optional[str]) -> Optional[tuple[str, str]]:
    if not raw:
        return None
    at, sep, eid = raw.rpartition("|")
    if not sep or not at or not eid:
        raise HTTPException(status_code=422, detail="Malformed cursor.")
    return at, eid


@router.get("/{user_id}/events")
async def person_events(
    user_id: str = Path(..., description="The person, or 'me'."),
    workspace: Optional[str] = _WORKSPACE,
    kinds: Optional[str] = _FEED_KINDS,
    before: Optional[str] = _CURSOR,
    limit: int = Query(50, ge=1, le=200),
    reader: PeopleReader = Depends(resolve_people_reader),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> dict[str, Any]:
    """Everything they did, newest first, across all three stores, a page at a time.

    Reaches as far back as the raw events are kept (``PRODUCT_EVENT_RETENTION_DAYS``,
    ``ACTIVITY_RETENTION_DAYS``); the person page's index carries joins and first activity
    past that."""
    access = person_access(reader, user_id, workspace)
    wanted = None
    if kinds:
        wanted = {k.strip() for k in kinds.split(",") if k.strip()}
        unknown = wanted - set(repo.FEED_KINDS)
        if unknown:
            raise HTTPException(status_code=422, detail=f"Unknown kinds: {sorted(unknown)}")
        if access.lens == repo.WORKSPACE:
            wanted.discard("signin")
    await _workspace_exists(session, workspace)
    if await repo.profile(session, access.target) is None:
        raise HTTPException(status_code=404, detail="Person not found")
    events, nxt = await repo.person_events(
        session, access.target, before=_cursor(before), limit=limit,
        workspace_id=access.workspace_id, lens=access.lens, kinds=wanted,
    )
    await _reach(session, access, now=analytics_cache.epoch_start(),
                 has_activity=bool(events) or before is not None)
    return {
        "scope": {"workspaceId": access.workspace_id, "lens": access.lens},
        "events": repo.redact_events(events, reader.viewer),
        "next": f"{nxt[0]}|{nxt[1]}" if nxt else None,
    }
