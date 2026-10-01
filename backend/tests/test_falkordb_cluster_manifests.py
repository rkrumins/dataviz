"""THE CLUSTER SHARDS HAVE TO SURVIVE THEIR OWN DEPLOYMENT.

Shard pods were being replaced with restartCount 0 — not by a crash, by the
deploy: every ``make deploy`` re-tagged the image, the StatefulSet got a new
revision, and the controller rolled every shard pod into an hour-long reload.
A restarted pod came back owning its slots with no data, because the data dir
was on the container layer. A replica that answered PONG while an hour behind
looked Ready. A master killed outright could rejoin with an older RDB than
its replica's and have the replica full-sync the stale set.

Each fix is a line of YAML that merges cleanly and is easy to lose in the next
edit of a three-times-duplicated file, so each is pinned here — parsed from
the manifests, not grepped: a flag in a comment is not a flag.
"""
from __future__ import annotations

import re
import subprocess
from pathlib import Path

import pytest
import yaml

_REPO = Path(__file__).resolve().parents[2]
_K8S = _REPO / "deploy" / "k8s"
_OVERLAY = _K8S / "overlays" / "production-cluster"
_SHARDS = _OVERLAY / "resources" / "falkordb-cluster-statefulsets.yaml"
_INIT_JOB = _OVERLAY / "resources" / "falkordb-cluster-init-job.yaml"
_PRIORITY = _OVERLAY / "resources" / "falkordb-cluster-priority-class.yaml"
_NETPOL = _OVERLAY / "resources" / "falkordb-cluster-network-policy.yaml"
_CONFIG = _OVERLAY / "patches" / "cluster-config.yaml"
_KUSTOMIZATION = _OVERLAY / "kustomization.yaml"
_MAKEFILE = _K8S / "Makefile"

_SHARD_NAMES = ["falkordb-shard-0", "falkordb-shard-1", "falkordb-shard-2"]


def _docs(path: Path) -> list:
    return [d for d in yaml.safe_load_all(path.read_text()) if d]


def _shards() -> list:
    shards = [d for d in _docs(_SHARDS) if d.get("kind") == "StatefulSet"]
    assert [d["metadata"]["name"] for d in shards] == _SHARD_NAMES
    return shards


def _container(shard) -> dict:
    (container,) = shard["spec"]["template"]["spec"]["containers"]
    return container


def _env(shard, name: str) -> str:
    return next(str(e["value"]) for e in _container(shard)["env"] if e["name"] == name)


def _script(command: list) -> str:
    """The body of an ``sh -c`` exec, the only form these manifests use."""
    assert command[:2] == ["sh", "-c"] and len(command) == 3, command
    return command[2]


def _node_timeout_s(shard) -> float:
    args = _env(shard, "REDIS_ARGS").split()
    return int(args[args.index("--cluster-node-timeout") + 1]) / 1000.0


def _kustomization() -> dict:
    return yaml.safe_load(_KUSTOMIZATION.read_text())


# ── topology and rollout ──────────────────────────────────────────────────


@pytest.mark.parametrize("index", [0, 1, 2])
def test_each_shard_runs_a_master_and_two_replicas(index):
    """Ordinal -2 is the read replica; the other replica takes no reads so it
    stays in step and wins a failover. Applying fewer deletes live pods."""
    assert _shards()[index]["spec"]["replicas"] == 3


@pytest.mark.parametrize("index", [0, 1, 2])
def test_a_loading_pod_does_not_block_its_siblings(index):
    """OrderedReady will not recreate a missing -2 while -0 is NotReady, and
    a shard pod loading its RDB is NotReady for up to an hour."""
    assert _shards()[index]["spec"]["podManagementPolicy"] == "Parallel"


@pytest.mark.parametrize("index", [0, 1, 2])
def test_a_template_change_never_restarts_a_shard_pod(index):
    """Under RollingUpdate every template change — an image re-tag, an arg —
    replaced every shard pod. Shards are rolled role-aware, by hand."""
    assert _shards()[index]["spec"]["updateStrategy"] == {"type": "OnDelete"}


