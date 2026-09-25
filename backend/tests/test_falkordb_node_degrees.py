"""Degree totals ask for relationship types in the graph's own spelling.

FalkorDB matches relationship types case-sensitively, and ``get_edges``
already translates declared types to the source's observed spelling
(``_alias_rel_types``). ``get_node_degrees`` did not, so on a source that
spells its types differently every card counted zero and read as having no
lineage at all.

No live FalkorDB required — the graph handle is a stub.
"""
from types import SimpleNamespace

from backend.app.providers.falkordb_provider import FalkorDBProvider


def _provider():
    p = FalkorDBProvider(host="x", graph_name="g")
    p.asked = []

    async def _connected():
        return None

    async def _buckets(urns):
        return [("Dataset", list(urns))]

    async def _ro(cypher, params=None, timeout=None, **kw):
        p.asked.append(cypher)
        return SimpleNamespace(result_set=[["u1", 3]])

    p._ensure_connected = _connected
    p._label_buckets = _buckets
    p._ro_query = _ro
    return p


async def test_degrees_ask_for_the_graphs_own_spelling():
    p = _provider()
    p.set_source_type_aliases({"TRANSFORMS": ["transforms"]})

    degrees = await p.get_node_degrees(["u1"], ["TRANSFORMS"])

    assert degrees == {"u1": {"in": 3, "out": 3}}
    assert p.asked and all("[r:transforms]" in c for c in p.asked)
