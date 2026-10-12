"""
Refresh-token rotation, reuse-detection, and the rotation grace window.

Each refresh token carries a ``jti`` (unique id) and ``fam`` (family id)
in its claims, and — since the move to allow-by-record — a row of its own
written at mint. **A refresh token is refused unless an active row says
otherwise.** That is the inversion: the previous model was a denylist, in
which a token was valid unless a row said otherwise, so correctness rested
on the denylist being complete and durable forever while ``purge_expired``
deleted from it. Now a lost row signs someone out rather than reviving a
credential, which is the failure direction to want.

Rotation consumes the presented token by stamping ``consumed_at`` on its
row, conditional on that column still being NULL, and points
``successor_jti`` at the row rotation issued.

Presenting a consumed ``jti`` again means one of two very different
things, and the original implementation could not tell them apart:

  * A stolen chain being replayed — the whole family must die.
  * Two tabs refreshing on the same cookie milliseconds apart, a retried
    POST, a tab restored from bfcache, or a rotation whose ``Set-Cookie``
    never reached the browser. None of these is an attack, and treating
    them as one signed users out of every tab at once.

The grace window separates them by time. Inside it, the re-presentation is
answered with the successor the winner already minted, so both racers
converge on one token. Outside it, the family is revoked as before.

The store interface is intentionally narrow so an extracted auth service
can swap SQLAlchemy for Redis without touching the rotation logic.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Protocol

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RefreshRecord:
    """The server's own account of one refresh token.

    Authoritative over the token's claims wherever the two overlap. The
    token asserts things about itself and can be minted with any of them
    missing; this row cannot.
    """

    jti: str
    family_id: str
    user_id: str
    auth_time: Optional[int]
    mint_ms: int
    expires_at_iso: str
    created_at_iso: str
    consumed_at_iso: Optional[str] = None
    successor_jti: Optional[str] = None
    revoked_at_iso: Optional[str] = None

    #: Which IdP row minted this session; None for local logins. Here
    #: for the same reason ``auth_time`` is: the refresh path needs it
    #: before it trusts anything in the token, and a claim the token can
    #: omit is not a fact about the session. Read by the back-channel
    #: liveness check — including to know when NOT to probe, so a local
    #: or OIDC session is never asked about.
    idp_provider_id: Optional[str] = None

    #: Epoch seconds of the last SUCCESSFUL upstream liveness
    #: confirmation. The anchor an outage grace window is measured from,
    #: so it advances only on a real answer.
    idp_checked_at: Optional[int] = None

    @property
    def is_active(self) -> bool:
        return self.consumed_at_iso is None and self.revoked_at_iso is None


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
      * ``"unknown"`` — no row for this token. Under allow-by-record that
        is a refusal, not an invitation to proceed.

    ``record`` is the presented token's row when there was one. The caller
    reads ``auth_time`` from it rather than from the token's claims.
    """

    status: str
    successor: Optional[RotationRecord] = None
    record: Optional[RefreshRecord] = None


class RefreshStore(Protocol):
    """Persistence for refresh-token rotation state.

    Concrete implementations live outside this module (the SQLAlchemy
    one is in ``backend/app/db/repositories/refresh_token_repo.py``); the
    protocol keeps the rotation logic free of any ORM dependency.
    """

    async def record_mint(
        self,
        *,
        jti: str,
        family_id: str,
        user_id: str,
        auth_time: Optional[int],
        mint_ms: int,
        expires_at_iso: str,
        revoked_at_iso: Optional[str] = None,
        idp_provider_id: Optional[str] = None,
        idp_checked_at: Optional[int] = None,
    ) -> bool: ...
    async def get_record(self, jti: str) -> Optional[RefreshRecord]: ...
    async def consume(self, jti: str, *, successor_jti: str) -> bool: ...
    async def revoke_family(self, family_id: str) -> bool: ...
    async def is_family_revoked(self, family_id: str) -> bool: ...
    async def touch_idp_check(self, jti: str, *, checked_at: int) -> bool: ...
    async def family_started_ms(self, family_id: str) -> Optional[int]: ...


def _iso(epoch_seconds: int) -> str:
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).isoformat()


def _age_seconds(consumed_at_iso: str) -> Optional[float]:
    """Seconds since a rotation was recorded, or None if unparseable.

    An unparseable timestamp must not open the window — returning None
    sends the caller down the reuse path, which fails closed.
    """
    try:
        recorded = datetime.fromisoformat(consumed_at_iso)
    except (TypeError, ValueError):
        return None
    if recorded.tzinfo is None:
        recorded = recorded.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - recorded).total_seconds()


