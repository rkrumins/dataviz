"""Audit-log read endpoint (Phase 7).

Mounted at ``/api/v1/admin/audit``. Backed by the ``outbox_events``
table — every RBAC mutation already writes there (see Phase 5/6/7
endpoints). This module just gives operators + compliance officers a
filterable, paginated read surface so they don't have to query SQL
or wait for SIEM ingestion.

Gate: ``system:admin`` only. Audit history can contain sensitive
provenance (who promoted whom) so we don't expose it to org_admin.
"""
from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import OutboxEventORM
from backend.app.db.repositories import user_repo
from backend.auth_service.interface import User
from backend.common.models.audit import (
    AuditEventResponse,
    AuditListResponse,
)


logger = logging.getLogger(__name__)
router = APIRouter()


# Event-type prefixes operators care about. ``event_type`` is a free
# string in the outbox; the UI filter chips below map to these. We
# expose the prefix list to the frontend via ``GET /audit/event-types``
# so the chip set stays in sync with whatever the backend emits.
_AUDIT_PREFIXES = (
    "rbac.workspace.",   # member_bound / member_revoked / member_expiry_updated
    "rbac.view.",        # grant_added / grant_removed
    "rbac.role.",        # created / updated / deleted / cascade_revoked
    "rbac.permission.",  # updated
    "rbac.group.",       # created / updated / deleted / member_added / member_removed
    "rbac.access_request.",  # created / approved / denied
    "rbac.sso_mapping.",     # created / deleted
    "user.",             # role_changed / approved / etc.
    "auth.",             # config.updated
    "idp.",              # provider.created / updated / deleted
)


# Phase 9: three-mode noise filter.
#
# * ``security`` (the default) shows the events a SOC analyst /
#   compliance officer actually wants — logins, logouts, failed
#   logins, session revocations, every RBAC mutation, SSO config
#   changes, identity links. It hides only the truly chatty
#   operational events.
# * ``activity`` adds back password-reset / signup / access-denied
#   chrome — useful for support troubleshooting "what did this user
#   do today?".
# * ``all`` returns every event under the audit prefixes — the
#   firehose, for debugging.
#
# The Phase-8 default put logins on the noise list. That was an
# overcorrection: a SOC analyst opens the audit page TO see logins.
# Phase 9 moves them back to first-class.

_SECURITY_HIDE = frozenset({
    # Per-request 403 noise — even sampled, the volume is too high
    # to surface in the security view.
    "user.access_denied",
    # Pre-activation chrome. The real signal lives in
    # ``user.approved`` (admin clicked Approve) and
    # ``user.role_changed`` (role grant).
    "user.created",
    "user.created_via_invite",
    # Password-reset chrome — the completed event is the signal but
    # at security volume it's still noise. Activity mode keeps it.
    "user.password_reset_requested",
    "user.password_reset_completed",
    "user.reset_token_generated",
    "user.invite_created",
    # Access request lifecycle — only the approve / deny step is
    # interesting at security volume.
    "rbac.access_request.created",
})

# ``activity`` keeps the page useful for support work — adds back
# the password / signup chrome — but still hides the per-request
# 403 spam.
_ACTIVITY_HIDE = frozenset({
    "user.access_denied",
})

# ``all`` hides nothing.
#
# ``sso`` is different in kind from the other three: they subtract noisy
# event types from the full audit prefix set, whereas ``sso`` narrows the
# prefix set itself (see ``_SSO_PREFIXES``) and then hides nothing. It
# answers "why did this person's sign-in fail?", where every event under
# those prefixes is on-topic — including the chatty ones the security view
# suppresses.
_HIDE_BY_CATEGORY: dict[str, frozenset[str]] = {
    "security": _SECURITY_HIDE,
    "activity": _ACTIVITY_HIDE,
    "sso": frozenset(),
    "all": frozenset(),
}

# The identity surface: provider CRUD, group-mapping CRUD, platform auth
# posture changes, and the per-user identity/session events. Deliberately
# excludes the wider ``user.`` and ``rbac.`` prefixes — a role rename is an
# audit event but it is not an SSO event, and including it would put this
# view back in the same haystack it exists to escape.
_SSO_PREFIXES = (
    "idp.",                  # provider.created / updated / deleted
    "auth.",                 # config.updated
    "rbac.sso_mapping.",     # created / deleted
    "user.sso_",             # provisioned / linked / link_denied / jit_blocked
                             # / session_expired / unsigned_accepted
                             # / header_accepted
    "user.identity.",        # linked / unlinked / admin_linked / admin_unlinked
    "user.logged_in",
    "user.login_failed",
    "user.logged_out",
)


