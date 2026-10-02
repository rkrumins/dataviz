"""The view's property catalog: every key, on how many entities, stored as
which kinds, with which values — exact, read from every entity in scope.

Here against a scripted scan: how the statistics merge (exact int64 bounds,
the distinct-value cap, values of different kinds kept apart, keys demoted
to ``propertiesRaw``), how a catalog session is followed across requests and
kept, and the service and route around it. The live suite holds the answers
to a real graph (``tests/integration/test_search_engine_live.py``).
"""
from __future__ import annotations

import asyncio
import dataclasses
import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from backend.app.api.v1.endpoints import graph as graph_mod
from backend.app.providers.falkordb_search import catalog as catalog_mod
from backend.app.providers.falkordb_search.catalog import (
    VALUES_MAX,
    VALUES_SHOWN,
    CatalogStats,
    execute_catalog_session,
)
from backend.app.providers.falkordb_search.plan import Plan, Unit
from backend.app.providers.falkordb_search.session import MemorySessionStore
from backend.app.services.advanced_search_service import AdvancedSearchService
from backend.app.services.deep_search import SearchRunContext, get_deep_search_settings
from backend.app.services.view_scope import EffectiveViewScope
from backend.common.models.search import SearchCatalogRequest, SearchScope

BIG = 2 ** 63 - 1


# ---------------------------------------------------------------------------
# The statistics
# ---------------------------------------------------------------------------

class TestStats:
    def test_a_key_is_counted_per_entity_type_and_kind(self):
        s = CatalogStats()
        s.add_kind("Dataset", "owner", "String", 30)
        s.add_kind("Column", "owner", "String", 5)
        s.add_kind("Column", "owner", "Integer", 2)
        d = s.describe("owner", complete=True)
        assert d["count"] == 37
        assert d["byEntityType"] == {"Dataset": 30, "Column": 7}
        assert d["kinds"] == {"String": 35, "Integer": 2}

    def test_numeric_bounds_are_exact_at_the_int64_extremes(self):
        s = CatalogStats()
        s.add_bounds("h", [5, BIG - 1, -3, -1])
        s.add_bounds("h", [0, BIG, -(2 ** 63), -7])
        s.add_bounds("h", [None, None, None, None])
        d = s.describe("h", complete=True)
        assert (d["min"], d["max"]) == (-(2 ** 63), BIG)

    def test_bounds_of_one_sign_only(self):
        s = CatalogStats()
        s.add_bounds("score", [0.25, 0.75, None, None])
        assert (s.describe("score", True)["min"], s.describe("score", True)["max"]) == (0.25, 0.75)
        s.add_bounds("debt", [None, None, -10, -2])
        assert (s.describe("debt", True)["min"], s.describe("debt", True)["max"]) == (-10, -2)

    def test_values_of_different_kinds_stay_apart(self):
        s = CatalogStats()
        s.add_kind("T", "v", "Integer", 4)
        s.add_values("v", 4, [["Integer", 1, 1], ["Float", 1.0, 1],
                              ["Boolean", True, 1], ["String", "1", 1]])
        values = s.describe("v", True)["values"]
        assert sorted((v["kind"], json.dumps(v["value"])) for v in values) == [
            ("Boolean", "true"), ("Float", "1.0"), ("Integer", "1"), ("String", '"1"')]

    def test_values_add_up_across_units_fullest_first(self):
        s = CatalogStats()
        s.add_kind("T", "tier", "String", 10)
        s.add_values("tier", 2, [["String", "gold", 3], ["String", "silver", 1]])
        s.add_values("tier", 2, [["String", "silver", 4], ["String", "bronze", 2]])
        d = s.describe("tier", complete=True)
        assert [(v["value"], v["count"]) for v in d["values"]] == [
            ("silver", 5), ("gold", 3), ("bronze", 2)]
        assert (d["distinct"], d["distinctExact"]) == (3, True)
        assert not s.describe("tier", complete=False)["distinctExact"]

    def test_only_the_fullest_values_are_listed(self):
        s = CatalogStats()
        s.add_kind("T", "k", "Integer", 1)
        s.add_values("k", 50, [["Integer", i, 100 - i] for i in range(50)])
        d = s.describe("k", True)
        assert len(d["values"]) == VALUES_SHOWN and d["values"][0]["value"] == 0
        assert d["distinct"] == 50

    def test_past_the_cap_a_key_is_high_cardinality_and_its_distinct_a_floor(self):
        s = CatalogStats()
        s.add_kind("T", "id", "String", 1)
        s.add_values("id", 600, [["String", f"a{i}", 1] for i in range(600)])
        s.add_values("id", 600, [["String", f"b{i}", 1] for i in range(600)])
        d = s.describe("id", complete=True)
        assert d["values"] == [] and not d["distinctExact"] and d["distinct"] >= VALUES_MAX
        assert s.high_cardinality("id")
        # Later units add nothing but a better floor.
        s.add_values("id", 5000, [])
        assert s.describe("id", True)["distinct"] == 5000

    def test_a_unit_alone_past_the_cap_is_enough(self):
        s = CatalogStats()
        s.add_values("id", VALUES_MAX + 1, [["String", "x", 1]])
        assert s.high_cardinality("id") and s.describe("id", True)["distinct"] == VALUES_MAX + 1

    def test_keys_demoted_to_properties_raw_count_like_the_rest(self):
        s = CatalogStats()
        skip = frozenset({"gvHash"})
        s.add_residual("Dataset", json.dumps({"cost": 12, "flag": True, "tags": ["a", "b"],
                                              "gvHash": 1, "empty": None}), skip)
        s.add_residual("Dataset", json.dumps({"cost": -3, "tags": ["a"]}), skip)
        s.add_residual("Dataset", "not json", skip)
        cost = s.describe("cost", True)
        assert (cost["count"], cost["kinds"], cost["residual"]) == (2, {"Integer": 2}, 2)
        assert (cost["min"], cost["max"]) == (-3, 12)
        # A boolean is not an integer, whatever Python thinks.
        assert s.describe("flag", True)["kinds"] == {"Boolean": 1}
        tags = s.describe("tags", True)
        assert {v["value"]: v["count"] for v in tags["values"]} == {"a": 2, "b": 1}
        assert "gvHash" not in s.keys and "empty" not in s.keys

    def test_tags_count_each_entity_once_per_tag(self):
        s = CatalogStats()
        s.add_tag_sets([['["pii","gold"]', 3], ['["pii","pii"]', 2], ["[]", 9], ["oops", 1],
                        [["native"], 4]])
        assert s.tags == {"pii": 5, "gold": 3, "native": 4} and s.tagged == 9

    def test_too_many_tag_sets_leave_the_tags_uncounted(self, monkeypatch):
        monkeypatch.setattr(catalog_mod, "TAG_SETS_MAX", 2)
        s = CatalogStats()
        s.add_tag_sets([['["a"]', 1], ['["b"]', 1], ['["c"]', 1]])
        assert not s.tags_counted and s.tags == {}

    def test_the_statistics_round_trip(self):
        s = CatalogStats()
        s.add_entities("T", 3)
        s.add_kind("T", "k", "String", 3)
        s.add_values("k", 1, [["String", "x", 3]])
        back = CatalogStats.from_json(s.to_json())
        assert back.entities == {"T": 3} and back.describe("k", True) == s.describe("k", True)


