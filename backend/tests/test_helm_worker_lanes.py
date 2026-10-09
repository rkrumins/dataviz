"""Every deploy target runs the versioning worker's three lanes.

The API only QUEUES import, export, publish and "Enable version control" jobs:
``GRAPHVER_TRANSFER_INPROCESS`` is gone and nothing in the web tier runs them.
So a target that ships without a lane fails nothing. Its jobs just wait, and
without the transfer lane nothing even times them out, because the JobReaper
runs on that lane too. Nothing at runtime turns red, so it is asserted here,
for Helm, the k8s base and compose.

A lane also has to see what the web tier sees. viz-service stores an upload,
and a lane reads it back to run the job, so both must resolve the same object
store and the same database. Helm guarantees that structurally, because every
lane reads the one ConfigMap and Secret viz-service reads; the checks below
hold it to that.

Helm is rendered with ``helm template`` when helm is installed. Without it the
template is checked as text: balanced actions, the lane list, and the shared
env sources.
"""
from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest
import yaml

from backend.app.services.versioning import config

_ROOT = Path(__file__).resolve().parents[2]
_CHART = _ROOT / "deploy" / "helm" / "dataviz"
_TEMPLATE = _CHART / "templates" / "versioning-worker.yaml"
_K8S = _ROOT / "deploy" / "k8s" / "base"
_LANES = set(config.LANES)
# Where a lane would get its own copy of what must match the web tier.
_SHARED_ENV = re.compile(r"^(OBJECT_STORE_|IMPORT_STORE_ROOT$|MANAGEMENT_DB_URL$|GRAPHVER_DB_URL$)")


def _lanes_of(raw: str, monkeypatch) -> frozenset:
    """Parse a GRAPHVER_WORKER_LANES value the way the worker does (it raises on a typo)."""
    monkeypatch.setenv("GRAPHVER_WORKER_LANES", raw)
    return config.worker_lanes()


def _env(container: dict) -> dict:
    return {e["name"]: e.get("value") for e in container.get("env", [])}


def _lane_deployments(docs: list[dict]) -> dict[str, dict]:
    """{lane: Deployment} for every Deployment whose pods carry synodic.io/lane."""
    out = {}
    for d in docs:
        if d.get("kind") != "Deployment":
            continue
        lane = d["spec"]["template"]["metadata"]["labels"].get("synodic.io/lane")
        if lane:
            assert lane not in out, f"two Deployments run the {lane} lane"
            out[lane] = d
    return out


def _assert_lanes(deployments: dict[str, dict], monkeypatch) -> None:
    assert set(deployments) == _LANES, f"lanes deployed: {sorted(deployments)}"
    for lane, d in deployments.items():
        pod = d["spec"]["template"]["spec"]
        (container,) = pod["containers"]
        env = _env(container)
        assert container["command"] == ["python", "-m", "backend.app.services.versioning"]
        assert _lanes_of(env["GRAPHVER_WORKER_LANES"], monkeypatch) == {lane}
        # The drain has to finish before the SIGKILL.
        assert pod["terminationGracePeriodSeconds"] > config.DRAIN_SECS
        # Spools land on a bounded emptyDir, not the node's root disk.
        mounts = {m["mountPath"]: m["name"] for m in container["volumeMounts"]}
        spool = next(v for v in pod["volumes"] if v["name"] == mounts[env["TMPDIR"]])
        assert spool["emptyDir"]["sizeLimit"]
        # Each Deployment selects only its own lane's pods.
        selector = d["spec"]["selector"]["matchLabels"]
        for other, o in deployments.items():
            labels = o["spec"]["template"]["metadata"]["labels"]
            matches = all(labels.get(k) == v for k, v in selector.items())
            assert matches == (other == lane), f"{d['metadata']['name']} selects {other} pods"
    # Apart from the lane, every lane runs the same environment.
    envs = [{k: v for k, v in _env(d["spec"]["template"]["spec"]["containers"][0]).items()
             if k != "GRAPHVER_WORKER_LANES"} for d in deployments.values()]
    assert all(e == envs[0] for e in envs), envs


