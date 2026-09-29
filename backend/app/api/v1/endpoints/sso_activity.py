"""The SSO activity log, one row per event with its fields as columns.

``GET /api/v1/admin/sso/activity`` — every sign-in, failed sign-in, session
ending, sign-out, identity change and SSO configuration change, with the
person, the connection, the outcome, the reason, the reference and where
it came from as fields rather than prose to read.

Every filter is a SQL predicate, so a page is full whatever is filtered
and a person's history is reachable however many other rows the window
holds:

* **outcome** — an explicit list of event types, which with
  ``idx_outbox_event_type_created`` makes each type a bounded range read;
* **connection** — the slug or provider id the record names (``password``
  for password sign-ins);
* **search** — a person's account ids, or any text in the record: an
  email, a reference, an address, an IdP subject.

Counts per outcome come from one ``GROUP BY`` over the same window and
filters, so the chips say what each choice would show.

Gate: ``system:audit:read``.
"""
from __future__ import annotations

import logging
import re
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.endpoints.audit import _EVENT_META
from backend.app.api.v1.endpoints.sso_failures import (
    PASSWORD,
    decode_payload,
    search_predicate,
    split_reason,
)
from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import IdpProviderORM, OutboxEventORM
from backend.app.db.repositories import user_repo
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)
router = APIRouter()

#: Every event on the SSO surface, by what it means to the person reading
#: the log. Explicit rather than prefixes, so each is an index range read;
#: ``test_sso_activity_log`` keeps it in step with what the code emits.
OUTCOMES: dict[str, tuple[str, ...]] = {
    "signed_in": ("user.logged_in",),
    "failed": (
        "user.login_failed", "user.sso_login_failed",
        "user.sso_jit_blocked", "user.sso_link_denied",
    ),
    "session_ended": (
        "user.session_refused", "user.sso_session_expired",
        "user.sso_session_ended_upstream", "user.session_revoked",
        "user.sessions_ended_by_admin",
    ),
    "signed_out": ("user.logged_out",),
    "account": (
        "user.sso_provisioned", "user.sso_linked",
        "user.identity.linked", "user.identity.unlinked",
        "user.identity.admin_linked", "user.identity.admin_unlinked",
    ),
    "trust": ("user.sso_unsigned_accepted", "user.sso_header_accepted"),
    "config": (
        "idp.provider.created", "idp.provider.updated",
        "idp.provider.deleted", "idp.provider.published",
        "idp.provider.sessions_ended",
        "auth.config.updated", "auth.config.sso_sessions_ended",
        "auth.config.all_sessions_ended",
        "rbac.sso_mapping.created", "rbac.sso_mapping.updated",
        "rbac.sso_mapping.deleted",
    ),
}
EVENT_TYPES: tuple[str, ...] = tuple(t for ts in OUTCOMES.values() for t in ts)
OUTCOME_OF: dict[str, str] = {t: o for o, ts in OUTCOMES.items() for t in ts}

_MAX_LIMIT = 200
_USER_ID = re.compile(r"\busr_[A-Za-z0-9]+\b")


# ── Response ─────────────────────────────────────────────────────────


