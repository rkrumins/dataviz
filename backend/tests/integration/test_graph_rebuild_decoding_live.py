"""A provider never decodes a rewritten graph with the old id tables — LIVE FalkorDB.

Reproduces the 2026-09-22 corruption at its root: a provider reads a Domain, the graph is
dropped (the projector's own drop path — eviction) and written again with a catalogue in a
different order (``_PropReserve`` first), and the SAME provider reads the Domain again.
Without the generation check falkordb-py decodes it with the neighbouring label — the
negative control proves this test reproduces exactly that; with it, it stays a Domain. So
it does with the catalogue probe alone (a reload nobody signalled), and a label-anchored
read re-reads rather than return a dead catalogue's type.
"""
import asyncio
import os

import pytest

from backend.app.providers.falkordb_connection import graph_clients
from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.providers.graph_generation import GraphRebuildWatch
from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory


class _Blind:
    async def rebuilt(self, _name):
        return False


async def _label_of(provider, urn):
    res = await provider._ro_query("MATCH (n {urn: $u}) RETURN n", {"u": urn})
    return res.result_set[0][0].labels


async def _top_level_types(provider):
    provider.set_containment_edge_types([], from_ontology=True)     # flat: every node is top-level
    res = await provider.get_top_level_or_orphan_nodes(entity_types=["domain"])
    return [n.entity_type for n in res.nodes]


async def _scenario(watch, *, probe: bool, read=None) -> list:
    name = "gvt_decode_" + os.urandom(3).hex()
    factory = make_falkor_graph_factory()
    raw = factory(name)
    raw = await raw if asyncio.iscoroutine(raw) else raw
    provider = FalkorDBProvider(host=os.getenv("FALKORDB_HOST", "falkordb"),
                                port=int(os.getenv("FALKORDB_PORT", "6379")),
                                graph_name=name, auto_reconcile=False)
    provider._rebuild_watch = watch
    try:
        for label in ("chart", "dataset", "domain", "schemaField"):
            await raw.query(f"CREATE (:{label} {{urn: 'u:{label}'}})")
        await provider._ensure_connected()
        assert await _label_of(provider, "u:domain") == ["domain"]      # table cached now

        # Evicted, then projected again: the rebuild registers _PropReserve first.
        await FalkorProjector(factory).drop_graph(name)
        raw = factory(name)
        raw = await raw if asyncio.iscoroutine(raw) else raw
        for label in ("_PropReserve", "chart", "dataset", "domain", "schemaField"):
            await raw.query(f"CREATE (:{label} {{urn: 'u:{label}'}})")
        await asyncio.sleep(0.05)
        provider._id_tables_checked_at = float("-inf") if probe else float("inf")
        if read is not None:
            return await read(provider)
        return await _label_of(provider, "u:domain")
    finally:
        try:
            await raw.delete()
        except Exception:
            pass
        await provider.close()
        await graph_clients().aclose()      # the factory's pools are bound to this loop


async def _run() -> None:
    corrupted = await _scenario(_Blind(), probe=False)
    assert corrupted == ["schemaField"], \
        f"negative control must reproduce the incident (Domain → schemaField): {corrupted}"
    assert await _scenario(GraphRebuildWatch(interval_s=0.0), probe=False) == ["domain"]
    # An unsignalled reload (an external loader, a script): healed by the catalogue probe alone.
    assert await _scenario(_Blind(), probe=True) == ["domain"]


@pytest.mark.skipif(os.getenv("GRAPHVER_E2E") != "1", reason="needs a live FalkorDB (set GRAPHVER_E2E=1)")
def test_a_rewritten_graph_is_never_decoded_with_old_tables():
    asyncio.run(_run())


@pytest.mark.skipif(os.getenv("GRAPHVER_E2E") != "1", reason="needs a live FalkorDB (set GRAPHVER_E2E=1)")
def test_a_top_level_read_never_returns_a_dead_catalogues_types():
    # Blind watch, probe suppressed: only the read guard stands between the stale table
    # and the answer (the unguarded decode yields 'schemaField').
    assert asyncio.run(_scenario(_Blind(), probe=False, read=_top_level_types)) == ["domain"]
