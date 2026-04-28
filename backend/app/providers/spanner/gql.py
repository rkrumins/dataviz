"""GQL / SQL execution wrappers.

Spanner Graph speaks GoogleSQL with embedded GQL. A graph query is
prefixed with ``GRAPH <name>`` to enter graph-mode; an ordinary SQL
statement (e.g. ``SELECT ... FROM INFORMATION_SCHEMA.…``) is submitted
unchanged. We auto-detect the right form via a head-of-query inspection.

Critical syntax rules baked into the helpers below:

  * Graph element label access uses zero-based array indexing
    ``LABELS(n)[0]`` — *not* the BigQuery / SQL ``[OFFSET(0)]`` form
    that the previous monolith mistakenly used. ``OFFSET()`` is valid
    in plain SQL on ARRAY columns but is rejected inside a GQL RETURN
    expression.

  * Quantified path patterns use ``-[r]->{1,N}(other)`` — a single
    arrow before the edge bracket, the quantifier between the closing
    bracket and the destination node. The previous monolith
    accidentally interpolated an arrow on both sides
    (``->[r]->{1,N}(other)``), which is unparsable.

  * Edge label filtering inside a quantified path goes inside the edge
    bracket: ``-[r WHERE LABELS(r) && @types]->{1,N}(b)``. Outside the
    bracket ``r`` is an ARRAY<EDGE>, not a single edge — the syntax
    differs from Cypher.

  * Counts use ``COUNT(*)``, never ``COUNT(node_var)`` — graph elements
    are typed and don't satisfy the ``COUNT(value)`` signature.
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any, Dict, List, Optional, Tuple

from .connection import (
    DEFAULT_QUERY_TIMEOUT_S,
    DEFAULT_READ_STALENESS_S,
    SpannerConnection,
)


def _needs_graph_clause(query: str) -> bool:
    """Heuristic: does this query need a leading ``GRAPH <name>`` clause?

    Pure SQL (SELECT … FROM INFORMATION_SCHEMA.…, COUNT against a managed
    table, etc.) does not. GQL traversals start with MATCH or contain
    a relationship pattern.
    """
    head = query.strip()
    upper = head.upper()
    if upper.startswith("MATCH ") or upper.startswith("MATCH("):
        return True
    if " MATCH (" in upper or " MATCH(" in upper:
        return True
    return False


def wrap_with_graph_clause(query: str, graph_name: str) -> str:
    """Prepend ``GRAPH <name>`` to a GQL query; leave SQL untouched."""
    if _needs_graph_clause(query) and graph_name:
        return f"GRAPH {graph_name}\n{query}"
    return query


async def execute_ro(
    conn: SpannerConnection,
    query: str,
    *,
    graph_name: str,
    params: Optional[Dict[str, Any]] = None,
    param_types_: Optional[Dict[str, Any]] = None,
    timeout: float = DEFAULT_QUERY_TIMEOUT_S,
    max_staleness_s: Optional[float] = DEFAULT_READ_STALENESS_S,
    request_tag: Optional[str] = None,
) -> List[Tuple[Any, ...]]:
    """Execute a read-only SQL/GQL statement; return all rows as tuples.

    Uses ``database.snapshot(exact_staleness=...)`` for bounded-staleness
    reads when ``max_staleness_s > 0``; strong reads otherwise. Bounded
    staleness is the right default for browse-path queries — it avoids
    leader-region round-trips on read-heavy databases.
    """
    await conn.ensure_connected()
    full_query = wrap_with_graph_clause(query, graph_name)
    p = params or {}
    pt = param_types_ or {}

    def _exec() -> List[Tuple[Any, ...]]:
        from google.cloud.spanner_v1 import RequestOptions

        kwargs: Dict[str, Any] = {}
        if max_staleness_s and max_staleness_s > 0:
            kwargs["exact_staleness"] = timedelta(seconds=max_staleness_s)
        req_opts = RequestOptions(request_tag=f"synodic:{request_tag}") if request_tag else None
        with conn.database.snapshot(**kwargs) as snap:
            rs = snap.execute_sql(
                full_query,
                params=p or None,
                param_types=pt or None,
                request_options=req_opts,
            )
            return [tuple(row) for row in rs]

    return await conn.run_with_retry(_exec, timeout=timeout)


async def execute_rw(
    conn: SpannerConnection,
    query: str,
    *,
    graph_name: str,
    params: Optional[Dict[str, Any]] = None,
    param_types_: Optional[Dict[str, Any]] = None,
    timeout: float = DEFAULT_QUERY_TIMEOUT_S,
    request_tag: Optional[str] = None,
) -> int:
    """Execute a DML statement inside a read-write transaction.

    Returns the row count from ``ResultSet.row_count``.
    """
    await conn.ensure_connected()
    full_query = wrap_with_graph_clause(query, graph_name)
    p = params or {}
    pt = param_types_ or {}

    def _exec() -> int:
        from google.cloud.spanner_v1 import RequestOptions

        req_opts = RequestOptions(request_tag=f"synodic:{request_tag}") if request_tag else None

        def _work(tx: Any) -> int:
            rs = tx.execute_update(
                full_query,
                params=p or None,
                param_types=pt or None,
                request_options=req_opts,
            )
            return int(rs)

        return int(conn.database.run_in_transaction(_work))

    return await conn.run_with_retry(_exec, timeout=timeout)
