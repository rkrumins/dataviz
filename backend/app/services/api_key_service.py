"""What an API key may do on a request, and the record of keys refused.

Injected into ``LocalIdentityService`` (which may not import ``backend.app``)
as the claims resolver and the rejection hook of ``validate_api_key``.

**Claims are cached per key, for at most 30 seconds.** Resolving them reads
the owner's bindings, groups and memberships, and an integration calling
hundreds of times a minute must not repeat that on every call. Thirty
seconds is the ceiling, not the usual delay: each cached entry is registered
as a session of the owner, so anything that already ends a person's sessions
on a change to what they may do — a role or group change, a removed
membership, a suspension — also drops the cached claims of their keys, and
the next request resolves them afresh. The key itself (revoked? expired?)
is never cached; that is read on every request.
"""
from __future__ import annotations

import logging
import secrets
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import ApiKeyORM
from backend.app.db.repositories import api_key_repo, notification_repo, outbox_event_repo
from backend.app.services import permission_service
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.revocation_service import get_revocation_service

logger = logging.getLogger(__name__)

CLAIMS_TTL_SECONDS = 30
#: Bounds memory by keys in use. Cleared wholesale when full: the cost is one
#: re-resolution per key, not a correctness problem.
_CACHE_MAX = 10_000


@dataclass(frozen=True)
class _Entry:
    expires_at: float
    claims: PermissionClaims
    sid: str


_claims_cache: dict[str, _Entry] = {}
#: One registered session per key per process, renewed only once it has been
#: ended. A fresh one per refresh would add a member to the owner's session
#: index every thirty seconds for as long as the key is busy.
_registered_sids: dict[str, str] = {}


def reset_for_tests() -> None:
    _claims_cache.clear()
    _registered_sids.clear()


async def _ended(sid: str) -> bool:
    """Whether the owner's sessions were ended since this entry registered.
    An unreachable store is not a verdict: the TTL is the floor."""
    try:
        return await get_revocation_service().is_revoked(sid)
    except Exception as exc:  # noqa: BLE001 — fail-open by design
        logger.warning("Revocation store unavailable for %s: %s", sid, exc)
        return False


def scope_of(key: ApiKeyORM) -> permission_service.KeyScope:
    return permission_service.key_scope_from_profile(
        key.id,
        kind=key.kind,
        permissions=api_key_repo.loads(key.permissions, {}),
        resources=api_key_repo.loads(key.resources, None),
    )


async def claims_for_key(session: AsyncSession, key: ApiKeyORM) -> PermissionClaims:
    """The claims for a request made with ``key`` — see the module docstring."""
    now = time.monotonic()
    entry = _claims_cache.get(key.id)
    if entry is not None and entry.expires_at > now:
        if not await _ended(entry.sid):
            return entry.claims
        _registered_sids.pop(key.id, None)

    sid = _registered_sids.get(key.id) or f"apk_{key.id}_{secrets.token_hex(6)}"
    # Registered before resolving, so a change that ends the owner's
    # sessions while the claims are being read still reaches this entry.
    try:
        await get_revocation_service().record_session(key.user_id, sid)
    except Exception as exc:  # noqa: BLE001 — the TTL still bounds staleness
        logger.warning("Could not register API key %s for invalidation: %s", key.id, exc)
    claims = await permission_service.resolve_for_api_key(
        session, key.user_id, scope_of(key),
    )
    if len(_claims_cache) >= _CACHE_MAX:
        _claims_cache.clear()
    _registered_sids[key.id] = sid
    _claims_cache[key.id] = _Entry(time.monotonic() + CLAIMS_TTL_SECONDS, claims, sid)
    return claims


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
        "Your key “{name}” ({prefix}…) was revoked, but someone presented it "
        "from {ip}. Nothing was allowed. If that wasn't you, the key has "
        "leaked — check where it was stored.",
    ),
    "ip_not_allowed": (
        "An API key was used from an address it doesn't allow",
        "Your key “{name}” ({prefix}…) was presented from {ip}, outside the "
        "networks it is limited to. The request was refused.",
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
    misuse an inbox note to the owner. Written in the caller's transaction."""
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
        await notification_repo.notify(
            session,
            user_ids=[key.user_id],
            kind="api_key_misuse",
            title=title,
            body=body.format(
                name=key.name, prefix=key.token_prefix, ip=client_ip or "an unknown address",
            ),
            link="/me/api-keys",
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
