"""Projector write-path contract (F3 audit finding).

Every FalkorDB query the projector issues must (a) anchor node lookups
on a LABEL so the per-label URN indexes drive them — the old unlabeled
``MATCH (a {urn: item.src})`` was a full node scan per UNWIND row, run
for EVERY edge of a full seed — and (b) carry an explicit server-side
``timeout`` so a degraded write is killed by FalkorDB instead of
outliving the client (the projector previously passed none at all,
and the new ``TIMEOUT_DEFAULT``/``TIMEOUT_MAX`` server args now kill
un-budgeted writes at 30s — mid-seed).
"""
import asyncio
from types import SimpleNamespace

from backend.app.services.versioning.projection import FalkorProjector
from backend.app.services.versioning.reconcile import SPELLING


def _run(coro):
    return asyncio.run(coro)


class _CaptureClient:
    """Records (cypher, params, timeout) for every query."""

    def __init__(self, result_rows=None):
        self.calls = []
        self._rows = result_rows or []

    async def query(self, cypher, params=None, timeout=None):
        self.calls.append((cypher, params, timeout))
        return SimpleNamespace(result_set=list(self._rows))

    def cyphers(self):
        return [c for c, _p, _t in self.calls]


class _NoTimeoutClient(_CaptureClient):
    """Simulates an older client lib whose query() has no timeout kwarg."""

    async def query(self, cypher, params=None):  # noqa: D401 - signature IS the point
        self.calls.append((cypher, params, None))
        return SimpleNamespace(result_set=[])


def _projector(**kw):
    return FalkorProjector(
        graph_client_factory=lambda name, provider_id=None: None,
        batch_size=10,
        **kw,
    )


_NODE_A = ("A", "urn:a", {"urn": "urn:a", "entityType": "Table", "displayName": "a"})
_NODE_B = ("B", "urn:b", {"urn": "urn:b", "entityType": "Dataset", "displayName": "b"})
# EdgeUpsert now carries the resolved endpoint labels.
_EDGE = ("E", "urn:a", "urn:b", {"edgeType": "FLOWS"}, "Table", "Dataset")


def test_edge_merges_are_label_anchored():
    client = _CaptureClient()
    p = _projector()
    _run(p._apply(client, [_NODE_A, _NODE_B], [_EDGE], [], []))
    edge_cyphers = [c for c in client.cyphers() if ":FLOWS" in c]
    assert edge_cyphers, f"no edge merge issued: {client.cyphers()}"
    for c in edge_cyphers:
        assert "MATCH (a:Table {urn: item.src})" in c
        assert "MATCH (b:Dataset {urn: item.tgt})" in c
    assert not any("MATCH (a {urn:" in c for c in client.cyphers())


def test_node_deletes_are_label_anchored():
    client = _CaptureClient()
    p = _projector()
    _run(p._apply(client, [], [], [("urn:x", "Table")], []))
    deletes = [c for c in client.cyphers() if "DETACH DELETE" in c]
    assert deletes and all("MATCH (n:Table {urn: u})" in c for c in deletes)


def test_edge_deletes_are_typed_and_anchored_with_fallback():
    client = _CaptureClient()
    p = _projector()
    resolved = {
        "eid": "E1", "src": "urn:a", "tgt": "urn:b",
        "rel": "FLOWS", "slb": "Table", "tlb": "Dataset",
    }
    _run(p._apply(client, [], [], [], [resolved, "E-unresolved"]))
    typed = [c for c in client.cyphers()
             if "-[r:FLOWS]->" in c and "WHERE r.id IN [item.eid, item.pid] DELETE r" in c]
    assert typed, f"no typed anchored edge delete: {client.cyphers()}"
    assert all("(a:Table {urn: item.src})" in c for c in typed)
    # The unresolvable eid still gets deleted via the legacy full form.
    fallback = [c for c in client.cyphers() if "[r {id: i}]" in c]
    assert fallback, "unresolved edge ids must fall back to the legacy delete"


def test_every_apply_query_carries_a_timeout():
    client = _CaptureClient()
    p = _projector()
    _run(p._apply(
        client, [_NODE_A, _NODE_B], [_EDGE], [("urn:x", "Table")],
        [{"eid": "E1", "src": "urn:a", "tgt": "urn:b",
          "rel": "FLOWS", "slb": "Table", "tlb": "Dataset"}],
    ))
    assert client.calls
    for cypher, _params, timeout in client.calls:
        assert timeout is not None, f"query without timeout: {cypher[:80]}"


def test_apply_tolerates_clients_without_timeout_kwarg():
    client = _NoTimeoutClient()
    p = _projector()
    _run(p._apply(client, [_NODE_A], [], [], []))
    assert client.calls, "old-signature client must still be driven"


