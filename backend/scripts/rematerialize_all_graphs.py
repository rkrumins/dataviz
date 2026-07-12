"""One-time re-materialization of every graph with :AGGREGATED cells.

WHY: the no-walk aggregated reader serves depth-keyed derivation only for
graphs whose cells carry sourceDepth/targetDepth stamps (stampVersion >= 2,
recorded in the in-graph _AggMeta singleton). Graphs materialized before the
depth-stamp contract serve stored cells + the exact raw mirror with
``stale: true`` until re-materialized. This script drains that backlog in one
supervised pass instead of waiting for per-graph read-path self-heal.

WHAT IT DOES, per data source (sequential — the shared FalkorDB has few
worker threads and materialization is CPU-heavy):
  1. Skip when _AggMeta already reports stampVersion >= 2 (idempotent).
  2. Skip when the graph has no :AGGREGATED cells AND has never been
     materialized (nothing to migrate — first canvas read self-heals it).
  3. Trigger a real aggregation job through the control plane
     (POST /aggregation/data-sources/{ds}/jobs — job row, watchdog, tuning,
     admission; never an inline shadow run).
  4. Poll the job to a terminal state (bounded).
  5. Verify: _AggMeta stampVersion >= 2 and zero depth-null cells.

Terminal failures (budget exceeded / precondition) are reported and SKIPPED —
the worker stamps materialize:terminal:{ds} so read-path self-heal won't
churn either; raise the budget in the tuning dialog and re-run this script
(an explicit trigger clears the terminal key).

USAGE (dev):
    python backend/scripts/rematerialize_all_graphs.py \
        --control-plane http://localhost:8091 [--dry-run] [--only ds_x,ds_y]

Requires: Postgres (workspace_data_sources) + FalkorDB reachable with the
same env the services use; the control plane needs no user auth.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from typing import List, Optional, Tuple

import httpx
from redis import asyncio as aioredis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

POLL_INTERVAL_S = 10.0
JOB_TIMEOUT_S = float(os.getenv("REMAT_JOB_TIMEOUT_S", "3600"))
TERMINAL_STATES = {"succeeded", "failed", "cancelled", "skipped"}


def _pg_dsn() -> str:
    return os.getenv(
        "DATABASE_URL",
        "postgresql+asyncpg://synodic:synodic@localhost:5432/synodic",
    ).replace("postgresql://", "postgresql+asyncpg://")


def _falkor_url() -> str:
    host = os.getenv("FALKORDB_HOST", "localhost")
    port = os.getenv("FALKORDB_PORT", "6379")
    return f"redis://{host}:{port}"


async def _list_data_sources(only: Optional[List[str]]) -> List[Tuple[str, str, str]]:
    engine = create_async_engine(_pg_dsn())
    try:
        async with engine.connect() as conn:
            rows = (await conn.execute(text(
                "SELECT id, workspace_id, graph_name FROM workspace_data_sources "
                "WHERE is_active IS NOT FALSE AND graph_name IS NOT NULL"
            ))).all()
    finally:
        await engine.dispose()
    out = [(r[0], r[1], r[2]) for r in rows]
    if only:
        keep = set(only)
        out = [r for r in out if r[0] in keep]
    return out


async def _graph_state(r: aioredis.Redis, graph: str) -> Tuple[Optional[dict], int, int]:
    """(meta properties or None, cell count, depth-null count)."""
    async def q(cypher: str):
        res = await r.execute_command("GRAPH.RO_QUERY", graph, cypher, "--compact")
        return res

    try:
        meta_res = await r.execute_command(
            "GRAPH.RO_QUERY", graph,
            "MATCH (m:_AggMeta {id:'singleton'}) RETURN m.regime, m.stampVersion, m.lastMaterializedAt",
        )
        meta_rows = meta_res[1] if len(meta_res) > 1 else []
        meta = None
        if meta_rows:
            row = meta_rows[0]
            meta = {"regime": row[0], "stampVersion": row[1], "lastMaterializedAt": row[2]}
        count_res = await r.execute_command(
            "GRAPH.RO_QUERY", graph,
            "MATCH ()-[x:AGGREGATED]->() RETURN count(*), "
            "sum(CASE WHEN x.sourceDepth IS NULL THEN 1 ELSE 0 END)",
        )
        crow = count_res[1][0] if len(count_res) > 1 and count_res[1] else [0, 0]
        return meta, int(crow[0] or 0), int(crow[1] or 0)
    except Exception as exc:  # missing graph key etc.
        print(f"    state read failed ({exc}) — treating as empty")
        return None, 0, 0


async def _trigger_and_wait(client: httpx.AsyncClient, base: str, ds_id: str) -> str:
    resp = await client.post(
        f"{base}/aggregation/data-sources/{ds_id}/jobs",
        json={"triggerSource": "manual"},
        timeout=30.0,
    )
    if resp.status_code not in (200, 201, 202):
        return f"trigger failed: HTTP {resp.status_code} {resp.text[:200]}"
    job = resp.json()
    job_id = job.get("id") or job.get("jobId")
    if not job_id:
        return f"trigger returned no job id: {json.dumps(job)[:200]}"
    deadline = time.monotonic() + JOB_TIMEOUT_S
    while time.monotonic() < deadline:
        await asyncio.sleep(POLL_INTERVAL_S)
        jr = await client.get(
            f"{base}/aggregation/data-sources/{ds_id}/jobs/{job_id}", timeout=30.0,
        )
        if jr.status_code != 200:
            continue
        state = (jr.json().get("status") or "").lower()
        if state in TERMINAL_STATES:
            return state
    return "poll timeout"


async def main() -> int:
    # This script talks plain standalone Redis (FALKORDB_HOST/PORT). On a Sentinel
    # or Cluster instance it would only reach one node — a partial re-materialization
    # that looks like it succeeded. Fail fast instead.
    from backend.app.providers.falkordb_connection import assert_standalone_env

    assert_standalone_env("rematerialize_all_graphs.py")

    ap = argparse.ArgumentParser()
    ap.add_argument("--control-plane", default=os.getenv("AGG_CONTROL_PLANE", "http://localhost:8091"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--only", default=None, help="comma-separated data source ids")
    args = ap.parse_args()
    only = [x.strip() for x in args.only.split(",")] if args.only else None

    sources = await _list_data_sources(only)
    print(f"{len(sources)} active data sources")
    r = aioredis.from_url(_falkor_url(), decode_responses=True)
    results = {}
    try:
        async with httpx.AsyncClient() as client:
            for ds_id, ws_id, graph in sources:
                print(f"\n== {ds_id} ({graph}) ==")
                meta, cells, depth_null = await _graph_state(r, graph)
                print(f"    cells={cells} depthNull={depth_null} meta={meta}")
                if meta and int(meta.get("stampVersion") or 1) >= 2 and depth_null == 0:
                    results[ds_id] = "already-stamped"
                    print("    OK (already stampVersion>=2)")
                    continue
                if cells == 0 and meta is None:
                    results[ds_id] = "never-materialized (read-path self-heal covers it)"
                    print("    skip (no cells, no meta)")
                    continue
                if args.dry_run:
                    results[ds_id] = "WOULD re-materialize"
                    print("    dry-run: would trigger")
                    continue
                state = await _trigger_and_wait(client, args.control_plane, ds_id)
                if state != "succeeded":
                    results[ds_id] = f"job {state}"
                    print(f"    job ended: {state}")
                    continue
                meta2, cells2, depth_null2 = await _graph_state(r, graph)
                ok = meta2 and int(meta2.get("stampVersion") or 1) >= 2 and depth_null2 == 0
                results[ds_id] = "re-materialized OK" if ok else (
                    f"job succeeded but verify failed (meta={meta2}, depthNull={depth_null2})"
                )
                print(f"    {results[ds_id]} (cells={cells2})")
    finally:
        await r.aclose()

    print("\n==== summary ====")
    for ds_id, outcome in results.items():
        print(f"  {ds_id}: {outcome}")
    bad = [d for d, o in results.items() if "OK" not in o and "self-heal" not in o and "already" not in o and "WOULD" not in o]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
