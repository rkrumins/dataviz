"""Tests for the single FalkorDB host-resolution path.

Root cause: a provider stored as ``localhost:6379`` resolved differently in the
web process vs the async worker vs the env-default fallback, because
``apply_local_dev_falkordb_override`` + ``_normalize_falkordb_host`` were
composed independently, inline, at each of three call sites. This pins:

1. ``resolve_falkordb_target`` is behavior-equivalent to manually composing
   the two existing helpers in the current order, for representative cases
   (localhost with/without the Docker rewrite, the ``falkordb`` passthrough,
   a remote host, the local-dev override).
2. All three call sites (``ProviderManager._create_provider_instance``,
   ``falkor_graph_registry``'s registry-factory ``_resolve`` closure, and its
   ``list_graph_keys``) route through the ONE function — no call site
   composes the two helpers inline anymore.

No live FalkorDB/Postgres required — pure host/port resolution + source
inspection.
"""
import inspect

import pytest

import backend.app.providers.falkor_graph_registry as frg
import backend.app.providers.manager as mgr
from backend.app.providers.falkordb_provider import (
    _normalize_falkordb_host,
    resolve_falkordb_target,
)
from backend.app.providers.manager import apply_local_dev_falkordb_override

_ENV_VARS = (
    "LOCAL_DEV_FALKORDB_OVERRIDE",
    "FALKORDB_HOST",
    "FALKORDB_PORT",
    "FALKORDB_DOCKER_LOCALHOST_REWRITE",
    "FALKORDB_DISABLE_IPV4_NORMALIZE",
)


@pytest.fixture(autouse=True)
def _clean_falkordb_env(monkeypatch):
    """These tests assert absolute (host, port) results, so start from a
    known-clean env rather than assuming it — the dev container sets
    ``FALKORDB_DOCKER_LOCALHOST_REWRITE=falkordb`` ambiently, which would
    otherwise make these tests order/environment-dependent."""
    for var in _ENV_VARS:
        monkeypatch.delenv(var, raising=False)


# ── resolve_falkordb_target: representative cases ───────────────────

def test_resolve_localhost_default_pins_ipv4():
    assert resolve_falkordb_target("localhost", 6379) == ("127.0.0.1", 6379)


def test_resolve_falkordb_passthrough():
    # Pinned per test_falkordb_empty_graph.py:58,73 — 'falkordb' is untouched.
    assert resolve_falkordb_target("falkordb", 6379) == ("falkordb", 6379)


def test_resolve_remote_host_unchanged():
    assert resolve_falkordb_target("10.0.0.5", 6379) == ("10.0.0.5", 6379)


def test_resolve_docker_localhost_rewrite(monkeypatch):
    monkeypatch.setenv("FALKORDB_DOCKER_LOCALHOST_REWRITE", "host.docker.internal")
    assert resolve_falkordb_target("localhost", 6379) == ("host.docker.internal", 6379)
    assert resolve_falkordb_target("127.0.0.1", 6379) == ("host.docker.internal", 6379)
    # Non-loopback hosts are still untouched.
    assert resolve_falkordb_target("falkordb", 6379) == ("falkordb", 6379)


def test_resolve_local_dev_override_then_still_normalized(monkeypatch):
    # LOCAL_DEV_FALKORDB_OVERRIDE rewrites the stored Docker hostname to a
    # host-reachable value; the IPv4-normalize step still runs afterward.
    monkeypatch.setenv("LOCAL_DEV_FALKORDB_OVERRIDE", "1")
    monkeypatch.setenv("FALKORDB_HOST", "localhost")
    assert resolve_falkordb_target("falkordb", 6379) == ("127.0.0.1", 6379)


def test_resolve_local_dev_override_host_and_port(monkeypatch):
    monkeypatch.setenv("LOCAL_DEV_FALKORDB_OVERRIDE", "1")
    monkeypatch.setenv("FALKORDB_HOST", "someremotehost")
    monkeypatch.setenv("FALKORDB_PORT", "7000")
    assert resolve_falkordb_target("falkordb", 6379) == ("someremotehost", 7000)


def test_resolve_equals_manual_composition_across_envs(monkeypatch):
    """Behavior-equivalence pin: resolve_falkordb_target(h, p) must equal
    manually composing apply_local_dev_falkordb_override then
    _normalize_falkordb_host, in that order, for any (host, port) and env."""
    cases = [("localhost", 6379), ("127.0.0.1", 6379), ("falkordb", 6380), ("10.1.2.3", 6379)]

    # No override / no rewrite set (default env).
    for h, p in cases:
        manual_host, manual_port = apply_local_dev_falkordb_override(h, p)
        manual_host = _normalize_falkordb_host(manual_host)
        assert resolve_falkordb_target(h, p) == (manual_host, manual_port)

    # Override + rewrite both set.
    monkeypatch.setenv("LOCAL_DEV_FALKORDB_OVERRIDE", "1")
    monkeypatch.setenv("FALKORDB_HOST", "otherhost")
    monkeypatch.setenv("FALKORDB_DOCKER_LOCALHOST_REWRITE", "host.docker.internal")
    for h, p in cases:
        manual_host, manual_port = apply_local_dev_falkordb_override(h, p)
        manual_host = _normalize_falkordb_host(manual_host)
        assert resolve_falkordb_target(h, p) == (manual_host, manual_port)


# ── routing: all three call sites use the ONE function ──────────────

def test_manager_create_provider_instance_routes_through_resolve_falkordb_target():
    src = inspect.getsource(mgr.ProviderManager._create_provider_instance)
    assert "resolve_falkordb_target(" in src
    assert "apply_local_dev_falkordb_override(" not in src


def test_registry_factory_resolve_routes_through_resolve_falkordb_target():
    # _resolve is a closure nested in make_registry_graph_factory; inspect
    # the enclosing function's source to reach it.
    src = inspect.getsource(frg.make_registry_graph_factory)
    assert "resolve_falkordb_target(" in src
    assert "apply_local_dev_falkordb_override(" not in src
    assert "_normalize_falkordb_host(" not in src


def test_list_graph_keys_routes_through_resolve_falkordb_target():
    src = inspect.getsource(frg.list_graph_keys)
    assert "resolve_falkordb_target(" in src
    assert "apply_local_dev_falkordb_override(" not in src
    assert "_normalize_falkordb_host(" not in src


if __name__ == "__main__":
    import os as _os

    for _var in _ENV_VARS:
        _os.environ.pop(_var, None)
    test_resolve_localhost_default_pins_ipv4()
    test_resolve_falkordb_passthrough()
    test_resolve_remote_host_unchanged()
    test_manager_create_provider_instance_routes_through_resolve_falkordb_target()
    test_registry_factory_resolve_routes_through_resolve_falkordb_target()
    test_list_graph_keys_routes_through_resolve_falkordb_target()
    print("host resolution + routing (no-env cases): OK")
