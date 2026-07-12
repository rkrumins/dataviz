"""Provider edits must invalidate EVERY process, not just the one that served the
request — and every cache in it, not just the read instances.

Two defects this pins:

1. ``evict_provider`` only invalidated the registry/projector caches when the
   provider happened to have a cached READ instance. ``_providers`` is populated by
   read traffic; the registry caches are populated by the PROJECTOR. A provider that
   was projected to but never read from had no key there — so an admin repoint left
   the projector writing to the OLD instance until restart.

2. All three caches (read instances, registry config memo, graph clients) are
   PROCESS-LOCAL. The admin edit runs in one web pod; the other replicas, the
   aggregation worker and the versioning worker keep the old host/mode/credentials.
   No self-heal covers it: after a repoint the old host usually still answers, so the
   warmup loop never sees the false→true transition that drives its eviction.
"""
import asyncio
import json

import pytest

from backend.app.providers import falkor_graph_registry as reg
from backend.app.providers.invalidation_bus import (
    PROVIDER_CONTROL_CHANNEL,
    ProviderInvalidationListener,
    apply_local_invalidation,
    publish_provider_invalidation,
)


class _FakeRedis:
    def __init__(self):
        self.published: list = []

    async def publish(self, channel, payload):
        self.published.append((channel, payload))


@pytest.mark.asyncio
async def test_publish_emits_on_the_control_channel():
    r = _FakeRedis()
    await publish_provider_invalidation("prov_1", r)
    (channel, payload), = r.published
    assert channel == PROVIDER_CONTROL_CHANNEL
    assert json.loads(payload) == {"action": "invalidate", "provider_id": "prov_1"}


@pytest.mark.asyncio
async def test_publish_never_raises_when_the_bus_is_down():
    """A bus outage must never fail an admin edit — the local eviction still applied."""

    class _Broken:
        async def publish(self, *a):
            raise ConnectionError("bus down")

    await publish_provider_invalidation("prov_1", _Broken())    # must not raise


@pytest.mark.asyncio
async def test_apply_local_invalidation_drops_registry_caches(monkeypatch):
    from backend.app.providers.falkordb_connection import FalkorDBConnConfig

    cfg = FalkorDBConnConfig(mode="standalone", host="h", port=6379)
    reg._RESOLVED["prov_x"] = cfg

    dropped = {}

    class _FakeClients:
        async def invalidate_config(self, c):
            dropped["cfg"] = c

    monkeypatch.setattr(
        "backend.app.providers.falkordb_connection.graph_clients",
        lambda: _FakeClients(),
    )

    await apply_local_invalidation("prov_x")
    assert "prov_x" not in reg._RESOLVED
    assert dropped["cfg"] is cfg


@pytest.mark.asyncio
async def test_evict_provider_invalidates_even_with_no_cached_read_instance(monkeypatch):
    """THE BUG: the registry invalidation used to sit inside the `_providers` loop,
    so a projected-but-never-read provider was never invalidated at all."""
    from backend.app.providers.manager import ProviderManager

    mgr = ProviderManager()
    assert not mgr._providers          # nothing cached from read traffic

    called = {}

    async def fake_invalidate(pid):
        called["provider_id"] = pid

    monkeypatch.setattr(
        "backend.app.providers.falkor_graph_registry.invalidate_provider",
        fake_invalidate,
    )
    published = {}

    async def fake_publish(pid):
        published["provider_id"] = pid

    monkeypatch.setattr(
        "backend.app.providers.invalidation_bus.publish_provider_invalidation",
        fake_publish,
    )

    await mgr.evict_provider("prov_projected_only")

    assert called["provider_id"] == "prov_projected_only"       # registry invalidated
    assert published["provider_id"] == "prov_projected_only"    # and broadcast


@pytest.mark.asyncio
async def test_listener_applies_a_received_invalidation(monkeypatch):
    """A worker receiving the message drops its own caches — and does NOT re-publish
    (which would echo around the bus forever)."""
    applied = {}

    class _FakeManager:
        async def evict_provider(self, provider_id, *, _broadcast=True):
            applied["provider_id"] = provider_id
            applied["broadcast"] = _broadcast

    async def fake_invalidate(pid):
        applied["registry"] = pid

    monkeypatch.setattr(
        "backend.app.providers.falkor_graph_registry.invalidate_provider",
        fake_invalidate,
    )

    await apply_local_invalidation("prov_9", _FakeManager())

    assert applied["provider_id"] == "prov_9"
    assert applied["broadcast"] is False         # no echo
    assert applied["registry"] == "prov_9"


@pytest.mark.asyncio
async def test_listener_starts_and_stops_cleanly():
    class _FakePubSub:
        async def subscribe(self, *a):
            return None

        async def unsubscribe(self, *a):
            return None

        async def aclose(self):
            return None

        async def listen(self):
            while True:
                await asyncio.sleep(0.05)
                yield {"type": "subscribe"}

    class _R:
        def pubsub(self, **kw):
            return _FakePubSub()

    listener = ProviderInvalidationListener(_R())
    await listener.start()
    await asyncio.sleep(0.05)
    await listener.stop()
