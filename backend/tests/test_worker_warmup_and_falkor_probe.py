"""Two rotation-recovery gaps, closed.

1. ``start_provider_warmup`` — the shared starter used by BOTH the web tier and the
   aggregation worker. Each owns its own ProviderManager (separate pools/breakers), so
   each needs its own warmup loop: it is what drives ``record_probe_success`` on a
   provider's false→true transition, which force-closes the breakers AND evicts the
   cached provider so its pool is rebuilt against the new pod. Without it a process
   self-heals only via the 30s breaker cooldown while holding dead sockets.

2. ``probe_falkordb`` — on a CLUSTER, probing only the seed node would report the whole
   graph tier healthy while a rotating shard is down and a third of the graphs are
   unreadable. It must probe every primary and roll the verdicts up.
"""
import asyncio
import sys
import types

import pytest


# ── 1. shared warmup starter ─────────────────────────────────────────

class _FakeManager:
    """Just enough ProviderManager surface for the starter."""

    def __init__(self):
        self.warmup_cache: dict = {}
        self.warmup_last_cycle_at = None
        self.recovered: list = []
        self.failed: list = []

    def _create_provider_instance(self, *args, **kwargs):
        return object()

    async def record_probe_success(self, provider_id, **kw):
        self.recovered.append(provider_id)

    async def record_probe_failure(self, provider_id, **kw):
        self.failed.append(provider_id)


@pytest.mark.asyncio
async def test_start_provider_warmup_wires_manager_callbacks(monkeypatch):
    from backend.app.providers import warmup

    captured = {}

    async def fake_initial_pass(**kwargs):
        captured["initial"] = kwargs
        # Drive a recovery through the callback the starter supplied.
        await kwargs["on_recovery"]("prov_1", {"elapsed_ms": 5})

    async def fake_supervised(**kwargs):
        captured["supervised"] = kwargs
        await kwargs["on_failure"]("prov_2", {"reason": "tcp_refused", "elapsed_ms": 1})
        await kwargs["on_cycle_complete"]()

    monkeypatch.setattr(warmup, "initial_fast_pass", fake_initial_pass)
    monkeypatch.setattr(warmup, "supervised_warmup_loop", fake_supervised)

    mgr = _FakeManager()
    shutdown = asyncio.Event()
    tasks = await warmup.start_provider_warmup(mgr, shutdown_event=shutdown)
    await asyncio.gather(*tasks)

    # Both loops started, and both are wired to THIS manager's state machine.
    assert len(tasks) == 2
    assert mgr.recovered == ["prov_1"]        # → force-closes breakers + evicts pool
    assert mgr.failed == ["prov_2"]
    assert mgr.warmup_last_cycle_at is not None
    assert captured["supervised"]["shutdown_event"] is shutdown
    assert captured["initial"]["cache"] is mgr.warmup_cache


@pytest.mark.asyncio
async def test_start_provider_warmup_can_skip_initial_pass(monkeypatch):
    from backend.app.providers import warmup

    async def fake_supervised(**kwargs):
        return None

    monkeypatch.setattr(warmup, "supervised_warmup_loop", fake_supervised)
    tasks = await warmup.start_provider_warmup(
        _FakeManager(), shutdown_event=asyncio.Event(), initial_pass=False,
    )
    await asyncio.gather(*tasks)
    assert len(tasks) == 1


def test_worker_starts_the_warmup_loop():
    """The aggregation worker owns its own ProviderManager, so it must start its own
    warmup loop (this is the gap: it previously started none) and stop it on drain."""
    import inspect

    from backend.app.services.aggregation import __main__ as worker

    src = inspect.getsource(worker.main)
    assert "start_provider_warmup(" in src
    assert "warmup_shutdown.set()" in src


def test_web_and_worker_share_one_starter():
    """No copy-paste: main.py must use the same starter, not its own lister/builder."""
    import inspect

    from backend.app import main as app_main

    src = inspect.getsource(app_main)
    assert "start_provider_warmup(" in src
    # The old inline duplication is gone.
    assert "_list_providers_for_warmup" not in src


