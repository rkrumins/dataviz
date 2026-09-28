"""FalkorDB ``get_edges`` between a few known endpoints binds BOTH ends by index.

Anchoring on the source alone walked its whole out-degree and filtered the
targets afterwards, so reading one relationship off a hub source (a warehouse
feeding thousands of tables) read every edge it had. With a handful of pairs
the read seeks each end by its label's URN index and expands between them.
Pins: the both-ends query shape (and what it carries — types, confidence,
limit), one sub-query per label-bucket pair, and the fall-backs — too many
pairs, or an end whose label is unknown (an unlabeled anchor is a full scan).
"""
import asyncio

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.common.models.graph import EdgeQuery


class _Result:
    def __init__(self, result_set=None):
        self.result_set = result_set or []


LABELS = {
    "urn:wh": "Warehouse",
    "urn:t1": "Table",
    "urn:t2": "Table",
    "urn:d1": "Dashboard",
}


def _provider(rows_for=lambda cypher, params: [], labels=LABELS):
    p = FalkorDBProvider(host="x", graph_name="g")
    p._redis = None
    calls = []

    async def _connected():
        return None

    async def _buckets(urns):
        by = {}
        for u in dict.fromkeys(u for u in urns if u):
            by.setdefault(labels.get(u) or "", []).append(u)
        return sorted(by.items())

    async def _ro_query(cypher, params=None, timeout=None, op=None, **kw):
        calls.append((cypher, params or {}))
        return _Result(rows_for(cypher, params or {}))

    p._ensure_connected = _connected
    p._label_buckets = _buckets
    p._ro_query = _ro_query
    p._alias_rel_types = lambda types: list(types)
    return p, calls


def _run(coro):
    return asyncio.run(coro)


def _edges_query(**kw):
    return EdgeQuery(**kw)


def test_one_pair_binds_both_ends_by_index_and_expands_between():
    def rows(cypher, params):
        return [["urn:wh", "urn:t1", "FLOWS_TO", {"id": "e1", "confidence": 0.9}]]

    p, calls = _provider(rows)
    edges = _run(p.get_edges(_edges_query(sourceUrns=["urn:wh"], targetUrns=["urn:t1"], edgeTypes=["FLOWS_TO"])))

    assert [e.id for e in edges] == ["e1"]
    assert len(calls) == 1
    cypher, params = calls[0]
    assert "MATCH (a:Warehouse) WHERE a.urn IN $sourceUrns" in cypher
    assert "MATCH (b:Table) WHERE b.urn IN $targetUrns" in cypher
    assert "MATCH (a)-[r:FLOWS_TO]->(b)" in cypher
    assert params["sourceUrns"] == ["urn:wh"] and params["targetUrns"] == ["urn:t1"]


def test_one_query_per_label_bucket_pair_and_the_limit_holds():
    def rows(cypher, params):
        return [[s, t, "FLOWS_TO", {"id": f"{s}>{t}"}] for s in params["sourceUrns"] for t in params["targetUrns"]]

    p, calls = _provider(rows)
    edges = _run(p.get_edges(_edges_query(
        sourceUrns=["urn:wh", "urn:t1", "urn:t2"], targetUrns=["urn:d1", "urn:t2"], limit=4,
    )))

    # sources: Table{t1,t2}, Warehouse{wh}; targets: Dashboard{d1}, Table{t2} → 4 bucket pairs.
    assert len(calls) == 4
    assert all("MATCH (a:" in c and "MATCH (b:" in c for c, _ in calls)
    assert len(edges) == 4


def test_min_confidence_is_applied_to_the_relationship():
    p, calls = _provider()
    _run(p.get_edges(_edges_query(sourceUrns=["urn:wh"], targetUrns=["urn:t1"], minConfidence=0.5)))
    cypher, params = calls[0]
    assert "MATCH (a)-[r]->(b) WHERE r.confidence >= $minConf" in cypher
    assert params["minConf"] == 0.5


def test_many_pairs_keep_the_one_sided_anchor():
    sources = [f"urn:s{i}" for i in range(9)]
    targets = [f"urn:x{i}" for i in range(8)]
    p, calls = _provider(labels={u: "Table" for u in sources + targets})
    _run(p.get_edges(_edges_query(sourceUrns=sources, targetUrns=targets)))

    assert calls and all("MATCH (b:" not in c for c, _ in calls)
    assert all("b.urn IN $targetUrns" in c for c, _ in calls)


def test_an_unknown_label_falls_back_to_the_one_sided_anchor():
    p, calls = _provider()
    _run(p.get_edges(_edges_query(sourceUrns=["urn:wh"], targetUrns=["urn:unlabeled"])))

    assert len(calls) == 1
    cypher, _ = calls[0]
    assert "MATCH (a:Warehouse)-[r]->(b)" in cypher
    assert "MATCH (b:" not in cypher


def test_a_source_only_read_is_unchanged():
    p, calls = _provider()
    _run(p.get_edges(_edges_query(sourceUrns=["urn:wh"])))

    assert len(calls) == 1
    assert "MATCH (a:Warehouse)-[r]->(b) WHERE a.urn IN $anchorUrns" in calls[0][0]