# ---------------------------------------------------------------------------
# Sessions, against a scripted scan
# ---------------------------------------------------------------------------

class _Result:
    def __init__(self, rows):
        self.result_set = rows


class _Graph:
    """Answers each catalog statement for a unit's label from scripted
    entities: ``{label: [ {key: value, ...}, ... ]}``."""

    def __init__(self, entities):
        self.entities = entities
        self.statements = []

    def rows(self, label, params):
        rows = self.entities[label]
        lo, hi = params.get("_lo"), params.get("_hi")
        return [r for i, r in enumerate(rows)
                if (lo is None or i >= lo) and (hi is None or i < hi)]

    async def run(self, cypher, params, timeout_s):
        label = cypher.split("MATCH (n:`", 1)[1].split("`", 1)[0]
        rows = self.rows(label, params)
        self.statements.append(cypher)
        if "RETURN labels(n)[0], count(n)" in cypher:
            return _Result([[label, len(rows)]])
        if "UNWIND keys(n)" in cypher:
            tally = {}
            for r in rows:
                for k, v in r.items():
                    kind = catalog_mod._kind_of(v)
                    tally[(k, kind)] = tally.get((k, kind), 0) + 1
            return _Result([[label, k, t, n] for (k, t), n in tally.items()])
        if "n.tags AS _t" in cypher:
            sets = {}
            for r in rows:
                if r.get("tags") not in (None, "[]"):
                    sets[r["tags"]] = sets.get(r["tags"], 0) + 1
            return _Result([[t, n] for t, n in sets.items()][:params["_tagcap"]])
        if "propertiesRaw" in cypher:
            return _Result([[label, r["propertiesRaw"]] for r in rows
                            if r.get("propertiesRaw") not in (None, "{}")])
        if "LIMIT $_probe" in cypher:
            head = rows[:params["_probe"]]
            return _Result([[k, len({json.dumps(r[k]) for r in head if k in r})]
                            for k in params["_keys"]])
        if "IN ['Integer', 'Float']" in cypher:
            out = []
            for k in params["_keys"]:
                nums = [r[k] for r in rows if catalog_mod._kind_of(r.get(k)) in ("Integer", "Float")]
                pos, neg = [x for x in nums if x >= 0], [x for x in nums if x < 0]
                out.append([k, min(pos, default=None), max(pos, default=None),
                            min(neg, default=None), max(neg, default=None)])
            return _Result(out)
        if "UNWIND $_keys AS _k" in cypher:
            out = []
            for k in params["_keys"]:
                counts = {}
                for r in rows:
                    if k not in r:
                        continue
                    for e in (r[k] if isinstance(r[k], list) else [r[k]]):
                        slot = (catalog_mod._kind_of(e), json.dumps(e))
                        counts[slot] = counts.get(slot, 0) + 1
                vals = [[t, json.loads(v), c] for (t, v), c in counts.items()]
                out.append([k, len(vals), vals[:params["_cap"]]])
            return _Result(out)
        raise AssertionError(f"unexpected statement: {cypher}")