def test_the_shards_carry_a_priority_class_that_ships_with_them():
    """Node-pressure eviction ignores the PDB; priority is its second key."""
    (priority,) = _docs(_PRIORITY)
    assert priority["kind"] == "PriorityClass"
    assert priority["globalDefault"] is False
    assert 0 < priority["value"] < 1_000_000_000, "user classes stay below system-*-critical"
    for shard in _shards():
        assert shard["spec"]["template"]["spec"]["priorityClassName"] == priority["metadata"]["name"]
    assert "resources/falkordb-cluster-priority-class.yaml" in _kustomization()["resources"]


@pytest.mark.parametrize("index", [0, 1, 2])
def test_ephemeral_storage_is_requested_and_capped(index):
    """With the data dir on the PVC the container layer holds only logs; the
    request ranks the pod last under DiskPressure and the limit names the
    cause if the dataset ever lands on the layer again."""
    resources = _container(_shards()[index])["resources"]
    assert "ephemeral-storage" in resources["requests"]
    assert "ephemeral-storage" in resources["limits"]


# ── what runs at start, at stop, and in between ───────────────────────────


@pytest.mark.parametrize("index", [0, 1, 2])
def test_the_entrypoint_holds_a_crashed_master_until_its_replica_is_promoted(index):
    """A master killed outright restarts from an RDB older than its replica's
    data. Started at once it rejoins as master before the cluster has failed
    it, and the replica full-syncs the stale set. The hold has to outlast
    failure detection plus the election, so it is pinned against the node
    timeout the same manifest sets rather than against a number."""
    shard = _shards()[index]
    script = _script(_container(shard)["command"])
    assert "myself,master" in script and "/data/nodes.conf" in script
    holds = [int(s) for s in re.findall(r"\bsleep (\d+)", script)]
    assert holds and min(holds) >= 2 * _node_timeout_s(shard), (
        f"holds {holds}s against a {_node_timeout_s(shard)}s cluster-node-timeout"
    )
    assert script.strip().splitlines()[-1].strip() == "exec /var/lib/falkordb/bin/run.sh", (
        "the wrapper must hand PID 1 to the image's own entrypoint, or SIGTERM "
        "never reaches redis-server and the shutdown save never happens"
    )


@pytest.mark.parametrize("index", [0, 1, 2])
def test_the_startup_probe_covers_the_hold(index):
    """Liveness must not start counting while the entrypoint is holding."""
    shard = _shards()[index]
    container = _container(shard)
    startup = container["startupProbe"]
    holds = [int(s) for s in re.findall(r"\bsleep (\d+)", _script(container["command"]))]
    assert startup["periodSeconds"] * startup["failureThreshold"] > max(holds)
    assert "initialDelaySeconds" not in container["livenessProbe"]


@pytest.mark.parametrize("index", [0, 1, 2])
def test_a_master_hands_over_before_it_stops(index):
    """A planned stop is a coordinated CLUSTER FAILOVER, not a node-timeout
    outage — and the hook must never fail the stop."""
    script = _script(_container(_shards()[index])["lifecycle"]["preStop"]["exec"]["command"])
    assert "cluster failover" in script
    assert script.strip().splitlines()[-1].strip() == "exit 0"


@pytest.mark.parametrize("index", [0, 1, 2])
def test_a_stop_during_the_hold_is_not_lost(index, tmp_path):
    """The wrapper is PID 1, and PID 1 drops a signal it has no handler for:
    a SIGTERM during a bare ``sleep 45`` was ignored, Redis started anyway,
    and the kubelet SIGKILLed it at the end of the grace period. Run here as
    an ordinary process (PID 1 needs a namespace), so what is pinned is the
    handler: without one the shell dies OF the signal instead of exiting 0,
    and as PID 1 it ignores it."""
    import os
    import signal
    import time

    script = _script(_container(_shards()[index])["command"])
    (tmp_path / "data").mkdir()
    (tmp_path / "data" / "nodes.conf").write_text(
        "abc 10.0.0.1:6379@16379,h myself,master - 0 0 1 connected 0-5460\n")
    run_sh = tmp_path / "run.sh"
    run_sh.write_text(f'#!/bin/sh\ntouch "{tmp_path}/started"\n')
    run_sh.chmod(0o755)
    script = (script.replace("/data/", f"{tmp_path}/data/")
              .replace("/var/lib/falkordb/bin/run.sh", str(run_sh)))
    proc = subprocess.Popen(["sh", "-c", script], stdout=subprocess.DEVNULL,
                            start_new_session=True)
    try:
        time.sleep(0.5)
        proc.send_signal(signal.SIGTERM)
        assert proc.wait(timeout=10) == 0
    finally:
        try:
            os.killpg(proc.pid, signal.SIGKILL)  # the orphaned sleep
        except ProcessLookupError:
            pass
    assert not (tmp_path / "started").exists(), "Redis was started after the stop"


