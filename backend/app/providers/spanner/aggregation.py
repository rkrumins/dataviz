"""Lineage aggregation pipeline.

Maintains a sidecar table of materialized aggregated edges keyed by
``(source_urn, target_urn)``. The sidecar lives outside the property
graph so the user's underlying schema can evolve without breaking the
aggregation overlay. Aggregated edges are served from
``get_edges(EdgeQuery(edge_types=["AGGREGATED"]))`` via a plain SQL read.

This module replaces the ``INSERT OR UPDATE`` SQL the previous monolith
relied on (which is not a valid Spanner DML statement) with proper
Mutations API upserts and a separate state-table watermark.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple

from . import gql
from .connection import DEFAULT_AGGR_TIMEOUT_S, SpannerConnection
from .schema import (
    aggregation_state_table_name,
    ensure_aggregation_tables,
    sidecar_table_name,
)

logger = logging.getLogger(__name__)


_SIDECAR_COLUMNS: Tuple[str, ...] = (
    "source_urn",
    "target_urn",
    "weight",
    "source_edge_types",
    "latest_update",
)


async def count_aggregated_edges(
    conn: SpannerConnection, graph_name: str
) -> int:
    sidecar = sidecar_table_name(graph_name)

    def _q() -> int:
        with conn.database.snapshot() as snap:
            try:
                rs = list(snap.execute_sql(f"SELECT COUNT(*) FROM `{sidecar}`"))
            except Exception:
                # Sidecar does not exist yet — treat as zero rather than
                # forcing DDL just to satisfy a count.
                return 0
            return int(rs[0][0]) if rs else 0

    return await conn.run_in_executor(_q, timeout=10.0)


async def upsert_batch(
    conn: SpannerConnection,
    graph_name: str,
    leaf_edges: List[Tuple[str, str, str]],
    *,
    timeout: float = DEFAULT_AGGR_TIMEOUT_S,
) -> int:
    """Upsert a batch of ``(source_urn, target_urn, edge_type)`` triples.

    Same source/target pairs across multiple triples collapse into a
    single row whose weight is the count and ``source_edge_types`` lists
    the distinct edge types observed.
    """
    if not leaf_edges:
        return 0

    grouped: Dict[Tuple[str, str], List[str]] = {}
    for s, t, et in leaf_edges:
        grouped.setdefault((s, t), []).append(et)

    sidecar = sidecar_table_name(graph_name)

    def _write() -> int:
        now = datetime.now(tz=timezone.utc)
        rows = [
            [s, t, len(types), sorted(set(types)), now]
            for (s, t), types in grouped.items()
        ]
        with conn.database.batch() as batch:
            batch.insert_or_update(
                table=sidecar,
                columns=_SIDECAR_COLUMNS,
                values=rows,
            )
        return len(rows)

    return int(await conn.run_in_executor(_write, timeout=timeout))


async def upsert_state(
    conn: SpannerConnection,
    graph_name: str,
    *,
    notes: str = "",
    timeout: float = 10.0,
) -> None:
    r"""Write the aggregation watermark via the Mutations API.

    The previous monolith reached for ``INSERT OR UPDATE \`...\``` SQL,
    which Spanner does not support. The Mutations API gives us proper
    upsert semantics on the state table.
    """
    state_table = aggregation_state_table_name(graph_name)

    def _write() -> None:
        now = datetime.now(tz=timezone.utc)
        with conn.database.batch() as batch:
            batch.insert_or_update(
                table=state_table,
                columns=("scope", "last_aggregation_commit_ts", "last_full_run_at", "notes"),
                values=[[graph_name, now, now, notes]],
            )

    await conn.run_in_executor(_write, timeout=timeout)


async def materialize_batch(
    conn: SpannerConnection,
    graph_name: str,
    *,
    batch_size: int = 1000,
    containment_edge_types: Optional[List[str]] = None,
    lineage_edge_types: Optional[List[str]] = None,
    last_cursor: Optional[str] = None,
    progress_callback: Optional[Callable[[int, int, Optional[str], int], Awaitable[None]]] = None,
    intra_batch_callback: Optional[Callable[[int], Awaitable[None]]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    """Cursor-paginated aggregation pass.

    Walks every lineage edge in the graph, expanding each into a single
    aggregated edge in the sidecar (one weighted edge per unique
    source→target pair). Uses GQL to read leaf edges, then the Mutations
    API to upsert the sidecar. The cursor is the lexicographic
    ``concat(source, '|', target)`` of the last row in each batch — this
    is stable under concurrent writes and lets the worker resume.
    """
    from google.cloud.spanner_v1 import param_types

    await conn.ensure_connected()
    await ensure_aggregation_tables(conn, graph_name)

    cont = list(containment_edge_types or [])
    if lineage_edge_types:
        effective = [t for t in lineage_edge_types if t.upper() != "AGGREGATED"]
        if not effective:
            return {"processed": 0, "aggregated_edges_affected": 0, "errors": 0}
    else:
        effective = []
    exclude = list(cont) + ["AGGREGATED"]

    # Build the leaf-selection clause
    clauses: List[str] = []
    params: Dict[str, Any] = {}
    ptypes: Dict[str, Any] = {}
    if effective:
        clauses.append("LABELS(r) && @types")
        params["types"] = effective
        ptypes["types"] = param_types.Array(param_types.STRING)
    else:
        clauses.append("NOT (LABELS(r) && @exclude)")
        params["exclude"] = exclude
        ptypes["exclude"] = param_types.Array(param_types.STRING)

    # Total for progress
    total = 0
    try:
        total_rows = await gql.execute_ro(
            conn,
            f"MATCH (s)-[r]->(t) WHERE {' AND '.join(clauses)} RETURN COUNT(*) AS c",
            graph_name=graph_name,
            params=params,
            param_types_=ptypes,
            max_staleness_s=0.0,
            request_tag="aggr_total",
        )
        total = int(total_rows[0][0]) if total_rows else 0
    except Exception as exc:  # noqa: BLE001
        logger.info("spanner_graph: aggregation total query failed: %s", exc)

    processed = 0
    errors = 0
    created_count = 0
    current_cursor = last_cursor

    while True:
        if should_cancel and should_cancel():
            break

        cur_params = dict(params)
        cur_ptypes = dict(ptypes)
        cursor_clause = ""
        if current_cursor:
            cursor_clause = " AND CONCAT(s.urn, '|', t.urn) > @cursor"
            cur_params["cursor"] = current_cursor
            cur_ptypes["cursor"] = param_types.STRING

        # NOTE: ``LABELS(r)[0]`` — zero-based array index in GQL. The
        # previous code used ``LABELS(r)[OFFSET(0)]`` which is BigQuery
        # SQL syntax and rejected by the GQL parser.
        leaf_query = (
            f"MATCH (s)-[r]->(t) WHERE {' AND '.join(clauses)}{cursor_clause} "
            f"RETURN s.urn AS s_urn, t.urn AS t_urn, LABELS(r)[0] AS edge_type "
            f"ORDER BY CONCAT(s.urn, '|', t.urn) "
            f"LIMIT {max(1, int(batch_size))}"
        )

        try:
            batch_rows = await gql.execute_ro(
                conn,
                leaf_query,
                graph_name=graph_name,
                params=cur_params,
                param_types_=cur_ptypes,
                timeout=DEFAULT_AGGR_TIMEOUT_S,
                max_staleness_s=0.0,
                request_tag="aggr_batch",
            )
        except Exception as exc:  # noqa: BLE001
            logger.exception("spanner_graph: aggregation batch fetch failed: %s", exc)
            errors += 1
            break

        if not batch_rows:
            break

        leaf_edges: List[Tuple[str, str, str]] = [
            (str(r[0]), str(r[1]), str(r[2])) for r in batch_rows
        ]

        try:
            created_count += await upsert_batch(conn, graph_name, leaf_edges)
            processed += len(leaf_edges)
            current_cursor = f"{leaf_edges[-1][0]}|{leaf_edges[-1][1]}"
        except Exception as exc:  # noqa: BLE001
            logger.exception("spanner_graph: aggregation batch upsert failed: %s", exc)
            errors += 1
            break

        if intra_batch_callback is not None:
            try:
                await intra_batch_callback(created_count)
            except Exception as cb_exc:  # noqa: BLE001
                logger.warning("spanner_graph: intra_batch_callback failed: %s", cb_exc)

        if progress_callback is not None:
            try:
                await progress_callback(processed, total, current_cursor, created_count)
            except Exception as cb_exc:  # noqa: BLE001
                logger.warning("spanner_graph: progress_callback failed: %s", cb_exc)

        if len(batch_rows) < batch_size:
            break

    try:
        await upsert_state(conn, graph_name, notes=f"processed={processed}")
    except Exception as exc:  # noqa: BLE001
        logger.warning("spanner_graph: aggregation state update failed: %s", exc)

    return {
        "processed": processed,
        "aggregated_edges_affected": created_count,
        "errors": errors,
        "last_cursor": current_cursor,
    }
