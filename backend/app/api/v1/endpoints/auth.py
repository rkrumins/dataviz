"""
Public authentication endpoints — the no-cookie subset: signup,
forgot-password, reset-password, verify-invite.

The cookie-issuing endpoints (/login, /logout, /refresh, /me) live in
``backend.auth_service.api.router`` and are mounted alongside this
router under /api/v1/auth/. They will follow into the extracted auth
service in a later move; the flows here remain because they don't yet
have a clean home in the new module.

POST /api/v1/auth/signup            → 201 + message
POST /api/v1/auth/forgot-password   → 200 + message (always succeeds)
POST /api/v1/auth/reset-password    → 200 + message
GET  /api/v1/auth/verify-invite     → 200 + InviteVerifyResponse
"""
import logging
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from slowapi import Limiter
from slowapi.util import get_remote_address
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.password import hash_password
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import user_repo
from backend.common.roles import INVITE_GLOBAL_TIER
from backend.common.models.auth import (
    SignUpRequest,
    SignUpResponse,
    UserPublicResponse,
    ForgotPasswordRequest,
    ResetPasswordRequest,
    InviteVerifyResponse,
)
from backend.app.api.v1.feature_gate import feature_disabled
from backend.app.services.feature_flags import feature_flags

logger = logging.getLogger(__name__)

router = APIRouter()

limiter = Limiter(key_func=get_remote_address)

#: What to assume about ``inviteLinksEnabled`` when the flag cannot be read.
#:
#: TRUE, and deliberately the opposite of ``signupEnabled``'s ``default=False``
#: a few lines down in ``signup``. That flag fails closed because an unreadable
#: value must not let anonymous strangers in. This one governs people who
#: already hold a signed, expiring, use-capped, revocable credential an admin
#: issued on purpose — so failing closed would black out the only entrance an
#: invite-only deployment has, in order to defend against someone who was
#: already invited. The costs are not symmetric in the same direction here.
INVITE_LINKS_FAIL_OPEN = True

#: Why a link was refused, in words the recipient can act on. "Invalid or
#: expired" covered four different situations and only one of them means
#: "ask for a new link" — the others mean "ask the person who sent it".
_INVITE_REFUSALS = {
    "expired": "This invite link has expired. Ask your administrator for a new one.",
    "revoked": "This invite link has been revoked. Ask your administrator for a new one.",
    "exhausted": (
        "This invite link has already been used the maximum number of times. "
        "Ask your administrator for a new one."
    ),
    "superseded": (
        "This invite link has been replaced by a newer one. Ask whoever "
        "sent it for the current link."
    ),
    "invalid": "Invite link is invalid or has expired.",
    "email_mismatch": "This invite is for a different email address.",
    "domain_mismatch": "This invite link only accepts email addresses from a specific domain.",
}


# ── helpers ────────────────────────────────────────────────────────────

def _check_password_strength(password: str) -> None:
    """
    Server-side password strength check using zxcvbn.
    Rejects passwords with score < 3.
    """
    try:
        from zxcvbn import zxcvbn
        result = zxcvbn(password)
        if result["score"] < 3:
            feedback = result.get("feedback", {})
            suggestions = feedback.get("suggestions", [])
            warning = feedback.get("warning", "")
            msg = "Password is too weak."
            if warning:
                msg += f" {warning}."
            if suggestions:
                msg += " " + " ".join(suggestions)
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=msg,
            )
    except ImportError:
        # zxcvbn not installed — fall back to length-only check
        if len(password) < 8:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Password must be at least 8 characters.",
            )


async def _build_user_response(session: AsyncSession, user) -> UserPublicResponse:
    roles = await user_repo.get_user_roles(session, user.id)
    role = roles[0] if roles else "user"
    return UserPublicResponse(
        id=user.id,
        email=user.email,
        firstName=user.first_name,
        lastName=user.last_name,
        displayName=f"{user.first_name} {user.last_name}",
        status=user.status,
        role=role,
        createdAt=user.created_at,
    )


# Phase 11: workspace-template system roles are bound at workspace
# scope on invite; super_admin/org_admin go through set_global_role
# (which also writes the legacy user_roles display row). Canonical
# set lives in ``backend.common.roles.INVITE_GLOBAL_TIER`` — local
# alias kept so the existing module-internal name keeps working.
_INVITE_GLOBAL_TIER = INVITE_GLOBAL_TIER


