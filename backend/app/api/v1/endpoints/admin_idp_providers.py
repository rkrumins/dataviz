"""Admin CRUD: ``idp_providers``.

Mounted at ``/api/v1/admin/idp-providers``. Every endpoint requires
``system:admin``. The ``settings`` field in the response is always
redacted — operators rotate secrets through the dedicated PATCH
endpoint, not by reading the existing value back. The ``/test``
endpoint runs the claim mapper against a paste-in claims blob so
admins can iterate on the mapping config without involving real users.
"""
from __future__ import annotations

import logging
from typing import Optional
from urllib.parse import quote

from fastapi import (
    APIRouter, Body, Depends, HTTPException, Path, Request, Response, status,
)
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import (
    backchannel_host_repo, idp_provider_repo, user_repo,
)
from backend.app.db.repositories.idp_provider_repo import (
    ProviderValidationError,
)
from backend.auth_service.cookies import set_dryrun_cookie
from backend.auth_service.core.tokens import create_dryrun_token
from backend.auth_service.interface import User
from backend.auth_service.providers import (
    ASSURANCE_DESCRIPTIONS,
    assurance_for,
    apply_claim_mapping,
    ClaimMappingError,
    KIND_DEFAULTS,
    PROVIDER_BUILDERS,
    ProviderConfigSnapshot,
    get_registry,
    resolved_sources,
)
from backend.auth_service.providers.backchannel import BackchannelConfigError
from backend.auth_service.providers.custom_profile import (
    CustomProfileConfigError,
)
from backend.auth_service.providers.oidc import OidcError, discover_issuer

# SAML metadata import is best-effort for the same reason the provider
# itself is: an image without libxmlsec1 must still serve the rest of this
# router. The endpoint reports the capability as missing rather than 500ing.
try:
    from backend.auth_service.providers.saml2 import (  # type: ignore
        fetch_idp_metadata,
        parse_idp_metadata,
    )
except ImportError:  # pragma: no cover - missing system dep
    fetch_idp_metadata = None  # type: ignore[assignment]
    parse_idp_metadata = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

router = APIRouter()


# ── DTOs ──────────────────────────────────────────────────────────────


class ProviderDTO(BaseModel):
    """Public-safe view of a provider row. ``settings`` is redacted
    (secret fields show ``********``); the operator-defined
    ``claim_mapping`` is exposed verbatim because it contains no
    secrets."""
    model_config = ConfigDict(populate_by_name=True, from_attributes=True)

    id: str
    slug: str
    display_name: str = Field(alias="displayName")
    kind: str
    enabled: bool
    priority: int
    settings: dict
    claim_mapping: dict = Field(alias="claimMapping")
    linking_policy: str = Field(alias="linkingPolicy")
    button_label: Optional[str] = Field(default=None, alias="buttonLabel")
    button_icon: Optional[str] = Field(default=None, alias="buttonIcon")
    # Derived from kind + settings on every read, never stored — a column
    # would drift the moment an operator edits settings. See
    # ``auth_service/providers/assurance.py``.
    assurance: str
    assurance_reason: str = Field(alias="assuranceReason")
    # Domains routed here by email-first login. Plaintext, no secrets.
    email_domains: list[str] = Field(default_factory=list, alias="emailDomains")
    # Whether an assertion has been captured, NOT its contents — those
    # come from a dedicated endpoint so they cannot leak by someone
    # adding a field to this response.
    last_assertion_at: Optional[str] = Field(default=None, alias="lastAssertionAt")
    # Readiness: a draft reaches no public surface until it is published.
    # Distinct from ``enabled``, which is the operational switch.
    lifecycle: str = "draft"
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")


class CreateProviderRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    slug: str
    display_name: str = Field(alias="displayName")
    kind: str
    settings: dict = Field(default_factory=dict)
    claim_mapping: dict = Field(default_factory=dict, alias="claimMapping")
    linking_policy: str = Field(default="strict", alias="linkingPolicy")
    priority: int = 100
    enabled: bool = True
    button_label: Optional[str] = Field(default=None, alias="buttonLabel")
    button_icon: Optional[str] = Field(default=None, alias="buttonIcon")
    email_domains: Optional[list[str]] = Field(default=None, alias="emailDomains")