# Phase 8: per-event display metadata. Each entry maps a known
# event_type to (severity, summary-builder). The summary builder
# receives the decoded payload dict and returns a one-line human
# sentence. Missing payload keys are tolerated — the builder uses
# ``.get`` with sensible fallbacks so a malformed event never raises
# inside the response serialisation path.
def _summary_role_changed(p: dict) -> str:
    role = p.get("new_role") or "?"
    return f"Global role changed → {role}"


def _summary_ws_member_bound(p: dict) -> str:
    role = p.get("role") or "?"
    ws = p.get("workspace_id") or "?"
    expiry = p.get("expires_at")
    suffix = f" (expires {expiry[:10]})" if expiry else ""
    return f"Bound as {role} in {ws}{suffix}"


def _summary_ws_member_revoked(p: dict) -> str:
    role = p.get("role") or "?"
    ws = p.get("workspace_id") or "?"
    killed = p.get("sessions_revoked") or 0
    suffix = f" (killed {killed} session{'s' if killed != 1 else ''})" if killed else ""
    return f"{role} revoked from {ws}{suffix}"


def _summary_ws_expiry(p: dict) -> str:
    new = p.get("new_expires_at")
    if new is None:
        return f"Cleared expiry on {p.get('role') or '?'} in {p.get('workspace_id') or '?'}"
    return f"Expiry updated → {new[:10]} ({p.get('role') or '?'} in {p.get('workspace_id') or '?'})"


def _summary_role_lifecycle(verb: str):
    def _build(p: dict) -> str:
        return f"Role '{p.get('name') or '?'}' {verb}"
    return _build


def _summary_cascade(p: dict) -> str:
    n = p.get("users_revoked") or 0
    role = p.get("role_name") or "?"
    return f"Role '{role}' update cascade-revoked {n} user{'s' if n != 1 else ''}"


def _summary_ws_roles_cascaded(p: dict) -> str:
    n = len(p.get("roles_removed") or [])
    ws = p.get("workspace_id") or "?"
    return f"Workspace {ws} deletion cascaded {n} role{'s' if n != 1 else ''}"


def _summary_view_grant(verb: str):
    def _build(p: dict) -> str:
        view = p.get("view_id") or "?"
        role = p.get("role") or "?"
        return f"View grant ({role}) {verb} on {view}"
    return _build


def _summary_group_lifecycle(verb: str):
    def _build(p: dict) -> str:
        return f"Group '{p.get('group_name') or p.get('group_id') or '?'}' {verb}"
    return _build


def _summary_group_membership(verb: str):
    def _build(p: dict) -> str:
        return f"User {verb} group '{p.get('group_id') or '?'}'"
    return _build


def _summary_user_status(verb: str):
    def _build(p: dict) -> str:
        uid = p.get("user_id") or "?"
        return f"User {uid} {verb}"
    return _build


def _summary_identity(verb: str):
    def _build(p: dict) -> str:
        return f"SSO identity {verb} for {p.get('user_id') or '?'}"
    return _build


def _summary_access_request(verb: str):
    def _build(p: dict) -> str:
        ws = p.get("workspace_id") or "?"
        return f"Access request {verb} for {ws}"
    return _build


def _summary_idp_provider(verb: str):
    def _build(p: dict) -> str:
        slug = p.get("slug") or p.get("provider_id") or "?"
        return f"IdP provider '{slug}' {verb}"
    return _build


def _summary_sso_mapping(verb: str):
    def _build(p: dict) -> str:
        return f"IdP group mapping {verb} ({p.get('idp_group') or '?'})"
    return _build


def _summary_login(p: dict) -> str:
    provider = p.get("provider") or p.get("provider_slug") or "local"
    return f"Signed in via {provider}"


def _summary_login_failed(p: dict) -> str:
    reason = p.get("reason") or "invalid_credentials"
    email = p.get("email") or "?"
    return f"Failed login for {email} ({reason})"


def _summary_session_revoked(p: dict) -> str:
    reason = p.get("reason") or "unspecified"
    n = p.get("sessions_killed") or 1
    return f"Session revoked ({reason}, {n} kill{'s' if n != 1 else ''})"


def _summary_workspace_lifecycle(verb: str):
    def _build(p: dict) -> str:
        name = p.get("name") or p.get("workspace_id") or "?"
        return f"Workspace '{name}' {verb}"
    return _build


