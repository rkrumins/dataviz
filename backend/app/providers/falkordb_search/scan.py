"""Every match of a search, read for a job — its URNs, exactly, up to a cap.

A property operation acts on what a search matches. Its job reads the
search's units the way a count does (``engine._hop``): each unit's matches
once, a unit that ran out of time or memory split and read again, a unit the
fleet had no room for given back and tried again after a pause. Nothing is
kept between runs: a job reads its matches in one go, in its own process, so
there is no session to share and none is stored.

It reads each match's URN and nothing else — never ``propertiesRaw`` — and
stops starting units once it holds more matches than ``cap``: an operation
that would change more is refused before it writes anything.
"""
from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import time
from typing import Any, Dict, List, Sequence

from backend.app.providers.falkordb_search.export import _unit_rows, scan_context
from backend.app.providers.falkordb_search.plan import Context, Unit, make_plan
from backend.app.providers.falkordb_search.session import FAILED, RUNNING, Session
from backend.app.services.deep_search import (
    SearchFailed,
    SearchRunContext,
    get_deep_search_settings,
)
from backend.common.adapters.circuit import ProviderBusy
from backend.common.models.search import SearchQuery

#: How long one pass of the scan starts units for; units under way run on.
_HOP_S = 30.0
#: The pause after a pass that left units to read, doubled while none land.
_BACKOFF_S = 0.5
_BACKOFF_MAX_S = 15.0


@dataclasses.dataclass
class ScanResult:
    urns: List[str]
    over_cap: bool          # more matches than ``cap``: the scan stopped early


class _ScanWork:
    """What a scan takes from each unit: its matches' URNs."""

    def __init__(self, session: Session, ctx: Context, run, cap: int) -> None:
        self.session, self.ctx, self.run, self.cap = session, ctx, run, cap
        self.urns: List[str] = []
        self.over_cap = False

    async def unit(self, unit: Unit, timeout_s: float) -> List[str]:
        from backend.app.providers.falkordb_search.engine import unit_context

        ctx = dataclasses.replace(self.ctx, clamp_depths=tuple(self.session.clamp_depths))
        ctx = await unit_context(unit, ctx, self.run, timeout_s)
        return [row[2] async for row in _unit_rows(unit, ctx, self.session.clamps, ["urn"],
                                                   self.run, timeout_s, raw=False)]

    def fold(self, unit: Unit, urns: Sequence[str]) -> None:
        self.urns.extend(urns)
        self.session.count += len(urns)
        if self.session.count > self.cap:
            # No more units start; the ones under way land, and the scan ends.
            self.over_cap = True
            self.session.pending.clear()


async def scan_urns(provider, query: SearchQuery, *, context: SearchRunContext,
                    cap: int) -> ScanResult:
    """The URNs of ``query``'s matches (its scope resolved by the caller), or
    as many as it takes to know there are more than ``cap``."""
    from backend.app.providers.falkordb_search.engine import _hop, unit_budget

    settings = get_deep_search_settings()
    # A walk is read a page at a time: two statements' budget, as an export's.
    unit_s = unit_budget(settings, passes=2)
    admit = context.admit

    async def run(cypher: str, params: Dict[str, Any], timeout_s: float):
        async with (admit() if admit else contextlib.nullcontext()):
            return await provider._ro_query(cypher, params=params, timeout=timeout_s)

    compiler, ctx = await scan_context(
        provider, query, context, settings, run,
        refuse_path="A path search finds routes, not entities to change.")
    statement_s = max(1.0, settings.chunk_timeout_ms / 1000.0)
    plan = await make_plan(provider, query, compiler, run=lambda c, p: run(c, p, statement_s),
                           width=settings.chunk_width, walk_max=settings.walk_max,
                           timeout_s=statement_s)
    session = Session.start("scan", "scan", context.data_version, None, 0, plan,
                            scope_hash=context.scope_hash)
    work = _ScanWork(session, ctx, run, cap)
    pause = _BACKOFF_S
    while session.status == RUNNING:
        scanned = session.scanned
        try:
            await _hop(session, work, time.monotonic() + _HOP_S, settings, unit_s)
        except ProviderBusy:
            pass            # every unit given back before one landed: pause, as below
        if session.status != RUNNING:
            break
        # Units given back (the fleet is full) or the pass is over: pause, for
        # longer each time nothing landed.
        pause = _BACKOFF_S if session.scanned > scanned else min(pause * 2, _BACKOFF_MAX_S)
        await asyncio.sleep(pause)
    if session.status == FAILED:
        raise SearchFailed(f"reading the search's matches failed: {session.error}")
    return ScanResult(work.urns, work.over_cap)