class ResolvedInvite:
    """What an invite grants, plus whether it may still be used.

    ``reason`` is None when the invite is usable; otherwise it names the
    specific refusal so the signup page can say something actionable.
    "Invalid or expired" used to cover four different situations and
    only one of them means "ask for a new link".
    """

    __slots__ = (
        "valid", "reason", "invite_id", "role", "workspace_id",
        "email", "email_domain", "group_ids", "created_by",
        "seats_remaining", "expires_at",
    )

    def __init__(
        self, *, valid: bool, reason: Optional[str] = None,
        invite_id: Optional[str] = None, role: Optional[str] = None,
        workspace_id: Optional[str] = None, email: Optional[str] = None,
        email_domain: Optional[str] = None,
        group_ids: Optional[list[str]] = None,
        created_by: Optional[str] = None,
        seats_remaining: Optional[int] = None,
        expires_at: Optional[str] = None,
    ):
        self.valid = valid
        self.reason = reason
        self.invite_id = invite_id
        self.role = role
        self.workspace_id = workspace_id
        self.email = email
        self.email_domain = email_domain
        self.group_ids = group_ids or []
        self.created_by = created_by
        self.seats_remaining = seats_remaining
        self.expires_at = expires_at


async def resolve_invite(session, token: str) -> ResolvedInvite:
    """Validate a token and return what it grants.

    Two eras of token meet here.

    A token carrying a ``jti`` is backed by a row in ``invites``, and
    THAT ROW is authoritative: the payload is only a cached copy of what
    was true at mint time. Reading the grant from the row is what makes
    revocation and seat caps real — otherwise a cryptographically valid
    token would keep asserting a role after an admin had revoked it.

    A token without a ``jti`` predates the ledger. There is no row to
    consult, so it keeps its original self-contained behaviour: no
    revocation, no cap. This path retires itself — invite lifetimes are
    capped at 90 days — and is logged so operators can see when it stops
    being hit and delete it.
    """
    import jwt as pyjwt
    from backend.app.auth.jwt import decode_invite_token
    from backend.app.db.repositories import invite_repo

    try:
        payload = decode_invite_token(token)
    except pyjwt.ExpiredSignatureError:
        return ResolvedInvite(valid=False, reason="expired")
    except pyjwt.InvalidTokenError:
        return ResolvedInvite(valid=False, reason="invalid")

    raw_groups = payload.get("group_ids") or []
    payload_groups = (
        [g for g in raw_groups if isinstance(g, str)]
        if isinstance(raw_groups, list) else []
    )
    jti = payload.get("jti")

    if jti is None:
        logger.info(
            "Legacy jti-less invite presented (created_by=%s) — no ledger row "
            "to enforce revocation or seat caps against.",
            payload.get("created_by"),
        )
        return ResolvedInvite(
            valid=True,
            role=payload.get("role"),
            workspace_id=payload.get("workspace_id"),
            email=payload.get("email"),
            group_ids=payload_groups,
            created_by=payload.get("created_by"),
        )

    invite = await invite_repo.get(session, jti)
    if invite is None:
        # Signed by us, but no row: the ledger was cleared, or the token
        # was minted against a different database.
        return ResolvedInvite(valid=False, reason="invalid")

    # A URL from before the link was regenerated. The row is alive and
    # may even be in active use — this particular URL is not, and saying
    # "invalid" would send the holder chasing the wrong problem.
    # Missing ``tv`` means the token predates rotation, so it reads as
    # generation 1 and keeps working.
    if int(payload.get("tv") or 1) != int(invite.token_version or 1):
        return ResolvedInvite(
            valid=False, reason="superseded", invite_id=invite.id,
        )

    status_now = invite_repo.status_of(invite)
    if status_now != "active":
        return ResolvedInvite(valid=False, reason=status_now, invite_id=invite.id)

    return ResolvedInvite(
        valid=True,
        invite_id=invite.id,
        role=invite.role,
        workspace_id=invite.workspace_id,
        email=invite.email,
        email_domain=invite.email_domain,
        group_ids=invite_repo.group_ids_of(invite),
        created_by=invite.created_by,
        seats_remaining=(
            None if invite.max_uses is None
            else max(0, invite.max_uses - invite.use_count)
        ),
        expires_at=invite.expires_at,
    )