def test_apply_rollups_queries_are_label_anchored():
    client = _CaptureClient()
    p = _projector()
    pairs = {
        ("urn:a", "urn:b"): {
            "dw": 1, "types": {"FLOWS"}, "sl": 2, "tl": 2, "dg": "d",
            "slb": "Table", "tlb": "Dataset",
        },
    }
    ok = _run(p._apply_rollups(client, pairs, 1, 2))
    assert ok is True
    body = [c for c in client.cyphers() if "AGGREGATED" in c]
    assert body, f"no rollup queries issued: {client.cyphers()}"
    for c in body:
        assert "MATCH (a {urn:" not in c and "MATCH (b {urn:" not in c, c
        assert ":Table" in c and ":Dataset" in c, c
    for cypher, _params, timeout in client.calls:
        assert timeout is not None, f"rollup query without timeout: {cypher[:80]}"


def test_a_pass_writes_and_matches_the_graph_own_spelling_of_its_types():
    """A customer graph spells ``Table`` as ``table`` and ``FLOWS`` as ``flows``
    (``projection_state.physical_types``): every label and type a pass writes or matches is the
    graph's own, and one the graph never had is written as declared."""
    client = _CaptureClient()
    p = _projector()
    token = SPELLING.set({"nodes": {"Table": "table"}, "edges": {"FLOWS": "flows"}})
    try:
        _run(p._apply(client, [_NODE_A, _NODE_B], [_EDGE], [("urn:x", "Table")],
                      [{"eid": "E1", "src": "urn:a", "tgt": "urn:b",
                        "rel": "FLOWS", "slb": "Table", "tlb": "Dataset"}]))
        _run(p._apply_rollups(client, {("urn:a", "urn:b"): {
            "dw": 1, "types": {"FLOWS"}, "sl": 2, "tl": 2, "dg": "d",
            "slb": "Table", "tlb": "Dataset"}}, 1, 2))
    finally:
        SPELLING.reset(token)
    written = " ".join(client.cyphers())
    assert "MERGE (n:table {urn: item.urn})" in written
    assert "MATCH (a:table {urn: item.src})" in written and "MERGE (a)-[r:flows]->(b)" in written
    assert "MATCH (n:table {urn: u}) DETACH DELETE n" in written
    assert "-[r:flows]->(b:Dataset {urn: item.tgt}) WHERE r.id IN" in written
    assert ":Dataset" in written
    assert ":Table" not in written and ":FLOWS" not in written, written


def _node_items(client):
    """Every node-merge batch item the projector wrote, flattened."""
    out = []
    for cypher, params, _t in client.calls:
        if "MERGE (n:" in cypher and params and "batch" in params:
            out.extend(params["batch"])
    return out


def test_node_merge_cypher_stamps_level():
    """RC2: the projector must stamp n.level like save_custom_graph (falkordb_provider.py:8757),
    else a rebuild drops it and trace level-pair filtering breaks."""
    from backend.app.services.versioning.projection import _node_merge_cypher
    assert "n.level = coalesce(item.level, n.level)" in _node_merge_cypher("Table")


def test_apply_stamps_level_from_map():
    client = _CaptureClient()
    p = _projector()
    _run(p._apply(client, [_NODE_A, _NODE_B], [], [], [], level_map={"Table": 2}))
    by_urn = {it["urn"]: it for it in _node_items(client)}
    assert by_urn["urn:a"]["level"] == 2            # Table is in the map
    assert by_urn["urn:b"]["level"] is None          # Dataset absent → unset (COALESCE keeps as-is)


def test_apply_level_none_when_map_empty():
    client = _CaptureClient()
    p = _projector()
    _run(p._apply(client, [_NODE_A], [], [], [], level_map={}))
    items = _node_items(client)
    assert items and all(it["level"] is None for it in items)


def test_resolve_level_map_reads_third_tuple_element():
    async def _resolver(svc, gid):
        return (["CONTAINS"], ["FLOWS"], {"Table": 2, "Dataset": 3})
    p = _projector(edge_types_resolver=_resolver)
    assert _run(p._resolve_level_map("g1")) == {"Table": 2, "Dataset": 3}


def test_resolve_level_map_empty_without_resolver():
    assert _run(_projector()._resolve_level_map("g1")) == {}


def test_resolve_level_map_swallows_resolver_error():
    async def _boom(svc, gid):
        raise RuntimeError("resolver down")
    assert _run(_projector(edge_types_resolver=_boom)._resolve_level_map("g1")) == {}