@pytest.mark.asyncio
async def test_warmup_probes_the_provider_s_own_topology(monkeypatch):
    """AUDIT FIX: the warmup lister must carry extra_config through to the probe.

    Without it every provider is probed as STANDALONE against its stored host:port
    — a Sentinel instance gets pinged wherever that row points and a Cluster
    instance at one seed — so the verdict describes a topology the read path never
    uses. That verdict drives record_probe_success/failure (breaker close + pool
    eviction), so a wrong probe corrupts recovery itself.
    """
    from backend.app.providers import warmup

    class _Row:
        id = "prov_cluster"
        provider_type = "falkordb"
        host = "seed-1"
        port = 6379
        tls_enabled = False
        credentials = None
        extra_config = (
            '{"falkordbConnection": {"mode": "cluster", '
            '"cluster": {"startupNodes": [["n1", 7000]]}}}'
        )

    class _FakeResult:
        def scalars(self):
            return self

        def all(self):
            return [_Row()]

    class _FakeSession:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def execute(self, *a, **k):
            # _list_providers now does ONE select(ProviderORM) + in-memory
            # decrypt (was N+1 get_credentials round-trips).
            return _FakeResult()

    from backend.app.db import engine as _engine

    monkeypatch.setattr(_engine, "get_provider_probe_session", lambda: _FakeSession())

    captured = {}

    async def fake_initial_pass(**kwargs):
        rows = await kwargs["list_providers"]()
        captured["rows"] = rows
        kwargs["build_instance"](rows[0])

    async def fake_supervised(**kwargs):
        return None

    monkeypatch.setattr(warmup, "initial_fast_pass", fake_initial_pass)
    monkeypatch.setattr(warmup, "supervised_warmup_loop", fake_supervised)

    mgr = _FakeManager()
    built = {}
    mgr._create_provider_instance = lambda *a: built.update(args=a) or object()

    tasks = await warmup.start_provider_warmup(mgr, shutdown_event=asyncio.Event())
    await asyncio.gather(*tasks)

    # The row snapshot carries the topology…
    assert captured["rows"][0]["extra_config"]["falkordbConnection"]["mode"] == "cluster"
    # …and it reaches _create_provider_instance as the extra_config argument (7th).
    assert built["args"][6]["falkordbConnection"]["mode"] == "cluster"


def _async_value(value):
    async def _coro():
        return value

    return _coro()


def test_outbound_provider_loader_passes_extra_config():
    """AUDIT FIX: _load_provider_for_outbound (used by discover_schema) dropped
    extra_config → a standalone client for a Sentinel/Cluster provider. The sibling
    /test endpoint always passed it; the two had drifted."""
    import inspect

    from backend.app.api.v1.endpoints import providers as prov_ep

    src = inspect.getsource(prov_ep._load_provider_for_outbound)
    assert "extra_config" in src
    assert "_create_provider_instance(" in src


def test_list_graphs_fans_out_on_cluster():
    """AUDIT FIX: a single-node GRAPH.LIST under-reports on a cluster (a node holds
    only its own slots' keys) — insights discovery would show a partial asset list."""
    import inspect

    from backend.app.providers.falkordb_provider import FalkorDBProvider

    src = inspect.getsource(FalkorDBProvider.list_graphs)
    assert "list_graph_keys_for_config" in src


def test_projection_mode_routes_proj_graph_on_cluster():
    """AUDIT FIX: {graph}_proj may hash to a DIFFERENT shard than {graph}; reusing
    the source graph's client sent AGGREGATED writes to the wrong node."""
    import inspect

    from backend.app.providers.falkordb_provider import FalkorDBProvider

    src = inspect.getsource(FalkorDBProvider.set_projection_mode)
    assert "build_graph_client" in src
    assert 'mode == "cluster"' in src


def test_orphan_drop_is_routed_to_its_provider():
    """AUDIT FIX: drop_graph(orphan) with no provider_id issued GRAPH.DELETE against
    the ENV instance — it would miss the orphan and could delete a same-named graph
    over there."""
    import inspect

    from backend.app.api.v1.endpoints import versioning as ver_ep

    src = inspect.getsource(ver_ep.project_now)
    assert "falkor_provider" in src
    assert "drop_graph(orphan," in src


# ── 2. topology-aware FalkorDB probe ─────────────────────────────────

@pytest.fixture
def fake_redis_for_probe(monkeypatch):
    """Fake redis.asyncio so probe_falkordb can build node clients."""
    state = {"down": set(), "graphs": {}}

    class FakeRedis:
        def __init__(self, host=None, port=None, **kwargs):
            self.host = host
            self.port = port

        async def ping(self):
            if f"{self.host}:{self.port}" in state["down"]:
                raise ConnectionError("connection refused")
            return True

        async def info(self, *a, **kw):
            return {"redis_version": "7.2.0", "aof_enabled": 1,
                    "aof_last_write_status": "ok", "rdb_last_bgsave_status": "ok"}

        async def execute_command(self, cmd, *a):
            return state["graphs"].get(f"{self.host}:{self.port}", [])

        async def aclose(self):
            return None

    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = FakeRedis
    redis_asyncio.from_url = lambda *a, **kw: FakeRedis()

    # `import redis.asyncio as aioredis` (what the probe does) binds the attribute off
    # the PARENT package, so patching sys.modules alone is not enough — the real
    # submodule would still be used and the probe would dial the live FalkorDB.
    import redis as _redis_pkg

    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setattr(_redis_pkg, "asyncio", redis_asyncio)
    return state