def _email_matches_invite(resolved: ResolvedInvite, email: str) -> Optional[str]:
    """None if *email* may use this invite, else the refusal reason."""
    candidate = email.strip().lower()
    if resolved.email and resolved.email.strip().lower() != candidate:
        return "email_mismatch"
    if resolved.email_domain:
        domain = candidate.rpartition("@")[2]
        if domain != resolved.email_domain.strip().lower():
            return "domain_mismatch"
    return None


async def _try_auto_sign_in(
    request: Request,
    response: Response,
    session: AsyncSession,
    *,
    email: str,
    password: str,
    user_id: str,
) -> bool:
    """Issue session cookies for a just-invited user. Best-effort.

    Two things here are load-bearing and easy to get wrong.

    FIRST, the commit. ``LocalIdentityService.login`` opens its OWN
    session, while ``get_db_session`` commits only when the request
    scope exits — after this handler returns. Without an explicit commit
    the login would run against a connection that cannot see the user we
    just created, and it would fail in PRODUCTION while passing in
    tests, because the test fixture wires the identity service to the
    same session. A green suite would have shipped a broken flow.

    SECOND, why ``login`` rather than a "mint a session for this user
    id" helper. Adding that helper to the IdentityService protocol means
    adding a way to obtain a session without presenting credentials —
    a permanent footgun for one call site. Paying one Argon2id verify,
    once, at account creation, buys the claims resolver, the outbox
    event and the refresh-token family setup identically to a real
    login, with no new privileged primitive.

    Failure is never fatal: the account exists and is active either way,
    so the caller falls back to "you can now sign in". A deployment with
    local login disabled (SSO-only) lands here by design — silently
    minting a local session there would subvert the whole posture.
    """
    from backend.auth_service.cookies import set_session_cookies

    await session.commit()

    try:
        svc = getattr(request.app.state, "identity_service", None)
        if svc is None:
            return False
        _user, tokens = await svc.login(email, password)
        set_session_cookies(response, tokens)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.info(
            "Invited signup created %s but auto sign-in was unavailable: %s",
            user_id, exc,
        )
        return False


async def _grant_invite_role(
    session,
    *,
    user_id: str,
    role: str,
    workspace_id: Optional[str],
    granted_by: Optional[str],
) -> None:
    """Apply the invite's role to a freshly-created user.

    Global tiers (super_admin / org_admin) go through
    ``set_global_role`` so the legacy display badge stays correct.
    Everything else — workspace templates and custom roles — is a
    plain ``role_binding`` at the right scope.

    Re-validates bindability at signup time: the role could have
    been deleted or rescoped since the invite was minted. If it's
    no longer bindable we activate the user anyway (the invite is
    still valid) and log — we never 500 the signup over a stale
    role reference.
    """
    from backend.app.db.repositories import role_repo, binding_repo

    if role in _INVITE_GLOBAL_TIER:
        try:
            await user_repo.set_global_role(
                session, user_id, role, granted_by=granted_by,
            )
        except ValueError as exc:
            logger.warning(
                "Invite global role %s no longer assignable for %s: %s",
                role, user_id, exc,
            )
        return

    scope_type = "workspace" if workspace_id else "global"
    bindable = await role_repo.role_is_bindable_in_scope(
        session, role_name=role,
        binding_scope_type=scope_type, binding_scope_id=workspace_id,
    )
    if not bindable:
        logger.warning(
            "Invite role %s no longer bindable in scope %s/%s for %s; "
            "activating without a binding.",
            role, scope_type, workspace_id, user_id,
        )
        return

    await binding_repo.create_binding(
        session,
        subject_type="user",
        subject_id=user_id,
        role_name=role,
        scope_type=scope_type,
        scope_id=workspace_id,
        granted_by=granted_by,
    )


# ── POST /auth/signup ─────────────────────────────────────────────────

