"""Sign-in failure digest for the SSO diagnostics page.

``GET /api/v1/admin/sso/failures`` answers the questions an operator
brings to that page: who could not sign in, why, how often, and whether
they have signed in since. The audit trail holds the answers one row at a
time; this turns a window of it into one row per person.

Cost is bounded by construction, whatever the table holds: one range read
over ``idx_outbox_event_type_created`` capped at :data:`SCAN_CAP` rows
(``truncated`` says when the cap was reached), then a fixed number of
batched lookups for the people in it. A search for a person narrows the
read itself, so someone buried under a flood of other failures is still
found.

Gate: ``system:audit:read`` — this is the audit trail, summarised.
"""
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import IdpProviderORM, OutboxEventORM
from backend.app.db.repositories import user_identity_repo, user_repo
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)
router = APIRouter()

#: The events that are a failed attempt to sign in.
ATTEMPT_TYPES = ("user.login_failed", "user.sso_login_failed")
#: Why a session stopped renewing — shown beside a person's failures, the
#: usual reason they were signing in again at all. Never counted as one.
SESSION_END_TYPES = (
    "user.session_refused",
    "user.sso_session_expired",
    "user.sso_session_ended_upstream",
)
#: Most rows one request reads. The newest are kept.
SCAN_CAP = 5_000
RECENT_PER_PERSON = 10
SESSION_ENDS_PER_PERSON = 5
RELATED_PER_PERSON = 5
#: How far before a person's attempt an unidentified failure from the same
#: browser is shown beside it.
RELATED_WINDOW = timedelta(minutes=30)
#: Password sign-ins have no provider row; they group under this slug.
PASSWORD = "password"
_DEFAULT_WINDOW = timedelta(days=7)
_SEARCH_IDS_CAP = 50
_CONTEXT_ADDRESSES_CAP = 10

_WRAPPED = "sso_login_rejected:"
_STATUS_SUFFIX = re.compile(r"^\d{3}$")


def split_reason(reason: Optional[str]) -> tuple[str, Optional[str]]:
    """``(code, detail)`` from a recorded reason.

    Older rows carried the free text inside the reason itself —
    ``bad_flow_cookie:Signature has expired``, ``idp_error=access_denied``.
    An HTTP status suffix is part of the code
    (``backchannel_idp_rejected:401``); any other suffix is the detail.
    ``sso_login_rejected:`` wraps the code the sign-in was refused with.
    """
    r = (reason or "").strip()
    if r.startswith(_WRAPPED):
        r = r[len(_WRAPPED):].strip() or "sso_rejected"
    if not r:
        return "unknown", None
    head, eq, tail = r.partition("=")
    if eq and ":" not in head:
        return head, tail.strip() or None
    code, colon, rest = r.partition(":")
    if not colon:
        return r, None
    if _STATUS_SUFFIX.match(rest):
        return r, None
    return code, rest.strip() or None


@dataclass
class Row:
    """One audit row the digest reads, already decoded."""
    event_type: str
    created_at: str
    payload: dict


@dataclass
class _Attempt:
    at: str
    code: str
    detail: Optional[str]
    provider: str
    ref: Optional[str]
    user_id: Optional[str]
    email: Optional[str]
    external_id: Optional[str]
    client_ip: Optional[str]
    user_agent: Optional[str]


def _attempt(row: Row) -> _Attempt:
    p = row.payload
    code, embedded = split_reason(p.get("reason"))
    provider = (
        PASSWORD if row.event_type == "user.login_failed"
        else (p.get("provider_slug") or "unknown")
    )
    email = (p.get("email") or "").strip().lower() or None
    return _Attempt(
        at=row.created_at, code=code,
        detail=p.get("detail") or embedded,
        provider=provider, ref=p.get("ref"),
        user_id=p.get("user_id"), email=email,
        external_id=p.get("external_id"),
        client_ip=p.get("client_ip"), user_agent=p.get("user_agent"),
    )


@dataclass
class _Person:
    key: str
    user_id: Optional[str] = None
    email: Optional[str] = None
    external_id: Optional[str] = None
    attempts: list[_Attempt] = field(default_factory=list)


