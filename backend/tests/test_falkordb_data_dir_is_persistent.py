"""THE FALKORDB DATA DIRECTORY HAS TO BE ON THE CLAIM.

The image runs ``redis-server ${REDIS_ARGS} ... --dir /var/lib/falkordb/data``
(``FALKORDB_DATA_PATH``, passed AFTER ``REDIS_ARGS``, so nothing in our args can
move it) and ``/data`` holds only a symlink into that directory. For months the
k8s manifests mounted the claim at ``/data``: it held ``nodes.conf`` and nothing
else, while the RDB, the appendonlydir and every temp file lived in the
container's writable layer on the node boot disk. On a 15 GB shard that layer
reached ~75 GB when a BGSAVE or AOF rewrite met a large incr, the kubelet hit
DiskPressure and evicted the pod — recreated with RESTARTS 0, no previous log and
an empty data dir, so it came back as a replica and full-synced for an hour,
writing the temp RDB to the same disk. That is the "pods bounce at 90 % of the
load and the restart count never goes up" incident.

The settings beside the mount are what let a shard survive the hour a load
takes: an evicted pod must be recreated while its sibling is still loading, a
replaying pod must not be killed for answering -LOADING, a rotation must be
operator-paced because a fresh replica is Ready (PONG) during the RDB transfer,
and a drain must not run a blocking 15 GB SAVE into the SIGKILL at the end of
the grace period.

Parsed from the YAML, not grepped — a path inside a comment is not a mount.
"""
from __future__ import annotations

from pathlib import Path

import pytest
import yaml

_ROOT = Path(__file__).resolve().parents[2]
_CLUSTER = _ROOT / "deploy/k8s/overlays/production-cluster/resources/falkordb-cluster-statefulsets.yaml"
_BASE = _ROOT / "deploy/k8s/base/infrastructure/falkordb/statefulset.yaml"
_COMPOSE = _ROOT / "docker-compose.yml"
_HELM = _ROOT / "deploy/helm/dataviz/templates/stores-falkordb.yaml"

DATA_DIR = "/var/lib/falkordb/data"


def _statefulsets(path: Path) -> list[dict]:
    return [d for d in yaml.safe_load_all(path.read_text())
            if d and d.get("kind") == "StatefulSet"]


def _falkordb_container(doc: dict) -> dict:
    containers = doc["spec"]["template"]["spec"]["containers"]
    return next(c for c in containers if c["name"] == "falkordb")


def _redis_args(container: dict) -> list[str]:
    for env in container.get("env") or []:
        if env.get("name") == "REDIS_ARGS":
            return str(env.get("value") or "").split()
    return []


def _tokens_after(args: list[str], flag: str) -> list[str]:
    """The values following ``flag``, up to the next ``--flag``."""
    if flag not in args:
        return []
    out = []
    for token in args[args.index(flag) + 1:]:
        if token.startswith("--"):
            break
        out.append(token)
    return out


_CLUSTER_DOCS = _statefulsets(_CLUSTER)
_BASE_DOC = _statefulsets(_BASE)[0]
_EVERY = [("base", _BASE_DOC)] + [(d["metadata"]["name"], d) for d in _CLUSTER_DOCS]
_SHARDS = [(d["metadata"]["name"], d) for d in _CLUSTER_DOCS]


def test_the_three_shard_blocks_are_actually_three():
    assert len(_CLUSTER_DOCS) == 3


@pytest.mark.parametrize("label,doc", _EVERY, ids=[label for label, _ in _EVERY])
def test_the_claim_is_mounted_at_the_image_data_dir(label, doc):
    """Mounted anywhere else, the dataset lives in the container's writable
    layer: gone on every recreation, and the node disk's problem until then."""
    claims = [t["metadata"]["name"] for t in doc["spec"]["volumeClaimTemplates"]]
    assert len(claims) == 1, f"{label}: expected one claim, found {claims}"
    mounts = {m["name"]: m["mountPath"] for m in _falkordb_container(doc)["volumeMounts"]}
    assert mounts.get(claims[0]) == DATA_DIR, (
        f"{label}: the claim is mounted at {mounts.get(claims[0])!r}; the image's "
        f"redis-server --dir is {DATA_DIR} and REDIS_ARGS cannot move it"
    )