@router.post("/signup", response_model=SignUpResponse, status_code=status.HTTP_201_CREATED)
# 5/minute is keyed on the CLIENT IP, which is the wrong unit for an invite: a
# team redeeming one shareable link from a single office NAT would 429 on the
# sixth person, and "the link stopped working" is indistinguishable from a bug.
# The invite ledger (max_uses / expires_at / revoked_at) is the real control on
# the invited path; this limit only blunts automated abuse of open registration.
@limiter.limit("20/minute")
async def signup(
    request: Request,
    response: Response,
    body: SignUpRequest,
    session: AsyncSession = Depends(get_db_session),
):
    from backend.app.db.repositories import invite_repo

    # 1. Password strength
    _check_password_strength(body.password)

    # 2. Validate invite token (if provided). Phase 11: a valid
    # invite auto-activates the account and grants the token's role —
    # global tiers, workspace tiers, AND custom roles. Phase 15: what it
    # grants now comes from the ``invites`` row rather than the payload,
    # so revocation and seat caps actually bite.
    invite_valid = False
    invite_role = None
    invite_admin = None
    invite_workspace_id = None
    invite_email = None
    invite_group_ids: list[str] = []
    invite_id = None
    if body.invite_token:
        # Kill switch, checked before the signature — see verify_invite. An
        # admin who switches invite links off has to be able to stop the ones
        # already out there, not just prevent new ones.
        if not await feature_flags.is_enabled_self_session(
                "inviteLinksEnabled", default=INVITE_LINKS_FAIL_OPEN):
            logger.info("signup blocked: invite links are disabled")
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invite links are turned off for this deployment.",
            )

        resolved = await resolve_invite(session, body.invite_token)
        if not resolved.valid:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=_INVITE_REFUSALS.get(
                    resolved.reason, "Invite link is invalid or has expired.",
                ),
            )
        invite_valid = True
        invite_id = resolved.invite_id
        invite_role = resolved.role  # may be None (plain invite)
        invite_admin = resolved.created_by
        invite_workspace_id = resolved.workspace_id
        invite_email = resolved.email
        invite_group_ids = resolved.group_ids

    # 2a. SELF-REGISTRATION GATE.
    #
    # `signupEnabled` promised the admin that strangers could not create accounts, and enforced
    # nothing: with the flag OFF, an anonymous POST here still returned 201 and still wrote a
    # `pending` user row. The switch was decorative, which is worse than absent — an absent
    # control is at least honest about what it does not do.
    #
    # The gate goes HERE, after the invite has been validated, because "self-registration is
    # off" must never mean "invitations stop working": disabling the open door is precisely the
    # moment invites become the ONLY way in, and closing that too would lock an admin out of
    # their own onboarding.
    #
    # default=False, deliberately. Every other flag in this codebase fails OPEN so a database
    # hiccup cannot black out a product area. This one is a security control, and the costs are
    # not symmetric: failing open lets strangers in, failing closed inconveniences an invite.
    # When we cannot read the flag, we assume the admin meant to keep the door shut.
    if not invite_valid and not await feature_flags.is_enabled_self_session(
            "signupEnabled", default=False):
        logger.info("signup blocked: self-registration is disabled and no valid invite was given")
        raise feature_disabled("signupEnabled")

    # 2b. Email pin (Phase 11) / domain restriction (Phase 15): an
    # email-bound invite can only be accepted by the pinned address, and a
    # domain-restricted one only by that domain. Checked BEFORE the
    # enumeration-safe uniqueness short-circuit so a mismatch is a clear
    # 400 rather than a silent no-op.
    if invite_valid:
        mismatch = _email_matches_invite(resolved, body.email)
        if mismatch:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=_INVITE_REFUSALS[mismatch],
            )

    # 3. Check email uniqueness — return the same 201 response regardless
    # to prevent email enumeration attacks.
    #
    # ACCEPTED WEAKENING (Phase 15): auto sign-in makes this short-circuit
    # distinguishable, because the created path also carries Set-Cookie
    # while this one does not. So an invite holder can probe whether an
    # address already exists. Accepted deliberately rather than
    # overlooked: the oracle requires possession of a valid, unexpired
    # invite, every probe is bounded by that invite's ``max_uses``, and
    # the ledger records who was holding it. The alternative — suppressing
    # auto sign-in whenever the address exists — only muddies the tell
    # ("exists OR auto sign-in unavailable") while making the ordinary
    # path inconsistent for everyone.
    existing = await user_repo.get_user_by_email(session, body.email)
    if existing is not None:
        logger.debug("Signup attempt with existing email (suppressed)")
        msg = "Account created and activated." if invite_valid else "Account created. Awaiting administrator approval."
        return SignUpResponse(message=msg)

    # 3a. Claim a seat, atomically. This must happen AFTER the uniqueness
    # check — otherwise repeatedly submitting an existing address would
    # burn through a link's seats without ever creating an account — and
    # BEFORE the user row, so that a link which has just run out cannot
    # produce a half-admitted user. If anything below throws, the
    # transaction rolls back and the seat is returned.
    if invite_valid and invite_id is not None:
        if not await invite_repo.try_consume(session, invite_id):
            # Lost a race, or revoked between resolve and here.
            invite = await invite_repo.get(session, invite_id)
            reason = invite_repo.status_of(invite) if invite else "invalid"
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=_INVITE_REFUSALS.get(
                    reason, "Invite link is invalid or has expired.",
                ),
            )

    # 4. Hash password
    hashed = hash_password(body.password)

    # 5. Create user — auto-activate if invited, otherwise pending
    user_status = "active" if invite_valid else "pending"
    user = await user_repo.create_user(
        session,
        email=body.email,
        password_hash=hashed,
        first_name=body.first_name,
        last_name=body.last_name,
        status=user_status,
        # ``create_user`` has always accepted this and documented that the
        # invite flow passes 'invite' — but this call site never did, so every
        # invited user was recorded as a self-registration. That made the
        # column useless for exactly the question it exists to answer:
        # "how did this account come to exist?"
        signup_source="invite" if invite_valid else "local_signup",
    )

    if invite_valid:
        # Invited: mark as approved + (optionally) grant the role.
        if invite_role:
            await _grant_invite_role(
                session,
                user_id=user.id,
                role=invite_role,
                workspace_id=invite_workspace_id,
                granted_by=invite_admin,
            )

        # Phase 13: attach the user to each group from the invite.
        # Best-effort: a group deleted after minting just logs +
        # continues — we'd rather activate the user with partial
        # group membership than 500 the signup.
        attached_groups: list[str] = []
        if invite_group_ids:
            from backend.app.db.repositories import group_repo
            for gid in invite_group_ids:
                grp = await group_repo.get_group_by_id(session, gid)
                if grp is None:
                    logger.warning(
                        "Invite group %s no longer exists; skipping for %s",
                        gid, user.id,
                    )
                    continue
                try:
                    await group_repo.add_member(
                        session, gid, user.id, added_by=invite_admin,
                    )
                    attached_groups.append(gid)
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Failed to add %s to group %s: %s — continuing.",
                        user.id, gid, exc,
                    )

        await user_repo.create_approval(
            session, user.id, status="approved", approved_by=invite_admin,
        )
        # The "who used this link" ledger. Without it a shareable invite
        # could be redeemed by a dozen people and leave nothing an admin
        # could point at afterwards.
        if invite_id is not None:
            await invite_repo.record_redemption(
                session,
                invite_id=invite_id,
                user_id=user.id,
                email=user.email,
            )
        await user_repo.create_outbox_event(
            session,
            event_type="user.created_via_invite",
            payload={
                "user_id": user.id,
                "email": user.email,
                "invite_id": invite_id,
                "role": invite_role,
                "workspace_id": invite_workspace_id,
                "group_ids": attached_groups,
                "invited_by": invite_admin,
            },
        )
        logger.info(
            "User signed up via invite: %s (role=%s ws=%s groups=%d)",
            user.id, invite_role, invite_workspace_id, len(attached_groups),
        )

        user_dto = await _build_user_response(session, user)
        signed_in = await _try_auto_sign_in(
            request, response, session,
            email=body.email, password=body.password, user_id=user.id,
        )
        if signed_in:
            return SignUpResponse(
                message="Account created. Welcome aboard.",
                autoSignedIn=True,
                user=user_dto,
                redirectTo=(
                    f"/workspaces/{invite_workspace_id}"
                    if invite_workspace_id else "/"
                ),
            )
        return SignUpResponse(message="Account created and activated. You can now sign in.")
    else:
        # Standard signup: pending approval
        await user_repo.create_approval(session, user.id, status="pending")
        await user_repo.create_outbox_event(
            session,
            event_type="user.created",
            payload={"user_id": user.id, "email": user.email},
        )
        logger.info("User signed up: %s (pending approval)", user.id)
        return SignUpResponse(message="Account created. Awaiting administrator approval.")