@pytest.mark.asyncio
async def test_probe_standalone_unchanged(fake_redis_for_probe, monkeypatch):
    monkeypatch.delenv("FALKORDB_MODE", raising=False)
    monkeypatch.setenv("FALKORDB_HOST", "falkordb")
    monkeypatch.setenv("FALKORDB_PORT", "6379")
    fake_redis_for_probe["graphs"]["falkordb:6379"] = ["g1", "g2"]

    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "healthy"
    assert res["detail"]["graphCount"] == 2
    assert res["detail"]["endpoint"] == "falkordb:6379"


@pytest.mark.asyncio
async def test_probe_cluster_all_shards_healthy(fake_redis_for_probe, monkeypatch):
    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    monkeypatch.setenv("FALKORDB_CLUSTER_NODES", "n1:7000,n2:7001")
    fake_redis_for_probe["graphs"] = {
        "n1:7000": ["a"], "n2:7001": ["b", "c"], "n3:7002": ["d"],
    }

    from backend.app.providers import falkordb_connection
    from backend.app.services.system_status import probes

    async def fake_primaries(cfg, timeout):
        return [("n1", 7000), ("n2", 7001), ("n3", 7002)]

    monkeypatch.setattr(falkordb_connection, "cluster_primary_nodes", fake_primaries)

    res = await probes.probe_falkordb()
    assert res["status"] == "healthy"
    assert res["detail"]["shardsTotal"] == 3 and res["detail"]["shardsUp"] == 3
    # Graph count is the SUM across shards — a single-seed probe would have said 1.
    assert res["detail"]["graphCount"] == 4
    assert len(res["detail"]["shards"]) == 3


@pytest.mark.asyncio
async def test_probe_cluster_degrades_when_a_shard_is_down(fake_redis_for_probe, monkeypatch):
    """The gap this closes: a healthy seed used to mask a dead shard."""
    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    monkeypatch.setenv("FALKORDB_CLUSTER_NODES", "n1:7000")
    fake_redis_for_probe["down"].add("n2:7001")
    fake_redis_for_probe["graphs"] = {"n1:7000": ["a"]}

    from backend.app.providers import falkordb_connection
    from backend.app.services.system_status import probes

    async def fake_primaries(cfg, timeout):
        return [("n1", 7000), ("n2", 7001)]

    monkeypatch.setattr(falkordb_connection, "cluster_primary_nodes", fake_primaries)

    res = await probes.probe_falkordb()
    assert res["status"] == "degraded"          # NOT "healthy"
    assert res["detail"]["shardsUp"] == 1 and res["detail"]["shardsTotal"] == 2
    assert "n2:7001" in res["error"]


@pytest.mark.asyncio
async def test_probe_cluster_down_when_all_shards_down(fake_redis_for_probe, monkeypatch):
    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    monkeypatch.setenv("FALKORDB_CLUSTER_NODES", "n1:7000")
    fake_redis_for_probe["down"].update({"n1:7000", "n2:7001"})

    from backend.app.providers import falkordb_connection
    from backend.app.services.system_status import probes

    async def fake_primaries(cfg, timeout):
        return [("n1", 7000), ("n2", 7001)]

    monkeypatch.setattr(falkordb_connection, "cluster_primary_nodes", fake_primaries)

    res = await probes.probe_falkordb()
    assert res["status"] == "down"


@pytest.mark.asyncio
async def test_probe_cluster_topology_unreachable_is_down(fake_redis_for_probe, monkeypatch):
    """No topology at all → the cluster is unreachable from here, which IS the fault
    (never report healthy just because discovery failed)."""
    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    monkeypatch.setenv("FALKORDB_CLUSTER_NODES", "n1:7000")

    from backend.app.providers import falkordb_connection
    from backend.app.services.system_status import probes

    async def boom(cfg, timeout):
        raise ConnectionError("no route to cluster")

    monkeypatch.setattr(falkordb_connection, "cluster_primary_nodes", boom)

    res = await probes.probe_falkordb()
    assert res["status"] == "down"
    assert res["detail"]["mode"] == "cluster"
