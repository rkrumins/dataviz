"""On a Redis Cluster no read runs on a master past the window's write share:
one the master stops there runs again on a replica with its whole budget.

A read holds its graph's read lock, and a write that arrives meanwhile waits
for it on the node's main thread — the node answers nothing until the read
ends. Canvas reads with budgets of 30-60 s, landing on the master by its
turn or by the read-your-own-writes pin, froze a master for 28-49 s under a
write a second and got it failed over.

Needs a real cluster with replicas (the sandbox has none, so it skips)::

    FALKORDB_TEST_MODE=cluster \\
    FALKORDB_TEST_CLUSTER_NODES=127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002 \\
    pytest backend/tests/integration/test_master_read_cap_live.py -v
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid

import pytest
import pytest_asyncio

pytestmark = pytest.mark.integration

#: About 11 s on the 20,000 nodes below on one core: past a master's share of
#: a 15 s window (6 s), inside the 30 s a canvas read is given.
SLOW = "MATCH (n:N) UNWIND range(1, 4000) AS x RETURN count(x)"


def _nodes() -> list:
    out = []
    for chunk in os.getenv("FALKORDB_TEST_CLUSTER_NODES", "").split(","):
        host, _, port = chunk.strip().rpartition(":")
        if host:
            out.append([host, int(port)])
    return out


@pytest_asyncio.fixture
async def provider():
    if os.getenv("FALKORDB_TEST_MODE", "").strip().lower() != "cluster" or not _nodes():
        pytest.skip("Set FALKORDB_TEST_MODE=cluster and FALKORDB_TEST_CLUSTER_NODES")
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    host, port = _nodes()[0]
    p = FalkorDBProvider(
        host=host, port=port, graph_name=f"master_cap_{uuid.uuid4().hex[:8]}",
        password=os.getenv("FALKORDB_TEST_PASSWORD"), auto_reconcile=False,
        connection_config={"mode": "cluster", "cluster": {"startupNodes": _nodes()}},
    )
    await p._ensure_connected()
    await p._query("UNWIND range(1, 20000) AS i CREATE (:N {i: i})", timeout=30.0)
    await asyncio.sleep(2)                    # the replicas apply it
    yield p
    try:
        await p._graph.delete()
        await p.close()
    except Exception:                         # noqa: BLE001 — cleanup only
        pass


def _flagged(host: str, port: int) -> list:
    import redis
    raw = redis.Redis(host=host, port=port, password=os.getenv("FALKORDB_TEST_PASSWORD"),
                      socket_timeout=5).execute_command("CLUSTER", "NODES").decode()
    return [line for line in raw.splitlines() if "fail" in line.split()[2]]


async def test_a_slow_read_pinned_to_the_master_finishes_on_a_replica(provider):
    """A write a moment ago pins this graph's reads to the master. The slow
    read gets the master's share there, then the replica finishes it — and a
    write that arrives meanwhile waits for the share, not for the read."""
    from backend.app.providers.falkordb_provider import cluster_write_ceiling_s

    cap = cluster_write_ceiling_s()
    assert cap is not None
    provider._note_local_write()
    before = provider.read_routing_counters()["cappedOnMaster"]
    started = time.monotonic()
    read = asyncio.ensure_future(provider._ro_query(SLOW, timeout=30.0, op="slow.view"))
    await asyncio.sleep(2)
    wrote = time.monotonic()
    await provider._query("CREATE (:W {at: timestamp()})", timeout=5.0)
    wrote_in = time.monotonic() - wrote
    result = await read
    took = time.monotonic() - started

    assert result.result_set[0][0] == 20000 * 4000
    assert provider.read_routing_counters()["cappedOnMaster"] == before + 1
    assert took > cap, "the master answered a read past its share"
    assert wrote_in < cap, f"a write waited {wrote_in:.1f}s behind a read on the master"
    await asyncio.sleep(cap)                  # what a flag would take to appear
    host, port = _nodes()[0]
    assert _flagged(host, port) == []


async def test_a_read_pinned_to_a_node_that_moved_on_does_not_run_on_the_master(provider):
    """A replica that has moved to another shard answers MOVED. The read comes
    back to the router, which benches it — it does not run on the master with
    the budget it was given for a replica."""
    from redis.exceptions import MovedError

    conn = provider._db.connection
    owners = conn.nodes_manager.slots_cache[conn.keyslot(provider._graph_name)]
    moved_on = next(n for n in conn.get_replicas() if n not in owners)
    with pytest.raises(MovedError):
        await provider._pinned_to(provider._graph, moved_on).ro_query("RETURN 1")