def _hand_over_target(script: str, tmp_path: Path, nodes: str, info: str) -> str:
    """Run the preStop against a stand-in redis-cli; the replica it sent
    CLUSTER FAILOVER to, as ``host:port``."""
    (tmp_path / "nodes").write_text(nodes)
    (tmp_path / "info").write_text(info.replace("\n", "\r\n"))
    (tmp_path / "failed-over").unlink(missing_ok=True)
    fake = tmp_path / "redis-cli"
    fake.write_text(
        "#!/bin/sh\n"
        'case "$*" in\n'
        '  "role") [ -f "$DIR/failed-over" ] && echo slave || echo master ;;\n'
        '  "cluster nodes") cat "$DIR/nodes" ;;\n'
        '  "info replication") cat "$DIR/info" ;;\n'
        '  *"cluster failover") echo "$2:$4" > "$DIR/failed-over" ;;\n'
        "esac\n"
    )
    fake.chmod(0o755)
    subprocess.run(
        ["sh", "-c", script], check=True, timeout=30, capture_output=True,
        env={"PATH": f"{tmp_path}:/usr/bin:/bin", "DIR": str(tmp_path)},
    )
    return (tmp_path / "failed-over").read_text().strip()


@pytest.mark.parametrize("index", [0, 1, 2])
def test_the_hand_over_goes_to_the_standby_not_the_read_replica(index, tmp_path):
    """A -2 master leaves its shard no replica the read allowlist matches, so
    every read lands on the master. By offset alone an idle tie went to
    whichever replica INFO listed first (reproduced on Redis 8.6.3). The
    standby is read by HOSTNAME, so it holds after roles have moved."""
    script = _script(_container(_shards()[index])["lifecycle"]["preStop"]["exec"]["command"])
    assert _docs(_CONFIG)[0]["data"]["FALKORDB_REPLICA_READ_HOSTS"] in script, (
        "the preStop's read-replica pattern must be the app's allowlist"
    )

    def nodes(master: int) -> str:
        return "".join(
            f"id{o} 10.8.{index}.{o}:6379@16379,falkordb-shard-{index}-{o}"
            f".falkordb-cluster.synodic.svc.cluster.local "
            f"{'myself,master' if o == master else 'slave'} - 0 0 1 connected\n"
            for o in range(3)
        )

    def info(*replicas) -> str:
        return "# Replication\nrole:master\n" + "".join(
            f"slave{n}:ip=10.8.{index}.{o},port=6379,state={state},offset={off},lag=0\n"
            for n, (o, state, off) in enumerate(replicas)
        )

    reader, standby = f"10.8.{index}.2:6379", f"10.8.{index}.1:6379"
    tie = info((2, "online", 158380), (1, "online", 158380))
    assert _hand_over_target(script, tmp_path, nodes(0), tie) == standby
    ahead = info((2, "online", 9000), (1, "online", 100))
    assert _hand_over_target(script, tmp_path, nodes(0), ahead) == standby
    syncing = info((2, "online", 9000), (1, "wait_bgsave", 0))
    assert _hand_over_target(script, tmp_path, nodes(0), syncing) == reader
    # After a hand-over -1 is master and -0 the standby.
    moved = info((2, "online", 500), (0, "online", 500))
    assert _hand_over_target(script, tmp_path, nodes(1), moved) == f"10.8.{index}.0:6379"