def test_seed_resolves_edge_labels_from_window_nodes():
    p = _projector()

    class _Svc:
        async def _state_as_of(self, s, gid, bid, seq):
            return {
                "A": _NODE_A[2],
                "B": _NODE_B[2],
                "E": {"sourceEntityId": "A", "targetEntityId": "B",
                      "edgeType": "FLOWS"},
            }

        async def _main_branch_id(self, s, gid):
            return "main"

    p._svc = _Svc()
    graph = SimpleNamespace(id="g1", fork_parent_graph_id=None)
    nodes, edges, ndel, edel = _run(
        p._compute_changes(None, graph, "main", 0, 5)
    )
    assert len(edges) == 1
    eid, su, tu, payload, slb, tlb = edges[0]
    assert (su, tu) == ("urn:a", "urn:b")
    assert (slb, tlb) == ("Table", "Dataset")


def test_urnless_node_resolves_to_the_label_it_was_merged_under():
    """A node published without a urn is merged as ``(:<entityType> {urn: 'gv:<id>'})``; its
    delete and its edges' ends must anchor on that label, not ``:Entity``, or they miss it and
    a deleted node stays in FalkorDB."""
    p = _projector()

    class _Session:
        async def execute(self, stmt):
            sql = str(stmt)
            # Only B's create row exists, and it carries no urn.
            row = None if "urn IS NOT NULL" in sql else ("Dataset",)
            return SimpleNamespace(first=lambda: row)

    graph = SimpleNamespace(id="g1", fork_parent_graph_id=None)
    assert _run(p._urn_label_for(_Session(), graph, "main", "B")) == ("gv:B", "Dataset")
    assert _run(p._endpoint(_Session(), graph, "main", "B", {}, {})) == ("gv:B", "Dataset")


def test_an_edge_delete_also_finds_the_id_the_graph_knows_it_by():
    """An edge re-keyed ``edge:<id>`` in history (its id was also a node's) is ``<id>`` in the
    customer's graph: the delete matches either."""
    client = _CaptureClient()
    _run(_projector()._apply(client, [], [], [], [
        {"eid": "edge:X", "src": "urn:a", "tgt": "urn:b",
         "rel": "FLOWS", "slb": "Table", "tlb": "Dataset"}]))
    (params,) = [p for c, p, _t in client.calls if "DELETE r" in c]
    assert params["batch"] == [{"eid": "edge:X", "pid": "X", "src": "urn:a", "tgt": "urn:b"}]


def test_a_customer_graph_keeps_the_id_its_relationship_has():
    owned, customer = _CaptureClient(), _CaptureClient()
    _run(_projector()._apply(owned, [_NODE_A, _NODE_B], [_EDGE], [], []))
    _run(_projector()._apply(customer, [_NODE_A, _NODE_B], [_EDGE], [], [], owned=False))
    assert any("SET r.id = item.eid," in c for c in owned.cyphers())
    assert any("SET r.id = coalesce(r.id, item.eid)," in c for c in customer.cyphers())


class _HeldClient(_CaptureClient):
    """Node ``urn:a`` holds ``held`` property names, as the strip's read sees it; an edge merge
    reports ``landed`` items."""

    def __init__(self, held=(), landed=None):
        super().__init__()
        self._held, self._landed = list(held), landed

    async def query(self, cypher, params=None, timeout=None):
        self.calls.append((cypher, params, timeout))
        if "RETURN u, keys(n)" in cypher:
            return SimpleNamespace(result_set=[["urn:a", self._held, None, None]])
        if "RETURN count(DISTINCT item.eid)" in cypher and self._landed is not None:
            return SimpleNamespace(result_set=[[self._landed]])
        return SimpleNamespace(result_set=[])


def _gone(client):
    return [i["gone"] for _c, p, _t in client.calls if p and "batch" in p
            for i in p["batch"] if "gone" in i]


def test_a_customer_key_keeps_the_properties_history_never_held():
    """A property the node had before the pass and lost is removed; one history never held was
    written by something else, and stays."""
    node = ("A", "urn:a", {"urn": "urn:a", "entityType": "Table", "displayName": "a",
                           "properties": {"kept": 1}})
    owned, customer = _HeldClient(["kept", "dropped", "etl"]), _HeldClient(["kept", "dropped", "etl"])
    _run(_projector()._apply(owned, [node], [], [], []))
    _run(_projector()._apply(customer, [node], [], [], [], owned=False,
                             prior={"A": {"kept", "dropped"}}))
    assert _gone(owned) == [{"dropped": None, "etl": None}]
    assert _gone(customer) == [{"dropped": None}]


def test_an_edge_whose_endpoint_is_not_there_is_counted_as_not_landed():
    assert _run(_projector()._apply(_HeldClient(landed=0), [], [_EDGE], [], [])) == 1
    assert _run(_projector()._apply(_HeldClient(landed=1), [], [_EDGE], [], [])) == 0