class UpdateProviderRequest(BaseModel):
    """Partial-update body. Pass only the fields you want to change;
    ``settings`` is merged into the existing encrypted blob (use a
    ``None`` value to remove a key)."""
    model_config = ConfigDict(populate_by_name=True)
    display_name: Optional[str] = Field(default=None, alias="displayName")
    enabled: Optional[bool] = None
    priority: Optional[int] = None
    settings: Optional[dict] = None
    claim_mapping: Optional[dict] = Field(default=None, alias="claimMapping")
    linking_policy: Optional[str] = Field(default=None, alias="linkingPolicy")
    button_label: Optional[str] = Field(default=None, alias="buttonLabel")
    button_icon: Optional[str] = Field(default=None, alias="buttonIcon")
    email_domains: Optional[list[str]] = Field(default=None, alias="emailDomains")


class DiscoverRequest(BaseModel):
    """Body for ``POST /admin/idp-providers/discover``.

    One of ``issuer`` (OIDC), ``metadataUrl`` or ``metadataXml`` (SAML).
    Nothing is persisted — this fills a form, it does not create a row.
    """
    model_config = ConfigDict(populate_by_name=True)
    kind: str
    issuer: Optional[str] = None
    metadata_url: Optional[str] = Field(default=None, alias="metadataUrl")
    metadata_xml: Optional[str] = Field(default=None, alias="metadataXml")


class DiscoverResult(BaseModel):
    """Structured outcome. A probe failure is ``success=False`` with an
    ``error``, never an exception — mirroring the data-source
    ``/test-connection`` contract, because "your IdP is unreachable" is an
    answer, not a server fault."""
    model_config = ConfigDict(populate_by_name=True)
    success: bool
    settings: dict = Field(default_factory=dict)
    metadata: dict = Field(default_factory=dict)
    warnings: list[str] = Field(default_factory=list)
    error: Optional[str] = None


class TestMappingRequest(BaseModel):
    """Body for ``POST /admin/idp-providers/{id}/test``.

    ``claims`` is the IdP-asserted blob — paste in a real id_token
    payload or SAML attribute statement. ``override`` lets admins
    preview a mapping change without saving."""
    model_config = ConfigDict(populate_by_name=True)
    claims: dict
    override: Optional[dict] = None


class PreviewMappingRequest(BaseModel):
    """Body for ``POST /admin/idp-providers/preview-mapping``.

    The provider-less twin of :class:`TestMappingRequest`. ``kind`` picks
    the default mapping to merge ``override`` onto; ``slug`` only names the
    connection in an error message, so it is optional while the operator is
    still deciding what to call it."""
    model_config = ConfigDict(populate_by_name=True)
    kind: str
    claims: dict
    override: Optional[dict] = None
    slug: Optional[str] = None