@pytest.mark.parametrize("index", [0, 1, 2])
def test_a_replica_is_ready_only_while_its_link_is_up(index):
    """A replica answers PONG through an hour-long full sync, holding data
    that is not its master's."""
    script = _script(_container(_shards()[index])["readinessProbe"]["exec"]["command"])
    assert "grep -q PONG" in script
    assert "master_link_status:up" in script and "role:master" in script


@pytest.mark.parametrize("index", [0, 1, 2])
def test_no_script_uses_the_kubelets_expansion_syntax(index):
    """The kubelet rewrites ``$(NAME)`` for every env var the container
    defines (POD_NAME, REDISCLI_AUTH, FALKORDB_ARGS…) and ``$$`` to ``$``
    before the shell ever sees the script. The one intended use is the
    announce hostname in REDIS_ARGS."""
    container = _container(_shards()[index])
    scripts = [
        _script(container["command"]),
        _script(container["lifecycle"]["preStop"]["exec"]["command"]),
        *(_script(container[probe]["exec"]["command"])
          for probe in ("startupProbe", "readinessProbe", "livenessProbe")),
    ]
    for script in scripts:
        assert "$(" not in script and "$$" not in script, script
    refs = {
        e["name"]: re.findall(r"\$\(([^)]*)\)", str(e.get("value") or ""))
        for e in container["env"]
    }
    assert {name: found for name, found in refs.items() if found} == {"REDIS_ARGS": ["POD_NAME"]}


def test_the_init_job_attaches_both_replicas_of_every_shard(tmp_path):
    """Run the Job's own script against a stand-in redis-cli and read what it
    asked for: a pairing the script only appears to make is not checked by
    reading it."""
    (job,) = _docs(_INIT_JOB)
    script = _script(job["spec"]["template"]["spec"]["containers"][0]["command"])
    log = tmp_path / "calls.log"
    fake = tmp_path / "redis-cli"
    fake.write_text(
        "#!/bin/sh\n"
        f'echo "$*" >> "{log}"\n'
        'case "$*" in\n'
        '  *" ping") echo PONG ;;\n'
        '  *"cluster info") echo cluster_state:fail ;;\n'
        '  *"cluster myid") echo "id-$2" ;;\n'
        "esac\n"
    )
    fake.chmod(0o755)
    subprocess.run(
        ["sh", "-c", script], check=True, timeout=30,
        env={"PATH": f"{tmp_path}:/usr/bin:/bin"}, capture_output=True,
    )

    def short(endpoint: str) -> str:
        return endpoint.split(".", 1)[0]

    attached = set()
    for line in log.read_text().splitlines():
        tokens = line.split()
        if tokens[:2] == ["--cluster", "add-node"]:
            master_id = tokens[tokens.index("--cluster-master-id") + 1]
            attached.add((short(tokens[2]), short(tokens[3]), master_id))
    domain = "falkordb-cluster.synodic.svc.cluster.local"
    assert attached == {
        (f"falkordb-shard-{i}-{r}", f"falkordb-shard-{i}-0", f"id-falkordb-shard-{i}-0.{domain}")
        for i in range(3) for r in (1, 2)
    }


# ── who may reach the shards ──────────────────────────────────────────────


def _selects(selector: dict, labels: dict) -> bool:
    for key, value in (selector.get("matchLabels") or {}).items():
        if labels.get(key) != value:
            return False
    for expr in selector.get("matchExpressions") or []:
        assert expr["operator"] == "In", expr
        if labels.get(expr["key"]) not in expr["values"]:
            return False
    return True


def _admits(labels: dict, port: int) -> bool:
    (policy,) = _docs(_NETPOL)
    return any(
        any(p["port"] == port and p.get("protocol", "TCP") == "TCP" for p in rule["ports"])
        and any(_selects(peer["podSelector"], labels) for peer in rule["from"])
        for rule in policy["spec"]["ingress"]
    )


