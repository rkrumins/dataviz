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
