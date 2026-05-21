"""
LocalIdentityService — in-process implementation of ``IdentityService``.

Orchestrates providers, JWT issuance, refresh rotation, and CSRF token
minting. Owns no global state beyond the registered providers; sessions
are opened on demand through an injected ``session_factory`` so this
class has no static binding to SQLAlchemy.

When the auth service is extracted, ``LocalIdentityService`` is replaced
on the app by a ``RemoteIdentityService`` that speaks HTTP — call sites
do not change.
"""
from __future__ import annotations

import logging
import secrets
from typing import Awaitable, Callable, Optional

import jwt as pyjwt

import time
from urllib.parse import quote

from .core.config import (
    JWT_EXPIRY_MINUTES,
    JWT_REFRESH_EXPIRY_DAYS,
    SSO_SESSION_MAX_AGE_SECONDS,
)
from .core.password import hash_password
from .core.tokens import (
    create_access_token,
    create_refresh_token,
    decode_token,
    decode_refresh_token,
)
from .csrf import mint_csrf_token
from .interface import (
    InvalidCredentials,
    InvalidRefreshToken,
    SessionTokens,
    SSOAuthError,
    SsoReauthRequired,
    User,
)
from .providers import ProviderCredentials, get_provider
from .refresh import check_and_record_rotation


# Provider names that participate in the SSO daily re-auth ceiling.
# ``local`` is exempt — local password sessions keep the existing
# 7-day refresh TTL. Update this when a new SSO provider lands.
_SSO_PROVIDERS = frozenset({"oidc", "saml2", "custom"})

# Where to send the user when their SSO session has expired. Each
# provider has its own /login endpoint that re-runs the handshake; the
# 401 body includes the URL so the frontend can navigate transparently.
_SSO_LOGIN_PATHS = {
    "oidc":   "/api/v1/auth/oidc/login",
    "saml2":  "/api/v1/auth/saml/login",
    "custom": "/api/v1/auth/custom/login",
}


def _build_reauth_url(provider: str, *, next_path: str) -> str:
    """Compose the IdP /login URL for the SSO re-auth bounce. ``force=1``
    is appended so the frontend's tryRefresh handler can request a fresh
    IdP login (vs. silent rotation through the IdP session)."""
    base = _SSO_LOGIN_PATHS.get(provider, "/api/v1/auth/oidc/login")
    safe_next = next_path or "/"
    return f"{base}?next={quote(safe_next, safe='/')}&force=1"

logger = logging.getLogger(__name__)


