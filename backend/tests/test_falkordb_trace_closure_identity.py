"""A lineage partner with no usable urn never fails a read — it is left out,
and the closure says how many edges that cost.

Reported live: on an onboarded graph, every Focus-lens and Trace walk's fine
first page (``maxNodes: 600``) answered 500 with "1 validation error for
GraphEdge sourceUrn — Input should be a valid string". The walk returned a
neighbour's raw ``o.urn`` (null) and built a ``GraphEdge`` from it, so one
such neighbour anywhere in the page failed the whole page, for every entity.
The coarse leg succeeded only because it skipped null partners.

"No usable urn" is null, but also a non-text urn (an integer id stamped as-is)
and the empty string: no urn lookup can ever match one, so nothing can draw,
search or trace the node. The filter lives in the query, before LIMIT, so the
degree-exact walk's cursors and drift tripwire are untouched; the fake honours
it only when the query carries the predicate, as the database would.
"""
from types import SimpleNamespace

import pytest

from backend.app.models.graph import GraphNode
from backend.app.providers import falkordb_provider as fp
from backend.common.models.graph import EdgeQuery, TraceClosureResult
from backend.tests.test_falkordb_trace_structural import (
    _Result, _TraceFake, _label, _make_provider, _run,
)
from backend.tests.test_trace_closure_completeness import _assert_no_e0, _closure, _edges, _shipped

UNUSABLE = [None, 7, ""]
UNUSABLE_IDS = ["null", "int", "empty"]


@pytest.fixture(autouse=True)
def _fresh_warnings():
    fp._unaddressable_warned.clear()
    yield
    fp._unaddressable_warned.clear()


# ── the fine walk ────────────────────────────────────────────────────────


@pytest.mark.parametrize("bad", UNUSABLE, ids=UNUSABLE_IDS)
@pytest.mark.parametrize("side", ["up", "down"])
def test_a_partner_with_no_usable_urn_is_left_out_and_counted(bad, side):
    fake = _TraceFake()
    if side == "up":
        fake.lineage = [("u_ok", "f", "FLOWS"), (bad, "f", "FLOWS")]
    else:
        fake.lineage = [("f", "d_ok", "FLOWS"), ("f", bad, "FLOWS")]
    p = _make_provider(fake)

    r = _closure(p, "f", up=int(side == "up"), down=int(side == "down"), max_nodes=600)

    assert _edges(r) == ({("u_ok", "f")} if side == "up" else {("f", "d_ok")})
    assert all(isinstance(u, str) and u for e in r.edges for u in (e.source_urn, e.target_urn))
    # Complete for every partner that can be addressed: not a truncation.
    assert r.truncated is False and r.truncation_reason is None
    assert r.unresolved_edges == 1
    wire = r.model_dump(by_alias=True)
    assert wire["unresolvedEdges"] == 1
    assert TraceClosureResult.model_validate(wire).unresolved_edges == 1


def test_a_page_with_nothing_left_out_reports_zero():
    fake = _TraceFake()
    fake.lineage = [("u_ok", "f", "FLOWS"), ("f", "d_ok", "FLOWS")]
    r = _closure(_make_provider(fake), "f", max_nodes=600)
    assert r.unresolved_edges == 0


def test_an_old_cached_payload_without_the_field_still_validates():
    fake = _TraceFake()
    fake.lineage = [("u_ok", "f", "FLOWS")]
    wire = _closure(_make_provider(fake), "f", max_nodes=600).model_dump(by_alias=True)
    wire.pop("unresolvedEdges")
    assert TraceClosureResult.model_validate(wire).unresolved_edges == 0


def test_the_left_out_edges_are_logged_once_per_graph(caplog):
    fake = _TraceFake()
    fake.lineage = [("u_ok", "f", "FLOWS"), (None, "f", "FLOWS")]
    p = _make_provider(fake)
    with caplog.at_level("WARNING", logger=fp.logger.name):
        _closure(p, "f", down=0, max_nodes=600)
        _closure(p, "f", down=0, max_nodes=600)
    hits = [m for m in caplog.messages if "Node Identity Property" in m]
    assert len(hits) == 1


def test_a_descendant_with_a_non_text_urn_is_never_an_anchor():
    """A container's lineage-bearing descendants seed the walk. An integer urn
    there would have been walked as an anchor — its own rows carry it on the
    NEAR end, which no far-end filter sees — and minted ``s:7`` cursors."""
    fake = _TraceFake()
    fake.contain("dom", "leaf_a")
    fake.contain("dom", 7)
    fake.lineage = [("leaf_a", "sink_a", "FLOWS"), (7, "sink_b", "FLOWS")]
    p = _make_provider(fake)

    r = _closure(p, "dom", up=0, down=1, max_nodes=600)

    assert _edges(r) == {("leaf_a", "sink_a")}
    assert 7 not in _shipped(r) and "sink_b" not in _shipped(r)
    assert r.seed_cursor is None and r.truncation_reason is None


