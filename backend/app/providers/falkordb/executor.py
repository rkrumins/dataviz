"""``FalkorDBExecutor`` -- the adapter over the provider's five query
chokepoints (``ConnectionMixin._ro_query`` / ``_query`` /
``_ro_query_tolerant`` / ``_proj_ro_query`` / ``_proj_query``).

Retries, cluster-redirect failover, the "warming up" classification, the
write semaphore, the latency-quiesce circuit, and slow-query telemetry all
stay exactly where they are -- inside those five chokepoints (see
``connection.py``). This class adds none of that; it only gives future
algorithmic code (and this task's own tests) the database-neutral
``CypherExecutor`` shape from ``backend.common.providers.cypher.executor``
to call instead of naming a FalkorDB chokepoint directly.

Two instances, not one executor with a ``target=`` argument: ``_proj_query``
carries the quiesce gate and the write semaphore, and
``ConnectionMixin._proj`` resolves to ``_graph`` only in ``"in_source"``
projection mode -- the two targets differ in *policy*, not just in handle,
and separate instances keep that visible at the call site (``self.executor``
vs. ``self.projection_executor``, wired as cached properties on
``ConnectionMixin``).

No call site uses this yet -- a later task converts a pilot module, and the
next PR converts the rest. This module and the two cached properties are
the seam, proved by ``backend/tests/test_falkordb_executor.py``.
"""
from __future__ import annotations

from typing import Any, Mapping, Optional, TYPE_CHECKING

from backend.app.providers.falkordb.errors import _EmptyResult
from backend.common.providers.cypher.executor import CypherResult

if TYPE_CHECKING:
    from backend.app.providers.falkordb._state import _FalkorState


def _wrap(raw: Any) -> CypherResult:
    return CypherResult(raw=raw, result_set=raw.result_set)


class FalkorDBExecutor:
    """Adapter over one query target (source graph or projection graph) of
    a single ``FalkorDBProvider`` instance."""

    def __init__(self, owner: "_FalkorState", target: str) -> None:
        self._owner = owner
        self.target = target

    async def run(
        self,
        cypher: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        readonly: bool = True,
        timeout_s: Optional[float] = None,
        op: Optional[str] = None,
    ) -> CypherResult:
        # The chokepoint is looked up on the owner HERE, at call time --
        # never captured in __init__. The unit suite fakes the database by
        # assigning over these methods on a live instance (`p._ro_query =
        # fake`, 26 sites; `_proj_ro_query`, 23; `_query`, 9; `_proj_query`,
        # 4). A reference captured at construction would bind the real
        # bound method, and those fakes would stop intercepting --
        # silently, with the tests still green.
        owner = self._owner
        if self.target == "source":
            fn = owner._ro_query if readonly else owner._query
        else:
            fn = owner._proj_ro_query if readonly else owner._proj_query
        raw = await fn(cypher, params=params, timeout=timeout_s, op=op)
        return _wrap(raw)

    async def run_tolerant(
        self,
        cypher: str,
        params: Optional[Mapping[str, Any]] = None,
        *,
        timeout_s: Optional[float] = None,
        op: Optional[str] = None,
    ) -> CypherResult:
        owner = self._owner
        if self.target == "source":
            raw = await owner._ro_query_tolerant(cypher, params=params, timeout=timeout_s, op=op)
            return _wrap(raw)
        # The projection graph has no native "_proj_ro_query_tolerant" --
        # this reproduces _ro_query_tolerant's own try/verify/mask shape
        # (ConnectionMixin._ro_query_tolerant) for the projection chokepoint.
        try:
            raw = await owner._proj_ro_query(cypher, params=params, timeout=timeout_s, op=op)
        except Exception as exc:
            if await owner._is_verified_missing_graph(exc):
                raw = _EmptyResult()
            else:
                raise
        return _wrap(raw)
