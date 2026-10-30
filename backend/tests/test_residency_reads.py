"""Reads and residency (doc 17): what a person's read of a versioned graph out of FalkorDB asks
for, and what FalkorDB-only work answers meanwhile.

ContextEngine calls ``residency.on_read`` once per engine. For a person's read (a background job
passes no viewer) of a graph whose key is not in FalkorDB — evicted, waiting for room or being
loaded — the read is served from Postgres and the request remembers which graph it is
(``residency.READING``): deep search, node degrees and native queries then answer 503
``graph_loading`` with Retry-After and ask for the load. A Standard or Always graph's load is asked
for by any read, a Coldline graph's only by such FalkorDB-only work or by a canvas read of a graph
larger than the canvas-load threshold. A fork reads through its root, so it is the root's load.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import graph as G
from backend.app.services.versioning import config, residency, residency_policy
from backend.app.services.versioning.service import Viewer

_VIEWER = Viewer(actor="usr_1", can_read=True)


class _Svc:
    def __init__(self, wms: dict, parents: dict = None):
        self.wms, self.parents = wms, parents or {}

    async def get_graph(self, gid):
        return {"graph_id": gid, "data_source_id": f"ds_{gid}",
                "fork_parent_graph_id": self.parents.get(gid)}

    async def projection_watermark(self, gid):
        return self.wms[gid]


def _wm(status="idle", residency_class="standard", size=None):
    return {"status": status, "residency": residency_class, "size_bytes": size}


@pytest.fixture
def asked(monkeypatch):
    """The loads asked for, and a clean slate for the request's reading."""
    out = []

    async def request_load(gid):
        out.append(gid)

    async def no_entities(ids):
        return {}

    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    monkeypatch.setattr(residency, "request_load", request_load)
    monkeypatch.setattr(residency, "_entities", no_entities)
    residency_policy._MEMO.update(policy=residency_policy.defaults(), at=residency_policy._clock())
    residency.READING.set(None)
    yield out
    residency.READING.set(None)
    residency_policy.invalidate()


async def _read(svc, gid="g", *, viewer=_VIEWER, wm=None):
    await residency.on_read(svc, await svc.get_graph(gid), viewer=viewer, wm=wm)
    return residency.READING.get()


@pytest.mark.parametrize("status, residency_class, size, loads", [
    ("evicted", "standard", None, True),
    ("waiting_capacity", "always", None, True),
    ("evicted", "coldline", 550 * 10, False),               # 10 entities: a canvas reads Postgres
    ("evicted", "coldline", 550 * 600_000, True),           # past the 500,000 threshold
    ("rehydrating", "standard", None, False),               # its load is under way
])
async def test_a_read_of_a_graph_out_of_falkordb_and_the_load_it_asks_for(
        asked, status, residency_class, size, loads):
    reading = await _read(_Svc({"g": _wm(status, residency_class, size)}))
    assert reading == residency.Reading(graph_id="g", state=status, retry_after=60)
    assert asked == (["g"] if loads else [])


async def test_a_coldline_graph_whose_statistics_count_past_the_threshold_loads(asked, monkeypatch):
    async def entities(ids):
        return {"ds_g": 500_001}

    monkeypatch.setattr(residency, "_entities", entities)
    await _read(_Svc({"g": _wm("evicted", "coldline")}))
    assert asked == ["g"]


async def test_a_resident_graph_asks_for_nothing_and_says_nothing(asked):
    assert await _read(_Svc({"g": _wm()})) is None and asked == []


async def test_a_background_read_neither_asks_nor_marks_the_request(asked):
    assert await _read(_Svc({"g": _wm("evicted")}), viewer=None) is None and asked == []


async def test_with_residency_off_nothing_changes(asked, monkeypatch):
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", False)
    assert await _read(_Svc({"g": _wm("evicted")})) is None and asked == []


async def test_a_fork_reads_through_its_root(asked):
    svc = _Svc({"root": _wm("evicted")}, parents={"fork2": "fork1", "fork1": "root"})
    reading = await _read(svc, "fork2")
    assert reading.graph_id == "root" and asked == ["root"]


async def test_the_engine_s_own_watermark_is_used_for_a_graph_that_is_not_a_fork(asked):
    reading = await _read(_Svc({}), wm=_wm("evicted"))
    assert reading.graph_id == "g" and asked == ["g"]


# ── what FalkorDB-only work answers meanwhile ────────────────────────────────────────────────────
async def test_deep_search_on_a_graph_out_of_falkordb_is_a_503_that_asks_for_the_load(asked):
    residency.READING.set(residency.Reading(graph_id="g", state="evicted", retry_after=45))
    exc = G._map_not_implemented(SimpleNamespace(), NotImplementedError("the graph is catching up"))
    assert exc.status_code == 503 and exc.headers == {"Retry-After": "45"}
    assert exc.detail["type"] == "graph_loading" and exc.detail["retryAfter"] == 45
    await asyncio.sleep(0)
    assert asked == ["g"]


async def test_deep_search_on_a_graph_in_falkordb_is_refused_as_before(asked):
    exc = G._map_not_implemented(SimpleNamespace(), NotImplementedError("the graph is catching up"))
    assert exc.status_code == 501 and exc.detail == "the graph is catching up" and asked == []


async def test_node_degrees_on_a_graph_out_of_falkordb_is_a_503(asked, monkeypatch):
    class _Engine:
        async def get_node_degrees(self, urns, edge_types, include_rollups=False):
            raise NotImplementedError("a versioned branch cannot count degrees")

    monkeypatch.setattr(G, "_cache_scope", lambda engine: None)
    monkeypatch.setattr(G, "_bounded_compute", lambda engine, fn: fn)
    query = G.NodeDegreeQuery.model_validate({"urns": ["urn:a"]})
    with pytest.raises(G.HTTPException) as caught:
        await G.get_node_degrees(SimpleNamespace(headers={}), query, engine=_Engine())
    assert caught.value.status_code == 501
    residency.READING.set(residency.Reading(graph_id="g", state="waiting_capacity", retry_after=60))
    with pytest.raises(G.HTTPException) as caught:
        await G.get_node_degrees(SimpleNamespace(headers={}), query, engine=_Engine())
    assert caught.value.status_code == 503 and caught.value.detail["type"] == "graph_loading"
    await asyncio.sleep(0)
    assert asked == ["g"]