@pytest.mark.parametrize("label,doc", _SHARDS, ids=[label for label, _ in _SHARDS])
def test_the_cluster_config_file_lives_on_the_claim(label, doc):
    """nodes.conf is the node's identity. Beside the data, on the claim —
    and no --dir in our args, which run.sh would silently override anyway."""
    args = _redis_args(_falkordb_container(doc))
    assert _tokens_after(args, "--cluster-config-file") == [f"{DATA_DIR}/nodes.conf"]
    assert "--dir" not in args


def test_compose_and_helm_agree_on_the_path():
    assert f"falkordb_data:{DATA_DIR}" in _COMPOSE.read_text()
    assert f"mountPath: {DATA_DIR}" in _HELM.read_text()


@pytest.mark.parametrize("label,doc", _SHARDS, ids=[label for label, _ in _SHARDS])
def test_an_evicted_pod_is_recreated_while_its_sibling_still_loads(label, doc):
    """OrderedReady stops at the first ordinal that is not Running+Ready, so
    with -0 replaying for an hour a Failed -1 is not even looked at."""
    assert doc["spec"].get("podManagementPolicy") == "Parallel"


@pytest.mark.parametrize("label,doc", _SHARDS, ids=[label for label, _ in _SHARDS])
def test_rotations_are_operator_paced(label, doc):
    """A fresh replica answers PONG during the RDB transfer and only then
    -LOADING; a RollingUpdate reads that PONG as done and deletes the master."""
    assert (doc["spec"].get("updateStrategy") or {}).get("type") == "OnDelete"


@pytest.mark.parametrize("label,doc", _SHARDS, ids=[label for label, _ in _SHARDS])
def test_shutdown_does_not_block_on_a_save(label, doc):
    """With save points set, SIGTERM runs a BLOCKING SAVE of the whole shard
    by default — longer than the grace period on 15 GB, so it was SIGKILLed
    mid-save. The AOF is fsynced first either way."""
    args = _redis_args(_falkordb_container(doc))
    assert _tokens_after(args, "--shutdown-on-sigterm") == ["nosave"]
    timeout = _tokens_after(args, "--shutdown-timeout")
    grace = int(doc["spec"]["template"]["spec"]["terminationGracePeriodSeconds"])
    assert timeout and int(timeout[0]) <= grace - 30, (
        f"{label}: shutdown-timeout {timeout} must leave the final fsync room "
        f"inside terminationGracePeriodSeconds {grace}"
    )
    # The replica loads from its claim; the master's fork child must live for
    # the transfer (minutes), not for the hour an on-empty-db parse would take.
    assert _tokens_after(args, "--repl-diskless-load") == ["disabled"]


@pytest.mark.parametrize("label,doc", _SHARDS, ids=[label for label, _ in _SHARDS])
def test_a_replay_is_not_killed_before_it_answers(label, doc):
    """Startup holds liveness off through the whole AOF replay (PONG only, so
    it does not pass early); liveness still tolerates the -LOADING a replica
    answers while it loads a full sync after startup; readiness never does."""
    c = _falkordb_container(doc)
    startup = c["startupProbe"]
    cmd = " ".join(startup["exec"]["command"])
    assert "PONG" in cmd and "LOADING" not in cmd
    assert startup["periodSeconds"] * startup["failureThreshold"] >= 3 * 3600, (
        f"{label}: the startup window must cover a multi-hour replay"
    )
    assert "LOADING" in " ".join(c["livenessProbe"]["exec"]["command"])
    assert "LOADING" not in " ".join(c["readinessProbe"]["exec"]["command"])


@pytest.mark.parametrize("label,doc", _SHARDS, ids=[label for label, _ in _SHARDS])
def test_the_node_disk_is_not_a_data_dir(label, doc):
    """If anything lands in the writable layer again, THIS pod is evicted
    with a named reason instead of the node reaching DiskPressure."""
    limits = _falkordb_container(doc)["resources"]["limits"]
    assert "ephemeral-storage" in limits
