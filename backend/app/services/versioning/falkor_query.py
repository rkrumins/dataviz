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

# Canonical derived / system-internal node labels: NOT committed entities, so they must be excluded
# wherever the cache is compared against Postgres (counts, scans) or read as user entities. Kept in
# ONE place so the exclusion can never diverge between call sites — a divergence (reconcile excluded
# only ``_GVRollupMeta`` while the aggregation pipeline writes ``_AggMeta``) is exactly what made
# "Check sync" report a healthy graph as out-of-sync-by-one-node with no detail. Peers that MUST agree:
# ``bootstrap_worker`` (imports this) and ``context_engine`` (filters ``labels(n)`` on read).
#  * ``_GVRollupMeta`` — the projector's rollup-watermark marker (projection.py).
#  * ``_AggMeta``      — the aggregation pipeline's run-metadata singleton (falkordb_materialize.py).
#  * ``_Projection``   — projection scaffolding (falkordb_provider.py).
DERIVED_META_LABELS = ("_GVRollupMeta", "_AggMeta", "_Projection")


def not_derived_clause(var: str = "n") -> str:
    """A Cypher predicate excluding every :data:`DERIVED_META_LABELS` label from ``var`` — the
    ``MATCH (n) WHERE not_derived_clause('n')`` guard shared by the count + scan so both count/scan
    exactly the committed entities a faithful projection holds."""
    return " AND ".join(f"NOT '{lab}' IN labels({var})" for lab in DERIVED_META_LABELS)


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
