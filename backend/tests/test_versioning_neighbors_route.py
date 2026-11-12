"""The neighbors read comes from the key while it serves a version of main, never from one that
holds nothing published.

While the projection catches up, the key serves the version it last published, and during a
rebuild in place, which resets the watermark to 0, the version it held when the rebuild began
(``served_commit_seq``). A key that holds no version (a first seed, a move, an Adopt, a reset) is
empty or partial, so its graph reads from Postgres until the key has one. ``GRAPHVER_READ_MAX_LAG``
caps how far behind the key may serve.

Pure unit tests — ``_serve_neighbors`` is called directly with a stub service and read factory, and
the watermark's ``served`` is the service's own rule (``serving_seq``).
"""
import asyncio
from types import SimpleNamespace

import pytest

import backend.app.api.v1.endpoints.versioning as V
from backend.app.services.versioning.service import serving_seq


@pytest.fixture(autouse=True)
def _lag(monkeypatch):
    async def lease(graph_id):
        return None

    async def falkor_neighbors(graph, **kw):
        return {"nodes": [], "edges": []}

    monkeypatch.setattr(V, "acquire_lease", lease)
    monkeypatch.setattr(V, "release_lease", lease)
    monkeypatch.setattr(V, "_falkor_neighbors", falkor_neighbors)


def _serve(projected: int, status: str, fork: bool = False, held=None):
    opened = []

    async def watermark(graph_id):
        return {"committed": 3, "projected": projected, "fresh": projected >= 3, "status": status,
                "served": serving_seq(projected, 3, status, held),
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
                                         direction="both", edge_types=None, limit=10, fork=fork))
    return out["source"], opened, out["watermark"]["served"]


def test_a_key_at_projected_zero_is_not_read():
    assert _serve(0, "reseeding") == ("postgres", [], None)
    # Written from nothing (a move, a first seed): no version to serve yet.
    assert _serve(0, "rebuilding") == ("postgres", [], None)


def test_a_key_catching_up_serves_the_version_it_last_published():
    assert _serve(2, "projecting") == ("falkordb", [("prov_b", "gvp_k")], 2)
    # At genesis, the empty first commit, it holds nothing anyone published.
    assert _serve(1, "projecting") == ("postgres", [], None)


def test_a_key_rebuilt_in_place_serves_the_version_it_held():
    assert _serve(0, "rebuilding", held=2) == ("falkordb", [("prov_b", "gvp_k")], 2)
    # Out of FalkorDB or being loaded, whatever it held: Postgres.
    assert _serve(0, "evicted", held=2) == ("postgres", [], None)
    assert _serve(0, "rehydrating", held=2) == ("postgres", [], None)


def test_read_max_lag_caps_how_far_behind_the_key_serves(monkeypatch):
    monkeypatch.setattr(V.vconfig, "READ_MAX_LAG", 0)
    assert _serve(2, "projecting") == ("postgres", [], None)
    assert _serve(3, "idle")[0] == "falkordb"
    monkeypatch.setattr(V.vconfig, "READ_MAX_LAG", 1)
    assert _serve(2, "projecting")[0] == "falkordb"
    assert _serve(1, "projecting")[0] == "postgres"


def test_a_fork_reads_its_neighbors_from_postgres_whatever_its_key():
    """A fork has no projection of its own: a key its row still names (a copy an earlier release
    made) is never read, however fresh it says it is."""
    assert _serve(3, "idle", fork=True)[:2] == ("postgres", [])
