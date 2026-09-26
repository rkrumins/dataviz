"""THE MEMORY GUARD'S FALLBACK HAS TO MATCH WHAT WE ACTUALLY SHIP.

``THREAD_COUNT_ASSUMED`` is what the graph-store limits guard plans with when
a node does not report its own THREAD_COUNT. It sizes
``container_memory_needed(maxmemory, concurrent, query_mem_capacity)`` — the
container memory the node needs to run that many queries concurrently, each
allowed its per-query ceiling.

The two directions of error are not symmetric:

* Too HIGH refuses a config that would have fitted. Conservative, visible, and
  the operator sees every number in the refusal.
* Too LOW approves a config that OOM-kills the node under exactly the
  concurrency it was raised to serve.

It shipped as 4 while the manifests said 8 — a silent under-booking by half,
in a file that merges cleanly, so nothing would have flagged it.
"""
import re
from pathlib import Path

import pytest

from backend.app.services.aggregation.graph_store_limits import THREAD_COUNT_ASSUMED

_ROOT = Path(__file__).resolve().parents[2]

#: Files carrying a FalkorDB launch-args string. A new shipped topology that
#: is not listed here is not covered — keep this in step with deploy/.
_SHIPPED = [
    "deploy/k8s/base/infrastructure/falkordb/statefulset.yaml",
    "deploy/k8s/overlays/production-cluster/resources/falkordb-cluster-statefulsets.yaml",
    "deploy/helm/dataviz/values.yaml",
    "docker-compose.yml",
]

# THREAD_COUNT, but never the OMP_THREAD_COUNT that precedes it in every args
# string — that one is deliberately 1 and is a different setting entirely.
_THREADS = re.compile(r"(?<!OMP_)\bTHREAD_COUNT (\d+)")


def _shipped_thread_counts():
    found = {}
    for rel in _SHIPPED:
        path = _ROOT / rel
        if not path.exists():
            continue
        values = [int(m) for m in _THREADS.findall(path.read_text())]
        if values:
            found[rel] = values
    return found


def test_the_manifests_are_where_we_think_they_are():
    """If this fails the guard below is vacuously true, which is worse than a
    wrong number: it is a wrong number nobody is checking."""
    found = _shipped_thread_counts()
    missing = [rel for rel in _SHIPPED if rel not in found]
    assert not missing, f"no THREAD_COUNT found in {missing} — has deploy/ moved?"


def test_the_assumption_is_never_below_what_we_ship():
    """The property that matters. Under-booking is the direction that OOMs."""
    found = _shipped_thread_counts()
    highest = max(v for values in found.values() for v in values)
    assert THREAD_COUNT_ASSUMED >= highest, (
        f"THREAD_COUNT_ASSUMED is {THREAD_COUNT_ASSUMED} but the manifests ship "
        f"up to {highest} ({found}). An unreporting node would be planned for "
        f"{THREAD_COUNT_ASSUMED} concurrent queries and run {highest}, so the "
        f"container memory guard under-books and approves a config that "
        f"OOM-kills the node."
    )


def test_omp_thread_count_is_not_mistaken_for_thread_count():
    """Both appear in the same args string and OMP_THREAD_COUNT is 1. A
    matcher that caught it would make the guard above read 'we ship 1' and
    pass no matter how wrong the assumption got."""
    assert _THREADS.findall("THREAD_COUNT 8 OMP_THREAD_COUNT 1") == ["8"]
    assert _THREADS.findall("OMP_THREAD_COUNT 1") == []


@pytest.mark.parametrize("shipped,assumed,safe", [
    (8, 8, True),    # exactly what we ship
    (8, 16, True),   # over-booked: refuses more than it must, never OOMs
    (8, 4, False),   # the bug this file exists for
])
def test_the_direction_of_safety_is_stated(shipped, assumed, safe):
    """Pins the asymmetry itself, so the next person to touch the number knows
    which way is dangerous without re-deriving it."""
    assert (assumed >= shipped) is safe


# ── the container-memory guard counts replication ────────────────────────
#
# container_memory_needed() used to implement the single-instance rule only —
#   1.25 x maxmemory + concurrent x 1.3 x QUERY_MEM_CAPACITY + overhead
# — with no input for the replication backlog or the per-replica output
# buffers. On the cluster overlay that gap is ~5 GiB, enough to flip a
# THREAD_COUNT decision: the guard approved 8 threads on a 56Gi shard that the
# manifest's own budget refused, and docs/CONCURRENCY_TUNING.md §5 told
# operators to do the arithmetic by hand. It takes both terms now. This pins
# that the guard and the overlay's stated budget agree, and that the decision
# flips with them — the direction this file exists to protect.


def test_the_container_guard_counts_replication():
    from backend.app.providers.shard_capacity import container_memory_needed

    GIB = 1024 ** 3
    maxmemory, cap, threads = 32 * GIB, 1 * GIB, 8
    single = container_memory_needed(maxmemory, threads, cap)
    full = container_memory_needed(
        maxmemory, threads, cap,
        repl_backlog_bytes=1 * GIB, replicas=2, replica_outbuf_hard_bytes=2 * GIB,
    )
    assert full - single == 1 * GIB + 2 * (2 * GIB)

    shard_limit = 56 * GIB
    assert single < shard_limit < full, (
        "8 threads on a 56Gi shard: the single-instance rule approves and the full "
        "budget refuses. That flip is what the replication terms exist for; if this "
        "now fits, the shard sizing changed and docs/CONCURRENCY_TUNING.md §5 needs "
        "its table redone."
    )
