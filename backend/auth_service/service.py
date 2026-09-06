"""
LocalIdentityService — in-process implementation of ``IdentityService``.

Orchestrates providers, JWT issuance, refresh rotation, CSRF token
minting, and the multi-identity SSO flow. Owns no global state beyond
the registered providers; sessions are opened on demand through an
injected ``session_factory`` so this class has no static binding to
SQLAlchemy.

When the auth service is extracted, ``LocalIdentityService`` is
replaced on the app by a ``RemoteIdentityService`` that speaks HTTP —
call sites do not change. To keep that lift safe, the class only
imports from ``backend.auth_service.*`` (enforced by
``test_auth_service_isolation``); every DB-side hook is injected.
"""
from __future__ import annotations

import base64
import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote, urlsplit

import jwt as pyjwt

from .core.config import (
    JWT_EXPIRY_MINUTES,
    SESSION_ABSOLUTE_MAX_SECONDS,
    SESSION_IDLE_MAX_SECONDS,
    JWT_REFRESH_EXPIRY_DAYS,
    REFRESH_ADOPT_RECORDLESS,
    REFRESH_ROTATION_GRACE_SECONDS,
    SSO_SESSION_MAX_AGE_SECONDS,
)
from backend.common.identity_provenance import asserted_fields, build_snapshot

from .core.password import disabled_password_hash
from .core.tokens import (
    create_access_token,
    create_refresh_token,
    decode_token,
    decode_refresh_token,
    is_foreign_token_error,
)
from .app_auth_config import (
    AuthConfigProvider,
    AuthConfigSnapshot,
    StaticAuthConfigProvider,
)
from .csrf import mint_csrf_token
from .interface import (
    InvalidCredentials,
    InvalidRefreshToken,
    LocalLoginDisabled,
    SessionTokens,
    SSOAuthError,
    SsoReauthRequired,
    User,
)
from .providers import ProviderCredentials, get_provider
from .refresh import check_and_record_rotation

logger = logging.getLogger(__name__)


# Default re-auth URL when we don't know the provider's slug. Used as
# a last-resort fallback only; real flows always have a slug from the
# user's identity row.
_FALLBACK_REAUTH_URL = "/login"


def _build_reauth_url(provider_slug: Optional[str], *, next_path: str) -> str:
    """Compose the IdP-bound re-auth URL. ``force=1`` requests an IdP
    re-authentication even when the IdP session is still warm."""
    base = (
        f"/api/v1/auth/{provider_slug}/login"
        if provider_slug else _FALLBACK_REAUTH_URL
    )
    safe_next = next_path or "/"
    return f"{base}?next={quote(safe_next, safe='/')}&force=1"


@dataclass(frozen=True)
class SsoDecision:
    """What an incoming SSO identity means, before anything is done about it.

    Produced by ``_classify_sso_login`` from reads alone, and consumed two
    ways: ``complete_sso_login`` executes the writes for the action, and
    ``preview_sso_login`` renders it for an operator rehearsing a sign-in.
    One producer is the point — a rehearsal that disagreed with the login
    it rehearses would be worse than no rehearsal.
    """
    #: sign_in_existing | link_intent | provision_new | link_existing | rejected
    action: str
    #: The account this would touch, when there is one.
    user: Any = None
    #: The ``user_identities`` row to touch, on the returning-subject path.
    identity_row: Any = None
    #: Set when ``action == "rejected"``: the ``SSOAuthError`` code.
    error: Optional[str] = None
    deny_reasons: tuple[str, ...] = ()
    has_existing_identity: bool = False
    email_verified: bool = False


@dataclass(frozen=True)
class _PendingLiveness:
    """What an upstream liveness re-check needs, carried out of the DB
    session scope so the outbound call happens on nobody's connection.

    Mirrors ``_RefreshRejected``'s reason for existing: the work has to
    happen once the request's transaction has closed.
    """

    #: The IdP row that minted this session. Only a ``backchannel`` row
    #: is probed; every other kind resolves and is skipped.
    provider_id: str
    #: The row to stamp on a successful confirmation — the token the
    #: user is about to start using, not the one they just spent.
    successor_jti: str
    #: Epoch seconds of the last successful confirmation, the anchor the
    #: outage grace window is measured from.
    last_checked_at: Optional[int]
    user_id: str


class _RefreshRejected(Exception):
    """Carries a refresh rejection out of the DB session scope.

    Everything a rejection still has to do — revoke the family, kill live
    access tokens, write the audit row — has to happen on a connection
    the request scope is no longer holding, and after that scope has
    rolled back. Raising this instead of the caller-facing error lets
    ``refresh`` unwind the session first and settle the consequences
    afterwards. It never escapes ``refresh``.
    """

    def __init__(
        self,
        error: Exception,
        *,
        kill_sessions_for: Optional[str] = None,
        audit: Optional[tuple[str, dict]] = None,
    ):
        super().__init__(str(error))
        #: The error to re-raise at the caller once cleanup is done.
        self.error = error
        #: User id whose live access tokens should be tombstoned, if any.
        self.kill_sessions_for = kill_sessions_for
        #: ``(event_type, payload)`` to emit in its own transaction.
        self.audit = audit


