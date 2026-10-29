"""The neighbors read never comes from a key that holds nothing published yet.

With ``GRAPHVER_READ_MAX_LAG`` above zero a lagging projection may serve main, but a key at
projected 0 is empty or mid-reconcile — just moved, rebuilt or reseeding — so a graph with a
small head must still read from Postgres until the key catches up.

Pure unit tests — ``_serve_neighbors`` is called directly with a stub service and read factory.
"""
import asyncio
from types import SimpleNamespace

import pytest

import backend.app.api.v1.endpoints.versioning as V


@pytest.fixture(autouse=True)
def _lag(monkeypatch):
    async def lease(graph_id):
        return None

    async def falkor_neighbors(graph, **kw):
        return {"nodes": [], "edges": []}

    monkeypatch.setattr(V.vconfig, "READ_MAX_LAG", 5)
    monkeypatch.setattr(V, "acquire_lease", lease)
    monkeypatch.setattr(V, "release_lease", lease)
    monkeypatch.setattr(V, "_falkor_neighbors", falkor_neighbors)


def _serve(projected: int, status: str):
    opened = []

    async def watermark(graph_id):
        return {"committed": 3, "projected": projected, "fresh": projected >= 3, "status": status,
                "falkor_graph_name": "gvp_k", "falkor_provider": "prov_b"}

    async def main_branch_id(graph_id):
        return "b_main"

    async def from_state(**kw):
        return {"nodes": [], "edges": []}

    def read_factory(name, provider_id=None):
        opened.append((provider_id, name))
        return object()

    svc = SimpleNamespace(projection_watermark=watermark, main_branch_id=main_branch_id,
                          neighbors_from_state=from_state)
    out = asyncio.run(V._serve_neighbors(svc, read_factory, "g1", urn="u", depth=1,
                                         direction="both", edge_types=None, limit=10))
    return out["source"], opened


def test_a_key_at_projected_zero_is_not_read():
    assert _serve(0, "reseeding") == ("postgres", [])


def test_a_key_within_the_lag_is_still_read():
    # Regression guard: within the lag and published, the key serves as before.
    assert _serve(1, "idle") == ("falkordb", [("prov_b", "gvp_k")])
