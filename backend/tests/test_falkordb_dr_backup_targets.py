"""The DR snapshot must SYNC a shard's healthy REPLICA — whichever pod that is now.

``redis-cli --rdb`` issues a SYNC, which forks the server it reaches. The cluster
patch used to hard-wire each shard's ``-1`` pod as "the replica"; after any
failover that pod is the master, and the 6-hourly backup forked a loaded master
(copy-on-write on top of live query memory) — the exact thing it exists to avoid.

So each target field is now a ``|``-separated candidate list and the snapshot
script reads every candidate's live INFO, skipping (and logging why) one that is
unreachable, loading, a master under ``FALKORDB_BACKUP_REPLICA_ONLY=1``, a replica
whose master link is down (SYNC would fail ``-NOMASTERLINK``), or already forking.
Nothing at apply time checks any of that, so the script is run here for real:
extracted from the manifest, under dash (the image's ``sh``), against a fake
``redis-cli`` answering from per-host INFO fixtures.
"""
from __future__ import annotations

import gzip
import os
import subprocess
from pathlib import Path

import pytest
import yaml

_K8S = Path(__file__).resolve().parents[2] / "deploy" / "k8s" / "overlays"
_BASE = _K8S / "production" / "resources" / "falkordb-dr-backup.yaml"
_PATCH = _K8S / "production-cluster" / "patches" / "dr-backup-cluster.yaml"
_SHARDS = _K8S / "production-cluster" / "resources" / "falkordb-cluster-statefulsets.yaml"
_DASH = "/usr/bin/dash"
# The designated read replica (replica reads go only to it) can be frozen behind
# a long read, so it is the last resort; -0/-1 are the no-read standbys.
_READ_REPLICA_ORDINAL = 2


def _docs(path: Path) -> list[dict]:
    assert path.exists(), f"{path} is missing — has the overlay moved?"
    return [d for d in yaml.safe_load_all(path.read_text()) if d]


def _cronjob(path: Path) -> dict:
    (cronjob,) = [d for d in _docs(path) if d["kind"] == "CronJob"]
    return cronjob


def _snapshot(cronjob: dict) -> dict:
    pod = cronjob["spec"]["jobTemplate"]["spec"]["template"]["spec"]
    (container,) = [c for c in pod["initContainers"] if c["name"] == "snapshot"]
    return container


def _env(*containers: dict) -> dict:
    """Env by name, later containers winning — how kustomize merges the patch."""
    env: dict = {}
    for c in containers:
        env.update({e["name"]: e.get("value") for e in c.get("env", [])})
    return env


def test_every_cluster_shard_lists_all_its_pods_and_never_forks_a_master():
    """Every shard StatefulSet gets exactly one field naming all three of its
    pods (a failover can make ANY ordinal the master), the read replica last."""
    base, patch = _cronjob(_BASE), _cronjob(_PATCH)
    assert [d["kind"] for d in _docs(_BASE)] == ["ServiceAccount", "CronJob"]
    env = _env(_snapshot(base), _snapshot(patch))
    assert env["FALKORDB_BACKUP_REPLICA_ONLY"] == "1"

    shards = {
        s["metadata"]["name"]: s
        for s in _docs(_SHARDS)
        if s["kind"] == "StatefulSet"
    }
    fields = env["FALKORDB_BACKUP_TARGETS"].split(",")
    job = patch["spec"]["jobTemplate"]["spec"]
    assert job["completions"] == job["parallelism"] == len(fields) == len(shards)

    covered = []
    for field in fields:
        candidates = field.split("|")
        assert len(candidates) == 3, field
        name = candidates[0].split(".")[0].rsplit("-", 1)[0]
        sts = shards[name]
        dns = f"{sts['spec']['serviceName']}.{sts['metadata']['namespace']}.svc.cluster.local"
        ordinals = []
        for c in candidates:
            pod, _, rest = c.partition(".")
            assert rest == f"{dns}:6379", c
            assert pod.rsplit("-", 1)[0] == name, f"{c} is not a {name} pod"
            ordinals.append(int(pod.rsplit("-", 1)[1]))
        assert sorted(ordinals) == [0, 1, 2], field
        assert ordinals[-1] == _READ_REPLICA_ORDINAL, field
        covered.append(name)
    assert sorted(covered) == sorted(shards)


# ── The script itself ─────────────────────────────────────────────────────────

_FAKE_REDIS_CLI = r"""#!/bin/sh
# INFO answers from $FAKE_DIR/<host>.info (CRLF, like the real server); no file =
# unreachable. '--rdb -' streams fake RDB bytes and records the host it SYNCed.
while [ $# -gt 0 ]; do
  case "$1" in
    -h) host=$2; shift 2 ;;
    -p) port=$2; shift 2 ;;
    *) break ;;
  esac
done
case "$1" in
  INFO)
    echo "$host" >> "$FAKE_DIR/probed"
    if [ ! -f "$FAKE_DIR/$host.info" ]; then
      echo "Could not connect to Redis at $host:$port: Connection refused" >&2
      exit 1
    fi
    cat "$FAKE_DIR/$host.info" ;;
  --rdb)
    echo "$host" >> "$FAKE_DIR/synced"
    printf 'REDIS0013fake-rdb-of-%s' "$host" ;;
  *)
    echo "unexpected redis-cli args: $*" >&2
    exit 2 ;;
esac
"""


