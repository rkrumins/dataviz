"""LIVE FalkorDB: a name reference names exactly what the reference
semantics say.

``StubDeepSearchProvider._named`` is what ``Country / United Kingdom``,
``Country / ** / London`` or ``** / London`` mean. The FalkorDB resolver
(``falkordb_search/refs.py``) gets there by index seeks and short walks —
top-level entities by name, one level down per segment, a name found
through the index then checked upward for ``**`` — so here, on a real
graph, every reference must name the same entities the stub does, in every
kind of scope, a share link's included.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_refs_live.py -q
"""
from __future__ import annotations

import os
import uuid

import pytest
import pytest_asyncio

from backend.app.services.deep_search import SearchRunContext
from backend.common.models.search import NodeRef, SearchScope
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live refs test.",
    ),
    pytest.mark.asyncio(loop_scope="module"),
]

NODES = [
    ("country", "Domain", "Country"), ("uk", "Region", "United Kingdom"),
    ("london-uk", "City", "London"), ("manchester", "City", "Manchester"),
    ("canada", "Region", "Canada"), ("london-ca", "City", "London"),
    ("product", "Domain", "Product"), ("uk2", "Region", "United Kingdom"),
    ("sales", "Domain", "Sales"), ("orders", "Dataset", "orders"),
    ("orders-col", "Column", "orders"), ("nested", "Folder", "Country"),
    ("deep", "Dataset", "London"),
]
CONTAINS = [("country", "uk"), ("uk", "london-uk"), ("uk", "manchester"),
            ("country", "canada"), ("canada", "london-ca"), ("product", "uk2"),
            ("sales", "orders"), ("orders", "orders-col"),
            # A "Country" that is not top-level, and a London four levels down.
            ("sales", "nested"), ("london-ca", "deep")]

REFS = [
    {"path": ["Country", "United Kingdom"]},
    {"path": ["Country", "United Kingdom", "London"]},
    {"path": ["United Kingdom"]},
    {"path": ["country", "united kingdom"], "caseSensitive": False},
    {"path": ["country"]},
    {"path": ["Country", "**", "London"]},
    {"path": ["Country", "**", "London"], "entityType": "dataset"},
    {"path": ["Country", "**", "United Kingdom"]},
    {"path": ["**", "United Kingdom"]},
    {"path": ["**", "London"]},
    {"path": ["**", "Country"]},
    {"path": ["Sales", "**", "orders"]},
    {"path": ["Sales", "**", "orders"], "entityType": "Column"},
    {"path": ["Product", "United Kingdom"]},
    {"urn": "uk2"},
]
SCOPES = [
    SearchScope(view_id="v", scope_mode="data_source"),
    SearchScope(view_id="v", scope_mode="view", root_urns=["country"]),
    SearchScope(view_id="v", scope_mode="view", root_urns=["uk", "sales"], max_depth=2),
]


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"refs_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    await p._ensure_connected()
    for label in {label for _, label, _ in NODES}:
        await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
        await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.displayName)")
    for urn, label, name in NODES:
        await p._graph.query(f"CREATE (:{label} {{urn: $u, displayName: $n}})",
                             {"u": urn, "n": name})
    for parent, child in CONTAINS:
        await p._graph.query("MATCH (a {urn: $a}), (b {urn: $b}) CREATE (a)-[:CONTAINS]->(b)",
                             {"a": parent, "b": child})
    try:
        yield p
    finally:
        await p._graph.delete()


def _stub() -> StubDeepSearchProvider:
    return StubDeepSearchProvider(
        nodes=[{"urn": u, "entityType": label, "displayName": n} for u, label, n in NODES],
        edges=[{"source": a, "target": b, "type": "CONTAINS"} for a, b in CONTAINS])


@pytest.mark.parametrize("scope", SCOPES, ids=["data_source", "view", "narrow_view"])
@pytest.mark.parametrize("confined", [False, True], ids=["member", "share_link"])
async def test_every_reference_names_what_the_semantics_say(provider, scope, confined):
    if confined and scope.scope_mode == "data_source":
        pytest.skip("a share link only ever searches its view")
    refs = [NodeRef.model_validate(r) for r in REFS]
    got = await provider.deep_search_resolve_refs(scope, refs, context=SearchRunContext(),
                                                  confined=confined)
    want = await _stub().deep_search_resolve_refs(scope, refs, confined=confined)
    for ref, g, w in zip(refs, got, want):
        assert (g["urns"], g["error"]) == (w["urns"], w["error"]), ref.label()


async def test_named_entities_come_with_their_containers(provider):
    ref = NodeRef.model_validate({"path": ["Country", "**", "London"]})
    [answer] = await provider.deep_search_resolve_refs(
        SCOPES[0], [ref], context=SearchRunContext(), with_paths=True)
    assert sorted((e["urn"], e["entityType"]) for e in answer["entities"]) == [
        ("deep", "Dataset"), ("london-ca", "City"), ("london-uk", "City")]
    paths = {e["urn"]: [a["displayName"] for a in e["ancestorPath"]] for e in answer["entities"]}
    assert paths["london-uk"] == ["Country", "United Kingdom"]
    assert paths["deep"] == ["Country", "Canada", "London"]


async def test_answers_are_cached_per_data_version(provider):
    ref = NodeRef.model_validate({"path": ["Country", "United Kingdom"]})
    calls = []
    original = provider._ro_query

    async def counting(cypher, *, params=None, **kw):
        calls.append(cypher)
        return await original(cypher, params=params, **kw)

    provider._ro_query = counting
    try:
        context = SearchRunContext(data_version="v-test-1")
        first = await provider.deep_search_resolve_refs(SCOPES[0], [ref], context=context)
        resolving = len(calls)
        again = await provider.deep_search_resolve_refs(SCOPES[0], [ref], context=context)
    finally:
        provider._ro_query = original
    assert first[0]["urns"] == again[0]["urns"] == ["uk"]
    # The second answer re-reads only the names it shows, not the path.
    assert len(calls) - resolving < resolving


@pytest.mark.parametrize("engine", ["capped", "uncapped"])
async def test_a_search_by_name_end_to_end(provider, engine):
    """Resolved by the service, compiled, and run by either engine."""
    from types import SimpleNamespace

    from backend.app.services.advanced_search_service import AdvancedSearchService
    from backend.app.services.view_scope import EffectiveViewScope
    from backend.common.models.search import SearchQuery

    svc = AdvancedSearchService(SimpleNamespace(provider=provider), session=None,
                                workspace_id="ws")
    eff = EffectiveViewScope(
        view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="graph",
        root_urns=("country",), entity_type_allow_list=frozenset(),
        layer_allow_list=frozenset(), max_depth=12, scope_hash="h-refs")

    async def resolve(requested):
        return eff

    async def guard(scope):
        return None

    svc._resolve_scope, svc._guard_view_data_source = resolve, guard
    query = SearchQuery.model_validate({
        "predicate": {"kind": "group", "children": [
            {"kind": "descendantOf", "refs": [{"path": ["Country", "United Kingdom"]}]},
            {"kind": "entityType", "values": ["city"]}]},
        "scope": {"viewId": "v"}, "options": {"results": "hits"}})
    context = (SearchRunContext(data_version="", scope_hash="h-refs")
               if engine == "uncapped" else None)
    page, _ = await svc.search(query, run_context=context)
    assert sorted(h.node.urn for h in page.hits) == ["london-uk", "manchester"]
    assert page.scope_diagnostics.resolved_refs[0].count == 1