class LocalIdentityService:
    """In-process ``IdentityService`` (Phase 3 — multi-IdP, multi-identity).

    Constructor args are duck-typed callables/modules so this class
    has no static binding to SQLAlchemy or any specific repository.

      * ``session_factory()`` -> async context manager yielding the
        SQLAlchemy session (matches
        ``backend.app.db.engine.get_async_session``).
      * ``user_repo`` — module exposing ``get_user_by_id``,
        ``get_user_by_email``, ``get_user_roles``,
        ``create_sso_user`` (the Phase 3 simplified signature with
        no auth_provider/external_id args),
        ``set_user_idp_metadata`` (optional).
      * ``user_identity_repo`` — module exposing
        ``get_by_subject(provider_id, external_id)``,
        ``create_identity(user_id, provider_id, external_id, …)``,
        ``touch_last_login``, ``list_for_user``,
        ``has_any_identity``. Phase 3 NEW.
      * ``refresh_store_factory(session)`` -> ``RefreshStore``.
      * ``outbox_emit(session, event_type, payload)`` — optional async
        callback for emitting domain events alongside the operation.
      * ``claims_resolver(session, user_id)`` -> dict — RBAC Phase 1
        permission-claim resolver.
      * ``sso_role_reconciler(session, *, user_id, idp_groups,
        provider_id)`` -> dict — Phase 3 group-target reconciler
        (handles both role_binding and group_membership targets).
      * ``session_killer(user_id)`` -> None — Phase 2.E
        revoke-all-sessions hook.
      * ``session_revoker(sid)`` -> None — tombstone ONE session. The
        narrow sibling of ``session_killer``: sign-out on this device
        must not end the user's sessions on their other devices.

    The new ``user_identity_repo`` is required for the SSO paths; the
    constructor accepts ``None`` so the local-only login flow works
    in narrow environments (legacy tests) that don't wire it.
    """

    def __init__(
        self,
        *,
        session_factory,
        user_repo,
        refresh_store_factory,
        user_identity_repo=None,
        outbox_emit=None,
        email_domain_resolver=None,
        assertion_recorder=None,
        claims_resolver: Optional[Callable[..., Awaitable[dict]]] = None,
        sso_role_reconciler: Optional[Callable[..., Awaitable[dict]]] = None,
        sso_role_preview: Optional[Callable[..., Awaitable[dict]]] = None,
        session_killer: Optional[Callable[..., Awaitable[None]]] = None,
        session_revoker: Optional[Callable[..., Awaitable[None]]] = None,
        auth_config_provider: Optional[AuthConfigProvider] = None,
        avatar_fetcher: Optional[
            Callable[..., Awaitable[tuple[bytes, str]]]
        ] = None,
    ):
        self._session_factory = session_factory
        self._user_repo = user_repo
        self._user_identity_repo = user_identity_repo
        self._refresh_store_factory = refresh_store_factory
        self._outbox_emit = outbox_emit
        # Injected by app startup: (domain) -> ProviderConfigSnapshot | None.
        # Lives outside this module because resolving it needs the provider
        # repo, and auth_service may not import backend.app.* .
        self._email_domain_resolver = email_domain_resolver
        # (session, provider_id, claims) -> None. Injected for the
        # same isolation reason as the resolver above.
        self._assertion_recorder = assertion_recorder
        self._claims_resolver = claims_resolver
        self._sso_role_reconciler = sso_role_reconciler
        # Read-only sibling of the reconciler, for the dry-run: same
        # mapping lookup, no writes.
        self._sso_role_previewer = sso_role_preview
        self._session_killer = session_killer
        self._session_revoker = session_revoker
        # (url, *, provider_id=None) -> (bytes, content_type). Injected
        # by app startup, which binds the outbound guard and the
        # operator's host allowlist — auth_service may not import
        # backend.app.* itself. ``provider_id`` lets the wiring honour
        # the connection's own TLS posture (its ``tls_verify`` opt-out)
        # for the image fetch made during that connection's sign-in.
        self._avatar_fetcher = avatar_fetcher
        # ``auth_config_provider`` (Phase 4) gates login + JIT + SSO
        # discovery on the platform posture stored in
        # ``app_auth_config``. When ``None`` (legacy test wiring), the
        # service falls back to the all-true defaults via
        # ``StaticAuthConfigProvider`` so existing tests keep
        # working unchanged.
        self._auth_config_provider: AuthConfigProvider = (
            auth_config_provider or StaticAuthConfigProvider()
        )

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

    async def auth_config(self) -> AuthConfigSnapshot:
        """Expose the current platform posture to the routing layer.

        Returns the cached snapshot from the injected provider. The
        ``/auth/providers`` route + ``/auth/{slug}/*`` slug routes
        consult this to short-circuit the master kill-switch."""
        return await self._auth_config_provider.get()

    async def invalidate_auth_config_cache(self) -> None:
        """Called by the admin ``PATCH /admin/sso/config`` endpoint
        after a successful change so the next request sees the new
        posture without waiting out the TTL."""
        await self._auth_config_provider.invalidate()

    async def login(self, email: str, password: str) -> tuple[User, SessionTokens]:
        # Phase 4: respect the platform kill-switch BEFORE invoking
        # the local provider — refuse the request explicitly so the
        # FE can redirect to the dynamic providers list instead of
        # showing a generic "wrong password".
        cfg = await self._auth_config_provider.get()

        provider = get_provider("local")

        claims_extra: dict = {}
        async with self._session_factory() as session:
            async def _get_user_by_email(em: str):
                return await self._user_repo.get_user_by_email(session, em)

            if not cfg.allow_local_login:
                # One carve-out from the kill-switch: a system account
                # (break-glass) keeps the password door while the
                # platform enforces SSO — otherwise an IdP outage has
                # no way back in. Unknown emails and every ordinary
                # account get the identical refusal, before any
                # password check, so this is not an account oracle.
                candidate = await _get_user_by_email(email)
                if candidate is None or not bool(
                    getattr(candidate, "is_system_account", False)
                ):
                    raise LocalLoginDisabled()

            identity = await provider.authenticate(
                ProviderCredentials(email=email, password=password),
                get_user_by_email=_get_user_by_email,
            )
            if identity is None:
                # Phase 9: emit user.login_failed BEFORE raising so the
                # audit log captures brute-force / password-spray
                # attempts. Use the rollback-safe emit since the raise
                # would roll back the main session and drop the event.
                # Best-effort throughout — an audit failure must never
                # block the 401 (wrapped below).
                try:
                    await self._emit_audit(
                        "user.login_failed",
                        {"email": email, "reason": "invalid_credentials"},
                    )
                except Exception:  # noqa: BLE001
                    pass
                raise InvalidCredentials("Invalid email or password")

            orm = await self._user_repo.get_user_by_id(session, identity.external_id)
            if orm is None:
                try:
                    await self._emit_audit(
                        "user.login_failed",
                        {"email": email, "reason": "user_not_found"},
                    )
                except Exception:  # noqa: BLE001
                    pass
                raise InvalidCredentials("Invalid email or password")
            roles = await self._user_repo.get_user_roles(session, orm.id)

            if self._claims_resolver is not None:
                claims_extra = await self._claims_resolver(session, orm.id)

            if self._outbox_emit is not None:
                await self._outbox_emit(
                    session, "user.logged_in",
                    {"user_id": orm.id, "email": orm.email, "provider": "local"},
                )

            # Inside the scope, so the token and its record commit or fail
            # together. ``auth_time`` is None: this is a local password
            # login, and the SSO re-auth ceiling does not apply to it.
            refresh_token = await self._mint_recorded_refresh(
                session, user_id=orm.id, family_id=None, auth_time=None,
            )

        user = _orm_to_user(orm, role=_primary_role(roles))
        tokens = self._issue_tokens(
            user,
            family_id=None,
            claims_extra=claims_extra,
            refresh_token=refresh_token,
        )
        return user, tokens

    async def logout(
        self,
        refresh_token: Optional[str],
        access_token: Optional[str] = None,
    ) -> None:
        """End this session: revoke its rotation family AND tombstone
        the access token still in the caller's hands.

        Revoking the family alone is not a sign-out. It stops the
        session being *renewed*, but the access token already issued
        stays signature-valid until it expires, and nothing on the
        request path consults the refresh family — ``get_current_user``
        checks the ``sid`` tombstone. So a token captured before the
        sign-out kept working for the rest of its lifetime: up to
        ``JWT_EXPIRY_MINUTES + CLOCK_SKEW_LEEWAY_SECONDS``, which is an
        hour under the shipped compose default.

        The ``sid`` lives in the ACCESS token, not the refresh token,
        which is why the caller hands both in. An expired or unreadable
        access cookie needs no tombstone — it is already refused — so
        those cases fall through to the family revocation alone rather
        than failing the sign-out.

        Deliberately per-session, not per-user: ``session_killer`` ends
        every session a user has, and signing out of one browser must
        not sign them out of the others. "Sign out everywhere" is a
        separate, explicit action.
        """
        await self._revoke_this_session(access_token)

        if not refresh_token:
            return
        try:
            claims = decode_refresh_token(refresh_token)
        except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError):
            return  # idempotent — nothing left to revoke

        async with self._session_factory() as session:
            store = self._refresh_store_factory(session)
            await store.revoke_family(claims.family_id)
            if self._outbox_emit is not None:
                await self._outbox_emit(
                    session, "user.logged_out",
                    {"user_id": claims.sub},
                )

    async def _revoke_this_session(self, access_token: Optional[str]) -> None:
        """Tombstone the ``sid`` carried by ``access_token``, if any.

        Best-effort by design: a sign-out whose tombstone write fails
        must still revoke the refresh family and clear the cookies. The
        failure is logged at ERROR because it leaves a live access token
        behind, which is exactly the condition worth alerting on.
        """
        if not access_token or self._session_revoker is None:
            return
        try:
            sid = decode_token(access_token).get("sid")
        except Exception:  # noqa: BLE001 — see below
            # Expired, foreign, or structurally broken: all already
            # refused on every request, so there is nothing to tombstone.
            # Broad rather than the two JWT errors, because this runs
            # BEFORE the family revocation and before the cookies are
            # cleared — anything escaping here would turn a sign-out into
            # a 500 that also failed to sign the user out.
            return
        if not sid:
            return
        try:
            await self._session_revoker(sid)
        except Exception:  # noqa: BLE001 — sign-out must not fail on this
            logger.exception(
                "Failed to tombstone sid during logout; the access token "
                "stays valid until it expires",
            )

    async def refresh(
        self, refresh_token: str, *,
        ambient_cookies: Optional[dict] = None,
        ambient_headers: Optional[dict] = None,
    ) -> tuple[User, SessionTokens]:
        """Rotate a refresh token.

        ``ambient_cookies`` / ``ambient_headers`` are the inbound
        request's own, forwarded so a ``backchannel`` session can be
        re-confirmed with the enterprise IdP on every rotation. Both
        default to None so every other caller — and every existing test
        — is unchanged; a session that needs the check and is not given
        them is treated as having no ambient token, which is the same
        answer as the user having signed out upstream.
        """
        try:
            claims = decode_refresh_token(refresh_token)
        except (pyjwt.ExpiredSignatureError, pyjwt.InvalidTokenError) as exc:
            raise InvalidRefreshToken(
                str(exc), foreign=is_foreign_token_error(exc),
            ) from exc

        # Every rejection below has to revoke the family durably, and the
        # request session is rolled back on the way out — so the revocation
        # cannot ride on it. It also must not run *inside* this block:
        # opening a second connection while the first is still held is a
        # deadlock against SQLite's single writer and, on Postgres, a way
        # to exhaust the pool under load waiting for a connection that only
        # frees when this scope exits. So rejections are carried out of the
        # scope by ``_RefreshRejected`` and settled once it has closed.
        try:
            user, tokens, liveness = await self._refresh_within_session(claims)
        except _RefreshRejected as rejection:
            await self._revoke_family_committed(claims.family_id)
            if rejection.kill_sessions_for is not None and self._session_killer:
                try:
                    await self._session_killer(rejection.kill_sessions_for)
                except Exception as exc:  # noqa: BLE001 — best-effort
                    logger.warning(
                        "session_killer failed during refresh rejection "
                        "(user=%s): %s", rejection.kill_sessions_for, exc,
                    )
            if rejection.audit is not None:
                await self._emit_audit(*rejection.audit)
            raise rejection.error from None

        # Deliberately AFTER the session scope has closed. This makes an
        # outbound HTTP call, and holding a DB connection across one
        # would pin a connection per in-flight refresh for the length of
        # somebody else's network — the same reason rejections are
        # carried out of the scope above rather than settled inside it.
        #
        # Rotation has already committed by this point, which is fine:
        # refusing here revokes the family, and the successor written a
        # moment ago belongs to that family.
        if liveness is not None:
            await self._settle_liveness(
                liveness, claims,
                ambient_cookies=ambient_cookies or {},
                ambient_headers=ambient_headers or {},
            )
        return user, tokens

    async def _refresh_within_session(
        self, claims,
    ) -> tuple[User, SessionTokens, Optional["_PendingLiveness"]]:
        # Mint the candidate successor before claiming. Its identity has
        # to be recorded in the same statement that consumes the
        # presented token, so a concurrent refresh that loses the race
        # can read it back instead of being treated as a thief. Minting
        # is pure CPU; if we lose, this one is simply discarded.
        successor_token, successor = create_refresh_token(
            user_id=claims.sub,
            family_id=claims.family_id,
            auth_time=claims.auth_time,
            # Family-invariant, like auth_time: the upstream credential's
            # expiry does not move because we rotated, and dropping it
            # here would make rotation a way to shed the ceiling.
            idp_exp=claims.idp_exp,
        )

        claims_extra: dict = {}
        async with self._session_factory() as session:
            store = self._refresh_store_factory(session)
            outcome = await check_and_record_rotation(
                store,
                presented_jti=claims.jti,
                presented_family=claims.family_id,
                presented_exp=claims.exp,
                presented_user_id=claims.sub,
                presented_auth_time=claims.auth_time,
                presented_mint_ms=claims.mint_ms,
                successor_jti=successor.jti,
                successor_exp=successor.exp,
                successor_mint_ms=successor.mint_ms,
                grace_seconds=REFRESH_ROTATION_GRACE_SECONDS,
                adopt_recordless=REFRESH_ADOPT_RECORDLESS,
            )
            if outcome.status == "unknown":
                # Allow-by-record: no row, no session. Reached only once
                # adoption is off, and then it means the token was
                # forged, restored from a backup taken before its row
                # existed, or minted by a deployment whose writes were
                # rolled back. Refuse without killing the family — there
                # is no family here to speak of.
                logger.warning(
                    "Refresh rejected (no_record) for user=%s family=%s",
                    claims.sub, claims.family_id,
                )
                raise InvalidRefreshToken("no_record")
            if outcome.status == "family_revoked":
                # Already dead — nothing to revoke, don't pay for a
                # second connection just to re-mark rows that are marked.
                logger.warning(
                    "Refresh rejected (family_revoked) for user=%s family=%s",
                    claims.sub, claims.family_id,
                )
                raise InvalidRefreshToken("family_revoked")
            if outcome.status == "reuse":
                logger.warning(
                    "Refresh rejected (reuse_detected) for user=%s family=%s",
                    claims.sub, claims.family_id,
                )
                raise _RefreshRejected(InvalidRefreshToken("reuse_detected"))

            # The server's own account of when this session authenticated,
            # in preference to what the token says about itself. See the
            # SSO ceiling below for why that distinction is the point;
            # everything downstream — the ceiling, the replay re-mint, the
            # successor's own record — reads this one value so they cannot
            # disagree. Falls back to the claim only when there is no
            # record at all, which the ``unknown`` branch above has
            # already ruled out except under adoption.
            auth_time = (
                outcome.record.auth_time if outcome.record is not None
                else claims.auth_time
            )

            is_replay = outcome.status == "replay"
            if is_replay:
                # Someone beat us to this token moments ago. Hand back
                # what they minted rather than a competing successor:
                # the refresh cookie is per-browser, so two live
                # successors would leave one of them orphaned in the
                # chain — unconsumable, and indistinguishable from theft
                # if it ever surfaced.
                logger.info(
                    "Refresh replayed inside the grace window for user=%s "
                    "family=%s — returning the successor already issued",
                    claims.sub, claims.family_id,
                )
                successor_token, successor = create_refresh_token(
                    user_id=claims.sub,
                    family_id=claims.family_id,
                    auth_time=auth_time,
                    idp_exp=claims.idp_exp,
                    jti=outcome.successor.successor_jti,
                    expires_at_epoch=outcome.successor.successor_exp,
                    mint_ms=outcome.successor.successor_mint_ms,
                )

            orm = await self._user_repo.get_user_by_id(session, claims.sub)
            if orm is None or orm.deleted_at is not None or orm.status != "active":
                # User no longer eligible — kill the family and bail.
                raise _RefreshRejected(InvalidRefreshToken("user_inactive"))

            # ── Session revocation cutoff ────────────────────────────
            # Revoking sessions tombstones live access-token ``sid``s in
            # Redis, but that alone does not sign anyone out: the
            # revocation entry expires with the access token, and this
            # method mints a FRESH random ``sid`` on every rotation, so
            # a client that eats one 401 and silently refreshes — which
            # the SPA does automatically — comes straight back with a
            # ``sid`` that was never on the list.
            #
            # ``sessions_valid_from`` is the durable half. Anything
            # issued before the cutoff is refused and its family killed,
            # so "sign out everywhere" means it.
            if _refresh_predates_cutoff(
                claims.mint_ms, getattr(orm, "sessions_valid_from", None),
            ):
                logger.info(
                    "Refresh rejected (sessions_revoked) for user=%s family=%s",
                    claims.sub, claims.family_id,
                )
                raise _RefreshRejected(InvalidRefreshToken("sessions_revoked"))

            # ── Absolute + idle session ceilings ─────────────────────
            # Every session, SSO or local. Rotation mints a fresh 7-day
            # refresh token each time and nothing looked at when the
            # family started, so a local session that rotated once a
            # week lived indefinitely — a refresh cookie stolen once was
            # a permanent credential. The SSO ceiling below does not
            # help there: it only fires when ``auth_time`` is set, which
            # local logins deliberately leave NULL.
            #
            # Refused rather than merely not-renewed, and the family is
            # killed with it: a session past its ceiling is over, and
            # leaving the rest of the chain live would let the next tab
            # walk straight back in.
            if SESSION_IDLE_MAX_SECONDS > 0:
                # From the server's record, not the token's own claim —
                # the same rule ``auth_time`` follows two blocks down,
                # and for the same reason: a value the token asserts
                # about itself is a value whoever holds the token could
                # have been handed with anything in it.
                last_mint_ms = (
                    outcome.record.mint_ms if outcome.record is not None
                    else claims.mint_ms
                )
                idle_seconds = int(time.time()) - int(last_mint_ms / 1000)
                if idle_seconds > SESSION_IDLE_MAX_SECONDS:
                    logger.info(
                        "Refresh rejected (session_idle) for user=%s "
                        "family=%s idle=%ds",
                        claims.sub, claims.family_id, idle_seconds,
                    )
                    raise _RefreshRejected(
                        InvalidRefreshToken("session_idle"),
                    )

            if SESSION_ABSOLUTE_MAX_SECONDS > 0:
                started_ms = await store.family_started_ms(claims.family_id)
                if started_ms is not None:
                    age_seconds = int(time.time()) - int(started_ms / 1000)
                    if age_seconds > SESSION_ABSOLUTE_MAX_SECONDS:
                        logger.info(
                            "Refresh rejected (session_expired) for user=%s "
                            "family=%s age=%ds",
                            claims.sub, claims.family_id, age_seconds,
                        )
                        raise _RefreshRejected(
                            InvalidRefreshToken("session_expired"),
                        )

            # ── SSO daily re-auth ceiling ────────────────────────────
            # ``auth_time`` present means "this session was minted by an
            # SSO login" — no user column is consulted for that. We DO
            # ask the identity repo for the user's most recent identity
            # to pick which provider slug to bounce to. Local password
            # sessions have ``auth_time IS NULL`` and skip this block.
            #
            # Read from the SERVER'S record, not from the token. As a
            # claim it was something the token asserted about itself, and
            # a token that simply omitted it read as a local session and
            # skipped this ceiling entirely — which is exactly the bug
            # fixed earlier in this work, there by defaulting the value
            # at mint. Sourcing it here makes the whole class impossible:
            # the row cannot be absent for a token we just accepted, and
            # it cannot be edited by whoever holds the cookie.
            is_sso_session = auth_time is not None
            sso_age = (
                int(time.time()) - auth_time
                if is_sso_session else 0
            )
            if is_sso_session and sso_age > SSO_SESSION_MAX_AGE_SECONDS:
                # Kill the family + every live access token across all
                # tabs so the next request from any browser surface
                # bounces to the IdP. The slug lookup needs the session,
                # so resolve it here; the revocation, the session-killer
                # (Redis) and the audit event all happen after this scope
                # closes — see ``refresh``.
                provider_slug = await self._latest_identity_slug(session, orm.id)
                logger.info(
                    "SSO session expired (user=%s, slug=%s, age=%ds)",
                    orm.id, provider_slug, sso_age,
                )
                raise _RefreshRejected(
                    SsoReauthRequired(
                        _build_reauth_url(provider_slug, next_path="/"),
                        provider=provider_slug or "sso",
                    ),
                    kill_sessions_for=orm.id,
                    audit=("user.sso_session_expired", {
                        "user_id": orm.id,
                        "provider_slug": provider_slug,
                        "auth_time": auth_time,
                        "elapsed_seconds": sso_age,
                    }),
                )

            # ── Upstream credential ceiling ──────────────────────────
            # ``idp_exp`` is the corporate token's own expiry, captured
            # at sign-in by the browser-exchange back-channel shape —
            # the topology where the server never sees the corporate
            # session and so can never re-ask about it. It is signed
            # into our refresh token and propagated unchanged, so
            # rotation cannot extend it. Past it, the session ends the
            # way a failed liveness check ends one: the reauth envelope
            # names the provider, and the sign-in page silently re-runs
            # the browser flow against the corporate IdP.
            #
            # From the claim rather than a server record — unlike
            # ``auth_time`` above — because our own signature covers it:
            # nobody holding the cookie can edit it without failing
            # verification, and it exists only for tokens this
            # deployment minted with it.
            if claims.idp_exp is not None and int(time.time()) > claims.idp_exp:
                provider_slug = await self._latest_identity_slug(session, orm.id)
                logger.info(
                    "Upstream credential expired (user=%s, slug=%s, "
                    "idp_exp=%d)",
                    orm.id, provider_slug, claims.idp_exp,
                )
                raise _RefreshRejected(
                    SsoReauthRequired(
                        _build_reauth_url(provider_slug, next_path="/"),
                        provider=provider_slug or "sso",
                    ),
                    kill_sessions_for=orm.id,
                    audit=("user.sso_session_ended_upstream", {
                        "user_id": orm.id,
                        "provider_slug": provider_slug,
                        "reason": "upstream_token_expired",
                        "idp_exp": claims.idp_exp,
                    }),
                )

            # ── Continuous group->target reconciliation ──────────────
            # When mappings or groups change between the previous login
            # and this refresh, derived RoleBindings / Group memberships
            # update on the next rotation rather than waiting for the
            # next full SSO login. The cached ``idp_groups`` snapshot
            # is set by ``set_user_idp_metadata`` at SSO login.
            # Skipped on a replay: the refresh we are echoing reconciled
            # moments ago, and repeating the write would only lengthen
            # the transaction every other racer is blocked behind.
            if is_sso_session and self._sso_role_reconciler and not is_replay:
                cached_groups = _load_cached_idp_groups(orm)
                latest_provider_id = await self._latest_identity_provider_id(
                    session, orm.id,
                )
                try:
                    await self._sso_role_reconciler(
                        session,
                        user_id=orm.id,
                        idp_groups=cached_groups,
                        provider_id=latest_provider_id,
                    )
                except TypeError:
                    # Phase-2 reconciler signature (no provider_id). Fall
                    # back so a partial roll-forward still works.
                    try:
                        await self._sso_role_reconciler(
                            session, user_id=orm.id, idp_groups=cached_groups,
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "Refresh-time reconcile failed (user=%s): %s",
                            orm.id, exc,
                        )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Refresh-time reconcile failed (user=%s): %s",
                        orm.id, exc,
                    )

            # Captured, not acted on: the probe is an outbound HTTP call
            # and must not run while this transaction is open.
            pending_liveness = (
                _PendingLiveness(
                    provider_id=outcome.record.idp_provider_id,
                    successor_jti=successor.jti,
                    last_checked_at=outcome.record.idp_checked_at,
                    user_id=orm.id,
                )
                if outcome.record is not None
                and outcome.record.idp_provider_id
                else None
            )

            roles = await self._user_repo.get_user_roles(session, orm.id)

            if self._claims_resolver is not None:
                # Refresh re-resolves claims so a binding/group change
                # made since the previous access token still rolls
                # forward on the next rotation, even if the revocation
                # set has expired.
                claims_extra = await self._claims_resolver(session, orm.id)

        user = _orm_to_user(orm, role=_primary_role(roles))
        # Propagate the original IdP auth_time unchanged through
        # rotation so the next check still measures from the real
        # authentication instant, not from this refresh.
        tokens = self._issue_tokens(
            user,
            family_id=claims.family_id,
            claims_extra=claims_extra,
            auth_time=auth_time,
            refresh_token=successor_token,
        )
        return user, tokens, pending_liveness

    async def get_user(self, user_id: str) -> Optional[User]:
        async with self._session_factory() as session:
            orm = await self._user_repo.get_user_by_id(session, user_id)
            if orm is None or orm.deleted_at is not None:
                return None
            roles = await self._user_repo.get_user_roles(session, orm.id)
        return _orm_to_user(orm, role=_primary_role(roles))

    # ── SSO completion ───────────────────────────────────────────────

    async def complete_sso_login(
        self,
        identity,
        *,
        provider_id: str,
        provider_slug: Optional[str] = None,
        linking_policy: str = "strict",
        link_intent_user_id: Optional[str] = None,
        assurance: Optional[str] = None,
    ) -> tuple[User, SessionTokens]:
        """Find-or-provision from a verified SSO identity, then issue
        a session.

        ``identity`` is a :class:`ProviderIdentity`. ``provider_id`` is
        the ``idp_providers.id`` of the provider that produced the
        identity (the route resolves this from the URL slug via the
        registry). ``linking_policy`` is the provider's
        ``linking_policy`` column value.

        ``link_intent_user_id`` is set by the self-service link flow
        (``/auth/identities/{slug}/link/start``): when present, the
        verified identity is **bound to that user** instead of
        provisioning or auto-linking. The route MUST validate the
        intent cookie carries a user_id that matches the current
        session before calling.

        Identity lookup key: ``(provider_id, external_id)`` in
        ``user_identities``. Phase 2's ``(auth_provider, external_id)``
        on ``users`` is gone.

        Linking policy semantics:

          * ``strict`` (Phase-2 behaviour): auto-link only when
            ``email_verified=true`` AND the existing account is local
            (no other identities) AND active.
          * ``allow_verified``: same gate, but tolerate existing
            accounts that already have one or more identities (multi-
            identity stacking).
          * ``manual_only``: never auto-link; existing accounts must
            initiate the link from ``/me/identities``.
          * ``disabled``: never link, never JIT-provision an existing-
            email match. Effectively forces a fresh account per IdP
            subject; primarily for testing the deny path.
        """
        if self._user_identity_repo is None:
            raise SSOAuthError("identity_repo_unavailable")

        # Phase 4: respect the platform posture switches BEFORE
        # touching any data. ``sso_enabled=false`` short-circuits the
        # whole flow (the slug route 404s in the same condition; this
        # is the belt-and-suspenders for direct service calls).
        cfg = await self._auth_config_provider.get()
        if not cfg.sso_enabled:
            raise SSOAuthError("sso_disabled")

        external_id = identity.external_id
        email = identity.email
        email_verified = _claims_email_verified(identity.raw_claims)
        idp_groups: list[str] = list(getattr(identity, "groups", ()) or ())
        attributes: dict = dict(getattr(identity, "attributes", {}) or {})
        # The 24h re-auth ceiling measures from the instant the IdP says
        # the user actually authenticated. When the IdP does not say, we
        # substitute now — which quietly converts the ceiling into "24h
        # since this login", a weaker guarantee than the one it claims
        # to enforce. That is the right fallback (refusing the login
        # would be worse) but it must not be silent: an IdP that never
        # asserts auth_time is a misconfiguration an operator can fix,
        # and until now nothing surfaced it.
        auth_time = getattr(identity, "auth_time", None)
        auth_time_asserted = isinstance(auth_time, int) and auth_time > 0
        if not auth_time_asserted:
            auth_time = int(time.time())
            logger.warning(
                "IdP provider_id=%s released no usable auth_time; the SSO "
                "re-auth ceiling will measure from this login instead of "
                "from the IdP authentication. For OIDC the authorize "
                "request sends max_age, which obliges a compliant provider "
                "to return auth_time; for the gateway and profile kinds, "
                "point auth_time at the right claim in the connection's "
                "claim mapping.",
                provider_id,
            )

        claims_extra: dict = {}
        async with self._session_factory() as session:
            # Which branch fires is decided in one place, shared with the
            # dry-run so a rehearsal cannot disagree with the real thing.
            # What follows is only the consequences.
            decision = await self._classify_sso_login(
                session, identity, provider_id=provider_id,
                linking_policy=linking_policy,
                link_intent_user_id=link_intent_user_id,
            )
            orm = decision.user
            link_metadata = {"groups": idp_groups, "attributes": attributes}

            if decision.action == "rejected":
                # The refusals that operators need to see get an audit
                # event in its own transaction, since this one rolls back.
                if decision.error == "jit_disabled":
                    await self._emit_audit(
                        "user.sso_jit_blocked",
                        {"email": email, "provider_id": provider_id,
                         "external_id": external_id,
                         "reason": "jit_provisioning_disabled"},
                    )
                elif decision.error == "unsafe_auto_link":
                    await self._emit_audit(
                        "user.sso_link_denied",
                        {"email": email, "provider_id": provider_id,
                         "external_id": external_id,
                         "reason": "unsafe_auto_link",
                         "deny_reasons": list(decision.deny_reasons),
                         "linking_policy": linking_policy,
                         "email_verified": email_verified,
                         "existing_status": orm.status if orm else None,
                         "existing_has_identity": decision.has_existing_identity},
                    )
                raise SSOAuthError(
                    decision.error or "sso_rejected",
                    deny_reasons=decision.deny_reasons,
                )

            if decision.action == "sign_in_existing":
                await self._user_identity_repo.touch_last_login(
                    session, decision.identity_row.id, metadata=link_metadata,
                )

            elif decision.action == "link_intent":
                await self._user_identity_repo.create_identity(
                    session,
                    user_id=orm.id, provider_id=provider_id,
                    external_id=external_id, email_at_link=email,
                    metadata=link_metadata,
                )
                if self._outbox_emit is not None:
                    await self._outbox_emit(
                        session, "user.identity.linked",
                        {"user_id": orm.id, "provider_id": provider_id,
                         "external_id": external_id, "via": "self_service"},
                    )

            elif decision.action == "provision_new":
                orm = await self._user_repo.create_sso_user(
                    session,
                    email=email,
                    first_name=identity.first_name,
                    last_name=identity.last_name,
                    password_hash=disabled_password_hash(),
                    signup_source="sso_jit",
                    signup_provider_id=provider_id,
                )
                await self._user_identity_repo.create_identity(
                    session,
                    user_id=orm.id, provider_id=provider_id,
                    external_id=external_id, email_at_link=email,
                    metadata=link_metadata,
                )
                if self._outbox_emit is not None:
                    await self._outbox_emit(
                        session, "user.sso_provisioned",
                        {"user_id": orm.id, "email": orm.email,
                         "provider_id": provider_id,
                         "external_id": external_id,
                         "linking_policy": linking_policy,
                         "signup_source": "sso_jit"},
                    )

            elif decision.action == "link_existing":
                # Add the identity row to the existing user — not a
                # destructive rewrite of password_hash; local + SSO
                # coexist when the policy allows.
                await self._user_identity_repo.create_identity(
                    session,
                    user_id=orm.id, provider_id=provider_id,
                    external_id=external_id, email_at_link=email,
                    metadata=link_metadata,
                )
                if self._outbox_emit is not None:
                    await self._outbox_emit(
                        session, "user.sso_linked",
                        {"user_id": orm.id, "email": orm.email,
                         "provider_id": provider_id,
                         "external_id": external_id,
                         "linking_policy": linking_policy,
                         "has_password": _has_password(orm),
                         "had_existing_identity": decision.has_existing_identity},
                    )

            # ── Profile fields the IdP owns ──────────────────────────
            #
            # Names used to be written once, at JIT provisioning, and
            # never again — so the IdP seeded the profile and then drifted
            # from it forever. Re-applying them here is what makes "the
            # IdP is the source of truth" an actual property rather than
            # a disabled input on a form.
            #
            # Only fields this login actually carried are touched. An IdP
            # that releases no ``given_name`` leaves the field alone
            # instead of blanking it, and leaves it editable — see
            # ``identity_provenance``. Nor does a name we split out of a
            # full name count: it is populated at provisioning either way,
            # but we do not lock a person out of correcting our own guess.
            #
            # Best-effort, like the metadata write below: a profile that
            # failed to re-sync must not cost somebody their sign-in.
            #
            # The provider-supplied avatar first, because whether it is
            # OWNED depends on whether the bytes actually landed: a URL
            # nothing could download must not lock anyone out of picking
            # their own picture. Fetched through the injected outbound
            # guard, refetched only when the asserted URL changed, and
            # never a login blocker.
            avatar_asserted = False
            avatar_url = getattr(identity, "avatar_url", None)
            if avatar_url and self._avatar_fetcher is not None:
                scheme = urlsplit(avatar_url).scheme.lower()
                if scheme not in ("http", "https"):
                    logger.warning(
                        "Avatar URL for user=%s has scheme %r; skipped.",
                        orm.id, scheme,
                    )
                elif (
                    getattr(orm, "avatar_source_url", None) == avatar_url
                    and getattr(orm, "avatar_image", None)
                ):
                    # Unchanged source, image in hand: nothing to fetch.
                    avatar_asserted = True
                else:
                    try:
                        img, ctype = await self._avatar_fetcher(
                            avatar_url, provider_id=provider_id,
                        )
                        await self._user_repo.set_user_avatar_image(
                            session, orm.id,
                            image_b64=base64.b64encode(img).decode("ascii"),
                            content_type=ctype,
                            source_url=avatar_url,
                        )
                        avatar_asserted = True
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "Avatar fetch failed (user=%s, provider=%s): %s",
                            orm.id, provider_id, exc,
                        )

            owned = asserted_fields(
                first_name=identity.first_name, last_name=identity.last_name,
                derived=identity.names_derived_from is not None,
                avatar_url=avatar_url if avatar_asserted else None,
            )
            if owned:
                try:
                    updates = {}
                    if "first_name" in owned:
                        updates["first_name"] = identity.first_name.strip()
                    if "last_name" in owned:
                        updates["last_name"] = identity.last_name.strip()
                    await self._user_repo.update_identity(
                        session, orm.id, **updates,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "IdP profile re-sync failed (user=%s, provider=%s): %s",
                        orm.id, provider_id, exc,
                    )

            # Derived (split) names are a guess, so they are never owned
            # and the re-sync above never writes them — which left anyone
            # who existed BEFORE this connection (an invite, a local
            # signup, an older JIT row) blank-named forever: every login
            # re-derived the split and threw it away. Seed instead of
            # syncing: written only while the row has no name at all, so
            # nothing a person typed is ever overwritten, and no
            # ownership is claimed — the fields stay theirs to edit.
            #
            # The IdP's exact full-name string also seeds the display
            # override (once, while blank): the split is a guess about
            # word order, and "Doe, Alice" reconstructed as "Alice Doe"
            # is not what the directory said.
            if identity.names_derived_from is not None:
                try:
                    row_first = (orm.first_name or "").strip()
                    row_last = (orm.last_name or "").strip()
                    id_first = (identity.first_name or "").strip()
                    id_last = (identity.last_name or "").strip()
                    seed: dict = {}
                    if not row_first and not row_last:
                        if id_first:
                            seed["first_name"] = id_first
                        if id_last:
                            seed["last_name"] = id_last
                    names_from_this_split = bool(seed) or (
                        (row_first, row_last) == (id_first, id_last)
                    )
                    if (
                        identity.display_name
                        and names_from_this_split
                        and not (
                            getattr(orm, "display_name", "") or ""
                        ).strip()
                        and identity.display_name.strip()
                        != f"{id_first} {id_last}".strip()
                    ):
                        seed["display_name"] = identity.display_name.strip()
                    if seed:
                        await self._user_repo.update_identity(
                            session, orm.id, **seed,
                        )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Derived-name seed failed (user=%s, provider=%s): %s",
                        orm.id, provider_id, exc,
                    )

            # Persist the IdP-asserted groups + attributes on the user
            # row so the admin UI / /me can surface the latest snapshot.
            # Best-effort: failures here MUST NOT block login.
            try:
                if hasattr(self._user_repo, "set_user_idp_metadata"):
                    await self._user_repo.set_user_idp_metadata(
                        session,
                        user_id=orm.id,
                        idp_groups=idp_groups,
                        raw_claims=identity.raw_claims,
                        attributes=attributes,
                        source_provider_id=provider_id,
                        # Rewritten wholesale each login, which is what
                        # makes "most recently authenticated provider
                        # wins" fall out without a precedence table.
                        idp_managed=build_snapshot(
                            fields=owned,
                            provider_id=provider_id,
                            at=_now_iso(),
                        ),
                    )
            except TypeError:
                # Pre-Phase-3 signature (no ``attributes`` kwarg).
                # Fall back so the old test setup keeps working.
                try:
                    await self._user_repo.set_user_idp_metadata(
                        session,
                        user_id=orm.id,
                        idp_groups=idp_groups,
                        raw_claims=identity.raw_claims,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Persisting IdP metadata failed (user=%s, provider=%s): %s",
                        orm.id, provider_id, exc,
                    )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Persisting IdP metadata failed (user=%s, provider=%s): %s",
                    orm.id, provider_id, exc,
                )

            # Reconcile group->target (role_binding | group_membership)
            # against what the IdP currently asserts. Additive for
            # present groups; soft-revoke for groups removed since the
            # last login. A failure is logged and the login proceeds —
            # a mapping hiccup must not lock the org out — and the
            # refresh-time reconcile retries it within one access-token
            # lifetime.
            reconcile_result: dict | None = None
            if self._sso_role_reconciler is not None:
                try:
                    reconcile_result = await self._sso_role_reconciler(
                        session, user_id=orm.id, idp_groups=idp_groups,
                        provider_id=provider_id,
                    )
                except TypeError:
                    # Old signature compatibility.
                    try:
                        reconcile_result = await self._sso_role_reconciler(
                            session, user_id=orm.id, idp_groups=idp_groups,
                        )
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "Group->target reconcile failed (user=%s, "
                            "provider=%s): %s", orm.id, provider_id, exc,
                        )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Group->target reconcile failed (user=%s, "
                        "provider=%s): %s", orm.id, provider_id, exc,
                    )

            roles = await self._user_repo.get_user_roles(session, orm.id)
            if self._claims_resolver is not None:
                claims_extra = await self._claims_resolver(session, orm.id)
            if self._outbox_emit is not None:
                payload = {
                    "user_id": orm.id,
                    "email": orm.email,
                    "provider_id": provider_id,
                    "provider_slug": provider_slug,
                    "auth_time": auth_time,
                    # False means the IdP did not release auth_time and
                    # this is our own clock — so the re-auth ceiling for
                    # this session measures from the login, not from the
                    # IdP authentication. Recorded per-login so the
                    # question is answerable per provider after the fact.
                    "auth_time_asserted": auth_time_asserted,
                    "groups": idp_groups,
                    # How well we actually knew this person. Recorded on the
                    # login itself so the question is answerable later without
                    # reconstructing what the provider's settings were at the
                    # time — they may have changed since.
                    "assurance": assurance,
                }
                if reconcile_result is not None:
                    payload["reconcile"] = {
                        k: reconcile_result[k] for k in
                        ("mappings_matched", "created", "revoked", "reactivated")
                        if k in reconcile_result
                    }
                await self._outbox_emit(session, "user.logged_in", payload)

            # Capture what this provider actually sent, so an operator can
            # build the claim mapping against reality rather than a sample
            # they typed from memory. Best-effort and last: a failure here
            # must never cost someone their login.
            if self._assertion_recorder is not None:
                try:
                    await self._assertion_recorder(
                        session, provider_id,
                        (identity.raw_claims or {}).get("claims") or {},
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "Recording last assertion failed (provider=%s): %s",
                        provider_id, exc,
                    )

            # Same reason as the local login: the record is the token's
            # licence, so both commit together. ``auth_time`` is the
            # IdP's authentication instant, and putting it on the row is
            # what stops the 24h re-auth ceiling depending on a claim the
            # token asserts about itself.
            # ``provider_id`` on the row, not just in the identity
            # table: a user can hold several identities, so "which IdP
            # did this SESSION come from" is not answerable from
            # ``user_identities`` alone — and the back-channel liveness
            # check has to ask exactly that, or it would probe an OIDC
            # session against a gateway it never came from.
            refresh_token = await self._mint_recorded_refresh(
                session, user_id=orm.id, family_id=None, auth_time=auth_time,
                idp_provider_id=provider_id,
                idp_exp=getattr(identity, "upstream_expires_at", None),
            )

        user = _orm_to_user(orm, role=_primary_role(roles))
        tokens = self._issue_tokens(
            user,
            family_id=None,
            claims_extra=claims_extra,
            auth_time=auth_time,
            refresh_token=refresh_token,
        )
        return user, tokens

    async def _classify_sso_login(
        self,
        session,
        identity,
        *,
        provider_id: str,
        linking_policy: str,
        link_intent_user_id: Optional[str] = None,
    ) -> "SsoDecision":
        """Decide what this identity means, without changing anything.

        Reads only. Every branch of the real login and every branch of the
        dry-run comes from here, so the rehearsal cannot disagree with the
        sign-in it rehearses — previously the two mirrored each other's
        structure and only shared the deny gate, guarded by a test that
        grepped the source for a function name. A grep is what you write
        when the structure cannot make the guarantee itself.

        The caller owns the consequences: writes for
        :meth:`complete_sso_login`, a rendered explanation for
        :meth:`preview_sso_login`. Audit events for the refusals belong to
        the caller too — a rehearsal must not emit them.
        """
        email_verified = _claims_email_verified(identity.raw_claims)

        # 1. Known subject (provider_id, external_id) — reuse the account
        #    it belongs to, must be active.
        existing_identity = await self._user_identity_repo.get_by_subject(
            session, provider_id=provider_id,
            external_id=identity.external_id,
        )
        if existing_identity is not None:
            orm = await self._user_repo.get_user_by_id(
                session, existing_identity.user_id,
            )
            if orm is None or orm.deleted_at is not None \
                    or orm.status != "active":
                return SsoDecision("rejected", error="sso_account_inactive")
            return SsoDecision(
                "sign_in_existing", user=orm, identity_row=existing_identity,
            )

        # 2. Link-intent path — bind the subject to the current
        #    authenticated user. Skips the policy gate because the user
        #    just authenticated moments ago to start the link.
        if link_intent_user_id is not None:
            orm = await self._user_repo.get_user_by_id(
                session, link_intent_user_id,
            )
            if orm is None or orm.deleted_at is not None \
                    or orm.status != "active":
                return SsoDecision("rejected", error="link_target_inactive")
            return SsoDecision("link_intent", user=orm)

        # 3. New subject — does the email collide with an existing account?
        by_email = await self._user_repo.get_user_by_email(
            session, identity.email,
        )
        if by_email is None:
            cfg = await self._auth_config_provider.get()
            if not cfg.allow_jit_provisioning:
                return SsoDecision("rejected", error="jit_disabled")
            return SsoDecision("provision_new")

        has_existing_identity = await self._user_identity_repo.has_any_identity(
            session, by_email.id,
        )
        deny_reasons = self._link_deny_reasons(
            by_email, linking_policy=linking_policy,
            email_verified=email_verified,
            has_existing_identity=has_existing_identity,
        )
        if deny_reasons:
            return SsoDecision(
                "rejected", user=by_email, error="unsafe_auto_link",
                deny_reasons=tuple(deny_reasons),
                has_existing_identity=has_existing_identity,
                email_verified=email_verified,
            )
        return SsoDecision(
            "link_existing", user=by_email,
            has_existing_identity=has_existing_identity,
        )

    async def preview_sso_login(
        self,
        identity,
        *,
        provider_id: str,
        linking_policy: str = "strict",
        link_intent_user_id: Optional[str] = None,
    ) -> dict:
        """What ``complete_sso_login`` WOULD do with this identity.

        Read-only by construction: it runs :meth:`_classify_sso_login` —
        the *same* function the real login runs — and renders the decision
        instead of executing it. That is what makes the rehearsal
        trustworthy: there is one implementation of "which branch fires",
        not two that have to be kept in agreement.

        The alternative — running the real path inside a rolled-back
        transaction — would exercise the writers, and the audit helper
        there commits a session of its own, which would make "writes
        nothing" untrue in exactly the case an operator is trusting it.

        One read-only side effect is deliberate: when the claims carry
        an avatar URL, the rehearsal performs the same guarded GET a
        real sign-in would (storing nothing), so the verdict can say
        whether the picture would arrive — and name the rule that
        refused it when it would not. That is the only surface an
        operator has for a fetch that otherwise fails as one server log
        line.
        """
        auth_time = getattr(identity, "auth_time", None)
        outcome: dict = {
            "email": identity.email,
            "external_id": identity.external_id,
            "first_name": identity.first_name,
            "last_name": identity.last_name,
            "groups": list(getattr(identity, "groups", ()) or ()),
            "attributes": dict(getattr(identity, "attributes", {}) or {}),
            "email_verified": _claims_email_verified(identity.raw_claims),
            "linking_policy": linking_policy,
            # Whether the claims carried a usable authentication time.
            # Absent means the ceiling measures from each sign-in (see
            # the fallback in ``complete_sso_login``) — a fact worth
            # stating on the verdict, since the row that reaches a
            # successful rehearsal without one has the requirement off.
            "auth_time": {
                "present": isinstance(auth_time, int) and auth_time > 0,
                "ceiling_hours": SSO_SESSION_MAX_AGE_SECONDS // 3600,
            },
        }

        cfg = await self._auth_config_provider.get()
        if not cfg.sso_enabled:
            outcome["action"] = "rejected"
            outcome["reason"] = "sso_disabled"
            return outcome
        if self._user_identity_repo is None:
            outcome["action"] = "rejected"
            outcome["reason"] = "identity_repo_unavailable"
            return outcome

        async with self._session_factory() as session:
            decision = await self._classify_sso_login(
                session, identity, provider_id=provider_id,
                linking_policy=linking_policy,
                link_intent_user_id=link_intent_user_id,
            )
            outcome["action"] = decision.action
            if decision.user is not None:
                outcome["user_id"] = decision.user.id
                outcome["user_email"] = decision.user.email
            if decision.error:
                outcome["reason"] = decision.error
            if decision.deny_reasons:
                outcome["deny_reasons"] = list(decision.deny_reasons)

            if self._sso_role_previewer is not None:
                try:
                    outcome["reconcile"] = await self._sso_role_previewer(
                        session, idp_groups=outcome["groups"],
                        provider_id=provider_id,
                    )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("Dry-run role preview failed: %s", exc)

        # After the session block on purpose: the avatar leg can wait on
        # a slow host, and a rehearsal must not hold a DB connection
        # while it does.
        outcome["avatar"] = await self._preview_avatar(
            getattr(identity, "avatar_url", None),
            provider_id=provider_id,
        )

        return outcome

    async def _preview_avatar(
        self, avatar_url, *, provider_id: Optional[str] = None,
    ) -> dict:
        """The avatar leg of a rehearsal: the fetch, storing nothing.

        Returns a dict the verdict renderer pattern-matches: no URL
        resolved (``{"url": None}``), fetched (content type and size),
        or refused — with the fetch guard's machine-readable ``reason``
        so the operator is told which rule fired (host not on the
        avatar list, not a raster image, too many redirects, …).
        """
        url = avatar_url.strip() if isinstance(avatar_url, str) else None
        if not url:
            return {"url": None}
        if self._avatar_fetcher is None:
            return {"url": url, "fetched": False,
                    "reason": "fetch_unavailable"}
        try:
            body, content_type = await self._avatar_fetcher(
                url, provider_id=provider_id,
            )
        except Exception as exc:  # noqa: BLE001
            from .providers.outbound import is_tls_verification_failure

            reason = getattr(exc, "reason", None)
            if reason is None and is_tls_verification_failure(exc):
                # httpx wraps the ssl failure in a ConnectError with no
                # ``.reason``; without this the operator reads a generic
                # fetch_failed and learns nothing about trust.
                reason = "tls_verify_failed"
            return {
                "url": url,
                "fetched": False,
                "reason": reason or "fetch_failed",
                "detail": str(exc),
            }
        return {
            "url": url, "fetched": True,
            "content_type": content_type, "size": len(body),
        }

    @staticmethod
    def _link_deny_reasons(
        existing, *, linking_policy: str, email_verified: bool,
        has_existing_identity: bool,
    ) -> list[str]:
        """The collision-branch gate, in one place so the dry-run and the
        real path cannot disagree about why a link is refused."""
        reasons: list[str] = []
        if linking_policy in ("manual_only", "disabled"):
            reasons.append(f"policy:{linking_policy}")
        if not email_verified:
            reasons.append("email_unverified")
        if existing.status != "active":
            reasons.append(f"existing_status:{existing.status}")
        if existing.deleted_at is not None:
            reasons.append("existing_deleted")
        if linking_policy == "strict" and has_existing_identity:
            reasons.append("strict_existing_sso")
        return reasons

    async def _emit_audit(self, event_type: str, payload: dict) -> None:
        """Emit an audit event in its own committed transaction.

        Used for paths that raise (link-denied, login-failed) where the
        main session would roll back and drop the audit row. We open a
        SECOND session, write the event, and commit it before the
        caller raises.

        Phase 9: added the explicit commit so the audit endpoint can
        see the event. The SSO-link-denied path used to work because
        the outer transaction was already in flight when raise fired;
        the login-failed path raises directly, so without the commit
        the new session was reaped without flushing.
        """
        if self._outbox_emit is None:
            return
        async with self._session_factory() as session:
            await self._outbox_emit(session, event_type, payload)
            try:
                await session.commit()
            except Exception:  # noqa: BLE001 — best-effort by design
                pass

    async def _settle_liveness(
        self, pending: "_PendingLiveness", claims, *,
        ambient_cookies: dict, ambient_headers: dict,
    ) -> None:
        """Re-ask the IdP whether this session is still live upstream.

        This is what stops our session outliving the enterprise session
        that created it — the gap every other kind has, and the reason
        single logout is hard for them. It runs on every rotation, so the
        cost is one back-channel call per active session per access-token
        lifetime — five minutes on the default ``JWT_EXPIRY_MINUTES``,
        longer where an operator has raised it. Deliberately not stated
        as a fixed number anywhere user-facing: it is deployment
        configuration, and the grace window is sized against it.

        Three outcomes, and keeping them apart is the whole design:

        * **The ambient token is gone.** The user signed out upstream,
          or the cookie was deleted. Costs no network call, and is the
          most common way a session legitimately ends.
        * **The IdP says no** (401/403). Authoritative. End the session.
        * **The IdP did not say** — a timeout, a 5xx, a blocked
          destination. NOT an answer, and ending sessions on one would
          turn a gateway blip into a platform-wide logout. Allowed
          through, but only while the last successful confirmation is
          inside the row's grace window; past that the session ends
          anyway, so an outage cannot extend sessions indefinitely.

        Only a success advances ``idp_checked_at``. A failure that moved
        it would let the outage renew the very allowance it is meant to
        be spending down.
        """
        provider = await self._resolve_liveness_provider(pending.provider_id)
        if provider is None:
            return

        settings = provider.settings
        if settings.token_source == "header":
            # Header names are case-insensitive on the wire, and the dict
            # the refresh route hands us has been through Starlette, which
            # lower-cases them. The operator's spelling (``X-Corp-Session``)
            # must keep matching, or every refresh reads "absent" and
            # revokes a healthy family.
            wanted = settings.token_source_key.lower()
            raw = next(
                (v for k, v in ambient_headers.items()
                 if k.lower() == wanted),
                None,
            )
        else:
            raw = ambient_cookies.get(settings.token_source_key)

        if not raw:
            await self._end_session_upstream(
                pending, claims, reason="ambient_token_absent",
            )
            return

        from .providers.backchannel import (
            BackchannelUnavailable, SessionRevokedUpstream,
        )
        try:
            await provider.confirm_still_authenticated(raw)
        except SessionRevokedUpstream as exc:
            await self._end_session_upstream(
                pending, claims, reason=f"idp_rejected:{exc}",
            )
            return
        except BackchannelUnavailable as exc:
            if self._liveness_grace_expired(pending, settings):
                logger.warning(
                    "Back-channel IdP unreachable and the grace window has "
                    "expired (user=%s provider=%s): %s",
                    pending.user_id, pending.provider_id, exc,
                )
                await self._end_session_upstream(
                    pending, claims, reason=f"idp_unconfirmed:{exc}",
                )
                return
            logger.warning(
                "Back-channel liveness unconfirmed for user=%s provider=%s "
                "(%s); inside the grace window, allowing this rotation",
                pending.user_id, pending.provider_id, exc,
            )
            return
        except Exception as exc:  # noqa: BLE001 — a provider bug is an outage
            logger.warning(
                "Back-channel liveness check raised unexpectedly "
                "(user=%s provider=%s): %s",
                pending.user_id, pending.provider_id, exc,
            )
            if self._liveness_grace_expired(pending, settings):
                await self._end_session_upstream(
                    pending, claims, reason="idp_unconfirmed:internal",
                )
            return

        await self._record_liveness_check(pending.successor_jti)

    async def _resolve_liveness_provider(self, provider_id: str):
        """The ``backchannel`` provider for this session, or None.

        None for every other kind — an OIDC or SAML session has no
        ambient token to present and must never be probed. Also None
        when the row has since been disabled or deleted: that is an
        operator action about future logins, and inventing a new
        revocation trigger out of it is not this method's call.
        """
        from .providers.backchannel import BackchannelProvider
        from .providers.registry import get_registry, ProviderNotFound

        try:
            provider = await get_registry().get(provider_id)
        except (ProviderNotFound, RuntimeError) as exc:
            logger.info(
                "Skipping liveness check; provider %s is not resolvable (%s)",
                provider_id, exc,
            )
            return None
        if not isinstance(provider, BackchannelProvider):
            return None
        if not provider.settings.liveness_on_refresh:
            return None
        if provider.settings.exchange_mode == "browser":
            # The corporate session never reaches this server in browser
            # mode, so there is nothing on the request to re-confirm.
            # The session is bounded instead by ``idp_exp`` — the
            # corporate token's own expiry, checked on every refresh.
            return None
        if not provider.settings.token_source_key:
            # Nothing on the request carries the upstream session, so
            # there is nothing to re-confirm. Without this the lookup
            # below returned None and the code concluded the session had
            # been revoked — revoking the refresh family and killing
            # every live session, once per access-token lifetime, for a
            # user who had done nothing wrong.
            #
            # "I have no way to check" and "I checked and the answer was
            # no" are opposite conclusions, and only one of them is
            # grounds for signing somebody out.
            logger.debug(
                "Provider %s names no ambient session source; skipping the "
                "liveness check rather than treating it as revoked.",
                provider.settings.provider_id,
            )
            return None
        return provider

    @staticmethod
    def _liveness_grace_expired(pending: "_PendingLiveness", settings) -> bool:
        """Whether an unconfirmed session has run out of allowance.

        A row with no anchor at all has never been confirmed — treated
        as expired, because the alternative is an unbounded allowance
        handed to exactly the sessions we know least about.
        """
        if pending.last_checked_at is None:
            return True
        return (
            int(time.time()) - int(pending.last_checked_at)
            > max(0, int(settings.liveness_grace_seconds))
        )

    async def _record_liveness_check(self, jti: str) -> None:
        """Stamp a successful confirmation, best-effort.

        Best-effort on purpose: failing to WRITE the anchor must not
        fail a refresh the IdP has just approved. The cost of losing it
        is a shorter grace window later, which errs closed.
        """
        try:
            async with self._session_factory() as session:
                store = self._refresh_store_factory(session)
                await store.touch_idp_check(jti, checked_at=int(time.time()))
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not record liveness check for %s: %s", jti, exc)

    async def _end_session_upstream(
        self, pending: "_PendingLiveness", claims, *, reason: str,
    ) -> None:
        """Kill this session because the IdP no longer backs it.

        Raises ``SsoReauthRequired`` — the same signal the 24h re-auth
        ceiling already raises, so the frontend's existing handling
        bounces the user to the provider's login with nothing new to
        teach it.
        """
        await self._revoke_family_committed(claims.family_id)
        if self._session_killer:
            try:
                await self._session_killer(pending.user_id)
            except Exception as exc:  # noqa: BLE001 — best-effort
                logger.warning(
                    "session_killer failed during liveness rejection "
                    "(user=%s): %s", pending.user_id, exc,
                )
        provider_slug = "sso"
        try:
            async with self._session_factory() as session:
                provider_slug = (
                    await self._latest_identity_slug(session, pending.user_id)
                ) or "sso"
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not resolve provider slug: %s", exc)

        logger.info(
            "Back-channel session ended upstream (user=%s provider=%s): %s",
            pending.user_id, pending.provider_id, reason,
        )
        await self._emit_audit("user.sso_session_ended_upstream", {
            "user_id": pending.user_id,
            "provider_id": pending.provider_id,
            "provider_slug": provider_slug,
            "reason": reason,
        })
        raise SsoReauthRequired(
            _build_reauth_url(provider_slug, next_path="/"),
            provider=provider_slug or "sso",
        )

    async def _revoke_family_committed(self, family_id: str) -> None:
        """Revoke a refresh family in its own committed transaction.

        Same shape as ``_emit_audit`` above, and for the same reason:
        every caller raises straight after, and the request-scoped
        session is rolled back on the way out — so a revocation written
        into that session never reached the database. Reuse detection,
        the inactive-user check, the sessions_valid_from cutoff and the
        SSO daily ceiling all revoked into thin air.

        Unlike ``_emit_audit`` a commit failure is NOT swallowed: a lost
        audit row is regrettable, a lost revocation leaves a stolen
        token family live. We log it loudly and let the caller raise its
        own auth error so the client still gets a clean 401.
        """
        async with self._session_factory() as session:
            store = self._refresh_store_factory(session)
            await store.revoke_family(family_id)
            try:
                await session.commit()
            except Exception as exc:  # noqa: BLE001
                logger.error(
                    "FAILED to revoke refresh family=%s — the family is "
                    "still live: %s", family_id, exc,
                )

    async def resolve_email_domain(self, domain: str):
        """Which provider claims *domain*, or None. See the injected
        resolver above; returns None when nothing is wired so the
        email-first route degrades to "no match" rather than erroring."""
        if self._email_domain_resolver is None:
            return None
        return await self._email_domain_resolver(domain)

    async def emit_audit(self, event_type: str, payload: dict) -> None:
        """Public entry point to the standalone-transaction audit path.

        Used by routes that need to record a fact about *how* a login
        was accepted (e.g. an unsigned or header-sourced profile) before
        the login itself is attempted, so the record survives a
        subsequent rejection.
        """
        await self._emit_audit(event_type, payload)

    # ── Identity helpers (refresh path) ──────────────────────────────

    async def _latest_identity_slug(
        self, session, user_id: str,
    ) -> Optional[str]:
        if self._user_identity_repo is None:
            return None
        identities = await self._user_identity_repo.list_for_user(session, user_id)
        # Pick the most recently used one. The repo orders by created_at
        # asc; we resort here by last_login_at desc.
        identities = sorted(
            identities, key=lambda i: i.last_login_at or "", reverse=True,
        )
        if not identities:
            return None
        provider = getattr(identities[0], "provider", None)
        return getattr(provider, "slug", None) if provider is not None else None

    async def _latest_identity_provider_id(
        self, session, user_id: str,
    ) -> Optional[str]:
        if self._user_identity_repo is None:
            return None
        identities = await self._user_identity_repo.list_for_user(session, user_id)
        identities = sorted(
            identities, key=lambda i: i.last_login_at or "", reverse=True,
        )
        return identities[0].provider_id if identities else None

    # ── Internals ─────────────────────────────────────────────────────

    async def _mint_recorded_refresh(
        self,
        session,
        *,
        user_id: str,
        family_id: Optional[str],
        auth_time: Optional[int],
        idp_provider_id: Optional[str] = None,
        idp_exp: Optional[int] = None,
    ) -> str:
        """Mint a refresh token and write the row that makes it usable.

        Under allow-by-record the row is not bookkeeping — it is the
        token's licence to exist. A token minted without one is refused
        at its first rotation, which the user meets as being signed out
        roughly one access lifetime after signing in. So the two happen
        together, in the caller's transaction: if the record cannot be
        written the login fails outright, rather than handing back a
        session that is already doomed.

        Called inside the session scope for that reason. Everything else
        about minting is pure CPU and deliberately stays outside it.
        """
        token, claims = create_refresh_token(
            user_id=user_id, family_id=family_id, auth_time=auth_time,
            idp_exp=idp_exp,
        )
        store = self._refresh_store_factory(session)
        await store.record_mint(
            jti=claims.jti,
            family_id=claims.family_id,
            user_id=user_id,
            auth_time=claims.auth_time,
            mint_ms=claims.mint_ms,
            expires_at_iso=datetime.fromtimestamp(
                claims.exp, tz=timezone.utc,
            ).isoformat(),
            idp_provider_id=idp_provider_id,
            # A login IS a successful upstream confirmation, so the
            # anchor starts here rather than at the first refresh. Left
            # NULL for local logins, where there is no upstream to
            # confirm and the column is never read.
            idp_checked_at=int(time.time()) if idp_provider_id else None,
        )
        return token

    def _issue_tokens(
        self,
        user: User,
        *,
        family_id: Optional[str],
        claims_extra: Optional[dict] = None,
        auth_time: Optional[int] = None,
        refresh_token: Optional[str] = None,
    ) -> SessionTokens:
        """Mint a fresh (access, refresh, csrf) triple.

        ``auth_time`` (epoch seconds) is the IdP-issued authentication
        instant for SSO sessions; it is embedded in the refresh JWT
        and propagated through every rotation. The 24h SSO re-auth
        check reads it on the next refresh. ``None`` for local
        password sessions.

        ``refresh_token`` supplies an already-minted refresh JWT. The
        rotation path mints its successor before consuming the presented
        token — the successor's identity has to be recorded atomically
        with that consumption — so it passes the token it committed to
        rather than letting a second one be generated here.
        """
        extra = dict(claims_extra or {})
        if user.must_change_password:
            # Carried as a claim rather than looked up per request:
            # ``get_current_user`` already decodes this token to read
            # ``sid``, so enforcing the rotation costs one more dict
            # lookup instead of a database round-trip on every call.
            extra["mcp"] = True
        # No size decision here. The claims resolver does not put
        # per-workspace grants in the token at all — see ``_resolve_claims``
        # in ``app/main.py`` — so what arrives is bounded by construction
        # and there is nothing to shed. This used to embed-while-it-fits,
        # which meant a user's authorization travelled differently
        # depending on how many workspaces they happened to hold, and the
        # store path that served the largest tenants was the one least
        # exercised. ``_warn_if_oversized`` in ``cookies.py`` remains as a
        # tripwire in case something ever puts an unbounded claim back.
        access = create_access_token(
            user_id=user.id,
            email=user.email,
            role=user.role,
            extra=extra or None,
        )
        refresh = refresh_token or create_refresh_token(
            user_id=user.id, family_id=family_id, auth_time=auth_time,
        )[0]
        return SessionTokens(
            access_token=access,
            access_max_age_seconds=JWT_EXPIRY_MINUTES * 60,
            refresh_token=refresh,
            refresh_max_age_seconds=JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60,
            # Bound to this session's sid so a cookie planted by a
            # sibling subdomain cannot satisfy the double-submit check.
            csrf_token=mint_csrf_token(extra.get("sid")),
        )