def test_the_degree_estimate_counts_only_what_the_walk_can_ship():
    """An anchor whose adjacency is mostly unusable: with a degree that
    counted every edge, the walk would budget for rows that never come back
    (and with a filter only in Python, read a short page as drift)."""
    fake = _TraceFake()
    fake.lineage = [("f", "d_ok", "FLOWS")] + [("f", None, "FLOWS")] * 20
    p = _make_provider(fake)

    # Budget for the focus + its one usable partner: 2 nodes.
    r = _closure(p, "f", up=0, down=1, max_nodes=2)

    assert _edges(r) == {("f", "d_ok")}
    assert r.truncation_reason is None
    assert r.unresolved_edges == 20


def test_a_hub_pages_its_usable_edges_completely_and_counts_the_rest_once():
    """The hub no page can hold is paged by edge id. Unusable rows never come
    back from the page query, so every page still fills to its limit and the
    cursor names the next real id — the hub drains with nothing lost."""
    fake = _TraceFake()
    fake.lineage = [(None, "hub", "FLOWS")] + [(f"u{i:02d}", "hub", "FLOWS") for i in range(50)]
    fake.lineage.insert(25, (7, "hub", "FLOWS"))
    p = _make_provider(fake)
    usable = {(f"u{i:02d}", "hub") for i in range(50)}

    first = _closure(p, "hub", up=1, down=0, max_nodes=10)
    got, counted, cursor = set(_edges(first)), [first.unresolved_edges], None
    hub = [f for f in first.frontier_up if f.urn == "hub"]
    cursor = hub[0].next_cursor if hub else None
    for _ in range(20):
        if cursor is None:
            break
        page = _closure(p, "hub", up=1, down=0, max_nodes=10, after_cursor=cursor)
        _assert_no_e0(page)
        assert page.truncation_reason in (None, "max_nodes")
        got |= _edges(page)
        counted.append(page.unresolved_edges)
        nxt = [f for f in page.frontier_up if f.urn == "hub" and f.next_cursor]
        cursor = nxt[0].next_cursor if nxt else None

    assert cursor is None, "the hub never drained"
    assert got == usable
    # Told on the hub's first page; the pages that drain it never repeat it.
    assert counted[0] == 2 and sum(counted[1:]) == 0


def test_an_after_cursor_page_resumes_past_unusable_rows_without_shortening():
    fake = _TraceFake()
    fake.adjacency[("hub", "incoming")] = [
        ("u0", "FLOWS"), (None, "FLOWS"), (5, "FLOWS"), ("u3", "FLOWS"), ("u4", "FLOWS"),
    ]
    p = _make_provider(fake)

    first = _closure(p, "hub", up=1, down=0, max_nodes=2, after_cursor="e:0")
    assert _edges(first) == {("u0", "hub"), ("u3", "hub")}
    [hub] = [f for f in first.frontier_up if f.urn == "hub"]
    assert hub.next_cursor == "e:4"

    rest = _closure(p, "hub", up=1, down=0, max_nodes=2, after_cursor="e:4")
    assert _edges(rest) == {("u4", "hub")}
    assert not [f for f in rest.frontier_up if f.urn == "hub" and f.next_cursor]


def test_the_frontier_probe_counts_only_edges_a_page_could_ship():
    """A boundary node whose remaining edges all end at unusable nodes must
    not advertise "+N more": no page could ever bring them."""
    fake = _TraceFake()
    fake.lineage = [("u_ok", "f", "FLOWS"), (None, "u_ok", "FLOWS")]
    fake.degrees["u_ok"] = {"in": 0, "out": 1}     # addressable-only, as asked
    p = _make_provider(fake)

    r = _closure(p, "f", up=1, down=0, max_nodes=600)

    assert fake.degree_asks == [True]
    assert r.frontier_up == []


# ── the coarse lane ──────────────────────────────────────────────────────


def _coarse(p, urn):
    return _run(p.trace_closure_coarse(
        urn=urn, direction="both", aggregated_edge_type="AGGREGATED",
        containment_edge_types=["HAS"], max_cells=50, timeout_ms=5000,
    ))


