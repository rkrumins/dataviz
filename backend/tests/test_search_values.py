"""``GET /search/values`` — a property's most common values for the value
picker.

Reported: value suggestions came from ``/search/discover``'s 200-node sample
per type, so on a large graph a property with hundreds of values offered
"only 2 distinct values". The suggestions are now counted over every entity
of the view's types, narrowed by what the user typed, bounded by a time
budget that the response owns up to (``complete`` / ``truncated``).
"""
from __future__ import annotations

import asyncio

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from backend.app.api.v1.endpoints import graph as graph_mod
from backend.app.providers.falkordb_deep_search import suggest_property_values
from backend.app.services.advanced_search_service import AdvancedSearchService
from backend.app.services.view_scope import EffectiveViewScope
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider


pytestmark = pytest.mark.asyncio


# ---------------------------------------------------------------------------
# Route
# ---------------------------------------------------------------------------

class _Provider:
    manager_cache_key = ("prov-1", "graph-1")


class _FakeEngine:
    provider = _Provider()


def _request(*, view_capability: str | None = None) -> Request:
    state: dict = {}
    if view_capability is not None:
        state["view_capability"] = view_capability
    return Request({"type": "http", "headers": [], "state": state})


@pytest.fixture
def slot(monkeypatch):
    sem = asyncio.Semaphore(1)
    taken: list = []

    async def _acquire(provider_id, graph_name=""):
        taken.append((provider_id, graph_name))
        await sem.acquire()
        return sem

    monkeypatch.setattr(graph_mod.provider_manager, "acquire_provider_slot", _acquire)
    return taken


def _patch_values(monkeypatch, *, result=None, raises=None) -> list:
    calls: list = []

    async def _values(self, *, view_id, key, q="", limit=25):
        calls.append((view_id, key, q, limit))
        if raises is not None:
            raise raises
        return result

    monkeypatch.setattr(AdvancedSearchService, "values", _values)
    return calls


async def _call(**kw):
    args = dict(request=_request(), viewId="view-1", key="tier", q="", limit=25,
                ws_id="ws-1", dataSourceId=None, branchId=None,
                engine=_FakeEngine(), session=None)
    args.update(kw)
    return await graph_mod.search_values(**args)


async def test_values_run_inside_the_provider_slot(slot, monkeypatch):
    calls = _patch_values(monkeypatch, result={"key": "tier", "values": []})
    result = await _call(q="go", limit=10)
    assert result == {"key": "tier", "values": []}
    assert calls == [("view-1", "tier", "go", 10)]
    assert slot == [("prov-1", "graph-1")]


async def test_values_refuse_a_capability_identity(monkeypatch):
    """The values come from the view's entity TYPES — wider than a view
    scoped to a subtree — so a share link is refused, like discover."""
    calls = _patch_values(monkeypatch, result={})
    with pytest.raises(HTTPException) as exc:
        await _call(request=_request(view_capability="view-1"))
    assert exc.value.status_code == 403
    assert calls == [], "must refuse before the graph is read"


async def test_values_map_a_refusal_to_501(slot, monkeypatch):
    _patch_values(monkeypatch, raises=NotImplementedError("no deep search here"))
    with pytest.raises(HTTPException) as exc:
        await _call()
    assert exc.value.status_code == 501


async def test_values_need_a_workspace():
    with pytest.raises(HTTPException) as exc:
        await _call(ws_id=None)
    assert exc.value.status_code == 400


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------

async def test_service_reads_the_view_types_and_guards_its_data_source(monkeypatch):
    stub = StubDeepSearchProvider(nodes=[
        {"urn": "a", "entityType": "dataset", "tier": "gold"},
        {"urn": "b", "entityType": "dashboard", "tier": "silver"},
    ])
    engine = type("E", (), {"provider": stub})()
    svc = AdvancedSearchService(engine, session=object(), workspace_id="ws-1")
    guarded: list = []

    async def _resolve(requested):
        assert (requested.view_id, requested.scope_mode) == ("view-1", "view")
        return EffectiveViewScope(
            view_id="view-1", workspace_id="ws-1", data_source_id="ds-1",
            canvas_kind="hierarchy", root_urns=(),
            entity_type_allow_list=frozenset({"Dataset"}),
            layer_allow_list=frozenset(), max_depth=12, scope_hash="h",
        )

    async def _guard(eff):
        guarded.append(eff.view_id)

    monkeypatch.setattr(svc, "_resolve_scope", _resolve)
    monkeypatch.setattr(svc, "_guard_view_data_source", _guard)
    result = await svc.values(view_id="view-1", key="tier")
    assert result["values"] == [{"value": "gold", "count": 1}]
    assert guarded == ["view-1"]


# ---------------------------------------------------------------------------
# Stub — the answer the FalkorDB query gives on a small graph
# ---------------------------------------------------------------------------

