"""
Refresh-token rotation, reuse-detection, and the rotation grace window.

Each refresh token carries a ``jti`` (unique id) and ``fam`` (family id)
in its claims. Rotation consumes the presented ``jti`` by writing it to
the ``revoked_refresh_jti`` table, recording alongside it the identity of
the successor token that rotation issued.

Presenting a consumed ``jti`` again means one of two very different
things, and the old implementation could not tell them apart:

  * A stolen chain being replayed — the whole family must die.
  * Two tabs refreshing on the same cookie milliseconds apart, a retried
    POST, a tab restored from bfcache, or a rotation whose ``Set-Cookie``
    never reached the browser. None of these is an attack, and treating
    them as one signed users out of every tab at once.

The grace window separates them by time. Inside it, the re-presentation
is answered with the successor the winner already minted, so both racers
converge on one token. Outside it, the family is revoked as before.

The store interface is intentionally narrow so an extracted auth service
can swap SQLAlchemy for Redis without touching the rotation logic.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Protocol


@dataclass(frozen=True)
class RotationRecord:
    """What a consumed ``jti`` rotated into.

    Claims, not a token: re-minting from these yields a JWT carrying the
    same ``jti``/``fam``/``exp``, which is all that matters — two tokens
    with the same ``jti`` are consumed by the same next rotation. Storing
    the signed token instead would put a live credential at rest.
    """

    revoked_at_iso: str
    successor_jti: str
    successor_exp: int
    successor_mint_ms: int


@dataclass(frozen=True)
class RotationOutcome:
    """Verdict on a presented refresh token.

    ``status`` is one of:
      * ``"claimed"`` — the token was consumed; mint and return the successor.
      * ``"replay"`` — a concurrent/retried refresh inside the grace
        window. ``successor`` carries the token to re-mint.
      * ``"reuse"`` — a consumed token presented outside the grace
        window. The caller must revoke the family.
      * ``"family_revoked"`` — the family was already killed.
    """

    status: str
    successor: Optional[RotationRecord] = None


class RefreshStore(Protocol):
    """Persistence for refresh-token rotation state.

    Concrete implementations live outside this module (the SQLAlchemy
    one is in ``backend/app/db/repositories/refresh_token_repo.py``); the
    protocol keeps the rotation logic free of any ORM dependency.
    """

    async def claim_jti(
        self,
        jti: str,
        family_id: str,
        expires_at_iso: str,
        *,
        successor_jti: str,
        successor_exp: int,
        successor_mint_ms: int,
    ) -> bool: ...
    async def get_rotation(self, jti: str) -> Optional[RotationRecord]: ...
    async def revoke_family(self, family_id: str) -> bool: ...
    async def is_family_revoked(self, family_id: str) -> bool: ...


def _iso(epoch_seconds: int) -> str:
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).isoformat()


def _age_seconds(revoked_at_iso: str) -> Optional[float]:
    """Seconds since a rotation was recorded, or None if unparseable.

    An unparseable timestamp must not open the window — returning None
    sends the caller down the reuse path, which fails closed.
    """
    try:
        recorded = datetime.fromisoformat(revoked_at_iso)
    except (TypeError, ValueError):
        return None
    if recorded.tzinfo is None:
        recorded = recorded.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - recorded).total_seconds()


async def check_and_record_rotation(
    store: RefreshStore,
    *,
    presented_jti: str,
    presented_family: str,
    presented_exp: int,
    successor_jti: str,
    successor_exp: int,
    successor_mint_ms: int,
    grace_seconds: int,
) -> RotationOutcome:
    """Consume a refresh token, or explain why it cannot be consumed.

    The caller mints a candidate successor before calling and passes its
    claims in; they are recorded atomically with the consumption, so a
    concurrent refresh that loses the race can read them back.

    Revoking on ``"reuse"`` is deliberately NOT done here. It has to
    happen in its own committed transaction, and every caller raises
    straight afterwards — see ``LocalIdentityService._revoke_family_committed``.
    """
    if await store.is_family_revoked(presented_family):
        return RotationOutcome("family_revoked")

    claimed = await store.claim_jti(
        presented_jti,
        presented_family,
        _iso(presented_exp),
        successor_jti=successor_jti,
        successor_exp=successor_exp,
        successor_mint_ms=successor_mint_ms,
    )
    if claimed:
        return RotationOutcome("claimed")

    # Someone else already consumed this jti. On Postgres we blocked on
    # the primary key until their transaction committed, so if they
    # recorded a successor it is visible now.
    if grace_seconds > 0:
        record = await store.get_rotation(presented_jti)
        if record is not None:
            age = _age_seconds(record.revoked_at_iso)
            if age is not None and 0 <= age <= grace_seconds:
                return RotationOutcome("replay", successor=record)

    return RotationOutcome("reuse")