def _summary_sso_failure(p: dict) -> str:
    # ``ref`` leads the line: it is the handle the stuck user was shown on
    # the login page, so an admin pastes it into the filter and lands here.
    ref = p.get("ref")
    slug = p.get("provider_slug") or "?"
    reason = p.get("reason") or "unknown"
    lead = f"[{ref}] " if ref else ""
    return f"{lead}Sign-in via {slug} failed: {reason}"


def _summary_sso_user(verb: str) -> callable:
    def _build(p: dict) -> str:
        who = p.get("email") or p.get("user_id") or "?"
        return f"{who} {verb} {p.get('provider_slug') or 'an IdP'}"
    return _build


def _summary_sso_denied(p: dict) -> str:
    who = p.get("email") or p.get("user_id") or "?"
    reasons = p.get("deny_reasons") or p.get("reason")
    if isinstance(reasons, (list, tuple)):
        reasons = ", ".join(str(r) for r in reasons)
    slug = p.get("provider_slug") or "an IdP"
    return f"Refused {who} from {slug}" + (f": {reasons}" if reasons else "")


_EVENT_META: dict[str, tuple[str, callable]] = {
    # ── critical: role / identity changes / forced revocation
    "user.role_changed": ("critical", _summary_role_changed),
    "user.suspended": ("critical", _summary_user_status("suspended")),
    "user.rejected": ("critical", _summary_user_status("rejected")),
    "user.identity.admin_linked": ("critical", _summary_identity("linked")),
    "user.identity.admin_unlinked": ("critical", _summary_identity("unlinked")),
    "user.session_revoked": ("critical", _summary_session_revoked),
    "auth.config.updated": ("critical", lambda p: "SSO / login config changed"),
    "rbac.role.cascade_revoked": ("critical", _summary_cascade),
    "rbac.workspace.roles_cascaded": ("critical", _summary_ws_roles_cascaded),
    "rbac.workspace.deleted": (
        "critical", _summary_workspace_lifecycle("deleted"),
    ),

    # ── warning: revokes / deletes / denials / failed login
    "rbac.workspace.member_revoked": ("warning", _summary_ws_member_revoked),
    "rbac.view.grant_removed": ("warning", _summary_view_grant("revoked")),
    "rbac.role.deleted": ("warning", _summary_role_lifecycle("deleted")),
    "rbac.group.deleted": ("warning", _summary_group_lifecycle("deleted")),
    "rbac.group.member_removed": ("warning", _summary_group_membership("removed from")),
    "rbac.sso_mapping.deleted": ("warning", _summary_sso_mapping("deleted")),
    "idp.provider.deleted": ("warning", _summary_idp_provider("deleted")),
    "rbac.access_request.denied": ("warning", _summary_access_request("denied")),
    "user.login_failed": ("warning", _summary_login_failed),
    "user.logged_out": ("warning", lambda p: f"User {p.get('user_id') or '?'} signed out"),

    # ── info: binds / creates / updates
    "rbac.workspace.member_bound": ("info", _summary_ws_member_bound),
    "rbac.workspace.member_expiry_updated": ("info", _summary_ws_expiry),
    "rbac.view.grant_added": ("info", _summary_view_grant("added")),
    "rbac.role.created": ("info", _summary_role_lifecycle("created")),
    "rbac.role.updated": ("info", _summary_role_lifecycle("permissions updated")),
    "rbac.permission.updated": ("info", lambda p: f"Permission '{p.get('id') or '?'}' description updated"),
    "rbac.group.created": ("info", _summary_group_lifecycle("created")),
    "rbac.group.updated": ("info", _summary_group_lifecycle("updated")),
    "rbac.group.member_added": ("info", _summary_group_membership("added to")),
    "rbac.sso_mapping.created": ("info", _summary_sso_mapping("created")),
    "idp.provider.created": ("info", _summary_idp_provider("created")),
    "idp.provider.updated": ("info", _summary_idp_provider("updated")),
    "branding.updated": ("info", lambda p: "Branding settings updated"),
    "user.approved": ("info", _summary_user_status("approved")),
    "user.reactivated": ("info", _summary_user_status("reactivated")),
    "rbac.access_request.approved": ("info", _summary_access_request("approved")),
    # Phase 9 — login / lifecycle events promoted to first-class.
    "user.logged_in": ("info", _summary_login),
    "rbac.workspace.created": ("info", _summary_workspace_lifecycle("created")),
    "rbac.workspace.updated": ("info", _summary_workspace_lifecycle("updated")),

    # ── SSO sign-in outcomes.
    # ``ref`` is the handle the stuck user was shown on the login page, so it
    # leads the summary: an admin pastes it into the filter and lands here.
    "user.sso_login_failed": ("warning", _summary_sso_failure),
    "user.sso_provisioned": ("info", _summary_sso_user("provisioned via")),
    "user.sso_linked": ("info", _summary_sso_user("linked to")),
    "user.sso_link_denied": ("warning", _summary_sso_denied),
    "user.sso_jit_blocked": ("warning", _summary_sso_denied),
    "user.sso_session_expired": (
        "info",
        lambda p: (
            f"SSO session expired for {p.get('user_id') or '?'} "
            f"({p.get('provider_slug') or 'sso'}) — re-authentication required"
        ),
    ),
    # Degraded-trust logins. Warning, not info: each one is a login the
    # platform could not cryptographically verify.
    "user.sso_unsigned_accepted": (
        "warning",
        lambda p: (
            f"Accepted an UNSIGNED profile from "
            f"{p.get('provider_slug') or '?'} "
            f"(source {p.get('source') or '?'})"
        ),
    ),
    "user.sso_header_accepted": (
        "warning",
        lambda p: (
            f"Trusted a proxy-injected header from "
            f"{p.get('provider_slug') or '?'} "
            f"({p.get('source_key') or '?'})"
        ),
    ),
}