async def test_stub_counts_every_value_and_list_element():
    stub = StubDeepSearchProvider(nodes=[
        {"urn": "1", "entityType": "t", "tier": "gold", "labels": ["pii", "gold"]},
        {"urn": "2", "entityType": "t", "tier": "gold", "labels": ["pii"]},
        {"urn": "3", "entityType": "t", "tier": 15, "labels": []},
        {"urn": "4", "entityType": "t", "tier": "15"},
        {"urn": "5", "entityType": "t", "tier": True},
        {"urn": "6", "entityType": "t", "tier": 1},
    ])
    tiers = await stub.deep_search_values(key="tier")
    assert tiers["values"][0] == {"value": "gold", "count": 2}
    # 15 and "15", True and 1 are different values.
    assert {"value": 15, "count": 1} in tiers["values"]
    assert {"value": "15", "count": 1} in tiers["values"]
    assert {"value": True, "count": 1} in tiers["values"]
    assert {"value": 1, "count": 1} in tiers["values"]
    labels = await stub.deep_search_values(key="labels")
    assert labels["values"] == [{"value": "pii", "count": 2}, {"value": "gold", "count": 1}]


async def test_stub_narrows_by_text_and_type():
    stub = StubDeepSearchProvider(nodes=[
        {"urn": "1", "entityType": "a", "owner": "Data Platform"},
        {"urn": "2", "entityType": "a", "owner": "analytics"},
        {"urn": "3", "entityType": "b", "owner": "platform-ops"},
    ])
    got = await stub.deep_search_values(key="owner", q="PLAT")
    assert [v["value"] for v in got["values"]] == ["Data Platform", "platform-ops"]
    got = await stub.deep_search_values(key="owner", q="plat", entity_types=["A"])
    assert [v["value"] for v in got["values"]] == ["Data Platform"]
    got = await stub.deep_search_values(key="owner", limit=1)
    assert got["truncated"] is True and len(got["values"]) == 1


# ---------------------------------------------------------------------------
# FalkorDB query — shape, budget and merging, against a fake provider
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, rows):
        self.result_set = rows


class _FakeFalkor:
    """Answers ``db.labels()`` and one value query per label."""

    def __init__(self, labels, rows_by_label, *, fail=()):
        self.labels = labels
        self.rows_by_label = rows_by_label
        self.fail = set(fail)
        self.queries: list = []

    async def _ro_query(self, cypher, params=None, timeout=None):
        self.queries.append((cypher, params))
        if cypher.startswith("CALL db.labels()"):
            return _Result([[label] for label in self.labels])
        label = cypher.split("MATCH (n:`", 1)[1].split("`", 1)[0]
        if label in self.fail:
            raise TimeoutError("Query timed out")
        return _Result(self.rows_by_label.get(label, []))


async def test_counts_merge_across_types_keeping_kinds_apart():
    fake = _FakeFalkor(["dataset", "table", "_GVRollupMeta"], {
        "dataset": [["gold", 5], [15, 2], [1, 1]],
        "table": [["gold", 3], ["15", 4], [True, 1], [15.0, 1]],
    })
    out = await suggest_property_values(fake, key="tier", limit=10)
    # 15 and 15.0 are one number, as FalkorDB groups them within a type;
    # "15" is text and true is not 1.
    assert out["values"] == [
        {"value": "gold", "count": 8},
        {"value": "15", "count": 4},
        {"value": 15, "count": 3},
        {"value": 1, "count": 1},
        {"value": True, "count": 1},
    ]
    assert out["complete"] is True and out["truncated"] is False
    scanned = [q for q, _ in fake.queries if q.startswith("MATCH")]
    assert len(scanned) == 2, "the platform's own labels are never read"


async def test_the_query_counts_list_elements_and_narrows_by_folded_text():
    fake = _FakeFalkor(["dataset"], {"dataset": []})
    await suggest_property_values(fake, key="Asset Owner", q="  ÉCOLE ", limit=7)
    cypher, params = fake.queries[-1]
    assert "MATCH (n:`dataset`) WHERE n.`Asset Owner` IS NOT NULL" in cypher
    assert "UNWIND CASE WHEN typeOf(n.`Asset Owner`) = 'List'" in cypher
    assert "toLower(" in cypher and "CONTAINS $q" in cypher
    assert "ORDER BY _c DESC LIMIT $lim" in cypher
    assert params == {"lim": 7, "q": "école"}


async def test_only_the_view_types_are_read():
    fake = _FakeFalkor(["Dataset", "Dashboard"], {"Dataset": [["x", 1]]})
    out = await suggest_property_values(fake, key="k", entity_types=["dataset"])
    assert out["values"] == [{"value": "x", "count": 1}]
    assert not any("Dashboard" in q for q, _ in fake.queries)


async def test_a_type_that_times_out_leaves_the_answer_incomplete():
    fake = _FakeFalkor(["a", "b"], {"b": [["x", 1]]}, fail={"a"})
    out = await suggest_property_values(fake, key="k")
    assert out["values"] == [{"value": "x", "count": 1}]
    assert out["complete"] is False


async def test_a_full_page_from_one_type_is_truncated():
    fake = _FakeFalkor(["a"], {"a": [["x", 3], ["y", 2]]})
    out = await suggest_property_values(fake, key="k", limit=2)
    assert out["truncated"] is True
