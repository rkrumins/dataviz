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
from typing import Awaitable, Callable, Optional
from urllib.parse import quote

import jwt as pyjwt

from .core.config import (
    JWT_EXPIRY_MINUTES,
    JWT_REFRESH_EXPIRY_DAYS,
    SSO_SESSION_MAX_AGE_SECONDS,
)
from .core.password import disabled_password_hash
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
        claims_resolver: Optional[Callable[..., Awaitable[dict]]] = None,
        sso_role_reconciler: Optional[Callable[..., Awaitable[dict]]] = None,
        session_killer: Optional[Callable[..., Awaitable[None]]] = None,
    ):
        self._session_factory = session_factory
        self._user_repo = user_repo
        self._user_identity_repo = user_identity_repo
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
                logger.warning(
                    "Refresh rejected (%s) for user=%s family=%s",
                    err, claims.sub, claims.family_id,
                )
                raise InvalidRefreshToken(err)

            orm = await self._user_repo.get_user_by_id(session, claims.sub)
            if orm is None or orm.deleted_at is not None or orm.status != "active":
                # User no longer eligible — kill the family and bail.
                await store.revoke_family(claims.family_id)
                raise InvalidRefreshToken("user_inactive")

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
                # bounces to the IdP. Best-effort outbox audit.
                await store.revoke_family(claims.family_id)
                if self._session_killer is not None:
                    try:
                        await self._session_killer(orm.id)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning(
                            "session_killer failed during SSO expiry "
                            "(user=%s): %s", orm.id, exc,
                        )
                provider_slug = await self._latest_identity_slug(session, orm.id)
                if self._outbox_emit is not None:
                    await self._outbox_emit(
                        session, "user.sso_session_expired",
                        {
                            "user_id": orm.id,
                            "provider_slug": provider_slug,
                            "auth_time": claims.auth_time,
                            "elapsed_seconds": sso_age,
                        },
                    )
                logger.info(
                    "SSO session expired (user=%s, slug=%s, age=%ds)",
                    orm.id, provider_slug, sso_age,
                )
                raise SsoReauthRequired(
                    _build_reauth_url(provider_slug, next_path="/"),
                    provider=provider_slug or "sso",
                )

            # ── Continuous group->target reconciliation ──────────────
            # When mappings or groups change between the previous login
            # and this refresh, derived RoleBindings / Group memberships
            # update on the next rotation rather than waiting for the
            # next full SSO login. The cached ``idp_groups`` snapshot
            # is set by ``set_user_idp_metadata`` at SSO login.
            if is_sso_session and self._sso_role_reconciler is not None:
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

        external_id = identity.external_id
        email = identity.email
        email_verified = _claims_email_verified(identity.raw_claims)
        idp_groups: list[str] = list(getattr(identity, "groups", ()) or ())
        attributes: dict = dict(getattr(identity, "attributes", {}) or {})
        auth_time = getattr(identity, "auth_time", None)
        if not isinstance(auth_time, int) or auth_time <= 0:
            auth_time = int(time.time())

        claims_extra: dict = {}
        async with self._session_factory() as session:
            # 1. Known subject (provider_id, external_id) — reuse the
            #    account it belongs to, must be active.
            existing_identity = await self._user_identity_repo.get_by_subject(
                session, provider_id=provider_id, external_id=external_id,
            )
            orm = None

            if existing_identity is not None:
                orm = await self._user_repo.get_user_by_id(
                    session, existing_identity.user_id,
                )
                if orm is None or orm.deleted_at is not None or orm.status != "active":
                    raise SSOAuthError("sso_account_inactive")
                await self._user_identity_repo.touch_last_login(
                    session, existing_identity.id,
                    metadata={"groups": idp_groups, "attributes": attributes},
                )

            # 2. Link-intent path — bind the subject to the current
            #    authenticated user. Skips the policy gate because the
            #    user just authenticated via password / another IdP
            #    moments ago to start the link.
            elif link_intent_user_id is not None:
                orm = await self._user_repo.get_user_by_id(
                    session, link_intent_user_id,
                )
                if orm is None or orm.deleted_at is not None or orm.status != "active":
                    raise SSOAuthError("link_target_inactive")
                await self._user_identity_repo.create_identity(
                    session,
                    user_id=orm.id, provider_id=provider_id,
                    external_id=external_id, email_at_link=email,
                    metadata={"groups": idp_groups, "attributes": attributes},
                )
                if self._outbox_emit is not None:
                    await self._outbox_emit(
                        session, "user.identity.linked",
                        {"user_id": orm.id, "provider_id": provider_id,
                         "external_id": external_id, "via": "self_service"},
                    )

            else:
                # 3. New subject — does the email collide with an
                #    existing account?
                by_email = await self._user_repo.get_user_by_email(session, email)
                if by_email is None:
                    if linking_policy == "disabled":
                        # Policy explicitly says "no linking" — but the
                        # email is free, so JIT-provision a fresh user.
                        # This is the same as the "strict, no
                        # collision" branch; deny only applies to the
                        # collision case below.
                        pass
                    orm = await self._user_repo.create_sso_user(
                        session,
                        email=email,
                        first_name=identity.first_name,
                        last_name=identity.last_name,
                        password_hash=disabled_password_hash(),
                    )
                    await self._user_identity_repo.create_identity(
                        session,
                        user_id=orm.id, provider_id=provider_id,
                        external_id=external_id, email_at_link=email,
                        metadata={"groups": idp_groups, "attributes": attributes},
                    )
                    if self._outbox_emit is not None:
                        await self._outbox_emit(
                            session, "user.sso_provisioned",
                            {"user_id": orm.id, "email": orm.email,
                             "provider_id": provider_id,
                             "external_id": external_id,
                             "linking_policy": linking_policy},
                        )
                else:
                    # Collision branch — apply the linking policy.
                    has_existing_identity = (
                        await self._user_identity_repo.has_any_identity(
                            session, by_email.id,
                        )
                    )
                    deny_reasons: list[str] = []
                    if linking_policy in ("manual_only", "disabled"):
                        deny_reasons.append(f"policy:{linking_policy}")
                    if not email_verified:
                        deny_reasons.append("email_unverified")
                    if by_email.status != "active":
                        deny_reasons.append(f"existing_status:{by_email.status}")
                    if by_email.deleted_at is not None:
                        deny_reasons.append("existing_deleted")
                    if (
                        linking_policy == "strict"
                        and has_existing_identity
                    ):
                        deny_reasons.append("strict_existing_sso")

                    if deny_reasons:
                        await self._emit_audit(
                            "user.sso_link_denied",
                            {"email": email, "provider_id": provider_id,
                             "external_id": external_id,
                             "reason": "unsafe_auto_link",
                             "deny_reasons": deny_reasons,
                             "linking_policy": linking_policy,
                             "email_verified": email_verified,
                             "existing_status": by_email.status,
                             "existing_has_identity": has_existing_identity},
                        )
                        raise SSOAuthError("unsafe_auto_link")

                    # Auto-link safe. Add the identity row to the
                    # existing user (no longer destructively rewriting
                    # password_hash — local + SSO can coexist when
                    # the policy allows).
                    orm = by_email
                    await self._user_identity_repo.create_identity(
                        session,
                        user_id=orm.id, provider_id=provider_id,
                        external_id=external_id, email_at_link=email,
                        metadata={"groups": idp_groups, "attributes": attributes},
                    )
                    if self._outbox_emit is not None:
                        await self._outbox_emit(
                            session, "user.sso_linked",
                            {"user_id": orm.id, "email": orm.email,
                             "provider_id": provider_id,
                             "external_id": external_id,
                             "linking_policy": linking_policy,
                             "has_password": _has_password(orm),
                             "had_existing_identity": has_existing_identity},
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
    the User DTO carry a single ``role`` for simplicity. We prefer
    ``admin`` if present, then fall back to the first role, then
    ``user``.
    """
    if not roles:
        return "user"
    if "admin" in roles:
        return "admin"
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
        role=role,
        status=orm.status,
        auth_provider=auth_provider,
        created_at=getattr(orm, "created_at", "") or "",
        updated_at=getattr(orm, "updated_at", "") or "",
        attributes=attributes,
    )