_MAX_LIMIT = 500
_DEFAULT_LIMIT = 50


def _row_to_response(row: OutboxEventORM) -> AuditEventResponse:
    """Decode the JSON payload + surface payload-derived fields the
    UI keys off (actor_id, target_user_id, target_role, severity,
    summary).

    Bad JSON is treated as ``{}`` rather than 500'd — an event with a
    malformed payload is operationally rare and shouldn't break the
    audit lens for everything else.
    """
    try:
        payload = json.loads(row.payload) if row.payload else {}
    except (TypeError, ValueError):
        payload = {}
    if not isinstance(payload, dict):
        payload = {}

    # Phase 8: pick severity + human summary from the per-event
    # catalogue. Unknown events default to ``info`` + the raw type
    # so a new event added on the backend without a catalogue entry
    # still renders something sensible (just not as polished).
    meta = _EVENT_META.get(row.event_type)
    if meta is not None:
        severity, summary_builder = meta
        try:
            summary = summary_builder(payload)
        except Exception:  # noqa: BLE001 — never break the response on a bad summary
            summary = row.event_type
    else:
        severity = "info"
        summary = row.event_type

    return AuditEventResponse(
        event_id=row.id,
        event_type=row.event_type,
        event_version=row.event_version,
        aggregate_type=row.aggregate_type,
        aggregate_id=row.aggregate_id,
        created_at=row.created_at,
        actor_id=payload.get("actor_id") or payload.get("changed_by")
            or payload.get("granted_by"),
        target_user_id=(
            payload.get("user_id")
            or (payload.get("subject_id") if payload.get("subject_type") == "user" else None)
        ),
        target_role=payload.get("role")
            or payload.get("new_role")
            or payload.get("role_name")
            or payload.get("name"),
        workspace_id=payload.get("workspace_id"),
        severity=severity,
        summary=summary,
        payload=payload,
    )


