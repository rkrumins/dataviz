"""Outbound HTTP for IdP metadata, with the target constrained.

Three provider paths fetch a URL an administrator typed: OIDC discovery,
the JWKS endpoint named by that discovery document, and SAML IdP
metadata. Each used a bare ``httpx`` GET, which made
``POST /admin/idp-providers/discover`` an arbitrary-URL request issued
from inside the cluster, with the response body handed back to the
caller. ``http://169.254.169.254/latest/meta-data/`` is the canonical
example; a Redis admin port or an internal service's health endpoint is
the more useful one.

It is admin-gated, so this is not an unauthenticated hole. It is still
worth closing: the whole point of the network position this service
holds is that it can reach things the admin's browser cannot, and
"an admin would never" is not an access control.

What this does NOT fully solve is DNS rebinding — the name is resolved
here and resolved again by the connection, and a hostile resolver can
answer differently. Pinning the checked address into the connection
needs a custom transport; the resolve-time check raises the bar
substantially and is where the standard mitigations sit.
"""
from __future__ import annotations

import ipaddress
import json
import logging
import os
import re
import socket
from typing import Any
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

#: The shape of a compact JWS: three base64url segments. A transport-level
#: check only — whether the token verifies is the caller's business. The
#: signature segment may be empty here because the *shape* of an unsecured
#: JWT is still this shape; the decode layer refuses ``alg: none``.
_COMPACT_JWS_RE = re.compile(r"^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$")

#: Metadata documents are small. A cap stops a hostile or misconfigured
#: endpoint streaming until the worker runs out of memory.
MAX_METADATA_BYTES = 1024 * 1024

_PROD_ENV_VALUES = {"prod", "production"}


class OutboundError(RuntimeError):
    """An outbound request that did not produce a usable response."""


class BlockedOutboundRequest(OutboundError):
    """The URL resolves somewhere this service must not reach, or the
    response broke one of the transport rules — a redirect, an oversized
    body, a body that is not JSON."""


class OutboundStatusError(OutboundError):
    """The endpoint answered, with a status we cannot use.

    Separate from :class:`BlockedOutboundRequest` because the *status*
    is the whole signal for one caller: the back-channel liveness check
    has to tell "the IdP says this session is over" (401/403 — act on
    it, end the session) from "the IdP did not answer properly"
    (5xx — do not act on it, this is an outage). Collapsing the two
    would either log everyone out during a gateway incident or keep
    sessions alive after they were revoked upstream.
    """

    def __init__(self, url: str, status_code: int) -> None:
        super().__init__(f"{url!r} answered HTTP {status_code}.")
        self.status_code = status_code


def _is_prod() -> bool:
    return os.getenv("ENV", "dev").strip().lower() in _PROD_ENV_VALUES


def _unwrap(ip: ipaddress._BaseAddress) -> ipaddress._BaseAddress:
    """Resolve an IPv4-mapped IPv6 address to its IPv4 form.

    ``::ffff:169.254.169.254`` is the same destination as
    ``169.254.169.254``, and a check that reads only the properties of
    the outer form misses it.
    """
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped if mapped is not None else ip


