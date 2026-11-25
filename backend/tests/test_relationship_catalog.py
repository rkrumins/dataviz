"""The view's relationship properties: every key its relationships carry, on
how many, stored as which kinds, with which values — the entity catalog's
answer, for relationships, exact.

Here against a scripted scan: a relationship's native keys and its JSON bag
counted as every reader takes them (the bag wins a name both hold), the
envelope never shown, the bag read a page at a time, and the session kept
apart from the entity catalog's. The live suite holds the answers to a real
graph (``tests/integration/test_search_engine_live.py``).
"""
from __future__ import annotations

import json

import pytest

from backend.app.providers.falkordb_search import catalog as catalog_mod
from backend.app.providers.falkordb_search import relationship_catalog as rc
from backend.app.providers.falkordb_search.catalog import execute_catalog_session
from backend.app.providers.falkordb_search.edges import EdgeContext
from backend.app.providers.falkordb_search.keys import SortKey, SortSpec
from backend.app.providers.falkordb_search.plan import Context, Plan, Unit
from backend.app.providers.falkordb_search.session import MemorySessionStore
from backend.app.services.deep_search import SearchRunContext
from backend.common.models.search import SearchScope


class _Result:
    def __init__(self, rows):
        self.result_set = rows


def _kind(v):
    return catalog_mod._kind_of(v)


class _Graph:
    """Answers each relationship catalog statement for a unit's source label
    from scripted relationships: ``{label: [(type, properties(e)), ...]}`` —
    a relationship's position stands for its source's and its own ID."""

    def __init__(self, edges):
        self.edges = edges
        self.statements = []

    def rows(self, label, params):
        lo, hi = params.get("_lo"), params.get("_hi")
        return [(i, t, p) for i, (t, p) in enumerate(self.edges[label])
                if (lo is None or i >= lo) and (hi is None or i < hi)]

    async def run(self, cypher, params, timeout_s):
        label = cypher.split("MATCH (n:`", 1)[1].split("`", 1)[0]
        self.statements.append(cypher)
        rows = self.rows(label, params)
        no_bag = [(i, t, p) for i, t, p in rows if p.get("properties") in (None, "{}")]
        if "RETURN type(e), count(e)" in cypher:
            tally = {}
            for _, t, _p in rows:
                tally[t] = tally.get(t, 0) + 1
            return _Result([[t, n] for t, n in tally.items()])
        if "RETURN ID(n), ID(e), type(e), properties(e)" in cypher:
            held = [[i, i, t, p] for i, t, p in rows if p.get("properties") not in (None, "{}")
                    and (i > params["_an"] or (i == params["_an"] and i > params["_ae"]))]
            return _Result(held[:params["_page"]])
        if "UNWIND keys(e)" in cypher:
            tally = {}
            for _, t, p in no_bag:
                for k, v in p.items():
                    tally[(t, k, _kind(v))] = tally.get((t, k, _kind(v)), 0) + 1
            return _Result([[[[t, k, kind, n] for (t, k, kind), n in tally.items()]]])
        if "LIMIT $_probe" in cypher:
            head = no_bag[:params["_probe"]]
            return _Result([[k, len({json.dumps(p[k]) for _, _, p in head if k in p})]
                            for k in params["_keys"]])
        if "IN ['Integer', 'Float']" in cypher:
            out = []
            for k in params["_keys"]:
                nums = [p[k] for _, _, p in no_bag if _kind(p.get(k)) in ("Integer", "Float")]
                pos, neg = [x for x in nums if x >= 0], [x for x in nums if x < 0]
                out.append([k, min(pos, default=None), max(pos, default=None),
                            min(neg, default=None), max(neg, default=None)])
            return _Result(out)
        if "collect([_t, _x, _c])" in cypher:
            out = []
            for k in params["_keys"]:
                counts = {}
                for _, _, p in no_bag:
                    if k not in p:
                        continue
                    for e in (p[k] if isinstance(p[k], list) else [p[k]]):
                        slot = (_kind(e), json.dumps(e))
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


def _ectx():
    anchor = Context(where="true", params={}, sort=SortSpec((SortKey("n.urn"),)),
                     containment=("CONTAINS",), max_depth=12, visible=None)
    return EdgeContext(anchor=anchor, anchor_side="source", rel="FEEDS|OWNS", edge_where="",
                       far_head="true", far_stages=())


