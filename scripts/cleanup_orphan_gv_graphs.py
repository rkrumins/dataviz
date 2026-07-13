"""Drop orphan/test FalkorDB keys created by the versioning projection, and unpin their rows.

Versioned graphs created without a real FalkorDB target (integration-test graphs, or graphs
auto-created before the data source's ``graph_name`` was injected) used to be projected into
synthetic keys nothing reads — ``gv_<graph_id>``, fork variants ``gv_<parent>__fork_<id>``,
and test-pinned ``gvt_*``/``gvtest_*`` names — leaking one FalkorDB graph per test run. The
projector no longer touches unpinned graphs (projection.py) and forks of unpinned parents stay
unpinned (service.py), so any such key is a leftover; this script removes them and resets the
affected projection rows to NULL (= unpinned, excluded from the worker's poll).

Safety rules — a key is dropped ONLY if all of:
  * its name is synthetic: exactly ``gv_<graph_id>`` for a graphver row, a ``gv_*__fork_*``
    fork of a synthetic parent, a ``gvt_*``/``gvtest_*`` test pin, a ``gv_graph_*`` key
    whose graph row no longer exists, or a ``blank_*`` key (only ever minted by the
    blank-model provisioning) whose data source no longer claims it;
  * no management-DB data source uses that name as its real ``graph_name``;
  * no projection row pins a DIFFERENT graph to it with a non-synthetic claim;
  * it is EMPTY (0 nodes), unless ``--force`` is given (test keys hold a handful of rows,
    so ``--force`` is expected for a full sweep; non-empty keys are listed either way).

Run inside the backend container:
  cd /app && PYTHONPATH=/app python scripts/cleanup_orphan_gv_graphs.py [--dry-run] [--force]
"""
from __future__ import annotations

import asyncio
import os
import re
import sys

from sqlalchemy import select

from backend.app.services.versioning import db as gvdb
from backend.app.services.versioning.models import GraphORM, ProjectionStateORM

_TEST_PIN = re.compile(r"^(gvt_|gvtest_)")
_SYNTH_FORK = re.compile(r"^gv_.*__fork_")


def _synthetic(name: str, gid: str | None = None) -> bool:
    """A name no real reader can be pointed at: the graph's own gv_ fallback, a fork of a
    synthetic parent, a test pin, or (for keys) any gv_graph_* whose row is unknown.
    NOTE: ``blank_*`` mints are deliberately NOT synthetic here — this predicate also
    drives pin protection/unpinning, and live blank models pin their real key. Orphan
    ``blank_*`` KEYS are swept via the key-candidacy check in main() instead."""
    if _TEST_PIN.match(name) or _SYNTH_FORK.match(name):
        return True
    if gid is not None:
        return name == f"gv_{gid}"
    return name.startswith("gv_graph_")


async def _falkor_handle():
    from redis.asyncio import ConnectionPool
    from falkordb.asyncio import FalkorDB

    pool = ConnectionPool(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        max_connections=int(os.getenv("FALKORDB_POOL_SIZE", "10")),
    )
    # Speaks PLAIN standalone Redis: against a Cluster this reaches only the slots
    # of one node and against Sentinel it can land on a demoted replica — a wipe or
    # GRAPH.DELETE would half-apply and a reindex would silently skip shards.
    from backend.app.providers.falkordb_connection import assert_standalone_env
    assert_standalone_env("cleanup_orphan_gv_graphs.py")
    return FalkorDB(connection_pool=pool)


async def _data_source_graph_names() -> set:
    """Real graph names the canvas reads — never droppable, whatever they look like."""
    try:
        from backend.app.db.engine import get_async_session
        from sqlalchemy import text
    except Exception:
        return set()
    names: set = set()
    for sql in (
        "SELECT graph_name FROM workspace_data_sources",
        "SELECT dedicated_graph_name FROM workspace_data_sources",
        "SELECT graph_name FROM graph_connections",
        "SELECT falkordb_graph_name FROM graph_connections",
    ):
        try:
            async with get_async_session() as s:
                names |= {r for r in (await s.execute(text(sql))).scalars().all() if r}
        except Exception:                            # per-deployment schema drift — best effort
            continue
    return names


async def main() -> int:
    dry = "--dry-run" in sys.argv
    force = "--force" in sys.argv

    async with gvdb.graphver_session() as s:
        graph_ids = set((await s.execute(select(GraphORM.id))).scalars().all())
        pins = dict((await s.execute(
            select(ProjectionStateORM.graph_id, ProjectionStateORM.falkor_graph_name))).all())
    ds_names = await _data_source_graph_names()
    # Names pinned by a live row for a REAL (non-synthetic) purpose are protected.
    protected = ds_names | {p for g, p in pins.items() if p and not _synthetic(p, g)}

    handle = await _falkor_handle()
    existing = {k.decode() if isinstance(k, bytes) else k for k in await handle.list_graphs()}

    dropped, skipped_nonempty, kept = [], [], []
    for key in sorted(existing):
        gid = key[3:] if key.startswith("gv_") and "__fork_" not in key else None
        # blank_* keys are only ever minted by blank-model provisioning; one no
        # data source claims (the protected set) is an orphan (e.g. a compensated
        # provisioning, a deleted model, or a FalkorDB-snapshot zombie).
        is_candidate = (_synthetic(key, gid if gid in graph_ids else None)
                        or key.startswith("blank_"))
        if not is_candidate or key in protected:
            if key.startswith(("gv_", "gvt", "blank_")):
                kept.append(key)
            continue
        g = handle.select_graph(key)
        nodes = (await g.query("MATCH (n) RETURN count(n)")).result_set[0][0]
        if nodes and not force:
            skipped_nonempty.append((key, nodes))
            continue
        if not dry:
            await g.delete()
        dropped.append(key)

    # Unpin every row whose pin is synthetic, so the projection worker's poll (which skips
    # unpinned rows) never re-materialises these keys.
    to_unpin = [g for g, p in pins.items() if p and _synthetic(p, g)]
    if to_unpin and not dry:
        async with gvdb.graphver_session() as s:
            for gid in to_unpin:
                ps = await s.get(ProjectionStateORM, gid)
                if ps is not None and ps.falkor_graph_name and _synthetic(ps.falkor_graph_name, gid):
                    ps.falkor_graph_name = None

    verb = "would drop" if dry else "dropped"
    print(f"{verb} {len(dropped)} synthetic graph key(s); "
          f"unpinned {len(to_unpin)} projection row(s); kept {len(kept)}")
    for key, n in skipped_nonempty:
        print(f"  SKIPPED (non-empty, {n} nodes — rerun with --force to drop): {key}")
    if kept:
        for key in kept[:10]:
            print(f"  kept (protected/real): {key}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
