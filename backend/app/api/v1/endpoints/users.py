"""
User endpoints (authenticated) and admin user management endpoints.

Authenticated:
    GET  /api/v1/users/me

Admin:
    GET   /api/v1/admin/users?status=pending
    POST  /api/v1/admin/users/{user_id}/approve
    POST  /api/v1/admin/users/{user_id}/reject
    PUT   /api/v1/admin/users/{user_id}/role
    POST  /api/v1/admin/users/{user_id}/suspend
    POST  /api/v1/admin/users/{user_id}/reactivate
    POST  /api/v1/admin/users/{user_id}/reset-password
    POST  /api/v1/admin/users/{user_id}/generate-reset-token
"""
import base64
import hashlib
import json
import logging
import re
import uuid
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy import desc, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import (
    get_current_user,
    get_permission_claims,
    require_admin,
)
from backend.app.services.permission_service import PermissionClaims, has_permission
from backend.app.auth.password import hash_password
# ``is_password_set`` has no re-export on the app-side shim, so it comes
# from the source module — same as ``me_identities.py``.
from backend.auth_service.core.password import is_password_set, verify_password
from backend.app.api.v1.endpoints.auth import (
    _check_password_strength,
    INVITE_LINKS_FAIL_OPEN,
)
from backend.app.api.v1.feature_gate import feature_disabled
from backend.auth_service.cookies import clear_session_cookies
from backend.auth_service.core.tokens import invite_expiry
from backend.app.services.feature_flags import feature_flags
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import user_identity_repo, user_repo
from backend.common.display_name import resolve_display_name
from backend.common.models.auth import (
    AccountActivityItem,
    AdminCreateUserRequest,
    AdminCreateUserResponse,
    AdminUserIdentityRef,
    AdminUserResponse,
    AdminResetPasswordRequest,
    ChangeMyPasswordRequest,
    BulkCreateUsersRequest,
    BulkCreateUsersResponse,
    BulkCreateUserResult,
    ApproveRejectRequest,
    ChangeRoleRequest,
    BulkInviteRequest,
    BulkInviteResponse,
    BulkInviteResult,
    CreateInviteRequest,
    ExtendInviteRequest,
    InviteActivityItem,
    InviteRedemptionResponse,
    InviteSummaryResponse,
    InviteTokenResponse,
    ResetTokenResponse,
    SetSystemAccountRequest,
    UpdateUserRequest,
    UserPublicResponse,
)

logger = logging.getLogger(__name__)


# ── Helpers ────────────────────────────────────────────────────────────

async def _public_response(session: AsyncSession, user) -> UserPublicResponse:
    roles = await user_repo.get_user_roles(session, user.id)
    role = roles[0] if roles else "user"
    # The provider id, not its display name: the account page already
    # fetches /me/identities, which carries both, so resolving it here
    # would be a second query for something the client can join.
    owned, owned_by = user_repo.idp_ownership(user)
    return UserPublicResponse(
        id=user.id,
        email=user.email,
        firstName=user.first_name,
        lastName=user.last_name,
        displayName=resolve_display_name(
            user.display_name, user.first_name, user.last_name,
        ),
        status=user.status,
        role=role,
        createdAt=user.created_at,
        avatarId=user.avatar_id,
        mustChangePassword=bool(user.must_change_password),
        idpManagedFields=sorted(owned),
        idpManagedBy=owned_by,
    )


def _identity_ref(row) -> AdminUserIdentityRef:
    return AdminUserIdentityRef(
        providerId=row.provider_id,
        slug=row.provider.slug if row.provider else row.provider_id,
        displayName=(
            row.provider.display_name if row.provider else row.provider_id
        ),
        kind=row.provider.kind if row.provider else "unknown",
        lastLoginAt=row.last_login_at,
    )


async def _admin_response(
    session: AsyncSession, user, *, identities=None,
) -> AdminUserResponse:
    roles = await user_repo.get_user_roles(session, user.id)
    role = roles[0] if roles else "user"
    has_reset = await user_repo.has_pending_reset(session, user.id)
    # ``identities=None`` means "not batched by the caller" — fetch this
    # one user's rows rather than reporting an SSO account as local. The
    # list endpoint batches; the single-user paths pay one small query.
    if identities is None:
        identities = await user_identity_repo.list_for_user(session, user.id)
    return AdminUserResponse(
        id=user.id,
        email=user.email,
        firstName=user.first_name,
        lastName=user.last_name,
        displayName=resolve_display_name(
            user.display_name, user.first_name, user.last_name,
        ),
        status=user.status,
        role=role,
        createdAt=user.created_at,
        updatedAt=user.updated_at,
        resetRequested=has_reset,
        mustChangePassword=bool(user.must_change_password),
        hasPassword=is_password_set(user.password_hash),
        signupSource=getattr(user, "signup_source", None),
        identities=[_identity_ref(row) for row in identities],
        isSystemAccount=bool(getattr(user, "is_system_account", False)),
    )


# ── Authenticated user routes ─────────────────────────────────────────

router = APIRouter()

# Own limiter instance, matching ``auth.py``. Only the self-service
# password route uses it: asking for the current password makes that
# endpoint a credential oracle, which nothing else on this router is.
limiter = Limiter(key_func=get_remote_address)