@pytest.fixture(autouse=True)
def scripted(monkeypatch):
    from backend.app.providers.falkordb_search import session as session_mod
    store = MemorySessionStore()
    monkeypatch.setattr(session_mod, "_MEMORY", store)
    monkeypatch.setattr(rc, "edge_context", lambda provider, query, state: _ectx())

    def match(unit, ectx, clamps):
        # The anchor end's band, then its edges — what ``edges.edge_match`` binds.
        params = {k: v for k, v in (("_lo", unit.lo), ("_hi", unit.hi)) if v is not None}
        return f"MATCH (n:`{unit.label}`) WITH n MATCH (n)-[e:FEEDS|OWNS]->(m)", params

    monkeypatch.setattr(rc, "_match", match)
    return store


def _plan(units, state=None):
    async def plan(provider, scope, run, settings, deadline):
        return Plan(list(units)), dict(state or {"anchor": "source"})
    return plan


def _bag(**props):
    return json.dumps(props)


#: Relationships from datasets: native keys within the budget, the rest — every one, for a
#: relationship written before that — in the JSON bag.
EDGES = {
    "Dataset": [
        ("FEEDS", {"id": "e0", "gvHash": "h", "confidence": 0.9, "properties": "{}",
                   "schedule": "daily", "lag": 5}),
        ("FEEDS", {"id": "e1", "gvHash": "h", "confidence": 0.5, "properties": "{}",
                   "schedule": "hourly", "lag": -2}),
        ("FEEDS", {"id": "e2", "gvHash": "h", "properties": _bag(schedule="daily", job="nightly"),
                   "lag": 7}),
        # A name both hold: the bag's value is the relationship's, as its readers read it.
        ("OWNS", {"id": "e3", "properties": _bag(since=2020, schedule="weekly"),
                  "schedule": "stale"}),
        # A confidence that isn't a number is the user's.
        ("OWNS", {"id": "e4", "properties": "{}", "confidence": "high"}),
    ],
}
UNITS = [Unit("range", "Dataset", 0, 3, size=3), Unit("range", "Dataset", 3, None, size=2)]


async def _follow(provider, context, **kw):
    sid, requests = None, 0
    while True:
        out = await execute_catalog_session(provider, SearchScope(view_id="v"), context=context,
                                            wait_ms=0, session_id=sid, subject="relationships",
                                            **kw)
        sid, requests = out["sessionId"], requests + 1
        if out["status"] == "complete":
            return out, requests
        assert requests < 20


