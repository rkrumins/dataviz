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

**The credentials are opaque.** Never decode, parse, log or infer from
the ambient token, or from a gateway token that exists only to be
presented to the next leg. What MAY be decoded is the claims material
itself: when the operator says the answer arrives as a JWT
(``claims_format="jwt"``), the payload of that JWT *is* the user object
this flow exists to obtain, read from the same TLS response the JSON
shape would have been read from — the authority was still asked on this
very request. Verification against a JWKS is available and optional
here, because the transport already authenticates the answer; nothing
browser-supplied is ever decoded on this path.

**Nothing is cached.** The gateway token lives for the duration of one
request and is discarded. It is never stored, never written to a
cookie, never sent to the browser. Its own validity period is therefore
irrelevant to us, which is the point: an hour of validity is only a
risk for something you keep. (The one cache here is the JWKS document —
public key material, held briefly so verification does not refetch it
per login.)

Every failure is a login failure. A timeout, a 5xx, a redirect, an
oversized body, a missing field — none of them yield a partial
identity.

Settings live in the Fernet-encrypted ``idp_providers.settings`` blob.
``gateway_headers`` and ``exchange_headers`` carry whatever credentials
the endpoints want and are redacted whole on the way back to the admin
UI.
"""
from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable, Optional

import httpx
import jwt as pyjwt

from .base import ProviderCredentials, ProviderIdentity
from .claim_mapper import (
    apply_claim_mapping,
    ClaimMappingError,
    resolve_path,
    resolved_sources,
)
from .outbound import (
    BlockedOutboundRequest,
    MAX_JSON_BYTES,
    OutboundError,
    OutboundStatusError,
    fetch_jwks,
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

#: Shapes the claims material can arrive in.
VALID_CLAIMS_FORMATS = frozenset({"json", "jwt"})

#: Where the exchange runs.
VALID_EXCHANGE_MODES = frozenset({"server", "browser"})

#: Signature algorithms accepted with PUBLIC verification material — a
#: JWKS or a pasted PEM public key. Asymmetric only, spelled out rather
#: than derived: HS* would let anyone holding the (public!) key material
#: mint tokens, and ``none`` is refused by never being on a list. A
#: symmetric gateway configures ``jwt_shared_secret`` instead, which
#: pins the algorithm list to exactly ``HS256`` — the material decides
#: the list, so neither confusion direction is expressible.
_JWT_ALGORITHMS = ("RS256", "RS384", "RS512", "ES256", "ES384", "ES512",
                   "PS256", "PS384", "PS512")

#: How long a fetched JWKS document is reused before it is refetched.
#: Kept short — key rotation must land promptly — and a kid the cache
#: does not know forces one refetch regardless of age.
_JWKS_TTL_SECONDS = 300.0

#: Replay-burn horizon for trust_unsigned assertions, where ``exp`` is
#: attacker-writable or absent entirely. The stores size their TTL from
#: the exp they are handed, so an absent one would burn for ~1 second —
#: a replay window, not a burn. Clamped to [floor, cap] regardless of
#: what the payload claims: the floor makes the burn real, the cap
#: stops an attacker-chosen exp growing the store unboundedly.
_UNSIGNED_REPLAY_FLOOR_SECONDS = 900
_UNSIGNED_REPLAY_CAP_SECONDS = 86_400

#: One level of nesting hoisted so an operator maps ``firstName`` rather
#: than ``user.firstName``. An API JSON body is exactly the shape that
#: benefits. Mirrors ``custom_profile._NESTED_CONTAINERS``.
_NESTED_CONTAINERS = ("claims", "profile", "user", "userProfile",
                      "data", "result", "attributes")

#: Top-level values a populated nested one may overwrite during the
#: hoist. Membership is by equality, so ``0`` and ``False`` — values a
#: gateway can mean — are NOT emptyish.
_EMPTYISH = (None, "", [], {})


def hoist_nested_containers(claims: dict) -> dict:
    """One level of container nesting flattened, so mappings can say
    ``firstName`` instead of ``profile.firstName``.

    A top-level key wins over a hoisted one — except when its value is
    emptyish (``None``, ``""``, ``[]``, ``{}``) and the nested one is
    not. Real gateways emit exactly that shape: a vestigial top-level
    ``groups: []`` beside ``profile.groups`` carrying the real list,
    and "present but empty shadows populated" silently turned group
    mapping off.

    Exported because the admin preview must run the very same hoist —
    a preview that skipped it disagreed with the sign-in it was
    supposed to predict.
    """
    flat = {**claims}
    for container in _NESTED_CONTAINERS:
        nested = claims.get(container)
        if isinstance(nested, dict):
            for k, v in nested.items():
                if k not in flat:
                    flat[k] = v
                elif flat[k] in _EMPTYISH and v not in _EMPTYISH:
                    flat[k] = v
    return flat

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
    #: Send the ambient session as a cookie IN ADDITION to whatever
    #: ``gateway_send_as`` carries the token in. A gateway that
    #: authenticates by cookie and takes the token in the body needs
    #: both on the same request, which one carrier cannot express.
    gateway_send_ambient_cookie: bool = False
    gateway_headers: dict = field(default_factory=dict)
    gateway_token_path: str = "access_token"

    #: Where the exchange happens. ``server`` is the original shape and
    #: the default: the corporate cookie reaches our backend (shared
    #: parent domain) and both legs run server-to-server. ``browser``
    #: exists for a cookie scoped to the SSO host alone — the browser
    #: calls the corporate translate endpoint itself (its cookie jar
    #: does what ours cannot) and posts the resulting JWT here, where it
    #: is signature-verified, exp-checked and enforced single-use. The
    #: server legs and the ambient token do not apply in that mode.
    exchange_mode: str = "server"
    #: The translate endpoint the BROWSER calls in ``browser`` mode.
    #: Published to the sign-in page with its method, headers and token
    #: path — a deliberately public family, like ``authenticate_*``, so
    #: flipping a row's mode can never leak ``gateway_headers`` or
    #: ``exchange_headers``, which stay server-only under every mode.
    browser_exchange_url: str = ""
    browser_exchange_method: str = "GET"
    #: PUBLISHED TO THE BROWSER, like ``authenticate_headers``.
    browser_exchange_headers: dict = field(default_factory=dict)
    #: Where the JWT sits in the translate response. Blank means the
    #: response body IS the token.
    browser_exchange_token_path: str = ""

    # Leg 2: gateway token -> claims. Blank URL skips it.
    exchange_url: str = ""
    exchange_method: str = "POST"
    exchange_send_as: str = "body"
    exchange_body_field: str = "token"
    exchange_token_header: str = ""
    exchange_token_prefix: str = "Bearer "
    exchange_headers: dict = field(default_factory=dict)
    exchange_claims_path: str = ""

    #: How the claims material arrives. ``json`` is the original shape:
    #: the value at ``exchange_claims_path`` is the user object itself.
    #: ``jwt`` says that value (or the whole response body, when the
    #: path is blank — including a bare ``application/jwt`` body) is a
    #: compact JWT whose *payload* is the user object.
    claims_format: str = "json"
    #: Verification material, at most one of the three. ``jwks_url``
    #: fetches the gateway's published key set (through the guarded
    #: outbound layer, so an internal JWKS host needs an allowlist entry
    #: like every other internal destination). ``jwt_public_key`` is the
    #: same trust for a gateway that signs but publishes no key set: the
    #: operator pastes the PEM public key. ``jwt_shared_secret`` is for
    #: symmetric gateways: HS256, pinned to exactly that algorithm, the
    #: way ``custom_profile`` holds its shared secret. In server mode
    #: all three are optional — blank decodes without verifying, which
    #: carries exactly the trust the JSON shape already has (the bytes
    #: came over TLS from the endpoint we called). In browser mode ONE
    #: of them is required: the token arrives from the user's browser,
    #: and is only as good as its signature.
    jwks_url: str = ""
    jwt_public_key: str = ""
    jwt_shared_secret: str = ""
    #: Browser-mode-only danger opt-in: accept the translate reply with
    #: NO verification at all — an unverified compact JWT, or a bare
    #: JSON claims object; both shapes on the same row, which is what a
    #: gateway whose reply varies by environment needs. The price is
    #: stated everywhere it matters: anyone who can reach the sign-in
    #: page can post a reply, the connection's assurance drops to
    #: ``unverified`` (so it cannot grant platform-admin roles through
    #: group mappings), and every such login is audited. The replay
    #: burn still applies. Contradicts verification material, and means
    #: nothing in server mode — validation refuses both.
    trust_unsigned: bool = False
    #: Optional pins, applied only when verifying.
    jwt_issuer: str = ""
    jwt_audience: str = ""

    timeout_seconds: float = 5.0
    max_response_bytes: int = MAX_JSON_BYTES
    require_auth_time: bool = True
    #: When the gateway sends no ``email_verified`` claim at all, count
    #: the address as verified. Corporate gateways rarely send one, and
    #: an absent claim normalises to False — which refuses the
    #: auto-link-by-email this kind exists to make. An explicit
    #: ``false`` from the gateway is still respected.
    trust_gateway_email: bool = True

    # Liveness re-check on each token rotation.
    liveness_on_refresh: bool = True
    liveness_grace_seconds: int = 900
    #: Optional cheaper endpoint for the re-check. The contract asks
    #: gateway teams for one ("an endpoint that validates a handle
    #: without minting a new token"); when they provide it, the
    #: re-check calls it instead of ``gateway_url``, with identical
    #: mechanics — same carrier, same headers, same status semantics,
    #: and a JSON (or configured-JWT) body on success.
    liveness_url: str = ""

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
        gateway_send_ambient_cookie=_as_bool(
            s.get("gateway_send_ambient_cookie")
        ),
        gateway_headers=_as_dict(s.get("gateway_headers")),
        gateway_token_path=str(
            s.get("gateway_token_path") or "access_token"
        ).strip(),
        exchange_mode=str(s.get("exchange_mode") or "server").strip().lower(),
        browser_exchange_url=str(s.get("browser_exchange_url") or "").strip(),
        browser_exchange_method=str(
            s.get("browser_exchange_method") or "GET"
        ).strip().upper(),
        browser_exchange_headers=_as_dict(s.get("browser_exchange_headers")),
        browser_exchange_token_path=str(
            s.get("browser_exchange_token_path") or ""
        ).strip(),
        exchange_url=str(s.get("exchange_url") or "").strip(),
        exchange_method=str(s.get("exchange_method") or "POST").strip().upper(),
        exchange_send_as=str(s.get("exchange_send_as") or "body").strip(),
        exchange_body_field=str(s.get("exchange_body_field") or "token").strip(),
        exchange_token_header=str(s.get("exchange_token_header") or "").strip(),
        exchange_token_prefix=str(s.get("exchange_token_prefix") or "Bearer "),
        exchange_headers=_as_dict(s.get("exchange_headers")),
        exchange_claims_path=str(s.get("exchange_claims_path") or "").strip(),
        claims_format=str(s.get("claims_format") or "json").strip().lower(),
        jwks_url=str(s.get("jwks_url") or "").strip(),
        # Key material verbatim (no strip) — custom_profile parity: PEM
        # bodies and secrets are not ours to normalise.
        jwt_public_key=str(s.get("jwt_public_key") or ""),
        jwt_shared_secret=str(s.get("jwt_shared_secret") or ""),
        trust_unsigned=_as_bool(s.get("trust_unsigned")),
        jwt_issuer=str(s.get("jwt_issuer") or "").strip(),
        jwt_audience=str(s.get("jwt_audience") or "").strip(),
        timeout_seconds=_as_float(s.get("timeout_seconds"), 5.0),
        max_response_bytes=_as_int(s.get("max_response_bytes"), MAX_JSON_BYTES),
        require_auth_time=_as_bool(s.get("require_auth_time", True)),
        trust_gateway_email=_as_bool(s.get("trust_gateway_email", True)),
        liveness_on_refresh=_as_bool(s.get("liveness_on_refresh", True)),
        liveness_grace_seconds=_as_int(s.get("liveness_grace_seconds"), 900),
        liveness_url=str(s.get("liveness_url") or "").strip(),
        claim_mapping_override=snap.claim_mapping or {},
        linking_policy=snap.linking_policy,
    )


def assertion_verification(s: BackchannelSettings, assertion: str) -> dict:
    """How this row judged an ACCEPTED browser assertion — for the
    rehearsal verdict, so an operator sees which case their gateway is:
    a signed token verified against which material, or a reply trusted
    unverified. Lives beside the code that does the judging so the
    verdict cannot drift from the branch that actually ran.
    """
    if s.trust_unsigned:
        return {
            "shape": "json" if assertion.strip().startswith("{") else "jwt",
            "verified": False,
            "material": "none",
        }
    material = (
        "jwks" if s.jwks_url
        else "public_key" if s.jwt_public_key
        else "shared_secret"
    )
    return {"shape": "jwt", "verified": True, "material": material}


def validate_settings(s: BackchannelSettings) -> None:
    """Refuse a row that would not work, or would work by accident."""
    if s.exchange_mode not in VALID_EXCHANGE_MODES:
        raise BackchannelConfigError(
            f"exchange_mode must be one of {sorted(VALID_EXCHANGE_MODES)}, "
            f"got '{s.exchange_mode}'"
        )
    if s.token_source not in VALID_TOKEN_SOURCES:
        raise BackchannelConfigError(
            f"token_source must be one of {sorted(VALID_TOKEN_SOURCES)}, "
            f"got '{s.token_source}'"
        )
    if s.authenticate_url and s.authenticate_method not in VALID_METHODS:
        raise BackchannelConfigError(
            f"authenticate_method must be one of {sorted(VALID_METHODS)}, "
            f"got '{s.authenticate_method}'"
        )
    if s.claims_format not in VALID_CLAIMS_FORMATS:
        raise BackchannelConfigError(
            f"claims_format must be one of {sorted(VALID_CLAIMS_FORMATS)}, "
            f"got '{s.claims_format}'"
        )
    materials = [m for m in (s.jwks_url, s.jwt_public_key,
                             s.jwt_shared_secret) if m]
    if len(materials) > 1:
        raise BackchannelConfigError(
            "configure exactly one of jwks_url / jwt_public_key / "
            "jwt_shared_secret — with two keys, which one verified a "
            "given token would be an accident"
        )
    if s.trust_unsigned and materials:
        raise BackchannelConfigError(
            "trust_unsigned contradicts verification material — remove "
            "one; keeping both would leave it ambiguous whether "
            "assertions are verified"
        )
    if (s.jwt_issuer or s.jwt_audience) and not materials:
        raise BackchannelConfigError(
            "jwt_issuer / jwt_audience are verification pins and need "
            "verification material (jwks_url, jwt_public_key or "
            "jwt_shared_secret) — without a verified signature they "
            "would pin nothing"
        )
    if s.timeout_seconds <= 0:
        raise BackchannelConfigError("timeout_seconds must be > 0")
    if s.max_response_bytes <= 0:
        raise BackchannelConfigError("max_response_bytes must be > 0")
    if s.liveness_grace_seconds < 0:
        raise BackchannelConfigError("liveness_grace_seconds must be >= 0")

    if s.exchange_mode == "browser":
        _validate_browser_mode(s)
        return

    # ── server mode: the original shape ──────────────────────────────
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
    if not s.gateway_url:
        raise BackchannelConfigError("gateway_url is required")

    _validate_leg(
        "gateway", url=s.gateway_url, method=s.gateway_method,
        send_as=s.gateway_send_as, header=s.gateway_token_header,
        body_field=s.gateway_body_field,
    )
    if s.exchange_url and not s.gateway_token_path:
        # Only when there IS a second leg. A gateway that answers with
        # the identity has no token to point at, and ``fetch_identity``
        # never reads this — demanding it made an operator carry a value
        # that meant nothing.
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
    if s.claims_format != "jwt":
        for name, value in (("jwks_url", s.jwks_url),
                            ("jwt_public_key", s.jwt_public_key),
                            ("jwt_shared_secret", s.jwt_shared_secret)):
            if value:
                raise BackchannelConfigError(
                    f"{name} only applies with claims_format='jwt' — "
                    "there is no signature to verify on a JSON user "
                    "object"
                )
    if s.trust_unsigned:
        raise BackchannelConfigError(
            "trust_unsigned is the browser-mode opt-in; server mode "
            "already accepts the TLS answer without a signature, so "
            "here the flag would state nothing"
        )


def _validate_browser_mode(s: BackchannelSettings) -> None:
    """The browser-exchange shape: the corporate cookie never reaches
    us, so the browser runs the translate call and hands over the JWT.
    Different trust, different requirements."""
    if not s.browser_exchange_url:
        raise BackchannelConfigError(
            "browser_exchange_url is required in browser mode — it is "
            "the translate endpoint the sign-in page calls"
        )
    if s.browser_exchange_method not in VALID_METHODS:
        raise BackchannelConfigError(
            f"browser_exchange_method must be one of "
            f"{sorted(VALID_METHODS)}, got '{s.browser_exchange_method}'"
        )
    if not s.trust_unsigned and not (
        s.jwks_url or s.jwt_public_key or s.jwt_shared_secret
    ):
        # Not optional here, unlike the server shape: a token the
        # BROWSER delivers is written by whoever sits at it unless a
        # signature says otherwise. TLS authenticated nothing to us —
        # we were not on the call. (Exactly-one is enforced upstream;
        # this insists on at-least-one, or the explicit trust_unsigned
        # opt-in that rates the row unverified.)
        raise BackchannelConfigError(
            "browser mode needs verification material — jwks_url, "
            "jwt_public_key or jwt_shared_secret — because a "
            "browser-delivered token is only as good as its signature; "
            "trust_unsigned is the explicit opt-out, at the price of an "
            "unverified rating"
        )
    if s.authenticate_token_path:
        raise BackchannelConfigError(
            "authenticate_token_path is the handle shape, which redeems "
            "at the gateway; in browser mode the trigger exists only to "
            "establish the corporate session, and the translate call "
            "carries it from there"
        )
    if s.liveness_url:
        raise BackchannelConfigError(
            "liveness_url does not apply in browser mode — the server "
            "never sees the corporate session, so there is nothing it "
            "could re-check; the token's own expiry bounds the session"
        )


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


class _MemoryReplayCache:
    """Process-local single-use cache. Tests and single-process dev ONLY.

    Mirrors ``custom_profile._MemoryJtiCache`` and fails the same two
    ways: every gunicorn worker holds its own dict, and the registry
    rebuilds this provider (dict included) every 60 s. Which is exactly
    why ``app/main.py`` refuses to serve a browser-mode row in
    production without the shared store — this fallback silently *looks*
    like replay protection.
    """

    def __init__(self) -> None:
        self._seen: dict[str, int] = {}

    async def record(self, token_id: str, expires_at_epoch: int) -> bool:
        now = int(time.time())
        self._seen = {k: e for k, e in self._seen.items() if e > now}
        if token_id in self._seen:
            return False
        self._seen[token_id] = max(int(expires_at_epoch), now + 1)
        return True


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
        replay_cache=None,
    ) -> None:
        self._s = settings or BackchannelSettings()
        # Injected, and read per request rather than per build: removing
        # a host from the allowlist has to stop working now, not when
        # the registry's 60s provider cache next turns over.
        self._allowed_hosts = allowed_hosts
        # The JWKS document, held per provider instance. The registry
        # rebuilds instances every ~60s anyway, so this is a bounded,
        # self-expiring cache of public key material — the one thing the
        # module docstring's "nothing is cached" rule does not cover.
        self._jwks: list | None = None
        self._jwks_at: float = 0.0
        # Single-use enforcement for browser-delivered assertions.
        # ``app/main.py`` binds the shared store; the local fallback is
        # for tests and single-process dev only, and production refuses
        # to build a browser-mode row without the real one.
        self._replay = replay_cache or _MemoryReplayCache()

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
        cookie_name: str, static_headers: dict, also_cookie: bool = False,
        accept_jwt: bool = False,
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

        if also_cookie and cookie_name and send_as != "cookie":
            # Both, not either. A gateway can authenticate the caller by
            # cookie and still expect the token in the body — the cookie
            # says who is asking, the body says what is being redeemed,
            # and they are not the same question.
            cookies = {**(cookies or {}), cookie_name: token}

        try:
            return await request_json(
                url, method=method, json_body=body, headers=headers,
                cookies=cookies, timeout=self._s.timeout_seconds,
                max_bytes=self._s.max_response_bytes,
                allow_hosts=await self._allow_hosts(),
                accept_jwt=accept_jwt,
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

    def _gateway_answers_with_jwt(self) -> bool:
        """Whether leg 1's own response body is the claims JWT — the
        single-leg translate shape. With a leg 2 configured the gateway
        response is a JSON envelope carrying a token at a path, and the
        strict JSON rule stays."""
        return self._s.claims_format == "jwt" and not self._s.exchange_url

    async def _gateway(self, ambient_token: str, *, url: str = "") -> Any:
        """Leg 1, raw. Separate from :meth:`redeem` because when leg 2
        is not configured the same body carries the claims, and calling
        the gateway twice to read one response would double the load
        for nothing. *url* overrides the destination only — the liveness
        re-check aims the same call at the cheaper validate endpoint."""
        if not ambient_token or not ambient_token.strip():
            raise BackchannelError(
                "ambient_token_missing", code="backchannel_no_session",
            )
        s = self._s
        return await self._call(
            url=url or s.gateway_url, method=s.gateway_method,
            send_as=s.gateway_send_as, token=ambient_token.strip(),
            header_name=s.gateway_token_header,
            header_prefix=s.gateway_token_prefix,
            body_field=s.gateway_body_field,
            cookie_name=s.gateway_cookie_name or s.token_source_key,
            static_headers=s.gateway_headers,
            also_cookie=s.gateway_send_ambient_cookie,
            accept_jwt=self._gateway_answers_with_jwt(),
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
            accept_jwt=s.claims_format == "jwt",
        )
        return await self._claims_material(payload, s.exchange_claims_path)

    def _claims_from(self, payload: Any, path: str) -> dict:
        claims = resolve_path(payload, path) if path else payload
        if not isinstance(claims, dict):
            raise BackchannelError(
                f"claims_absent_at:{path or '<root>'}",
                code="backchannel_claims_absent",
            )
        return claims

    async def _claims_material(self, payload: Any, path: str) -> dict:
        """The user object, in whichever shape the operator said it
        arrives. ``json``: the value at *path* is the object itself.
        ``jwt``: that value — or the whole body, including a bare
        ``application/jwt`` one — is a compact JWT whose payload is the
        object."""
        if self._s.claims_format != "jwt":
            return self._claims_from(payload, path)
        material = resolve_path(payload, path) if path else payload
        if not isinstance(material, str) or not material.strip():
            raise BackchannelError(
                f"claims_absent_at:{path or '<root>'}",
                code="backchannel_claims_absent",
            )
        return await self._decode_claims_jwt(material.strip())

    async def _decode_claims_jwt(self, token: str) -> dict:
        """Decode — and, when verification material is configured,
        verify — the claims JWT. Error messages name failure classes,
        never token material: they reach an operator's logs, and the
        token is the identity."""
        s = self._s
        if not (s.jwks_url or s.jwt_public_key or s.jwt_shared_secret):
            # Unverified decode is a deliberate trust statement, not a
            # shortcut: the bytes arrived over TLS from the endpoint we
            # just called, exactly like the JSON shape they replace.
            # (Unreachable in browser mode — validation demands
            # material there.)
            try:
                return pyjwt.decode(
                    token, options={"verify_signature": False},
                )
            except pyjwt.InvalidTokenError as exc:
                raise BackchannelError(
                    f"jwt_undecodable:{type(exc).__name__}",
                    code="backchannel_jwt_invalid",
                ) from exc

        try:
            header = pyjwt.get_unverified_header(token)
        except pyjwt.InvalidTokenError as exc:
            raise BackchannelError(
                f"jwt_undecodable:{type(exc).__name__}",
                code="backchannel_jwt_invalid",
            ) from exc
        # The MATERIAL decides the algorithm list, checked before any
        # key is touched — so an HS-stamped header can never meet public
        # key material (the classic confusion), and an RS-stamped one
        # can never meet the shared secret. ``none`` is refused by never
        # being on either list.
        allowed = ("HS256",) if s.jwt_shared_secret else _JWT_ALGORITHMS
        alg = str(header.get("alg") or "")
        if alg not in allowed:
            raise BackchannelError(
                f"jwt_alg_refused:{alg or 'absent'}",
                code="backchannel_jwt_invalid",
            )
        if s.jwt_shared_secret:
            key: Any = s.jwt_shared_secret
        elif s.jwt_public_key:
            # PEM text straight to pyjwt, custom_profile parity — a key
            # that does not parse refuses below as jwt_refused.
            key = s.jwt_public_key
        else:
            key = await self._verification_key(header.get("kid"))

        options: dict[str, Any] = {"require": ["exp"]}
        kwargs: dict[str, Any] = {}
        if s.jwt_audience:
            kwargs["audience"] = s.jwt_audience
        else:
            options["verify_aud"] = False
        if s.jwt_issuer:
            kwargs["issuer"] = s.jwt_issuer
        try:
            return pyjwt.decode(
                token, key=key, algorithms=list(allowed),
                options=options, **kwargs,
            )
        except pyjwt.ExpiredSignatureError as exc:
            raise BackchannelError(
                "jwt_expired", code="backchannel_jwt_expired",
            ) from exc
        except pyjwt.PyJWTError as exc:
            # PyJWTError rather than InvalidTokenError: a pasted PEM
            # that does not parse raises InvalidKeyError, which is NOT
            # an InvalidTokenError — and an operator's bad paste must be
            # a legible refusal, not a 500.
            raise BackchannelError(
                f"jwt_refused:{type(exc).__name__}",
                code="backchannel_jwt_invalid",
            ) from exc

    async def _verification_key(self, kid: Any):
        """The key *kid* names, from the configured JWKS.

        A kid the cached document does not know forces one refetch —
        that is how key rotation lands without waiting out the TTL — and
        an unknown kid after a fresh fetch is a refusal, not a guess.
        """
        key = self._key_for(await self._jwks_keys(), kid)
        if key is None:
            key = self._key_for(await self._jwks_keys(force=True), kid)
        if key is None:
            raise BackchannelError(
                f"jwt_key_unknown:{'kid' if kid else 'no_kid'}",
                code="backchannel_jwt_invalid",
            )
        return key

    async def _jwks_keys(self, *, force: bool = False) -> list:
        now = time.monotonic()
        if (
            not force
            and self._jwks is not None
            and now - self._jwks_at < _JWKS_TTL_SECONDS
        ):
            return self._jwks
        try:
            doc = await fetch_jwks(
                self._s.jwks_url, timeout=self._s.timeout_seconds,
                max_bytes=self._s.max_response_bytes,
                allow_hosts=await self._allow_hosts(),
            )
        except OutboundError as exc:
            # The key set not answering is an outage, same as the IdP
            # not answering: nobody's session should end over it, and no
            # login can proceed without it.
            raise BackchannelUnavailable(
                f"jwks_unavailable:{type(exc).__name__}"
            ) from exc
        except httpx.HTTPError as exc:
            raise BackchannelUnavailable(
                f"jwks_unreachable:{type(exc).__name__}"
            ) from exc
        self._jwks = [k for k in doc.get("keys", []) if isinstance(k, dict)]
        self._jwks_at = now
        return self._jwks

    @staticmethod
    def _key_for(keys: list, kid: Any):
        candidates = keys
        if kid is not None:
            candidates = [k for k in keys if k.get("kid") == kid]
        elif len(keys) != 1:
            # No kid on the token and more than one key on offer:
            # trying each would make "which key verified this" an
            # accident. The gateway team adds a kid, or trims the set.
            return None
        for jwk_dict in candidates:
            try:
                return pyjwt.PyJWK(jwk_dict).key
            except pyjwt.exceptions.PyJWKError:
                continue
        return None

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
            claims = await self._claims_material(payload, s.exchange_claims_path)

        return self._identity_from(claims)

    def _identity_from(self, claims: dict) -> ProviderIdentity:
        flat = hoist_nested_containers(claims)

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

        if self._s.trust_gateway_email and resolved_sources(
            flat, kind="backchannel",
            override=self._s.claim_mapping_override,
        )["email_verified"] is None:
            # No candidate claim resolved at all. The gateway answered
            # for this person over TLS on this very request — a stronger
            # statement than most IdPs' email_verified claim — but
            # corporate gateways rarely send one, and absence normalises
            # to False, which refuses the auto-link-by-email this kind
            # exists to make. Absence counts as verified while the
            # toggle is on. An explicit ``false`` resolves, so it never
            # reaches this branch and still wins.
            identity = replace(
                identity,
                raw_claims={**identity.raw_claims, "email_verified": True},
            )

        if self._s.require_auth_time and not getattr(identity, "auth_time", None):
            # Without one, ``complete_sso_login`` falls back to "now"
            # with a warning — which quietly disables the 24h SSO
            # re-auth ceiling for every session this provider mints.
            raise BackchannelError(
                "auth_time_absent", code="backchannel_auth_time_absent",
            )
        return identity

    def _unverified_claims(self, text: str) -> dict:
        """The trust_unsigned reading: BOTH reply shapes on one row — a
        bare JSON claims object, or a compact JWT decoded WITHOUT
        verification. This is what serves a gateway whose reply shape
        varies by environment; the price (impersonation by anyone who
        can reach the sign-in page, an unverified rating) was accepted
        explicitly when the flag was set."""
        if text.startswith("{"):
            try:
                claims = json.loads(text)
            except ValueError as exc:
                raise BackchannelError(
                    f"assertion_undecodable:{type(exc).__name__}",
                    code="backchannel_jwt_invalid",
                ) from exc
            if not isinstance(claims, dict):
                raise BackchannelError(
                    "assertion_undecodable:not_an_object",
                    code="backchannel_jwt_invalid",
                )
            return claims
        try:
            return pyjwt.decode(text, options={"verify_signature": False})
        except pyjwt.InvalidTokenError as exc:
            raise BackchannelError(
                f"jwt_undecodable:{type(exc).__name__}",
                code="backchannel_jwt_invalid",
            ) from exc

    async def identity_from_assertion(self, assertion: str) -> ProviderIdentity:
        """Browser mode: the translate reply, delivered by the browser.

        Everything the server shape gets for free from "we made the
        call" is reconstructed explicitly here, because a value the
        browser delivers is written by whoever sits at it until proven
        otherwise:

        * the signature says the gateway minted it — verification
          material is mandatory in this mode, so ``_decode_claims_jwt``
          always verifies. The one exception is the explicit
          ``trust_unsigned`` opt-in, which accepts either shape
          unverified and rates the connection ``unverified``;
        * ``exp`` bounds it, and is additionally carried into the
          session we mint so rotation cannot outlive it;
        * the replay burn makes it single-use — a captured assertion is
          worthless after the sign-in it was captured from.
        """
        if not assertion or not assertion.strip():
            raise BackchannelError(
                "assertion_missing", code="backchannel_no_session",
            )
        text = assertion.strip()
        now = int(time.time())

        if self._s.trust_unsigned:
            payload = self._unverified_claims(text)
            try:
                raw_exp = payload.get("exp")
                exp: Optional[int] = (
                    int(raw_exp) if raw_exp is not None else None
                )
            except (TypeError, ValueError):
                # Junk exp in an unverified payload counts as absent —
                # it proves nothing either way.
                exp = None
            if exp is not None and exp <= now:
                # Not a security claim (the field is unverified) — just
                # hygiene for legitimately stale tokens.
                raise BackchannelError(
                    "jwt_expired", code="backchannel_jwt_expired",
                )
        else:
            if text.startswith("{"):
                # No opportunistic verification: a verifying row commits
                # to signed tokens. Accepting bare JSON here would let
                # anyone bypass the signature by simply not signing —
                # the posture that accepts both shapes is
                # trust_unsigned, at the unverified rating.
                raise BackchannelError(
                    "assertion_not_a_jwt:configured_to_verify",
                    code="backchannel_jwt_invalid",
                )
            payload = await self._decode_claims_jwt(text)
            exp = int(payload.get("exp") or 0)

        jti = payload.get("jti")
        key = (
            str(jti) if isinstance(jti, (str, int)) and str(jti).strip()
            else hashlib.sha256(text.encode()).hexdigest()
        )
        if self._s.trust_unsigned:
            # The stores size their TTL from this value, and here exp is
            # attacker-writable or absent — clamp so the burn is real
            # (floor) and the store bounded (cap).
            burn = min(
                max(exp or 0, now + _UNSIGNED_REPLAY_FLOOR_SECONDS),
                now + _UNSIGNED_REPLAY_CAP_SECONDS,
            )
        else:
            burn = exp  # verified decode required exp
        try:
            fresh = await self._replay.record(key, burn)
        except Exception as exc:  # noqa: BLE001 — the store's error type
            # lives in app-land, which this package must not import.
            # "We could not check for a replay" has no floor under it,
            # so it refuses the login (fail closed) as an outage.
            raise BackchannelUnavailable(
                f"replay_store_unavailable:{type(exc).__name__}"
            ) from exc
        if not fresh:
            raise BackchannelError(
                "assertion_replayed", code="backchannel_replayed",
            )

        identity = self._identity_from(payload)
        if self._s.trust_unsigned:
            # An unverified exp still SHORTENS the session when present
            # and future (idp_exp only ever shortens); absent or past,
            # None — a 0 here would end the session at its first
            # rotation.
            ceiling = exp if (exp and exp > now) else None
        else:
            ceiling = exp
        return replace(identity, upstream_expires_at=ceiling)

    # ── Liveness ─────────────────────────────────────────────────────

    async def confirm_still_authenticated(self, ambient_token: str) -> None:
        """Re-ask the IdP whether this session is still live.

        Called on each token rotation so our session cannot outlive the
        enterprise session that created it — the gap that makes single
        logout hard for every other kind.

        Only leg 1 runs: redeeming the ambient token is the question
        being asked, and the claims are not needed to answer it. When
        the operator has configured ``liveness_url`` — the validate-only
        endpoint the contract asks gateway teams for — the same call
        goes there instead, so the re-check stops minting a token per
        renewal the moment the cheaper endpoint exists.

        Raises :class:`SessionRevokedUpstream` when the IdP says no, and
        :class:`BackchannelUnavailable` when it did not say. The caller
        must treat those differently — ending sessions on an outage
        would turn a gateway blip into a platform-wide logout.
        """
        await self._gateway(ambient_token, url=self._s.liveness_url)


def build_backchannel_provider(
    snap: ProviderConfigSnapshot,
    *,
    allowed_hosts: AllowedHostsLoader | None = None,
    replay_cache=None,
) -> BackchannelProvider:
    """Factory for the registry. Validates before returning so a
    misconfigured row raises here rather than at login time.

    ``allowed_hosts`` must be supplied by anything serving real traffic;
    ``app/main.py`` binds it. Without it the provider can still reach
    public addresses but no internal ones — which fails closed, and is
    the right default for a test. ``replay_cache`` likewise: main binds
    the shared store, and production refuses to build a browser-mode
    row without one.
    """
    settings = settings_from_snapshot(snap)
    validate_settings(settings)
    return BackchannelProvider(
        settings, allowed_hosts=allowed_hosts, replay_cache=replay_cache,
    )