# /auth/login lives in backend.auth_service.api.router (cookie-based).


# ── POST /auth/forgot-password ──────────────────────────────────────

@router.post("/forgot-password")
@limiter.limit("3/minute")
async def forgot_password(
    request: Request,
    body: ForgotPasswordRequest,
    session: AsyncSession = Depends(get_db_session),
):
    """
    Request a password reset. Always returns 200 to prevent email enumeration.
    If the user exists, a reset token is created and an outbox event is written
    so the admin panel can surface the request.
    """
    user = await user_repo.get_user_by_email(session, body.email)
    if user is not None and user.status in ("active", "pending"):
        # Flag the user as having requested a reset — do NOT generate a
        # token here. The admin will see the flag in the dashboard and
        # generate a shareable token via the admin endpoint.
        await user_repo.flag_reset_requested(session, user.id)
        await user_repo.create_outbox_event(
            session,
            event_type="user.password_reset_requested",
            payload={"user_id": user.id, "email": user.email},
        )
        logger.info("Password reset requested for user %s", user.id)
    # Always return the same response regardless of whether the user exists
    return {
        "message": "If an account with that email exists, a password reset has been initiated. Please contact your administrator for the reset token.",
    }


# ── POST /auth/reset-password ───────────────────────────────────────

@router.post("/reset-password")
@limiter.limit("5/minute")
async def reset_password(
    request: Request,
    body: ResetPasswordRequest,
    session: AsyncSession = Depends(get_db_session),
):
    """
    Reset password using a valid reset token.
    """
    # 1. Validate token
    user = await user_repo.verify_reset_token(session, body.token)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid or expired reset token.",
        )

    # 2. Validate password strength
    _check_password_strength(body.new_password)

    # 3. Update password (also clears the reset token)
    hashed = hash_password(body.new_password)
    await user_repo.update_password(session, user.id, hashed)

    await user_repo.create_outbox_event(
        session,
        event_type="user.password_reset_completed",
        payload={"user_id": user.id},
    )

    logger.info("Password reset completed for user %s", user.id)
    return {"message": "Password has been reset successfully. You can now sign in."}