class _Model(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class Person(_Model):
    user_id: Optional[str] = Field(default=None, alias="userId")
    name: Optional[str] = None
    email: Optional[str] = None
    avatar_id: Optional[str] = Field(default=None, alias="avatarId")
    deleted: bool = False


class Connection(_Model):
    slug: str
    name: Optional[str] = None


class ActivityRow(_Model):
    id: str
    at: str
    event_type: str = Field(alias="eventType")
    outcome: str
    severity: str
    summary: str
    person: Optional[Person] = None
    #: Who did it, when that is someone other than the person it concerns
    #: — an administrator changing a connection or ending sessions.
    actor: Optional[Person] = None
    connection: Optional[Connection] = None
    reason: Optional[str] = None
    detail: Optional[str] = None
    ref: Optional[str] = None
    client_ip: Optional[str] = Field(default=None, alias="clientIp")
    user_agent: Optional[str] = Field(default=None, alias="userAgent")
    payload: dict[str, Any] = Field(default_factory=dict)


class ActivityPage(_Model):
    rows: list[ActivityRow]
    next_cursor: Optional[str] = Field(default=None, alias="nextCursor")
    #: Events per outcome in the window under the connection and search
    #: filters — what each outcome chip would show.
    counts: dict[str, int]


# ── Filters ──────────────────────────────────────────────────────────


def _contains(text: str):
    return OutboxEventORM.payload.contains(text, autoescape=True)


async def _connection_predicate(session: AsyncSession, slug: str):
    if slug == PASSWORD:
        return or_(
            OutboxEventORM.event_type == "user.login_failed",
            _contains('"provider": "local"'),
        )
    clauses = [
        _contains(f'"provider_slug": "{slug}"'),
        _contains(f'"slug": "{slug}"'),
    ]
    provider_id = (await session.execute(
        select(IdpProviderORM.id).where(IdpProviderORM.slug == slug)
    )).scalar_one_or_none()
    if provider_id:
        clauses.append(_contains(f'"provider_id": "{provider_id}"'))
    return or_(*clauses)


def _cursor_predicate(cursor: str):
    try:
        at, row_id = cursor.split("|", 1)
    except ValueError:
        raise HTTPException(status_code=400, detail="Malformed cursor")
    return or_(
        OutboxEventORM.created_at < at,
        and_(OutboxEventORM.created_at == at, OutboxEventORM.id < row_id),
    )


# ── Rows ─────────────────────────────────────────────────────────────


def _reason(event_type: str, p: dict) -> tuple[Optional[str], Optional[str]]:
    if event_type == "user.sso_link_denied" and p.get("deny_reasons"):
        return ", ".join(str(r) for r in p["deny_reasons"]), None
    if not p.get("reason"):
        return None, p.get("detail")
    code, embedded = split_reason(p.get("reason"))
    return code, p.get("detail") or embedded


def _connection_slug(event_type: str, p: dict,
                     slug_by_id: dict[str, str]) -> Optional[str]:
    if event_type == "user.login_failed" or p.get("provider") == "local":
        return PASSWORD
    return (
        p.get("provider_slug") or p.get("slug")
        or slug_by_id.get(p.get("provider_id") or "")
    )


def _person(user_id: Optional[str], email: Optional[str],
            identities: dict[str, dict]) -> Optional[Person]:
    if not user_id and not email:
        return None
    known = identities.get(user_id or "") or {}
    return Person(
        user_id=user_id,
        name=known.get("name") or None,
        email=known.get("email") or email,
        avatar_id=known.get("avatar_id"),
        deleted=bool(known.get("deleted")),
    )


def _summary(event_type: str, p: dict, names: dict[str, str]) -> tuple[str, str]:
    meta = _EVENT_META.get(event_type)
    if meta is None:
        return "info", event_type
    severity, build = meta
    try:
        text = build(p)
    except Exception:  # noqa: BLE001 — a bad payload costs the prose, not the row
        text = event_type
    return severity, _USER_ID.sub(lambda m: names.get(m.group(0), m.group(0)), text)


# ── Endpoint ─────────────────────────────────────────────────────────


@router.get("", response_model=ActivityPage, response_model_by_alias=True)
async def sso_activity(
    from_ts: Optional[str] = Query(
        None, alias="fromTs",
        description="ISO timestamp; the window starts here. Omit for all time.",
    ),
    outcome: Optional[str] = Query(
        None, description="One of: " + ", ".join(OUTCOMES),
    ),
    connection: Optional[str] = Query(
        None, description="A connection's slug, or ``password``.",
    ),
    q: Optional[str] = Query(
        None,
        description="A person (name, email, id) or any text in the record: "
                    "a reference, an address, an IdP subject.",
    ),
    cursor: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=_MAX_LIMIT),
    _admin: User = Depends(requires("system:audit:read")),
    session: AsyncSession = Depends(get_db_session),
) -> ActivityPage:
    if outcome is not None and outcome not in OUTCOMES:
        raise HTTPException(status_code=422, detail="Unknown outcome")

    scope = []
    if from_ts:
        scope.append(OutboxEventORM.created_at >= from_ts)
    if connection:
        scope.append(await _connection_predicate(session, connection))
    term = (q or "").strip()
    if term:
        predicate, _ids = await search_predicate(session, term)
        scope.append(predicate)

    counted = await session.execute(
        select(OutboxEventORM.event_type, func.count())
        .where(OutboxEventORM.event_type.in_(EVENT_TYPES), *scope)
        .group_by(OutboxEventORM.event_type)
    )
    counts = {o: 0 for o in OUTCOMES}
    for event_type, n in counted.all():
        counts[OUTCOME_OF[event_type]] += int(n)

    page_filter = [
        OutboxEventORM.event_type.in_(OUTCOMES[outcome] if outcome else EVENT_TYPES),
        *scope,
    ]
    if cursor:
        page_filter.append(_cursor_predicate(cursor))
    found = (await session.execute(
        select(
            OutboxEventORM.id, OutboxEventORM.event_type,
            OutboxEventORM.created_at, OutboxEventORM.payload,
        )
        .where(*page_filter)
        .order_by(OutboxEventORM.created_at.desc(), OutboxEventORM.id.desc())
        .limit(limit + 1)
    )).all()
    more = len(found) > limit
    found = found[:limit]
    decoded = [(i, t, c, decode_payload(p)) for i, t, c, p in found]

    # Everyone and everything the page names, in a fixed number of queries.
    emails = [
        p["email"] for _, _, _, p in decoded
        if p.get("email") and not p.get("user_id")
    ]
    email_to_user = await user_repo.get_user_ids_by_emails(session, emails)
    user_ids: set[str] = set(email_to_user.values())
    for _, _, _, p in decoded:
        for key in ("user_id", "actor_id"):
            if p.get(key):
                user_ids.add(p[key])
    identities = await user_repo.get_identities_by_ids(session, list(user_ids))
    names = {
        uid: (info.get("name") or info.get("email"))
        for uid, info in identities.items()
        if info.get("name") or info.get("email")
    }
    provider_ids = {p.get("provider_id") for *_, p in decoded if p.get("provider_id")}
    slugs = {
        p.get("provider_slug") or p.get("slug")
        for *_, p in decoded if p.get("provider_slug") or p.get("slug")
    }
    slug_by_id: dict[str, str] = {}
    name_by_slug: dict[str, str] = {}
    if provider_ids or slugs:
        rows = await session.execute(
            select(IdpProviderORM.id, IdpProviderORM.slug,
                   IdpProviderORM.display_name)
            .where(or_(IdpProviderORM.id.in_(provider_ids),
                       IdpProviderORM.slug.in_(slugs)))
        )
        for pid, slug, display in rows.all():
            slug_by_id[pid] = slug
            if display:
                name_by_slug[slug] = display

    out: list[ActivityRow] = []
    for row_id, event_type, at, p in decoded:
        email = (p.get("email") or "").strip().lower() or None
        user_id = p.get("user_id") or (email_to_user.get(email) if email else None)
        slug = _connection_slug(event_type, p, slug_by_id)
        reason, detail = _reason(event_type, p)
        severity, summary = _summary(event_type, p, names)
        actor_id = p.get("actor_id")
        out.append(ActivityRow(
            id=row_id, at=at, event_type=event_type,
            outcome=OUTCOME_OF[event_type], severity=severity, summary=summary,
            person=_person(user_id, email, identities),
            actor=(_person(actor_id, None, identities)
                   if actor_id and actor_id != user_id else None),
            connection=(Connection(
                slug=slug,
                name="Password" if slug == PASSWORD else name_by_slug.get(slug),
            ) if slug else None),
            reason=reason, detail=detail, ref=p.get("ref"),
            client_ip=p.get("client_ip"), user_agent=p.get("user_agent"),
            payload=p,
        ))

    next_cursor = f"{found[-1][2]}|{found[-1][0]}" if more and found else None
    return ActivityPage(rows=out, next_cursor=next_cursor, counts=counts)