def person_key(user_id: Optional[str], email: Optional[str],
               provider: str) -> str:
    """Who an attempt belongs to: the account, else the address typed or
    asserted, else nobody in particular on that connection."""
    if user_id:
        return user_id
    if email:
        return f"email:{email}"
    return f"unidentified:{provider}"


def digest(
    rows: list[Row],
    *,
    email_to_user: dict[str, str],
    accounts: dict[str, dict],
    ways_in: dict[str, list[dict]],
    provider_names: dict[str, str],
    reason: Optional[str] = None,
    provider: Optional[str] = None,
    search: Optional[str] = None,
    search_ids: frozenset[str] = frozenset(),
    limit: int = 50,
    context_rows: Optional[list[Row]] = None,
) -> dict:
    """One entry per person from a window of audit rows. Pure — the
    lookups are handed in, so this is where the behaviour is tested.

    ``reasons`` and ``providers`` count every attempt in the window, so the
    filter chips keep offering what the current filter hides; everything
    else reflects the filters. ``context_rows`` are read only to find
    unnamed failures from the same browser as someone's attempts — a
    search narrows ``rows`` to that person, which would otherwise leave
    those out.
    """
    attempts: list[_Attempt] = []
    ends: dict[str, list[dict]] = {}
    for row in rows:
        if row.event_type in ATTEMPT_TYPES:
            attempts.append(_attempt(row))
        elif row.event_type in SESSION_END_TYPES:
            uid = row.payload.get("user_id")
            if uid:
                ends.setdefault(uid, []).append({
                    "at": row.created_at,
                    "event_type": row.event_type,
                    "reason": row.payload.get("reason") or "unknown",
                    "provider": row.payload.get("provider_slug"),
                })

    reason_counts: dict[str, int] = {}
    provider_counts: dict[str, int] = {}
    for a in attempts:
        reason_counts[a.code] = reason_counts.get(a.code, 0) + 1
        provider_counts[a.provider] = provider_counts.get(a.provider, 0) + 1

    needle = (search or "").strip().lower()
    people: dict[str, _Person] = {}
    for a in attempts:
        if reason and a.code != reason:
            continue
        if provider and a.provider != provider:
            continue
        uid = a.user_id or (email_to_user.get(a.email) if a.email else None)
        key = person_key(uid, a.email, a.provider)
        person = people.setdefault(key, _Person(key=key))
        person.user_id = person.user_id or uid
        person.email = person.email or a.email
        person.external_id = person.external_id or a.external_id
        person.attempts.append(a)

    # An attempt that failed before anyone could be named — no session to
    # read, an upstream outage — is often what sent that same person to try
    # another way a minute later. Same network address and browser is
    # evidence, not proof (an office shares an address), so these are shown
    # beside the person as related rather than counted as theirs.
    anonymous: dict[tuple, list[_Attempt]] = {}
    seen: set[tuple] = set()
    extra = [
        _attempt(r) for r in (context_rows or [])
        if r.event_type in ATTEMPT_TYPES
    ]
    for a in attempts + extra:
        if not (a.user_id or a.email) and a.client_ip and a.user_agent:
            ident = (a.at, a.ref, a.client_ip)
            if ident in seen:
                continue
            seen.add(ident)
            anonymous.setdefault((a.client_ip, a.user_agent), []).append(a)

    out: list[dict] = []
    for person in people.values():
        account = accounts.get(person.user_id) if person.user_id else None
        if needle and not _matches(person, account, needle, search_ids):
            continue
        entry = _person_entry(person, account, ways_in, ends, provider_names)
        entry["related"] = (
            [] if entry["kind"] == "unidentified"
            else _related(person.attempts, anonymous, provider_names)
        )
        out.append(entry)

    # Still failing first — those are the people waiting on someone — then
    # the most recent trouble.
    out.sort(key=lambda e: e["last_at"], reverse=True)
    out.sort(key=lambda e: e["still_failing"] is not True)
    identified = [e for e in out if e["kind"] != "unidentified"]
    return {
        "totals": {
            "attempts": sum(e["attempts"] for e in out),
            "people": len(identified),
            "still_failing": sum(1 for e in identified if e["still_failing"]),
            "unidentified": sum(
                e["attempts"] for e in out if e["kind"] == "unidentified"
            ),
        },
        "reasons": _ranked(reason_counts, "code"),
        "providers": [
            {**r, "name": provider_names.get(r["slug"])}
            for r in _ranked(provider_counts, "slug")
        ],
        "people": out[:limit],
    }


