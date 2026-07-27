"""Repository: invites + invite_redemptions — the invite ledger.

An invite token is a signed JWT, so its authenticity is self-proving.
What a signature cannot express is everything that changes AFTER the
link is minted: the admin revoked it, the seats ran out, the link
leaked. That state lives here, keyed by the token's ``jti``, and the
row — not the payload — decides what an invite grants and whether it
may still be used.

Tokens minted before this table existed carry no ``jti``. They are
handled by the caller, not here: there is no row to look up, so they
keep the old self-contained behaviour until they age out (invite
lifetimes are capped at 90 days, so the legacy path retires itself).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional, Sequence

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import InviteORM, InviteRedemptionORM


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def is_expired(expires_at: str, *, now: Optional[datetime] = None) -> bool:
    """True if an invite has aged out.

    Deliberately fails CLOSED on an unparseable timestamp, which is the
    opposite of ``binding_repo._is_expired``. There, ``expires_at`` is
    nullable and NULL legitimately means "never", so a value that won't
    parse is treated as non-expiring to avoid revoking a valid grant on
    a bad write. Here the column is NOT NULL and always set at mint
    time, so a value that won't parse is corruption — and reading
    corruption as "never expires" would make a link immortal, which is
    precisely the failure this table exists to prevent.
    """
    now = now or datetime.now(timezone.utc)
    raw = (expires_at or "").strip()
    if not raw:
        return True
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed <= now


def status_of(invite: InviteORM, *, now: Optional[datetime] = None) -> str:
    """Derive the lifecycle state. Not stored — see the model docstring.

    Order matters: an admin who revoked a link wants to see "revoked"
    even if it has since also expired, because that is the fact they
    acted on.
    """
    if invite.revoked_at:
        return "revoked"
    if is_expired(invite.expires_at, now=now):
        return "expired"
    if invite.max_uses is not None and invite.use_count >= invite.max_uses:
        return "exhausted"
    return "active"


def group_ids_of(invite: InviteORM) -> list[str]:
    """Decode the JSON group list, tolerating a malformed value.

    A corrupt list must not 500 a signup: the user still gets their
    account and their role, just without the group attachments — which
    an admin can fix, unlike a failed signup they never hear about.
    """
    try:
        parsed = json.loads(invite.group_ids or "[]")
    except (TypeError, ValueError):
        return []
    if not isinstance(parsed, list):
        return []
    return [g for g in parsed if isinstance(g, str)]


# ── writes ────────────────────────────────────────────────────────────

async def create(
    session: AsyncSession,
    *,
    invite_id: str,
    role: Optional[str],
    workspace_id: Optional[str],
    email: Optional[str],
    email_domain: Optional[str],
    group_ids: Sequence[str],
    shareable_groups_override: bool,
    max_uses: Optional[int],
    expires_at: str,
    created_by: str,
) -> InviteORM:
    invite = InviteORM(
        id=invite_id,
        role=role,
        workspace_id=workspace_id,
        email=email,
        email_domain=email_domain,
        group_ids=json.dumps(list(group_ids)),
        shareable_groups_override=shareable_groups_override,
        max_uses=max_uses,
        use_count=0,
        expires_at=expires_at,
        created_by=created_by,
    )
    session.add(invite)
    await session.flush()
    return invite


async def get(session: AsyncSession, invite_id: str) -> Optional[InviteORM]:
    result = await session.execute(
        select(InviteORM).where(InviteORM.id == invite_id)
    )
    return result.scalar_one_or_none()


async def try_consume(session: AsyncSession, invite_id: str) -> bool:
    """Claim one seat. Returns False if the invite is revoked or full.

    A single conditional UPDATE, not a read-then-write. Two people
    clicking a ``max_uses=1`` link at the same moment would both read
    ``use_count = 0`` and both be admitted — the seat cap would be
    advisory, which is no cap at all. Letting the database evaluate the
    predicate and the increment together makes over-redemption
    impossible rather than unlikely.

    Expiry is checked by the caller: it is a string comparison against
    the clock, not a row predicate, and keeping it out here lets the
    caller distinguish "expired" from "exhausted" for the error message.
    """
    result = await session.execute(
        update(InviteORM)
        .where(
            InviteORM.id == invite_id,
            InviteORM.revoked_at.is_(None),
            or_(
                InviteORM.max_uses.is_(None),
                InviteORM.use_count < InviteORM.max_uses,
            ),
        )
        .values(use_count=InviteORM.use_count + 1)
    )
    return (result.rowcount or 0) > 0


async def revoke(
    session: AsyncSession, invite_id: str, *, revoked_by: str,
) -> Optional[InviteORM]:
    """Kill a link. Idempotent — re-revoking keeps the original stamp,
    because the first revocation is the one that happened."""
    invite = await get(session, invite_id)
    if invite is None:
        return None
    if invite.revoked_at is None:
        invite.revoked_at = _now()
        invite.revoked_by = revoked_by
        await session.flush()
    return invite


async def extend(
    session: AsyncSession,
    invite_id: str,
    *,
    expires_at: str,
    additional_uses: Optional[int] = None,
) -> Optional[InviteORM]:
    """Push out a link's expiry, and optionally raise its seat cap.

    On the SAME row, deliberately. Minting a replacement was the only
    option before, which split one invitation across two rows and left
    the redemption history attached to the dead one — so "who came in
    through this?" got harder to answer every time a link was renewed.

    Refuses a revoked link: revocation is a decision, and quietly
    resurrecting it by extending would undo that decision without
    anyone choosing to.
    """
    invite = await get(session, invite_id)
    if invite is None or invite.revoked_at is not None:
        return None

    invite.expires_at = expires_at
    if additional_uses is not None and invite.max_uses is not None:
        # Raise the ceiling relative to what has ALREADY been used, so
        # "add 5 seats" means five more people can join — not five more
        # than the original cap, which for a spent link would be none.
        invite.max_uses = invite.use_count + additional_uses
    await session.flush()
    return invite


async def regenerate(
    session: AsyncSession, invite_id: str, *, expires_at: str,
) -> Optional[InviteORM]:
    """Issue a fresh URL for the same invitation.

    Bumps ``token_version``, which strands every URL already handed out,
    and resets the clock. The row — its role, scope, groups, seat cap and
    redemption history — is untouched, which is the whole point: this is
    the same invitation with a new address, not a new invitation.

    Refuses a revoked link, for the same reason ``extend`` does.
    """
    invite = await get(session, invite_id)
    if invite is None or invite.revoked_at is not None:
        return None

    invite.token_version = int(invite.token_version or 1) + 1
    invite.expires_at = expires_at
    await session.flush()
    return invite


async def record_redemption(
    session: AsyncSession,
    *,
    invite_id: str,
    user_id: str,
    email: str,
) -> InviteRedemptionORM:
    redemption = InviteRedemptionORM(
        invite_id=invite_id, user_id=user_id, email=email,
    )
    session.add(redemption)
    await session.flush()
    return redemption


# ── reads ─────────────────────────────────────────────────────────────

async def list_for_admin(
    session: AsyncSession,
    *,
    created_by: Optional[str] = None,
    status: str = "active",
    limit: int = 200,
) -> list[InviteORM]:
    """Newest first. ``created_by`` scopes the list to one creator —
    used to stop a non-super-admin seeing links they did not mint.

    Status is filtered in Python rather than SQL because "expired" and
    "exhausted" are derived from a clock and a comparison between two
    columns; expressing them as portable SQL predicates across SQLite
    and Postgres buys nothing at this table's size.
    """
    stmt = select(InviteORM).order_by(InviteORM.created_at.desc())
    if created_by is not None:
        stmt = stmt.where(InviteORM.created_by == created_by)
    result = await session.execute(stmt)
    rows = list(result.scalars().all())

    if status != "all":
        now = datetime.now(timezone.utc)
        rows = [r for r in rows if status_of(r, now=now) == status]
    return rows[:limit]


async def list_redemptions(
    session: AsyncSession, invite_id: str, *, limit: int = 100,
) -> list[InviteRedemptionORM]:
    result = await session.execute(
        select(InviteRedemptionORM)
        .where(InviteRedemptionORM.invite_id == invite_id)
        .order_by(InviteRedemptionORM.redeemed_at.desc())
        .limit(limit)
    )
    return list(result.scalars().all())


async def redemption_counts(
    session: AsyncSession, invite_ids: Sequence[str],
) -> dict[str, int]:
    """Redemption count per invite, for the admin list. One query for
    the whole page rather than one per row."""
    if not invite_ids:
        return {}
    from sqlalchemy import func

    result = await session.execute(
        select(InviteRedemptionORM.invite_id, func.count())
        .where(InviteRedemptionORM.invite_id.in_(list(invite_ids)))
        .group_by(InviteRedemptionORM.invite_id)
    )
    return {row[0]: int(row[1]) for row in result.all()}
