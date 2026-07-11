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
             if "[r:FLOWS {id: item.eid}]" in c and "DELETE r" in c]
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
