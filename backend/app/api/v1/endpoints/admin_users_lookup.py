"""Admin user lookup + free-text search (Phase 4).

Two endpoints mounted at ``/api/v1/admin/users``:

  * ``GET /lookup?mode=email|identity|attribute&...`` — structured
    single-result lookup. The three modes hit dedicated indexes:
    ``uq_users_email`` (mode=email),
    ``uq_user_identities_provider_subject`` (mode=identity), and
    ``idx_user_external_attributes_key_value`` (mode=attribute).

  * ``GET /search?q=...&limit=20`` — free-text fan-out across email,
    first/last name, identity external_id, and the indexed external
    attribute values. Results are deduped on user_id and the
    response includes a small ``matchedOn`` array per row so the
    admin UI can highlight which field matched.

Both endpoints require ``system:admin``. Response shape is shared
(:class:`UserSummary`) so consumers can switch between modes
seamlessly.
"""
from __future__ import annotations

import logging
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import (
    idp_provider_repo,
    user_attribute_repo,
    user_identity_repo,
    user_repo,
)
from backend.auth_service.core.password import is_password_set
from backend.auth_service.interface import User

logger = logging.getLogger(__name__)

router = APIRouter()


# ── DTOs ──────────────────────────────────────────────────────────────


class ProviderRef(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    slug: str
    display_name: str = Field(alias="displayName")
    kind: str


class IdentityRef(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    id: str
    provider: ProviderRef
    external_id: str = Field(alias="externalId")
    email_at_link: Optional[str] = Field(default=None, alias="emailAtLink")
    created_at: str = Field(alias="createdAt")
    last_login_at: Optional[str] = Field(default=None, alias="lastLoginAt")


class AttributeRef(BaseModel):
    """One indexed claim attribute on a user."""
    model_config = ConfigDict(populate_by_name=True)
    key: str
    value: str
    source_provider: Optional[ProviderRef] = Field(default=None, alias="sourceProvider")
    set_at: str = Field(alias="setAt")


class UserSummary(BaseModel):
    """Shared response shape for /lookup and /search results.

    Carries enough to render an admin user-detail panel directly
    (signup source + provider, password state, identities,
    attributes). The auth_audit_log carries the time-series detail
    if the operator needs to drill in further."""
    model_config = ConfigDict(populate_by_name=True)
    id: str
    email: str
    first_name: str = Field(alias="firstName")
    last_name: str = Field(alias="lastName")
    status: str
    signup_source: str = Field(alias="signupSource")
    signup_provider: Optional[ProviderRef] = Field(default=None, alias="signupProvider")
    signup_at: str = Field(alias="signupAt")
    password_set: bool = Field(alias="passwordSet")
    identities: list[IdentityRef] = Field(default_factory=list)
    attributes: list[AttributeRef] = Field(default_factory=list)
    matched_on: Optional[list[str]] = Field(default=None, alias="matchedOn")


# ── Resolution helpers ───────────────────────────────────────────────


async def _provider_ref(
    session: AsyncSession, provider_id: Optional[str],
) -> Optional[ProviderRef]:
    if not provider_id:
        return None
    p = await idp_provider_repo.get_provider(session, provider_id)
    if p is None:
        return None
    return ProviderRef(
        id=p.id, slug=p.slug, display_name=p.display_name, kind=p.kind,
    )


async def _summarise(
    session: AsyncSession, user_orm, *, matched_on: Optional[list[str]] = None,
) -> UserSummary:
    identities_orm = await user_identity_repo.list_for_user(session, user_orm.id)
    identities: list[IdentityRef] = []
    for ident in identities_orm:
        provider = await _provider_ref(session, ident.provider_id)
        if provider is None:
            continue
        identities.append(IdentityRef(
            id=ident.id,
            provider=provider,
            external_id=ident.external_id,
            email_at_link=ident.email_at_link,
            created_at=ident.created_at,
            last_login_at=ident.last_login_at,
        ))

    attrs_orm = await user_attribute_repo.list_for_user(session, user_orm.id)
    attrs: list[AttributeRef] = []
    for a in attrs_orm:
        source = await _provider_ref(session, a.source_provider_id)
        attrs.append(AttributeRef(
            key=a.key, value=a.value, source_provider=source, set_at=a.set_at,
        ))

    signup_provider = await _provider_ref(
        session, getattr(user_orm, "signup_provider_id", None),
    )

    return UserSummary(
        id=user_orm.id,
        email=user_orm.email,
        first_name=user_orm.first_name,
        last_name=user_orm.last_name,
        status=user_orm.status,
        signup_source=getattr(user_orm, "signup_source", "local_signup"),
        signup_provider=signup_provider,
        signup_at=user_orm.created_at,
        password_set=is_password_set(user_orm.password_hash),
        identities=identities,
        attributes=attrs,
        matched_on=matched_on,
    )


# ── Structured lookup ────────────────────────────────────────────────


@router.get("/lookup", response_model=UserSummary, response_model_by_alias=True)
async def lookup_user(
    mode: Literal["email", "identity", "attribute"] = Query(...),
    value: Optional[str] = Query(default=None),
    provider_slug: Optional[str] = Query(default=None, alias="providerSlug"),
    external_id: Optional[str] = Query(default=None, alias="externalId"),
    attribute_key: Optional[str] = Query(default=None, alias="attributeKey"),
    attribute_value: Optional[str] = Query(default=None, alias="attributeValue"),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Exact-match lookup, one user or 404.

    Modes:
      * ``email`` — requires ``value`` (the email to match).
      * ``identity`` — requires ``providerSlug`` + ``externalId``.
      * ``attribute`` — requires ``attributeKey`` + ``attributeValue``;
        hits the (key, value) composite index.
    """
    if mode == "email":
        if not value:
            raise HTTPException(400, "value is required for mode=email")
        user = await user_repo.get_user_by_email(session, value)
        if user is None:
            raise HTTPException(404, "user not found")
        return await _summarise(session, user, matched_on=["email"])

    if mode == "identity":
        if not provider_slug or not external_id:
            raise HTTPException(
                400, "providerSlug and externalId are required for mode=identity",
            )
        provider = await idp_provider_repo.get_provider_by_slug(
            session, provider_slug,
        )
        if provider is None:
            raise HTTPException(404, "provider not found")
        ident = await user_identity_repo.get_by_subject(
            session, provider_id=provider.id, external_id=external_id,
        )
        if ident is None:
            raise HTTPException(404, "identity not found")
        user = await user_repo.get_user_by_id(session, ident.user_id)
        if user is None:
            raise HTTPException(404, "user not found")
        return await _summarise(session, user, matched_on=["identity"])

    # mode == "attribute"
    if not attribute_key or not attribute_value:
        raise HTTPException(
            400, "attributeKey and attributeValue are required for mode=attribute",
        )
    rows = await user_attribute_repo.get_users_by_attribute(
        session, key=attribute_key, value=attribute_value, limit=2,
    )
    if not rows:
        raise HTTPException(404, "no user matches that attribute")
    if len(rows) > 1:
        # Ambiguous result: bail with a 409 so the caller knows to
        # narrow further (e.g. include the provider in the search).
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{len(rows)} users have {attribute_key}={attribute_value} — "
            "use /search for the ambiguous case.",
        )
    user = await user_repo.get_user_by_id(session, rows[0].user_id)
    if user is None:
        raise HTTPException(404, "user not found")
    return await _summarise(
        session, user, matched_on=[f"attribute:{attribute_key}"],
    )


# ── Free-text fan-out search ────────────────────────────────────────


@router.get(
    "/search",
    response_model=list[UserSummary],
    response_model_by_alias=True,
)
async def search_users(
    q: str = Query("", max_length=200),
    limit: int = Query(default=20, ge=1, le=100),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Fan-out across users.email, users.first/last name, identity
    external_id, and indexed external attribute values. Dedupes on
    user_id; ``matchedOn`` records every dimension that matched.

    Empty or whitespace-only ``q`` short-circuits to an empty list —
    the SSO admin page hits this endpoint with ``q=`` on mount before
    the user has typed anything; rejecting that with 422 just adds
    UI noise.
    """
    needle = (q or "").strip()
    if not needle:
        return []

    # The four scans run sequentially against the request's single
    # AsyncSession. SQLAlchemy refuses concurrent ``execute`` calls
    # on one session (``InvalidRequestError: concurrent operations
    # are not permitted``); ``asyncio.gather`` here used to crash
    # 500. A single typeahead is fast enough sequentially that this
    # isn't worth fanning out across separate sessions.
    by_user = await user_repo.search_users(session, q=needle, limit=limit)
    by_identity = await _search_by_identity_external_id(
        session, q=needle, limit=limit,
    )
    by_attr_exact = await user_attribute_repo.get_users_by_attribute(
        session, key="", value="", limit=limit,
    )
    by_attr_substr = await user_attribute_repo.search_users_by_attribute_substring(
        session, needle=needle, limit=limit,
    )
    # by_attr_exact above is intentionally an empty list (we don't
    # know which key to match exactly during fan-out); the substring
    # path covers the user-friendly "type a number" case.

    matched_user_ids: dict[str, set[str]] = {}
    for u in by_user:
        matched_user_ids.setdefault(u.id, set()).add("email/name")
    for ident in by_identity:
        matched_user_ids.setdefault(ident.user_id, set()).add("identity")
    for attr in by_attr_substr:
        matched_user_ids.setdefault(attr.user_id, set()).add(
            f"attribute:{attr.key}"
        )

    out: list[UserSummary] = []
    for user_id, kinds in matched_user_ids.items():
        if len(out) >= limit:
            break
        u = await user_repo.get_user_by_id(session, user_id)
        if u is None:
            continue
        out.append(await _summarise(session, u, matched_on=sorted(kinds)))
    return out


async def _search_by_identity_external_id(
    session: AsyncSession, *, q: str, limit: int,
) -> list:
    """Identity external_id search. The Phase 3 ``user_identity_repo``
    doesn't expose this directly; we inline the SQL here so the
    fan-out lives in one place."""
    from sqlalchemy import select
    from backend.app.db.models import UserIdentityORM
    needle = f"%{q.strip()}%"
    res = await session.execute(
        select(UserIdentityORM)
        .where(UserIdentityORM.external_id.ilike(needle))
        .limit(limit)
    )
    return list(res.scalars().all())
