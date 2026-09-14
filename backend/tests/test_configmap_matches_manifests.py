"""A CONFIGMAP VALUE THAT DESCRIBES A MANIFEST HAS TO MATCH IT.

Some ConfigMap entries are not settings — they are the application's only way
to KNOW something about the deployment it cannot read for itself. Two of them
decide whether a safety guard gives the right answer:

* ``FALKORDB_CONTAINER_MEMORY_BYTES`` — the graph store container's memory
  limit. The sizing guard checks a raised ``QUERY_MEM_CAPACITY`` against it.
  Too high and it approves a ceiling the container cannot back, which turns a
  refused query into an OOM-killed pod.
* ``FALKORDB_SERVER_TIMEOUT_MAX_MS`` — the server's ``TIMEOUT_MAX``. The
  backend clamps every per-query timeout to it, and the server REJECTS a query
  asking for more, so a mismatch means queries that never run at all.

Neither has a runtime check: nothing compares them to the pods. If they drift
from the manifest, everything keeps working until the day it matters. So they
are compared here instead.
"""
import os
import re
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[2]
_GIB = 1024 ** 3


def _read(rel: str) -> str:
    path = _ROOT / rel
    assert path.exists(), f"{rel} is missing — has deploy/ been reorganised?"
    return path.read_text()


def _cm_value(text: str, key: str):
    found = re.search(rf'^\s*{key}: "([^"]+)"', text, re.M)
    return found.group(1) if found else None


def _falkordb_memory_limits(rel: str) -> set[int]:
    """Every FalkorDB container's memory LIMIT in a manifest, in bytes.

    Parsed as YAML rather than matched with a regex: these blocks carry long
    sizing comments between ``limits:`` and ``memory:``, and a pattern that
    happens to skip them today is a guard that silently finds nothing tomorrow.
    """
    import yaml

    found: set[int] = set()
    for doc in yaml.safe_load_all(_read(rel)):
        if not isinstance(doc, dict) or doc.get("kind") != "StatefulSet":
            continue
        spec = doc.get("spec", {}).get("template", {}).get("spec", {})
        for container in spec.get("containers", []) or []:
            limit = (container.get("resources", {}).get("limits", {}) or {}).get("memory")
            if isinstance(limit, str) and limit.endswith("Gi"):
                found.add(int(limit[:-2]) * _GIB)
    assert found, f"no StatefulSet container memory limit found in {rel}"
    return found


# ── the container limit the sizing guard checks against ──────────────────


def test_base_container_memory_matches_the_base_statefulset():
    cm = _cm_value(_read("deploy/k8s/base/configmaps/common-config.yaml"),
                   "FALKORDB_CONTAINER_MEMORY_BYTES")
    assert cm, (
        "FALKORDB_CONTAINER_MEMORY_BYTES is unset in common-config. The sizing "
        "guard then has no container limit to check a raised QUERY_MEM_CAPACITY "
        "against, and an operator has to type it by hand on every raise."
    )
    limits = _falkordb_memory_limits("deploy/k8s/base/infrastructure/falkordb/statefulset.yaml")
    assert len(limits) == 1, f"the base StatefulSet has several memory limits: {limits}"
    manifest = limits.pop()
    assert int(cm) == manifest, (
        f"common-config says the FalkorDB container has {int(cm) / _GIB:.0f}Gi; the base "
        f"StatefulSet gives it {manifest / _GIB:.0f}Gi. The guard believes the ConfigMap."
    )


def test_cluster_overlay_container_memory_matches_its_shards():
    cm = _cm_value(_read("deploy/k8s/overlays/production-cluster/patches/cluster-config.yaml"),
                   "FALKORDB_CONTAINER_MEMORY_BYTES")
    assert cm, (
        "the production-cluster overlay runs larger shards than the base, so it must "
        "override FALKORDB_CONTAINER_MEMORY_BYTES or the guard sizes against the base."
    )
    limits = _falkordb_memory_limits(
        "deploy/k8s/overlays/production-cluster/resources/falkordb-cluster-statefulsets.yaml")
    assert len(limits) == 1, f"the three shards no longer share one memory limit: {limits}"
    assert int(cm) == limits.pop(), (
        f"the overlay ConfigMap says {int(cm) / _GIB:.0f}Gi per shard; the shard "
        f"StatefulSets say otherwise."
    )


