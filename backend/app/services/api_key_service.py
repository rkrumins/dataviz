"""What an API key may do on a request, and the record of keys refused.

Injected into ``LocalIdentityService`` (which may not import ``backend.app``)
as the claims resolver and the rejection hook of ``validate_api_key``.

**Claims are cached per key, for at most 30 seconds.** Resolving them reads
the owner's bindings, groups and memberships, and an integration calling
hundreds of times a minute must not repeat that on every call. So a change to
what the owner may do — a role or group change, a removed membership —
reaches their keys within 30 seconds. What must be immediate is read on
every request instead: the key itself (revoked? expired?), its owner's
status (suspended?) and the owner's sign-in facts (paused?).

The cache is deliberately not tied to the owner's sessions: registering each
entry as one kept the owner's session index alive for as long as a key was
busy, so it grew with every browser session they ever had and slowed every
later revocation of them.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ApiKeyORM
from backend.app.db.repositories import api_key_repo, notification_repo, outbox_event_repo
from backend.app.services import permission_service, service_account_standing
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.revocation_service import get_revocation_service

CLAIMS_TTL_SECONDS = 30
#: Bounds memory by keys in use. Expired entries go first; cleared wholesale
#: only if every entry is live: the cost is one re-resolution per key.
_CACHE_MAX = 10_000


@dataclass(frozen=True)
class _Entry:
    expires_at: float
    claims: PermissionClaims


_claims_cache: dict[str, _Entry] = {}
#: One resolution per key at a time in this process: when an entry expires
#: (or after a deploy) the requests arriving together wait for one answer
#: rather than each reading the owner's bindings.
_resolving: dict[str, asyncio.Future] = {}


def reset_for_tests() -> None:
    _claims_cache.clear()
    _resolving.clear()


def scope_of(key: ApiKeyORM) -> permission_service.KeyScope:
    return permission_service.key_scope_from_profile(
        key.id,
        kind=key.kind,
        permissions=api_key_repo.loads(key.permissions, {}),
        resources=api_key_repo.loads(key.resources, None),
    )


async def claims_for_key(session: AsyncSession, key: ApiKeyORM) -> PermissionClaims:
    """The claims for a request made with ``key`` — see the module docstring."""
    while True:
        entry = _claims_cache.get(key.id)
        if entry is not None and entry.expires_at > time.monotonic():
            return entry.claims
        pending = _resolving.get(key.id)
        if pending is None:
            break
        try:
            return await asyncio.shield(pending)
        except asyncio.CancelledError:
            if not pending.cancelled():
                raise
            # The request resolving them went away: resolve them here.

    pending = asyncio.get_running_loop().create_future()
    _resolving[key.id] = pending
    try:
        claims = await permission_service.resolve_for_api_key(
            session, key.user_id, scope_of(key),
        )
    except asyncio.CancelledError:
        pending.cancel()
        raise
    except Exception as exc:
        pending.set_exception(exc)
        pending.exception()  # retrieved: no "never retrieved" warning when nobody waits
        raise
    finally:
        _resolving.pop(key.id, None)
    _remember(key.id, claims)
    pending.set_result(claims)
    return claims


def _remember(key_id: str, claims: PermissionClaims) -> None:
    now = time.monotonic()
    if len(_claims_cache) >= _CACHE_MAX:
        for stale in [k for k, e in _claims_cache.items() if e.expires_at <= now]:
            del _claims_cache[stale]
        if len(_claims_cache) >= _CACHE_MAX:
            _claims_cache.clear()
    _claims_cache[key_id] = _Entry(now + CLAIMS_TTL_SECONDS, claims)


def forget(key_id: str) -> None:
    """Drop a key's cached claims in this process — on revocation, so the
    process that revoked it never serves it again even inside the window."""
    _claims_cache.pop(key_id, None)


# ── Refusals ────────────────────────────────────────────────────────

#: A refusal that suggests the key is in the wrong hands rather than merely
#: out of date: a revoked key still being presented, or a key used from an
#: address it does not allow.
MISUSE_REASONS = frozenset({"revoked", "ip_not_allowed"})

_SAMPLE_SECONDS = 3600

_MISUSE_COPY = {
    "revoked": (
        "A revoked API key was used",
        "{key} was revoked, but someone presented it from {ip}. Nothing was "
        "allowed. If that wasn't you, the key has leaked — check where it was "
        "stored.",
    ),
    "ip_not_allowed": (
        "An API key was used from an address it doesn't allow",
        "{key} was presented from {ip}, outside the networks it is limited "
        "to. The request was refused.",
    ),
}


async def _first_this_hour(key_id: str, reason: str) -> bool:
    """Sample refusals to one record per key, reason and hour, so a client
    retrying in a loop cannot flood the audit log. If the sampling store is
    unavailable, record: over-auditing beats losing the signal."""
    bucket = int(time.time()) // _SAMPLE_SECONDS
    try:
        backend = get_revocation_service()._backend  # type: ignore[attr-defined]
        return await backend.set_if_absent(
            f"apikey:refused:{key_id}:{reason}:{bucket}", _SAMPLE_SECONDS,
        )
    except Exception:  # noqa: BLE001
        return True


async def record_rejection(
    session: AsyncSession,
    *,
    key: ApiKeyORM,
    reason: str,
    client_ip: Optional[str],
    user_agent: Optional[str],
) -> None:
    """The rejection hook: one audit event per key, reason and hour, and for
    misuse an inbox note to the owner — for a service account's key, to those
    who answer for it (``key_audience``). Written in the caller's
    transaction."""
    if not await _first_this_hour(key.id, reason):
        return
    misuse = reason in MISUSE_REASONS
    await outbox_event_repo.emit(
        session,
        event_type="identity.api_key.misuse" if misuse else "identity.api_key.rejected",
        aggregate_type="user",
        aggregate_id=key.user_id,
        payload={
            "user_id": key.user_id,
            "key_id": key.id,
            "key_name": key.name,
            "token_prefix": key.token_prefix,
            "reason": reason,
            "client_ip": client_ip,
            "user_agent": (user_agent or "")[:200] or None,
            "at": datetime.now(timezone.utc).isoformat(),
        },
    )
    if misuse:
        title, body = _MISUSE_COPY[reason]
        audience = await service_account_standing.key_audience(session, key.user_id)
        await notification_repo.notify(
            session,
            user_ids=audience.user_ids,
            kind="api_key_misuse",
            title=title,
            body=body.format(key=audience.key(key), ip=client_ip or "an unknown address"),
            link=audience.link,
            resource_type="api_key",
            resource_id=key.id,
            dedupe_unread=True,
        )


__all__ = [
    "CLAIMS_TTL_SECONDS",
    "MISUSE_REASONS",
    "claims_for_key",
    "forget",
    "record_rejection",
    "reset_for_tests",
    "scope_of",
]
