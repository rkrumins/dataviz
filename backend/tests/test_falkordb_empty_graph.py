"""Tests for the false-"provider down" fixes:
- empty/never-created graph is a valid 0/0 state, not an outage
  (get_stats / get_schema_stats / get_ontology_metadata tolerate it),
- localhost is pinned to IPv4 to dodge the ::1 dual-stack failure,
- BOTH provider-instantiation paths honor LOCAL_DEV_FALKORDB_OVERRIDE.

No live FalkorDB required — the graph query layer is monkeypatched.
"""
import os

import pytest
from redis.exceptions import ResponseError

import backend.app.providers.falkordb_provider as fp
from backend.app.providers.falkordb_provider import FalkorDBProvider, _is_missing_graph_error


_EMPTY_KEY = ResponseError("Invalid graph operation on empty key")


def _make_provider():
    p = FalkorDBProvider(host="x", graph_name="g")
    p._SCHEMA_CACHE_TTL = 0  # skip the redis cache read/write path

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect
    return p


# ── _is_missing_graph_error ─────────────────────────────────────────

def test_is_missing_graph_error_matches_empty_key():
    assert _is_missing_graph_error(_EMPTY_KEY)
    assert _is_missing_graph_error(ResponseError("invalid graph operation on EMPTY KEY"))


def test_is_missing_graph_error_rejects_unrelated():
    assert not _is_missing_graph_error(ResponseError("syntax error near MATCH"))
    assert not _is_missing_graph_error(ConnectionError("refused"))


def test_is_missing_graph_error_walks_cause_chain():
    outer = RuntimeError("wrapped")
    outer.__cause__ = _EMPTY_KEY
    assert _is_missing_graph_error(outer)


# ── host normalization (IPv6 ::1 guard) ─────────────────────────────

def test_localhost_normalized_to_ipv4():
    assert fp._normalize_falkordb_host("localhost") == "127.0.0.1"
    assert FalkorDBProvider(host="localhost")._host == "127.0.0.1"


def test_other_hosts_left_untouched():
    assert fp._normalize_falkordb_host("falkordb") == "falkordb"
    assert fp._normalize_falkordb_host("10.0.0.5") == "10.0.0.5"


def test_normalization_opt_out(monkeypatch):
    monkeypatch.setenv("FALKORDB_DISABLE_IPV4_NORMALIZE", "true")
    assert fp._normalize_falkordb_host("localhost") == "localhost"


def test_docker_localhost_rewrite(monkeypatch):
    monkeypatch.setenv("FALKORDB_DOCKER_LOCALHOST_REWRITE", "host.docker.internal")
    # Rewrite wins over the IPv4 pin, for both localhost and 127.0.0.1.
    assert fp._normalize_falkordb_host("localhost") == "host.docker.internal"
    assert fp._normalize_falkordb_host("127.0.0.1") == "host.docker.internal"
    # Non-loopback hosts are untouched.
    assert fp._normalize_falkordb_host("falkordb") == "falkordb"


# ── empty-graph tolerance in introspection reads ────────────────────

@pytest.mark.asyncio
async def test_get_stats_empty_graph_returns_zero(monkeypatch):
    p = _make_provider()

    async def _raise(*a, **k):
        raise _EMPTY_KEY

    monkeypatch.setattr(p, "_ro_query", _raise)
    stats = await p.get_stats()
    assert stats == {
        "nodeCount": 0,
        "edgeCount": 0,
        "entityTypeCounts": {},
        "edgeTypeCounts": {},
    }


@pytest.mark.asyncio
async def test_get_stats_propagates_real_errors(monkeypatch):
    p = _make_provider()

    async def _raise(*a, **k):
        raise ResponseError("syntax error")

    monkeypatch.setattr(p, "_ro_query", _raise)
    with pytest.raises(ResponseError):
        await p.get_stats()


@pytest.mark.asyncio
async def test_get_schema_stats_empty_graph_returns_empty(monkeypatch):
    p = _make_provider()

    async def _raise(*a, **k):
        raise _EMPTY_KEY

    monkeypatch.setattr(p, "_ro_query", _raise)
    schema = await p.get_schema_stats()
    assert schema.total_nodes == 0
    assert schema.total_edges == 0
    assert schema.entity_type_stats == []
    assert schema.edge_type_stats == []


@pytest.mark.asyncio
async def test_ro_query_tolerant_swallows_only_missing_graph(monkeypatch):
    p = _make_provider()

    calls = {"n": 0}

    async def _raise_empty(*a, **k):
        calls["n"] += 1
        raise _EMPTY_KEY

    monkeypatch.setattr(p, "_ro_query", _raise_empty)
    res = await p._ro_query_tolerant("MATCH ()-[r]->() RETURN type(r)")
    assert res.result_set == []
    assert calls["n"] == 1

    async def _raise_other(*a, **k):
        raise ResponseError("nope")

    monkeypatch.setattr(p, "_ro_query", _raise_other)
    with pytest.raises(ResponseError):
        await p._ro_query_tolerant("MATCH (n) RETURN n")


