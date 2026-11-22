"""The live facts the registry's recommendations read (``services.settings.facts``): each one that
can be read, and none guessed for one that can't."""
from __future__ import annotations

from types import SimpleNamespace

from backend.app.services.settings import facts
from backend.app.services.versioning import config


def _node(endpoint, used, maxmemory):
    return SimpleNamespace(endpoint=endpoint,
                           memory=SimpleNamespace(used=used, maxmemory=maxmemory))


async def test_every_fact_that_can_be_read(monkeypatch):
    async def graphs():
        return 13 * 2 ** 30, 7

    async def topology():
        return SimpleNamespace(instances=[SimpleNamespace(shards=[
            SimpleNamespace(master=_node("falkor-0:6379", 6 * 2 ** 30, 16 * 2 ** 30)),
            SimpleNamespace(master=_node("falkor-1:6379", 2 * 2 ** 30, 0)),
            SimpleNamespace(master=_node("falkor-2:6379", None, 16 * 2 ** 30))])])

    from backend.app.services.graph_store import topology as graph_store

    monkeypatch.setattr(facts, "_graphs", graphs)
    monkeypatch.setattr(graph_store, "get_topology_snapshot", topology)
    monkeypatch.setenv("GUNICORN_WORKERS", "4")
    assert await facts.collect() == {
        "graphCount": 7, "largestGraphBytes": 13 * 2 ** 30,
        "nodes": [{"name": "falkor-0:6379", "usedBytes": 6 * 2 ** 30, "maxBytes": 16 * 2 ** 30},
                  {"name": "falkor-1:6379", "usedBytes": 2 * 2 ** 30, "maxBytes": None}],
        "poolSize": config.POOL_SIZE + config.POOL_MAX_OVERFLOW,
        "projectionConcurrency": config.PROJECTION_CONCURRENCY,
        "readerProcesses": 4}


async def test_a_fact_that_cant_be_read_is_left_out(monkeypatch):
    async def unreachable(*_a, **_k):
        raise ConnectionError("out of reach")

    async def unmeasured():
        return None, 0

    from backend.app.services.graph_store import topology as graph_store

    monkeypatch.setattr(facts, "_graphs", unreachable)
    monkeypatch.setattr(graph_store, "get_topology_snapshot", unreachable)
    monkeypatch.delenv("GUNICORN_WORKERS", raising=False)
    assert set(await facts.collect()) == {"poolSize", "projectionConcurrency"}
    monkeypatch.setattr(facts, "_graphs", unmeasured)
    assert {k: v for k, v in (await facts.collect()).items()
            if k in ("graphCount", "largestGraphBytes")} == {"graphCount": 0}