def _at(iso: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return None


def _related(attempts: list[_Attempt],
             anonymous: dict[tuple, list[_Attempt]],
             provider_names: dict[str, str]) -> list[dict]:
    """Unidentified failures from the same browser shortly before any of
    this person's attempts, newest first."""
    found: dict[int, _Attempt] = {}
    for a in attempts:
        candidates = anonymous.get((a.client_ip, a.user_agent)) or []
        mine = _at(a.at)
        if mine is None:
            continue
        for c in candidates:
            theirs = _at(c.at)
            if theirs is not None and mine - RELATED_WINDOW <= theirs <= mine:
                found[id(c)] = c
    ordered = sorted(found.values(), key=lambda c: c.at, reverse=True)
    return [
        _attempt_entry(c, provider_names)
        for c in ordered[:RELATED_PER_PERSON]
    ]


def _attempt_entry(a: _Attempt, provider_names: dict[str, str]) -> dict:
    return {
        "at": a.at, "code": a.code, "detail": a.detail,
        "provider": a.provider, "provider_name": provider_names.get(a.provider),
        "ref": a.ref, "client_ip": a.client_ip, "user_agent": a.user_agent,
    }


def _matches(person: _Person, account: Optional[dict], needle: str,
             search_ids: frozenset[str]) -> bool:
    if person.user_id and person.user_id in search_ids:
        return True
    hay = [person.email, person.external_id]
    if account:
        hay += [account.get("name"), account.get("email")]
    return any(needle in (h or "").lower() for h in hay)


def _ranked(counts: dict[str, int], label: str) -> list[dict]:
    return [
        {label: k, "count": n}
        for k, n in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


def _person_entry(person: _Person, account: Optional[dict],
                  ways_in: dict[str, list[dict]],
                  ends: dict[str, list[dict]],
                  provider_names: dict[str, str]) -> dict:
    tries = sorted(person.attempts, key=lambda a: a.at, reverse=True)
    latest = tries[0]
    by_code: dict[str, int] = {}
    for a in tries:
        by_code[a.code] = by_code.get(a.code, 0) + 1
    last_sign_in = account.get("last_login_at") if account else None
    if account is not None:
        kind = "account"
        # A sign-in after the last failure means whatever it was has
        # cleared, for now at least.
        still_failing: Optional[bool] = not (
            last_sign_in and last_sign_in > latest.at
        )
    elif person.email:
        kind, still_failing = "no_account", True
    else:
        kind, still_failing = "unidentified", None
    first_at = tries[-1].at
    session_ends = [
        e for e in ends.get(person.user_id or "", [])
        if e["at"] >= _hours_before(first_at, 24)
    ]
    session_ends.sort(key=lambda e: e["at"], reverse=True)
    return {
        "key": person.key,
        "kind": kind,
        "user_id": person.user_id,
        "email": (account or {}).get("email") or person.email,
        "external_id": person.external_id,
        "name": (account or {}).get("name"),
        "avatar_id": (account or {}).get("avatar_id"),
        "status": (account or {}).get("status"),
        "deleted": bool((account or {}).get("deleted")),
        "password_set": (account or {}).get("password_set"),
        "ways_in": ways_in.get(person.user_id or "", []),
        "last_sign_in_at": last_sign_in,
        "attempts": len(tries),
        "first_at": first_at,
        "last_at": latest.at,
        "still_failing": still_failing,
        "latest": {
            "code": latest.code,
            "detail": latest.detail,
            "provider": latest.provider,
            "provider_name": provider_names.get(latest.provider),
            "ref": latest.ref,
        },
        "reasons": _ranked(by_code, "code"),
        "clients": len({a.client_ip for a in tries if a.client_ip}),
        "session_ends": session_ends[:SESSION_ENDS_PER_PERSON],
        "recent": [
            _attempt_entry(a, provider_names) for a in tries[:RECENT_PER_PERSON]
        ],
    }


def _hours_before(iso: str, hours: int) -> str:
    at = _at(iso)
    return iso if at is None else (at - timedelta(hours=hours)).isoformat()


# ── HTTP ──────────────────────────────────────────────────────────────


class _Model(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class ReasonCount(_Model):
    code: str
    count: int


class ProviderCount(_Model):
    slug: str
    name: Optional[str] = None
    count: int


class WayIn(_Model):
    slug: str
    name: Optional[str] = None
    last_used_at: Optional[str] = Field(default=None, alias="lastUsedAt")


class Latest(_Model):
    code: str
    detail: Optional[str] = None
    provider: str
    provider_name: Optional[str] = Field(default=None, alias="providerName")
    ref: Optional[str] = None


class SessionEnd(_Model):
    at: str
    event_type: str = Field(alias="eventType")
    reason: str
    provider: Optional[str] = None


class Attempt(_Model):
    at: str
    code: str
    detail: Optional[str] = None
    provider: str
    provider_name: Optional[str] = Field(default=None, alias="providerName")
    ref: Optional[str] = None
    client_ip: Optional[str] = Field(default=None, alias="clientIp")
    user_agent: Optional[str] = Field(default=None, alias="userAgent")


class PersonFailures(_Model):
    key: str
    kind: str
    user_id: Optional[str] = Field(default=None, alias="userId")
    email: Optional[str] = None
    external_id: Optional[str] = Field(default=None, alias="externalId")
    name: Optional[str] = None
    avatar_id: Optional[str] = Field(default=None, alias="avatarId")
    status: Optional[str] = None
    deleted: bool = False
    password_set: Optional[bool] = Field(default=None, alias="passwordSet")
    ways_in: list[WayIn] = Field(default_factory=list, alias="waysIn")
    last_sign_in_at: Optional[str] = Field(default=None, alias="lastSignInAt")
    attempts: int
    first_at: str = Field(alias="firstAt")
    last_at: str = Field(alias="lastAt")
    still_failing: Optional[bool] = Field(default=None, alias="stillFailing")
    latest: Latest
    reasons: list[ReasonCount]
    clients: int
    session_ends: list[SessionEnd] = Field(alias="sessionEnds")
    recent: list[Attempt]
    #: Failures nobody could be named for, from the same browser shortly
    #: before this person's attempts.
    related: list[Attempt] = Field(default_factory=list)


class Totals(_Model):
    attempts: int
    people: int
    still_failing: int = Field(alias="stillFailing")
    unidentified: int


class Window(_Model):
    from_ts: str = Field(alias="from")
    scanned: int
    truncated: bool


class FailureDigest(_Model):
    window: Window
    totals: Totals
    reasons: list[ReasonCount]
    providers: list[ProviderCount]
    people: list[PersonFailures]


def _decode(raw: Optional[str]) -> dict:
    try:
        value = json.loads(raw) if raw else {}
    except (TypeError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


async def _search_predicate(session: AsyncSession, term: str):
    """Narrow the read to rows that can belong to the person searched for:
    those naming one of their account ids, or containing the text itself
    (an email, an IdP subject). ``digest`` then keeps only the people who
    actually match."""
    ids = await user_repo.find_user_ids_matching(
        session, term, limit=_SEARCH_IDS_CAP,
    )
    clauses = [func.lower(OutboxEventORM.payload).contains(
        term.lower(), autoescape=True,
    )]
    clauses += [
        OutboxEventORM.payload.contains(f'"user_id": "{i}"', autoescape=True)
        for i in ids
    ]
    return or_(*clauses), frozenset(ids)


@router.get("", response_model=FailureDigest, response_model_by_alias=True)
async def sign_in_failures(
    from_ts: Optional[str] = Query(
        None, alias="fromTs",
        description="ISO timestamp; the window starts here. Default: 7 days ago.",
    ),
    reason: Optional[str] = Query(None, description="Only this reason code."),
    provider: Optional[str] = Query(
        None, description="Only this connection's slug, or ``password``.",
    ),
    q: Optional[str] = Query(
        None, description="A person: name, email, user id or IdP subject.",
    ),
    limit: int = Query(50, ge=1, le=200),
    _admin: User = Depends(requires("system:audit:read")),
    session: AsyncSession = Depends(get_db_session),
) -> FailureDigest:
    since = from_ts or (datetime.now(timezone.utc) - _DEFAULT_WINDOW).isoformat()
    stmt = (
        select(
            OutboxEventORM.event_type,
            OutboxEventORM.created_at,
            OutboxEventORM.payload,
        )
        .where(
            OutboxEventORM.event_type.in_(ATTEMPT_TYPES + SESSION_END_TYPES),
            OutboxEventORM.created_at >= since,
        )
        .order_by(OutboxEventORM.created_at.desc())
        .limit(SCAN_CAP + 1)
    )
    term = (q or "").strip()
    search_ids: frozenset[str] = frozenset()
    if term:
        predicate, search_ids = await _search_predicate(session, term)
        stmt = stmt.where(predicate)

    raw = (await session.execute(stmt)).all()
    truncated = len(raw) > SCAN_CAP
    rows = [Row(t, c, _decode(p)) for t, c, p in raw[:SCAN_CAP]]

    # A search reads only rows naming the person; the unnamed failures from
    # their browsers are read separately, as context for ``related``.
    context_rows: list[Row] = []
    if term:
        addresses = sorted({
            r.payload["client_ip"] for r in rows
            if r.event_type in ATTEMPT_TYPES and r.payload.get("client_ip")
        })[:_CONTEXT_ADDRESSES_CAP]
        if addresses:
            found = await session.execute(
                select(
                    OutboxEventORM.event_type,
                    OutboxEventORM.created_at,
                    OutboxEventORM.payload,
                )
                .where(
                    OutboxEventORM.event_type == "user.sso_login_failed",
                    OutboxEventORM.created_at >= since,
                    or_(*[
                        OutboxEventORM.payload.contains(
                            f'"client_ip": "{ip}"', autoescape=True,
                        )
                        for ip in addresses
                    ]),
                )
                .order_by(OutboxEventORM.created_at.desc())
                .limit(SCAN_CAP)
            )
            context_rows = [Row(t, c, _decode(p)) for t, c, p in found.all()]

    # Everyone the window names, resolved in a fixed number of queries.
    emails = [
        r.payload.get("email") for r in rows
        if r.event_type in ATTEMPT_TYPES
        and r.payload.get("email") and not r.payload.get("user_id")
    ]
    email_to_user = await user_repo.get_user_ids_by_emails(session, emails)
    user_ids = {
        r.payload.get("user_id") for r in rows if r.payload.get("user_id")
    } | set(email_to_user.values())
    accounts = await user_repo.get_sign_in_state_by_ids(session, list(user_ids))
    linked = await user_identity_repo.list_for_users(session, list(accounts))
    ways_in = {
        uid: [
            {
                "slug": i.provider.slug if i.provider else "?",
                "name": i.provider.display_name if i.provider else None,
                "last_used_at": i.last_login_at,
            }
            for i in identities
        ]
        for uid, identities in linked.items()
    }
    slugs = {
        r.payload.get("provider_slug") for r in rows + context_rows
        if r.payload.get("provider_slug")
    }
    provider_names: dict[str, str] = {}
    if slugs:
        found = await session.execute(
            select(IdpProviderORM.slug, IdpProviderORM.display_name)
            .where(IdpProviderORM.slug.in_(slugs))
        )
        provider_names = {s: n for s, n in found.all() if n}

    result: dict[str, Any] = digest(
        rows,
        email_to_user=email_to_user, accounts=accounts, ways_in=ways_in,
        provider_names=provider_names, reason=reason, provider=provider,
        search=term or None, search_ids=search_ids, limit=limit,
        context_rows=context_rows,
    )
    return FailureDigest(
        window=Window(from_ts=since, scanned=len(rows), truncated=truncated),
        totals=Totals(**result["totals"]),
        reasons=[ReasonCount(**r) for r in result["reasons"]],
        providers=[ProviderCount(**p) for p in result["providers"]],
        people=[PersonFailures(**p) for p in result["people"]],
    )
