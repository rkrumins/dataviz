"""Platform Analytics API — business insights over the whole application.

Three read-only endpoints backing the Analytics section: a platform-wide
summary, one aggregate row per workspace, and a per-workspace drill-down.
All aggregation lives in ``analytics_repo``; this module is the HTTP contract.

**Access.** Gated on ``system:analytics:read`` — the dedicated privilege —
or on ``system:org-admin`` / ``system:audit:read``, kept as implications for
deployments whose roles predate it, or on ``system:admin``, which implies
everything. Resolved once by ``analytics_scope.resolve_scope``, which answers
"may they load this?" and "what may they be told?" together. With
``analyticsPublicEnabled`` on, everyone else gets a redacted document instead
of a refusal.

**Pool.** These are aggregate reads on a page people leave open, so they take
``get_readonly_db_session``: a dashboard rebuild must not sit in the WEB pool
that serves the rest of the product.

**Window.** ``days`` matches the ``/admin/telemetry/summary?days=`` convention
already in the codebase. Totals are all-time; everything else is measured over
the trailing window, with an equal-length preceding window supplying the deltas.

Responses are typed loosely (``dict[str, Any]``) on purpose. The payload is a
wide, evolving analytics document rather than a domain entity, and pinning ~60
nested fields into Pydantic models here would buy schema noise rather than
safety — the frontend's ``analyticsService`` types are the consumed contract.
"""
from __future__ import annotations

from datetime import datetime
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_readonly_db_session
from backend.app.db.repositories import analytics_repo
from backend.app.services import analytics_cache
from backend.app.services.analytics_scope import ViewerScope, resolve_scope

logger = logging.getLogger(__name__)

router = APIRouter()

#: The presets the range picker offers. Bounded so a caller can't ask for an
#: unbounded scan; 365 matches the telemetry endpoint's ceiling.
_DAYS = Query(30, ge=1, le=365, description="Trailing window, in days.")

#: A custom range. ``from``/``to`` are the natural names and both are Python
#: keywords or builtins, so they are aliased rather than spelled awkwardly in
#: the URL. Both inclusive; supplying either one requires the other.
_FROM = Query(
    None, alias="from", description="Range start, inclusive (YYYY-MM-DD).",
)
_TO = Query(
    None, alias="to", description="Range end, inclusive (YYYY-MM-DD).",
)


def _window_args(days: int, start: str | None, end: str | None) -> dict[str, Any]:
    """Custom range wins when supplied; otherwise the trailing-day preset.

    ``days`` always has a value (its default is 30), so "did the caller ask for
    a custom range?" is decided by the dates, never by days being unset.
    """
    if start or end:
        return {"start": start, "end": end}
    return {"days": days}


#: Deliberately NOT per-reader — see `_serve`. Shared with the warmer, which
#: must write the exact key the reader looks up.
_cache_key = analytics_cache.document_key


def _at_epoch(args: dict[str, Any]) -> tuple[datetime, dict[str, Any]]:
    """The instant this request's documents end at, and the builder args.

    Every window a reader can see must end at the SAME instant, or a 14-day
    figure can come out smaller than the 7-day figure inside it — which is what
    happened, because each document used whatever the wall clock said when it
    happened to be built. Snapping to the shared epoch fixes both halves at
    once: the documents agree because they end together, and they stay agreed
    because the epoch is in the key, so all windows roll over as one.
    """
    epoch = analytics_cache.epoch_start()
    return epoch, {**args, "now": epoch}


