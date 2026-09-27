"""Every match of a search, read for a job: its URNs, exactly, up to a cap.

A property operation acts on what a search matches, so the job reads the
search's units the way a count does (``engine._hop``: each unit's matches
once, a unit under time or memory pressure split and read again, a unit the
fleet had no room for given back) and keeps each match's URN. It reads the
URN alone, never ``propertiesRaw``, and stops starting units once it holds
more matches than the operation may change. Against a scripted graph here;
``tests/integration/test_search_scan_live.py`` runs it on FalkorDB.
"""
from __future__ import annotations

import dataclasses
from types import SimpleNamespace

import pytest

from backend.app.providers.falkordb_search import export as export_mod
from backend.app.providers.falkordb_search import scan as scan_mod
from backend.app.providers.falkordb_search.plan import Plan, Unit
from backend.app.providers.falkordb_search.scan import scan_urns
from backend.app.services.deep_search import CompileError, SearchRunContext, get_deep_search_settings
from backend.common.adapters.circuit import ProviderBusy
from backend.common.models.search import SearchQuery

NODES = {"Dataset": [f"d{i}" for i in range(6)], "Column": [f"c{i}" for i in range(4)]}
UNITS = [Unit("range", "Dataset", 0, 3, size=3), Unit("range", "Dataset", 3, None, size=3),
         Unit("range", "Column", size=4)]


class _Graph:
    """``{label: [urn, …]}``, a node's position its ID; the predicate is ``all``."""

    def __init__(self, nodes, fail=None):
        self.nodes, self.fail, self.statements = nodes, fail, []

    async def run(self, cypher, params, timeout_s):
        self.statements.append((cypher, dict(params)))
        if self.fail:
            self.fail(cypher, params)
        if "UNWIND labels(n) AS _l" in cypher:
            return SimpleNamespace(result_set=[])
        if "MATCH (_w)" in cypher:
            label = "Dataset"
        else:
            label = cypher.split("MATCH (n:`", 1)[1].split("`", 1)[0]
        lo, hi = params.get("_lo"), params.get("_hi")
        rows = [[i, None, urn] for i, urn in enumerate(self.nodes[label])
                if (lo is None or i >= lo) and (hi is None or i < hi)]
        if "$_after" in cypher:
            rows = [r for r in rows if r[0] > params["_after"]][:params["_page"]]
        return SimpleNamespace(result_set=rows)


class _Provider:
    def __init__(self, graph):
        self.graph = graph

    async def _ro_query(self, cypher, params=None, timeout=None):
        return await self.graph.run(cypher, params or {}, timeout)

    def _get_containment_edge_types(self):
        return ["CONTAINS"]

    def _get_lineage_edge_types(self):
        return []


def _plan(units):
    async def plan(provider, query, compiler, **kw):
        return Plan(list(units))
    return plan


def _query(predicate=None):
    return SearchQuery.model_validate({"predicate": predicate or {"kind": "all"},
                                       "scope": {"viewId": "v"}, "options": {"results": "hits"}})


def _settings(monkeypatch, **changes):
    settings = dataclasses.replace(get_deep_search_settings(), **changes)
    monkeypatch.setattr(scan_mod, "get_deep_search_settings", lambda: settings)


@pytest.fixture(autouse=True)
def quick_backoff(monkeypatch):
    monkeypatch.setattr(scan_mod, "_BACKOFF_S", 0.001)
    monkeypatch.setattr(scan_mod, "_BACKOFF_MAX_S", 0.005)


async def _scan(provider, cap=100, query=None):
    return await scan_urns(provider, query or _query(), context=SearchRunContext(data_version="1"),
                           cap=cap)


async def test_every_match_is_read_once(monkeypatch):
    monkeypatch.setattr(scan_mod, "make_plan", _plan(UNITS))
    graph = _Graph(NODES)
    res = await _scan(_Provider(graph))
    assert sorted(res.urns) == sorted(NODES["Dataset"] + NODES["Column"])
    assert not res.over_cap


async def test_it_reads_the_urn_and_nothing_else(monkeypatch):
    monkeypatch.setattr(scan_mod, "make_plan", _plan(UNITS))
    graph = _Graph(NODES)
    await _scan(_Provider(graph))
    reads = [c for c, _ in graph.statements if "RETURN ID(n)" in c]
    assert reads and all("n.propertiesRaw" not in c and c.endswith("n.urn") for c in reads), reads


async def test_it_stops_starting_units_past_the_cap(monkeypatch):
    monkeypatch.setattr(scan_mod, "make_plan", _plan(UNITS))
    _settings(monkeypatch, chunk_concurrency=1)
    graph = _Graph(NODES)
    res = await _scan(_Provider(graph), cap=4)
    assert res.over_cap and len(res.urns) == 6, res
    assert not any("`Column`" in c for c, _ in graph.statements), "the third unit never ran"


