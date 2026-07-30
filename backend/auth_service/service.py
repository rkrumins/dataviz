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

import logging
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional
from urllib.parse import quote

import jwt as pyjwt

from .core.config import (
    JWT_EXPIRY_MINUTES,
    JWT_REFRESH_EXPIRY_DAYS,
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
        auth_config_provider: Optional[AuthConfigProvider] = None,
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
        if not cfg.allow_local_login:
            raise LocalLoginDisabled()

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
            return await self._refresh_within_session(claims)
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

    async def _refresh_within_session(self, claims) -> tuple[User, SessionTokens]:
        # Mint the candidate successor before claiming. Its identity has
        # to be recorded in the same statement that consumes the
        # presented token, so a concurrent refresh that loses the race
        # can read it back instead of being treated as a thief. Minting
        # is pure CPU; if we lose, this one is simply discarded.
        successor_token, successor = create_refresh_token(
            user_id=claims.sub,
            family_id=claims.family_id,
            auth_time=claims.auth_time,
        )

        claims_extra: dict = {}
        async with self._session_factory() as session:
            store = self._refresh_store_factory(session)
            outcome = await check_and_record_rotation(
                store,
                presented_jti=claims.jti,
                presented_family=claims.family_id,
                presented_exp=claims.exp,
                successor_jti=successor.jti,
                successor_exp=successor.exp,
                successor_mint_ms=successor.mint_ms,
                grace_seconds=REFRESH_ROTATION_GRACE_SECONDS,
            )
            if outcome.status == "family_revoked":
                # Already dead — nothing to revoke, don't pay for a
                # second connection just to re-write the sentinel.
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
                    auth_time=claims.auth_time,
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

            # ── SSO daily re-auth ceiling ────────────────────────────
            # The presence of ``auth_time`` in the refresh JWT means
            # "this session was minted by an SSO login" — we don't need
            # to look at any user column for that. We DO ask the
            # identity repo for the user's most recent identity to pick
            # which provider slug to bounce to. Local password sessions
            # have ``auth_time IS NULL`` and skip this entire block.
            is_sso_session = claims.auth_time is not None
            sso_age = (
                int(time.time()) - claims.auth_time
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
                        "auth_time": claims.auth_time,
                        "elapsed_seconds": sso_age,
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
            auth_time=claims.auth_time,
            refresh_token=successor_token,
        )
        return user, tokens

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
                "from the IdP authentication. The authorize request already "
                "sends max_age, which obliges a compliant OIDC provider to "
                "return auth_time — check the provider's claim mapping.",
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
                raise SSOAuthError(decision.error or "sso_rejected")

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
            owned = asserted_fields(
                first_name=identity.first_name, last_name=identity.last_name,
                derived=identity.names_derived_from is not None,
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
            # last login. Same transaction so a failure here rolls
            # back the whole login.
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

        user = _orm_to_user(orm, role=_primary_role(roles))
        tokens = self._issue_tokens(
            user, family_id=None, claims_extra=claims_extra, auth_time=auth_time,
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
        """
        outcome: dict = {
            "email": identity.email,
            "external_id": identity.external_id,
            "first_name": identity.first_name,
            "last_name": identity.last_name,
            "groups": list(getattr(identity, "groups", ()) or ()),
            "attributes": dict(getattr(identity, "attributes", {}) or {}),
            "email_verified": _claims_email_verified(identity.raw_claims),
            "linking_policy": linking_policy,
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

        return outcome

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
            csrf_token=mint_csrf_token(),
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