# ── override parity across both instantiation paths ─────────────────

def test_both_paths_apply_local_dev_override(monkeypatch):
    monkeypatch.setenv("LOCAL_DEV_FALKORDB_OVERRIDE", "true")
    monkeypatch.setenv("FALKORDB_HOST", "localhost")
    monkeypatch.delenv("FALKORDB_PORT", raising=False)

    from backend.app.providers.manager import ProviderManager
    from backend.app.registry.provider_registry import provider_registry

    # Stored host is the Docker hostname; the override must rewrite it so a
    # laptop process connects to localhost (then normalized to 127.0.0.1).
    mgr = ProviderManager._create_provider_instance(
        "falkordb", "falkordb", 6379, "g", False, credentials={},
    )
    reg = provider_registry._create_provider_instance(
        "falkordb", "falkordb", 6379, "g", False, credentials={},
    )
    assert mgr._host == "127.0.0.1"
    assert reg._host == "127.0.0.1"


# ── cluster-aware empty-key verification ────────────────────────────
#
# On a cluster, "Invalid graph operation on empty key" is ALSO what a read
# returns when it lands on a node that doesn't hold the graph key (stale
# pinned handle after a slot migration, or a promoted-but-unsynced replica).
# Masking that as "0 nodes / 0 edges" made graphs silently read as empty on
# some pods — so the mask is only allowed after a slot-routed EXISTS says
# the graph is genuinely absent.

from types import SimpleNamespace


def _cluster_provider(exists_result):
    """Provider faked into cluster mode with an EXISTS probe answering
    ``exists_result`` (an int, or an exception instance to raise)."""
    p = _make_provider()
    p._conn_cfg = SimpleNamespace(mode="cluster")
    calls = {"exists": 0}

    async def _execute_command(cmd, *args):
        assert cmd == "EXISTS"
        calls["exists"] += 1
        if isinstance(exists_result, BaseException):
            raise exists_result
        return exists_result

    p._db = SimpleNamespace(execute_command=_execute_command)
    return p, calls


@pytest.mark.asyncio
async def test_cluster_empty_key_with_existing_graph_fails_loud(monkeypatch):
    """EXISTS=1: the graph is real and the empty read was a misroute —
    get_stats must raise, never persist zero counts."""
    p, calls = _cluster_provider(1)

    async def _raise(*a, **k):
        raise _EMPTY_KEY

    monkeypatch.setattr(p, "_ro_query", _raise)
    with pytest.raises(ResponseError):
        await p.get_stats()
    assert calls["exists"] == 1


@pytest.mark.asyncio
async def test_cluster_empty_key_with_absent_graph_returns_zero(monkeypatch):
    """EXISTS=0: genuinely never-created graph — zeros, as before."""
    p, calls = _cluster_provider(0)

    async def _raise(*a, **k):
        raise _EMPTY_KEY

    monkeypatch.setattr(p, "_ro_query", _raise)
    stats = await p.get_stats()
    assert stats["nodeCount"] == 0 and stats["edgeCount"] == 0
    assert calls["exists"] == 1


@pytest.mark.asyncio
async def test_cluster_empty_key_probe_failure_fails_loud(monkeypatch):
    """A failing EXISTS probe must not mask — never report empty off an
    unhealthy cluster."""
    p, calls = _cluster_provider(ConnectionError("node gone"))

    async def _raise(*a, **k):
        raise _EMPTY_KEY

    monkeypatch.setattr(p, "_ro_query", _raise)
    with pytest.raises(ResponseError):
        await p._ro_query_tolerant("MATCH (n) RETURN n")
    assert calls["exists"] == 1


@pytest.mark.asyncio
async def test_standalone_empty_key_never_probes(monkeypatch):
    """Standalone/Sentinel behavior is byte-identical: no EXISTS issued."""
    p = _make_provider()          # _conn_cfg is None → non-cluster path

    async def _boom(*a, **k):
        raise AssertionError("EXISTS must not be issued outside cluster mode")

    p._db = SimpleNamespace(execute_command=_boom)

    async def _raise(*a, **k):
        raise _EMPTY_KEY

    monkeypatch.setattr(p, "_ro_query", _raise)
    stats = await p.get_stats()
    assert stats["nodeCount"] == 0


@pytest.mark.asyncio
async def test_cluster_schema_stats_empty_key_verified(monkeypatch):
    """get_schema_stats honours the same verification."""
    p, _calls = _cluster_provider(1)

    async def _raise(*a, **k):
        raise _EMPTY_KEY

    monkeypatch.setattr(p, "_ro_query", _raise)
    with pytest.raises(ResponseError):
        await p.get_schema_stats()
