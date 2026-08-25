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
import logging
import os
import socket
from urllib.parse import urlsplit

import httpx

logger = logging.getLogger(__name__)

#: Metadata documents are small. A cap stops a hostile or misconfigured
#: endpoint streaming until the worker runs out of memory.
MAX_METADATA_BYTES = 1024 * 1024

_PROD_ENV_VALUES = {"prod", "production"}


class BlockedOutboundRequest(RuntimeError):
    """The URL resolves somewhere this service must not reach."""


def _is_prod() -> bool:
    return os.getenv("ENV", "dev").strip().lower() in _PROD_ENV_VALUES


def _address_is_reachable(ip: ipaddress._BaseAddress) -> bool:
    """False for anything that is not a public internet address.

    Deliberately a denylist of address *properties* rather than of
    literals: ``is_private`` alone misses link-local (cloud metadata),
    and a hand-written list of CIDRs misses IPv6 forms of the same
    ranges — ``::ffff:169.254.169.254`` being the obvious one, which is
    why mapped addresses are unwrapped first.
    """
    if getattr(ip, "ipv4_mapped", None) is not None:
        ip = ip.ipv4_mapped  # type: ignore[assignment]
    return not (
        ip.is_private          # RFC1918, ULA
        or ip.is_loopback
        or ip.is_link_local    # 169.254.0.0/16 — cloud metadata
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def assert_fetchable(url: str) -> None:
    """Raise unless *url* is a public https endpoint we may request.

    Called before the request rather than relying on the response,
    because an SSRF's value is often in the side effect (a POST-like GET
    to an internal admin endpoint) rather than in what comes back.
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

    for family, _type, _proto, _canon, sockaddr in resolved:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        ip = ipaddress.ip_address(sockaddr[0])
        if not _address_is_reachable(ip):
            raise BlockedOutboundRequest(
                f"{host!r} resolves to {ip}, which is inside this "
                "deployment's own network. IdP metadata must be on a "
                "publicly routable host."
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
