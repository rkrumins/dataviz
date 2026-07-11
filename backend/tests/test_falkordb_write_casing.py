"""Write-side casing consistency for provider-direct edge/node creation.

FalkorDB matches labels and relationship types case-SENSITIVELY: a graph
holding both ``:HAS`` and ``:has`` fragments one logical type across two
relation matrices, every consumer must enumerate variants (or miss
rows), and a differently-cased node label makes ``MERGE (n:Table {urn})``
CREATE A DUPLICATE of an existing ``:table`` node instead of updating it.

The versioned write path already canonicalizes payload types to the
ontology's declared casing at the commit boundary; these tests pin the
same guarantee for the provider-DIRECT writers (``save_custom_graph``,
``create_node``'s containment edge, ``create_edge``): a type or label is
written in the graph's ALREADY-OBSERVED casing when a case-fold variant
exists, and a genuinely new spelling becomes the graph's canonical one —
including across a single call that mixes casings. The vocabulary probe
failing must never block writes (write-as-given degradation).
"""
import asyncio
from types import SimpleNamespace

from backend.app.providers.falkordb_provider import FalkorDBProvider
from backend.common.models.graph import GraphEdge, GraphNode


def _run(coro):
    return asyncio.run(coro)


def _node(urn, entity_type):
    return GraphNode(urn=urn, entityType=entity_type, displayName=urn)


def _edge(eid, src, tgt, edge_type):
    return GraphEdge(id=eid, sourceUrn=src, targetUrn=tgt, edgeType=edge_type)


def _provider(observed_rels=(), observed_labels=(), probe_fails=False):
    p = FalkorDBProvider(host="x", graph_name="g")
    p.queries = []

    async def noop(*a, **k):
        return None

    async def ro_query(cypher, params=None, **kw):
        if probe_fails:
            raise RuntimeError("vocab probe down")
        if "db.relationshipTypes" in cypher:
            return SimpleNamespace(result_set=[[t] for t in observed_rels])
        if "db.labels" in cypher:
            return SimpleNamespace(result_set=[[l] for l in observed_labels])
        return SimpleNamespace(result_set=[])

    async def query(cypher, params=None, **kw):
        p.queries.append(cypher)
        return SimpleNamespace(result_set=[])

    async def resolve_bulk(urns):
        return {u: None for u in urns}

    p._ensure_connected = noop
    p._ro_query = ro_query
    p._query = query
    p._cache_urn_labels_bulk = noop
    p._resolve_urn_labels_bulk = resolve_bulk
    p.ensure_indices = noop
    p._redis = None
    return p


def test_save_follows_the_graphs_existing_casing():
    p = _provider(observed_rels=["HAS"], observed_labels=["Table"])
    ok = _run(p.save_custom_graph(
        [_node("u1", "table"), _node("u2", "table")],
        [_edge("e1", "u1", "u2", "has")],
    ))
    assert ok
    joined = "\n".join(p.queries)
    assert "(n:Table {urn:" in joined, joined
    assert "[r:HAS]" in joined, joined
    assert ":table" not in joined and "[r:has]" not in joined, (
        "a case variant of an existing type/label must never mint a "
        "second casing (fragmented matrices, duplicate urn nodes)"
    )


def test_mixed_casings_within_one_call_collapse_to_one():
    p = _provider()                      # empty graph — first spelling wins
    _run(p.save_custom_graph(
        [_node("u1", "Column"), _node("u2", "column")],
        [_edge("e1", "u1", "u2", "FLOWS"), _edge("e2", "u2", "u1", "flows")],
    ))
    joined = "\n".join(p.queries)
    assert "[r:FLOWS]" in joined and "[r:flows]" not in joined, joined
    assert "(n:Column {urn:" in joined and "(n:column {urn:" not in joined, joined


def test_probe_failure_never_blocks_writes():
    p = _provider(probe_fails=True)
    ok = _run(p.save_custom_graph(
        [_node("u1", "table")], [_edge("e1", "u1", "u1x", "has")],
    ))
    assert ok
    joined = "\n".join(p.queries)
    assert "(n:table {urn:" in joined and "[r:has]" in joined, (
        "vocabulary probe failure must degrade to write-as-given"
    )


def test_create_node_containment_edge_follows_observed_casing():
    p = _provider(observed_rels=["CONTAINS"], observed_labels=["Table"])
    ok = _run(p.create_node(
        _node("u3", "table"),
        containment_edge=_edge("e9", "parent", "u3", "contains"),
    ))
    assert ok
    joined = "\n".join(p.queries)
    assert "[r:CONTAINS]" in joined and "[r:contains]" not in joined, joined
    assert ":Table" in joined and ":table" not in joined, joined


def test_create_edge_follows_observed_casing():
    p = _provider(observed_rels=["FLOWS_TO"])
    ok = _run(p.create_edge(_edge("e1", "a", "b", "flows_to")))
    assert ok
    joined = "\n".join(p.queries)
    assert "[r:FLOWS_TO]" in joined and "[r:flows_to]" not in joined, joined