class LocalIdentityService:
    """In-process ``IdentityService``. See module docstring.

    Constructor args are duck-typed callables so this module has no
    static binding to SQLAlchemy or any specific repository:

      * ``session_factory()`` -> async context manager yielding the session
        (matches ``backend.app.db.engine.get_async_session``).
      * ``user_repo`` — module exposing ``get_user_by_id``,
        ``get_user_by_email``, ``get_user_roles``.
      * ``refresh_store_factory(session)`` -> ``RefreshStore``.
      * ``outbox_emit(session, event_type, payload)`` — optional async
        callback for emitting domain events alongside the operation.
    """

    def __init__(
        self,
        *,
        session_factory,
        user_repo,
        refresh_store_factory,
        outbox_emit=None,
        claims_resolver: Optional[Callable[..., Awaitable[dict]]] = None,
        sso_role_reconciler: Optional[Callable[..., Awaitable[dict]]] = None,
        session_killer: Optional[Callable[..., Awaitable[None]]] = None,
    ):
        # ``user_repo`` is injected as a module so this class doesn't need
        # to import the concrete repository directly. The shape used:
        #   get_user_by_id(session, id) -> ORM | None
        #   get_user_by_email(session, email) -> ORM | None
        #   get_user_roles(session, id) -> list[str]
        #   set_user_idp_metadata(session, *, user_id, idp_groups, raw_claims) (optional)
        #
        # ``claims_resolver`` (RBAC Phase 1) is an optional callable
        # ``(session, user_id, *, sid) -> dict`` that returns the
        # permission claim payload to embed in the access JWT. The
        # auth service doesn't know the shape of the dict — it only
        # forwards it to ``create_access_token(extra=...)``. When None,
        # tokens carry only identity (no permission claims), preserving
        # pre-Phase-1 behaviour.
        #
        # ``sso_role_reconciler`` (Phase 2.D) is an optional callable
        # ``(session, *, user_id, idp_groups) -> dict`` that reconciles
        # SSO RoleBindings against the IdP-asserted group list. The
        # auth service treats the return value as opaque (audit metadata).
        # Lives outside this module so the binding repo stays out of the
        # extractable surface.
        #
        # ``session_killer`` (Phase 2.E) is an optional async callable
        # ``(user_id) -> None`` invoked when the SSO daily ceiling
        # forces re-auth — it kills every live access-token session for
        # the user so the next request from any browser tab bounces to
        # the IdP. Implemented by ``revocation_service.revoke_all_user_sessions``
        # but injected to keep the boundary clean.
        self._session_factory = session_factory
        self._user_repo = user_repo
        self._refresh_store_factory = refresh_store_factory
        self._outbox_emit = outbox_emit
        self._claims_resolver = claims_resolver
        self._sso_role_reconciler = sso_role_reconciler
        self._session_killer = session_killer

    # ── Service protocol ──────────────────────────────────────────────

    async def validate_session(self, access_token: Optional[str]) -> Optional[User]:
        if not access_token:
            return None
        try:
            payload = decode_token(access_token)
        except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
            return None

        user_id = payload.get("sub")
        if not user_id:
            return None

        async with self._session_factory() as session:
            orm = await self._user_repo.get_user_by_id(session, user_id)
            if orm is None or orm.deleted_at is not None or orm.status != "active":
                return None
            roles = await self._user_repo.get_user_roles(session, orm.id)
        return _orm_to_user(orm, role=_primary_role(roles))

    async def login(self, email: str, password: str) -> tuple[User, SessionTokens]:
        provider = get_provider("local")

        claims_extra: dict = {}
        async with self._session_factory() as session:
            async def _get_user_by_email(em: str):
                return await self._user_repo.get_user_by_email(session, em)

            identity = await provider.authenticate(
                ProviderCredentials(email=email, password=password),
                get_user_by_email=_get_user_by_email,
            )
            if identity is None:
                raise InvalidCredentials("Invalid email or password")

            orm = await self._user_repo.get_user_by_id(session, identity.external_id)
            if orm is None:
                raise InvalidCredentials("Invalid email or password")
            roles = await self._user_repo.get_user_roles(session, orm.id)

            if self._claims_resolver is not None:
                claims_extra = await self._claims_resolver(session, orm.id)

            if self._outbox_emit is not None:
                await self._outbox_emit(
                    session, "user.logged_in",
                    {"user_id": orm.id, "email": orm.email, "provider": "local"},
                )

        user = _orm_to_user(orm, role=_primary_role(roles))
        tokens = self._issue_tokens(user, family_id=None, claims_extra=claims_extra)
        return user, tokens

    async def logout(self, refresh_token: Optional[str]) -> None:
        if not refresh_token:
            return
        try:
            claims = decode_refresh_token(refresh_token)
        except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
            return  # idempotent — nothing to revoke

        async with self._session_factory() as session:
            store = self._refresh_store_factory(session)
            await store.revoke_family(claims.family_id)
            if self._outbox_emit is not None:
                await self._outbox_emit(
                    session, "user.logged_out",
                    {"user_id": claims.sub},
                )

    async def refresh(self, refresh_token: str) -> tuple[User, SessionTokens]:
        try:
            claims = decode_refresh_token(refresh_token)
        except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError) as exc:
            raise InvalidRefreshToken(str(exc)) from exc

        claims_extra: dict = {}
        async with self._session_factory() as session:
            store = self._refresh_store_factory(session)
            err = await check_and_record_rotation(
                store,
                presented_jti=claims.jti,
                presented_family=claims.family_id,
                presented_exp=claims.exp,
            )
            if err is not None:
                logger.warning("Refresh rejected (%s) for user=%s family=%s", err, claims.sub, claims.family_id)
                raise InvalidRefreshToken(err)

            orm = await self._user_repo.get_user_by_id(session, claims.sub)
            if orm is None or orm.deleted_at is not None or orm.status != "active":
                # User no longer eligible — kill the family and bail.
                await store.revoke_family(claims.family_id)
                raise InvalidRefreshToken("user_inactive")

            # ── SSO daily re-auth ceiling ────────────────────────────
            # SSO sessions must re-authenticate at the IdP at least
            # every ``SSO_SESSION_MAX_AGE_SECONDS``. We measure elapsed
            # wall-clock time from the IdP-issued ``auth_time`` (which
            # propagates unchanged through every rotation), not from
            # the previous rotation. Local password sessions skip
            # this check and keep the existing 7-day refresh TTL.
            user_provider = getattr(orm, "auth_provider", "local") or "local"
            if (
                user_provider in _SSO_PROVIDERS
                and claims.auth_time is not None
                and (int(time.time()) - claims.auth_time) > SSO_SESSION_MAX_AGE_SECONDS
            ):
                # Kill the family + every live access token across all
                # tabs so the next request from any browser surface
                # bounces to the IdP. Best-effort outbox audit. The
                # session-killer (revocation service) is injected so
                # this module stays extractable.
                await store.revoke_family(claims.family_id)
                if self._session_killer is not None:
                    try:
                        await self._session_killer(orm.id)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "session_killer failed during SSO expiry "
                            "(user=%s): %s", orm.id, exc,
                        )
                if self._outbox_emit is not None:
                    await self._outbox_emit(
                        session, "user.sso_session_expired",
                        {
                            "user_id": orm.id,
                            "provider": user_provider,
                            "auth_time": claims.auth_time,
                            "elapsed_seconds": int(time.time()) - claims.auth_time,
                        },
                    )
                logger.info(
                    "SSO session expired (user=%s, provider=%s, age=%ds)",
                    orm.id, user_provider, int(time.time()) - claims.auth_time,
                )
                raise SsoReauthRequired(
                    _build_reauth_url(user_provider, next_path="/"),
                    provider=user_provider,
                )

            roles = await self._user_repo.get_user_roles(session, orm.id)

            if self._claims_resolver is not None:
                # Refresh re-resolves claims so a binding/group change made
                # since the previous access token still rolls forward on
                # the next rotation, even if the revocation set has expired.
                claims_extra = await self._claims_resolver(session, orm.id)

        user = _orm_to_user(orm, role=_primary_role(roles))
        # Propagate the original IdP auth_time unchanged through
        # rotation so the next check still measures from the real
        # authentication instant, not from this refresh.
        tokens = self._issue_tokens(
            user,
            family_id=claims.family_id,
            claims_extra=claims_extra,
            auth_time=claims.auth_time,
        )
        return user, tokens

    async def get_user(self, user_id: str) -> Optional[User]:
        async with self._session_factory() as session:
            orm = await self._user_repo.get_user_by_id(session, user_id)
            if orm is None or orm.deleted_at is not None:
                return None
            roles = await self._user_repo.get_user_roles(session, orm.id)
        return _orm_to_user(orm, role=_primary_role(roles))

    async def complete_sso_login(self, identity) -> tuple[User, SessionTokens]:
        """Find-or-provision from a verified SSO identity, then issue a
        session. ``identity`` is a ``ProviderIdentity`` (provider,
        external_id, email, names, raw_claims, groups, auth_time).

        Identity key is ``(auth_provider, external_id)`` — never email.
        Linking guardrails (account-takeover defence):

          * known subject → reuse the account (must be active);
          * new subject, email free → JIT-provision (active, no roles);
          * new subject, email collides with an existing account →
            auto-link **only** when the IdP asserts
            ``email_verified=true`` AND the existing account is a local,
            active account; on link, password login is disabled;
          * otherwise → **deny + audit** (no duplicate-email account).

        Additionally — for every successful SSO login — the IdP groups
        are persisted on the user row and the group->role reconciler
        is invoked so RoleBindings track what the IdP currently
        asserts.
        """
        provider = identity.provider
        external_id = identity.external_id
        email = identity.email
        email_verified = _claims_email_verified(identity.raw_claims)
        idp_groups: list[str] = list(getattr(identity, "groups", ()) or ())
        # auth_time anchors the 24h SSO re-auth ceiling. Fall back to
        # "now" when the IdP didn't surface one (we have to start the
        # clock somewhere; doing so is conservative).
        auth_time = getattr(identity, "auth_time", None)
        if not isinstance(auth_time, int) or auth_time <= 0:
            auth_time = int(time.time())

        claims_extra: dict = {}
        async with self._session_factory() as session:
            orm = await self._user_repo.get_user_by_external_identity(
                session, provider, external_id,
            )

            if orm is not None:
                if orm.deleted_at is not None or orm.status != "active":
                    raise SSOAuthError("sso_account_inactive")
            else:
                by_email = await self._user_repo.get_user_by_email(session, email)
                if by_email is None:
                    orm = await self._user_repo.create_sso_user(
                        session,
                        email=email,
                        first_name=identity.first_name,
                        last_name=identity.last_name,
                        auth_provider=provider,
                        external_id=external_id,
                        password_hash=_disabled_password_hash(),
                    )
                    if self._outbox_emit is not None:
                        await self._outbox_emit(
                            session, "user.sso_provisioned",
                            {"user_id": orm.id, "email": orm.email,
                             "provider": provider, "external_id": external_id},
                        )
                else:
                    safe_to_link = (
                        email_verified
                        and by_email.status == "active"
                        and by_email.auth_provider == "local"
                        and by_email.deleted_at is None
                    )
                    if not safe_to_link:
                        await self._emit_audit(
                            "user.sso_link_denied",
                            {"email": email, "provider": provider,
                             "external_id": external_id,
                             "reason": "unsafe_auto_link",
                             "email_verified": email_verified,
                             "existing_status": by_email.status,
                             "existing_provider": by_email.auth_provider},
                        )
                        raise SSOAuthError("unsafe_auto_link")
                    orm = await self._user_repo.link_user_to_provider(
                        session,
                        user_id=by_email.id,
                        auth_provider=provider,
                        external_id=external_id,
                        disabled_password_hash=_disabled_password_hash(),
                    )
                    if self._outbox_emit is not None:
                        await self._outbox_emit(
                            session, "user.sso_linked",
                            {"user_id": orm.id, "email": orm.email,
                             "provider": provider, "external_id": external_id},
                        )

            # Persist the IdP-asserted groups + raw_claims on the user
            # row so the admin UI / /me can surface the latest snapshot.
            # Best-effort: failures here MUST NOT block login (the
            # reconciler below still runs and its result is the
            # authoritative permission state).
            try:
                if hasattr(self._user_repo, "set_user_idp_metadata"):
                    await self._user_repo.set_user_idp_metadata(
                        session,
                        user_id=orm.id,
                        idp_groups=idp_groups,
                        raw_claims=identity.raw_claims,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Persisting IdP metadata failed (user=%s, provider=%s): %s",
                    orm.id, provider, exc,
                )

            # Reconcile group->role RoleBindings (source='sso') with
            # what the IdP currently asserts. Additive for present
            # groups; expires bindings whose source group is no longer
            # asserted. Same transaction as the upsert above so a
            # failure here rolls back the whole login. The reconciler
            # itself lives outside this module (the auth service is
            # extractable and must not import from backend.app); it
            # is injected by the app at startup.
            reconcile_result: dict | None = None
            if self._sso_role_reconciler is not None:
                try:
                    reconcile_result = await self._sso_role_reconciler(
                        session, user_id=orm.id, idp_groups=idp_groups,
                    )
                except Exception as exc:  # noqa: BLE001 — surface in audit
                    logger.warning(
                        "Group->role reconcile failed (user=%s, provider=%s): %s",
                        orm.id, provider, exc,
                    )

            roles = await self._user_repo.get_user_roles(session, orm.id)
            if self._claims_resolver is not None:
                claims_extra = await self._claims_resolver(session, orm.id)
            if self._outbox_emit is not None:
                payload = {
                    "user_id": orm.id,
                    "email": orm.email,
                    "provider": provider,
                    "auth_time": auth_time,
                    "groups": idp_groups,
                }
                if reconcile_result is not None:
                    payload["reconcile"] = {
                        k: reconcile_result[k] for k in
                        ("mappings_matched", "created", "revoked", "reactivated")
                        if k in reconcile_result
                    }
                await self._outbox_emit(session, "user.logged_in", payload)

        user = _orm_to_user(orm, role=_primary_role(roles))
        tokens = self._issue_tokens(
            user, family_id=None, claims_extra=claims_extra, auth_time=auth_time,
        )
        return user, tokens

    async def _emit_audit(self, event_type: str, payload: dict) -> None:
        """Emit an audit event in its own committed transaction.

        Used for the link-denied path: the main session rolls back when
        we raise ``SSOAuthError``, so the audit record must be written
        and committed separately or it would be lost with the rollback.
        """
        if self._outbox_emit is None:
            return
        async with self._session_factory() as session:
            await self._outbox_emit(session, event_type, payload)

    # ── Internals ─────────────────────────────────────────────────────

    def _issue_tokens(
        self,
        user: User,
        *,
        family_id: Optional[str],
        claims_extra: Optional[dict] = None,
        auth_time: Optional[int] = None,
    ) -> SessionTokens:
        """Mint a fresh (access, refresh, csrf) triple.

        ``auth_time`` (epoch seconds) is the IdP-issued authentication
        instant for SSO sessions; it is embedded in the refresh JWT
        and propagated through every rotation. The 24h SSO re-auth
        check reads it on the next refresh. ``None`` for local
        password sessions.
        """
        access = create_access_token(
            user_id=user.id,
            email=user.email,
            role=user.role,
            extra=claims_extra or None,
        )
        refresh, _ = create_refresh_token(
            user_id=user.id, family_id=family_id, auth_time=auth_time,
        )
        return SessionTokens(
            access_token=access,
            access_max_age_seconds=JWT_EXPIRY_MINUTES * 60,
            refresh_token=refresh,
            refresh_max_age_seconds=JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60,
            csrf_token=mint_csrf_token(),
        )


