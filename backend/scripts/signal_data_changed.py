"""Signal that a data source's graph changed after a DIRECT FalkorDB load.

Every direct write to FalkorDB (seed scripts, import scripts, external
connectors) bypasses the app's write paths, so read caches and the
:AGGREGATED overlay go stale silently. Run this at the end of such a load
to converge: it POSTs the unified ``refresh`` verb to the aggregation
control plane with ``origin="script"``. The default ``--scope auto`` is
the change-gated signal (marks the source stale, clears content +
hierarchy read caches, nudges stats, and queues a rebuild) — identical to
the legacy source-changed call. ``read-caches`` / ``rollups`` / ``full``
act unconditionally for operators who want to force part or all of it.

The direct FalkorDB loaders (``seed_*``, ``import_layered_lineage``, …) call
:func:`emit_after_load` / :func:`emit_after_load_async` at the end of a load
so convergence is automatic; this module stays runnable standalone for a
manual re-signal or a loader run with ``--no-signal``.

Usage:
    python -m backend.scripts.signal_data_changed --graph <falkordb_graph>
    python -m backend.scripts.signal_data_changed --data-source-id <ds_id>
        [--scope auto|read-caches|rollups|full] [--reason external_load] [--force]

Environment:
    AGGREGATION_SERVICE_URL   Control plane base URL (default http://localhost:8091)
    AGGREGATION_INTERNAL_TOKEN Shared bearer token (optional in dev)
    DATABASE_URL / MANAGEMENT_DB_URL  Postgres (for --graph resolution)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import sys

import httpx
from sqlalchemy import select

from backend.app.db.engine import get_async_session
from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services.aggregation.internal_auth import internal_auth_headers

logger = logging.getLogger(__name__)


async def _resolve_ds_id(graph_name: str) -> str | None:
    """Resolve a live data source id from its FalkorDB graph name."""
    async with get_async_session() as session:
        row = (
            await session.execute(
                select(WorkspaceDataSourceORM)
                .where(WorkspaceDataSourceORM.graph_name == graph_name)
                .where(WorkspaceDataSourceORM.deleted_at.is_(None))
            )
        ).scalars().first()
        return row.id if row else None


async def signal_data_changed(
    *,
    data_source_id: str | None = None,
    graph_name: str | None = None,
    scope: str = "auto",
    reason: str = "external_load",
    force: bool = False,
    origin: str = "script",
    base_url: str | None = None,
    timeout: float = 60.0,
) -> dict:
    """Resolve the data source (by id, or by graph name) and POST the unified
    ``refresh`` verb to the aggregation control plane. Returns the parsed
    response JSON.

    Raises ``ValueError`` when neither id nor graph name is given,
    ``LookupError`` when a graph name resolves to no live data source,
    ``RuntimeError`` on an HTTP error status, or ``httpx`` errors on a
    transport failure. Callers wanting best-effort semantics (a load must not
    fail because the control plane is down) should use :func:`emit_after_load`
    / :func:`emit_after_load_async` instead of catching these directly.
    """
    if not data_source_id and not graph_name:
        raise ValueError("one of data_source_id or graph_name is required")
    ds_id = data_source_id
    if not ds_id:
        ds_id = await _resolve_ds_id(graph_name)
        if not ds_id:
            raise LookupError(f"no live data source found for graph {graph_name!r}")

    base = base_url or os.getenv("AGGREGATION_SERVICE_URL", "http://localhost:8091")
    url = f"{base}/aggregation/data-sources/{ds_id}/refresh"
    payload = {"scope": scope, "reason": reason, "force": force, "origin": origin}
    async with httpx.AsyncClient(headers=internal_auth_headers()) as client:
        resp = await client.post(url, json=payload, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(
            f"control plane returned HTTP {resp.status_code}: {resp.text[:300]}"
        )
    return resp.json()


async def emit_after_load_async(
    *,
    graph_name: str | None = None,
    data_source_id: str | None = None,
    reason: str = "external_load",
    force: bool = False,
) -> bool:
    """Best-effort convergence signal for an ASYNC loader (already inside an
    event loop). Returns True on success, False otherwise, and NEVER raises —
    a control plane that is unreachable (common when a seed script runs
    without the app stack up) is a warning, not a failed load.

    Opt out by setting ``DATAVIZ_SKIP_LOAD_SIGNAL`` (e.g. in CI, or a bulk
    load that will be signalled once at the end) — the call then no-ops."""
    target = graph_name or data_source_id
    if os.getenv("DATAVIZ_SKIP_LOAD_SIGNAL"):
        logger.info(
            "freshness signal skipped for %s (DATAVIZ_SKIP_LOAD_SIGNAL set)", target,
        )
        return False
    try:
        result = await signal_data_changed(
            graph_name=graph_name, data_source_id=data_source_id,
            reason=reason, force=force,
        )
        logger.info(
            "freshness signal sent for %s: changed=%s job=%s",
            target, result.get("changed"),
            result.get("jobId") or result.get("job_id"),
        )
        return True
    except Exception as exc:
        logger.warning(
            "freshness signal failed for %s (%s) — data loaded, but the canvas "
            "will not converge until you run "
            "`python -m backend.scripts.signal_data_changed --graph %s`",
            target, exc, graph_name or "<graph>",
        )
        return False


def emit_after_load(
    *,
    graph_name: str | None = None,
    data_source_id: str | None = None,
    reason: str = "external_load",
    force: bool = False,
) -> bool:
    """Best-effort convergence signal for a SYNC loader. Runs the async signal
    via ``asyncio.run`` and swallows every error (see
    :func:`emit_after_load_async`). Must NOT be called from within a running
    event loop — async callers use :func:`emit_after_load_async`."""
    try:
        return asyncio.run(
            emit_after_load_async(
                graph_name=graph_name, data_source_id=data_source_id,
                reason=reason, force=force,
            )
        )
    except Exception as exc:
        # asyncio.run edge cases (e.g. called from an already-running loop).
        logger.warning(
            "freshness signal could not run for %s: %s",
            graph_name or data_source_id, exc,
        )
        return False


async def main() -> int:
    parser = argparse.ArgumentParser(
        description="Signal a source-changed event after a direct FalkorDB load.",
    )
    parser.add_argument("--data-source-id", help="Target data source id")
    parser.add_argument("--graph", help="FalkorDB graph name (resolved to a data source)")
    parser.add_argument(
        "--reason", default="external_load", help="Signal reason (default: external_load)",
    )
    parser.add_argument(
        "--force", action="store_true",
        help="Invalidate + rebuild even if the fingerprint is unchanged",
    )
    parser.add_argument(
        "--scope", default="auto",
        choices=["auto", "read-caches", "rollups", "full"],
        help=(
            "What to converge (default: auto — the change-gated signal, "
            "equivalent to the legacy source-changed call). read-caches / "
            "rollups / full act unconditionally."
        ),
    )
    args = parser.parse_args()

    if not args.data_source_id and not args.graph:
        parser.error("one of --data-source-id or --graph is required")

    try:
        result = await signal_data_changed(
            data_source_id=args.data_source_id,
            graph_name=args.graph,
            scope=args.scope,
            reason=args.reason,
            force=args.force,
            origin="script",
        )
    except LookupError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    except (httpx.HTTPError, RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
