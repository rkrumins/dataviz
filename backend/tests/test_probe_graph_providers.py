"""``probe_graph_providers`` — the Infrastructure page's provider cards.

* A FalkorDB provider's card carries how many versioned graphs it hosts and their size, taken
  from the graph store reading already in hand: the probe never sweeps the store for them.
* With no reading yet, or for a provider the reading does not cover, the figures are absent
  rather than zero.
"""
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace

from backend.app.db import engine
from backend.app.db.repositories import provider_repo
from backend.app.providers.manager import provider_manager
from backend.app.services.graph_store import topology
from backend.app.services.graph_store.schemas import (
    GraphStoreInstance,
    GraphStoreTopologyResponse,
    ProviderRef,
)
from backend.app.services.system_status import probes


def _providers(monkeypatch):
    rows = [SimpleNamespace(id="p1", name="Falkor EU", provider_type="falkordb", is_active=True),
            SimpleNamespace(id="p2", name="Neo", provider_type="neo4j", is_active=True)]

    async def list_providers(_session):
        return rows

    @asynccontextmanager
    async def session():
        yield None

    monkeypatch.setattr(provider_repo, "list_providers", list_providers)
    monkeypatch.setattr(engine, "get_session_factory", lambda _role: session)
    monkeypatch.setattr(provider_manager, "report_provider_states", lambda: {})


async def test_a_falkordb_card_counts_its_versioned_graphs_from_the_reading(monkeypatch):
    _providers(monkeypatch)
    snapshot = GraphStoreTopologyResponse(instances=[GraphStoreInstance(
        id="i1", providers=[ProviderRef(id="p1", versioned_graphs=3, versioned_bytes=4096)])])
    monkeypatch.setattr(topology, "_cache", (time.monotonic(), snapshot))

    cards = {c["id"]: c for c in await probes.probe_graph_providers(SimpleNamespace())}
    assert (cards["p1"]["versionedGraphs"], cards["p1"]["versionedBytes"]) == (3, 4096)
    assert "versionedGraphs" not in cards["p2"]


async def test_before_the_store_is_read_the_counts_are_absent_not_zero(monkeypatch):
    _providers(monkeypatch)
    monkeypatch.setattr(topology, "_cache", None)

    cards = await probes.probe_graph_providers(SimpleNamespace())
    assert all("versionedGraphs" not in c for c in cards)
