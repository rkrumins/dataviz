"""
API key tokens: minting, recognising, and reading one off a request.

A key is ``<prefix><32 random base62><6-char checksum>`` — 44 characters:

* the **prefix** names what kind of principal holds it (``nxpat_`` for a
  person's own key; ``nxsat_`` is reserved for service accounts, which
  will mint keys through the same machinery). A fixed, distinctive prefix
  is what lets secret scanners find a key pasted into a repository or a
  chat log, and what lets a request be recognised as key-authenticated
  before anything is looked up;
* the **random part** is ~190 bits from ``secrets`` — far beyond guessing,
  which is why a fast hash is the right way to store it (a slow password
  hash protects low-entropy secrets and would only cost every request);
* the **checksum** (CRC32 of everything before it) lets a typo or a
  made-up string be refused without a database lookup, and lets a scanner
  tell a real key from a lookalike. It is not a MAC: anyone can compute
  one, so a well-formed token proves nothing about being genuine.

Only ``hash_token(token)`` is ever stored. The token itself is shown to
its owner once, at creation, and never again.

It also holds the rules that decide whether a stored key may act now —
read by the request path and by the pages that show a key's status, so the
two cannot disagree.

Pure functions, no I/O, and nothing from ``backend.app`` — this package
is kept separable (``tests/test_auth_service_isolation.py``).
"""
from __future__ import annotations

import hashlib
import ipaddress
import json
import secrets
import zlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Mapping, Optional

from .password import is_password_set

#: A person's own key, acting as them.
KIND_PERSONAL = "personal"
#: Reserved for service accounts — non-human principals. Recognised here so
#: the format, the scanners and the CSRF exemption need no change when they
#: arrive; nothing mints one yet.
KIND_SERVICE = "service"

_PREFIX_BY_KIND = {
    KIND_PERSONAL: "nxpat_",
    KIND_SERVICE: "nxsat_",
}
_KIND_BY_PREFIX = {prefix: kind for kind, prefix in _PREFIX_BY_KIND.items()}
_PREFIX_LEN = 6

_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
_ALPHABET_SET = frozenset(_ALPHABET)
_RANDOM_LEN = 32
_CHECKSUM_LEN = 6
TOKEN_LENGTH = _PREFIX_LEN + _RANDOM_LEN + _CHECKSUM_LEN

#: How much of the random part the owner sees in lists, after the prefix.
#: Enough to tell their keys apart and to find one in a config file; 8 of 32
#: characters still leaves ~142 bits unknown.
_DISPLAY_RANDOM_CHARS = 8


@dataclass(frozen=True)
class GeneratedKey:
    """A freshly minted key. ``token`` exists only in this object and in the
    one response that shows it to its owner; store ``token_hash``."""

    token: str
    display_prefix: str
    token_hash: str
    kind: str


def _base62(value: int, width: int) -> str:
    digits = []
    for _ in range(width):
        value, rem = divmod(value, 62)
        digits.append(_ALPHABET[rem])
    return "".join(reversed(digits))


def _checksum(body: str) -> str:
    # 62**6 > 2**32, so every CRC32 fits the fixed width.
    return _base62(zlib.crc32(body.encode("ascii")) & 0xFFFFFFFF, _CHECKSUM_LEN)


def generate(kind: str = KIND_PERSONAL) -> GeneratedKey:
    """Mint a new key of *kind*."""
    prefix = _PREFIX_BY_KIND[kind]
    random_part = "".join(secrets.choice(_ALPHABET) for _ in range(_RANDOM_LEN))
    body = prefix + random_part
    token = body + _checksum(body)
    return GeneratedKey(
        token=token,
        display_prefix=prefix + random_part[:_DISPLAY_RANDOM_CHARS],
        token_hash=hash_token(token),
        kind=kind,
    )


def kind_of(token: str) -> Optional[str]:
    """The kind a token's prefix names, or ``None`` if it names none."""
    return _KIND_BY_PREFIX.get(token[:_PREFIX_LEN]) if token else None


def looks_valid(token: Optional[str]) -> bool:
    """Whether *token* is well formed: a known prefix, the right length and
    alphabet, and a checksum that matches. Says nothing about whether the key
    exists or is still honoured."""
    if not token or len(token) != TOKEN_LENGTH or kind_of(token) is None:
        return False
    tail = token[_PREFIX_LEN:]
    if not _ALPHABET_SET.issuperset(tail):
        return False
    body, checksum = token[:-_CHECKSUM_LEN], token[-_CHECKSUM_LEN:]
    return secrets.compare_digest(_checksum(body), checksum)


