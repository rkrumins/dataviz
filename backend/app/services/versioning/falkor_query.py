"""Low-level bounded FalkorDB query primitive, shared by the projector and the reconciler.

Extracted into its own leaf module so neither :mod:`projection` nor :mod:`reconcile` has to
import the other just to reach ``_q`` / the query budgets. Previously ``projection`` imported
``reconcile``'s count helpers at module load while ``reconcile`` imported ``projection``'s ``_q``
(lazily, to dodge the resulting cycle) — a genuine import cycle CodeQL rightly flagged. This
module imports nothing from either, so both can import it and the cycle is gone.
"""
from __future__ import annotations

import asyncio
import os
from typing import Optional

# Server-side query budgets (ms). FalkorDB runs with TIMEOUT_DEFAULT / TIMEOUT_MAX set, so an
# un-budgeted query inherits the 30s default and dies mid-seed; every projector / reconcile query
# passes an explicit budget below TIMEOUT_MAX (mirroring the aggregation pipeline's clamp).
_WRITE_TIMEOUT_MS = int(1000 * min(170.0, max(
    5.0, float(os.getenv("PROJECTION_FALKOR_WRITE_TIMEOUT_S", "60")))))
_READ_TIMEOUT_MS = int(1000 * min(170.0, max(
    2.0, float(os.getenv("PROJECTION_FALKOR_READ_TIMEOUT_S", "30")))))


async def _q(client, cypher: str, params: Optional[dict] = None,
             *, timeout_ms: int = _WRITE_TIMEOUT_MS):
    """Run one query with a server-side kill budget AND a client-side hang net (belt over the
    pool-level socket timeouts, and the bound for client fakes without them). Falls back to the
    timeout-less call for client fakes/libs without the kwarg."""
    try:
        coro = client.query(cypher, params=params, timeout=timeout_ms)
    except TypeError:
        coro = client.query(cypher, params=params)
    return await asyncio.wait_for(coro, timeout=timeout_ms / 1000 + 10)
