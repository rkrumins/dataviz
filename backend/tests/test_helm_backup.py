"""The Helm chart's pre-upgrade backup runs where it must, and never blocks a deploy for nowhere to write.

``templates/db-backup.yaml`` and ``templates/db-backup-pvc.yaml``, read as text (helm isn't needed:
Guards runs this with ``--noconftest``):

* a ``pre-upgrade`` hook, between the database bootstrap (weight 0) and the upgrade (weight 5);
* the volume mounted only when it exists (``lookup``), an ``emptyDir`` otherwise, and the run
  skipped, not failed, with an image older than backups or nowhere to keep the dump;
* the volume kept on uninstall; on by default; admitted to an in-cluster Postgres.
"""
import re
from pathlib import Path

import yaml

TEMPLATES = Path(__file__).resolve().parents[2] / "deploy" / "helm" / "dataviz" / "templates"
VALUES = TEMPLATES.parent / "values.yaml"


def _hook(name: str) -> tuple[str, int]:
    text = (TEMPLATES / name).read_text(encoding="utf-8")
    kinds = re.search(r'"helm\.sh/hook": ([\w,-]+)', text).group(1)
    weight = int(re.search(r'"helm\.sh/hook-weight": "(-?\d+)"', text).group(1))
    return kinds, weight


def test_the_backup_runs_after_the_bootstrap_and_before_the_upgrade():
    backup_kinds, backup = _hook("db-backup.yaml")
    assert backup_kinds == "pre-upgrade"                    # a first install has nothing to back up
    assert _hook("db-init-job.yaml")[1] < backup < _hook("upgrade-job.yaml")[1]


def test_the_backup_never_blocks_a_deploy_for_nowhere_to_write():
    job = (TEMPLATES / "db-backup.yaml").read_text(encoding="utf-8")
    pvc = (TEMPLATES / "db-backup-pvc.yaml").read_text(encoding="utf-8")
    claim = re.search(r"^  name: (\S+)", pvc, re.MULTILINE).group(1)
    assert f'lookup "v1" "PersistentVolumeClaim" .Release.Namespace "{claim}"' in job
    assert f"claimName: {claim}" in job and "emptyDir: {}" in job
    assert 'grep -q "def cmd_backup" /app/backend/scripts/upgrade.py' in job   # an image older than backups
    assert "no backup this time" in job and "exit 0" in job
    assert "helm.sh/resource-policy: keep" in pvc
    # The same decision as the upgrade Job's.
    for variable in ("SYNODIC_SHARED_DATABASE", "SYNODIC_UPGRADE_RECOVER"):
        assert variable in job


def test_backups_are_on_by_default_with_a_volume():
    backup = yaml.safe_load(VALUES.read_text(encoding="utf-8"))["backup"]
    assert backup["enabled"] is True and backup["volume"]["enabled"] is True
    assert backup["bucket"]["prefix"] == "synodic-db-backups"   # not the import store's, which sweeps


def test_the_backup_and_the_upgrade_reach_an_in_cluster_postgres():
    policy = (TEMPLATES / "network-policy.yaml").read_text(encoding="utf-8")
    postgres = policy[policy.index("name: ingress-postgres"):]
    postgres = postgres[:postgres.index("{{- end }}")]
    for component in ("db-backup", "upgrade"):
        assert f"app.kubernetes.io/component: {component}" in postgres
