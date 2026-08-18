"""WS2.1: the provider cache Redis is decoupled from FalkorDB.

Three guarantees:
1. ``build_cache_client`` NEVER builds a client on the FalkorDB instance —
   without a dedicated cache endpoint it returns None (cache disabled), for
   every FalkorDB topology (standalone / sentinel / cluster). Covered in
   test_falkordb_connection.py / test_cache_client_endpoint.py.
2. Deployed roles fail fast at startup when a Redis endpoint they actually
   use is unresolvable. STREAMS is a single fleet-wide coordination endpoint
   with no per-provider override, so it must always resolve. The CACHE role
   may be configured purely per-provider (extra_config.cacheConnection), so
   a missing GLOBAL cache endpoint is resolved and logged, never enforced —
   the old guard only checked the env CACHE_REDIS_URL, which made that
   deployment shape fail to boot. DEV degrades gracefully for both.
3. Decoupled means the read path DEGRADES without the cache, never breaks:
   with no cache client the ancestor path computes uncached instead of
   discarding chains it had already computed.
"""
import asyncio

import pytest

from backend.app.providers import manager as mgr
from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.runtime.role import SynodicRole

_DEPLOYED = [SynodicRole.WEB, SynodicRole.WORKER, SynodicRole.CONTROLPLANE]

_REDIS_VARS = ["CACHE_REDIS_URL", "REDIS_URL", "REDIS_STREAMS_HOST", "REDIS_CACHE_HOST"]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for v in _REDIS_VARS:
        monkeypatch.delenv(v, raising=False)


def test_guard_dev_without_redis_is_ok(monkeypatch):
    monkeypatch.setattr(
        "backend.app.runtime.role.current_role", lambda: SynodicRole.DEV
    )
    mgr._assert_redis_roles_configured()  # must not raise


@pytest.mark.parametrize("role", _DEPLOYED)
def test_guard_deployed_streams_unconfigured_fails_fast(monkeypatch, role):
    monkeypatch.setattr("backend.app.runtime.role.current_role", lambda: role)
    with pytest.raises(RuntimeError, match="STREAMS"):
        mgr._assert_redis_roles_configured()


@pytest.mark.parametrize("role", _DEPLOYED)
def test_guard_deployed_cache_unconfigured_does_not_fail(monkeypatch, role):
    # The CACHE role may be configured purely per-provider — a deployment
    # with no GLOBAL cache endpoint must still boot (only STREAMS is required).
    monkeypatch.setattr("backend.app.runtime.role.current_role", lambda: role)
    monkeypatch.setenv("REDIS_STREAMS_HOST", "streams.internal")
    mgr._assert_redis_roles_configured()  # must not raise


@pytest.mark.parametrize("role", _DEPLOYED)
def test_guard_deployed_with_dedicated_cache_is_ok(monkeypatch, role):
    monkeypatch.setattr("backend.app.runtime.role.current_role", lambda: role)
    monkeypatch.setenv("REDIS_STREAMS_HOST", "streams.internal")
    monkeypatch.setenv("CACHE_REDIS_URL", "redis://dedicated-cache:6379/1")
    mgr._assert_redis_roles_configured()  # must not raise


def test_ancestor_chains_survive_a_cache_outage():
    """Guarantee 3, the one that bit: the store-back used to run unguarded, so
    with no cache client it raised on the WRITE — and the raise escaped the
    whole method, throwing away chains that had just been computed
    successfully. Callers saw `truncated: ancestors_failed` and a trace with NO
    containment tree, i.e. a cache outage silently breaking the graph read
    path: the exact inverse of what decoupling the cache was for."""
    provider = FalkorDBProvider(host="x", graph_name="g")
    provider._redis = None   # build_cache_client returns None with no cache URL

    async def _chains(urns):
        return {u: [f"parent-of-{u}"] for u in urns}

    provider._compute_ancestor_chains_bulk_cypher = _chains

    chains = asyncio.run(provider._compute_and_store_ancestors_bulk(["a", "b"]))

    assert chains == {"a": ["parent-of-a"], "b": ["parent-of-b"]}


class _Rows:
    """Minimal stand-in for a FalkorDB query result."""

    def __init__(self, rows):
        self.result_set = rows


def test_urn_labels_survive_a_cache_outage():
    """Guarantee 3 again, one layer down — the URN→label cache. Its store-back
    pipeline was opened INSIDE the try that also assigns the output map, so with
    no cache client it raised BEFORE a single resolved label was recorded: the
    whole batch degraded to label ``None`` and every reader fell onto the
    unlabeled full-scan path — the 4-9s-on-2M-nodes antipattern this very cache
    exists to avoid. A cache outage must cost the WRITE, never the answer."""
    provider = FalkorDBProvider(host="x", graph_name="g")
    provider._redis = None   # build_cache_client returns None with no cache URL

    async def _ro_query(cypher, params=None, **kw):
        if "db.labels()" in cypher:
            return _Rows([["Column"], ["Table"]])
        seeded = {"Column": {"a"}, "Table": {"b"}}
        for label, urns in seeded.items():
            if f"(n:{label})" in cypher:
                return _Rows([[u] for u in (params or {}).get("urns", []) if u in urns])
        return _Rows([])

    provider._ro_query = _ro_query

    labels = asyncio.run(provider._resolve_urn_labels_bulk(["a", "b"]))

    assert labels == {"a": "Column", "b": "Table"}