class _Provider:
    _redis = None
    _cache_ns = None

    def __init__(self, graph):
        self.graph = graph

    async def _ro_query(self, cypher, params=None, timeout=None):
        return await self.graph.run(cypher, params or {}, timeout)

    def _get_containment_edge_types(self):
        return ["CONTAINS"]


@pytest.fixture(autouse=True)
def memory_store(monkeypatch):
    from backend.app.providers.falkordb_search import session as session_mod
    store = MemorySessionStore()
    monkeypatch.setattr(session_mod, "_MEMORY", store)
    monkeypatch.setattr(catalog_mod, "_skipped_keys",
                        lambda: frozenset({"urn", "gvHash", "propertiesRaw", "tags"}))
    return store


def _plan(units):
    async def plan(provider, query, compiler, **kw):
        return Plan(list(units))
    return plan


ENTITIES = {
    "Dataset": [{"urn": f"d{i}", "owner": ["ann", "bob"][i % 2], "rows": i * 1000,
                 "gvHash": i, "propertiesRaw": "{}"} for i in range(6)],
    "Column": [{"urn": f"c{i}", "owner": "ann", "code": f"x{i}",
                "tags": json.dumps(["pii", "gold"] if i % 2 else ["pii"]),
                "propertiesRaw": json.dumps({"legacy": "yes"}) if i < 3 else "{}"}
               for i in range(4)],
}
UNITS = [Unit("range", "Dataset", 0, 3, size=3), Unit("range", "Dataset", 3, None, size=3),
         Unit("range", "Column", size=4)]


async def _follow(provider, context, **kw):
    out, sid, requests = None, None, 0
    while True:
        out = await execute_catalog_session(provider, SearchScope(view_id="v"), context=context,
                                            wait_ms=0, session_id=sid, **kw)
        sid, requests = out["sessionId"], requests + 1
        if out["status"] == "complete":
            return out, requests
        assert requests < 20


