"""Every graph store node must be configured so a fork is survivable and a
restart is not an outage.

The incident: a rebuild wrote at full speed while the master forked, the
copy-on-write took the container past its limit, the master was killed, and
its replica flushed 13 GB synchronously to follow the promotion — long
enough to fail its health probe and be restarted in turn.

Three of those four steps are settings, and the pipeline's own governor
cannot reach any of them. A rebuild now holds its writes through a fork,
which makes a fork survivable; it does not make an hourly one free, and it
does nothing at all about a replica that stops answering while it frees
memory on its main thread.

Parsed from the YAML, not grepped: a flag inside a comment is not a flag,
and a block that drifts from its two siblings is exactly the failure a
three-times-duplicated StatefulSet invites.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
import yaml

_DEPLOY = Path(__file__).resolve().parents[2] / "deploy"
_CLUSTER = _DEPLOY / "k8s/overlays/production-cluster/resources/falkordb-cluster-statefulsets.yaml"
_BASE = _DEPLOY / "k8s/base/infrastructure/falkordb/statefulset.yaml"
_HELM = _DEPLOY / "helm/dataviz/values.yaml"


def _docs(path: Path) -> list:
    return [d for d in yaml.safe_load_all(path.read_text()) if d]


def _containers(doc) -> list:
    spec = (doc.get("spec") or {}).get("template", {}).get("spec", {})
    return spec.get("containers") or []


def _redis_args(doc) -> list[str]:
    """Every graph store container's redis arguments in one document, as
    whitespace-separated tokens — however the manifest spells them (a block
    scalar in the cluster overlay, one REDIS_ARGS string in the base)."""
    out = []
    for c in _containers(doc):
        for env in c.get("env") or []:
            if env.get("name") in ("REDIS_ARGS", "FALKORDB_ARGS"):
                out.append(str(env.get("value") or ""))
    return out


def _cluster_arg_sets() -> list[list[str]]:
    sets = []
    for doc in _docs(_CLUSTER):
        if doc.get("kind") != "StatefulSet":
            continue
        for value in _redis_args(doc):
            if "--maxmemory" in value:
                sets.append(value.split())
    return sets


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


def test_the_three_shard_blocks_are_actually_three():
    """The overlay duplicates one StatefulSet per shard. A guard that only
    ever checked the first would miss the two that drifted."""
    assert len(_cluster_arg_sets()) == 3


@pytest.mark.parametrize("index", [0, 1, 2])
def test_a_replica_frees_its_old_dataset_in_the_background(index):
    """The last step of the incident, and the only one a rebuild cannot
    hold its way out of: a replica following a promotion or a full resync
    flushes what it held first, and synchronously on a large graph that is
    minutes of a main thread answering no health check."""
    args = _cluster_arg_sets()[index]
    assert _tokens_after(args, "--replica-lazy-flush") == ["yes"]
    assert _tokens_after(args, "--lazyfree-lazy-server-del") == ["yes"]


@pytest.mark.parametrize("index", [0, 1, 2])
def test_the_rdb_floor_does_not_fork_the_node_every_hour(index):
    """The RDB is a floor, not the recovery path — AOF is, and an RDB is
    read only when the appendonlydir is missing or quarantined, or across an
    engine upgrade. Its value does not decay in six hours; each save is a
    fork, and a fork is memory a rebuild has to be held out of."""
    args = _cluster_arg_sets()[index]
    seconds = _tokens_after(args, "--save")
    assert seconds and int(seconds[0]) >= 21_600, (
        "an hourly RDB save forks the node every hour whatever else it is "
        "doing; the floor is just as good six-hourly"
    )


@pytest.mark.parametrize("index", [0, 1, 2])
def test_the_aof_is_still_the_recovery_path(index):
    """Nothing above may quietly turn durability off: the floor is only a
    floor because the AOF is the real one."""
    args = _cluster_arg_sets()[index]
    assert _tokens_after(args, "--appendonly") == ["yes"]
    assert _tokens_after(args, "--appendfsync") == ["everysec"]
    assert _tokens_after(args, "--aof-load-truncated") == ["yes"]
    # And a trivial AOF is not worth a fork to rewrite.
    assert _tokens_after(args, "--auto-aof-rewrite-min-size") == ["512mb"]


@pytest.mark.parametrize("index", [0, 1, 2])
def test_the_replication_limits_the_write_governor_reads_are_still_set(index):
    """``hold_reason`` derives its replica-lag threshold from these. A node
    that stops declaring them falls back to a fixed floor and the governor
    holds on a number that has nothing to do with this deployment."""
    args = _cluster_arg_sets()[index]
    assert _tokens_after(args, "--repl-backlog-size") == ["1gb"]
    assert _tokens_after(args, "--client-output-buffer-limit") == [
        "replica", "2gb", "1gb", "300",
    ]


def test_the_single_node_base_carries_the_same_two_lessons():
    args = next(
        value.split()
        for doc in _docs(_BASE) if doc.get("kind") == "StatefulSet"
        for value in _redis_args(doc) if "--maxmemory" in value
    )
    assert _tokens_after(args, "--replica-lazy-flush") == ["yes"]
    assert int(_tokens_after(args, "--save")[0]) >= 21_600
    assert _tokens_after(args, "--appendonly") == ["yes"]


def test_the_helm_chart_frees_in_the_background_too():
    """The chart ships without AOF, so the RDB and rewrite settings do not
    apply to it — the lazy flush does, and for the same reason."""
    values = yaml.safe_load(_HELM.read_text())
    args = str(values["stores"]["falkordb"]["redisArgs"]).split()
    assert _tokens_after(args, "--replica-lazy-flush") == ["yes"]
    assert _tokens_after(args, "--maxmemory-policy") == ["noeviction"]


def test_the_deployment_guide_says_why():
    doc = (_DEPLOY.parent / "docs" / "FALKORDB_DEPLOYMENT.md").read_text()
    assert "replica-lazy-flush" in doc, (
        "a setting nobody can find the reason for is a setting the next "
        "person removes"
    )
    assert re.search(r"save\s+21600", doc)