async def _serve(
    key: str,
    build: Callable[[], Awaitable[Any]],
    redact: Callable[[Any, ViewerScope], Any],
    scope: ViewerScope,
) -> Any:
    """Compute a document once per window, then redact it per reader.

    WHY THE CACHE IS NOT KEYED BY READER. It used to be, and the reasoning was
    sound as far as it went: two callers see different documents, so an entry
    keyed on the window alone would let whoever asked first decide what
    everyone else was shown — an administrator warming the cache would hand
    their unredacted document to the next non-privileged reader.

    But the fix priced the platform out of its own dashboard. The key included
    a fingerprint of the caller's visible workspaces, so readers with different
    access never shared an entry; a few hundred concurrent users with a few
    hundred distinct workspace sets meant a few hundred full recomputations per
    TTL, each one scanning the whole event window. The cache was working
    hardest exactly when it needed to help most.

    The audience was in the key because the REDACTED document was in the value.
    Cache the unredacted one instead and the problem dissolves: the bytes are
    identical for everyone, so one computation serves every reader, and what
    each of them receives is still computed from their own scope on every
    request. `_serve` is the only way anything leaves this cache, and it cannot
    return a document without applying a redactor to it.

    THE COPY, AND WHAT IT ACTUALLY GUARDS. Cache hits from the in-process tier
    hand back the SAME object every time, so anything a redactor writes into
    the document it is given would edit the shared entry and serve the first
    reader's redaction to the second.

    Today no redactor does that: each one shallow-copies and then reassigns
    whole top-level keys with freshly built objects. The copy here is therefore
    insurance, not a fix for a live bug — but it is the cheap kind. A future
    redactor reaching one level deeper (``doc["health"]["access"] = …``) would
    corrupt the shared entry silently, for every subsequent reader, and a
    cross-reader disclosure is not a class of bug worth leaving to a convention
    nothing enforces.

    So it is kept for readers who get redacted, and skipped for the privileged,
    whose redactors provably return the document untouched — there it was a
    deep clone of twelve series, a ghost series, cohort grids and four
    leaderboards, made on the event loop and discarded unchanged, on the
    posture this section actually ships in.

    Where a copy IS taken it goes through JSON rather than ``copy.deepcopy``.
    The document is already pure JSON data — Redis stores it via ``json.dumps``
    — and a C round trip beats a pure-Python recursive clone carrying a memo
    table across every field it touches.
    """
    raw = await analytics_cache.cached(key, build)
    if raw is None:
        return None
    if scope.privileged:
        return redact(raw, scope)
    return redact(json.loads(json.dumps(raw)), scope)


@router.get("/summary")
async def analytics_summary(
    days: int = _DAYS,
    date_from: str | None = _FROM,
    date_to: str | None = _TO,
    scope: ViewerScope = Depends(resolve_scope),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> dict[str, Any]:
    """Platform-wide KPIs, time series, breakdowns, leaderboards, and funnel."""
    args = _window_args(days, date_from, date_to)
    epoch, build_args = _at_epoch(args)
    try:
        return await _serve(
            _cache_key("summary", args, epoch=epoch),
            # `scope=None` is what makes the repo return the document
            # unredacted; `_serve` is what puts the scope back.
            lambda: analytics_repo.platform_summary(session, scope=None, **build_args),
            analytics_repo.redact_summary,
            scope,
        )
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/workspaces")
async def analytics_workspaces(
    days: int = _DAYS,
    date_from: str | None = _FROM,
    date_to: str | None = _TO,
    scope: ViewerScope = Depends(resolve_scope),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> list[dict[str, Any]]:
    """One aggregate row per live workspace — the Workspaces tab's table."""
    args = _window_args(days, date_from, date_to)
    epoch, build_args = _at_epoch(args)
    try:
        return await _serve(
            _cache_key("workspaces", args, epoch=epoch),
            lambda: analytics_repo.workspace_rows(session, scope=None, **build_args),
            analytics_repo.redact_workspace_rows,
            scope,
        )
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/workspaces/{workspace_id}")
async def analytics_workspace_detail(
    workspace_id: str = Path(..., description="Workspace id to drill into."),
    days: int = _DAYS,
    date_from: str | None = _FROM,
    date_to: str | None = _TO,
    scope: ViewerScope = Depends(resolve_scope),
    session: AsyncSession = Depends(get_readonly_db_session),
) -> dict[str, Any]:
    """Full insights for one workspace, in the same shape as the summary."""
    args = _window_args(days, date_from, date_to)
    epoch, build_args = _at_epoch(args)
    try:
        detail = await _serve(
            _cache_key(f"ws:{workspace_id}", args, epoch=epoch),
            lambda: analytics_repo.workspace_detail(
                session, workspace_id, scope=None, **build_args),
            analytics_repo.redact_workspace_detail,
            scope,
        )
    except analytics_repo.InvalidWindow as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if detail is None:
        raise HTTPException(
            status_code=404, detail=f"Workspace '{workspace_id}' not found",
        )
    # The reachability gate moved OUT of the cached builder, because the
    # builder now runs scope-free. Order is deliberate and unchanged: a
    # workspace that does not exist is a 404 for everyone, including a
    # non-member, so the two answers stay distinguishable exactly as before.
    if not scope.can_see(workspace_id):
        raise HTTPException(
            status_code=403,
            detail="You are not a member of this workspace.",
        )
    return detail