# ── the server timeout ceiling the backend clamps to ─────────────────────


@pytest.mark.parametrize("config,manifest,label", [
    ("deploy/k8s/base/configmaps/common-config.yaml",
     "deploy/k8s/base/infrastructure/falkordb/statefulset.yaml", "base"),
    ("deploy/k8s/overlays/production-cluster/patches/cluster-config.yaml",
     "deploy/k8s/overlays/production-cluster/resources/falkordb-cluster-statefulsets.yaml",
     "production-cluster"),
])
def test_server_timeout_max_matches_the_deployed_args(config, manifest, label):
    """Documented in FALKORDB_DEPLOYMENT.md as a MUST. The server rejects any
    query whose timeout exceeds its TIMEOUT_MAX, so if the backend clamps to a
    larger number the query never runs — the failure is total, not gradual."""
    declared = _cm_value(_read(config), "FALKORDB_SERVER_TIMEOUT_MAX_MS")
    assert declared, f"{label}: FALKORDB_SERVER_TIMEOUT_MAX_MS is unset"
    shipped = {int(m) for m in re.findall(r"TIMEOUT_MAX (\d+)", _read(manifest))}
    assert shipped, f"{label}: no TIMEOUT_MAX found in the manifest"
    assert len(shipped) == 1, f"{label}: shards disagree on TIMEOUT_MAX: {shipped}"
    assert int(declared) == shipped.pop(), (
        f"{label}: the backend clamps per-query timeouts to {declared}ms but the "
        f"server's TIMEOUT_MAX is different. Queries asking for more are REJECTED."
    )


# ── the cluster's promotion clock, told to the client ────────────────────


def test_the_cluster_overlay_tells_the_client_its_node_timeout():
    """Everything a client does about a failover is derived from
    ``FALKORDB_CLUSTER_NODE_TIMEOUT_MS`` — how long a write waits out a
    demotion before giving up, and the Retry-After a caller is handed. Nothing
    reads it off the server, and unset it falls back to 3s.

    Against a cluster that does not even DECLARE a failover for 15s, a 3s
    answer sends every compliant client back before there is anything to
    answer it, and a rebuild spends its whole park budget inside the window in
    which no promotion had yet happened — then fails, throwing away the
    extract and compute it had done. Raise both together or neither."""
    declared = _cm_value(
        _read("deploy/k8s/overlays/production-cluster/patches/cluster-config.yaml"),
        "FALKORDB_CLUSTER_NODE_TIMEOUT_MS",
    )
    assert declared, (
        "FALKORDB_CLUSTER_NODE_TIMEOUT_MS is unset, so the client assumes 3s "
        "against a cluster configured for far longer"
    )
    shipped = {int(m) for m in re.findall(
        r"--cluster-node-timeout (\d+)",
        _read("deploy/k8s/overlays/production-cluster/resources/"
              "falkordb-cluster-statefulsets.yaml"),
    )}
    assert shipped, "no --cluster-node-timeout found in the shard StatefulSets"
    assert len(shipped) == 1, f"shards disagree on --cluster-node-timeout: {shipped}"
    assert int(declared) == shipped.pop(), (
        f"the client is told the cluster promotes in {declared}ms, but the "
        f"shards are configured otherwise — every failover wait is derived "
        f"from the wrong number"
    )


# ── aggregation's share of a node's query threads ────────────────────────
#
# FALKORDB_ENDPOINT_WRITE_SLOTS and FALKORDB_ENDPOINT_READ_SLOTS are the
# CROSS-POD budget for one FalkorDB node, and their defaults live in
# admission.py where nothing can see the THREAD_COUNT they are a share of.
# The shipped pair used to sum to exactly the cluster overlay's THREAD_COUNT
# 6, so aggregation's own caps could take a master's entire query width —
# and the whole pipeline reads under read_from_master_only, so all six landed
# on the master. Everything else that must reach a master then queued behind
# MAX_QUEUED_QUERIES: the post-write settle window, index DDL, the governor's
# INFO, the probe lane's counts read, and any interactive read inside a
# settle window. The read slots exist to "leave threads for the readers
# rather than apologise to them"; at 6 of 6 they did neither.

