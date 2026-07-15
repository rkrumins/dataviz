"""What turning this flag off would do to THIS estate — counted, not described.

The confirmation dialog already tells an admin what a feature does when it's off. That sentence is
true, and it comes from a config file: it says the same thing on a deployment with four views and
one with four thousand. It is a description of the FEATURE. What decides the question is a fact
about YOUR ESTATE — "142 views have unpublished drafts right now" — and the product knew it all
along and never said it.

THE RULE THAT MATTERS HERE: A PROBE MAY NOT GUESS.

Where a truthful, cheap count exists, it is returned. Where it does not, this returns NOTHING and
the dialog shows only the prose — because a number on a confirmation screen is read as a fact
about the world, and an invented one ("~some views affected") is worse than silence. `traceEnabled`
has no usage telemetry behind it, so there is no honest count of who would lose trace, so there is
no fact, so we say nothing. Restraint is the feature.

Every probe is a COUNT on the public schema with an index behind it. This runs while a human waits
with a dialog open, so nothing here is allowed to be slow, and nothing here reaches into graphver.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    AnnouncementORM,
    OntologyORM,
    UserORM,
    ViewORM,
)

logger = logging.getLogger(__name__)


@dataclass
class ImpactFact:
    """One counted consequence. `count` is the number; `consequence` says what happens to them."""

    count: int
    #: Plural noun for what is being counted — "views", "semantic layers", "people".
    label: str
    #: What becomes of them. "Become read-only", "Keep working, but nobody can build a new one".
    consequence: str
    #: `warning` = they lose something. `neutral` = they are affected but nothing is lost.
    tone: str = "warning"
    #: Optional breakdown, e.g. per view type.
    detail: list[str] = field(default_factory=list)

    def to_api(self) -> dict[str, Any]:
        return {
            "count": self.count,
            "label": self.label,
            "consequence": self.consequence,
            "tone": self.tone,
            "detail": self.detail,
        }


async def _live_views(session: AsyncSession) -> int:
    r = await session.execute(
        select(func.count()).select_from(ViewORM).where(ViewORM.deleted_at.is_(None))
    )
    return int(r.scalar() or 0)


# ── the probes ────────────────────────────────────────────────────────────────

async def _editing_probe(session: AsyncSession) -> list[ImpactFact]:
    views = await _live_views(session)
    if not views:
        return []
    return [
        ImpactFact(
            count=views,
            label="views" if views != 1 else "view",
            consequence="Become read-only. Nothing already saved is affected, and everyone can still read, filter and export.",
            tone="neutral",
        )
    ]


async def _view_modes_probe(session: AsyncSession) -> list[ImpactFact]:
    """The one that most changes a decision.

    An admin withdrawing a layout wants to know how much of the estate is already built in it. The
    answer is a GROUP BY away and has never been shown, so the choice was made blind.
    """
    r = await session.execute(
        select(ViewORM.view_type, func.count())
        .where(ViewORM.deleted_at.is_(None))
        .group_by(ViewORM.view_type)
        .order_by(func.count().desc())
    )
    rows = [(str(t), int(c)) for t, c in r.all() if c]
    if not rows:
        return []

    total = sum(c for _, c in rows)
    return [
        ImpactFact(
            count=total,
            label="views" if total != 1 else "view",
            consequence=(
                "Already built, across all layouts. Withdrawing a layout never touches them — they "
                "keep working and stay editable. It only stops NEW views being built in it."
            ),
            tone="neutral",
            detail=[f"{count} × {view_type}" for view_type, count in rows],
        )
    ]


async def _semantic_layers_probe(session: AsyncSession) -> list[ImpactFact]:
    r = await session.execute(
        select(OntologyORM.is_published, func.count())
        .where(OntologyORM.deleted_at.is_(None))
        .group_by(OntologyORM.is_published)
    )
    counts = {bool(published): int(c) for published, c in r.all()}
    drafts = counts.get(False, 0)
    published = counts.get(True, 0)
    if not drafts and not published:
        return []

    facts: list[ImpactFact] = []
    if drafts:
        facts.append(
            ImpactFact(
                count=drafts,
                label="draft layers" if drafts != 1 else "draft layer",
                consequence="Can no longer be edited. They are kept, not deleted.",
            )
        )
    if published:
        facts.append(
            ImpactFact(
                count=published,
                label="published layers" if published != 1 else "published layer",
                consequence="Keep resolving every view exactly as they do now.",
                tone="neutral",
            )
        )
    return facts


async def _layer_history_probe(session: AsyncSession) -> list[ImpactFact]:
    r = await session.execute(
        select(func.count()).select_from(OntologyORM).where(OntologyORM.deleted_at.is_(None))
    )
    layers = int(r.scalar() or 0)
    if not layers:
        return []
    return [
        ImpactFact(
            count=layers,
            label="semantic layers" if layers != 1 else "semantic layer",
            consequence="Their history is hidden, not deleted. Every version is retained and returns the moment this is switched back on.",
            tone="neutral",
        )
    ]


async def _signup_probe(session: AsyncSession) -> list[ImpactFact]:
    since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    r = await session.execute(
        select(func.count()).select_from(UserORM).where(UserORM.created_at >= since)
    )
    recent = int(r.scalar() or 0)
    if not recent:
        return []
    return [
        ImpactFact(
            count=recent,
            label="accounts created in the last 30 days" if recent != 1 else "account created in the last 30 days",
            consequence="A rough measure of how much this door is used. Invited users can still register either way.",
            tone="neutral",
        )
    ]


async def _announcements_probe(session: AsyncSession) -> list[ImpactFact]:
    r = await session.execute(
        select(func.count()).select_from(AnnouncementORM).where(AnnouncementORM.is_active.is_(True))
    )
    active = int(r.scalar() or 0)
    if not active:
        return []
    return [
        ImpactFact(
            count=active,
            label="active announcements" if active != 1 else "active announcement",
            consequence="Stop appearing for everyone. They are hidden, not deactivated — they return when this is switched back on.",
        )
    ]


#: Flags with an honest, cheap count behind them. Anything absent from this map has NO probe, and
#: the dialog shows the prose alone — which is the correct answer when we genuinely don't know.
#: `traceEnabled` and `semanticLayerAutoSuggest` are absent on purpose: neither has usage telemetry,
#: so there is no truthful number for "how many people would lose this", and a fabricated one would
#: be read as a fact.
PROBES: dict[str, Callable[[AsyncSession], Awaitable[list[ImpactFact]]]] = {
    "editModeEnabled": _editing_probe,
    "versioningEnabled": _editing_probe,
    "allowedViewModes": _view_modes_probe,
    "semanticLayerEditMode": _semantic_layers_probe,
    "semanticLayerImportEnabled": _semantic_layers_probe,
    "semanticLayerNonAdminEditing": _semantic_layers_probe,
    "semanticLayerVersionHistory": _layer_history_probe,
    "signupEnabled": _signup_probe,
    "announcementsEnabled": _announcements_probe,
}


async def probe(session: AsyncSession, feature_key: str) -> dict[str, Any]:
    """Count what turning `feature_key` off would touch.

    `known` distinguishes the three states an admin must be able to tell apart, and the middle one
    is the one products always get wrong:

        known=True,  facts=[...]   here is what it touches
        known=True,  facts=[]      it touches nothing — your estate is empty of these
        known=False                WE DON'T KNOW. Not "nothing". The probe failed, or there is no
                                   honest count for this flag.

    Collapsing the last two into "nothing to worry about" is how a confirmation dialog ends up
    reassuring someone about a blast radius it never measured.
    """
    prober = PROBES.get(feature_key)
    if prober is None:
        return {"known": False, "facts": []}

    try:
        facts = await prober(session)
    except Exception as exc:  # a broken probe must never block the admin from acting
        logger.warning("feature impact probe failed for %s: %s", feature_key, exc)
        return {"known": False, "facts": []}

    return {"known": True, "facts": [f.to_api() for f in facts]}
