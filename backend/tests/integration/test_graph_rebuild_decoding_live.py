"""A provider never decodes a rewritten graph with the old id tables — LIVE FalkorDB.

Reproduces the 2026-09-22 corruption at its root: a provider reads a Domain, the graph is
dropped (the projector's own drop path — eviction) and written again with a catalogue in a
different order (``_PropReserve`` first), and the SAME provider reads the Domain again.
Without the generation check falkordb-py decodes it with the neighbouring label — the
negative control proves this test reproduces exactly that; with it, it stays a Domain.
"""
import asyncio
import os

import pytest

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.app.providers.graph_generation import GraphRebuildWatch
from backend.app.services.versioning.projection import FalkorProjector, make_falkor_graph_factory


class _Blind:
    async def rebuilt(self, _name):
        return False


async def _label_of(provider, urn):
    res = await provider._ro_query("MATCH (n {urn: $u}) RETURN n", {"u": urn})
    return res.result_set[0][0].labels


async def _scenario(watch) -> list:
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
        return await _label_of(provider, "u:domain")
    finally:
        try:
            await raw.delete()
        except Exception:
            pass
        await provider.close()


async def _run() -> None:
    corrupted = await _scenario(_Blind())
    assert corrupted == ["schemaField"], \
        f"negative control must reproduce the incident (Domain → schemaField): {corrupted}"
    assert await _scenario(GraphRebuildWatch(interval_s=0.0)) == ["domain"]


@pytest.mark.skipif(os.getenv("GRAPHVER_E2E") != "1", reason="needs a live FalkorDB (set GRAPHVER_E2E=1)")
def test_a_rewritten_graph_is_never_decoded_with_old_tables():
    asyncio.run(_run())
