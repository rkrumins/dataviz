"""Repository: ``sso_backchannel_hosts``.

The exception list for the outbound SSRF guard. ``assert_fetchable``
refuses every private address, which is right for IdP metadata — that
is published on the public internet — and fatal for a back-channel
identity gateway, which is on RFC1918 by definition.

Two rules this module exists to enforce, both of which are the whole
security argument for letting operators edit this at all:

* **Normalise before storing.** ``GW.Corp.Internal.`` and
  ``gw.corp.internal`` are one destination, and an allowlist where a
  destination can be spelled three ways is an allowlist an operator
  cannot audit by reading it.
* **The port is never implicit.** Permitting a gateway on 443 must not
  also permit whatever answers on 6379 on the same box.

Since the avatar allowlist arrived the table holds two lists, told
apart by ``purpose``: ``gateway`` rows (the original exception list)
and ``avatar`` rows, the external image hosts in-app avatars may be
fetched from. Same rules, same normalisation, filtered reads.

What this list cannot do is unlock loopback or link-local. Those are
refused in ``auth_service.providers.outbound`` regardless of what is
stored here, so no row — however it was created — reaches the cloud
metadata service.

No caching. A removed entry must stop working on the next request, not
a TTL later; that is the revocation half of "attributable and
revocable" and it is cheap, since the read is one small indexed query
per login.
"""
from __future__ import annotations

import ipaddress
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import SsoBackchannelHostORM

logger = logging.getLogger(__name__)


#: A hostname label per RFC 1123, or an IP literal (checked separately).
_HOSTNAME_RE = re.compile(
    r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
    r"(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$"
)


class BackchannelHostError(ValueError):
    """A host entry the admin layer should turn into a 400."""


#: The flows an entry can serve. ``gateway`` relaxes the private-address
#: refusal for the back-channel legs; ``avatar`` names the external image
#: hosts in-app avatars may be fetched from. Distinct lists on one table:
#: same normalisation, attribution and next-request revocation.
HOST_PURPOSES = ("gateway", "avatar")


def normalise_purpose(raw: str) -> str:
    purpose = (raw or "").strip().lower()
    if purpose not in HOST_PURPOSES:
        raise BackchannelHostError(
            f"'{raw}' is not a host-list purpose; expected one of "
            f"{', '.join(HOST_PURPOSES)}."
        )
    return purpose


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def normalise_host(raw: str) -> str:
    """Lowercase, strip whitespace and the trailing root dot.

    Rejects anything that is neither a valid hostname nor an IP
    literal. A wildcard, a CIDR, or a URL pasted whole are all refused
    here rather than stored and silently never matched — an entry that
    looks present but matches nothing is worse than an error, because
    the operator stops looking.
    """
    host = (raw or "").strip().lower().rstrip(".")
    if not host:
        raise BackchannelHostError("host is required")
    # Bracketed IPv6 as it appears inside a URL. Stored unbracketed,
    # because that is what ``urlsplit(...).hostname`` yields and the two
    # forms have to be the same entry.
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    # IP literals are checked BEFORE the punctuation rules below: an
    # IPv6 address is all colons, and rejecting colons outright made a
    # v6-only gateway impossible to allow.
    try:
        ipaddress.ip_address(host)
        return host
    except ValueError:
        pass
    if "*" in host or "/" in host or ":" in host:
        raise BackchannelHostError(
            f"'{raw}' is not a plain hostname. Wildcards, CIDR ranges and "
            "URLs are not accepted — enter one host, and set the port "
            "separately."
        )
    if not _HOSTNAME_RE.match(host):
        raise BackchannelHostError(f"'{raw}' is not a valid hostname.")
    return host


def normalise_port(raw: object) -> int:
    try:
        port = int(raw)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        raise BackchannelHostError(f"'{raw}' is not a port number.") from None
    if not 1 <= port <= 65535:
        raise BackchannelHostError(f"port {port} is out of range.")
    return port


def entry_key(row: SsoBackchannelHostORM) -> str:
    """The ``host:port`` string ``assert_fetchable`` matches against."""
    return f"{row.host}:{row.port}"


async def list_hosts(
    session: AsyncSession, *, purpose: str = "gateway",
) -> list[SsoBackchannelHostORM]:
    clean_purpose = normalise_purpose(purpose)
    rows = await session.execute(
        select(SsoBackchannelHostORM)
        .where(SsoBackchannelHostORM.purpose == clean_purpose)
        .order_by(SsoBackchannelHostORM.host, SsoBackchannelHostORM.port)
    )
    return list(rows.scalars().all())


async def allowed_host_keys(
    session: AsyncSession, *, purpose: str = "gateway",
) -> frozenset[str]:
    """The set to hand :func:`assert_fetchable` as ``allow_hosts``."""
    return frozenset(
        entry_key(row) for row in await list_hosts(session, purpose=purpose)
    )


async def add_host(
    session: AsyncSession, *, host: str, port: object = 443,
    purpose: str = "gateway",
    note: Optional[str] = None, created_by: Optional[str] = None,
) -> SsoBackchannelHostORM:
    """Add one entry. Idempotent on ``(purpose, host, port)``.

    Returns the existing row rather than raising on a duplicate: two
    operators adding the same gateway is not an error, and the
    alternative is a 409 that tells them nothing they need to act on.
    """
    clean_host = normalise_host(host)
    clean_port = normalise_port(port)
    clean_purpose = normalise_purpose(purpose)

    existing = await session.execute(
        select(SsoBackchannelHostORM).where(
            SsoBackchannelHostORM.purpose == clean_purpose,
            SsoBackchannelHostORM.host == clean_host,
            SsoBackchannelHostORM.port == clean_port,
        )
    )
    row = existing.scalar_one_or_none()
    if row is not None:
        return row

    row = SsoBackchannelHostORM(
        id=f"bch_{uuid.uuid4().hex[:12]}",
        purpose=clean_purpose,
        host=clean_host,
        port=clean_port,
        note=(note or "").strip() or None,
        created_at=_now(),
        created_by=created_by,
    )
    session.add(row)
    await session.flush()
    logger.info(
        "SSO outbound host allowed (%s): %s:%s (by=%s)",
        clean_purpose, clean_host, clean_port, created_by,
    )
    return row


async def get_host(
    session: AsyncSession, host_id: str,
) -> Optional[SsoBackchannelHostORM]:
    """One entry by id, whichever list it is on."""
    row = await session.execute(
        select(SsoBackchannelHostORM).where(
            SsoBackchannelHostORM.id == host_id,
        )
    )
    return row.scalar_one_or_none()


async def delete_host(session: AsyncSession, host_id: str) -> bool:
    """Remove one entry. True when a row was actually deleted."""
    result = await session.execute(
        delete(SsoBackchannelHostORM).where(
            SsoBackchannelHostORM.id == host_id,
        )
    )
    return bool(result.rowcount)
