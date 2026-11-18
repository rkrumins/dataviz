"""Production's upgrade Job stops on a stamp no lineage places; dev's recovers it.

The upgrade Job's estimate-and-correct recovery (``--recover``, ``SYNODIC_UPGRADE_RECOVER``,
``docs/MIGRATIONS.md``) is for dev and local databases only. Each way of deploying keeps it off by
default and has a dev preset that turns it on:

* Helm: ``values.yaml`` off, ``values-dev.yaml`` on, and the upgrade Job passes it on;
* kustomize: base ``common-config`` off, the dev overlay on, no other overlay on, and the
  schema-upgrade Job in ``docs/KUBERNETES.md`` reads it from ``common-config``;
* Compose (a developer's own database): on.

Pure YAML parsing: Guards runs it with ``--noconftest``.
"""
import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
HELM = ROOT / "deploy" / "helm" / "dataviz"
K8S = ROOT / "deploy" / "k8s"
KEY = "SYNODIC_UPGRADE_RECOVER"


def _load(path: Path):
    return yaml.safe_load(path.read_text(encoding="utf-8"))


def test_helm_recovers_only_with_the_dev_values():
    assert _load(HELM / "values.yaml")["upgrade"]["recoverForeignStamps"] is False
    assert _load(HELM / "values-dev.yaml")["upgrade"]["recoverForeignStamps"] is True
    job = (HELM / "templates" / "upgrade-job.yaml").read_text(encoding="utf-8")
    assert re.search(rf"name: {KEY}\s+value: .*\.Values\.upgrade\.recoverForeignStamps", job)


def _recovery(overlay: Path) -> str:
    """``common-config``'s value for the key, as an overlay ends up with it."""
    kustomization = _load(overlay / "kustomization.yaml")
    value = None
    for resource in kustomization.get("resources", []):
        target = (overlay / resource).resolve()
        if target == (K8S / "base").resolve():
            value = _load(K8S / "base" / "configmaps" / "common-config.yaml")["data"][KEY]
        elif (target / "kustomization.yaml").exists():
            value = _recovery(target)
    for patch in kustomization.get("patches", []):
        body = patch.get("patch") or (overlay / patch["path"]).read_text(encoding="utf-8")
        target = patch.get("target", {}).get("name")
        for doc in yaml.safe_load_all(body):
            if isinstance(doc, list) and target == "common-config":          # a JSON patch
                for op in doc:
                    if op.get("path") == f"/data/{KEY}":
                        value = op.get("value")
            elif isinstance(doc, dict) and (doc.get("metadata") or {}).get("name") == "common-config":
                value = (doc.get("data") or {}).get(KEY, value)                # a strategic merge
    return value


def test_kustomize_recovers_only_in_the_dev_overlay():
    assert _load(K8S / "base" / "configmaps" / "common-config.yaml")["data"][KEY] == "false"
    overlays = sorted(p for p in (K8S / "overlays").iterdir() if (p / "kustomization.yaml").exists())
    assert {p.name for p in overlays} >= {"dev", "staging", "production"}
    for overlay in overlays:
        assert _recovery(overlay) == ("true" if overlay.name == "dev" else "false"), overlay.name


def test_the_kustomize_schema_job_reads_it_from_common_config():
    guide = (ROOT / "docs" / "KUBERNETES.md").read_text(encoding="utf-8")
    block = next(b for b in re.findall(r"```yaml\n(.*?)```", guide, re.S) if "name: schema-upgrade" in b)
    job = yaml.safe_load("\n".join(line[3:] for line in block.splitlines()))
    env = {e["name"]: e for e in job["spec"]["template"]["spec"]["containers"][0]["env"]}
    assert env[KEY]["valueFrom"]["configMapKeyRef"] == {"name": "common-config", "key": KEY, "optional": True}


def test_compose_recovers_a_developers_own_database():
    compose = _load(ROOT / "docker-compose.yml")
    assert compose["services"]["upgrade"]["environment"][KEY] == "true"