def test_coarse_reads_the_cells_where_aggregation_writes_them_and_skips_unusable_partners():
    fake = _TraceFake()
    fake.aggregated("obj_u", "obj_f", 7, 2, 2)
    fake.aggregated(None, "obj_f", 5, 2, 2)
    fake.aggregated(9, "obj_f", 3, 2, 2)
    p = _make_provider(fake)

    async def _focus(urn):
        return GraphNode(urn=urn, entityType=_label(urn), displayName=urn)

    p.get_node = _focus
    source_reads = []
    orig = fake.ro_query

    async def _spy(cypher, params=None, timeout=None, **kwargs):
        source_reads.append(cypher)
        return await orig(cypher, params=params, timeout=timeout, **kwargs)

    p._ro_query = _spy

    r = _coarse(p, "obj_f")

    assert _edges(r) == {("obj_u", "obj_f")}
    assert r.truncated is False
    assert not [c for c in source_reads if "AS partner" in c]


# ── the other lineage edge reads ─────────────────────────────────────────


def _edges_provider(rows_for):
    """A provider whose every read is answered by ``rows_for(cypher, params)``."""
    p = fp.FalkorDBProvider(host="x", graph_name="g")
    p._redis = None
    seen = []

    async def _connected():
        return None

    async def _ro_query(cypher, params=None, timeout=None, **kw):
        seen.append(cypher)
        return _Result(rows_for(cypher, params or {}))

    async def _buckets(urns):
        return [("Node", list(urns))]

    p._ensure_connected = _connected
    p._ro_query = _ro_query
    p._label_buckets = _buckets
    p.seen = seen
    return p


@pytest.mark.parametrize("query", [
    EdgeQuery(source_urns=["a1"]),                                     # one-sided bucket
    EdgeQuery(any_urns=["a1"]),                                        # legacy
], ids=["one-sided", "legacy"])
def test_get_edges_filters_unusable_ends_in_the_query_before_its_limit(query):
    """Behind a WITH, before RETURN … LIMIT: the anchoring MATCH keeps the
    plan it always had (a far-end predicate in its own WHERE turns the
    anchor's index seek into a full scan — see ``_has_urn``)."""
    p = _edges_provider(lambda c, prm: [["a1", "b1", "FLOWS", {}]])

    edges = _run(p.get_edges(query))

    assert [(e.source_urn, e.target_urn) for e in edges] == [("a1", "b1")]
    reads = [c for c in p.seen if "RETURN a.urn AS src" in c]
    assert reads
    for c in reads:
        assert f"WITH a, r, b WHERE {fp._has_urn('a')} AND {fp._has_urn('b')} RETURN" in c
        assert "typeOf" not in c[:c.index("WITH a, r, b")]


def test_get_edges_between_known_pairs_needs_no_filter():
    """Both ends bound by lists of urns the caller holds: nothing to drop."""
    p = _edges_provider(lambda c, prm: [["a1", "b1", "FLOWS", {}]])
    edges = _run(p.get_edges(EdgeQuery(source_urns=["a1"], target_urns=["b1"])))
    assert [(e.source_urn, e.target_urn) for e in edges] == [("a1", "b1")]


def test_scan_edges_skips_unusable_rows_but_pages_by_the_raw_count():
    rows = [["a", "b", "FLOWS", {}], [None, "b", "FLOWS", {}], ["a", 7, "FLOWS", {}],
            ["a", "", "FLOWS", {}], ["c", "d", "FLOWS", {}]]
    p = _edges_provider(
        lambda c, prm: [[0]] if "max(ID(n))" in c else rows[prm["skip"]:prm["skip"] + prm["limit"]]
    )

    async def _all():
        return [e async for page in p.scan_edges(page_size=5) for e in page]

    edges = _run(_all())

    assert [(e.source_urn, e.target_urn) for e in edges] == [("a", "b"), ("c", "d")]
    # A full raw page (5 rows) asked for the next one, though only 2 shipped.
    assert len([c for c in p.seen if "SKIP $skip" in c]) == 2


def test_aggregated_rows_with_an_unusable_end_are_dropped_and_a_full_read_stays_capped(monkeypatch):
    from backend.app.config import resilience

    monkeypatch.setattr(resilience, "AGGREGATED_EDGE_RESULT_CAP", 3)
    p = fp.FalkorDBProvider(host="x", graph_name="g")

    res = p._rows_to_aggregated_result([
        ["a", "b", 2, ["FLOWS"]], [None, "b", 1, ["FLOWS"]], ["a", 7, 1, ["FLOWS"]],
    ])

    assert [(e.source_urn, e.target_urn) for e in res.aggregated_edges] == [("a", "b")]
    assert res.truncated is True


