"""Where an outbound connection may go, decided by address property.

One classifier for every path that opens a connection to a destination an
administrator typed: the SSO metadata and back-channel fetches
(``backend/auth_service/providers/outbound.py``) and the AI service's
completion, token and MCP endpoints (``backend/ai_service``). Two
independent allowlists drift — ``docs/TECHNICAL_DEBT.md`` §1.2 and §4 — so
this module is the one place the rule lives, and it imports nothing from
``auth_service`` or ``backend.app``.

The rule:

* a **never-reachable** address — loopback, link-local (cloud metadata at
  ``169.254.169.254``), multicast, reserved, unspecified — is refused, and
  no allowlist entry changes that;
* a **private** address (RFC1918, ULA) is refused unless the caller names
  its ``host:port`` in an allowlist — an internal gateway legitimately
  lives on one;
* anything else is a public address and may be reached.

IPv4-mapped IPv6 forms are unwrapped first, so ``::ffff:169.254.169.254``
is the metadata service too. DNS rebinding is not solved here (the name is
resolved again by the connection); see the outbound module's docstring.
"""
from __future__ import annotations

import ipaddress
import logging
import socket
from typing import Iterable, Optional
from urllib.parse import urlsplit

logger = logging.getLogger(__name__)


class AddressRefused(ValueError):
    """The destination resolves somewhere this process must not connect.

    ``reason`` is a stable token: ``unroutable_address`` (no allowlist
    unlocks it) or ``private_address_not_allowlisted``.
    """

    def __init__(self, message: str, *, reason: str) -> None:
        super().__init__(message)
        self.reason = reason


def unwrap(ip: ipaddress._BaseAddress) -> ipaddress._BaseAddress:
    """Resolve an IPv4-mapped IPv6 address to its IPv4 form."""
    mapped = getattr(ip, "ipv4_mapped", None)
    return mapped if mapped is not None else ip


def is_never_reachable(ip: ipaddress._BaseAddress) -> bool:
    """True for addresses no allowlist may ever unlock.

    Link-local is the entry that matters: reaching the cloud metadata
    service turns a request forgery into instance-credential theft.
    Loopback is the process's own admin surfaces. Kept as a property check
    rather than a CIDR list so the IPv6 forms come along for free.
    """
    ip = unwrap(ip)
    return (
        ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def is_public(ip: ipaddress._BaseAddress) -> bool:
    """False for anything that is not a public internet address."""
    ip = unwrap(ip)
    return not (ip.is_private or is_never_reachable(ip))


def host_port_key(url: str) -> str:
    """The ``host:port`` an allowlist entry has to match, exactly.

    Normalised so ``GW.Corp.Internal.`` and ``gw.corp.internal:443`` are
    one entry. The port is always explicit: permitting a host for https
    must not permit another service on the same box.
    """
    parts = urlsplit(url)
    host = (parts.hostname or "").strip().lower().rstrip(".")
    port = parts.port or (443 if (parts.scheme or "").lower() == "https" else 80)
    return f"{host}:{port}"


def normalise_allowlist(entries: Iterable[str]) -> frozenset[str]:
    """Lower-cased, stripped ``host:port`` entries; blanks dropped."""
    return frozenset(
        str(entry).strip().lower().rstrip(".")
        for entry in entries
        if str(entry).strip()
    )


def assert_connectable(
    host: str, port: int, *, permitted: bool = False,
) -> None:
    """Raise :class:`AddressRefused` unless *host*:*port* may be reached.

    *permitted* says the caller's allowlist names this ``host:port``; it
    relaxes the private-address check and nothing else.

    A host that does not resolve is not refused: it cannot be reached
    either, and the connection that follows fails with a better message.
    Blocking would break split-horizon DNS and resolver blips while adding
    no protection.
    """
    try:
        resolved = socket.getaddrinfo(host, port)
    except socket.gaierror:
        logger.debug("Skipping address check for unresolvable host %r", host)
        return
    for family, _type, _proto, _canon, sockaddr in resolved:
        if family not in (socket.AF_INET, socket.AF_INET6):
            continue
        ip = ipaddress.ip_address(sockaddr[0])
        if is_never_reachable(ip):
            raise AddressRefused(
                f"{host!r} resolves to {ip}, which is a loopback, link-local, "
                "or otherwise non-routable address. No allowlist entry "
                "permits this.",
                reason="unroutable_address",
            )
        if not is_public(ip) and not permitted:
            raise AddressRefused(
                f"{host!r} resolves to {ip}, which is inside this "
                f"deployment's own network, and '{host}:{port}' is not in "
                "the allowlist.",
                reason="private_address_not_allowlisted",
            )


def assert_url_connectable(
    url: str, *, allow_hosts: Optional[Iterable[str]] = None,
) -> None:
    """:func:`assert_connectable` for a URL's host and port.

    Scheme rules (https in production and so on) are the caller's: they
    differ between an IdP metadata fetch and a completion endpoint. This
    checks only where the URL resolves.
    """
    parts = urlsplit(url)
    host = parts.hostname
    if not host:
        raise AddressRefused(f"no host in {url!r}", reason="no_host")
    scheme = (parts.scheme or "").lower()
    port = parts.port or (443 if scheme == "https" else 80)
    permitted = host_port_key(url) in normalise_allowlist(allow_hosts or ())
    assert_connectable(host, port, permitted=permitted)