# ── Helpers ──────────────────────────────────────────────────────────

def _claims_email_verified(raw_claims: dict) -> bool:
    """OIDC ``email_verified`` may arrive as a JSON bool or the string
    ``"true"`` depending on the IdP. Treat anything else as false."""
    v = raw_claims.get("email_verified")
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


def _disabled_password_hash() -> str:
    """A valid Argon2id hash of a discarded random secret. Stored on
    SSO-owned / linked accounts so the local password path runs in
    constant time but can never authenticate them."""
    return hash_password(secrets.token_urlsafe(64))


def _primary_role(roles: list[str]) -> str:
    """Pick the highest-privilege role for downstream gating.

    UserORM allows multiple roles per user; the access-token claim and the
    User DTO carry a single ``role`` for simplicity. We prefer ``admin``
    if present, then fall back to the first role, then ``user``.
    """
    if not roles:
        return "user"
    if "admin" in roles:
        return "admin"
    return roles[0]


def _orm_to_user(orm, *, role: str) -> User:
    """Project a ``UserORM`` (or any object exposing the same fields) into the
    cross-service ``User`` DTO. Centralised here so the wire shape evolves
    in one place."""
    return User(
        id=orm.id,
        email=orm.email,
        first_name=orm.first_name,
        last_name=orm.last_name,
        role=role,
        status=orm.status,
        auth_provider=getattr(orm, "auth_provider", "local") or "local",
        created_at=getattr(orm, "created_at", "") or "",
        updated_at=getattr(orm, "updated_at", "") or "",
    )
