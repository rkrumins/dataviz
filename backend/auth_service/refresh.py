"""
Refresh-token rotation and reuse-detection.

Each refresh token carries a ``jti`` (unique id) and ``fam`` (family id)
in its claims. On rotation the previous ``jti`` is recorded in the
``revoked_refresh_jti`` table. If a recorded ``jti`` is ever presented
again, that's a reuse attack — the entire family is revoked.

The store interface is intentionally narrow so an extracted auth service
can swap SQLAlchemy for Redis without touching the rotation logic.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional, Protocol


class RefreshStore(Protocol):
    """Persistence for refresh-token rotation state.

    Concrete implementations live outside this module (the SQLAlchemy
    one is in ``service.py``); the protocol keeps the rotation logic
    free of any ORM dependency.
    """

    async def is_jti_revoked(self, jti: str) -> bool: ...
    async def revoke_jti(self, jti: str, family_id: str, expires_at_iso: str) -> None: ...
    async def revoke_family(self, family_id: str) -> None: ...
    async def is_family_revoked(self, family_id: str) -> bool: ...


def _iso(epoch_seconds: int) -> str:
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).isoformat()


async def check_and_record_rotation(
    store: RefreshStore,
    *,
    presented_jti: str,
    presented_family: str,
    presented_exp: int,
) -> Optional[str]:
    """Validate that a refresh token may be used, then mark it as consumed.

    Returns ``None`` on success (the caller may then mint a new token in the
    same family). Returns a string error code on failure:

      * ``"family_revoked"`` — the family was killed by a previous reuse.
      * ``"reuse_detected"`` — this jti was already consumed; the entire
        family is now revoked as a side effect.
    """
    if await store.is_family_revoked(presented_family):
        return "family_revoked"

    if await store.is_jti_revoked(presented_jti):
        await store.revoke_family(presented_family)
        return "reuse_detected"

    await store.revoke_jti(
        jti=presented_jti,
        family_id=presented_family,
        expires_at_iso=_iso(presented_exp),
    )
    return None