def _to_dto(row) -> ProviderDTO:
    settings = idp_provider_repo.decrypt_settings(row.settings)
    level = assurance_for(row.kind, settings)
    return ProviderDTO(
        assurance=level,
        assurance_reason=ASSURANCE_DESCRIPTIONS.get(level, ""),
        email_domains=idp_provider_repo.parse_email_domains(row),
        last_assertion_at=getattr(row, "last_assertion_at", None),
        lifecycle=getattr(row, "lifecycle", "live"),
        id=row.id,
        slug=row.slug,
        display_name=row.display_name,
        kind=row.kind,
        enabled=bool(row.enabled),
        priority=int(row.priority or 100),
        settings=idp_provider_repo.redact_settings(settings),
        claim_mapping=idp_provider_repo.parse_claim_mapping(row),
        linking_policy=row.linking_policy,
        button_label=row.button_label,
        button_icon=row.button_icon,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


# ── Endpoints ─────────────────────────────────────────────────────────


@router.get("", response_model=list[ProviderDTO], response_model_by_alias=True)
async def list_providers(
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    rows = await idp_provider_repo.list_providers(session)
    return [_to_dto(r) for r in rows]


@router.get("/defaults/{kind}")
async def get_default_mapping(
    kind: str = Path(...),
    _admin: User = Depends(requires("system:admin")),
):
    """Return the default claim mapping for a kind so the admin UI can
    pre-fill the editor when an operator starts a fresh provider."""
    # ``KIND_DEFAULTS`` rather than a local copy of it. The copy that
    # used to live here was a fifth place a new provider kind had to be
    # registered, and the only one where forgetting produced a 404 from
    # a route the admin UI calls on every "new provider" click.
    mapping = KIND_DEFAULTS.get(kind)
    if mapping is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown kind")
    return mapping


@router.get("/status")
async def provider_health_status(
    request: Request,
    _admin: User = Depends(requires("system:admin")),
):
    """Last known health for every enabled provider.

    Reads the background sweep's cache and does **NO outbound work** — the
    same contract ``providers.py:/status`` states for data sources, and for
    the same reason: this is polled, and a polled endpoint that opens
    sockets turns a dashboard into a load generator.

    An empty result means the sweep has not run yet (or this replica does
    not run schedulers), not that every provider is unhealthy.
    """
    cache = getattr(request.app.state, "idp_health_cache", None) or {}
    return {
        "providers": [
            {
                "providerId": h.provider_id,
                "slug": h.slug,
                "status": h.status,
                "detail": h.detail,
                "certNotAfter": h.cert_not_after,
                "certDaysRemaining": h.cert_days_remaining,
                "checkedAt": h.checked_at,
            }
            for h in cache.values()
        ],
    }


# ── Back-channel host allowlist ──────────────────────────────────────
#
# The exception list for the outbound SSRF guard, which otherwise
# refuses every private address. A back-channel identity gateway is on
# RFC1918 by definition, so without this the kind has no reachable
# destination at all.
#
# Gated on ``system:sso:hosts:manage`` rather than ``system:admin``,
# because an entry lets this service make requests to an internal
# address. Who may edit the list is a network decision and worth
# granting on its own; the permission is also fail-closed, so an
# unreachable revocation backend refuses these routes rather than
# assuming the session is still good.
#
# What no entry can do — reach loopback, link-local or the cloud
# metadata service — is enforced in ``providers/outbound.py``, not here.
# It must not be possible to talk this endpoint into it.
#
# Declared ahead of the ``/{provider_id}`` routes so the literal path
# segment is matched before the parameterised one.


class BackchannelHostDTO(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    host: str
    port: int
    note: Optional[str] = None
    created_at: Optional[str] = Field(default=None, alias="createdAt")
    created_by: Optional[str] = Field(default=None, alias="createdBy")


class BackchannelHostCreate(BaseModel):
    host: str
    port: int = 443
    note: Optional[str] = None


def _host_dto(row) -> BackchannelHostDTO:
    return BackchannelHostDTO(
        id=row.id, host=row.host, port=row.port, note=row.note,
        created_at=row.created_at, created_by=row.created_by,
    )


@router.get("/backchannel-hosts", response_model=list[BackchannelHostDTO],
            response_model_by_alias=True)
async def list_backchannel_hosts(
    session: AsyncSession = Depends(get_db_session),
    _admin: User = Depends(requires("system:sso:hosts:manage")),
):
    """Every internal destination a back-channel provider may call."""
    rows = await backchannel_host_repo.list_hosts(session)
    return [_host_dto(r) for r in rows]


@router.post("/backchannel-hosts", response_model=BackchannelHostDTO,
             response_model_by_alias=True,
             status_code=status.HTTP_201_CREATED)
async def add_backchannel_host(
    body: BackchannelHostCreate,
    session: AsyncSession = Depends(get_db_session),
    admin: User = Depends(requires("system:sso:hosts:manage")),
):
    """Permit one ``host:port``.

    Idempotent: adding an entry that already exists returns it rather
    than 409-ing. Two operators allowing the same gateway is not a
    conflict anyone needs to resolve.
    """
    try:
        row = await backchannel_host_repo.add_host(
            session, host=body.host, port=body.port, note=body.note,
            created_by=admin.id,
        )
    except backchannel_host_repo.BackchannelHostError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))

    await user_repo.create_outbox_event(
        session, event_type="sso.backchannel_host_allowed",
        payload={
            "host": row.host, "port": row.port, "note": row.note,
            "actor_id": admin.id,
        },
    )
    await session.commit()
    return _host_dto(row)


@router.delete("/backchannel-hosts/{host_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def delete_backchannel_host(
    host_id: str,
    session: AsyncSession = Depends(get_db_session),
    admin: User = Depends(requires("system:sso:hosts:manage")),
):
    """Withdraw one entry.

    Takes effect on the next login rather than on a cache TTL — the
    allowlist is read per request precisely so that revoking a
    destination is immediate.
    """
    rows = await backchannel_host_repo.list_hosts(session)
    row = next((r for r in rows if r.id == host_id), None)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such host entry")

    host, port = row.host, row.port
    await backchannel_host_repo.delete_host(session, host_id)
    await user_repo.create_outbox_event(
        session, event_type="sso.backchannel_host_withdrawn",
        payload={"host": host, "port": port, "actor_id": admin.id},
    )
    await session.commit()
    return None


@router.post("/discover", response_model=DiscoverResult,
             response_model_by_alias=True)
async def discover_provider_settings(
    body: DiscoverRequest,
    _admin: User = Depends(requires("system:admin")),
):
    """Derive provider settings from the IdP's own published configuration.

    Standing up an IdP meant hand-transcribing ~15 fields — issuer URLs,
    entity ids, a base64 signing certificate — from one console into
    another. Every one of those is a chance to introduce a typo that
    surfaces days later as an opaque login failure. Both protocols publish
    this information; this reads it.

    Never persists, and never invents secrets: ``client_id`` /
    ``client_secret`` are the operator's to supply.
    """
    kind = (body.kind or "").strip()

    if kind == "oidc":
        if not body.issuer:
            raise HTTPException(
                status.HTTP_400_BAD_REQUEST,
                "issuer is required to discover an OIDC provider",
            )
        try:
            found = await discover_issuer(body.issuer)
        except OidcError as exc:
            return DiscoverResult(success=False, error=str(exc))
        except Exception as exc:  # noqa: BLE001 — a probe never 500s
            logger.warning("OIDC discovery failed (%s): %s", body.issuer, exc)
            return DiscoverResult(success=False, error=str(exc))
        return DiscoverResult(success=True, **found)

    if kind == "saml2":
        if parse_idp_metadata is None:
            return DiscoverResult(
                success=False,
                error="SAML support is not available in this deployment.",
            )
        xml = body.metadata_xml
        if not xml:
            if not body.metadata_url:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST,
                    "metadataUrl or metadataXml is required to discover a "
                    "SAML provider",
                )
            try:
                xml = await fetch_idp_metadata(body.metadata_url)
            except Exception as exc:  # noqa: BLE001 — a probe never 500s
                return DiscoverResult(success=False, error=str(exc))
        try:
            found = parse_idp_metadata(xml)
        except Exception as exc:  # noqa: BLE001
            return DiscoverResult(success=False, error=str(exc))
        return DiscoverResult(success=True, **found)

    raise HTTPException(
        status.HTTP_400_BAD_REQUEST,
        f"discovery is not available for kind '{kind}'. Only 'oidc' and "
        "'saml2' publish their configuration.",
    )