def hash_token(token: str) -> str:
    """What is stored and looked up: SHA-256 of the whole token, hex."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def bearer_api_key(headers: Mapping[str, str]) -> Optional[str]:
    """The API key this request presents in ``Authorization: Bearer``, if any.

    Recognised by prefix alone, not validity: a request that *claims* to be
    key-authenticated is treated as one — its cookies are ignored and a bad
    key is refused — rather than quietly falling back to whatever session
    cookie happens to ride along. The one predicate decides both the CSRF
    exemption and which authentication path runs, so the two cannot
    disagree.

    Only the header is read. A key in a query string ends up in access logs,
    proxy logs and browser history (RFC 6750 §5.3), so it is never looked
    for there.
    """
    raw = headers.get("authorization") or headers.get("Authorization")
    if not raw:
        return None
    parts = raw.strip().split(None, 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        return None
    candidate = parts[1].strip()
    return candidate if kind_of(candidate) is not None else None


# ── Whether a stored key may act ────────────────────────────────────


def parse_instant(value: Optional[str]) -> Optional[datetime]:
    """An ISO-8601 instant as an aware datetime (naive reads as UTC), or
    ``None`` for nothing or nonsense."""
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def effective_expiry(key, *, max_lifetime_days: Optional[int]) -> Optional[datetime]:
    """When the key stops working: its own expiry, or the deployment's
    maximum lifetime counted from creation, whichever is sooner."""
    expiry = parse_instant(key.expires_at)
    created = parse_instant(key.created_at)
    if max_lifetime_days is not None and created is not None:
        cap = created + timedelta(days=max_lifetime_days)
        expiry = cap if expiry is None else min(expiry, cap)
    return expiry


def lifecycle_refusal(
    key,
    owner,
    *,
    identity_count: int,
    idp_last_login_at: Optional[str],
    now: datetime,
    sso_signin_window_days: Optional[int],
    max_lifetime_days: Optional[int],
) -> Optional[str]:
    """Why this key may not act now — ``revoked``, ``expired``,
    ``owner_inactive`` or ``owner_reauth_required`` — or ``None`` if it may.

    The owner must still be someone who could sign in, and not a break-glass
    (system) account: one is kept for when nobody else can sign in, and
    nothing should run as it day to day, so its keys stop while it is one —
    and come back if it stops being one. With an SSO identity,
    that means their identity provider has vouched for them recently: the
    platform hears about a leaver only when they next try to sign in, so a
    key must not outlive that silence for long. With neither a password nor
    an identity, nobody can sign in as them at all.
    """
    if key.revoked_at:
        return "revoked"
    expiry = effective_expiry(key, max_lifetime_days=max_lifetime_days)
    if expiry is not None and expiry <= now:
        return "expired"
    if (
        owner.deleted_at is not None or owner.status != "active"
        or getattr(owner, "is_system_account", False)
    ):
        return "owner_inactive"
    if identity_count:
        if sso_signin_window_days is not None:
            last = parse_instant(idp_last_login_at)
            if last is None or now - last > timedelta(days=sso_signin_window_days):
                return "owner_reauth_required"
    elif not is_password_set(getattr(owner, "password_hash", None)):
        return "owner_reauth_required"
    return None


def client_address(raw: Optional[str]) -> Optional[str]:
    """A client address as the canonical text of an IP address — an
    IPv4-mapped IPv6 address as its IPv4 form — or ``None`` for anything
    that is not one. What comes off a request (or out of a forwarded-for
    header a proxy passed on) is only ever recorded, compared or shown in
    this form, so it can never carry text into a notification or the audit
    log."""
    if not raw:
        return None
    try:
        address = ipaddress.ip_address(str(raw).strip())
    except ValueError:
        return None
    if address.version == 6 and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    return str(address)


def address_bucket(client_ip: Optional[str]) -> str:
    """The bucket a client address's budget of refused keys is counted in:
    the address itself, or for IPv6 its /64 — one host's allocation, which
    it can rotate through freely."""
    address = client_address(client_ip)
    if address is None:
        return "unknown"
    if ":" in address:
        return str(ipaddress.ip_network(f"{address}/64", strict=False))
    return address


def address_allowed(client_ip: Optional[str], raw_cidrs: Optional[str]) -> bool:
    """Whether a key restricted to networks was presented from one of them.
    A key with no restriction allows every address; a restricted key and an
    address that cannot be read do not mix."""
    try:
        cidrs = json.loads(raw_cidrs) if raw_cidrs else []
    except (TypeError, ValueError):
        cidrs = None
    if cidrs == []:
        return True
    if not isinstance(cidrs, list) or not client_ip:
        return False
    try:
        address = ipaddress.ip_address(client_ip)
    except ValueError:
        return False
    if address.version == 6 and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    for cidr in cidrs:
        try:
            if address in ipaddress.ip_network(str(cidr), strict=False):
                return True
        except ValueError:
            continue
    return False


__all__ = [
    "KIND_PERSONAL",
    "address_bucket",
    "client_address",
    "KIND_SERVICE",
    "TOKEN_LENGTH",
    "GeneratedKey",
    "generate",
    "kind_of",
    "looks_valid",
    "hash_token",
    "bearer_api_key",
    "parse_instant",
    "effective_expiry",
    "lifecycle_refusal",
    "address_allowed",
]