def _address_is_never_reachable(ip: ipaddress._BaseAddress) -> bool:
    """True for addresses no allowlist may ever unlock.

    ``assert_fetchable`` can be told to permit a private address, because
    an internal IdP gateway legitimately lives on one. These are the
    addresses where that argument does not apply:

    * **link-local** — ``169.254.169.254`` is the cloud metadata service.
      This is the entry that matters. Reaching it turns a
      request-forgery into instance-credential theft, and no identity
      provider is ever hosted there.
    * **loopback** — the process's own admin surfaces: Redis, debug
      ports, the app's internal endpoints.
    * multicast, reserved, unspecified — not a destination at all.

    Kept as a property check rather than a CIDR list so the IPv6 forms
    come along for free.
    """
    ip = _unwrap(ip)
    return (
        ip.is_loopback
        or ip.is_link_local    # 169.254.0.0/16 — cloud metadata
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _address_is_reachable(ip: ipaddress._BaseAddress) -> bool:
    """False for anything that is not a public internet address.

    Deliberately a denylist of address *properties* rather than of
    literals: ``is_private`` alone misses link-local (cloud metadata),
    and a hand-written list of CIDRs misses IPv6 forms of the same
    ranges — ``::ffff:169.254.169.254`` being the obvious one, which is
    why mapped addresses are unwrapped first.
    """
    ip = _unwrap(ip)
    return not (
        ip.is_private          # RFC1918, ULA
        or _address_is_never_reachable(ip)
    )


def host_port_key(url: str) -> str:
    """The ``host:port`` an allowlist entry has to match, exactly.

    Normalised so ``GW.Corp.Internal.`` and ``gw.corp.internal:443``
    are one entry rather than three. The port is always explicit: an
    operator permitting ``gw.corp.internal`` for https must not thereby
    permit ``gw.corp.internal:6379``, which is a different service
    entirely on the same box.
    """
    parts = urlsplit(url)
    host = (parts.hostname or "").strip().lower().rstrip(".")
    port = parts.port or (443 if (parts.scheme or "").lower() == "https" else 80)
    return f"{host}:{port}"


def assert_fetchable(
    url: str, *, allow_hosts: frozenset[str] | set[str] = frozenset(),
) -> None:
    """Raise unless *url* is an endpoint we may request.

    Called before the request rather than relying on the response,
    because an SSRF's value is often in the side effect (a POST-like GET
    to an internal admin endpoint) rather than in what comes back.

    ``allow_hosts`` holds ``host:port`` strings — see :func:`host_port_key`
    — that may resolve to a **private** address. An internal identity
    gateway is the reason it exists: it is on RFC1918 by definition, so
    without an exception this function refuses the only destination that
    flow has. It relaxes exactly one check. Scheme, the production https
    requirement, and :func:`_address_is_never_reachable` are unchanged by
    it, so no allowlist entry can reach cloud metadata or loopback.

    Note what an entry does and does not buy: it names a *host*, not an
    address, so a host whose DNS is hostile can still move between
    private addresses. That is the same reach the entry already grants,
    which is why it is acceptable — and why the never-reachable floor is
    an address check rather than a name check.
    """
    parts = urlsplit(url)
    scheme = (parts.scheme or "").lower()

    if scheme not in ("http", "https"):
        raise BlockedOutboundRequest(
            f"{scheme or 'relative'!r} is not a fetchable scheme; "
            "IdP metadata must be served over https."
        )
    if scheme == "http" and _is_prod():
        raise BlockedOutboundRequest(
            "refusing to fetch IdP metadata over plain http in production — "
            "the document decides which keys verify your users' tokens."
        )
    host = parts.hostname
    if not host:
        raise BlockedOutboundRequest(f"no host in {url!r}")

    try:
        resolved = socket.getaddrinfo(
            host, parts.port or (443 if scheme == "https" else 80),
        )
    except socket.gaierror:
        # Cannot resolve, so cannot judge — and cannot reach either. The
        # connection is about to consult the same resolver and fail with
        # a better message than anything invented here, so this is not
        # treated as a refusal. Blocking would add no protection (an
        # unresolvable host is not an SSRF target) while breaking
        # split-horizon DNS and every transient resolver blip.
        logger.debug("Skipping address check for unresolvable host %r", host)
        return

    permitted = host_port_key(url) in {
        str(entry).strip().lower() for entry in allow_hosts
    }

    for family, _type, _proto, _canon, sockaddr in resolved:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        ip = ipaddress.ip_address(sockaddr[0])
        if _address_is_never_reachable(ip):
            # Deliberately checked before the allowlist, and worded so
            # the log says which floor was hit. An operator who has
            # allowlisted this host still does not get here.
            raise BlockedOutboundRequest(
                f"{host!r} resolves to {ip}, which is a loopback, "
                "link-local, or otherwise non-routable address. No "
                "allowlist entry permits this."
            )
        if not _address_is_reachable(ip) and not permitted:
            raise BlockedOutboundRequest(
                f"{host!r} resolves to {ip}, which is inside this "
                "deployment's own network, and "
                f"{host_port_key(url)!r} is not in the allowlist."
            )


async def fetch_metadata(url: str, *, timeout: float) -> httpx.Response:
    """GET *url* once, with redirects off and the body bounded.

    Redirects are disabled rather than followed-and-rechecked: a 302 to
    an internal address is the standard way around a pre-flight check,
    and no IdP needs one to serve its own metadata.
    """
    assert_fetchable(url)
    async with httpx.AsyncClient(
        timeout=timeout, follow_redirects=False,
    ) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        if len(resp.content) > MAX_METADATA_BYTES:
            raise BlockedOutboundRequest(
                f"{url!r} returned {len(resp.content)} bytes; the cap is "
                f"{MAX_METADATA_BYTES}."
            )
        return resp


#: Back-channel identity responses are a user object, not a document.
#: Separate from ``MAX_METADATA_BYTES`` so tightening one does not
#: silently retune the other.
MAX_JSON_BYTES = 256 * 1024


async def request_json(
    url: str,
    *,
    method: str = "POST",
    json_body: dict | None = None,
    headers: dict[str, str] | None = None,
    cookies: dict[str, str] | None = None,
    timeout: float,
    max_bytes: int = MAX_JSON_BYTES,
    allow_hosts: frozenset[str] | set[str] = frozenset(),
    accept_jwt: bool = False,
) -> Any:
    """Make one guarded credentialed request and return the parsed JSON.

    ``accept_jwt`` widens exactly one refusal: a body that is not JSON
    but *is* a compact JWS (three base64url segments — the way a corporate
    token-translation endpoint answers with the token as the whole body)
    is returned as a string instead of being blocked. Anything else that
    is not JSON stays an error. A JWT arriving inside JSON needs no flag
    — it is just a string value the caller resolves a path to.

    The helper this module should have had from the start.
    :func:`fetch_metadata` is GET-only, so the one credentialed
    back-channel call that already existed — the OIDC token exchange —
    was written as a bare ``httpx.post`` and inherited none of the
    protections here: no pre-flight address check, redirects followed,
    no size cap. Moving that call onto this function is worth doing and
    is deliberately not done in the same change.

    What is guarded:

    * the destination, via :func:`assert_fetchable` before we connect;
    * **redirects, which are refused rather than followed** — a 302 to
      an internal address is the standard way around a pre-flight check,
      so a 3xx is an error here, not a hop;
    * the response size, capped **while streaming** rather than after
      the fact, so a hostile endpoint cannot exhaust the worker before
      the check runs;
    * the clock, via an explicit caller-supplied timeout.

    Errors never carry the response body. This is called on behalf of an
    administrator who may be shown the failure, and a helper that echoed
    what an internal address replied would turn a blocked request into a
    working one.
    """
    assert_fetchable(url, allow_hosts=allow_hosts)

    async with httpx.AsyncClient(
        timeout=timeout, follow_redirects=False,
    ) as client:
        async with client.stream(
            method.upper(), url,
            json=json_body, headers=headers, cookies=cookies,
        ) as resp:
            if 300 <= resp.status_code < 400:
                raise BlockedOutboundRequest(
                    f"{url!r} answered {resp.status_code} with a redirect; "
                    "redirects are refused because they are how a "
                    "pre-flight address check gets bypassed."
                )
            if resp.status_code >= 400:
                raise OutboundStatusError(url, resp.status_code)
            body = bytearray()
            async for chunk in resp.aiter_bytes():
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise BlockedOutboundRequest(
                        f"{url!r} exceeded the {max_bytes}-byte response cap."
                    )

    try:
        return json.loads(bytes(body))
    except (ValueError, UnicodeDecodeError) as exc:
        if accept_jwt:
            try:
                text = bytes(body).decode("ascii").strip()
            except UnicodeDecodeError:
                text = ""
            if _COMPACT_JWS_RE.fullmatch(text):
                return text
        # The parse error, not the payload — see the note above.
        raise BlockedOutboundRequest(
            f"{url!r} did not return valid JSON ({type(exc).__name__})."
        ) from exc


#: Profile pictures fetched at SSO login. Small on purpose: this is an
#: avatar, not an asset store, and the bytes are re-served from our own
#: origin on every member list.
MAX_AVATAR_BYTES = 256 * 1024

#: The content types an avatar fetch will accept, parameter-stripped and
#: case-folded. Anything else — HTML, JSON, SVG (scriptable) — is not an
#: image we are willing to re-serve.
_AVATAR_IMAGE_TYPES = frozenset({
    "image/png", "image/jpeg", "image/gif", "image/webp",
})


async def fetch_image(
    url: str,
    *,
    timeout: float,
    max_bytes: int = MAX_AVATAR_BYTES,
    allow_hosts: frozenset[str] | set[str] = frozenset(),
) -> tuple[bytes, str]:
    """GET one image with :func:`request_json`'s guards, returning
    ``(bytes, content_type)``.

    Same posture as every outbound call here: destination pre-checked,
    redirects refused, the body capped while streaming. The one addition
    is the content-type allowlist — the bytes are stored and re-served
    from our own origin, so a reply that is not a raster image is a
    refusal, not a passthrough.
    """
    assert_fetchable(url, allow_hosts=allow_hosts)

    async with httpx.AsyncClient(
        timeout=timeout, follow_redirects=False,
    ) as client:
        async with client.stream("GET", url) as resp:
            if 300 <= resp.status_code < 400:
                raise BlockedOutboundRequest(
                    f"{url!r} answered {resp.status_code} with a redirect; "
                    "redirects are refused because they are how a "
                    "pre-flight address check gets bypassed."
                )
            if resp.status_code >= 400:
                raise OutboundStatusError(url, resp.status_code)
            content_type = (
                resp.headers.get("content-type") or ""
            ).split(";")[0].strip().lower()
            if content_type not in _AVATAR_IMAGE_TYPES:
                raise BlockedOutboundRequest(
                    f"{url!r} answered with content-type "
                    f"{content_type or 'unknown'!r}, which is not an "
                    "image type this fetch accepts."
                )
            body = bytearray()
            async for chunk in resp.aiter_bytes():
                body.extend(chunk)
                if len(body) > max_bytes:
                    raise BlockedOutboundRequest(
                        f"{url!r} exceeded the {max_bytes}-byte image cap."
                    )
    return bytes(body), content_type


async def fetch_jwks(
    url: str,
    *,
    timeout: float,
    max_bytes: int = MAX_JSON_BYTES,
    allow_hosts: frozenset[str] | set[str] = frozenset(),
) -> dict:
    """GET a JWKS document through the same guards as every other call.

    Exists so nobody reaches for PyJWT's ``PyJWKClient``, which fetches
    with its own urllib stack — no pre-flight address check, redirects
    followed, no size cap. The key set decides which signatures verify,
    so it is fetched with *more* care than an identity response, not
    less.
    """
    doc = await request_json(
        url, method="GET", timeout=timeout, max_bytes=max_bytes,
        allow_hosts=allow_hosts,
    )
    if not isinstance(doc, dict) or not isinstance(doc.get("keys"), list):
        raise BlockedOutboundRequest(
            f"{url!r} did not return a JWKS document (an object with a "
            "'keys' array)."
        )
    return doc
