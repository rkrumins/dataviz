"""A LOAD GENERATOR THAT MEASURES ITSELF REPORTS A PLAUSIBLE WRONG NUMBER.

`deploy/k8s/loadtest/` runs the harness distributed across cluster nodes. Three
of its properties are load-bearing, invisible at apply time, and fail by
producing a confident figure rather than an error — the worst failure mode a
capacity test has, because somebody sizes a cluster on it.

Guarded here for the same reason `test_configmap_matches_manifests.py` exists:
nothing at runtime compares a manifest to what the thing using it assumes.
"""
from pathlib import Path

import yaml

_LOADTEST = Path(__file__).resolve().parents[2] / "deploy" / "k8s" / "loadtest"


def _manifest(name: str) -> dict:
    path = _LOADTEST / name
    assert path.exists(), f"{name} is missing — has deploy/k8s/loadtest moved?"
    return yaml.safe_load(path.read_text())


def _env(container: dict) -> dict:
    return {e["name"]: e.get("value") for e in container.get("env", [])}


def test_the_master_waits_for_every_worker_it_will_get():
    """``LOCUST_EXPECT_WORKERS`` below the replica count and the ramp starts
    short-handed; above it and the run never starts at all. Either way the
    drift is silent — the pods are Running and the CSV looks like a result."""
    master = _manifest("master.yaml")
    worker = _manifest("worker.yaml")

    expect = _env(master["spec"]["template"]["spec"]["containers"][0])
    assert int(expect["LOCUST_EXPECT_WORKERS"]) == worker["spec"]["replicas"]


def test_two_workers_cannot_land_on_one_node():
    """They would share the node's CPU and its one NIC, so the run measures
    the generator. `required`, not `preferred`: a pod stuck Pending asks a
    question, a co-scheduled pair answers one wrongly."""
    spec = _manifest("worker.yaml")["spec"]["template"]["spec"]
    rules = spec["affinity"]["podAntiAffinity"][
        "requiredDuringSchedulingIgnoredDuringExecution"
    ]
    own_label = {"app.kubernetes.io/name": "loadtest-worker"}
    assert any(
        r["labelSelector"].get("matchLabels") == own_label
        and r["topologyKey"] == "kubernetes.io/hostname"
        for r in rules
    ), "the worker must be anti-affine to itself, per hostname, and required"


def test_the_generator_is_not_part_of_a_normal_deploy():
    """One applied by accident is indistinguishable from an attack."""
    base = (_LOADTEST / ".." / "base" / "kustomization.yaml").resolve().read_text()
    assert "loadtest" not in base, (
        "deploy/k8s/loadtest must stay out of base/kustomization.yaml — "
        "it is applied explicitly, for the duration of a run"
    )