# ── GET /auth/verify-invite ──────────────────────────────────────────

@router.get("/verify-invite", response_model=InviteVerifyResponse)
async def verify_invite(
    token: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Validate an invite token and return the assigned role + scope.

    Phase 11: also surfaces the workspace (id + friendly name) and
    the pinned email so the signup page can render "You'll join
    Finance as Viewer" and lock the email field for email-bound
    invites.

    Phase 15: reports WHY an unusable link is unusable. Revoked, out of
    seats, expired and "links are switched off" are four different
    situations with four different remedies, and collapsing them into
    "invalid or expired" told the recipient nothing they could act on.
    """
    # The kill switch, checked before the signature: when an admin turns invite
    # links off, links already in circulation must stop working at once. A
    # toggle that only prevented NEW links would be useless in the situation it
    # exists for — a link that has leaked.
    if not await feature_flags.is_enabled_self_session(
            "inviteLinksEnabled", default=INVITE_LINKS_FAIL_OPEN):
        return InviteVerifyResponse(valid=False, role=None, reason="links_disabled")

    resolved = await resolve_invite(session, token)
    if not resolved.valid:
        return InviteVerifyResponse(
            valid=False, role=None, reason=resolved.reason,
        )

    workspace_id = resolved.workspace_id
    workspace_name = None
    if workspace_id:
        from backend.app.db.repositories import workspace_repo
        ws = await workspace_repo.get_workspace_orm(session, workspace_id)
        if ws is not None:
            workspace_name = ws.name

    # Phase 13: resolve group names so the signup page can render
    # "You'll join the Engineering and Data Platform groups."
    group_ids: list[str] = resolved.group_ids
    group_names: list[str] = []
    if group_ids:
        from backend.app.db.repositories import group_repo
        for gid in group_ids:
            grp = await group_repo.get_group_by_id(session, gid)
            group_names.append(grp.name if grp else gid)

    return InviteVerifyResponse(
        valid=True,
        role=resolved.role,
        workspaceId=workspace_id,
        workspaceName=workspace_name,
        email=resolved.email,
        groupIds=group_ids or None,
        groupNames=group_names or None,
        seatsRemaining=resolved.seats_remaining,
        expiresAt=resolved.expires_at,
    )
