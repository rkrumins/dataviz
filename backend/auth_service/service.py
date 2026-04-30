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
from typing import Awaitable, Callable, Optional

import jwt as pyjwt

from .core.config import (
    JWT_EXPIRY_MINUTES,
    JWT_REFRESH_EXPIRY_DAYS,
)
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
    User,
)
from .providers import ProviderCredentials, get_provider
from .refresh import check_and_record_rotation

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
    ):
        # ``user_repo`` is injected as a module so this class doesn't need
        # to import the concrete repository directly. The shape used:
        #   get_user_by_id(session, id) -> ORM | None
        #   get_user_by_email(session, email) -> ORM | None
        #   get_user_roles(session, id) -> list[str]
        #
        # ``claims_resolver`` (RBAC Phase 1) is an optional callable
        # ``(session, user_id, *, sid) -> dict`` that returns the
        # permission claim payload to embed in the access JWT. The
        # auth service doesn't know the shape of the dict — it only
        # forwards it to ``create_access_token(extra=...)``. When None,
        # tokens carry only identity (no permission claims), preserving
        # pre-Phase-1 behaviour.
        self._session_factory = session_factory
        self._user_repo = user_repo
        self._refresh_store_factory = refresh_store_factory
        self._outbox_emit = outbox_emit
        self._claims_resolver = claims_resolver

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
            roles = await self._user_repo.get_user_roles(session, orm.id)

            if self._claims_resolver is not None:
                # Refresh re-resolves claims so a binding/group change made
                # since the previous access token still rolls forward on
                # the next rotation, even if the revocation set has expired.
                claims_extra = await self._claims_resolver(session, orm.id)

        user = _orm_to_user(orm, role=_primary_role(roles))
        tokens = self._issue_tokens(user, family_id=claims.family_id, claims_extra=claims_extra)
        return user, tokens

    async def get_user(self, user_id: str) -> Optional[User]:
        async with self._session_factory() as session:
            orm = await self._user_repo.get_user_by_id(session, user_id)
            if orm is None or orm.deleted_at is not None:
                return None
            roles = await self._user_repo.get_user_roles(session, orm.id)
        return _orm_to_user(orm, role=_primary_role(roles))

    # ── Internals ─────────────────────────────────────────────────────

    def _issue_tokens(
        self,
        user: User,
        *,
        family_id: Optional[str],
        claims_extra: Optional[dict] = None,
    ) -> SessionTokens:
        access = create_access_token(
            user_id=user.id,
            email=user.email,
            role=user.role,
            extra=claims_extra or None,
        )
        refresh, _ = create_refresh_token(user_id=user.id, family_id=family_id)
        return SessionTokens(
            access_token=access,
            access_max_age_seconds=JWT_EXPIRY_MINUTES * 60,
            refresh_token=refresh,
            refresh_max_age_seconds=JWT_REFRESH_EXPIRY_DAYS * 24 * 60 * 60,
            csrf_token=mint_csrf_token(),
        )


# ── Helpers ──────────────────────────────────────────────────────────

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