def test_the_trace_v2_peer_hop_filters_unusable_far_ends_in_the_query():
    """``/trace/v2``'s per-hop expansion builds its edges from the far end's
    urn too: every sub-query it issues carries the predicate in its WHERE."""
    fake = _TraceFake()
    fake.aggregated("m_a", "m_b", 1, 1, 1)
    p = _make_provider(fake)
    seen = []

    async def _spy(cypher, params=None, timeout=None, **kwargs):
        seen.append(cypher)
        return _Result([])

    p._proj_ro_query = _spy
    p._ro_query = _spy
    _run(p._expand_aggregated_set(
        frontier=["m_a"], frontier_labels={"m_a": "Node"},
        direction="outgoing", level=1, ltypes=["FLOWS"],
        limit=50, timeout_secs=2.0,
    ))
    hops = [c for c in seen if "f.urn IN $frontier" in c]
    assert hops
    assert all(f"WITH f, r, other WHERE {fp._has_urn('other')} WITH" in c for c in hops)


def test_has_urn_is_the_typeof_predicate_the_engine_already_runs():
    assert fp._has_urn("o") == "(typeOf(o.urn) = 'String' AND o.urn <> '')"
    assert [fp._is_urn(v) for v in ("u", "", None, 7, ["u"])] == [True, False, False, False, False]


def test_the_warning_is_once_per_physical_graph():
    a = fp.FalkorDBProvider(host="h", port=1, graph_name="g")
    b = fp.FalkorDBProvider(host="h", port=1, graph_name="g")    # same graph
    c = fp.FalkorDBProvider(host="h", port=1, graph_name="other")
    logged = []
    orig = fp.logger.warning
    fp.logger.warning = lambda msg, *args: logged.append(args[0])
    try:
        a._warn_unaddressable("x", "1 edge")
        b._warn_unaddressable("x", "1 edge")
        c._warn_unaddressable("x", "1 edge")
    finally:
        fp.logger.warning = orig
    assert logged == ["g", "other"]


# ── through the endpoint: the reported request pair ──────────────────────


async def test_the_lens_request_pair_answers_200_on_a_graph_with_unusable_partners(test_client):
    """The exact pair the Focus lens sends: the coarse first paint, then the
    fine first page at ``maxNodes: 600``. The second was the 500."""
    from backend.app.api.v1.endpoints.graph import get_context_engine
    from backend.app.main import app
    from backend.app.services.context_engine import ContextEngine

    fake = _TraceFake()
    fake.lineage = [("obj_u", "obj_f", "FLOWS"), (None, "obj_f", "FLOWS"), ("obj_f", "obj_d", "FLOWS")]
    fake.aggregated("obj_u", "obj_f", 7, 2, 2)
    p = _make_provider(fake)

    async def _focus(urn):
        return GraphNode(urn=urn, entityType=_label(urn), displayName=urn)

    p.get_node = _focus
    engine = ContextEngine(provider=p)

    async def _resolve_ontology():
        return SimpleNamespace(lineage_edge_types=["FLOWS"], containment_edge_types=["HAS"])

    engine._resolve_ontology = _resolve_ontology

    async def _override():
        return engine

    app.dependency_overrides[get_context_engine] = _override
    try:
        coarse = await test_client.post(
            "/api/v1/test-ws/graph/trace/closure",
            json={"urn": "obj_f", "direction": "both", "upstreamDepth": 1, "downstreamDepth": 1, "grain": "coarse"},
        )
        fine = await test_client.post(
            "/api/v1/test-ws/graph/trace/closure",
            json={"urn": "obj_f", "direction": "both", "upstreamDepth": 1, "downstreamDepth": 1, "maxNodes": 600},
        )
    finally:
        app.dependency_overrides.pop(get_context_engine, None)

    assert coarse.status_code == 200, coarse.text
    assert fine.status_code == 200, fine.text
    body = fine.json()
    assert {(e["sourceUrn"], e["targetUrn"]) for e in body["edges"]} == {("obj_u", "obj_f"), ("obj_f", "obj_d")}
    assert body["unresolvedEdges"] == 1
    assert body["truncated"] is False


# ── the sync card reads the last completed run's advisory ────────────────


def test_sync_status_reads_identity_gaps_from_a_completed_runs_advisory():
    import json

    from backend.app.api.v1.endpoints.graph import _identity_gaps_of

    stats = {"advisories": [{"kind": "endpoints_unresolved", "dropped_pairs": 2},
                            {"kind": "lineage_identity_gaps", "nodes": 12}]}
    assert _identity_gaps_of(json.dumps(stats)) == 12
    assert _identity_gaps_of(json.dumps({"advisories": []})) is None
    assert _identity_gaps_of(None) is None
    assert _identity_gaps_of("not json") is None