def _template_labels(path: Path) -> dict:
    doc = next(d for d in _docs(path) if d.get("kind") in ("Deployment", "Job", "CronJob"))
    spec = doc["spec"]["jobTemplate"]["spec"] if doc["kind"] == "CronJob" else doc["spec"]
    return spec["template"]["metadata"]["labels"]


def test_the_network_policy_selects_every_shard_pod():
    """The base allow rule selects ``name: falkordb``, which no shard pod
    carries: under default-deny the cluster would partition itself."""
    (policy,) = _docs(_NETPOL)
    assert policy["spec"]["policyTypes"] == ["Ingress"]
    for shard in _shards():
        assert _selects(policy["spec"]["podSelector"], shard["spec"]["template"]["metadata"]["labels"])
    assert "resources/falkordb-cluster-network-policy.yaml" in _kustomization()["resources"]


def test_the_shards_reach_each_other_on_both_ports():
    peer = _shards()[0]["spec"]["template"]["metadata"]["labels"]
    assert _admits(peer, 6379), "replication, the preStop hand-over, redis-cli --cluster"
    assert _admits(peer, 16379), "the cluster bus: gossip, failure detection, votes"


@pytest.mark.parametrize("client", [
    "base/services/viz-service/deployment.yaml",
    "base/services/aggregation-controlplane/deployment.yaml",
    "base/services/aggregation-worker/deployment.yaml",
    "base/services/versioning-worker/deployment.yaml",
    "base/services/seed/job.yaml",
    "overlays/production/resources/falkordb-dr-backup.yaml",
    "overlays/production-cluster/resources/falkordb-cluster-init-job.yaml",
])
def test_every_client_reaches_the_data_port_and_not_the_bus(client):
    """Read from each client's own pod template, so a relabel there fails
    here rather than in production the day enforcement is switched on."""
    labels = _template_labels(_K8S / client)
    assert _admits(labels, 6379)
    assert not _admits(labels, 16379)


def test_an_unrelated_pod_is_not_admitted():
    frontend = _template_labels(_K8S / "base/services/frontend/deployment.yaml")
    assert not _admits(frontend, 6379)


# ── what an app deploy may change ─────────────────────────────────────────


def test_an_app_deploy_cannot_retag_the_shard_image():
    """``make deploy``/``apply`` pipe the render through seds that rewrite
    the shared tags to the per-commit one. The shards' tag must survive all
    of them, or every app deploy is a new StatefulSet revision."""
    seds = re.findall(r'sed "s\|([^|]+)\|([^|]*)\|g"', _MAKEFILE.read_text())
    tag_seds = {pattern for pattern, _ in seds if pattern.startswith(":")}
    assert {":prod-latest", ":dev-latest", ":staging-latest", ":v1.0.0"} <= tag_seds, (
        f"the Makefile's tag seds are no longer where this test reads them: {sorted(tag_seds)}"
    )
    (entry,) = [i for i in _kustomization()["images"] if i["name"] == "REGISTRY/falkordb"]
    image = f"{entry['newName']}:{entry['newTag']}"
    for pattern, _ in seds:
        image = re.sub(pattern, lambda _m: "<rewritten>", image)
    assert image.endswith(f":{entry['newTag']}"), (
        f"{entry['newTag']} is rewritten by the deploy pipeline (became {image!r})"
    )


# ── where the app sends reads ─────────────────────────────────────────────


def test_reads_go_to_the_designated_replica_and_never_the_master():
    """A long read holding a graph's lock freezes the node a write then
    reaches — on a master, past the failure detector. One replica per shard
    takes reads; the other stays in step for failover; the master takes
    none."""
    data = _docs(_CONFIG)[0]["data"]
    assert data["FALKORDB_MASTER_READ_SHARE"] == "0"
    hosts = re.compile(data["FALKORDB_REPLICA_READ_HOSTS"])
    domain = "falkordb-cluster.synodic.svc.cluster.local"
    for shard in range(3):
        assert hosts.search(f"falkordb-shard-{shard}-2.{domain}")
        for other in (0, 1):
            assert not hosts.search(f"falkordb-shard-{shard}-{other}.{domain}")