def _transfer_hpa(docs: list[dict], deployments: dict[str, dict]) -> dict:
    name = deployments["transfer"]["metadata"]["name"]
    (hpa,) = [d for d in docs if d.get("kind") == "HorizontalPodAutoscaler"
              and d["spec"]["scaleTargetRef"]["name"] == name]
    assert (hpa["spec"]["minReplicas"], hpa["spec"]["maxReplicas"]) == (2, 8)
    assert hpa["spec"]["metrics"][0]["resource"]["target"]["averageUtilization"] == 70
    assert hpa["spec"]["behavior"]["scaleDown"]["stabilizationWindowSeconds"] == 900
    return hpa


# --------------------------------------------------------------------------- #
# Helm                                                                         #
# --------------------------------------------------------------------------- #
@pytest.mark.skipif(shutil.which("helm") is None, reason="helm is not installed")
def test_helm_renders_the_three_lanes_with_the_web_tiers_env(monkeypatch):
    rendered = subprocess.run(
        ["helm", "template", "dataviz", str(_CHART), "--set", "networkPolicy.enabled=true"],
        check=True, capture_output=True, text=True, timeout=120).stdout
    docs = [d for d in yaml.safe_load_all(rendered) if d]
    deployments = _lane_deployments(docs)
    _assert_lanes(deployments, monkeypatch)
    _transfer_hpa(docs, deployments)
    assert "replicas" not in deployments["transfer"]["spec"], "the HPA owns the transfer replicas"

    viz = next(d for d in docs if d.get("kind") == "Deployment"
               and d["metadata"]["name"] == "viz-service")["spec"]["template"]["spec"]["containers"][0]
    for lane, d in deployments.items():
        pod = d["spec"]["template"]["spec"]
        (container,) = pod["containers"]
        assert container["envFrom"] == viz["envFrom"], f"{lane} reads other config than viz-service"
        assert _env(container)["SYNODIC_ROLE"] == "worker"
        assert not [k for k in _env(container) if _SHARED_ENV.match(k)], (
            f"{lane} overrides store/database env viz-service gets from the shared ConfigMap")
        assert [i["name"] for i in pod["initContainers"]] == ["wait-for-schema"]

    data = next(d for d in docs if d.get("kind") == "ConfigMap"
                and d["metadata"]["name"] == "dataviz-config")["data"]
    assert data["GRAPHVER_PROJECTION_INPROCESS"] == "0"
    assert data["OBJECT_STORE_BACKEND"] == "database"

    # The default-deny policy admits the lanes to every store they use.
    admitted = {p["metadata"]["name"] for p in docs if p.get("kind") == "NetworkPolicy"
                for rule in p["spec"].get("ingress", []) for f in rule.get("from", [])
                if {"key": "synodic.io/lane", "operator": "Exists"}
                in f.get("podSelector", {}).get("matchExpressions", [])}
    assert {"ingress-postgres", "ingress-redis", "ingress-falkordb"} <= admitted