# ── Helpers ──────────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _refresh_predates_cutoff(mint_ms: int, cutoff: Optional[str]) -> bool:
    """True if a refresh token minted at *mint_ms* is older than *cutoff*.

    *cutoff* is the ISO ``users.sessions_valid_from`` stamp; *mint_ms* is
    the token's mint instant in epoch milliseconds. Both sides are
    compared at millisecond resolution because both routinely land in
    the same second — revoke-then-refresh, and revoke-then-sign-in-again
    are the two ordinary cases, and second precision cannot tell them
    apart.

    Fails OPEN in every "cannot tell" case: no cutoff, no mint claim, or
    an unparseable stamp. A session is killed on positive evidence, not
    on missing evidence — the alternative is a malformed column locking
    an account out of its own refresh path.
    """
    if not cutoff or mint_ms <= 0:
        return False
    try:
        parsed = datetime.fromisoformat(cutoff)
    except ValueError:
        logger.warning("Unparseable sessions_valid_from %r — ignoring", cutoff)
        return False
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return mint_ms < int(parsed.timestamp() * 1000)


def _claims_email_verified(raw_claims: dict) -> bool:
    """OIDC ``email_verified`` may arrive as a JSON bool or the string
    ``"true"`` depending on the IdP. Treat anything else as false.
    Phase 3: the claim mapper normalises this already and stashes the
    result in ``raw_claims['email_verified']``; we also fall back to
    the legacy ``email_verified`` key path."""
    v = raw_claims.get("email_verified")
    if v is None:
        nested = raw_claims.get("claims")
        if isinstance(nested, dict):
            v = nested.get("email_verified")
    return v is True or (isinstance(v, str) and v.strip().lower() == "true")


