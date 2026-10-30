"""Reads and residency (doc 17): what a person's read of a versioned graph out of FalkorDB asks
for, and what FalkorDB-only work answers meanwhile.

ContextEngine calls ``residency.on_read`` once per engine. A person's read (a background job
passes no viewer) is noted for the graph whose key serves it — a fork's root — and each process
flushes what it noted once a minute, in one UPDATE that never moves a read back; a read FalkorDB
serves also takes the graph's read lease, so a graph mid-read is never evicted. For a read of a
graph whose key is not in FalkorDB — evicted, waiting for room or being
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
from backend.app.services.versioning import cache_manager, config, residency, residency_policy
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


def _wm(status="idle", residency_class="standard", size=None, fresh=None):
    return {"status": status, "residency": residency_class, "size_bytes": size, "committed": 7,
            "fresh": status == "idle" if fresh is None else fresh}


def _loads(asked) -> list:
    return [x for x in asked if isinstance(x, str)]


@pytest.fixture
def asked(monkeypatch):
    """The loads asked for, and a clean slate for the request's reading."""
    out = []

    async def request_load(gid):
        out.append(gid)

    async def no_count(graph_id, data_source_id, head):
        return None

    async def lease(gid, ttl=None):
        out.append(("lease", gid, ttl))
        return True

    monkeypatch.setattr(config, "RESIDENCY_ENABLED", True)
    monkeypatch.setattr(residency, "request_load", request_load)
    monkeypatch.setattr(residency, "_entity_count", no_count)
    monkeypatch.setattr(cache_manager, "acquire_lease", lease)
    monkeypatch.setattr(residency, "_note_read", lambda gid: out.append(("read", gid)))
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
    assert _loads(asked) == (["g"] if loads else [])


async def test_a_coldline_graph_whose_count_is_past_the_threshold_loads(asked, monkeypatch):
    """Its nodes and edges at the main head, as graphver counts them, kept per head: the next read
    asks nothing of the database."""
    counted = []

    async def count(graph_id, data_source_id, head):
        counted.append((graph_id, head))
        residency._COUNTS[(graph_id, head)] = 500_001
        return 500_001

    monkeypatch.setattr(residency, "_entity_count", count)
    try:
        await _read(_Svc({"g": _wm("evicted", "coldline")}))
        await _read(_Svc({"g": _wm("evicted", "coldline")}))
        assert _loads(asked) == ["g", "g"] and counted == [("g", 7)]
    finally:
        residency._COUNTS.clear()


async def test_a_resident_graph_asks_for_nothing_and_says_nothing(asked):
    assert await _read(_Svc({"g": _wm()})) is None and _loads(asked) == []


async def test_a_background_read_neither_asks_nor_marks_the_request(asked):
    assert await _read(_Svc({"g": _wm("evicted")}), viewer=None) is None and asked == []


async def test_with_residency_off_nothing_changes(asked, monkeypatch):
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", False)
    assert await _read(_Svc({"g": _wm("evicted")})) is None and asked == []


async def test_a_fork_reads_through_its_root(asked):
    svc = _Svc({"root": _wm("evicted")}, parents={"fork2": "fork1", "fork1": "root"})
    reading = await _read(svc, "fork2")
    assert reading.graph_id == "root" and _loads(asked) == ["root"]


async def test_the_engine_s_own_watermark_is_used_for_a_graph_that_is_not_a_fork(asked):
    reading = await _read(_Svc({}), wm=_wm("evicted"))
    assert reading.graph_id == "g" and _loads(asked) == ["g"]


# ── what FalkorDB-only work answers meanwhile ────────────────────────────────────────────────────
async def test_deep_search_on_a_graph_out_of_falkordb_is_a_503_that_asks_for_the_load(asked):
    residency.READING.set(residency.Reading(graph_id="g", state="evicted", retry_after=45))
    exc = G._map_not_implemented(SimpleNamespace(), NotImplementedError("the graph is catching up"))
    assert exc.status_code == 503 and exc.headers == {"Retry-After": "45"}
    assert exc.detail["type"] == "graph_loading" and exc.detail["retryAfter"] == 45
    await asyncio.sleep(0)
    assert _loads(asked) == ["g"]


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
    assert _loads(asked) == ["g"]


