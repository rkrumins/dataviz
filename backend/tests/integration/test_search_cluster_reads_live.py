"""Advanced Search on a Redis Cluster: its reads stay off the masters, and a
long one ends inside the cluster's failure detector.

A read holds its graph's read lock, and a write that arrives meanwhile waits
for it on the node's main thread — the node answers nothing until the read
ends. On a 3 masters x 2 replicas cluster (FalkorDB 4.18.11, a 15 s
``cluster-node-timeout``) a 25 s read on a master with a write 2 s in froze
that master for 22.6 s: it was failed over, and the write it had acknowledged
was lost.

Needs a real cluster with replicas (the sandbox has none, so it skips)::

    FALKORDB_TEST_MODE=cluster \\
    FALKORDB_TEST_CLUSTER_NODES=127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002 \\
    pytest backend/tests/integration/test_search_cluster_reads_live.py -v
"""
from __future__ import annotations

import asyncio
import os
import time
import uuid

import pytest
import pytest_asyncio

pytestmark = pytest.mark.integration

#: About 25 s on the 20,000 nodes below — far past a replica's share of a
#: 15 s window.
LONG = "MATCH (n:N) UNWIND range(1, 10300) AS x RETURN count(x)"


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
        host=host, port=port, graph_name=f"search_reads_{uuid.uuid4().hex[:8]}",
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


async def test_search_reads_never_reach_a_master(provider):
    from backend.app.providers.falkordb_provider import search_reads_on_replicas

    before = provider.read_routing_counters()
    with search_reads_on_replicas():
        for _ in range(12):
            await provider._ro_query("MATCH (n:N) RETURN count(n)", timeout=5.0)
    after = provider.read_routing_counters()
    assert after["masterReads"] == before["masterReads"]
    assert after["replicaReads"] - before["replicaReads"] == 12


async def test_a_long_search_read_ends_inside_the_window_and_the_master_keeps_writing(provider):
    from backend.app.providers.falkordb_provider import (
        search_reads_on_replicas,
        search_replica_ceiling_s,
    )

    ceiling = search_replica_ceiling_s()
    assert ceiling is not None
    started = time.monotonic()
    with search_reads_on_replicas():
        read = asyncio.ensure_future(provider._ro_query(LONG, timeout=45.0))
        await asyncio.sleep(2)
        wrote = time.monotonic()
        await provider._query("CREATE (:W {at: timestamp()})", timeout=5.0)
        wrote_in = time.monotonic() - wrote
        await asyncio.wait([read])
        stopped = read.exception()            # the server stops it at the ceiling
    assert "timed out" in str(stopped), f"the read ended with {stopped!r}"
    assert time.monotonic() - started < ceiling + 3
    assert wrote_in < 1.0, f"the master took {wrote_in:.1f}s to take a write"
    await asyncio.sleep(ceiling)              # what a flag would take to appear
    host, port = _nodes()[0]
    assert _flagged(host, port) == []
