"""
Back-channel identity provider — the IdP is *asked*, never quoted.

The pattern this serves: an enterprise portal has already signed the
user in and left an ambient session token on a shared parent domain.
There is no OIDC dance and no SAML POST, and — unlike
``custom_profile`` — there is no readable assertion either. The token is
opaque. Identity is obtained by redeeming it, server-to-server:

    1. present the ambient token to a GATEWAY endpoint  -> a token
    2. present that token to an EXCHANGE endpoint       -> user claims
    3. map those claims onto a ``ProviderIdentity``

Leg 2 is optional: a gateway that returns the claims directly makes
``exchange_url`` blank and skips the round trip.

Trust model — read this before changing anything here
-----------------------------------------------------
This is the strongest kind in the codebase, and for a reason worth
stating plainly. Every other kind verifies a **signature over a
statement the IdP made at some point in the past**. This one **asks the
IdP now**. The consequences differ in the direction that matters:

* a session revoked upstream thirty seconds ago fails here immediately,
  where a signed assertion keeps verifying until its own ``exp``;
* a copied ambient token is worth exactly as much as a stolen
  enterprise SSO session — which already compromises everything else in
  that estate. We *inherit* the enterprise's session risk rather than
  *adding* a new one.

Two rules follow, and both are load-bearing:

**The tokens are opaque.** Never decode, parse, log or infer from
either the ambient token or the gateway token, even when the latter is
visibly a JWT. Reading claims out of it would turn this back into a
bearer-assertion flow and drag in signature verification, issuer and
audience pinning, and replay protection — every one of which this
design gets to skip precisely because it asks the authority directly.

**Nothing is cached.** The gateway token lives for the duration of one
request and is discarded. It is never stored, never written to a
cookie, never sent to the browser. Its own validity period is therefore
irrelevant to us, which is the point: an hour of validity is only a
risk for something you keep.

Every failure is a login failure. A timeout, a 5xx, a redirect, an
oversized body, a missing field — none of them yield a partial
identity.

Settings live in the Fernet-encrypted ``idp_providers.settings`` blob.
``gateway_headers`` and ``exchange_headers`` carry whatever credentials
the endpoints want and are redacted whole on the way back to the admin
UI.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import httpx

from .base import ProviderCredentials, ProviderIdentity
from .claim_mapper import apply_claim_mapping, ClaimMappingError, resolve_path
from .outbound import (
    BlockedOutboundRequest,
    MAX_JSON_BYTES,
    OutboundError,
    OutboundStatusError,
    request_json,
)
from .registry import ProviderConfigSnapshot

logger = logging.getLogger(__name__)


#: Where the ambient token can be read from on an inbound request.
VALID_TOKEN_SOURCES = frozenset({"cookie", "header"})
#: How a token is presented on an outbound leg.
VALID_SEND_AS = frozenset({"cookie", "header", "body"})
VALID_METHODS = frozenset({"GET", "POST"})

#: Statuses that mean "this session is over", as opposed to "we could
#: not tell". Anything else — 5xx, a timeout, a blocked request — is an
#: outage, and the liveness check must not end a session on one.
_AUTHORITATIVE_REJECTIONS = frozenset({401, 403})

#: One level of nesting hoisted so an operator maps ``firstName`` rather
#: than ``user.firstName``. An API JSON body is exactly the shape that
#: benefits. Mirrors ``custom_profile._NESTED_CONTAINERS``.
_NESTED_CONTAINERS = ("claims", "profile", "user", "userProfile",
                      "data", "result", "attributes")

#: Async callable returning the ``host:port`` entries an operator has
#: permitted. Injected rather than imported so ``auth_service`` keeps
#: importing nothing from ``backend.app.*``; ``app/main.py`` binds it.
AllowedHostsLoader = Callable[[], Awaitable[frozenset[str]]]


class BackchannelError(Exception):
    """Any failure obtaining an identity. Mapped to a generic login
    failure by the route; the precise reason is logged and audited,
    never shown to the user.

    Carries a stable ``code`` alongside the message, and the split
    matters. The message is free text — it quotes URLs, exception class
    names, and whatever a library's error string says this week. The
    code is a closed vocabulary the audit log and the diagnostics tab
    can key on. Putting the message where the code belongs was how a
    gateway URL ended up inside an audit summary, and how the
    diagnostics tab came to render nothing for most of these failures:
    its parser cannot match a code that contains a quote.

    So: ``code`` is audited and explained; ``str(exc)`` is logged.
    """

    #: Overridden per raise site. The default is the honest answer for a
    #: failure nobody has classified yet — it still parses, and still
    #: reaches the operator, rather than being dropped.
    code = "backchannel_failed"

    def __init__(self, message: str, *, code: str | None = None) -> None:
        super().__init__(message)
        if code:
            self.code = code


class BackchannelConfigError(BackchannelError):
    """The provider row is misconfigured. Raised at build time so a bad
    row fails loudly instead of silently trusting the wrong thing."""


class BackchannelUnavailable(BackchannelError):
    """The IdP did not answer usefully — a timeout, a 5xx, a blocked
    request.

    One code for all three: from the operator's side they are the same
    situation — "it did not answer" — and the specific transport reason
    belongs in the log rather than in a vocabulary they have to learn.

    Distinct from every other failure because the liveness check treats
    it differently: an outage must not end sessions, while an
    authoritative rejection must. At login it is still a refusal.
    """

    code = "backchannel_unavailable"


class SessionRevokedUpstream(BackchannelError):
    """The IdP answered, and the answer was "not authenticated".

    The status is kept in the code — it is a three-digit number from a
    closed set, so it stays parseable, and 401 versus 403 is worth
    telling apart when someone asks why everybody is being signed out.
    """

    code = "backchannel_idp_rejected"


@dataclass(frozen=True)
class BackchannelSettings:
    """Per-provider settings. Every endpoint shape is configurable
    because no two bespoke gateways agree on where a token goes."""

    provider_id: str = "backchannel"
    provider_slug: str = "default-backchannel"

    # Where the ambient token is on the INBOUND request.
    token_source: str = "cookie"
    token_source_key: str = ""

    # The browser-side trigger. Blank ``authenticate_url`` means no
    # trigger: the ambient token is expected to exist already, which is
    # the original shape and stays the default.
    #
    # This step CANNOT move to the server when the enterprise uses
    # Kerberos/SPNEGO. Answering a `401 WWW-Authenticate: Negotiate`
    # needs a Service Ticket from the workstation's OS credential store,
    # reachable only through SSPI or GSS-API — by the user's browser, on
    # the user's machine. We hold no ticket for them.
    authenticate_url: str = ""
    authenticate_method: str = "POST"
    #: PUBLISHED TO THE BROWSER. See ``validate_settings``.
    authenticate_headers: dict = field(default_factory=dict)
    #: Where the token sits in the trigger's OWN response, when it
    #: answers with one rather than setting a cookie. Blank means the
    #: call exists only to establish the cookie.
    authenticate_token_path: str = ""

    # Leg 1: ambient token -> gateway token.
    gateway_url: str = ""
    gateway_method: str = "POST"
    gateway_send_as: str = "cookie"
    gateway_token_header: str = ""
    gateway_token_prefix: str = ""
    gateway_body_field: str = ""
    gateway_cookie_name: str = ""
    gateway_headers: dict = field(default_factory=dict)
    gateway_token_path: str = "access_token"

    # Leg 2: gateway token -> claims. Blank URL skips it.
    exchange_url: str = ""
    exchange_method: str = "POST"
    exchange_send_as: str = "body"
    exchange_body_field: str = "token"
    exchange_token_header: str = ""
    exchange_token_prefix: str = "Bearer "
    exchange_headers: dict = field(default_factory=dict)
    exchange_claims_path: str = ""

    timeout_seconds: float = 5.0
    max_response_bytes: int = MAX_JSON_BYTES
    require_auth_time: bool = True

    # Liveness re-check on each token rotation.
    liveness_on_refresh: bool = True
    liveness_grace_seconds: int = 900

    claim_mapping_override: dict = field(default_factory=dict)
    linking_policy: str = "strict"


def _as_bool(v: Any) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        return v.strip().lower() in {"true", "1", "yes", "t"}
    return bool(v)


def _as_int(v: Any, default: int) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _as_float(v: Any, default: float) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _as_dict(v: Any) -> dict:
    return dict(v) if isinstance(v, dict) else {}


def settings_from_snapshot(snap: ProviderConfigSnapshot) -> BackchannelSettings:
    s = snap.settings or {}
    return BackchannelSettings(
        provider_id=snap.id,
        provider_slug=snap.slug,
        token_source=str(s.get("token_source") or "cookie").strip(),
        token_source_key=str(s.get("token_source_key") or "").strip(),
        authenticate_url=str(s.get("authenticate_url") or "").strip(),
        authenticate_method=str(
            s.get("authenticate_method") or "POST"
        ).strip().upper(),
        authenticate_headers=_as_dict(s.get("authenticate_headers")),
        authenticate_token_path=str(
            s.get("authenticate_token_path") or ""
        ).strip(),
        gateway_url=str(s.get("gateway_url") or "").strip(),
        gateway_method=str(s.get("gateway_method") or "POST").strip().upper(),
        gateway_send_as=str(s.get("gateway_send_as") or "cookie").strip(),
        gateway_token_header=str(s.get("gateway_token_header") or "").strip(),
        gateway_token_prefix=str(s.get("gateway_token_prefix") or ""),
        gateway_body_field=str(s.get("gateway_body_field") or "").strip(),
        gateway_cookie_name=str(s.get("gateway_cookie_name") or "").strip(),
        gateway_headers=_as_dict(s.get("gateway_headers")),
        gateway_token_path=str(
            s.get("gateway_token_path") or "access_token"
        ).strip(),
        exchange_url=str(s.get("exchange_url") or "").strip(),
        exchange_method=str(s.get("exchange_method") or "POST").strip().upper(),
        exchange_send_as=str(s.get("exchange_send_as") or "body").strip(),
        exchange_body_field=str(s.get("exchange_body_field") or "token").strip(),
        exchange_token_header=str(s.get("exchange_token_header") or "").strip(),
        exchange_token_prefix=str(s.get("exchange_token_prefix") or "Bearer "),
        exchange_headers=_as_dict(s.get("exchange_headers")),
        exchange_claims_path=str(s.get("exchange_claims_path") or "").strip(),
        timeout_seconds=_as_float(s.get("timeout_seconds"), 5.0),
        max_response_bytes=_as_int(s.get("max_response_bytes"), MAX_JSON_BYTES),
        require_auth_time=_as_bool(s.get("require_auth_time", True)),
        liveness_on_refresh=_as_bool(s.get("liveness_on_refresh", True)),
        liveness_grace_seconds=_as_int(s.get("liveness_grace_seconds"), 900),
        claim_mapping_override=snap.claim_mapping or {},
        linking_policy=snap.linking_policy,
    )


def validate_settings(s: BackchannelSettings) -> None:
    """Refuse a row that would not work, or would work by accident."""
    if s.token_source not in VALID_TOKEN_SOURCES:
        raise BackchannelConfigError(
            f"token_source must be one of {sorted(VALID_TOKEN_SOURCES)}, "
            f"got '{s.token_source}'"
        )
    # The trigger can supply the token itself, in which case there is no
    # cookie to name.
    if not s.token_source_key and not s.authenticate_token_path:
        raise BackchannelConfigError(
            "token_source_key is required — name the cookie or header "
            "carrying the ambient session token, or set "
            "authenticate_token_path if the sign-in trigger returns the "
            "token in its own response"
        )
    if s.authenticate_token_path and not s.authenticate_url:
        raise BackchannelConfigError(
            "authenticate_token_path needs authenticate_url — there is no "
            "response to read the token out of without a call to make"
        )
    if s.authenticate_url and s.authenticate_method not in VALID_METHODS:
        raise BackchannelConfigError(
            f"authenticate_method must be one of {sorted(VALID_METHODS)}, "
            f"got '{s.authenticate_method}'"
        )
    if not s.gateway_url:
        raise BackchannelConfigError("gateway_url is required")

    _validate_leg(
        "gateway", url=s.gateway_url, method=s.gateway_method,
        send_as=s.gateway_send_as, header=s.gateway_token_header,
        body_field=s.gateway_body_field,
    )
    if not s.gateway_token_path:
        raise BackchannelConfigError(
            "gateway_token_path is required — name the field in the "
            "gateway response holding the token"
        )
    if s.exchange_url:
        if s.exchange_send_as == "cookie":
            raise BackchannelConfigError(
                "exchange_send_as='cookie' is not supported; the gateway "
                "token is a bearer credential, not an ambient one"
            )
        _validate_leg(
            "exchange", url=s.exchange_url, method=s.exchange_method,
            send_as=s.exchange_send_as, header=s.exchange_token_header,
            body_field=s.exchange_body_field,
        )
    if s.timeout_seconds <= 0:
        raise BackchannelConfigError("timeout_seconds must be > 0")
    if s.max_response_bytes <= 0:
        raise BackchannelConfigError("max_response_bytes must be > 0")
    if s.liveness_grace_seconds < 0:
        raise BackchannelConfigError("liveness_grace_seconds must be >= 0")


def _validate_leg(
    name: str, *, url: str, method: str, send_as: str, header: str,
    body_field: str,
) -> None:
    if method not in VALID_METHODS:
        raise BackchannelConfigError(
            f"{name}_method must be one of {sorted(VALID_METHODS)}, "
            f"got '{method}'"
        )
    if send_as not in VALID_SEND_AS:
        raise BackchannelConfigError(
            f"{name}_send_as must be one of {sorted(VALID_SEND_AS)}, "
            f"got '{send_as}'"
        )
    if send_as == "header" and not header:
        raise BackchannelConfigError(
            f"{name}_send_as='header' requires {name}_token_header"
        )
    if send_as == "body":
        if not body_field:
            raise BackchannelConfigError(
                f"{name}_send_as='body' requires {name}_body_field"
            )
        if method == "GET":
            raise BackchannelConfigError(
                f"{name}_send_as='body' cannot be combined with a GET; "
                "the token would never be sent"
            )


class BackchannelProvider:
    """Back-channel IdP. The route reads the ambient token off the
    request and hands the raw string over; everything else happens
    server-to-server."""

    name = "backchannel"

    def __init__(
        self,
        settings: BackchannelSettings | None = None,
        *,
        allowed_hosts: AllowedHostsLoader | None = None,
    ) -> None:
        self._s = settings or BackchannelSettings()
        # Injected, and read per request rather than per build: removing
        # a host from the allowlist has to stop working now, not when
        # the registry's 60s provider cache next turns over.
        self._allowed_hosts = allowed_hosts

    @property
    def settings(self) -> BackchannelSettings:
        return self._s

    @property
    def slug(self) -> str:
        return self._s.provider_slug

    @property
    def provider_id(self) -> str:
        return self._s.provider_id

    @property
    def enabled(self) -> bool:
        return True

    # ── IdentityProvider protocol ────────────────────────────────────
    async def authenticate(
        self, credentials: ProviderCredentials, *, get_user_by_email,
    ) -> Optional[ProviderIdentity]:
        return None

    # ── Outbound legs ────────────────────────────────────────────────

    async def _allow_hosts(self) -> frozenset[str]:
        if self._allowed_hosts is None:
            return frozenset()
        return await self._allowed_hosts()

    async def _call(
        self, *, url: str, method: str, send_as: str, token: str,
        header_name: str, header_prefix: str, body_field: str,
        cookie_name: str, static_headers: dict,
    ) -> Any:
        """One guarded leg. Raises the split errors this module's
        callers distinguish between."""
        headers = {str(k): str(v) for k, v in (static_headers or {}).items()}
        cookies: dict[str, str] | None = None
        body: dict | None = None

        if send_as == "header":
            headers[header_name] = f"{header_prefix}{token}"
        elif send_as == "cookie":
            cookies = {cookie_name: token}
        else:  # body
            body = {body_field: token}

        try:
            return await request_json(
                url, method=method, json_body=body, headers=headers,
                cookies=cookies, timeout=self._s.timeout_seconds,
                max_bytes=self._s.max_response_bytes,
                allow_hosts=await self._allow_hosts(),
            )
        except OutboundStatusError as exc:
            if exc.status_code in _AUTHORITATIVE_REJECTIONS:
                raise SessionRevokedUpstream(
                    f"idp_rejected:{exc.status_code}",
                    code=f"backchannel_idp_rejected:{exc.status_code}",
                ) from exc
            raise BackchannelUnavailable(
                f"idp_status:{exc.status_code}"
            ) from exc
        except BlockedOutboundRequest as exc:
            # A refused destination, a redirect, an oversized or
            # non-JSON body. Not an answer about the user, so it is an
            # outage for liveness purposes and a refusal at login.
            raise BackchannelUnavailable(f"idp_blocked:{exc}") from exc
        except httpx.HTTPError as exc:
            raise BackchannelUnavailable(
                f"idp_unreachable:{type(exc).__name__}"
            ) from exc
        except OutboundError as exc:  # pragma: no cover — future subclasses
            raise BackchannelUnavailable(f"idp_error:{exc}") from exc

    async def _gateway(self, ambient_token: str) -> Any:
        """Leg 1, raw. Separate from :meth:`redeem` because when leg 2
        is not configured the same body carries the claims, and calling
        the gateway twice to read one response would double the load
        for nothing."""
        if not ambient_token or not ambient_token.strip():
            raise BackchannelError(
                "ambient_token_missing", code="backchannel_no_session",
            )
        s = self._s
        return await self._call(
            url=s.gateway_url, method=s.gateway_method,
            send_as=s.gateway_send_as, token=ambient_token.strip(),
            header_name=s.gateway_token_header,
            header_prefix=s.gateway_token_prefix,
            body_field=s.gateway_body_field,
            cookie_name=s.gateway_cookie_name or s.token_source_key,
            static_headers=s.gateway_headers,
        )

    def _token_from(self, payload: Any) -> str:
        token = resolve_path(payload, self._s.gateway_token_path)
        if not isinstance(token, str) or not token.strip():
            # Deliberately reports the PATH, not the payload: this
            # message reaches an operator's logs and the payload is the
            # user's identity.
            raise BackchannelError(
                f"gateway_token_absent_at:{self._s.gateway_token_path}",
                code="backchannel_token_absent",
            )
        return token.strip()

    async def redeem(self, ambient_token: str) -> str:
        """Leg 1. Returns the gateway token, which stays opaque."""
        return self._token_from(await self._gateway(ambient_token))

    async def exchange(self, gateway_token: str) -> dict:
        """Leg 2. Returns the claims object, or the whole body when no
        ``exchange_claims_path`` is configured."""
        s = self._s
        payload = await self._call(
            url=s.exchange_url, method=s.exchange_method,
            send_as=s.exchange_send_as, token=gateway_token,
            header_name=s.exchange_token_header,
            header_prefix=s.exchange_token_prefix,
            body_field=s.exchange_body_field,
            cookie_name="", static_headers=s.exchange_headers,
        )
        return self._claims_from(payload, s.exchange_claims_path)

    def _claims_from(self, payload: Any, path: str) -> dict:
        claims = resolve_path(payload, path) if path else payload
        if not isinstance(claims, dict):
            raise BackchannelError(
                f"claims_absent_at:{path or '<root>'}",
                code="backchannel_claims_absent",
            )
        return claims

    # ── Identity ─────────────────────────────────────────────────────

    async def fetch_identity(self, raw: str) -> ProviderIdentity:
        """Redeem the ambient token and return a verified identity.

        Raises :class:`BackchannelError` (or a subclass) on any failure.
        """
        s = self._s
        payload = await self._gateway(raw)

        if s.exchange_url:
            claims = await self.exchange(self._token_from(payload))
        else:
            # No leg 2 configured: this gateway answers with the claims
            # directly, so the body already in hand is the answer.
            claims = self._claims_from(payload, s.exchange_claims_path)

        return self._identity_from(claims)

    def _identity_from(self, claims: dict) -> ProviderIdentity:
        flat = {**claims}
        for container in _NESTED_CONTAINERS:
            nested = claims.get(container)
            if isinstance(nested, dict):
                for k, v in nested.items():
                    flat.setdefault(k, v)

        try:
            identity = apply_claim_mapping(
                flat,
                kind="backchannel",
                provider_slug=self._s.provider_slug,
                override=self._s.claim_mapping_override,
            )
        except ClaimMappingError as exc:
            raise BackchannelError(
                str(exc), code="backchannel_claims_unmappable",
            ) from exc

        if self._s.require_auth_time and not getattr(identity, "auth_time", None):
            # Without one, ``complete_sso_login`` falls back to "now"
            # with a warning — which quietly disables the 24h SSO
            # re-auth ceiling for every session this provider mints.
            raise BackchannelError(
                "auth_time_absent", code="backchannel_auth_time_absent",
            )
        return identity

    # ── Liveness ─────────────────────────────────────────────────────

    async def confirm_still_authenticated(self, ambient_token: str) -> None:
        """Re-ask the IdP whether this session is still live.

        Called on each token rotation so our session cannot outlive the
        enterprise session that created it — the gap that makes single
        logout hard for every other kind.

        Only leg 1 runs: redeeming the ambient token is the question
        being asked, and the claims are not needed to answer it.

        Raises :class:`SessionRevokedUpstream` when the IdP says no, and
        :class:`BackchannelUnavailable` when it did not say. The caller
        must treat those differently — ending sessions on an outage
        would turn a gateway blip into a platform-wide logout.
        """
        await self._gateway(ambient_token)


def build_backchannel_provider(
    snap: ProviderConfigSnapshot,
    *,
    allowed_hosts: AllowedHostsLoader | None = None,
) -> BackchannelProvider:
    """Factory for the registry. Validates before returning so a
    misconfigured row raises here rather than at login time.

    ``allowed_hosts`` must be supplied by anything serving real traffic;
    ``app/main.py`` binds it. Without it the provider can still reach
    public addresses but no internal ones — which fails closed, and is
    the right default for a test.
    """
    settings = settings_from_snapshot(snap)
    validate_settings(settings)
    return BackchannelProvider(settings, allowed_hosts=allowed_hosts)