#: Errors a provider builder raises when the ROW is wrong rather than the
#: code. Each one already carries the sentence an operator needs — which
#: field is missing, which combination cannot work — so the only job here
#: is to let it reach them.
_CONFIG_ERRORS = (BackchannelConfigError, CustomProfileConfigError)


def _assert_settings_usable(
    *, kind: str, settings: dict, claim_mapping: dict | None = None,
    linking_policy: str = "strict", require_settings: bool = False,
) -> None:
    """Build a provider from *settings* and turn a config error into a 400.

    Until this existed, a bad settings blob was stored happily and first
    surfaced when somebody tried to sign in — as ``500 Internal server
    error``, because ``_resolve_provider`` does not catch a builder
    failure. The message explaining exactly what was wrong had already
    been written by the builder's own ``validate_settings`` and thrown
    away.

    Called BEFORE the write, on the settings that would be stored — for
    an update that means the caller merges first, because
    ``update_provider`` merges and judging the submitted fragment would
    judge half a configuration. Validating first rather than writing and
    relying on the request's rollback keeps the guarantee in this
    function instead of in the session's error handling.

    An empty blob passes unless *require_settings*: a row can
    legitimately be created as a placeholder and filled in afterwards,
    which is how every kind without discovery is set up. Publishing is
    where that stops being acceptable.
    """
    builder = PROVIDER_BUILDERS.get(kind)
    if builder is None:
        return
    if not settings and not require_settings:
        return
    snapshot = ProviderConfigSnapshot(
        id="pending", slug="pending", display_name="pending", kind=kind,
        enabled=True, priority=100, settings=settings or {},
        claim_mapping=claim_mapping or {}, linking_policy=linking_policy,
        button_label=None, button_icon=None,
    )
    try:
        builder(snapshot)
    except _CONFIG_ERRORS as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    # Anything else is a bug in the builder rather than a bad row, and
    # is left to surface as a 500 rather than being reported to an
    # operator as their mistake.