def _has_password(orm) -> bool:
    """True when the user has a usable password hash. Reads through
    ``auth_service.core.password.is_password_set`` for the
    disabled-sentinel detection."""
    from .core.password import is_password_set
    return is_password_set(getattr(orm, "password_hash", None) or "")


def _load_cached_idp_groups(orm) -> list[str]:
    """Read the most recent ``idp_groups`` snapshot off
    ``UserORM.metadata_``. Returns ``[]`` for unparseable / missing
    data so the refresh-time reconciler degrades to a no-op."""
    raw = getattr(orm, "metadata_", None) or "{}"
    try:
        import json
        data = json.loads(raw)
    except (ValueError, TypeError):
        return []
    if not isinstance(data, dict):
        return []
    groups = data.get("idp_groups", [])
    if not isinstance(groups, list):
        return []
    return [g for g in groups if isinstance(g, str)]


def _primary_role(roles: list[str]) -> str:
    """Pick the highest-privilege role for downstream gating.

    UserORM allows multiple roles per user; the access-token claim and
    the User DTO carry a single ``role`` for simplicity. Phase 5
    rename: ``admin`` is now ``super_admin``; the fallback "no role"
    sentinel is ``workspace_member`` (the new analogue of the old
    Phase-1 ``user``).
    """
    if not roles:
        return "workspace_member"
    if "super_admin" in roles:
        return "super_admin"
    if "org_admin" in roles:
        return "org_admin"
    return roles[0]


