"""Provider-level Redis caches must be namespaced by the PHYSICAL graph
(FalkorDB endpoint + graph name), not graph_name alone. graph_name defaults
to "nexus_lineage" and the DB uniqueness is (workspace, provider, graph_name),
so the same graph_name can name DIFFERENT physical graphs on different
instances — keying caches by graph_name alone leaked URN labels / ancestor
chains / regime across tenants on a shared CACHE_REDIS_URL.
"""
from backend.app.providers.falkordb_provider import FalkorDBProvider


def _p(host, port, graph):
    return FalkorDBProvider(host=host, graph_name=graph, port=port)


def test_cache_keys_include_host_port_not_just_graph_name():
    a = _p("falkordb-a", 6379, "nexus_lineage")
    b = _p("falkordb-b", 6379, "nexus_lineage")  # same graph_name, diff instance
    # Every provider cache key must differ between the two instances.
    assert a._urn_label_key() != b._urn_label_key()
    assert a._agg_regime_key() != b._agg_regime_key()
    assert a._agg_last_materialized_key() != b._agg_last_materialized_key()
    assert a._ancestors_cache_key() != b._ancestors_cache_key()
    # And each carries the physical discriminator.
    assert "falkordb-a:6379:nexus_lineage" in a._urn_label_key()
    assert "falkordb-b:6379:nexus_lineage" in b._urn_label_key()


def test_same_physical_graph_shares_cache():
    """Same endpoint + graph_name = the same physical graph → SAME key
    (sharing is correct; it is literally one graph)."""
    a = _p("falkordb-a", 6379, "g")
    b = _p("falkordb-a", 6379, "g")
    assert a._urn_label_key() == b._urn_label_key()
    assert a._ancestors_cache_key() == b._ancestors_cache_key()


def test_graph_selection_still_uses_bare_graph_name():
    """The namespace is a CACHE prefix only — the FalkorDB graph SELECTION
    must still target the bare graph name, not host:port:graph."""
    p = _p("falkordb-a", 6379, "mygraph")
    assert p._graph_name == "mygraph"
    assert p._cache_ns == "falkordb-a:6379:mygraph"
