"""Signal that a data source's graph changed after a DIRECT FalkorDB load.

Every direct write to FalkorDB (seed scripts, import scripts, external
connectors) bypasses the app's write paths, so read caches and the
:AGGREGATED overlay go stale silently. Run this at the end of such a load
to converge: it POSTs the change-gated ``source-changed`` signal to the
aggregation control plane, which marks the source stale, clears content +
hierarchy read caches, nudges stats, and queues an aggregation rebuild.

Usage:
    python -m backend.scripts.signal_data_changed --graph <falkordb_graph>
    python -m backend.scripts.signal_data_changed --data-source-id <ds_id>
        [--reason external_load] [--force]

Environment:
    AGGREGATION_SERVICE_URL   Control plane base URL (default http://localhost:8091)
    AGGREGATION_INTERNAL_TOKEN Shared bearer token (optional in dev)
    DATABASE_URL / MANAGEMENT_DB_URL  Postgres (for --graph resolution)
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys

import httpx
from sqlalchemy import select

from backend.app.db.engine import get_async_session
from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services.aggregation.internal_auth import internal_auth_headers


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
    args = parser.parse_args()

    if not args.data_source_id and not args.graph:
        parser.error("one of --data-source-id or --graph is required")

    ds_id = args.data_source_id
    if not ds_id:
        ds_id = await _resolve_ds_id(args.graph)
        if not ds_id:
            print(
                f"error: no live data source found for graph {args.graph!r}",
                file=sys.stderr,
            )
            return 2

    base = os.getenv("AGGREGATION_SERVICE_URL", "http://localhost:8091")
    url = f"{base}/aggregation/data-sources/{ds_id}/source-changed"
    payload = {"reason": args.reason, "force": args.force}
    try:
        async with httpx.AsyncClient(headers=internal_auth_headers()) as client:
            resp = await client.post(url, json=payload, timeout=60.0)
    except httpx.HTTPError as exc:
        print(f"error: request to {url} failed: {exc}", file=sys.stderr)
        return 1

    if resp.status_code >= 400:
        print(
            f"error: control plane returned HTTP {resp.status_code}: {resp.text[:300]}",
            file=sys.stderr,
        )
        return 1

    print(json.dumps(resp.json(), indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