class TestSessions:
    async def test_every_entity_is_read_across_requests(self, monkeypatch):
        monkeypatch.setattr(catalog_mod, "make_plan", _plan(UNITS))
        monkeypatch.setattr(catalog_mod, "PROBE_ENTITIES", 2)
        out, requests = await _follow(_Provider(_Graph(ENTITIES)),
                                      SearchRunContext(data_version="1", scope_hash="h"))
        assert requests > 1       # two units a request: more than one answer
        assert out["entities"] == 10 and out["progress"]["scanned"] == 10
        assert out["entityTypes"] == [{"type": "Dataset", "count": 6},
                                      {"type": "Column", "count": 4}]
        props = {p["key"]: p for p in out["properties"]}
        # Platform keys never show; a residual key does.
        assert set(props) == {"owner", "rows", "code", "legacy"}
        owner = props["owner"]
        assert owner["count"] == 10 and owner["byEntityType"] == {"Dataset": 6, "Column": 4}
        assert {v["value"]: v["count"] for v in owner["values"]} == {"ann": 7, "bob": 3}
        assert owner["distinctExact"]
        assert (props["rows"]["min"], props["rows"]["max"]) == (0, 5000)
        assert props["legacy"]["residual"] == 3
        assert out["properties"][0]["key"] == "owner"     # most carried first
        assert out["tags"] == [{"tag": "pii", "count": 4}, {"tag": "gold", "count": 2}]
        assert out["tagged"] == 4

    async def test_a_unit_has_two_statements_budget(self, monkeypatch):
        """A unit reads in passes — its counts, a probe, then the values of
        the keys the probe keeps — so it gets two statements' budget before
        it is split."""
        settings = dataclasses.replace(get_deep_search_settings(), chunk_timeout_ms=200)
        monkeypatch.setattr(catalog_mod, "get_deep_search_settings", lambda: settings)
        monkeypatch.setattr(catalog_mod, "make_plan", _plan(UNITS))
        graph = _Graph(ENTITIES)
        read = graph.run

        async def slow(cypher, params, timeout_s):
            await asyncio.sleep(0.1)
            return await read(cypher, params, timeout_s)

        graph.run = slow
        out, _ = await _follow(_Provider(graph),
                               SearchRunContext(data_version="1", scope_hash="h"))
        assert out["entities"] == 10

    async def test_a_key_unique_per_entity_is_not_counted_value_by_value(self, monkeypatch):
        graph = _Graph({"T": [{"urn": f"t{i}", "id": f"id{i}", "tier": "gold"}
                              for i in range(30)]})
        monkeypatch.setattr(catalog_mod, "make_plan",
                            _plan([Unit("range", "T", 0, 15, size=15),
                                   Unit("range", "T", 15, None, size=15)]))
        monkeypatch.setattr(catalog_mod, "VALUES_MAX", 10)
        out, _ = await _follow(_Provider(graph), SearchRunContext(data_version="1", scope_hash="h"))
        props = {p["key"]: p for p in out["properties"]}
        assert props["id"]["values"] == [] and not props["id"]["distinctExact"]
        assert props["tier"]["values"] == [{"value": "gold", "kind": "String", "count": 30}]
        # The probe flagged ``id`` before any unit counted its values.
        assert not any("UNWIND $_keys" in c and "'id'" in c for c in graph.statements)
        counted = [c for c in graph.statements if "collect([_t, _e, _c])" in c]
        assert counted

    async def test_a_complete_catalog_is_served_again_without_a_scan(self, monkeypatch):
        monkeypatch.setattr(catalog_mod, "make_plan", _plan(UNITS))
        graph = _Graph(ENTITIES)
        context = SearchRunContext(data_version="1", scope_hash="h")
        first, _ = await _follow(_Provider(graph), context)
        seen = len(graph.statements)
        again = await execute_catalog_session(_Provider(graph), SearchScope(view_id="v"),
                                              context=context, wait_ms=0)
        assert again["sessionId"] == first["sessionId"] and again["status"] == "complete"
        assert len(graph.statements) == seen and not again["stale"]

    async def test_after_the_data_changes_a_recent_catalog_is_served_as_of(self, monkeypatch):
        monkeypatch.setattr(catalog_mod, "make_plan", _plan(UNITS))
        graph = _Graph(ENTITIES)
        first, _ = await _follow(_Provider(graph), SearchRunContext(data_version="1", scope_hash="h"))
        seen = len(graph.statements)
        newer = SearchRunContext(data_version="2", scope_hash="h")
        served = await execute_catalog_session(_Provider(graph), SearchScope(view_id="v"),
                                               context=newer, wait_ms=0)
        assert served["sessionId"] == first["sessionId"] and served["stale"]
        assert served["asOf"] and len(graph.statements) == seen
        # ``refresh`` reads the view again.
        fresh, _ = await _follow(_Provider(graph), newer, refresh=True)
        assert fresh["sessionId"] != first["sessionId"] and not fresh["stale"]

    async def test_past_the_reuse_window_the_view_is_read_again(self, monkeypatch):
        monkeypatch.setattr(catalog_mod, "make_plan", _plan(UNITS))
        monkeypatch.setenv("DEEP_SEARCH_CATALOG_REUSE", "0")
        from backend.app.services.deep_search import get_deep_search_settings
        get_deep_search_settings.cache_clear()
        try:
            graph = _Graph(ENTITIES)
            first, _ = await _follow(_Provider(graph),
                                     SearchRunContext(data_version="1", scope_hash="h"))
            answer = await execute_catalog_session(
                _Provider(graph), SearchScope(view_id="v"),
                context=SearchRunContext(data_version="2", scope_hash="h"), wait_ms=0)
            assert answer["sessionId"] != first["sessionId"] and not answer["stale"]
        finally:
            get_deep_search_settings.cache_clear()

    async def test_another_scopes_catalog_is_never_served(self, monkeypatch):
        monkeypatch.setattr(catalog_mod, "make_plan", _plan(UNITS))
        graph = _Graph(ENTITIES)
        first, _ = await _follow(_Provider(graph), SearchRunContext(data_version="1", scope_hash="h"))
        other = await execute_catalog_session(
            _Provider(graph), SearchScope(view_id="v"),
            context=SearchRunContext(data_version="1", scope_hash="other"), wait_ms=0,
            session_id=first["sessionId"])
        assert other["sessionId"] != first["sessionId"]


