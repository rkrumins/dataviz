"""Version-controlled transfers at 20k nodes + 20k edges, through the benchmark harness (plan P0.3).

Each scenario is a run of ``backend/scripts/bench_versioning.py`` — the real jobs, queued as their
routes queue them and claimed on a lease — so CI exercises the harness as well as the flows:

* a package of 20k + 20k (a third of the edges containment) is uploaded, inspected, imported into
  a draft of a new graph — every row new, no Merkle row on the draft — and published through a
  publish job, landing every change on main;
* the same kind of package seeds a new data source: FalkorDB ends up holding what Postgres holds;
* "enable version control" on a FalkorDB graph with 200 duplicated urns pauses before it copies
  anything, and once the collapse is decided completes with FalkorDB counted equal to Postgres
  and a clean verify after the next publish.

The budgets are sanity bounds — several times a local run — not the plan's targets, which are for
100k + 100k (``bench_versioning run … --check``); later phases tighten them.

Needs Postgres (``GRAPHVER_E2E=1``); the seed and the bootstrap also FalkorDB:
  GRAPHVER_E2E=1 RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
    python -m pytest -q tests/integration/test_versioning_scale_smoke.py
"""
import asyncio
import os

import pytest
from falkordb.asyncio import FalkorDB
from redis.asyncio import ConnectionPool

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db
from backend.scripts import bench_versioning as bench

pytestmark = [pytest.mark.skipif(not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 (Postgres)")]
falkor_live = pytest.mark.skipif(os.getenv("RUN_FALKOR_LIVE") != "1",
                                 reason="set RUN_FALKOR_LIVE=1 with FalkorDB reachable")

N = 20_000


@pytest.fixture(autouse=True)
def _shipped_widths(monkeypatch):
    """The scan widths the jobs ship with, whatever an earlier test in this process set them to
    (``test_bootstrap_job.py`` narrows them to 2 rows a window, and a seed's heads phase measured
    at those widths runs for minutes)."""
    from backend.app.services.versioning import config

    monkeypatch.setattr(config, "BOOTSTRAP_WINDOW", int(os.getenv("GRAPHVER_BOOTSTRAP_WINDOW", "50000")))
    monkeypatch.setattr(config, "BOOTSTRAP_SCAN_WIDTH",
                        int(os.getenv("GRAPHVER_BOOTSTRAP_SCAN_WIDTH", "100000")))
    monkeypatch.setattr(config, "BOOTSTRAP_BACKFILL_PAUSE_MS",
                        int(os.getenv("GRAPHVER_BOOTSTRAP_BACKFILL_PAUSE_MS", "200")))


@pytest.fixture
async def store(tmp_path):
    from backend.app.db.engine import close_db

    yield bench.counting_store(LocalFsObjectStore(tmp_path / "store"))
    await db.dispose_engine()
    await close_db()


@pytest.fixture
async def falkor():
    """A FalkorDB client factory on a pool of this test's own loop; its graphs are deleted after."""
    from backend.app.services.aggregation import redis_client
    from backend.app.services.aggregation.redis_client import close_redis

    try:
        await close_redis()
    except Exception:                              # a client of an earlier test's loop: forget it
        redis_client._client = None
    pool = ConnectionPool(host=os.getenv("FALKORDB_HOST", "localhost"),
                          port=int(os.getenv("FALKORDB_PORT", "6379")), max_connections=8)
    handle, made = FalkorDB(connection_pool=pool), set()

    def factory(name, _provider=None):
        made.add(name)
        return handle.select_graph(name)

    try:
        yield factory
    finally:
        for name in made:
            try:
                await handle.select_graph(name).delete()
            except Exception:                      # never created, or deleted by the run
                pass
        await pool.disconnect()
        await close_redis()


async def _package(tmp_path, store):
    path = str(tmp_path / "p.zip")
    made = await bench.gen_package(path, nodes=N, edges=N, containment=0.33)
    assert (made["nodes"], made["edges"]) == (N, N)
    inspected = await bench.run_inspect(package=path, store=store)
    assert inspected["status"] == "completed" and not inspected.get("error"), inspected
    return inspected["upload"]["key"]


def _within(result, **budgets):
    print(bench.markdown([result]))               # the 20k numbers, with ``pytest -s``
    for metric, limit in budgets.items():
        assert result["metrics"][metric] <= limit, (
            f"{result['run']}: {metric} {result['metrics'][metric]} over its budget of {limit}", result["probes"])


async def test_a_20k_package_imports_into_a_draft_and_publishes(tmp_path, store):
    upload = await _package(tmp_path, store)

    imported = await bench.run_import(upload_key=upload, store=store)
    assert imported["status"] == "completed", imported
    assert imported["tallies"]["new"] == 2 * N and imported["tallies"]["invalid"] == 0, imported["tallies"]
    assert imported["metrics"]["draft_merkle_rows"] == 0
    _within(imported, total_s=150)

    draft = imported["draft"]
    published = await bench.run_publish(graph_id=draft["graphId"], branch_id=draft["branchId"], store=store)
    assert published["status"] == "completed", published
    assert published["metrics"]["changes"] == 2 * N
    _within(published, total_s=90, lock_hold_s=60)


@falkor_live
async def test_a_20k_package_seeds_a_new_data_source(tmp_path, store, falkor):
    upload = await _package(tmp_path, store)

    seeded = await bench.run_seed(upload_key=upload, store=store, factory=falkor)
    assert seeded["status"] == "completed", seeded
    assert not seeded["failedChecks"], seeded["failedChecks"]
    assert seeded["metrics"]["falkor_eq_pg"] and seeded["metrics"]["pg"] == [N, N], seeded["metrics"]
    _within(seeded, total_s=120)


@falkor_live
async def test_enable_versioning_with_200_duplicates_pauses_then_completes(falkor):
    name = "gvt_smoke_" + os.urandom(4).hex()
    made = await bench.gen_falkor(falkor(name), nodes=N, edges=N, dupes=200, cross_label=0.5,
                                  string_synced=True)
    assert made["dupes"] == 200

    enabled = await asyncio.wait_for(bench.run_bootstrap(graph=name, factory=falkor), timeout=180)
    assert enabled["status"] == "completed", enabled
    assert enabled["duplicates"]["extraCopies"] == 200
    assert enabled["metrics"]["version_rows_at_pause"] == 0
    assert enabled["metrics"]["falkor_eq_pg"] and enabled["metrics"]["verify_clean"], enabled["metrics"]
    assert not enabled["failedChecks"], enabled["failedChecks"]
    _within(enabled, pause_s=30, after_decision_s=120)
