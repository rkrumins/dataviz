"""A versioned data source is read from the key its graph projects into.

``ProviderManager.get_provider`` asks ``versioned_sources.physical_key`` for the (provider, key)
before it computes the cache key, so after a move (doc 14 KeyMigration, phase 1) every reader and
rollup writer that resolves the data source reaches the new key, while the management DB keeps
naming the old one. A source that is not versioned, or a graph that is not pinned to a real key, is
read exactly as before. ``serves_pin`` is the fence ContextEngine adds on top: main counts as fresh
only while the provider it holds serves the published pin.

No real DB or provider: the data-source lookup, the versioned set and the graphver read are stubbed.
"""
from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.providers.manager import ProviderManager
from backend.app.services import versioned_sources
from backend.app.services.versioned_sources import physical_key, serves_pin
from backend.app.services.versioning import db as gv_db
from backend.common.adapters import ProviderUnavailable


class _DataSource:
    def __init__(self, *, id="ds_1", provider_id="prov_A", graph_name="K1"):
        self.id, self.provider_id, self.graph_name = id, provider_id, graph_name
        self.extra_config = None


class _Session:
    def __init__(self, row):
        self._row = row

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, stmt):
        if isinstance(self._row, Exception):
            raise self._row
        return SimpleNamespace(first=lambda: self._row)


@pytest.fixture
def routed(monkeypatch):
    """The real ``physical_key`` (conftest makes it the identity), over a stubbed data source,
    versioned set and pin row. Returns a setter for those three."""
    from backend.app.db.repositories import data_source_repo

    monkeypatch.setattr(versioned_sources, "physical_key", physical_key)
    state = {"ds": _DataSource(), "versioned": {"ds_1"}, "row": None, "reads": 0}

    async def _get_ds(_session, _ds_id):
        return state["ds"]

    async def _versioned():
        if isinstance(state["versioned"], Exception):
            raise state["versioned"]
        return frozenset(state["versioned"])

    def _factory():
        state["reads"] += 1
        return _Session(state["row"])

    monkeypatch.setattr(data_source_repo, "get_data_source_orm", _get_ds)
    monkeypatch.setattr(versioned_sources, "versioned_data_source_ids", _versioned)
    monkeypatch.setattr(gv_db, "get_session_factory", lambda: _factory)
    return state


def _manager():
    mgr = ProviderManager()
    raw = MagicMock()
    raw.close = AsyncMock()
    mgr._instantiate_from_provider = AsyncMock(return_value=raw)
    return mgr


async def test_a_moved_graph_is_read_from_its_pin(routed):
    routed["row"] = ("graph_1", "prov_B", "K2")
    mgr = _manager()
    provider = await mgr.get_provider("ws_1", MagicMock(), data_source_id="ds_1")
    assert mgr._instantiate_from_provider.await_args.args[:2] == ("prov_B", "K2")
    assert list(mgr._providers) == [("prov_B", "K2")]
    assert provider.manager_cache_key == ("prov_B", "K2")


async def test_a_pin_on_the_default_provider_keeps_the_data_sources_provider(routed):
    for pin_provider in (None, "", "default"):
        routed["row"] = ("graph_1", pin_provider, "K2")
        assert await physical_key("ds_1", "prov_A", "K1") == ("prov_A", "K2")


async def test_an_unpinned_or_unversioned_source_reads_its_own_key(routed):
    for row in (None, ("graph_1", "prov_B", None), ("graph_1", "prov_B", "gv_graph_1")):
        routed["row"] = row
        assert await physical_key("ds_1", "prov_A", "K1") == ("prov_A", "K1")
    routed["versioned"], reads = set(), routed["reads"]
    mgr = _manager()
    provider = await mgr.get_provider("ws_1", MagicMock(), data_source_id="ds_1")
    assert provider.manager_cache_key == ("prov_A", "K1")
    assert routed["reads"] == reads                       # no graphver read for it


async def test_an_unreadable_versioned_set_falls_back_to_the_data_sources_key(routed):
    routed["versioned"] = versioned_sources.VersionedLookupUnavailable("down")
    routed["row"] = ("graph_1", "prov_B", "K2")
    assert await physical_key("ds_1", "prov_A", "K1") == ("prov_A", "K1")


async def test_an_unreadable_pin_fails_the_read_closed(routed):
    routed["row"] = RuntimeError("graphver down")
    mgr = _manager()
    with pytest.raises(ProviderUnavailable):
        await mgr.get_provider("ws_1", MagicMock(), data_source_id="ds_1")
    mgr._instantiate_from_provider.assert_not_awaited()


@pytest.mark.parametrize("served, pin_provider, pin_name, serves", [
    (None, "prov_B", "K2", True),                     # a provider the manager did not build
    (("prov_A", "K1"), "prov_B", None, True),         # unpinned
    (("prov_A", "K1"), "prov_B", "gv_graph_1", True),  # the placeholder nothing reads
    (("prov_A", "K2"), None, "K2", True),             # the default provider: by name only
    (("prov_A", "K2"), "default", "K2", True),
    (("prov_B", "K2"), "prov_B", "K2", True),
    (("prov_A", "K1"), "prov_A", "K2", False),        # another key
    (("prov_A", "K2"), "prov_B", "K2", False),        # another provider
])
def test_serves_pin(served, pin_provider, pin_name, serves):
    assert serves_pin(served, pin_provider, pin_name, "graph_1") is serves