class TestRelationshipCatalog:
    async def test_every_relationship_is_counted_as_its_readers_read_it(self, monkeypatch):
        monkeypatch.setattr(rc, "relationship_plan", _plan(UNITS))
        out, _ = await _follow(_Provider(_Graph(EDGES)),
                               SearchRunContext(data_version="1", scope_hash="h"))
        assert out["subject"] == "relationships"
        assert out["entities"] == 5
        assert out["entityTypes"] == [{"type": "FEEDS", "count": 3}, {"type": "OWNS", "count": 2}]
        # Relationships carry no tags.
        assert out["tags"] == [] and out["tagged"] is None
        props = {p["key"]: p for p in out["properties"]}
        # The envelope never shows: its id, hash, the bag itself and a numeric confidence.
        assert set(props) == {"schedule", "lag", "job", "since", "confidence"}
        schedule = props["schedule"]
        assert schedule["count"] == 4
        assert schedule["byEntityType"] == {"FEEDS": 3, "OWNS": 1}
        assert {v["value"]: v["count"] for v in schedule["values"]} == {
            "daily": 2, "hourly": 1, "weekly": 1}          # "stale" lost to the bag's value
        assert schedule["residual"] == 2                  # held in the bag by e2 and e3
        assert (props["lag"]["min"], props["lag"]["max"]) == (-2, 7)
        assert props["lag"]["count"] == 3 and props["lag"]["residual"] == 0
        assert props["job"]["residual"] == 1 and props["job"]["byEntityType"] == {"FEEDS": 1}
        assert props["since"]["kinds"] == {"Integer": 1}
        assert props["confidence"]["values"] == [{"value": "high", "kind": "String", "count": 1}]

    async def test_bags_past_a_reply_are_read_a_page_at_a_time(self, monkeypatch):
        monkeypatch.setattr(rc, "relationship_plan", _plan(UNITS))
        monkeypatch.setattr(catalog_mod, "PAGE", 1)
        graph = _Graph({"Dataset": [("FEEDS", {"properties": _bag(n=i)}) for i in range(5)]})
        monkeypatch.setattr(rc, "relationship_plan",
                            _plan([Unit("range", "Dataset", 0, None, size=5)]))
        out, _ = await _follow(_Provider(graph), SearchRunContext(data_version="1", scope_hash="h"))
        n = {p["key"]: p for p in out["properties"]}["n"]
        assert n["count"] == 5 and n["residual"] == 5 and (n["min"], n["max"]) == (0, 4)
        bag_reads = [c for c in graph.statements if "properties(e)" in c]
        assert len(bag_reads) == 6                        # five full pages, then an empty one

    async def test_a_key_past_the_cap_in_the_bag_is_high_cardinality(self, monkeypatch):
        monkeypatch.setattr(catalog_mod, "VALUES_MAX", 3)
        graph = _Graph({"Dataset": [("FEEDS", {"properties": _bag(run=f"r{i}", tier="gold")})
                                    for i in range(6)]})
        monkeypatch.setattr(rc, "relationship_plan",
                            _plan([Unit("range", "Dataset", 0, None, size=6)]))
        out, _ = await _follow(_Provider(graph), SearchRunContext(data_version="1", scope_hash="h"))
        props = {p["key"]: p for p in out["properties"]}
        assert props["run"]["values"] == [] and not props["run"]["distinctExact"]
        assert props["run"]["distinct"] >= 4
        assert props["tier"]["values"] == [{"value": "gold", "kind": "String", "count": 6}]

    async def test_its_sessions_are_kept_apart_from_the_entity_catalogs(self, monkeypatch,
                                                                         scripted):
        monkeypatch.setattr(rc, "relationship_plan", _plan(UNITS))
        context = SearchRunContext(data_version="1", scope_hash="h")
        graph = _Graph(EDGES)
        first, _ = await _follow(_Provider(graph), context)
        seen = len(graph.statements)
        # Served again from what it kept, with no scan …
        again = await execute_catalog_session(_Provider(graph), SearchScope(view_id="v"),
                                              context=context, wait_ms=0, subject="relationships")
        assert again["sessionId"] == first["sessionId"] and len(graph.statements) == seen
        assert again["entities"] == 5
        # … and never as the same scope's entity catalog, nor that as this.
        assert await scripted.pointed("catalog:h") is None
        assert await scripted.pointed("catalog:relationships:h") == first["sessionId"]

    async def test_a_resumed_session_keeps_what_its_edges_are_read_by(self, monkeypatch):
        """Which end anchors and what the far end's scope check reads are planned once and
        kept with the session: a later request reads its units the same way."""
        seen_states = []

        def context(provider, query, state):
            seen_states.append(dict(state))
            return _ectx()

        monkeypatch.setattr(rc, "edge_context", context)
        three = [Unit("range", "Dataset", 0, 2, size=2), Unit("range", "Dataset", 2, 4, size=2),
                 Unit("range", "Dataset", 4, None, size=1)]
        monkeypatch.setattr(rc, "relationship_plan",
                            _plan(three, {"anchor": "source", "far_labels": ["dataset"]}))
        out, requests = await _follow(_Provider(_Graph(EDGES)),
                                      SearchRunContext(data_version="1", scope_hash="h"))
        assert requests > 1 and out["entities"] == 5
        assert all(s == {"anchor": "source", "far_labels": ["dataset"]} for s in seen_states)


class TestStatements:
    def test_the_native_part_reads_only_relationships_with_an_empty_bag(self):
        unit = Unit("range", "Dataset", 0, 10, size=10)
        cypher, _ = rc.keys_statement(unit, _ectx(), [])
        assert rc._NO_BAG in cypher
        for build in (rc.probe_statement, rc.values_statement, rc.bounds_statement):
            cypher, params = build(unit, _ectx(), [], ["k"])
            assert rc._NO_BAG in cypher and params["_keys"] == ["k"]
        cypher, params = rc.bag_statement(unit, _ectx(), [], (-1, -1))
        assert f"NOT {rc._NO_BAG}" in cypher and params["_page"] == catalog_mod.PAGE
        assert "ORDER BY ID(n), ID(e)" in cypher

    def test_every_relationship_type_but_the_rollups_is_read(self):
        query = rc.scan_query(SearchScope(view_id="v"))
        assert query.predicate.kind == "edges" and query.predicate.edge_class == "any"
        assert query.predicate.direction == "outgoing"
