"""The activity insight band: one way to build it, for a reader and the warmer.

The band is folded from whole days. Closed days — and the whole comparison
period — are folded once, kept in Redis until the next UTC midnight moves
every window on, and shared by every window over the same days; a request
reads only yesterday and today. That fold is the page's cold cost, and it is
the same for everyone who opens the explorer through one of its lenses, so
the analytics warmer pays it ahead of them (:func:`warm_platform`).

Only the database layer and the cache are imported, so the control plane —
which runs the warmer and holds no auth secrets — can import this.
"""
from __future__ import annotations

import contextlib
import hashlib
import json
import logging
from dataclasses import asdict, replace
from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.common.bulkhead import Busy
from backend.app.db.repositories import activity_repo, analytics_repo
from backend.app.db.repositories.activity_repo import ActivityFilter
from backend.app.services import activity_retention, analytics_cache
from backend.app.services.activity import catalogue, names

logger = logging.getLogger(__name__)

#: How long a built band is reused. Activity is read for what just happened,
#: so this is far shorter than the analytics documents' epoch.
SUMMARY_TTL_SECONDS = 60.0
#: How long a fold of closed days is kept: the span is day-aligned, so it is
#: asked for until the next UTC midnight moves every window on.
FOLD_TTL_SECONDS = 26 * 3600.0
#: The explorer's leading ranges, warmed for the platform view.
WARM_DAYS = (7, 30, 90)
#: The explorer's lenses, as the filter each one's requests carry (``LENSES``
#: in ``frontend/src/components/activity/activityMeta.ts``): the categories it
#: narrows to, and whether it shows the routine refusals "Everything" leaves
#: out. Each is a view everyone opens, so its cold cost is paid ahead of them.
LENSES: tuple[tuple[tuple[str, ...], bool], ...] = (
    ((), False),
    (("operations",), False),
    (("access",), False),
    (("identity",), False),
    (("data",), False),
    (("content",), False),
    (("platform",), False),
    (("identity", "access"), True),
)


def selection_key(f: ActivityFilter) -> str:
    """A stable digest of what is selected — not of when, which the window
    and the fold spans carry. Collections are sorted: a set's order is
    per-process, and "identity,access" selects what "access,identity" does."""
    fields = {
        k: sorted(v) if isinstance(v, (set, frozenset, tuple)) else v
        for k, v in asdict(replace(f, since=None, until=None)).items()
    }
    return hashlib.sha1(
        json.dumps(fields, sort_keys=True, default=str).encode()
    ).hexdigest()[:20]


async def summary(
    session: AsyncSession, f: ActivityFilter, window: analytics_repo.Window, *,
    workspace_id: Optional[str], ttl: float = SUMMARY_TTL_SECONDS,
) -> dict[str, Any]:
    """The band for ``f`` over ``window``, folds reused across windows."""
    scope = workspace_id or "all"
    selection = selection_key(f)

    async def _reuse(span: str, build):
        # Redis only: a fold holds every person and target in its span, too
        # large to keep a copy of in every worker.
        return await analytics_cache.cached(
            f"activity:fold:v3:p{catalogue.PROJECTION_VERSION}:{scope}:{selection}:{span}",
            build, ttl=FOLD_TTL_SECONDS, memory=False,
        )

    async def _build() -> dict[str, Any]:
        doc = await activity_repo.summary(
            session, f, window, reuse=_reuse, kept_from=activity_retention.horizon(),
        )
        doc["generatedAt"] = datetime.now(timezone.utc).isoformat()
        return await name_summary(session, doc)

    return await analytics_cache.cached(
        f"activity:v3:{scope}:{selection}:d{window.days}:{window.start[:10]}:{window.end[:10]}",
        _build, ttl=ttl,
    )


async def name_summary(session: AsyncSession, doc: dict[str, Any]) -> dict[str, Any]:
    """Name the leaderboards: one batched lookup per kind, like a page."""
    page = await names.name_page(
        session,
        people={r["id"] for r in doc["topPeople"]}
        | {p["id"] for r in doc["handsOnSources"] for p in r.get("people", ())},
        workspaces={r["workspaceId"] for r in doc["handsOnSources"] if r.get("workspaceId")},
        references={r["dataSourceId"] for r in doc["handsOnSources"]}
        | {r["id"] for r in doc["topTargets"] if r.get("id") and not r.get("label")},
    )
    for row in doc["topPeople"]:
        who = page.people.get(row["id"]) or {}
        row.update(name=who.get("name") or None, email=who.get("email"),
                   deleted=bool(who.get("deleted")),
                   avatarId=who.get("avatar_id"), hasImage=bool(who.get("has_image")))
    for row in doc["topTargets"]:
        row["label"] = row.get("label") or page.names.get(row.get("id") or "")
    for row in doc["handsOnSources"]:
        row["name"] = page.names.get(row["dataSourceId"])
        row["workspaceName"] = page.workspaces.get(row.get("workspaceId") or "")
        for person in row.get("people", ()):
            who = page.people.get(person["id"]) or {}
            person.update(name=who.get("name") or None, email=who.get("email"),
                          deleted=bool(who.get("deleted")),
                          avatarId=who.get("avatar_id"), hasImage=bool(who.get("has_image")))
    for row in doc["topActions"]:
        row.update(label=catalogue.label_of(row["type"]), category=catalogue.category_of(row["type"]))
    return doc


async def warm_platform(session: AsyncSession) -> int:
    """Fold the explorer's platform view through every lens, for its leading
    ranges: the views everyone opens, whose cold cost is folding closed days.
    Returns how many were built; one failing does not stop the rest."""
    built = 0
    for days in WARM_DAYS:
        window = analytics_repo.build_window(days)
        for categories, include_noise in LENSES:
            f = ActivityFilter(
                since=window.start, until=window.end,
                categories=categories, include_noise=include_noise,
            )
            try:
                await summary(session, f, window, workspace_id=None)
            except Exception as exc:  # noqa: BLE001 — one view, not the pass
                # Busy is another replica still building it: no fault here.
                logger.warning(
                    "Activity warm failed for %dd %s: %s",
                    days, ",".join(categories) or "everything", exc,
                    exc_info=not isinstance(exc, Busy),
                )
                await rolled_back(session)
                continue
            built += 1
    return built


async def rolled_back(session: AsyncSession) -> None:
    """Make ``session`` usable again after a failed read. A timed-out query
    leaves its transaction invalid, and every read after it on the same
    session would fail too — one slow window must not cost the whole pass."""
    with contextlib.suppress(Exception):
        await session.rollback()