# ---------------------------------------------------------------------------
# Service and route
# ---------------------------------------------------------------------------

def _eff(roots=()) -> EffectiveViewScope:
    return EffectiveViewScope(
        view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="graph",
        root_urns=tuple(roots), entity_type_allow_list=frozenset({"dataset"}),
        layer_allow_list=frozenset(), max_depth=12, scope_hash="scope-1")


def _service(provider, eff=None) -> AdvancedSearchService:
    svc = AdvancedSearchService(SimpleNamespace(provider=provider), session=None,
                                workspace_id="ws")

    async def resolve(requested):
        return eff or _eff()

    async def guard(scope):
        return None

    svc._resolve_scope = resolve
    svc._guard_view_data_source = guard
    return svc


class TestService:
    async def test_the_catalog_reads_the_resolved_scope(self):
        seen = {}

        class _Catalog:
            async def deep_search_catalog(self, scope, *, context, wait_ms, session_id=None,
                                          refresh=False):
                seen.update(types=scope.entity_types, scope_hash=context.scope_hash,
                            wait=wait_ms, sid=session_id, refresh=refresh)
                return {"sessionId": "s", "status": "complete", "entities": 3,
                        "properties": [{"key": "owner", "count": 3, "distinct": 1,
                                        "distinctExact": True,
                                        "values": [{"value": "ann", "kind": "String",
                                                    "count": 3}]}]}

        request = SearchCatalogRequest.model_validate({
            "scope": {"viewId": "v"}, "waitMs": 500, "sessionId": "prev", "refresh": True})
        out = await _service(_Catalog()).catalog(request)
        assert seen == {"types": ["dataset"], "scope_hash": "scope-1", "wait": 500,
                        "sid": "prev", "refresh": True}
        assert out.properties[0].values[0].value == "ann"

    async def test_roots_all_outside_the_view_read_nothing(self):
        request = SearchCatalogRequest.model_validate({
            "scope": {"viewId": "v", "rootUrns": ["urn:elsewhere"]}})
        out = await _service(SimpleNamespace(), _eff(roots=())).catalog(request)
        assert out.status == "complete" and out.properties == []

    async def test_a_provider_without_the_catalog_is_a_501(self):
        request = SearchCatalogRequest.model_validate({"scope": {"viewId": "v"}})
        with pytest.raises(NotImplementedError):
            await _service(SimpleNamespace()).catalog(request)


def _request(view_capability=None) -> Request:
    state = {} if view_capability is None else {"view_capability": view_capability}
    return Request({"type": "http", "headers": [], "state": state})


class TestRoute:
    @pytest.mark.parametrize("scope_mode", ["data_source", "visible"])
    async def test_a_share_link_stays_inside_its_view(self, scope_mode):
        body = SearchCatalogRequest.model_validate({
            "scope": {"viewId": "view-1", "scopeMode": scope_mode}})
        with pytest.raises(HTTPException) as exc:
            await graph_mod.search_catalog(body=body, request=_request("view-1"), ws_id="ws",
                                           engine=SimpleNamespace(provider=None), session=None)
        assert exc.value.status_code == 403

    async def test_the_catalog_needs_a_workspace(self):
        body = SearchCatalogRequest.model_validate({"scope": {"viewId": "v"}})
        with pytest.raises(HTTPException) as exc:
            await graph_mod.search_catalog(body=body, request=_request(), ws_id=None,
                                           engine=SimpleNamespace(provider=None), session=None)
        assert exc.value.status_code == 400