@router.get(
    "",
    response_model=AuditListResponse,
    response_model_by_alias=True,
)
async def list_audit_events(
    event_type: Optional[str] = Query(
        None, alias="eventType",
        description=(
            "Exact event type or a wildcard prefix (e.g. "
            "``rbac.role.*``). Suffix ``*`` triggers prefix match."
        ),
    ),
    actor_id: Optional[str] = Query(None, alias="actorId"),
    target_user_id: Optional[str] = Query(None, alias="targetUserId"),
    target_role: Optional[str] = Query(None, alias="targetRole"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    from_ts: Optional[str] = Query(
        None, alias="fromTs",
        description="ISO timestamp inclusive lower bound on created_at.",
    ),
    to_ts: Optional[str] = Query(
        None, alias="toTs",
        description="ISO timestamp exclusive upper bound on created_at.",
    ),
    cursor: Optional[str] = Query(
        None,
        description=(
            "Opaque cursor returned by the previous page's "
            "``next_cursor``. Pass to fetch the next page."
        ),
    ),
    limit: int = Query(_DEFAULT_LIMIT, ge=1, le=_MAX_LIMIT),
    category: str = Query(
        "security",
        description=(
            "``security`` (default) hides per-request noise "
            "(access_denied) plus signup / password-reset chrome; "
            "surfaces logins, logouts, failed logins, session "
            "revocations, every RBAC mutation. ``activity`` adds back "
            "signup + password chrome for support work. ``all`` is the "
            "unfiltered firehose. ``sso`` narrows to the identity "
            "surface only (provider + mapping CRUD, auth posture, "
            "identity links, login outcomes) and hides nothing within "
            "it — the view for debugging a failed sign-in."
        ),
    ),
    _admin: User = Depends(requires("system:audit:read")),
    session: AsyncSession = Depends(get_db_session),
) -> AuditListResponse:
    """Filter + paginate the outbox-events audit trail.

    The handler keeps the SQL simple: indexable predicates on
    ``event_type`` / ``created_at`` / ``aggregate_*`` filter at the
    DB layer; the per-event payload predicates (actor_id / target_*)
    filter in Python after JSON-decoding. This is fine because the
    pre-filtered set is small (a tight ``event_type`` + ``created_at``
    window usually drops the count by orders of magnitude before the
    Python pass runs).

    Pagination uses ``(created_at, id)`` as the cursor — both columns
    are part of the ``idx_outbox_processed_created`` index so the
    ``created_at`` predicate is cheap, and ``id`` breaks ties when
    multiple events share a millisecond (uuid suffix makes them
    deterministic).
    """
    stmt = select(OutboxEventORM)

    # ── DB-level predicates ──────────────────────────────────────
    if event_type:
        if event_type.endswith("*"):
            prefix = event_type[:-1]
            stmt = stmt.where(OutboxEventORM.event_type.like(f"{prefix}%"))
        else:
            stmt = stmt.where(OutboxEventORM.event_type == event_type)
    else:
        # Default: only RBAC + user lifecycle events, never the
        # everything-else outbox noise (graph cache invalidation,
        # aggregation jobs, etc.). The ``sso`` category narrows further
        # to the identity surface — see _SSO_PREFIXES.
        prefixes = _SSO_PREFIXES if category == "sso" else _AUDIT_PREFIXES
        stmt = stmt.where(
            or_(*[
                OutboxEventORM.event_type.like(f"{p}%")
                for p in prefixes
            ])
        )

    # Phase 9: three-mode category filter. ``security`` (default)
    # hides only the chatty events that drown out the security
    # signal; ``activity`` keeps password / signup chrome visible
    # for support work; ``all`` is the unfiltered firehose.
    hide_set = _HIDE_BY_CATEGORY.get(category, _SECURITY_HIDE)
    if hide_set:
        stmt = stmt.where(
            OutboxEventORM.event_type.notin_(hide_set)
        )
    if from_ts:
        stmt = stmt.where(OutboxEventORM.created_at >= from_ts)
    if to_ts:
        stmt = stmt.where(OutboxEventORM.created_at < to_ts)
    if workspace_id:
        # Most rbac.workspace.* events carry workspace_id in the
        # ``aggregate_id`` slot too. We OR both so a future change to
        # the aggregate_id contract doesn't silently break the
        # filter.
        stmt = stmt.where(
            or_(
                OutboxEventORM.aggregate_id == workspace_id,
                OutboxEventORM.payload.like(f'%"workspace_id": "{workspace_id}"%'),
            )
        )

    # ── Cursor ───────────────────────────────────────────────────
    if cursor:
        try:
            cursor_ts, cursor_id = cursor.split("|", 1)
        except ValueError:
            raise HTTPException(
                status_code=400, detail="Malformed cursor",
            )
        # Newer first: continue with strictly older entries OR same
        # ts with smaller id (lexicographic).
        stmt = stmt.where(
            or_(
                OutboxEventORM.created_at < cursor_ts,
                and_(
                    OutboxEventORM.created_at == cursor_ts,
                    OutboxEventORM.id < cursor_id,
                ),
            )
        )

    stmt = stmt.order_by(
        OutboxEventORM.created_at.desc(),
        OutboxEventORM.id.desc(),
    ).limit(limit + 1)  # +1 to detect "has next page"

    rows = list((await session.execute(stmt)).scalars().all())
    has_more = len(rows) > limit
    rows = rows[:limit]

    # ── Turn a typed person into the ids to match on ──────────────
    # The two filters took an exact user id, which was all they could offer
    # while the rows showed nothing else. The table names people now, so an
    # operator will type "john" or an email — and matching that against an id
    # returns nothing, silently, which reads as "this person did nothing"
    # rather than "that is not an id".
    #
    # An exact id short-circuits: it needs no lookup, and it keeps every
    # existing link and bookmark working unchanged. Anything else is resolved
    # to a SET of ids once, and the row test becomes membership.
    async def _subject_ids(term: Optional[str]) -> Optional[set[str]]:
        if not term:
            return None
        term = term.strip()
        if not term:
            return None
        try:
            matches = await user_repo.find_user_ids_matching(session, term)
        except Exception:  # noqa: BLE001
            logger.warning("audit: could not resolve the subject filter %r", term, exc_info=True)
            # Fall back to the exact-id behaviour rather than dropping the
            # filter — silently widening a filter shows rows the operator
            # asked to exclude.
            return {term}
        # A term that resolves to nobody must still filter to nothing, not to
        # everything: `set()` is a real answer, and `None` means "no filter".
        return matches | ({term} if term.startswith("usr_") else set())

    actor_ids = await _subject_ids(actor_id)
    target_ids = await _subject_ids(target_user_id)

    # ── Python-level predicates (payload introspection) ───────────
    out: list[AuditEventResponse] = []
    for row in rows:
        ev = _row_to_response(row)
        if actor_ids is not None and ev.actor_id not in actor_ids:
            continue
        if target_ids is not None and ev.target_user_id not in target_ids:
            continue
        if target_role and ev.target_role != target_role:
            continue
        out.append(ev)

    # ── Name the people in the page ───────────────────────────────
    # ONE query for the whole page, after filtering, so the lookup only ever
    # covers rows that are actually being returned. Every event carries at most
    # two user ids and a page is capped at `_MAX_LIMIT`, so this is a single
    # indexed `IN` over a few dozen keys at worst.
    #
    # It runs against the page rather than per row for the obvious reason, but
    # also because the same actor usually appears on many rows of an audit log —
    # deduplicating first turns "one lookup per row" into "one lookup per
    # distinct person".
    #
    # A failure here must not take the audit lens down with it: the ids are the
    # record, the names are an enrichment of it, and a log that renders with raw
    # ids is enormously more useful than one that 500s.
    try:
        identities = await user_repo.get_identities_by_ids(
            session,
            [i for ev in out for i in (ev.actor_id, ev.target_user_id) if i],
        )
    except Exception:  # noqa: BLE001
        logger.warning("audit: could not resolve user identities for this page", exc_info=True)
        identities = {}

    # Same treatment for the workspace an event happened in: "ws_4f21c8" tells
    # a reader nothing they can act on. Deleted workspaces are included for the
    # same reason deleted users are — an event in a workspace that has since
    # been torn down is among the more interesting rows in the log.
    try:
        workspace_names = await user_repo.get_workspace_names_by_ids(
            session, [ev.workspace_id for ev in out if ev.workspace_id],
        )
    except Exception:  # noqa: BLE001
        logger.warning("audit: could not resolve workspace names for this page", exc_info=True)
        workspace_names = {}

    for ev in out:
        if ev.workspace_id:
            ev.workspace_name = workspace_names.get(ev.workspace_id)
        actor = identities.get(ev.actor_id) if ev.actor_id else None
        if actor:
            ev.actor_name = actor["name"] or None
            ev.actor_email = actor["email"]
            ev.actor_deleted = actor["deleted"]
        target = identities.get(ev.target_user_id) if ev.target_user_id else None
        if target:
            ev.target_user_name = target["name"] or None
            ev.target_user_email = target["email"]
            ev.target_user_deleted = target["deleted"]

    next_cursor = None
    if has_more and rows:
        last = rows[-1]
        next_cursor = f"{last.created_at}|{last.id}"

    return AuditListResponse(events=out, next_cursor=next_cursor)


@router.get(
    "/event-types",
    response_model=list[str],
)
async def list_event_types(
    _admin: User = Depends(requires("system:audit:read")),
    session: AsyncSession = Depends(get_db_session),
) -> list[str]:
    """Distinct event types that have ever been emitted into the
    RBAC / user lifecycle namespace. Powers the FE filter dropdown
    so the chip list stays in sync with whatever the backend has
    actually produced (not whatever the FE thinks it knows about).
    """
    stmt = (
        select(OutboxEventORM.event_type)
        .distinct()
        .where(
            or_(*[
                OutboxEventORM.event_type.like(f"{p}%")
                for p in _AUDIT_PREFIXES
            ])
        )
        .order_by(OutboxEventORM.event_type)
    )
    rows = (await session.execute(stmt)).scalars().all()
    return list(rows)
