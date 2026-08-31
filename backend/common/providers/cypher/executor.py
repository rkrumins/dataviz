"""Cypher-execution seam: ``CypherResult`` and the ``CypherExecutor`` Protocol.

Every query in the FalkorDB provider goes through one of five chokepoint
methods on ``ConnectionMixin`` (``_ro_query``, ``_ro_query_tolerant``,
``_query``, ``_proj_ro_query``, ``_proj_query``). Around them sits
everything that makes FalkorDB survivable: transparent retries for
transient drops, cluster-redirect failover, the "warming up"
classification, the write semaphore, the latency-quiesce circuit,
slow-query telemetry. That machinery is FalkorDB's and stays exactly
where it is (``backend.app.providers.falkordb.connection``).

What a second database needs is not that machinery -- it is the
*interface* to it. This module names that interface so future algorithmic
code can run a query without knowing which engine answers it. The
FalkorDB adapter that satisfies this Protocol today is
``backend.app.providers.falkordb.executor.FalkorDBExecutor``; a future
engine (Neo4j, ArcadeDB, ...) supplies its own.

Kernel module: stdlib + typing only, no ``backend.app`` import.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Literal, Mapping, Optional, Protocol, Tuple


@dataclass
class CypherResult:
    """Engine-neutral wrapper around one query's driver-native result.

    ``result_set`` is THE SAME list object the driver returned -- never a
    copy, never a per-row transformation. Every one of today's ~120 call
    sites reads ``.result_set`` and indexes rows positionally; aliasing
    keeps that free.
    """

    raw: Any
    result_set: List[List[Any]]

    @property
    def columns(self) -> Tuple[str, ...]:
        """Column names for ``result_set``'s rows, read lazily from
        ``raw`` -- not computed at construction time.

        Nothing in the package reads this today; it exists only to back
        ``rows`` below, for future code. Lazy, and read defensively with
        ``getattr``, because the tolerant read path can hand back a driver
        stand-in with no header at all (FalkorDB's ``_EmptyResult``,
        returned for a graph that hasn't been created yet -- a normal
        state, not an error): an eager ``raw.header`` would crash exactly
        there.
        """
        header = getattr(self.raw, "header", None)
        if not header:
            return ()
        return tuple(
            entry[1] if isinstance(entry, (list, tuple)) and len(entry) > 1 else entry
            for entry in header
        )

    @property
    def rows(self) -> List[Dict[str, Any]]:
        """Lazy ``zip(columns, row)`` view of ``result_set`` -- for future
        code only; no existing call site reads this."""
        cols = self.columns
        return [dict(zip(cols, row)) for row in self.result_set]


class CypherExecutor(Protocol):
    """What a second database needs to plug into the algorithmic code that
    will eventually call this instead of a FalkorDB chokepoint directly:
    not FalkorDB's retry/failover/quiesce machinery -- just the ability to
    run a query against one of the two query targets and get back a
    ``CypherResult``.
    """

    target: Literal["source", "projection"]

    async def run(
        self,
        cypher: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        readonly: bool = True,
        timeout_s: Optional[float] = None,
        op: Optional[str] = None,
    ) -> CypherResult: ...

    async def run_tolerant(
        self,
        cypher: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        timeout_s: Optional[float] = None,
        op: Optional[str] = None,
    ) -> CypherResult:
        """Like :meth:`run` with ``readonly=True``, but a missing/never-
        created graph yields an empty ``CypherResult`` instead of raising."""
        ...