def test_helm_template_declares_the_three_lanes_on_the_shared_env():
    """The checks that need no helm binary, so they hold wherever the suite runs."""
    text = _TEMPLATE.read_text()
    # Every action closes before the next opens: an unbalanced brace fails `helm template`.
    tokens = [m.group() for m in re.finditer(r"\{\{|\}\}", text)]
    assert tokens == ["{{", "}}"] * (len(tokens) // 2), "unbalanced template braces"

    (lanes,) = re.findall(r'range \$lane := list ((?:"\w+" ?)+)', text)
    assert set(re.findall(r'"(\w+)"', lanes)) == _LANES
    assert "synodic.io/lane: {{ $lane }}" in text
    assert "value: {{ $lane | quote }}" in text           # GRAPHVER_WORKER_LANES
    assert "schemaCheckInitContainer" in text
    assert "kind: HorizontalPodAutoscaler" in text
    # The same ConfigMap and Secret as viz-service, and no per-lane copy of their keys.
    viz = (_CHART / "templates" / "viz-service.yaml").read_text()
    for source in ("name: dataviz-config", 'name: {{ include "dataviz.secretName"'):
        assert source in text and source in viz
    assert not re.search(r"name: (OBJECT_STORE_|IMPORT_STORE_ROOT|MANAGEMENT_DB_URL|GRAPHVER_DB_URL)", text)

    values = yaml.safe_load((_CHART / "values.yaml").read_text())
    versioning = values["services"]["versioning"]
    assert _LANES <= set(versioning)
    assert versioning["terminationGracePeriodSeconds"] > config.DRAIN_SECS
    assert versioning["transfer"]["autoscaling"]["scaleDownStabilizationWindowSeconds"] == 900
    configmap = (_CHART / "templates" / "configmap.yaml").read_text()
    assert 'GRAPHVER_PROJECTION_INPROCESS: "0"' in configmap
    assert "OBJECT_STORE_BACKEND: {{ .Values.config.objectStore.backend" in configmap


# --------------------------------------------------------------------------- #
# k8s base and compose                                                         #
# --------------------------------------------------------------------------- #
def test_the_k8s_base_deploys_the_three_lanes_and_the_transfer_hpa(monkeypatch):
    resources = yaml.safe_load((_K8S / "kustomization.yaml").read_text())["resources"]
    docs = [d for r in resources for d in yaml.safe_load_all((_K8S / r).read_text()) if d]
    deployments = _lane_deployments(docs)
    _assert_lanes(deployments, monkeypatch)
    _transfer_hpa(docs, deployments)
    # Kept from the single worker: a Deployment's selector is immutable, so a
    # renamed or relabelled one would fail `kubectl apply` on every cluster.
    assert deployments["projection"]["metadata"]["name"] == "versioning-worker"
    assert deployments["projection"]["spec"]["selector"]["matchLabels"] == {
        "app.kubernetes.io/name": "versioning-worker"}
    worker_config = next(d for d in docs if d.get("kind") == "ConfigMap"
                         and d["metadata"]["name"] == "worker-config")["data"]
    assert worker_config["SYNODIC_ROLE"] == "worker"
    for d in deployments.values():
        (container,) = d["spec"]["template"]["spec"]["containers"]
        assert {"configMapRef": {"name": "worker-config"}} in container["envFrom"]
        # The base NetworkPolicies admit backends to the stores by this label.
        assert d["spec"]["template"]["metadata"]["labels"]["app.kubernetes.io/component"] == "worker"


def test_compose_splits_projection_from_the_job_lanes(monkeypatch):
    services = yaml.safe_load((_ROOT / "docker-compose.yml").read_text())["services"]
    projection, jobs = services["versioning-worker"], services["versioning-jobs"]
    worker_lanes = _lanes_of(projection["environment"]["GRAPHVER_WORKER_LANES"], monkeypatch)
    job_lanes = _lanes_of(jobs["environment"]["GRAPHVER_WORKER_LANES"], monkeypatch)
    assert (worker_lanes, job_lanes) == ({"projection"}, {"transfer", "bootstrap"})

    def rest(service):
        return {k: v for k, v in service["environment"].items() if k != "GRAPHVER_WORKER_LANES"}

    assert rest(jobs) == rest(projection)
    for key in ("build", "command", "depends_on", "restart"):
        assert jobs[key] == projection[key], key
    assert jobs["stop_grace_period"] == "60s"

    dev = yaml.safe_load((_ROOT / "docker-compose.dev.yml").read_text())["services"]
    assert dev["versioning-jobs"]["volumes"] == dev["versioning-worker"]["volumes"]


def test_no_deploy_target_still_sets_the_removed_inprocess_switch():
    """The worker logs a WARNING for it and nothing reads it; a manifest that
    still sets it suggests jobs could run in the web tier, which they cannot."""
    files = [*(_ROOT / "deploy").rglob("*.yaml"), *_ROOT.glob("docker-compose*.yml")]
    offenders = [str(f.relative_to(_ROOT)) for f in files
                 if "GRAPHVER_TRANSFER_INPROCESS" in f.read_text()]
    assert offenders == []