async def test_a_unit_under_pressure_is_split_and_read_again(monkeypatch):
    monkeypatch.setattr(scan_mod, "make_plan", _plan([Unit("range", "Dataset", 0, 6, size=6)]))

    def fail(cypher, params):
        if "RETURN ID(n)" in cypher and params.get("_hi", 99) - params.get("_lo", 0) > 3:
            raise TimeoutError("Query timed out")

    res = await _scan(_Provider(_Graph(NODES, fail=fail)))
    assert sorted(res.urns) == sorted(NODES["Dataset"]) and not res.over_cap


async def test_a_busy_fleet_is_waited_out(monkeypatch):
    monkeypatch.setattr(scan_mod, "make_plan", _plan(UNITS))
    busy = {"left": 5}

    def fail(cypher, params):
        if "RETURN ID(n)" in cypher and busy["left"]:
            busy["left"] -= 1
            raise ProviderBusy(provider_name="p", reason="full", retry_after_seconds=1)

    res = await _scan(_Provider(_Graph(NODES, fail=fail)))
    assert busy["left"] == 0 and len(res.urns) == 10


async def test_a_walk_is_read_a_page_at_a_time(monkeypatch):
    monkeypatch.setattr(scan_mod, "make_plan", _plan([Unit("walk", None, roots=[1], size=6)]))
    monkeypatch.setattr(export_mod, "_WALK_PAGE", 2)
    graph = _Graph(NODES)
    res = await _scan(_Provider(graph))
    assert sorted(res.urns) == sorted(NODES["Dataset"])
    assert sum("$_after" in c for c, _ in graph.statements) == 4


async def test_a_path_search_is_refused():
    path = {"kind": "path", "sourceUrns": ["d0"], "targetUrns": ["d1"]}
    with pytest.raises(CompileError):
        await _scan(_Provider(_Graph(NODES)), query=_query(path))


async def test_a_failed_unit_fails_the_scan(monkeypatch):
    monkeypatch.setattr(scan_mod, "make_plan", _plan(UNITS))

    def fail(cypher, params):
        if "`Column`" in cypher:
            raise RuntimeError("graph is gone")

    from backend.app.services.deep_search import SearchFailed
    with pytest.raises(SearchFailed):
        await _scan(_Provider(_Graph(NODES, fail=fail)))


async def test_each_statement_is_admitted(monkeypatch):
    monkeypatch.setattr(scan_mod, "make_plan", _plan(UNITS))
    held = []

    class _Admit:
        async def __aenter__(self):
            held.append(1)

        async def __aexit__(self, *exc):
            return False

    res = await scan_urns(_Provider(_Graph(NODES)), _query(), cap=100,
                          context=SearchRunContext(data_version="1", admit=_Admit))
    assert len(res.urns) == 10 and len(held) >= len(UNITS)


async def test_a_draft_scans_the_published_graph():
    """A draft's search is the published graph's (its edits are not searched):
    so is a job's reading of every match."""
    from backend.app.providers.draft_overlay_provider import DraftOverlayProvider

    seen = {}

    class _Base:
        async def deep_search_scan(self, query, *, context, cap):
            seen.update(cap=cap, version=context.data_version)
            return "base"

    draft = object.__new__(DraftOverlayProvider)
    draft._base = _Base()
    assert await draft.deep_search_scan(_query(), context=SearchRunContext(data_version="7"),
                                        cap=5) == "base"
    assert seen == {"cap": 5, "version": "7"}


class TestStatementAdmission:
    """A job's scan runs in the worker, not a request: it takes each
    statement's slots — this process's and the fleet's — from the provider
    manager, as the search route does."""

    def test_a_provider_without_a_slot_key_is_not_admitted(self):
        from backend.app.providers.manager import ProviderManager
        assert ProviderManager.statement_admission(object.__new__(ProviderManager),
                                                   SimpleNamespace()) is None

    async def test_both_slots_are_held_for_one_statement(self):
        from backend.app.providers.manager import ProviderManager

        events = []

        class _Sem:
            def release(self):
                events.append("released")

        class _Fleet:
            async def __aenter__(self):
                events.append("fleet")

            async def __aexit__(self, *exc):
                events.append("fleet done")
                return False

        manager = object.__new__(ProviderManager)

        async def acquire(provider_id, graph_name=""):
            events.append(("slot", provider_id, graph_name))
            return _Sem()

        manager.acquire_provider_slot = acquire
        manager.fleet_slot = lambda provider_id, graph_name="": _Fleet()
        admit = manager.statement_admission(SimpleNamespace(manager_cache_key=("prov", "g")))
        async with admit():
            events.append("statement")
        assert events == [("slot", "prov", "g"), "fleet", "statement", "fleet done", "released"]
