"""The graph store routes: who may read what, and what they answer.

The gates differ by route on purpose and that is worth pinning: the fleet
view is an administrator's picture of the infrastructure, while "which
node holds this source's graph" belongs to reading the source — the
Freshness drawer and a data source's own page show it, and those are not
admin-only surfaces.
"""
from __future__ import annotations

import asyncio
import types

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import graph_store as gs
from backend.app.services.graph_store import topology
from backend.app.services.graph_store.schemas import (
    GraphStoreInstance,
    GraphStoreNode,
    GraphStoreShard,
    GraphStoreTopologyResponse,
    InstanceTotals,
    ProviderRef,
)


def _run(coro):
    return asyncio.run(coro)


def _dep_calls(dependant):
    out = [dependant.call]
    for d in dependant.dependencies:
        out += _dep_calls(d)
    return out


def _route(path, method="GET"):
    return next(r for r in gs.router.routes
                if r.path == path and method in r.methods)


def _snapshot(*, graphs=("g1",), reachable=True):
    master = GraphStoreNode(endpoint="10.0.0.1:6379", node_id="m1", role="master")
    replica = GraphStoreNode(endpoint="10.0.0.4:6379", node_id="r1", role="replica")
    shard = GraphStoreShard(
        index=0, slot_ranges=[[0, 16383]], slot_count=16384,
        master=master, replicas=[replica],
        graphs=[], graphs_total=0,
    )
    from backend.app.services.graph_store.schemas import GraphOnShard

    shard.graphs = [
        GraphOnShard(key=k, slot=topology.key_slot(k), present=True) for k in graphs
    ]
    shard.graphs_total = len(shard.graphs)
    instance = GraphStoreInstance(
        id="inst1", providers=[ProviderRef(id="p1", name="Falkor")],
        mode="cluster", reachable=reachable, shards=[shard],
        totals=InstanceTotals(masters=1, replicas=1, nodes_up=2, nodes_total=2),
    )
    return GraphStoreTopologyResponse(instances=[instance], measured_at="2026-09-09T00:00:00Z")


def _wire(monkeypatch, snapshot=None, *, data_sources=(), boom=None):
    async def _get(*, fresh=False):
        if boom is not None:
            raise boom
        return snapshot if snapshot is not None else _snapshot()

    monkeypatch.setattr(topology, "get_topology_snapshot", _get)

    class _Result:
        def __init__(self, rows):
            self._rows = rows

        def scalars(self):
            return types.SimpleNamespace(all=lambda: list(self._rows))

    class _Session:
        async def execute(self, query):
            return _Result(list(data_sources))

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    monkeypatch.setattr(topology, "_session_factory", lambda: (lambda: _Session()))


def _ds(ds_id="ds1", *, provider="p1", graph="g1", mode=None, dedicated=None):
    return types.SimpleNamespace(
        id=ds_id, provider_id=provider, graph_name=graph,
        projection_mode=mode, dedicated_graph_name=dedicated, deleted_at=None,
    )


# ── gates ────────────────────────────────────────────────────────────────


def test_the_fleet_view_is_administrators_only():
    for path in ("/topology", "/providers/{provider_id}"):
        assert gs._REQUIRE_SYSTEM_ADMIN in _dep_calls(_route(path).dependant), path


def test_placement_rides_the_ingestion_read_gate_not_system_admin():
    """A data source's own page shows where its graph lives; gating that on
    system:admin would hide placement from the people who read the source."""
    for path in ("/placement", "/placements"):
        calls = _dep_calls(_route(path).dependant)
        assert gs._require_ingestion_read in calls, path
        assert gs._REQUIRE_SYSTEM_ADMIN not in calls, path


# ── answers ──────────────────────────────────────────────────────────────


def test_the_topology_route_serves_the_snapshot(monkeypatch):
    _wire(monkeypatch)
    out = _run(gs.get_topology(fresh=False))
    assert out.summary.instances == 0 or out.instances[0].id == "inst1"
    assert out.instances[0].shards[0].master.endpoint == "10.0.0.1:6379"