@router.get("/me/invite-activity", response_model=list[InviteActivityItem])
async def my_invite_activity(
    limit: int = Query(20, ge=1, le=50),
    current_user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """People who have signed up through links I created, newest first.

    The other half of an invitation. Sending one and never hearing
    whether it was used makes the whole thing feel like shouting into a
    void, and leaves the sender with no idea whether to follow up or let
    it expire.

    Scoped to the caller's own links — an invitation is a personal act,
    and this answers "did mine work?", not "who joined the company".
    """
    from backend.app.db.repositories import invite_repo, workspace_repo

    rows = await invite_repo.recent_redemptions_for_creator(
        session, current_user.id, limit=limit,
    )
    ws_names: dict[str, Optional[str]] = {}
    out: list[InviteActivityItem] = []
    for redemption, invite in rows:
        if invite.workspace_id and invite.workspace_id not in ws_names:
            ws = await workspace_repo.get_workspace_orm(session, invite.workspace_id)
            ws_names[invite.workspace_id] = ws.name if ws else None
        out.append(InviteActivityItem(
            id=redemption.id,
            email=redemption.email,
            userId=redemption.user_id,
            redeemedAt=redemption.redeemed_at,
            inviteId=invite.id,
            role=invite.role,
            workspaceId=invite.workspace_id,
            workspaceName=(
                ws_names.get(invite.workspace_id) if invite.workspace_id else None
            ),
        ))
    return out


@router.get("/me", response_model=UserPublicResponse)
async def get_me(
    current_user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    # Read the row rather than projecting the session DTO: the account
    # page saves and immediately re-reads, and the DTO is only as fresh
    # as the access token that carried it.
    user = await user_repo.get_user_by_id(session, current_user.id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return await _public_response(session, user)


# ── Self-service account management ───────────────────────────────────
#
# These live on the ``/users`` router rather than ``/auth`` for two
# reasons. ``auth.py`` is the unauthenticated subset — signup, forgot,
# reset — and these are the opposite of that. And ``csrf.py`` exempts a
# fixed list of ``/api/v1/auth/*`` paths from the double-submit check;
# an authenticated cookie mutation is exactly what that check exists to
# protect, so it belongs on a prefix that was never exempted.


@router.patch("/me", response_model=UserPublicResponse)
async def update_my_identity(
    body: UpdateUserRequest,
    current_user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Edit my own profile.

    Same rules as the admin edit (``update_user_identity``): email is
    the SSO identity key and changes through a re-link flow, not here. A
    body with nothing to apply returns the current state so the client
    can refresh without a second GET.

    An empty ``displayName`` is an instruction, not a mistake — it
    clears the override so the name goes back to being derived from
    first + last.

    Fields the identity provider asserts are refused with a 409: it
    re-applies them on every sign-in, so accepting a write here would
    show a change that silently reverted the next time the person
    logged in. ``displayName`` is never IdP-owned, which is what keeps
    the page useful for an SSO account.
    """
    user = await user_repo.get_user_by_id(session, current_user.id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    owned, _provider_id = user_repo.idp_ownership(user)

    updates: dict[str, str] = {}
    if body.first_name is not None and body.first_name.strip():
        updates["first_name"] = body.first_name.strip()
    if body.last_name is not None and body.last_name.strip():
        updates["last_name"] = body.last_name.strip()
    if body.display_name is not None:
        updates["display_name"] = body.display_name
    if body.avatar_id is not None:
        updates["avatar_id"] = body.avatar_id

    # Refuse rather than drop — checked against the COMPLETE update set,
    # so a managed avatar is refused the same way a managed name is.
    # Quietly ignoring a field the user typed into is how a form comes
    # to feel broken — and the UI already renders these as read-only, so
    # reaching this branch means something bypassed it.
    # ``display_name`` is never in MANAGEABLE_FIELDS, so it can never be
    # refused; the wire key and the provenance name differ for avatars.
    _provenance_name = {"avatar_id": "avatar"}
    refused = sorted(
        {_provenance_name.get(k, k) for k in updates} & owned
    )
    if refused:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "idp_managed_field",
                "fields": refused,
                "message": (
                    "Your identity provider manages part of your profile. "
                    "It is re-applied every time you sign in, so a change "
                    "made here would not survive. Set a display name "
                    "instead, or ask your provider's administrator to "
                    "update it."
                ),
            },
        )
    if not updates:
        return await _public_response(session, user)

    await user_repo.update_identity(session, current_user.id, **updates)

    await user_repo.create_outbox_event(
        session,
        event_type="user.identity_updated",
        payload={
            "user_id": current_user.id,
            "updated_fields": list(updates.keys()),
            "updated_by": current_user.id,
            # ``updated_by == user_id`` is ambiguous on its own — an
            # admin editing their own row looks identical. This is what
            # tells the two apart. Convention borrowed from
            # ``me_identities.py``.
            "via": "self_service",
        },
        aggregate_type="user",
        aggregate_id=current_user.id,
    )

    logger.info(
        "User %s updated own profile: %s", current_user.id, list(updates.keys()),
    )

    refreshed = await user_repo.get_user_by_id(session, current_user.id)
    return await _public_response(session, refreshed)


@router.get("/{user_id}/avatar")
async def get_user_avatar(
    user_id: str,
    request: Request,
    current_user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """The provider-supplied profile picture, served from our origin.

    The bytes were fetched server-side at SSO login (the CSP forbids
    hotlinking a remote image), so this is the only URL an ``<img>`` can
    load them from. Any signed-in user may fetch any user's avatar — it
    renders on member lists — and the response is cacheable per-browser:
    a strong ETag plus a short private max-age keeps a member list from
    refetching every face on every render, on the 404 side too, where
    most users live.
    """
    if user_id == "me":
        user_id = current_user.id
    user = await user_repo.get_user_by_id(session, user_id)
    image_b64 = getattr(user, "avatar_image", None) if user else None
    # The bytes came from a third party. Only raster types are ever
    # stored, but a served image endpoint must not depend on that: no
    # sniffing, and a document context gets an empty sandbox.
    guard = {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox",
    }
    absent = Response(
        status_code=404,
        headers={"Cache-Control": "private, max-age=60", **guard},
    )
    if not image_b64:
        return absent
    try:
        content = base64.b64decode(image_b64)
    except (ValueError, TypeError):
        return absent
    etag = f'"{hashlib.sha256(content).hexdigest()[:32]}"'
    cache = {"ETag": etag, "Cache-Control": "private, max-age=300", **guard}
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=cache)
    return Response(
        content=content,
        media_type=getattr(user, "avatar_image_type", None) or "image/png",
        headers=cache,
    )


@router.post("/me/password", status_code=status.HTTP_200_OK)
@limiter.limit("5/minute")
async def change_my_password(
    request: Request,
    response: Response,
    body: ChangeMyPasswordRequest,
    current_user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Change my own password, and sign every session out.

    Rate-limited to match ``/auth/reset-password``: verifying
    ``currentPassword`` turns this into a credential oracle, which none
    of the other self-service routes are.

    Both halves of the revocation run. Tombstoning the live access
    tokens covers the next few minutes; stamping ``sessions_valid_from``
    is what makes it stick, because a refresh mints a brand-new ``sid``
    that no tombstone covers. The caller's own session dies too — the UI
    says so before you submit.
    """
    user = await user_repo.get_user_by_id(session, current_user.id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Checked before the current-password comparison: an SSO-only
    # account has no password to be wrong about, and "incorrect" would
    # send someone hunting for a credential that does not exist.
    if not is_password_set(user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This account signs in through an identity provider and has "
                "no password to change. Sign in with your provider, or ask an "
                "administrator to set a password for you."
            ),
        )

    if not verify_password(body.current_password, user.password_hash):
        # 403, not 401. The frontend treats 401 as a dead session: it
        # silently refreshes, retries, and on failure signs the user
        # out — so a typo here would read as "Session expired" and could
        # end the session it was trying to secure.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Current password is incorrect.",
        )

    _check_password_strength(body.new_password)

    # ``update_password`` also clears the reset token and the
    # forced-rotation flag, so changing your own password retires a
    # pending admin reset request rather than leaving it live.
    await user_repo.update_password(
        session, current_user.id, hash_password(body.new_password),
    )
    await _revoke_my_every_session(
        session, current_user.id, reason="password_changed",
        response=response, request=request,
    )

    await user_repo.create_outbox_event(
        session,
        event_type="user.password_changed",
        payload={"user_id": current_user.id, "via": "self_service"},
        aggregate_type="user",
        aggregate_id=current_user.id,
    )

    logger.info("User %s changed their own password", current_user.id)
    return {"detail": "Password updated. Sign in again with your new password."}


@router.post("/me/sessions/revoke-all", status_code=status.HTTP_200_OK)
async def revoke_my_sessions(
    response: Response,
    request: Request,
    current_user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Sign out everywhere, this device included.

    The blunt version is the honest one: keeping the calling session
    alive would mean re-issuing its cookies past the cutoff, which needs
    session-minting surface on ``IdentityService`` that does not exist
    and that the extraction plan does not want.

    "This device included" has to mean the cookies as well. Revoking
    server-side alone left the caller's browser holding a full set of
    session cookies for a session that no longer exists — so the SPA
    still believed it was signed in, the login page offered "You're
    already signed in as …", and reloading re-read the same cookies and
    said it again. The user could not get out of their own sign-out.
    """
    await _revoke_my_every_session(
        session, current_user.id, reason="revoked_by_user",
        response=response, request=request,
    )
    await user_repo.create_outbox_event(
        session,
        event_type="user.sessions_revoked_by_self",
        payload={"user_id": current_user.id},
        aggregate_type="user",
        aggregate_id=current_user.id,
    )
    logger.info("User %s revoked all their own sessions", current_user.id)
    return {"detail": "Signed out on every device."}


#: What the account page shows under "recent activity". Deliberately a
#: whitelist: this is the caller's own security history, not a feed of
#: everything the platform has ever recorded about them.
_ACCOUNT_ACTIVITY_TYPES = (
    "user.password_changed",
    "user.password_reset_by_admin",
    "user.password_reset_completed",
    "user.reset_token_generated",
    "user.identity_updated",
    "user.sessions_revoked_by_self",
    "user.session_revoked",
    "user.role_changed",
    "user.suspended",
    "user.reactivated",
)


@router.get("/me/activity", response_model=list[AccountActivityItem])
async def my_account_activity(
    limit: int = Query(20, ge=1, le=50),
    current_user=Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """My own account-security history, newest first.

    Filtered on ``aggregate_type``/``aggregate_id``, which
    ``idx_outbox_aggregate`` covers — the alternative, matching the
    user id inside the JSON payload, is an unindexed scan of a table
    that grows forever.

    Only events written after this feature shipped carry the aggregate
    columns, so the history starts at upgrade rather than at signup. The
    page says so; an empty list must not be read as "nothing happened".
    """
    from backend.app.db.models import OutboxEventORM

    rows = (await session.execute(
        select(OutboxEventORM)
        .where(
            OutboxEventORM.aggregate_type == "user",
            OutboxEventORM.aggregate_id == current_user.id,
            OutboxEventORM.event_type.in_(_ACCOUNT_ACTIVITY_TYPES),
        )
        .order_by(desc(OutboxEventORM.created_at))
        .limit(limit)
    )).scalars().all()

    out: list[AccountActivityItem] = []
    for row in rows:
        try:
            payload = json.loads(row.payload or "{}")
        except ValueError:
            payload = {}
        actor = payload.get("updated_by") or payload.get("reset_by") or payload.get("changed_by")
        out.append(AccountActivityItem(
            id=row.id,
            eventType=row.event_type,
            occurredAt=row.created_at,
            # True when somebody else did this to the account. Worth
            # distinguishing: "your password was reset" reads very
            # differently depending on who reset it.
            byAdmin=bool(actor and actor != current_user.id),
        ))
    return out


async def _revoke_my_every_session(
    session: AsyncSession,
    user_id: str,
    *,
    reason: str,
    response: Response,
    request: Request,
) -> None:
    """Kill the CALLER's sessions — all three halves.

    The two durable halves live in
    ``revocation_service.revoke_every_session_for_user`` (tombstone the
    live ``sid``s, then stamp the cutoff that stops the next rotation
    minting a fresh one) and are shared with the admin and
    password-reset paths, which need exactly those two and must not
    touch the caller's cookies.

    The third half is clearing the caller's cookies, and it is the one
    that kept getting forgotten. Leaving them behind hands the browser a
    full set of session cookies for a session that no longer exists: the
    SPA keeps believing it is signed in, the login page offers "You're
    already signed in as …", and reloading re-reads the same cookies and
    says it again. Both self-service callers — sign out everywhere, and
    change password — shipped that bug independently.

    ``response`` and ``request`` are REQUIRED rather than optional so a
    third caller cannot repeat it. Revoking somebody else's sessions is a
    different operation and calls
    ``revoke_every_session_for_user`` directly — it must not touch the
    caller's cookies at all.
    """
    from backend.app.services.revocation_service import (
        revoke_every_session_for_user,
    )

    await revoke_every_session_for_user(user_id, session=session, reason=reason)
    clear_session_cookies(response, request)


# ── Admin routes ───────────────────────────────────────────────────────

admin_router = APIRouter()


@admin_router.get("", response_model=list[AdminUserResponse])
async def list_users(
    status_filter: Optional[str] = Query(None, alias="status"),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    users = await user_repo.list_users(session, status=status_filter, limit=limit, offset=offset)
    # One query for the whole page's identities, not one per row.
    linked = await user_identity_repo.list_for_users(
        session, [u.id for u in users],
    )
    return [
        await _admin_response(session, u, identities=linked.get(u.id, []))
        for u in users
    ]


@admin_router.post("/{user_id}/approve", status_code=status.HTTP_200_OK)
async def approve_user(
    user_id: str,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.status != "pending":
        raise HTTPException(status_code=409, detail=f"User is already '{user.status}', not pending")

    # Activate user. Phase 6: no automatic role assignment — approval
    # only marks the account as active; workspace access is granted
    # separately via the workspace-members endpoint. The ``User.role``
    # DTO field falls back to ``workspace_member`` via
    # ``_primary_role`` for display when no rows exist.
    await user_repo.update_user_status(session, user_id, "active")

    # Resolve approval record
    await user_repo.resolve_approval(
        session, user_id, status="approved", approved_by=admin.id,
    )

    # Outbox
    await user_repo.create_outbox_event(
        session,
        event_type="user.approved",
        payload={"user_id": user_id, "approved_by": admin.id},
    )

    logger.info("User %s approved by %s", user_id, admin.id)
    return {"detail": "User approved"}


@admin_router.post("/{user_id}/reject", status_code=status.HTTP_200_OK)
async def reject_user(
    user_id: str,
    body: ApproveRejectRequest = None,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.status != "pending":
        raise HTTPException(status_code=409, detail=f"User is already '{user.status}', not pending")

    reason = body.rejection_reason if body else None

    await user_repo.update_user_status(session, user_id, "suspended")
    await user_repo.resolve_approval(
        session, user_id,
        status="rejected",
        approved_by=admin.id,
        rejection_reason=reason,
    )

    await user_repo.create_outbox_event(
        session,
        event_type="user.rejected",
        payload={"user_id": user_id, "rejected_by": admin.id, "reason": reason},
    )

    logger.info("User %s rejected by %s", user_id, admin.id)
    return {"detail": "User rejected"}


# ── Identity edit ─────────────────────────────────────────────────────

@admin_router.patch("/{user_id}", response_model=AdminUserResponse)
async def update_user_identity(
    user_id: str,
    body: UpdateUserRequest,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Update an admin-editable identity field on a user.

    Email change is a separate re-link flow because it's the SSO
    identity key. Display name defaults to first + last and is stored
    only when somebody has deliberately chosen something else; passing
    an empty string here clears that choice.

    ``avatarId`` on the shared request DTO is deliberately ignored on
    this route — an avatar is the account owner's to pick.

    Fields the user's identity provider asserts are refused here too.
    Being an administrator does not make the write survive: SSO login
    re-applies them, so the edit would silently revert and the admin
    would have no way to tell. Fix it at the provider, or set a display
    name — which is never IdP-owned.
    """
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    owned, _provider_id = user_repo.idp_ownership(user)

    updates: dict[str, str] = {}
    if body.first_name is not None and body.first_name.strip():
        updates["first_name"] = body.first_name.strip()
    if body.last_name is not None and body.last_name.strip():
        updates["last_name"] = body.last_name.strip()
    if body.display_name is not None:
        updates["display_name"] = body.display_name

    refused = sorted(set(updates) & owned)
    if refused:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "idp_managed_field",
                "fields": refused,
                "message": (
                    "This user's identity provider manages those fields and "
                    "re-applies them at every sign-in, so a change here would "
                    "not survive. Update them at the provider, or set a "
                    "display name."
                ),
            },
        )
    if not updates:
        # Nothing to do — return the current state so the client can
        # refresh without a separate GET.
        return await _admin_response(session, user)

    await user_repo.update_identity(session, user_id, **updates)

    await user_repo.create_outbox_event(
        session,
        event_type="user.identity_updated",
        payload={
            "user_id": user_id,
            "updated_fields": list(updates.keys()),
            "updated_by": admin.id,
        },
    )

    logger.info("User %s identity updated by %s: %s", user_id, admin.id, list(updates.keys()))

    refreshed = await user_repo.get_user_by_id(session, user_id)
    return await _admin_response(session, refreshed)


# ── Role change ───────────────────────────────────────────────────────

@admin_router.put("/{user_id}/role", status_code=status.HTTP_200_OK)
async def change_user_role(
    user_id: str,
    body: ChangeRoleRequest,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Prevent changing own role (protect the super admin)
    if user.id == admin.id:
        raise HTTPException(status_code=403, detail="Cannot change your own role")

    # Phase 6: ``replace_roles`` now writes both ``user_roles`` (legacy
    # display) and ``role_bindings`` (canonical claims). The
    # ChangeRoleRequest DTO restricts ``body.role`` to the
    # globally-assignable set, but ``set_global_role`` re-validates so
    # the contract is enforced at the repo boundary too — a defensive
    # 400 covers the case where someone slips a workspace-template
    # role past the DTO via a custom client.
    try:
        await user_repo.replace_roles(
            session, user_id, body.role, granted_by=admin.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Phase 7: kill the target user's live sessions so the new claim
    # (promotion OR demotion) takes effect on the next request, not
    # at the end of the current JWT TTL. Best-effort.
    # Phase 9: ``reason`` lands in the audit ``user.session_revoked``.
    from backend.app.services.revocation_service import revoke_subject_sessions
    revoked = await revoke_subject_sessions(
        "user", user_id, session=session, reason="role_changed",
    )

    await user_repo.create_outbox_event(
        session,
        event_type="user.role_changed",
        payload={
            "user_id": user_id,
            "new_role": body.role,
            "changed_by": admin.id,
            "sessions_revoked": revoked,
        },
    )

    logger.info(
        "User %s role changed to '%s' by %s (sessions killed: %d)",
        user_id, body.role, admin.id, revoked,
    )
    return {"detail": f"Role changed to '{body.role}'"}


# ── Suspend ───────────────────────────────────────────────────────────

@admin_router.post("/{user_id}/suspend", status_code=status.HTTP_200_OK)
async def suspend_user(
    user_id: str,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.id == admin.id:
        raise HTTPException(status_code=403, detail="Cannot suspend yourself")
    if user.status == "suspended":
        raise HTTPException(status_code=409, detail="User is already suspended")

    await user_repo.update_user_status(session, user_id, "suspended")

    # ``validate_session`` re-reads ``status`` per request, so a
    # suspension already bites on the next call. Revoke anyway, for the
    # same reason ``change_role`` does: it stamps the refresh cutoff, so
    # the suspension survives a reactivation without silently handing
    # back every session the account held beforehand, and it leaves the
    # ``sid`` index clean rather than stale.
    from backend.app.services.revocation_service import (
        revoke_every_session_for_user,
    )
    await revoke_every_session_for_user(
        user_id, session=session, reason="user_suspended",
    )

    await user_repo.create_outbox_event(
        session,
        event_type="user.suspended",
        payload={"user_id": user_id, "suspended_by": admin.id},
    )

    logger.info("User %s suspended by %s", user_id, admin.id)
    return {"detail": "User suspended"}


# ── System account (break-glass) ──────────────────────────────────────

@admin_router.post("/{user_id}/system-account", response_model=AdminUserResponse)
async def set_system_account(
    user_id: str,
    body: SetSystemAccountRequest,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Mark or unmark an account as a system account.

    A system account is the SSO-enforcement carve-out: while
    ``allowLocalLogin`` is off it can still sign in with its password
    (break-glass), forced sign-out sweeps skip it, and the
    admin-lockout guard does not count it.

    Unmarking re-runs the one check that marking bypassed: with
    passwords already off, stripping the flag from an active
    super-admin who has no linked SSO identity would strand them — the
    same 409 the config PATCH answers.
    """
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if bool(getattr(user, "is_system_account", False)) == body.is_system_account:
        raise HTTPException(
            status_code=409,
            detail="User is already " + (
                "a system account" if body.is_system_account
                else "not a system account"
            ),
        )

    if not body.is_system_account:
        from backend.app.api.v1.endpoints.admin_sso_config import (
            _super_admin_user_ids,
        )
        from backend.app.db.repositories import app_auth_config_repo
        snap = await app_auth_config_repo.get_snapshot(session)
        if not snap.allow_local_login and user.status == "active":
            admin_ids = await _super_admin_user_ids(session)
            if user.id in admin_ids:
                idents = await user_identity_repo.list_for_user(
                    session, user.id,
                )
                if not idents:
                    raise HTTPException(
                        status_code=409,
                        detail={
                            "error": "would_lock_out_admin",
                            "message": "Passwords are off and this admin has "
                                       "no linked SSO identity — unmarking "
                                       "the system account would lock them "
                                       "out.",
                        },
                    )

    await user_repo.set_system_account(session, user_id, body.is_system_account)
    await user_repo.create_outbox_event(
        session,
        event_type="user.system_account_changed",
        payload={
            "user_id": user_id,
            "is_system_account": body.is_system_account,
            "changed_by": admin.id,
        },
    )
    logger.info(
        "User %s %s as a system account by %s",
        user_id,
        "marked" if body.is_system_account else "unmarked",
        admin.id,
    )
    return await _admin_response(session, user)


# ── Reactivate ────────────────────────────────────────────────────────

@admin_router.post("/{user_id}/reactivate", status_code=status.HTTP_200_OK)
async def reactivate_user(
    user_id: str,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    if user.status == "active":
        raise HTTPException(status_code=409, detail="User is already active")

    await user_repo.update_user_status(session, user_id, "active")

    # Phase 6: reactivation no longer auto-assigns a global role —
    # any previous role_bindings / user_roles rows survived the
    # suspend (we only flipped status), and the legacy display
    # fallback covers the empty case.

    await user_repo.create_outbox_event(
        session,
        event_type="user.reactivated",
        payload={"user_id": user_id, "reactivated_by": admin.id},
    )

    logger.info("User %s reactivated by %s", user_id, admin.id)
    return {"detail": "User reactivated"}


# ── Admin password reset (direct) ────────────────────────────────────

@admin_router.post("/{user_id}/reset-password", status_code=status.HTTP_200_OK)
async def admin_reset_password(
    user_id: str,
    body: AdminResetPasswordRequest,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Admin directly sets a new password for a user."""
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # Giving a password to an SSO-only account is a posture change, not
    # a reset — it removes the disabled-password sentinel that keeps the
    # user on the IdP path, and with it the org's conditional access and
    # MFA. Legitimate when an org is retiring SSO, so it is a switch
    # rather than a refusal; it just has to be asked for.
    converting_sso_only = not is_password_set(user.password_hash)
    if converting_sso_only and not body.allow_sso_only_override:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "error": "sso_only_account",
                "message": (
                    f"{user.email} signs in through an identity provider and "
                    "has no password. Setting one lets them sign in around "
                    "the IdP; pass allowSsoOnlyOverride to do it deliberately."
                ),
            },
        )

    _check_password_strength(body.new_password)
    hashed = hash_password(body.new_password)
    await user_repo.update_password(session, user_id, hashed)

    if converting_sso_only:
        logger.warning(
            "Admin %s gave a password to SSO-only user %s", admin.id, user_id,
        )
        await user_repo.create_outbox_event(
            session,
            event_type="user.local_login_enabled",
            payload={
                "user_id": user_id, "actor": admin.id,
                "reason": "admin_reset_password_override",
            },
        )

    # Same reasoning as the self-service reset: an admin resetting
    # somebody's password is usually responding to a compromise, and a
    # reset that leaves the attacker's session live has not remediated
    # anything. Cookies are deliberately untouched — the caller here is
    # the admin, not the subject.
    from backend.app.services.revocation_service import (
        revoke_every_session_for_user,
    )
    await revoke_every_session_for_user(
        user_id, session=session, reason="password_reset_by_admin",
    )

    await user_repo.create_outbox_event(
        session,
        event_type="user.password_reset_by_admin",
        payload={"user_id": user_id, "reset_by": admin.id},
    )

    logger.info("Password reset for user %s by admin %s", user_id, admin.id)
    return {"detail": "Password has been reset"}


# ── Generate reset token (for admin to share with user) ──────────────

@admin_router.post(
    "/{user_id}/generate-reset-token",
    response_model=ResetTokenResponse,
    status_code=status.HTTP_200_OK,
)
async def generate_reset_token(
    user_id: str,
    admin=Depends(require_admin),
    session: AsyncSession = Depends(get_db_session),
):
    """Generate a reset token that the admin can share with the user."""
    user = await user_repo.get_user_by_id(session, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    # admin_granted: this mint is the audited decision that the account
    # may have a password — redeeming it converts even an SSO-only row.
    raw_token, expires_at = await user_repo.create_reset_token(
        session, user_id, admin_granted=True,
    )

    await user_repo.create_outbox_event(
        session,
        event_type="user.reset_token_generated",
        payload={"user_id": user_id, "generated_by": admin.id},
    )

    logger.info("Reset token generated for user %s by admin %s", user_id, admin.id)
    return ResetTokenResponse(resetToken=raw_token, expiresAt=expires_at)


# ── Invite link ──────────────────────────────────────────────────────

# Phase 11: workspace-template system roles. Stored ``scope_type=
# 'global'`` in the roles table (they bind to any workspace) but
# they are NOT globally meaningful — an invite for one of these
# MUST carry a workspace_id.
_WORKSPACE_TEMPLATE_ROLES = frozenset({
    "workspace_admin", "workspace_member", "workspace_viewer",
})
_GLOBAL_TIER_ROLES = frozenset({"super_admin", "org_admin"})


def _role_is_privileged(perms: list[str]) -> bool:
    """A role is privileged (→ requires an email-bound invite) if it
    grants ``workspace:admin`` or any ``system:*`` permission. Custom
    roles are classified automatically from their permission bundle."""
    return any(p == "workspace:admin" or p.startswith("system:") for p in perms)


async def _enforce_invite_ceiling(
    claims: PermissionClaims,
    body: CreateInviteRequest,
    *,
    resolved_workspace_id: Optional[str],
    role_perms: list[str],
    role_is_privileged: bool,
) -> None:
    """Cap what a NON-platform-admin may hand out with an invite.

    Inviting used to be ``require_admin`` — ``system:admin`` only. That
    is too narrow in practice: a workspace admin is the person who
    actually knows who should join their workspace, and routing every
    such request through a platform owner makes onboarding somebody
    else's chore.

    The rule that keeps that safe is a single sentence: **you cannot
    grant what you do not hold.** Everything below is that sentence,
    checked against the same resolved claims the rest of RBAC uses, so
    an invite can never become a privilege-escalation primitive.
    """
    # Platform owners keep full reach.
    if has_permission(claims, "system:admin"):
        return

    # 1. Privileged roles stay with platform admins. A role carrying
    #    workspace:admin or system:* is how an account becomes able to
    #    grant further access; minting one from a lesser account would
    #    make the ceiling self-defeating.
    if role_is_privileged:
        raise HTTPException(
            status_code=403,
            detail=(
                "This role grants administrative permissions and can only be "
                "invited by a platform administrator."
            ),
        )

    # 2. Groups are GLOBAL (see GroupORM) — membership carries across
    #    every workspace a group is bound into. A workspace admin has no
    #    authority outside their own workspace, and the schema has no
    #    notion of who owns a group, so there is nothing to check
    #    against. Refuse rather than invent an ownership model here.
    if body.group_ids:
        raise HTTPException(
            status_code=403,
            detail=(
                "Groups are organisation-wide, so only a platform administrator "
                "can attach them to an invite."
            ),
        )

    # 3. An invite must land somewhere the caller actually administers.
    if not resolved_workspace_id:
        raise HTTPException(
            status_code=403,
            detail=(
                "Only a platform administrator can create an organisation-wide "
                "invite. Choose a workspace you administer."
            ),
        )
    if not has_permission(claims, "workspace:admin", workspace_id=resolved_workspace_id):
        raise HTTPException(
            status_code=403,
            detail=(
                f"You are not an administrator of workspace "
                f"'{resolved_workspace_id}'."
            ),
        )

    # 4. The ceiling proper: every permission the invited role would
    #    confer must be one the caller already holds in that workspace.
    #    A workspace:admin passes trivially for ordinary workspace roles
    #    — `resolve()` implies every workspace leaf for them — while
    #    anything reaching outside the workspace is refused. One loop,
    #    no new notion of "seniority".
    for perm in role_perms:
        if not has_permission(claims, perm, workspace_id=resolved_workspace_id):
            raise HTTPException(
                status_code=403,
                detail=(
                    f"You cannot invite someone into role '{body.role}': it "
                    f"grants '{perm}', which you do not have."
                ),
            )


@admin_router.post(
    "/invite",
    response_model=InviteTokenResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_invite(
    body: CreateInviteRequest,
    admin=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Generate a signed invite token that lets a new user sign up and
    be auto-activated with the specified role. The frontend constructs
    the full URL from its own origin.

    Phase 15 — who may call this. No longer ``require_admin``
    (``system:admin`` only): a workspace admin may invite into a
    workspace they administer, under the ceiling enforced by
    ``_enforce_invite_ceiling`` — you cannot grant what you do not
    hold. ``requires("workspace:admin", workspace=...)`` cannot express
    it, because that dependency reads the workspace from the URL path
    and an invite's workspace comes from the body.

    Phase 11 — tiered invites:
      * ``role`` omitted → plain activated account.
      * Workspace-tier / custom-workspace roles → require a
        ``workspace_id`` (custom workspace roles fix it to the role's
        own scope).
      * Global-tier / custom-global roles → no workspace.
      * Privileged roles (grant ``workspace:admin`` or any
        ``system:*``) → require a target ``email`` so the link is
        bound to one identity and can't be forwarded to escalate
        another user.
    """
    from backend.app.auth.jwt import create_invite_token
    from backend.app.db.repositories import (
        group_repo, invite_repo, role_repo, workspace_repo,
    )

    if not await feature_flags.is_enabled_self_session(
            "inviteLinksEnabled", default=INVITE_LINKS_FAIL_OPEN):
        raise feature_disabled("inviteLinksEnabled")

    resolved_workspace_id: Optional[str] = None
    resolved_group_ids: list[str] = []

    # Phase 13: validate any attached groups first. Reject unknown
    # or protected groups (the latter exist to defend IdP-mapped
    # collections from accidental admin additions; they can't be
    # invite-targeted either).
    if body.group_ids:
        for gid in body.group_ids:
            grp = await group_repo.get_group_by_id(session, gid)
            if grp is None:
                raise HTTPException(
                    status_code=400, detail=f"Unknown group '{gid}'",
                )
            if getattr(grp, "is_protected", False):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Group '{grp.name}' is protected and cannot be "
                        f"added through invite links."
                    ),
                )
            resolved_group_ids.append(gid)

    # Phase 14: classify the role's privilege up-front so we can apply
    # the right email rule below. ``role_is_privileged`` only true when
    # a role is attached AND it carries workspace:admin or system:*.
    role = None
    role_is_privileged = False
    role_perms: list[str] = []
    if body.role is not None:
        role = await role_repo.get_role(session, body.role)
        if role is None:
            raise HTTPException(
                status_code=400, detail=f"Unknown role '{body.role}'",
            )
        bundles = await role_repo.role_names_with_permissions(session, [body.role])
        role_perms = bundles.get(body.role, [])
        role_is_privileged = _role_is_privileged(role_perms)

    # Email rules, most restrictive first:
    # 1. Privileged role → email always required (override doesn't
    #    apply; this is a per-identity escalation vector).
    if role_is_privileged and not body.email:
        raise HTTPException(
            status_code=400,
            detail=(
                "This role is privileged and must be sent to a specific "
                "email address — a shareable link could be forwarded to "
                "escalate another identity. Provide a target email."
            ),
        )
    # 2. Phase 14: groups → email required UNLESS the admin opts into
    #    a shareable group invite. The override is intentional and
    #    audit-logged; it serves the "everyone on the team click this
    #    to join the Designers group" workflow.
    if (
        resolved_group_ids
        and not body.email
        and not body.allow_shareable_with_groups
    ):
        raise HTTPException(
            status_code=400,
            detail=(
                "Invites that attach groups must be sent to a specific "
                "email address. To create a shareable group invite, "
                "explicitly set ``allowShareableWithGroups: true`` — "
                "the link will be forwardable and reusable, so only "
                "use it for low-stakes groups."
            ),
        )
    # Track whether the override is actually being used so we can
    # emit the distinct audit event below.
    is_shareable_groups_override = bool(
        resolved_group_ids
        and not body.email
        and body.allow_shareable_with_groups
    )

    if role is not None:

        # Scope classification.
        is_workspace_role = (
            body.role in _WORKSPACE_TEMPLATE_ROLES
            or role.scope_type == "workspace"
        )
        if is_workspace_role:
            if role.scope_type == "workspace":
                # Custom workspace role — workspace is fixed to its scope.
                resolved_workspace_id = role.scope_id
                if body.workspace_id and body.workspace_id != role.scope_id:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Role '{body.role}' is scoped to workspace "
                            f"'{role.scope_id}' and cannot be invited into a "
                            f"different workspace."
                        ),
                    )
            else:
                # Workspace template — admin must pick a workspace.
                if not body.workspace_id:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Role '{body.role}' is workspace-scoped; a "
                            f"workspace must be selected for the invite."
                        ),
                    )
                resolved_workspace_id = body.workspace_id

            # Confirm the target workspace exists.
            if not await workspace_repo.get_workspace_orm(session, resolved_workspace_id):
                raise HTTPException(
                    status_code=404,
                    detail=f"Workspace '{resolved_workspace_id}' not found",
                )
            # Bindability guard (mirrors workspace-members POST).
            if not await role_repo.role_is_bindable_in_scope(
                session, role_name=body.role,
                binding_scope_type="workspace",
                binding_scope_id=resolved_workspace_id,
            ):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Role '{body.role}' cannot be bound in workspace "
                        f"'{resolved_workspace_id}'."
                    ),
                )
        else:
            # Global role — reject a stray workspace_id.
            if body.workspace_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Role '{body.role}' is global and cannot be "
                        f"workspace-scoped."
                    ),
                )

    # Authorisation ceiling. Deliberately AFTER the workspace has been
    # resolved: a custom workspace role fixes its own scope, so the
    # workspace we must check the caller against is not necessarily the
    # one they asked for.
    await _enforce_invite_ceiling(
        claims, body,
        resolved_workspace_id=resolved_workspace_id,
        role_perms=role_perms,
        role_is_privileged=role_is_privileged,
    )

    token, expires_at, invite = await _mint_invite(
        session,
        created_by=admin.id,
        role=body.role,
        workspace_id=resolved_workspace_id,
        email=body.email,
        email_domain=body.email_domain,
        group_ids=resolved_group_ids,
        shareable_groups_override=is_shareable_groups_override,
        max_uses=body.max_uses,
        expires_in_hours=body.expires_in_hours,
    )
    resolved_domain = invite.email_domain

    # Phase 14: distinct audit event when the shareable-groups override
    # was used, so an auditor can review who bypassed the email-pin
    # rule for group invites. Regular email-bound or no-groups invites
    # keep the standard event type.
    audit_event_type = (
        "user.invite_created_shareable_with_groups"
        if is_shareable_groups_override
        else "user.invite_created"
    )
    await user_repo.create_outbox_event(
        session,
        event_type=audit_event_type,
        payload={
            "invite_id": invite.id,
            "role": body.role,
            "workspace_id": resolved_workspace_id,
            "email": body.email,
            "email_domain": resolved_domain,
            "group_ids": resolved_group_ids,
            "max_uses": body.max_uses,
            "shareable_groups_override": is_shareable_groups_override,
            "created_by": admin.id,
            "expires_at": expires_at,
        },
    )

    logger.info(
        "Invite %s created by admin %s (role=%s ws=%s groups=%d email_bound=%s "
        "domain=%s max_uses=%s override=%s)",
        invite.id, admin.id, body.role, resolved_workspace_id,
        len(resolved_group_ids), bool(body.email), resolved_domain,
        body.max_uses, is_shareable_groups_override,
    )
    return InviteTokenResponse(
        inviteToken=token,
        role=body.role,
        workspaceId=resolved_workspace_id,
        email=body.email,
        groupIds=resolved_group_ids or None,
        expiresAt=expires_at,
        inviteId=invite.id,
        maxUses=body.max_uses,
        emailDomain=resolved_domain,
    )


# ── Invite management ────────────────────────────────────────────────
#
# An invite used to be a fire-and-forget JWT: once handed out there was no
# way to see it, count it, or stop it. These three endpoints are the other
# half of that — the list an admin can actually act on.


async def _mint_invite(
    session: AsyncSession,
    *,
    created_by: str,
    role: Optional[str],
    workspace_id: Optional[str],
    email: Optional[str],
    email_domain: Optional[str],
    group_ids: list[str],
    shareable_groups_override: bool,
    max_uses: Optional[int],
    expires_in_hours: int,
):
    """Issue one token and its ledger row. Returns (token, expires_at, row).

    Shared by the single and bulk endpoints — a bulk invite is a single
    invite repeated, and two copies of this would drift the first time a
    field is added.
    """
    from backend.app.auth.jwt import create_invite_token
    from backend.app.db.repositories import invite_repo

    # Allocate the id before minting so the token and its ledger row can be
    # created from a SINGLE encode. Minting twice — once for the expiry,
    # again for the jti — would leave the row's expires_at a few
    # microseconds behind the token's exp, and the two would disagree about
    # the instant a link dies.
    invite_id = f"inv_{uuid.uuid4().hex[:12]}"
    token, expires_at = create_invite_token(
        role=role,
        created_by=created_by,
        expires_in_hours=expires_in_hours,
        workspace_id=workspace_id,
        email=email,
        group_ids=group_ids or None,
        jti=invite_id,
        token_version=1,
    )
    # An email pin is strictly narrower than a domain restriction, so a
    # link carrying both is really just pinned. Drop the redundant field
    # rather than storing a constraint that can never bind.
    invite = await invite_repo.create(
        session,
        invite_id=invite_id,
        role=role,
        workspace_id=workspace_id,
        email=email,
        email_domain=None if email else email_domain,
        group_ids=group_ids,
        shareable_groups_override=shareable_groups_override,
        max_uses=max_uses,
        expires_at=expires_at,
        created_by=created_by,
    )
    return token, expires_at, invite


async def _invite_summary(session: AsyncSession, invite) -> InviteSummaryResponse:
    """Project one row into the shape the admin list renders.

    Four endpoints return this now (revoke, extend, regenerate, and the
    list's per-row build), and a projection copied four times is one that
    disagrees with itself the first time a field is added.
    """
    from backend.app.db.repositories import (
        group_repo, invite_repo, workspace_repo,
    )

    counts = await invite_repo.redemption_counts(session, [invite.id])
    gids = invite_repo.group_ids_of(invite)
    gnames = []
    for gid in gids:
        grp = await group_repo.get_group_by_id(session, gid)
        gnames.append(grp.name if grp else gid)
    ws = (
        await workspace_repo.get_workspace_orm(session, invite.workspace_id)
        if invite.workspace_id else None
    )
    return InviteSummaryResponse(
        id=invite.id,
        role=invite.role,
        workspaceId=invite.workspace_id,
        workspaceName=ws.name if ws else None,
        email=invite.email,
        emailDomain=invite.email_domain,
        groupIds=gids,
        groupNames=gnames,
        maxUses=invite.max_uses,
        useCount=invite.use_count,
        redemptionCount=counts.get(invite.id, 0),
        status=invite_repo.status_of(invite),
        createdBy=invite.created_by,
        createdAt=invite.created_at,
        expiresAt=invite.expires_at,
        revokedAt=invite.revoked_at,
        revokedBy=invite.revoked_by,
    )


@admin_router.get("/invites", response_model=list[InviteSummaryResponse])
async def list_invites(
    status_filter: str = Query(
        "active", alias="status",
        pattern="^(active|revoked|expired|exhausted|all)$",
    ),
    limit: int = Query(200, ge=1, le=500),
    admin=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Outstanding invite links, newest first.

    Never returns a token — see ``InviteSummaryResponse``.

    A platform admin sees every link; anyone else sees only the ones
    they created. ``created_by`` is the natural ownership boundary, and
    it means widening who can invite did not also widen who can see
    every outstanding invitation in the organisation.
    """
    from backend.app.db.repositories import (
        group_repo, invite_repo, workspace_repo,
    )

    mine_only = None if has_permission(claims, "system:admin") else admin.id
    rows = await invite_repo.list_for_admin(
        session, created_by=mine_only, status=status_filter, limit=limit,
    )
    counts = await invite_repo.redemption_counts(session, [r.id for r in rows])

    # Resolve workspace + group names once per distinct id rather than per
    # row: a page of invites into the same workspace is the common case.
    ws_names: dict[str, Optional[str]] = {}
    grp_names: dict[str, str] = {}

    summaries: list[InviteSummaryResponse] = []
    for row in rows:
        if row.workspace_id and row.workspace_id not in ws_names:
            ws = await workspace_repo.get_workspace_orm(session, row.workspace_id)
            ws_names[row.workspace_id] = ws.name if ws else None

        gids = invite_repo.group_ids_of(row)
        for gid in gids:
            if gid not in grp_names:
                grp = await group_repo.get_group_by_id(session, gid)
                grp_names[gid] = grp.name if grp else gid

        summaries.append(InviteSummaryResponse(
            id=row.id,
            role=row.role,
            workspaceId=row.workspace_id,
            workspaceName=ws_names.get(row.workspace_id) if row.workspace_id else None,
            email=row.email,
            emailDomain=row.email_domain,
            groupIds=gids,
            groupNames=[grp_names[g] for g in gids],
            maxUses=row.max_uses,
            useCount=row.use_count,
            redemptionCount=counts.get(row.id, 0),
            status=invite_repo.status_of(row),
            createdBy=row.created_by,
            createdAt=row.created_at,
            expiresAt=row.expires_at,
            revokedAt=row.revoked_at,
            revokedBy=row.revoked_by,
        ))
    return summaries


@admin_router.post("/invites/{invite_id}/revoke", response_model=InviteSummaryResponse)
async def revoke_invite(
    invite_id: str,
    admin=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Kill a link now, regardless of its expiry or remaining seats.

    Idempotent: revoking an already-revoked link keeps the original
    timestamp, because the first revocation is the one that happened.

    Deliberately NOT gated on ``inviteLinksEnabled`` — an admin who has
    switched invite links off still needs to clean up what is
    outstanding, and refusing the cleanup would be exactly backwards.
    """
    from backend.app.db.repositories import (
        group_repo, invite_repo, workspace_repo,
    )

    existing = await invite_repo.get(session, invite_id)
    # 404 rather than 403 for someone else's link: a caller who may not
    # act on it should not learn it exists.
    if existing is None or (
        existing.created_by != admin.id
        and not has_permission(claims, "system:admin")
    ):
        raise HTTPException(status_code=404, detail=f"Invite '{invite_id}' not found")

    invite = await invite_repo.revoke(session, invite_id, revoked_by=admin.id)
    if invite is None:
        raise HTTPException(status_code=404, detail=f"Invite '{invite_id}' not found")

    await user_repo.create_outbox_event(
        session,
        event_type="user.invite_revoked",
        payload={
            "invite_id": invite.id,
            "role": invite.role,
            "workspace_id": invite.workspace_id,
            "use_count": invite.use_count,
            "revoked_by": admin.id,
        },
    )
    logger.info(
        "Invite %s revoked by admin %s after %d use(s)",
        invite.id, admin.id, invite.use_count,
    )
    return await _invite_summary(session, invite)


@admin_router.post(
    "/invite/bulk",
    response_model=BulkInviteResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_bulk_invites(
    body: BulkInviteRequest,
    admin=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """One email-pinned link per address, from one set of settings.

    Onboarding a team meant repeating the same form once per person.
    This is that, once — and every link comes out pinned to its
    recipient, so each is separately revocable and each redemption is
    attributable to the person it was meant for. A single shared link
    would be less work and strictly worse: it would tell you only that
    somebody used it.

    Partial success is the norm and is reported per row rather than
    failing the batch: one address already having an account must not
    cost the other nineteen their invitations.

    The email-pin rules that govern single invites are satisfied here by
    construction — every link IS pinned — so a privileged role or an
    attached group needs no extra opt-in.
    """
    from backend.app.db.repositories import (
        group_repo, role_repo, workspace_repo,
    )

    if not await feature_flags.is_enabled_self_session(
            "inviteLinksEnabled", default=INVITE_LINKS_FAIL_OPEN):
        raise feature_disabled("inviteLinksEnabled")

    # Validate the SETTINGS once. They are identical for every row, so
    # re-checking per address would just be the same query N times.
    resolved_group_ids: list[str] = []
    if body.group_ids:
        for gid in body.group_ids:
            grp = await group_repo.get_group_by_id(session, gid)
            if grp is None:
                raise HTTPException(400, detail=f"Unknown group '{gid}'")
            if getattr(grp, "is_protected", False):
                raise HTTPException(
                    400,
                    detail=(
                        f"Group '{grp.name}' is protected and cannot be "
                        f"added through invite links."
                    ),
                )
            resolved_group_ids.append(gid)

    resolved_workspace_id: Optional[str] = None
    role_perms: list[str] = []
    role_is_privileged = False
    if body.role is not None:
        role = await role_repo.get_role(session, body.role)
        if role is None:
            raise HTTPException(400, detail=f"Unknown role '{body.role}'")
        bundles = await role_repo.role_names_with_permissions(session, [body.role])
        role_perms = bundles.get(body.role, [])
        role_is_privileged = _role_is_privileged(role_perms)

        is_workspace_role = (
            body.role in _WORKSPACE_TEMPLATE_ROLES or role.scope_type == "workspace"
        )
        if is_workspace_role:
            if role.scope_type == "workspace":
                resolved_workspace_id = role.scope_id
                if body.workspace_id and body.workspace_id != role.scope_id:
                    raise HTTPException(
                        400,
                        detail=(
                            f"Role '{body.role}' is scoped to workspace "
                            f"'{role.scope_id}' and cannot be invited into a "
                            f"different workspace."
                        ),
                    )
            else:
                if not body.workspace_id:
                    raise HTTPException(
                        400,
                        detail=(
                            f"Role '{body.role}' is workspace-scoped; a "
                            f"workspace must be selected for the invite."
                        ),
                    )
                resolved_workspace_id = body.workspace_id
            if not await workspace_repo.get_workspace_orm(session, resolved_workspace_id):
                raise HTTPException(
                    404, detail=f"Workspace '{resolved_workspace_id}' not found",
                )
            if not await role_repo.role_is_bindable_in_scope(
                session, role_name=body.role,
                binding_scope_type="workspace",
                binding_scope_id=resolved_workspace_id,
            ):
                raise HTTPException(
                    400,
                    detail=(
                        f"Role '{body.role}' cannot be bound in workspace "
                        f"'{resolved_workspace_id}'."
                    ),
                )
        elif body.workspace_id:
            raise HTTPException(
                400,
                detail=(
                    f"Role '{body.role}' is global and cannot be "
                    f"workspace-scoped."
                ),
            )

    await _enforce_invite_ceiling(
        claims, body,
        resolved_workspace_id=resolved_workspace_id,
        role_perms=role_perms,
        role_is_privileged=role_is_privileged,
    )

    results: list[BulkInviteResult] = []
    created = 0
    expires_at = ""
    seen: set[str] = set()

    for raw in body.emails:
        addr = (raw or "").strip().lower()
        if not addr or "@" not in addr or addr.startswith("@") or addr.endswith("@"):
            results.append(BulkInviteResult(
                email=raw, outcome="invalid_email",
                detail="Not a valid email address.",
            ))
            continue
        if addr in seen:
            results.append(BulkInviteResult(
                email=addr, outcome="duplicate",
                detail="Listed more than once.",
            ))
            continue
        seen.add(addr)

        # Someone with an account does not need an invitation, and minting
        # one would produce a link that can never be redeemed — the signup
        # path refuses a taken address.
        if await user_repo.get_user_by_email(session, addr) is not None:
            results.append(BulkInviteResult(
                email=addr, outcome="already_a_user",
                detail="Already has an account.",
            ))
            continue

        try:
            token, expires_at, invite = await _mint_invite(
                session,
                created_by=admin.id,
                role=body.role,
                workspace_id=resolved_workspace_id,
                email=addr,
                email_domain=None,
                group_ids=resolved_group_ids,
                shareable_groups_override=False,
                max_uses=body.max_uses,
                expires_in_hours=body.expires_in_hours,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("Bulk invite failed for %s: %s", addr, exc)
            results.append(BulkInviteResult(
                email=addr, outcome="failed",
                detail="Could not create a link for this address.",
            ))
            continue

        created += 1
        results.append(BulkInviteResult(
            email=addr, outcome="created",
            inviteToken=token, inviteId=invite.id,
        ))

    await user_repo.create_outbox_event(
        session,
        event_type="user.invites_created_bulk",
        payload={
            "created": created,
            "requested": len(body.emails),
            "role": body.role,
            "workspace_id": resolved_workspace_id,
            "group_ids": resolved_group_ids,
            "created_by": admin.id,
        },
    )
    logger.info(
        "Bulk invite by %s: %d created of %d requested (role=%s ws=%s)",
        admin.id, created, len(body.emails), body.role, resolved_workspace_id,
    )
    return BulkInviteResponse(
        created=created,
        skipped=len(results) - created,
        results=results,
        expiresAt=expires_at or invite_expiry(body.expires_in_hours),
    )


async def _load_own_invite(session, invite_id: str, admin, claims):
    """Fetch a link the caller is allowed to act on, else 404.

    404 rather than 403 for someone else's link: a caller who may not
    act on it should not learn that it exists.
    """
    from backend.app.db.repositories import invite_repo

    invite = await invite_repo.get(session, invite_id)
    if invite is None or (
        invite.created_by != admin.id
        and not has_permission(claims, "system:admin")
    ):
        raise HTTPException(status_code=404, detail=f"Invite '{invite_id}' not found")
    return invite


@admin_router.post("/invites/{invite_id}/extend", response_model=InviteSummaryResponse)
async def extend_invite(
    invite_id: str,
    body: ExtendInviteRequest,
    admin=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Give a link more time, and optionally more seats.

    The URL already shared keeps working — that is the point. Before
    this, a link nearing expiry meant minting a replacement, which split
    one invitation across two rows and left the redemption history on
    the dead one.
    """
    from backend.app.db.repositories import invite_repo

    await _load_own_invite(session, invite_id, admin, claims)

    expires_at = invite_expiry(body.expires_in_hours)
    invite = await invite_repo.extend(
        session, invite_id,
        expires_at=expires_at,
        additional_uses=body.additional_uses,
    )
    if invite is None:
        # Revoked. Extending would quietly undo a decision somebody made.
        raise HTTPException(
            status_code=409,
            detail="This link was revoked and cannot be extended. Create a new one.",
        )

    await user_repo.create_outbox_event(
        session,
        event_type="user.invite_extended",
        payload={
            "invite_id": invite.id, "expires_at": expires_at,
            "additional_uses": body.additional_uses,
            "extended_by": admin.id,
        },
    )
    logger.info(
        "Invite %s extended by %s to %s (+%s seats)",
        invite.id, admin.id, expires_at, body.additional_uses,
    )
    return await _invite_summary(session, invite)


@admin_router.post(
    "/invites/{invite_id}/regenerate", response_model=InviteTokenResponse,
)
async def regenerate_invite(
    invite_id: str,
    body: ExtendInviteRequest,
    admin=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Issue a fresh URL for the same invitation.

    Every URL already handed out stops working — that is what separates
    this from ``extend``. Use it when the link has been lost, or has gone
    somewhere it shouldn't but the invitation itself is still wanted.
    The role, scope, groups, seat cap and redemption history all stay on
    the one row, so the invitation keeps a single audit trail across the
    rotation instead of fragmenting into a new one.
    """
    from backend.app.auth.jwt import create_invite_token
    from backend.app.db.repositories import invite_repo

    await _load_own_invite(session, invite_id, admin, claims)

    expires_at = invite_expiry(body.expires_in_hours)
    invite = await invite_repo.regenerate(session, invite_id, expires_at=expires_at)
    if invite is None:
        raise HTTPException(
            status_code=409,
            detail="This link was revoked and cannot be regenerated. Create a new one.",
        )

    token, expires_at = create_invite_token(
        role=invite.role,
        created_by=invite.created_by,
        expires_in_hours=body.expires_in_hours,
        workspace_id=invite.workspace_id,
        email=invite.email,
        group_ids=invite_repo.group_ids_of(invite) or None,
        jti=invite.id,
        token_version=invite.token_version,
    )
    invite.expires_at = expires_at
    await session.flush()

    await user_repo.create_outbox_event(
        session,
        event_type="user.invite_regenerated",
        payload={
            "invite_id": invite.id,
            "token_version": invite.token_version,
            "regenerated_by": admin.id,
        },
    )
    logger.info(
        "Invite %s regenerated by %s (now version %s) — previous URLs are dead",
        invite.id, admin.id, invite.token_version,
    )
    return InviteTokenResponse(
        inviteToken=token,
        role=invite.role,
        workspaceId=invite.workspace_id,
        email=invite.email,
        groupIds=invite_repo.group_ids_of(invite) or None,
        expiresAt=expires_at,
        inviteId=invite.id,
        maxUses=invite.max_uses,
        emailDomain=invite.email_domain,
    )


@admin_router.get(
    "/invites/{invite_id}/redemptions",
    response_model=list[InviteRedemptionResponse],
)
async def list_invite_redemptions(
    invite_id: str,
    admin=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Who signed up through this link, most recent first."""
    from backend.app.db.repositories import invite_repo

    existing = await invite_repo.get(session, invite_id)
    if existing is None or (
        existing.created_by != admin.id
        and not has_permission(claims, "system:admin")
    ):
        raise HTTPException(status_code=404, detail=f"Invite '{invite_id}' not found")

    rows = await invite_repo.list_redemptions(session, invite_id)
    return [
        InviteRedemptionResponse(
            id=r.id, userId=r.user_id, email=r.email, redeemedAt=r.redeemed_at,
        )
        for r in rows
    ]


# ── Admin-created accounts ────────────────────────────────────────────
#
# The other way in. An invite is the user provisioning themselves from a
# link you handed them; this provisions them directly, which is what you
# need when there is nobody to hand a link TO yet — somebody starting on
# Monday, an account migrated from another tool, a shared operations
# login. ``signup_source`` has carried 'admin_created' since Phase 4;
# this is the endpoint that finally sets it.

_CREDENTIAL_MODES = frozenset({"setup_link", "password", "sso_only"})

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _derive_names(email: str) -> tuple[str, str]:
    """A usable name from an address, for the bulk path.

    A column of addresses is the usual source and rarely carries names.
    "a.hopper@x.com" → ("A", "Hopper") beats an empty string, which the
    schema forbids anyway, and beats the raw address, which looks like a
    bug in every list that renders a name.
    """
    local = email.split("@", 1)[0]
    parts = [p for p in re.split(r"[._\-+]+", local) if p]
    if len(parts) >= 2:
        return parts[0].capitalize(), " ".join(p.capitalize() for p in parts[1:])
    return (parts[0].capitalize() if parts else email), ""


async def _resolve_grant(
    session: AsyncSession,
    claims: PermissionClaims,
    body,
) -> tuple[Optional[str], list[str], bool]:
    """Validate the role/workspace the new accounts will receive.

    Deliberately the same checks the invite path runs, via the same
    helpers — an account created here and an account created by
    redeeming an invite are the same account, so a rule that binds one
    must bind the other or the stricter path is merely the slower one.

    Returns ``(resolved_workspace_id, role_perms, is_privileged)``.
    """
    from backend.app.db.repositories import role_repo, workspace_repo

    if not body.role:
        # No role: nothing to resolve, and nothing to escalate. Still
        # subject to the group rule below via the ceiling.
        await _enforce_invite_ceiling(
            claims, body, resolved_workspace_id=None,
            role_perms=[], role_is_privileged=False,
        )
        return None, [], False

    role = await role_repo.get_role(session, body.role)
    if role is None:
        raise HTTPException(status_code=400, detail=f"Unknown role '{body.role}'")

    bundles = await role_repo.role_names_with_permissions(session, [body.role])
    perms = bundles.get(body.role, [])
    privileged = _role_is_privileged(perms)

    needs_ws = (
        body.role in _WORKSPACE_TEMPLATE_ROLES
        or getattr(role, "scope_type", None) == "workspace"
    )
    fixed_ws = getattr(role, "scope_id", None) if getattr(role, "scope_type", None) == "workspace" else None
    resolved_ws = fixed_ws or body.workspace_id

    if needs_ws and not resolved_ws:
        raise HTTPException(
            status_code=400,
            detail=f"Role '{body.role}' is workspace-scoped and needs a workspace.",
        )
    if resolved_ws:
        ws = await workspace_repo.get_workspace(session, resolved_ws)
        if ws is None:
            raise HTTPException(status_code=400, detail="Unknown workspace")

    await _enforce_invite_ceiling(
        claims, body, resolved_workspace_id=resolved_ws,
        role_perms=perms, role_is_privileged=privileged,
    )
    return resolved_ws, perms, privileged


async def _provision_user(
    session: AsyncSession,
    *,
    email: str,
    first_name: str,
    last_name: str,
    role: Optional[str],
    workspace_id: Optional[str],
    group_ids: Optional[list[str]],
    credential: str,
    password: Optional[str],
    activate: bool,
    actor_id: str,
) -> tuple[str, Optional[str], Optional[str], list[str]]:
    """Create one account and apply its grants.

    Returns ``(user_id, setup_token, setup_expires_at, attached_groups)``.
    Raises ValueError for "this address is already taken", which the
    callers turn into a 409 or a per-row outcome respectively.
    """
    from backend.app.db.repositories import group_repo
    from backend.auth_service.core.password import disabled_password_hash
    from backend.app.api.v1.endpoints.auth import _grant_invite_role

    normalised = email.strip().lower()
    existing = await user_repo.get_user_by_email(session, normalised)
    if existing is not None:
        raise ValueError("already_a_user")

    # A password the admin typed is the only one that gets hashed. The
    # other two modes leave no usable local password at all: the setup
    # link mode expects the user to set their own, and sso_only expects
    # the IdP to vouch for them. Both use the sentinel rather than a
    # random string, so `has_usable_password` can tell the difference.
    if credential == "password":
        if not password:
            raise HTTPException(status_code=400, detail="A password is required.")
        _check_password_strength(password)
        pw_hash = hash_password(password)
    else:
        pw_hash = disabled_password_hash()

    user = await user_repo.create_user(
        session,
        email=normalised,
        password_hash=pw_hash,
        first_name=first_name,
        last_name=last_name,
        status="active" if activate else "pending",
        signup_source="admin_created",
    )

    if role:
        await _grant_invite_role(
            session, user.id, role, workspace_id, granted_by=actor_id,
        )

    attached: list[str] = []
    for gid in (group_ids or []):
        try:
            await group_repo.add_member(session, gid, user.id, added_by=actor_id)
            attached.append(gid)
        except Exception:  # noqa: BLE001 — one bad group must not lose the account
            logger.warning("Could not attach group %s to new user %s", gid, user.id)

    setup_token: Optional[str] = None
    setup_expires: Optional[str] = None
    if credential == "setup_link":
        # admin_granted: the setup link is how an admin-created account
        # gets its first password, including one created without any.
        setup_token, setup_expires = await user_repo.create_reset_token(
            session, user.id, admin_granted=True,
        )

    await user_repo.create_outbox_event(
        session,
        event_type="user.created_by_admin",
        payload={
            "user_id": user.id,
            "created_by": actor_id,
            "role": role,
            "workspace_id": workspace_id,
            "group_ids": attached,
            "credential": credential,
            "activated": activate,
        },
    )
    return user.id, setup_token, setup_expires, attached


@admin_router.post(
    "",
    response_model=AdminCreateUserResponse,
    status_code=status.HTTP_201_CREATED,
)
async def admin_create_user(
    body: AdminCreateUserRequest,
    admin=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Create one account directly, with the role and groups it needs.

    Not gated on ``inviteLinksEnabled``: that flag governs *links*, and
    an admin typing an account out by hand is not a link. Turning links
    off in order to close the self-service door should not also take
    away the ability to add somebody deliberately.

    Who may call it follows the invite rule exactly — see
    ``_enforce_invite_ceiling``. You cannot grant what you do not hold,
    whichever door the account comes through.
    """
    if body.credential not in _CREDENTIAL_MODES:
        raise HTTPException(status_code=400, detail="Unknown credential mode")
    if not _EMAIL_RE.match(body.email.strip()):
        raise HTTPException(status_code=400, detail="That is not a valid email address")

    resolved_ws, _perms, _priv = await _resolve_grant(session, claims, body)

    try:
        user_id, token, expires, groups = await _provision_user(
            session,
            email=body.email,
            first_name=body.first_name,
            last_name=body.last_name,
            role=body.role,
            workspace_id=resolved_ws,
            group_ids=body.group_ids,
            credential=body.credential,
            password=body.password,
            activate=body.activate,
            actor_id=admin.id,
        )
    except ValueError:
        # Not enumeration-sensitive: the caller is already an authenticated
        # admin who can list every user on the next screen.
        raise HTTPException(
            status_code=409,
            detail="An account with that email already exists.",
        )

    logger.info("User %s created by admin %s", user_id, admin.id)
    return AdminCreateUserResponse(
        id=user_id,
        email=body.email.strip().lower(),
        first_name=body.first_name,
        last_name=body.last_name,
        status="active" if body.activate else "pending",
        role=body.role,
        workspace_id=resolved_ws,
        group_ids=groups,
        setup_token=token,
        setup_expires_at=expires,
    )


@admin_router.post(
    "/bulk",
    response_model=BulkCreateUsersResponse,
    status_code=status.HTTP_201_CREATED,
)
async def admin_create_users_bulk(
    body: BulkCreateUsersRequest,
    admin=Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Create several accounts from one set of settings.

    Partial success is the point: one address that already has an
    account must not cost the other nineteen their onboarding. Every row
    reports its own outcome, and the grant rules are resolved once for
    the whole batch rather than per row — they are identical by
    construction, and re-resolving would only invite drift.
    """
    if body.credential not in _CREDENTIAL_MODES:
        raise HTTPException(status_code=400, detail="Unknown credential mode")
    if body.credential == "password":
        raise HTTPException(
            status_code=400,
            detail=(
                "A shared password across a batch is not a credential. "
                "Use a setup link, or SSO."
            ),
        )

    resolved_ws, _perms, _priv = await _resolve_grant(session, claims, body)

    results: list[BulkCreateUserResult] = []
    seen: set[str] = set()
    created = 0

    for row in body.users:
        email = row.email.strip().lower()
        if not _EMAIL_RE.match(email):
            results.append(BulkCreateUserResult(
                email=row.email, outcome="invalid_email",
                detail="Not a valid email address",
            ))
            continue
        if email in seen:
            results.append(BulkCreateUserResult(
                email=email, outcome="duplicate",
                detail="Listed more than once",
            ))
            continue
        seen.add(email)

        first = (row.first_name or "").strip()
        last = (row.last_name or "").strip()
        if not first:
            first, derived_last = _derive_names(email)
            last = last or derived_last

        try:
            user_id, token, _expires, _groups = await _provision_user(
                session,
                email=email,
                first_name=first,
                last_name=last,
                role=body.role,
                workspace_id=resolved_ws,
                group_ids=body.group_ids,
                credential=body.credential,
                password=None,
                activate=body.activate,
                actor_id=admin.id,
            )
        except ValueError:
            results.append(BulkCreateUserResult(
                email=email, outcome="already_a_user",
                detail="Already has an account",
            ))
            continue
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001 — one row must not lose the batch
            logger.warning("Bulk create failed for %s: %s", email, exc)
            results.append(BulkCreateUserResult(
                email=email, outcome="failed", detail="Could not be created",
            ))
            continue

        created += 1
        results.append(BulkCreateUserResult(
            email=email, outcome="created", user_id=user_id, setup_token=token,
        ))

    logger.info(
        "Bulk user creation by admin %s: %d created, %d skipped",
        admin.id, created, len(results) - created,
    )
    return BulkCreateUsersResponse(
        created=created,
        skipped=len(results) - created,
        results=results,
    )
