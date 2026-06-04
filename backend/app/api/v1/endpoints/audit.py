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


# Phase 8: noisy events the default ``category=security`` filter
# excludes. These either fire on every request (logged_in /
# access_denied) or are bookkeeping the operator doesn't usually want
# in an audit trail (password-reset chrome, invite token chrome,
# self-service signups). The "Everything" toggle on the FE switches
# to ``category=all`` which suppresses this filter.
_NOISE_EVENT_TYPES = frozenset({
    "user.logged_in",
    "user.access_denied",
    "user.created",                  # pending signup; the .approved is the security event
    "user.created_via_invite",       # invite chrome — the role_changed/bound event is what matters
    "user.password_reset_requested",
    "user.password_reset_completed",
    "user.reset_token_generated",
    "user.invite_created",
    "rbac.access_request.created",   # only the approve/deny step is interesting
})


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


_EVENT_META: dict[str, tuple[str, callable]] = {
    # ── critical: role / identity changes
    "user.role_changed": ("critical", _summary_role_changed),
    "user.suspended": ("critical", _summary_user_status("suspended")),
    "user.rejected": ("critical", _summary_user_status("rejected")),
    "user.identity.admin_linked": ("critical", _summary_identity("linked")),
    "user.identity.admin_unlinked": ("critical", _summary_identity("unlinked")),
    "auth.config.updated": ("critical", lambda p: "SSO / login config changed"),
    "rbac.role.cascade_revoked": ("critical", _summary_cascade),
    "rbac.workspace.roles_cascaded": ("critical", _summary_ws_roles_cascaded),

    # ── warning: revokes / deletes / denials
    "rbac.workspace.member_revoked": ("warning", _summary_ws_member_revoked),
    "rbac.view.grant_removed": ("warning", _summary_view_grant("revoked")),
    "rbac.role.deleted": ("warning", _summary_role_lifecycle("deleted")),
    "rbac.group.deleted": ("warning", _summary_group_lifecycle("deleted")),
    "rbac.group.member_removed": ("warning", _summary_group_membership("removed from")),
    "rbac.sso_mapping.deleted": ("warning", _summary_sso_mapping("deleted")),
    "idp.provider.deleted": ("warning", _summary_idp_provider("deleted")),
    "rbac.access_request.denied": ("warning", _summary_access_request("denied")),

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
    "user.approved": ("info", _summary_user_status("approved")),
    "user.reactivated": ("info", _summary_user_status("reactivated")),
    "rbac.access_request.approved": ("info", _summary_access_request("approved")),
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
            "``security`` (default) hides operational noise like "
            "``user.logged_in`` / ``user.access_denied`` / signup "
            "chrome. ``all`` returns every event under the RBAC + "
            "user + auth + idp namespaces."
        ),
    ),
    _admin: User = Depends(requires("system:admin")),
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
        # aggregation jobs, etc.).
        stmt = stmt.where(
            or_(*[
                OutboxEventORM.event_type.like(f"{p}%")
                for p in _AUDIT_PREFIXES
            ])
        )

    # Phase 8: ``category=security`` (the default) additionally drops
    # the noisy event types so the page surfaces real RBAC signal by
    # default. ``category=all`` opts back into the full firehose.
    if category != "all":
        stmt = stmt.where(
            OutboxEventORM.event_type.notin_(_NOISE_EVENT_TYPES)
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

    # ── Python-level predicates (payload introspection) ───────────
    out: list[AuditEventResponse] = []
    for row in rows:
        ev = _row_to_response(row)
        if actor_id and ev.actor_id != actor_id:
            continue
        if target_user_id and ev.target_user_id != target_user_id:
            continue
        if target_role and ev.target_role != target_role:
            continue
        out.append(ev)

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
    _admin: User = Depends(requires("system:admin")),
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