def test_a_provider_with_no_store_in_the_snapshot_is_a_404(monkeypatch):
    _wire(monkeypatch)
    assert _run(gs.get_provider_topology("p1")).instance.id == "inst1"
    with pytest.raises(HTTPException) as exc:
        _run(gs.get_provider_topology("p-unknown"))
    assert exc.value.status_code == 404


def test_no_snapshot_at_all_is_a_503_that_says_why(monkeypatch):
    _wire(monkeypatch, boom=RuntimeError("database unavailable"))
    with pytest.raises(HTTPException) as exc:
        _run(gs.get_topology())
    assert exc.value.status_code == 503
    assert exc.value.detail["code"] == "GRAPH_STORE_TOPOLOGY_UNAVAILABLE"
    assert "database unavailable" in exc.value.detail["reason"]


def test_a_stale_snapshot_is_served_rather_than_refused(monkeypatch):
    """Figures from a minute ago beat an empty page — the response says so
    instead of erroring."""
    stale = _snapshot().model_copy(update={"stale": True, "last_error": "bus down"})
    _wire(monkeypatch, stale)
    out = _run(gs.get_topology())
    assert out.stale and out.last_error == "bus down"
    assert out.instances[0].shards[0].master.endpoint == "10.0.0.1:6379"


def test_placement_answers_for_a_data_source_including_its_projection(monkeypatch):
    ds = _ds(graph="g1", mode="dedicated", dedicated="g1_proj")
    _wire(monkeypatch, _snapshot(graphs=("g1", "g1_proj")), data_sources=[ds])
    out = _run(gs.get_placement(dataSourceId="ds1", providerId=None, graph=None))
    assert out.provider_id == "p1" and out.mode == "cluster" and out.reachable
    assert [(p.role, p.graph_key) for p in out.placements] == [
        ("source", "g1"), ("projection", "g1_proj"),
    ]
    assert out.placements[0].master.endpoint == "10.0.0.1:6379"
    assert [r.endpoint for r in out.placements[0].replicas] == ["10.0.0.4:6379"]


def test_placement_by_provider_and_graph_serves_a_catalogue_keyed_view(monkeypatch):
    _wire(monkeypatch)
    out = _run(gs.get_placement(dataSourceId=None, providerId="p1", graph="g1"))
    assert [p.graph_key for p in out.placements] == ["g1"]
    assert out.data_source_id is None


def test_placement_needs_something_to_look_up(monkeypatch):
    _wire(monkeypatch)
    with pytest.raises(HTTPException) as exc:
        _run(gs.get_placement(dataSourceId=None, providerId=None, graph=None))
    assert exc.value.status_code == 400


def test_an_unknown_data_source_is_a_404(monkeypatch):
    _wire(monkeypatch, data_sources=[])
    with pytest.raises(HTTPException) as exc:
        _run(gs.get_placement(dataSourceId="ds-missing", providerId=None, graph=None))
    assert exc.value.status_code == 404


def test_the_batch_answers_one_chip_per_source_and_is_capped(monkeypatch):
    """A list surface asks once for every visible row, so the batch must be
    one request and bounded."""
    sources = [_ds(f"ds{i}", graph=f"g{i}") for i in range(5)]
    _wire(monkeypatch, _snapshot(graphs=tuple(f"g{i}" for i in range(5))),
          data_sources=sources)
    out = _run(gs.get_placements(dataSourceIds="ds0, ds1 ,ds2,ds3,ds4"))
    assert set(out.placements) == {f"ds{i}" for i in range(5)}
    assert out.placements["ds2"].master == "10.0.0.1:6379"
    assert out.placements["ds2"].graph_key == "g2" and out.placements["ds2"].present
    assert gs._MAX_BATCH == 200


def test_a_provider_the_snapshot_never_read_still_answers_with_the_reason(monkeypatch):
    _wire(monkeypatch, data_sources=[_ds(provider="p-other")])
    out = _run(gs.get_placement(dataSourceId="ds1", providerId=None, graph=None))
    assert not out.reachable
    assert "has not been read" in (out.error or "")
    assert out.placements and out.placements[0].master is None