def _info(role: str, *, link: str = "up", loading: int = 0, bgsave: int = 0) -> str:
    lines = ["# Persistence", f"loading:{loading}", f"rdb_bgsave_in_progress:{bgsave}",
             "# Replication", f"role:{role}"]
    if role == "slave":
        lines.append(f"master_link_status:{link}")
    return "\r\n".join(lines) + "\r\n"


def _dash_has_pipefail() -> bool:
    return subprocess.run([_DASH, "-c", "set -o pipefail"], capture_output=True).returncode == 0


@pytest.fixture
def run_snapshot(tmp_path):
    """Run the manifest's snapshot script; return (proc, probed, synced, files)."""
    if not os.path.exists(_DASH):
        pytest.skip(f"{_DASH} not installed")
    command = _snapshot(_cronjob(_BASE))["command"]
    assert command[:2] == ["sh", "-c"]
    backup = tmp_path / "backup"
    backup.mkdir()
    assert '"/backup/' in command[2]
    script = command[2].replace('"/backup/', f'"{backup}/')
    if not _dash_has_pipefail():
        # Ubuntu 24.04's dash 0.5.12-6ubuntu5 lacks it; the image's Debian trixie
        # dash 0.5.12-12 has it (backported). It only guards a truncated stream,
        # which no case here exercises.
        assert script.count("set -o pipefail") == 1
        script = script.replace("set -o pipefail", ":")

    fake = tmp_path / "fake"
    fake.mkdir()
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    cli = bin_dir / "redis-cli"
    cli.write_text(_FAKE_REDIS_CLI)
    cli.chmod(0o755)

    def run(targets: str, nodes: dict[str, str], *, replica_only: bool, index: int = 0):
        for host, info in nodes.items():
            (fake / f"{host}.info").write_bytes(info.encode())
        env = {
            "PATH": f"{bin_dir}:{os.environ['PATH']}",
            "FAKE_DIR": str(fake),
            "FALKORDB_BACKUP_TARGETS": targets,
            "JOB_COMPLETION_INDEX": str(index),
        }
        if replica_only:
            env["FALKORDB_BACKUP_REPLICA_ONLY"] = "1"
        proc = subprocess.run(
            [_DASH, "-c", script], env=env, capture_output=True, text=True, timeout=30,
        )

        def lines(name):
            path = fake / name
            return path.read_text().split() if path.exists() else []

        return proc, lines("probed"), lines("synced"), sorted(backup.iterdir())

    return run


@pytest.mark.parametrize(
    "first, why",
    [
        (_info("master"), "master (FALKORDB_BACKUP_REPLICA_ONLY=1)"),
        (_info("slave", loading=1), "loading its dataset"),
        (_info("slave", link="down"), "replica with master_link_status:down"),
        (_info("slave", bgsave=1), "fork already in progress"),
    ],
    ids=["master", "loading", "link-down", "forking"],
)
def test_an_ineligible_first_candidate_is_skipped_for_the_next(run_snapshot, first, why):
    proc, probed, synced, files = run_snapshot(
        "other:6379,a:6379|b:6379|c:6379",
        {"a": first, "b": _info("slave"), "c": _info("slave")},
        replica_only=True,
        index=1,
    )
    assert proc.returncode == 0, proc.stderr
    assert f"skipping a:6379: {why}" in proc.stderr
    assert probed == ["a", "b"]  # stops at the first eligible: c (the read replica) untouched
    assert synced == ["b"]
    (out,) = files
    assert out.name.startswith("b-") and out.name.endswith(".rdb.gz")
    assert gzip.decompress(out.read_bytes()) == b"REDIS0013fake-rdb-of-b"


def test_no_eligible_candidate_fails_loudly_and_syncs_nothing(run_snapshot):
    """Never falls back to forking the master: the shard's run fails and alerts."""
    proc, probed, synced, files = run_snapshot(
        "gone:6379|m:6379|f:6379|l:6379|d:6379",
        {
            "m": _info("master"),
            "l": _info("slave", loading=1),
            "d": _info("slave", link="down"),
            "f": _info("slave", bgsave=1),
        },
        replica_only=True,
    )
    assert proc.returncode != 0
    assert probed == ["gone", "m", "f", "l", "d"]
    assert synced == [] and files == []
    last = proc.stderr.strip().splitlines()[-1]
    assert last.startswith("no eligible snapshot source")
    for reason in (
        "gone:6379: no INFO: Could not connect",
        "m:6379: master",
        "l:6379: loading",
        "d:6379: replica with master_link_status:down",
        "f:6379: fork already in progress",
    ):
        assert reason in last, reason


def test_a_fork_in_progress_does_not_skip_the_last_candidate(run_snapshot):
    """The single instance's own 6-hourly BGSAVE must not fail its snapshot:
    with nothing left to prefer, the SYNC is queued behind the running fork,
    as it always was."""
    proc, _, synced, _files = run_snapshot(
        "falkordb:6379", {"falkordb": _info("master", bgsave=1)}, replica_only=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert synced == ["falkordb"]


def test_single_instance_master_is_snapshotted_when_replica_only_is_unset(run_snapshot):
    """The base (single-node) target: the master is the only copy, so it must
    stay eligible — the pre-change behaviour."""
    proc, _, synced, files = run_snapshot(
        "falkordb:6379", {"falkordb": _info("master")}, replica_only=False,
    )
    assert proc.returncode == 0, proc.stderr
    assert synced == ["falkordb"]
    (out,) = files
    assert out.name.startswith("falkordb-")
    assert gzip.decompress(out.read_bytes()) == b"REDIS0013fake-rdb-of-falkordb"