_SLOT_HEADROOM = 2
"""Threads a node must keep outside aggregation's budget. Not spare capacity:
it is what the settle window, index DDL, the governor and the probe lane need
on the SAME master while a rebuild runs."""


@pytest.mark.parametrize("config,manifest,label", [
    ("deploy/k8s/base/configmaps/worker-config.yaml",
     "deploy/k8s/base/infrastructure/falkordb/statefulset.yaml", "base"),
    ("deploy/k8s/overlays/production-cluster/patches/worker-slots.yaml",
     "deploy/k8s/overlays/production-cluster/resources/falkordb-cluster-statefulsets.yaml",
     "production-cluster"),
])
def test_the_slot_budget_leaves_the_node_threads_to_answer_with(config, manifest, label):
    write = _cm_value(_read(config), "FALKORDB_ENDPOINT_WRITE_SLOTS")
    read = _cm_value(_read(config), "FALKORDB_ENDPOINT_READ_SLOTS")
    assert write and read, (
        f"{label}: the slot budget is unset, so the pods take admission.py's "
        f"defaults — which are sized for a different topology's THREAD_COUNT."
    )
    threads = {int(m) for m in re.findall(r"(?<!OMP_)\bTHREAD_COUNT (\d+)", _read(manifest))}
    assert len(threads) == 1, f"{label}: no single THREAD_COUNT in the manifest: {threads}"
    thread_count = threads.pop()
    assert int(write) + int(read) <= thread_count - _SLOT_HEADROOM, (
        f"{label}: aggregation may hold {write} + {read} = {int(write) + int(read)} of "
        f"this node's {thread_count} query threads, leaving "
        f"{thread_count - int(write) - int(read)} for everything else that has to "
        f"reach the master. Re-derive both numbers against THREAD_COUNT, or raise "
        f"THREAD_COUNT with the pod memory the sizing rule then needs."
    )
    assert int(read) > int(write), (
        f"{label}: scans are the bulk of a rebuild's work and each is short, so the "
        f"read limit is deliberately the larger one — too small a cap starves "
        f"rebuilds fleet-wide to protect threads that were never contended."
    )


# ── the per-node socket pool the ConfigMap states rather than inherits ───


def test_the_overlay_states_the_pool_size_the_code_derives():
    """``FALKORDB_POOL_SIZE`` is per NODE in cluster mode — redis-py gives each
    node its own pool — and its default is DERIVED
    (``PROVIDER_MAX_CONCURRENCY`` x 2 graphs + housekeeping), not a round
    number. The overlay states the result so the value is visible where an
    operator reads it, which means it can also go stale: if the derivation
    moves and the ConfigMap does not, the explicit value wins silently.

    Getting it too low is not a slow deployment, it is an outage-shaped one:
    the caller past the cap gets redis-py's ``MaxConnectionsError``, which
    subclasses redis ``ConnectionError``, so the circuit breaker reads local
    socket exhaustion as a sick downstream and opens for every shard.
    """
    from backend.app.providers.falkordb_connection import default_graph_pool_size

    stated = _cm_value(
        _read("deploy/k8s/overlays/production-cluster/patches/cluster-config.yaml"),
        "FALKORDB_POOL_SIZE",
    )
    assert stated, (
        "the production-cluster overlay no longer states FALKORDB_POOL_SIZE, so "
        "every process inherits a derived default that nothing in deploy/ records"
    )
    env = dict(os.environ)
    for name in ("FALKORDB_POOL_SIZE", "PROVIDER_MAX_CONCURRENCY"):
        os.environ.pop(name, None)
    try:
        derived = default_graph_pool_size()
    finally:
        os.environ.clear()
        os.environ.update(env)
    assert int(stated) == derived, (
        f"the overlay pins FALKORDB_POOL_SIZE={stated} but the code now derives "
        f"{derived}. An explicit ConfigMap value beats a new default silently — "
        f"re-derive the ConfigMap, or say in its comment why it differs."
    )