def _orm_to_user(orm, *, role: str) -> User:
    """Project a ``UserORM`` (or any object exposing the same fields)
    into the cross-service ``User`` DTO. ``auth_provider`` is derived
    from password presence — actual identity rows live in
    ``user_identities`` and are exposed via ``/me/identities``."""
    has_pw = _has_password(orm)
    # The legacy ``auth_provider`` field is computed for backwards
    # compatibility on the DTO. 'local' means "has password" (with or
    # without additional identities); 'sso' means "no password, has at
    # least one identity"; consumers that need the actual identities
    # should call /me/identities.
    auth_provider = "local" if has_pw else "sso"

    # Pull operator-mapped extras off the metadata blob. Defensive
    # JSON parse so a malformed row never crashes /me.
    attributes: dict = {}
    try:
        import json
        meta = json.loads(getattr(orm, "metadata_", None) or "{}")
        if isinstance(meta, dict):
            raw = meta.get("attributes")
            if isinstance(raw, dict):
                attributes = {
                    str(k): v for k, v in raw.items()
                    if isinstance(k, str)
                }
    except (ValueError, TypeError):
        pass

    return User(
        id=orm.id,
        email=orm.email,
        first_name=orm.first_name,
        last_name=orm.last_name,
        chosen_display_name=getattr(orm, "display_name", None),
        role=role,
        status=orm.status,
        auth_provider=auth_provider,
        created_at=getattr(orm, "created_at", "") or "",
        updated_at=getattr(orm, "updated_at", "") or "",
        avatar_id=getattr(orm, "avatar_id", None),
        must_change_password=bool(getattr(orm, "must_change_password", False)),
        attributes=attributes,
    )