# ── who else reads a key ─────────────────────────────────────────────────────────────────────────
async def test_the_keys_other_readers_hold_are_found_in_two_reads(monkeypatch):
    """A key another live data source reads (by name, or as its dedicated key) through the same
    server, or a catalog entry publishes, is held; the graph's own data source is not another."""
    from backend.app.services import managed_sources

    async def servers(session, provider_id):
        return {None: ["default", "prov_alias"], "default": ["default", "prov_alias"],
                "prov_b": ["prov_b"]}[provider_id]

    reads = []

    class _Session:
        async def execute(self, stmt):
            reads.append(stmt)
            rows = ([("ds_own", "default", "k_own", None), ("ds_other", "prov_alias", None, "k_ded"),
                     ("ds_far", "prov_far", "k_far", None)] if len(reads) == 1
                    else [("prov_b", "k_cat")])
            return SimpleNamespace(all=lambda: rows)

    monkeypatch.setattr(managed_sources, "same_server_providers", servers)
    held = await managed_sources.keys_read_elsewhere(_Session(), [
        (None, "k_own", "ds_own"), ("default", "k_ded", "ds_mine"), ("default", "k_far", "ds_x"),
        ("prov_b", "k_cat", "ds_y"), ("prov_b", "k_free", "ds_z")])
    assert held == {("default", "k_ded"), ("prov_b", "k_cat")} and len(reads) == 2
    assert await managed_sources.keys_read_elsewhere(_Session(), []) == set()


# ── the stats probe ──────────────────────────────────────────────────────────────────────────────
async def test_the_stats_probe_skips_a_graph_out_of_falkordb(monkeypatch):
    """Its key is gone: a probe would read an empty graph and record 0 nodes and 0 edges."""
    from backend.app.services.aggregation.service import AggregationService

    asked = []

    class _Registry:
        async def get_provider_for_workspace(self, *a, **kw):
            asked.append("provider")
            raise AssertionError("the probe must not read FalkorDB")

    async def out(ds_id):
        return "g_evicted"

    monkeypatch.setattr(residency, "non_resident", out)
    probe = SimpleNamespace(_registry=_Registry())
    assert await AggregationService._probe_live_stats(probe, "ws1", "ds1", None) == (
        None, None, None)
    assert asked == []


# ── read tracking and the read lease ─────────────────────────────────────────────────────────────
async def test_a_person_s_read_is_noted_and_a_read_falkordb_serves_takes_the_lease(asked):
    await _read(_Svc({"g": _wm()}))
    assert asked == [("read", "g"), ("lease", "g", config.TRACE_LEASE_TTL_SECS)]


async def test_a_read_postgres_serves_is_noted_and_takes_no_lease(asked):
    await _read(_Svc({"g": _wm("idle", fresh=False)}))             # the projection lags
    await _read(_Svc({"g": _wm("evicted")}))
    assert [x for x in asked if isinstance(x, tuple)] == [("read", "g"), ("read", "g")]


async def test_a_fork_s_read_counts_for_its_root_and_leases_the_root(asked):
    svc = _Svc({"root": _wm()}, parents={"fork2": "fork1", "fork1": "root"})
    await _read(svc, "fork2")
    assert asked == [("read", "root"), ("lease", "root", config.TRACE_LEASE_TTL_SECS)]


async def test_a_background_read_is_not_noted(asked):
    await _read(_Svc({"g": _wm()}), viewer=None)
    assert asked == []


async def test_with_residency_off_no_read_is_noted(asked, monkeypatch):
    monkeypatch.setattr(config, "RESIDENCY_ENABLED", False)
    await _read(_Svc({"g": _wm()}))
    assert asked == []


async def test_reads_are_noted_once_a_graph_and_kept_when_a_flush_fails(monkeypatch):
    """The map keeps each graph's latest read; a flush that cannot write puts the reads back,
    keeping a later one noted meanwhile, for the next flush."""
    residency._READS.clear()
    monkeypatch.setattr(residency, "_ensure_flusher", lambda: None)
    residency._note_read("g1")
    first = residency._READS["g1"]
    residency._note_read("g1")
    residency._note_read("g2")
    assert set(residency._READS) == {"g1", "g2"} and residency._READS["g1"] >= first

    class _Broken:
        async def __aenter__(self):
            raise RuntimeError("graphver is down")

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(residency.db, "graphver_session", lambda: _Broken())
    assert await residency.flush_reads() == 0
    assert set(residency._READS) == {"g1", "g2"}
    residency._READS.clear()