async def _successor_of(
    store: RefreshStore, record: RefreshRecord,
) -> Optional[RotationRecord]:
    """Follow ``successor_jti`` to the row rotation actually issued.

    A pointer rather than a copy: the successor's expiry and mint instant
    live on its own row, so the two cannot drift apart, and a successor
    that was never written is visibly absent instead of being implied by
    three columns that happen to be filled in.
    """
    if record.consumed_at_iso is None or record.successor_jti is None:
        return None
    successor = await store.get_record(record.successor_jti)
    if successor is None:
        return None
    return RotationRecord(
        revoked_at_iso=record.consumed_at_iso,
        successor_jti=successor.jti,
        successor_exp=int(
            datetime.fromisoformat(successor.expires_at_iso).timestamp(),
        ),
        successor_mint_ms=successor.mint_ms,
    )


async def check_and_record_rotation(
    store: RefreshStore,
    *,
    presented_jti: str,
    presented_family: str,
    presented_exp: int,
    presented_user_id: str,
    presented_auth_time: Optional[int],
    presented_mint_ms: int,
    successor_jti: str,
    successor_exp: int,
    successor_mint_ms: int,
    grace_seconds: int,
    adopt_recordless: bool = False,
) -> RotationOutcome:
    """Consume a refresh token, or explain why it cannot be consumed.

    The caller mints a candidate successor before calling and passes its
    claims in; the successor's row is written in the same transaction that
    consumes the presented token, so a concurrent refresh that loses the
    race can read it back.

    ``adopt_recordless`` covers the tokens that were already live when
    allow-by-record deployed: they have no row, because nothing wrote one
    for them, and refusing them would sign out every session in the estate
    at its next rotation. Adoption writes the row they should have had and
    proceeds. It is not a weakening — those tokens are accepted today with
    no row anywhere — but it *is* the old denylist behaviour, so it is
    time-boxed: after one refresh lifetime no record-less token can exist
    and the flag comes off. Every adoption logs, so the drain to zero is
    observable rather than assumed.

    Revoking on ``"reuse"`` is deliberately NOT done here. It has to
    happen in its own committed transaction, and every caller raises
    straight afterwards — see ``LocalIdentityService._revoke_family_committed``.
    """
    record = await store.get_record(presented_jti)

    if record is None:
        # A token with no row has no ``revoked_at`` of its own to consult,
        # so the family's other rows are the only place its revocation
        # could be recorded. Asked before adoption, not after: otherwise a
        # pre-deploy cookie stolen from a session that has since been
        # logged out would be handed a brand-new licence.
        if await store.is_family_revoked(presented_family):
            return RotationOutcome("family_revoked")
        if not adopt_recordless:
            return RotationOutcome("unknown")
        logger.info(
            "Adopting a refresh token minted before allow-by-record "
            "(user=%s family=%s) — set REFRESH_ADOPT_RECORDLESS=false once "
            "these stop appearing", presented_user_id, presented_family,
        )
        await store.record_mint(
            jti=presented_jti,
            family_id=presented_family,
            user_id=presented_user_id,
            auth_time=presented_auth_time,
            mint_ms=presented_mint_ms,
            expires_at_iso=_iso(presented_exp),
        )
        record = await store.get_record(presented_jti)
        if record is None:  # pragma: no cover - storage refused the write
            return RotationOutcome("unknown")

    if record.revoked_at_iso is not None:
        return RotationOutcome("family_revoked", record=record)

    # Consume first, write the successor's row second, both in the
    # caller's transaction. The order matters: ``consume`` is a
    # conditional UPDATE on the presented row, so a concurrent refresh
    # blocks on it until this transaction commits and then matches zero
    # rows — at which point the successor it needs to read back is
    # already there. Writing the successor first instead would leave an
    # active row for a token that lost the race and was discarded, on
    # every contended refresh.
    if await store.consume(presented_jti, successor_jti=successor_jti):
        await store.record_mint(
            jti=successor_jti,
            family_id=presented_family,
            user_id=record.user_id,
            # Carried forward, not re-derived: the ceiling measures from
            # the real authentication instant, not from this rotation.
            auth_time=record.auth_time,
            mint_ms=successor_mint_ms,
            expires_at_iso=_iso(successor_exp),
            # Same reasoning, and the same direction of failure if it
            # were dropped: a successor with no provider is a session
            # the liveness check would stop probing, so a rotation
            # would be a way to shed the check rather than pass it.
            idp_provider_id=record.idp_provider_id,
            idp_checked_at=record.idp_checked_at,
        )
        return RotationOutcome("claimed", record=record)

    # Someone else consumed it first. Re-read: their successor pointer is
    # visible now, and it is theirs, not the one we just wrote.
    contended = await store.get_record(presented_jti) or record
    if contended.revoked_at_iso is not None:
        return RotationOutcome("family_revoked", record=contended)
    if grace_seconds > 0 and contended.consumed_at_iso is not None:
        age = _age_seconds(contended.consumed_at_iso)
        if age is not None and 0 <= age <= grace_seconds:
            rotation = await _successor_of(store, contended)
            if rotation is not None:
                return RotationOutcome(
                    "replay", successor=rotation, record=contended,
                )

    return RotationOutcome("reuse", record=contended)