@router.post(
    "",
    response_model=ProviderDTO,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_provider(
    body: CreateProviderRequest,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    _assert_settings_usable(
        kind=body.kind, settings=body.settings or {},
        claim_mapping=body.claim_mapping,
        linking_policy=body.linking_policy or "strict",
    )
    try:
        row = await idp_provider_repo.create_provider(
            session,
            slug=body.slug,
            display_name=body.display_name,
            kind=body.kind,
            settings=body.settings,
            claim_mapping=body.claim_mapping,
            linking_policy=body.linking_policy,
            priority=body.priority,
            enabled=body.enabled,
            button_label=body.button_label,
            button_icon=body.button_icon,
            email_domains=body.email_domains,
            # A provider a human just created is configured, not proved: it
            # stays invisible until they publish it. The repo defaults to
            # "live" for the boot seeder's benefit, so the policy is stated
            # here, where the actor is an operator.
            lifecycle="draft",
            created_by=admin.id,
        )
    except ProviderValidationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    except IntegrityError:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"A provider with slug '{body.slug}' already exists",
        )
    await user_repo.create_outbox_event(
        session, event_type="idp.provider.created",
        payload={"provider_id": row.id, "slug": row.slug, "kind": row.kind,
                 "actor_id": admin.id},
    )
    # Bust the registry cache so the new provider is live immediately.
    try:
        await get_registry().invalidate(row.id)
    except RuntimeError:
        pass
    return _to_dto(row)


@router.patch(
    "/{provider_id}",
    response_model=ProviderDTO,
    response_model_by_alias=True,
)
async def update_provider(
    provider_id: str,
    body: UpdateProviderRequest,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    if body.settings is not None:
        # The repo MERGES settings into what is stored, so the whole
        # merged result is what has to be judged — an edit that empties
        # one required field looks harmless as a fragment.
        existing = await idp_provider_repo.get_provider(session, provider_id)
        if existing is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
        _assert_settings_usable(
            kind=existing.kind,
            settings={
                **idp_provider_repo.decrypt_settings(existing.settings),
                **body.settings,
            },
            claim_mapping=(
                body.claim_mapping
                if body.claim_mapping is not None
                else idp_provider_repo.parse_claim_mapping(existing)
            ),
            linking_policy=body.linking_policy or existing.linking_policy,
        )
    try:
        row = await idp_provider_repo.update_provider(
            session,
            provider_id,
            display_name=body.display_name,
            enabled=body.enabled,
            priority=body.priority,
            settings=body.settings,
            claim_mapping=body.claim_mapping,
            linking_policy=body.linking_policy,
            button_label=body.button_label,
            button_icon=body.button_icon,
            email_domains=body.email_domains,
            updated_by=admin.id,
        )
    except ProviderValidationError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    await user_repo.create_outbox_event(
        session, event_type="idp.provider.updated",
        payload={"provider_id": row.id, "slug": row.slug, "actor_id": admin.id,
                 "fields": [k for k, v in body.model_dump().items() if v is not None]},
    )
    try:
        await get_registry().invalidate(row.id)
    except RuntimeError:
        pass
    return _to_dto(row)


@router.delete("/{provider_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_provider(
    provider_id: str,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    row = await idp_provider_repo.get_provider(session, provider_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    try:
        ok = await idp_provider_repo.delete_provider(session, provider_id)
    except IntegrityError:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Provider has linked user identities — unlink them first",
        )
    if not ok:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    await user_repo.create_outbox_event(
        session, event_type="idp.provider.deleted",
        payload={"provider_id": provider_id, "slug": row.slug,
                 "actor_id": admin.id},
    )
    try:
        await get_registry().invalidate(provider_id)
    except RuntimeError:
        pass
    return None


class EndSessionsRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    dry_run: bool = Field(default=False, alias="dryRun")


class EndSessionsResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    provider_id: str = Field(alias="providerId")
    users_affected: int = Field(alias="usersAffected")
    tokens_revoked: int = Field(alias="tokensRevoked")
    dry_run: bool = Field(alias="dryRun")


@router.post("/{provider_id}/end-sessions", response_model=EndSessionsResponse,
             response_model_by_alias=True)
async def end_provider_sessions(
    provider_id: str,
    body: EndSessionsRequest = Body(default=EndSessionsRequest()),
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """End every session minted through this connection.

    The deliberate lever the disable switch does not pull: turning a
    connection off stops new sign-ins (and, for a back-channel row, its
    liveness re-checks — "an operator action about future logins"), but
    the people already signed in keep their sessions until the ceilings
    fire. This ends them now — refresh families revoked at the row,
    live access tokens tombstoned — while password sessions the same
    people hold elsewhere survive untouched.

    Works whatever ``enabled``/``lifecycle`` say, because the designed
    order is "turn it off, then end its sessions" — and it must also
    work for a row disabled long ago. ``dryRun`` answers the count a
    confirm dialog shows; under concurrent sign-ins it can drift from
    the real sweep, whose response carries the actual numbers.
    """
    row = await idp_provider_repo.get_provider(session, provider_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")

    from backend.app.db.repositories import refresh_token_repo
    from backend.app.services.revocation_service import (
        revoke_provider_sessions,
    )

    if body.dry_run:
        users = await refresh_token_repo.count_active_provider_users(
            session, provider_id=provider_id,
        )
        return EndSessionsResponse(
            provider_id=provider_id, users_affected=users,
            tokens_revoked=0, dry_run=True,
        )

    outcome = await revoke_provider_sessions(
        provider_id, session=session,
        reason=f"provider_sessions_ended:{row.slug}",
    )
    await user_repo.create_outbox_event(
        session, event_type="idp.provider.sessions_ended",
        payload={
            "provider_id": provider_id, "slug": row.slug,
            "actor_id": admin.id,
            "users_affected": outcome["users"],
            "tokens_revoked": outcome["tokens"],
        },
    )
    return EndSessionsResponse(
        provider_id=provider_id, users_affected=outcome["users"],
        tokens_revoked=outcome["tokens"], dry_run=False,
    )


@router.post("/{provider_id}/test")
async def test_provider_mapping(
    provider_id: str,
    body: TestMappingRequest = Body(...),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Dry-run the configured (or overridden) claim mapping against a
    paste-in claims blob. Returns the resolved fields — including any
    ``extras`` — without persisting anything. Useful for debugging
    "why isn't department coming through?" without dragging in an end
    user."""
    row = await idp_provider_repo.get_provider(session, provider_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    override = (
        body.override if body.override is not None
        else idp_provider_repo.parse_claim_mapping(row)
    )
    result = _resolve_preview(
        body.claims, kind=row.kind, slug=row.slug, override=override,
    )
    result["providerId"] = provider_id
    return result


@router.post("/preview-mapping")
async def preview_claim_mapping(
    body: PreviewMappingRequest = Body(...),
    _admin: User = Depends(requires("system:admin")),
):
    """Resolve a mapping that has no provider row behind it yet.

    ``/{provider_id}/test`` needs a saved row, which meant the setup
    wizard's mapping step — the one place an operator is actively *writing*
    a mapping — could not preview at all: the draft is not created until
    the rehearse step that follows it. So the guidance said "here is what
    your IdP would produce" while the button sat disabled.

    Nothing here reads the database. The row was only ever supplying
    ``kind`` and ``slug``, and both are known before a row exists — ``kind``
    from the vendor tile, ``slug`` only to name the provider in an error
    message.
    """
    return _resolve_preview(
        body.claims, kind=body.kind,
        slug=body.slug or "this connection", override=body.override,
    )


def _resolve_preview(
    claims: dict, *, kind: str, slug: str, override: Optional[dict],
) -> dict:
    """Shared body of the two preview routes: resolve, and say where each
    field came from. One implementation so the saved and unsaved paths
    cannot answer the same question differently."""
    try:
        identity = apply_claim_mapping(
            claims, kind=kind, provider_slug=slug, override=override,
        )
    except ClaimMappingError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
    return {
        "providerSlug": slug,
        "resolved": {
            "external_id": identity.external_id,
            "email": identity.email,
            "first_name": identity.first_name,
            "last_name": identity.last_name,
            "groups": list(identity.groups),
            "auth_time": identity.auth_time,
            "attributes": identity.attributes,
        },
        "resolvedFrom": resolved_sources(claims, kind=kind, override=override),
        # Names the IdP did not name itself. `resolvedFrom` reports null
        # for both in that case — truthfully, since no candidate of theirs
        # fired — and without this the screen would show "nothing
        # resolved" beside two populated values.
        "namesDerivedFrom": identity.names_derived_from,
    }


@router.post("/{provider_id}/publish", response_model=ProviderDTO,
             response_model_by_alias=True)
async def publish_provider(
    provider_id: str,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Promote a draft provider to live — the moment it becomes visible on
    the login page for every user.

    Separate from ``PATCH`` on purpose. Making a provider public is not the
    same kind of act as editing its display name, and a deliberate endpoint
    is what lets the setup flow say "nothing is live until you press this".

    Idempotent: publishing a live provider is a no-op, so a double-click or
    a retried request cannot fail.
    """
    existing = await idp_provider_repo.get_provider(session, provider_id)
    if existing is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    # Stricter than create/update: a draft may be a placeholder, a live
    # provider is on the login page for everyone and must actually work.
    _assert_settings_usable(
        kind=existing.kind,
        settings=idp_provider_repo.decrypt_settings(existing.settings),
        claim_mapping=idp_provider_repo.parse_claim_mapping(existing),
        linking_policy=existing.linking_policy,
        require_settings=True,
    )
    row = await idp_provider_repo.publish_provider(
        session, provider_id, updated_by=admin.id,
    )
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")
    await user_repo.create_outbox_event(
        session, event_type="idp.provider.published",
        payload={"provider_id": row.id, "slug": row.slug, "kind": row.kind,
                 "actor_id": admin.id},
    )
    # Bust the registry cache so the provider reaches the login page
    # immediately rather than after the 60s TTL.
    try:
        await get_registry().invalidate(row.id)
    except RuntimeError:
        pass
    return _to_dto(row)


@router.post("/{provider_id}/dry-run/start")
async def start_dry_run(
    provider_id: str,
    response: Response,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Begin a rehearsal sign-in against this provider.

    ``/test`` dry-runs the *claim mapping* against a pasted blob. The half
    that actually breaks in production — redirect URI registered at the
    IdP, signature verifies, clock skew, certificate still valid — has no
    test at all, so today the first real test is a user failing to log in.

    The admin signs in with their own IdP account and the callback reports
    what would have happened instead of doing it: no session is minted and
    no rows are written. Requiring an admin to start it is what keeps this
    from being an identity probe — the marker cookie cannot be obtained
    anonymously.
    """
    row = await idp_provider_repo.get_provider(session, provider_id)
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Provider not found")

    set_dryrun_cookie(
        response, create_dryrun_token(admin_id=admin.id, provider_id=row.id),
    )
    return {
        "loginUrl": f"/api/v1/auth/{quote(row.slug, safe='')}/login",
        "expiresInMinutes": 10,
    }


@router.get("/{provider_id}/last-assertion")
async def get_last_assertion(
    provider_id: str,
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """The most recent assertion this provider sent.

    Mapping against a pasted sample is guesswork; mapping against what
    actually arrived is not. Stored encrypted and served only here — never
    on ``ProviderDTO``, so it cannot leak by someone adding a field to the
    list response.

    Credential-shaped values are redacted at capture time, not here: the
    unredacted form is never written.
    """
    claims, captured_at = await idp_provider_repo.read_last_assertion(
        session, provider_id,
    )
    if claims is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "No assertion captured yet for this provider. It is recorded on "
            "the next successful sign-in.",
        )
    return {"claims": claims, "capturedAt": captured_at}
