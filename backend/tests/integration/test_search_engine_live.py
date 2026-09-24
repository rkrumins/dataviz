"""LIVE FalkorDB: the uncapped engine returns exactly what one uncapped
statement would — every match, counted exactly, in one global order.

The engine never runs that statement. It cuts the scope into units (label ID
bands, a walk from a view's roots, per-label URN lookups), lets each unit
count and rank its own matches, and merges them; later pages resume after
the last row's sort keys. Every piece of that can go wrong in a way that
looks right on a small page: a band that misses nodes, a label counted
twice, a merge that orders differently from Cypher, a keyset that skips or
repeats rows at a page boundary, a scope clamp that leaks.

So here, on a real graph, for a matrix of predicates, orders and scopes: the
engine's pages — walked to the end through their cursors — must equal the
single uncapped ``ORDER BY`` over the same scope, row for row, and its total
must equal that statement's count. The relevance score it ranks by must be
the score ``_score_hit`` gives the same projected row, and each unit's
statement must be the seek it is meant to be.

Run:  RUN_FALKOR_LIVE=1 FALKORDB_HOST=localhost FALKORDB_PORT=6379 \\
      python -m pytest tests/integration/test_search_engine_live.py -q
"""
from __future__ import annotations

import json
import os
import random
import uuid

import pytest
import pytest_asyncio

pytestmark = [
    pytest.mark.skipif(
        os.getenv("RUN_FALKOR_LIVE") != "1",
        reason="Set RUN_FALKOR_LIVE=1 (with FalkorDB reachable) to run the live engine test.",
    ),
    # One event loop for the module: the provider's connections belong to it.
    pytest.mark.asyncio(loop_scope="module"),
]

NAMES = ["orders", "Orders Archive", "customer.orders", "sub-orders", "reorders",
         "order_items", "ORDERS", "ordersX", "customers", "payments", "Orders/2024",
         "dim customer", "fact_orders", "orders orders", "Commandes"]
OWNERS = ["data-core", "ml-ops", "finance", "data-ml", "risk"]
#: Every seeded urn, by label — filled by the ``provider`` fixture.
URNS: dict = {}
TAGS = [["pii"], ["gold", "pii"], [], ["orders"], ["deprecated", "Orders"]]


@pytest_asyncio.fixture(scope="module", loop_scope="module")
async def provider():
    """A real provider over a seeded graph: 3 domains, 12 containers,
    120 datasets, 2,400 columns, and typed properties of every kind."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=f"engine_{uuid.uuid4().hex[:8]}",
        auth_enabled=False,
    )
    p.set_containment_edge_types(["CONTAINS"], from_ontology=True)
    rng = random.Random(7)

    def node(label, i, parent):
        name = f"{rng.choice(NAMES)} {i}" if rng.random() < 0.7 else rng.choice(NAMES)
        return {
            "urn": f"urn:{label.lower()}:{i}", "parent": parent,
            "displayName": name,
            "qualifiedName": f"{parent.rsplit(':', 1)[-1] if parent else 'root'}.{name}",
            "description": rng.choice(["", "holds orders", "customer facts", None]),
            # As the provider writes them: a JSON string.
            "tags": json.dumps(rng.choice(TAGS)),
            "gvHash": rng.choice([rng.randint(-(2 ** 63), 2 ** 63 - 1),
                                  rng.randint(-5, 5)]),
            "score": rng.random(),
            "owner": rng.choice(OWNERS) if rng.random() < 0.85 else None,
            "mixed": rng.choice([7, "7", 7.5, "seven", True, ["a", "b"]]),
        }

    async def seed():
        await p._ensure_connected()
        levels = [("Domain", 3), ("Container", 12), ("Dataset", 120), ("Column", 2400)]
        parents = {None: [None]}
        previous = None
        for label, count in levels:
            await p._graph.query(f"CREATE INDEX FOR (n:{label}) ON (n.urn)")
            rows = [node(label, i, rng.choice(parents[previous])) for i in range(count)]
            if previous is None:
                await p._graph.query(
                    f"UNWIND $rows AS r CREATE (n:{label}) SET n = r, n.parent = null",
                    {"rows": rows})
            else:
                await p._graph.query(
                    f"UNWIND $rows AS r MATCH (a:{previous} {{urn: r.parent}}) "
                    f"CREATE (a)-[:CONTAINS]->(n:{label}) SET n = r, n.parent = null",
                    {"rows": rows})
            parents[label] = [r["urn"] for r in rows]
            previous = label
        return parents

    URNS.update(await seed())
    try:
        yield p
    finally:
        await p._graph.delete()


@pytest.fixture(autouse=True)
def small_chunks(monkeypatch):
    """1,000-node chunks and 60 rows per session: the 2,400 columns span
    several bands and every walk through the pages crosses sessions."""
    from backend.app.services.deep_search import get_deep_search_settings
    monkeypatch.setenv("DEEP_SEARCH_CHUNK_WIDTH", "1000")
    monkeypatch.setenv("DEEP_SEARCH_SESSION_ROWS", "60")
    get_deep_search_settings.cache_clear()
    yield
    get_deep_search_settings.cache_clear()


def _query(predicate, scope, **options):
    from backend.common.models.search import SearchQuery
    return SearchQuery.model_validate({
        "predicate": predicate, "scope": {"viewId": "v", **scope},
        "options": {"results": "hits", "pageSize": 37, **options}})


async def _expected(provider, query):
    """The single uncapped statement: the scope, the predicate, the order."""
    from backend.app.providers.falkordb_deep_search import (
        _RESERVED_NODE_KEYS, _build_compiler_for_provider)
    from backend.app.providers.falkordb_search.keys import build_sort_spec
    from backend.app.providers.falkordb_search.relevance import score_expr

    compiler = _build_compiler_for_provider(provider)
    where = compiler.compile(query.predicate)
    relevance = None
    if query.options.sort == "relevance" and not query.options.sort_property:
        relevance = score_expr(query, reserved_keys=frozenset(_RESERVED_NODE_KEYS))
    spec = build_sort_spec(query, relevance=relevance)
    params = {**compiler.params, **spec.params}
    scope = query.scope
    if scope.scope_mode == "visible":
        head = "MATCH (n) WHERE n.urn IN $_v WITH n"
        params["_v"] = scope.visible_urns
    elif scope.root_urns:
        head = ("MATCH (r) WHERE r.urn IN $_r MATCH (r)-[:CONTAINS*0..12]->(n) "
                "WITH DISTINCT n")
        params["_r"] = scope.root_urns
    else:
        head = "MATCH (n) WITH n"
    cypher = (f"{head} WHERE n.urn IS NOT NULL AND ({where}) "
              f"WITH n, {spec.projection()} ORDER BY {spec.order_by()} RETURN n.urn")
    rows = (await provider._ro_query(cypher, params=params, timeout=60)).result_set
    return [r[0] for r in rows]


async def _walk(provider, query):
    from backend.app.services.deep_search import SearchRunContext
    from backend.app.providers.falkordb_search.engine import execute_session_search

    seen, cursor, first = [], None, None
    for _ in range(500):
        q = query.model_copy(update={"options": query.options.model_copy(
            update={"cursor": cursor})})
        page = await execute_session_search(
            provider, q, context=SearchRunContext(data_version="1"))
        assert page.status == "complete"
        first = first or page
        seen += [h.node.urn for h in page.hits]
        cursor = page.cursor
        if not cursor:
            return first, seen
    raise AssertionError("the cursor never ran out")


PREDICATES = {
    "name": {"kind": "text", "value": "orders", "target": "name"},
    "any-prefix": {"kind": "text", "value": "ord", "target": "any", "match": "prefix"},
    "owner-in": {"kind": "property", "key": "owner", "op": "in", "value": ["data-core", "risk"]},
    "hash-positive": {"kind": "property", "key": "gvHash", "op": "gt", "value": 0,
                      "valueType": "number"},
    "not-pii": {"kind": "group", "op": "not", "children": [
        {"kind": "property", "key": "tags", "op": "contains", "value": "pii"}]},
    "or": {"kind": "group", "op": "or", "children": [
        {"kind": "text", "value": "customer", "target": "name"},
        {"kind": "property", "key": "score", "op": "between", "value": [0.1, 0.2],
         "valueType": "number"}]},
}
ORDERS = {
    "relevance": {"sort": "relevance"},
    "name-desc": {"sort": "displayName", "sortDir": "desc"},
    "hash-desc": {"sortProperty": "gvHash", "sortDir": "desc"},
    "mixed-asc": {"sortProperty": "mixed", "sortDir": "asc"},
}


@pytest.mark.parametrize("order", list(ORDERS))
@pytest.mark.parametrize("predicate", list(PREDICATES))
async def test_every_page_in_order_equals_one_uncapped_statement(provider, predicate, order):
    q = _query(PREDICATES[predicate], {"scopeMode": "data_source"}, **ORDERS[order])
    want = await _expected(provider, q)
    first, got = await _walk(provider, q)
    assert first.total_count == len(want)
    assert got == want


@pytest.mark.parametrize("walk_max", ["300000", "0"])
@pytest.mark.parametrize("predicate", ["name", "owner-in", "not-pii"])
async def test_a_views_roots_bound_the_search_walked_or_clamped(provider, monkeypatch,
                                                                 predicate, walk_max):
    """``300000``: the subtree is small enough to walk. ``0``: never walk —
    the columns are read in ID bands, each clamped to the roots."""
    from backend.app.services.deep_search import get_deep_search_settings
    monkeypatch.setenv("DEEP_SEARCH_WALK_MAX", walk_max)
    get_deep_search_settings.cache_clear()
    roots = [URNS["Domain"][0], URNS["Container"][5]]
    q = _query(PREDICATES[predicate], {"scopeMode": "view", "rootUrns": roots},
               sort="displayName")
    want = await _expected(provider, q)
    first, got = await _walk(provider, q)
    assert got == want and first.total_count == len(want)


async def test_many_roots_are_walked_in_buckets(provider, monkeypatch):
    from backend.app.providers.falkordb_search import plan as plan_mod
    from backend.app.services.deep_search import get_deep_search_settings
    monkeypatch.setenv("DEEP_SEARCH_WALK_MAX", "0")
    monkeypatch.setattr(plan_mod, "CLAMP_MAX_ROOTS", 4)
    monkeypatch.setattr(plan_mod, "WALK_BUCKET_ROOTS", 3)
    get_deep_search_settings.cache_clear()
    # Nested on purpose: a domain and some of its own datasets.
    roots = URNS["Domain"][:1] + URNS["Dataset"][:10] + URNS["Container"][:2]
    q = _query(PREDICATES["name"], {"scopeMode": "view", "rootUrns": roots},
               sort="displayName")
    want = await _expected(provider, q)
    first, got = await _walk(provider, q)
    assert got == want and first.total_count == len(want)


async def test_the_canvas_urns_bound_a_visible_search(provider):
    visible = URNS["Column"][::7] + URNS["Dataset"][::3]
    q = _query(PREDICATES["owner-in"], {"scopeMode": "visible", "visibleUrns": visible},
               sort="relevance")
    want = await _expected(provider, q)
    first, got = await _walk(provider, q)
    assert got == want and first.total_count == len(want)


@pytest.mark.parametrize("leaf", [
    {"kind": "text", "value": "orders", "target": "name"},
    {"kind": "text", "value": "Orders", "target": "name", "caseSensitive": True},
    {"kind": "text", "value": "orders", "target": "any"},
    {"kind": "text", "value": "customer", "target": "description"},
    {"kind": "text", "value": "orders", "target": "name", "match": "prefix"},
    {"kind": "text", "value": "orders", "target": "qualifiedName", "match": "suffix"},
    {"kind": "text", "value": "orders", "target": "tags"},
    {"kind": "property", "key": "owner", "op": "contains", "value": "data"},
    {"kind": "property", "key": "mixed", "op": "eq", "value": "7"},
])
async def test_relevance_is_the_score_python_gives_the_same_row(provider, leaf):
    """The engine ranks by a Cypher expression; ``_score_hit`` ranked the
    capped engine's projected rows. On this graph (ASCII names, every
    separator the word tier cares about) the two agree to the value."""
    from backend.app.providers.falkordb_deep_search import (
        _RESERVED_NODE_KEYS, _build_compiler_for_provider, _collect_text_leaves,
        _hit_projection, _rows_to_candidates, _score_hit)
    from backend.app.providers.falkordb_search.relevance import score_expr

    q = _query({"kind": "group", "op": "and", "children": [leaf]}, {"scopeMode": "data_source"})
    compiler = _build_compiler_for_provider(provider)
    where = compiler.compile(q.predicate)
    scored = score_expr(q, reserved_keys=frozenset(_RESERVED_NODE_KEYS))
    # None: every match scores alike, so the engine ranks by name alone —
    # which holds only if Python, too, gives every match one score.
    expr, params = scored or ("0.0", {})
    projection = _hit_projection(provider, q)
    rows = (await provider._ro_query(
        f"MATCH (n) WHERE {where} WITH n, {expr} AS _score "
        f"{projection.clause}, _score",
        params={**compiler.params, **params}, timeout=60)).result_set
    assert rows, "the predicate should match something"
    candidates = _rows_to_candidates(
        [r[:-1] for r in rows], columns=projection.columns,
        property_keys=projection.property_keys, identity_key=projection.identity_key,
        name_key=projection.name_key)
    leaves = _collect_text_leaves(q.predicate)
    if scored is None:
        python = {_score_hit(c, leaves, want_highlights=False, projected=True)[0]
                  for c in candidates}
        assert len(python) == 1, python
        return
    mismatches = [
        (c.display_name, row[-1], _score_hit(c, leaves, want_highlights=False, projected=True)[0])
        for c, row in zip(candidates, rows)
        if abs(row[-1] - _score_hit(c, leaves, want_highlights=False, projected=True)[0]) > 1e-9
    ]
    assert not mismatches, mismatches[:10]


async def test_each_unit_is_the_seek_it_means_to_be(provider):
    """Bands seek their label by ID, walks seek their roots by ID, and a
    clamp walks up from the node — nothing scans every node."""
    from backend.app.providers.falkordb_deep_search import _build_compiler_for_provider
    from backend.app.providers.falkordb_search.keys import build_sort_spec
    from backend.app.providers.falkordb_search.plan import Context, Unit, page_statements

    q = _query(PREDICATES["owner-in"], {"scopeMode": "data_source"}, sort="displayName")
    compiler = _build_compiler_for_provider(provider)
    ctx = Context(compiler.compile(q.predicate), dict(compiler.params),
                  build_sort_spec(q), ("CONTAINS",), 12)

    async def plan_of(unit, clamps=()):
        text = []
        for cypher, params, _ in page_statements(unit, ctx, [list(c) for c in clamps], 10):
            text += (await provider._graph.explain(cypher, params)).plan
        return " | ".join(line.strip() for line in text)

    band = await plan_of(Unit("range", "Column", 100, 900))
    assert "Node By Label and ID Scan" in band and "All Node Scan" not in band
    walk = await plan_of(Unit("walk", roots=[0, 1]))
    assert "NodeByIdSeek" in walk and "All Node Scan" not in walk
    clamped = await plan_of(Unit("range", "Column", 100, 900), clamps=[[0]])
    assert "Conditional Variable Length Traverse" in clamped
    assert "All Node Scan" not in clamped


# ---------------------------------------------------------------------------
# Rules: membership for what is on screen, exact counts for the whole view
# ---------------------------------------------------------------------------

def _scopes():
    from backend.common.models.search import SearchScope
    return {
        "data-source": SearchScope(view_id="v", scope_mode="data_source"),
        "domain": SearchScope(view_id="v", scope_mode="view", root_urns=[URNS["Domain"][0]]),
        "containers": SearchScope(view_id="v", scope_mode="view",
                                  root_urns=URNS["Container"][2:5]),
    }


async def _in_scope_matching(provider, scope, predicate, urns=None):
    """The URNs a rule matches in scope, by one direct statement."""
    from backend.app.providers.falkordb_deep_search import _build_compiler_for_provider
    compiler = _build_compiler_for_provider(provider)
    where = compiler.compile(predicate)
    params = dict(compiler.params)
    head = "MATCH (n) WITH n"
    if scope.root_urns:
        head = ("MATCH (r) WHERE r.urn IN $_r MATCH (r)-[:CONTAINS*0..12]->(n) "
                "WITH DISTINCT n")
        params["_r"] = scope.root_urns
    conds = [f"({where})"]
    for i, urn_set in enumerate(compiler.hoisted_root_urns):
        conds.append(f"ANY(_x IN _anc WHERE _x IN $_h{i})")
        params[f"_h{i}"] = urn_set
    if urns is not None:
        conds.append("n.urn IN $_u")
        params["_u"] = urns
    # A pattern comprehension can't sit in a WHERE beside a MATCH
    # (S0_FINDINGS §3): project the ancestors first.
    rows = (await provider._ro_query(
        f"{head} WITH n, [(n)<-[:CONTAINS*0..12]-(_a) | _a.urn] AS _anc "
        f"WHERE {' AND '.join(conds)} RETURN n.urn", params=params, timeout=60)).result_set
    return {r[0] for r in rows}


RULES = {
    "owner-in": PREDICATES["owner-in"],
    "not-pii": PREDICATES["not-pii"],
    "or": PREDICATES["or"],
    "under-a-container": {"kind": "group", "op": "and", "children": [
        {"kind": "descendantOf", "urns": ["urn:container:3", "urn:container:7"]},
        {"kind": "text", "value": "orders", "target": "name"}]},
}


@pytest.mark.parametrize("scope_name", ["data-source", "domain", "containers"])
async def test_membership_is_each_rule_on_each_urn_in_scope(provider, scope_name):
    from pydantic import TypeAdapter

    from backend.app.services.deep_search import SearchRunContext
    from backend.common.models.search import Predicate

    scope = _scopes()[scope_name]
    rng = random.Random(11)
    urns = (rng.sample(URNS["Column"], 700) + rng.sample(URNS["Dataset"], 60)
            + URNS["Container"] + ["urn:column:missing"])
    items = [(name, TypeAdapter(Predicate).validate_python(p)) for name, p in RULES.items()]
    out = await provider.deep_search_membership(scope, items, urns, context=SearchRunContext())
    assert out["errors"] == {}
    for name, predicate in items:
        want = await _in_scope_matching(provider, scope, predicate, urns)
        assert set(out["matches"][name]) == want, name


@pytest.mark.parametrize("scope_name", ["data-source", "domain", "containers"])
@pytest.mark.parametrize("rule", ["owner-in", "not-pii", "under-a-container"])
async def test_a_rule_count_is_exact_across_requests(provider, rule, scope_name):
    from pydantic import TypeAdapter

    from backend.app.providers.falkordb_search.engine import execute_count_session
    from backend.app.services.deep_search import SearchRunContext
    from backend.common.models.search import Predicate, SearchOptions, SearchQuery

    scope = _scopes()[scope_name]
    predicate = TypeAdapter(Predicate).validate_python(RULES[rule])
    want = len(await _in_scope_matching(provider, scope, predicate))
    session, requests, answer = None, 0, None
    for requests in range(1, 50):
        q = SearchQuery(predicate=predicate, scope=scope,
                        options=SearchOptions(results="hits", wait_ms=0, session_id=session))
        answer = await execute_count_session(provider, q, context=SearchRunContext(
            data_version="1", scope_hash=scope_name))
        session = answer["sessionId"]
        if answer["status"] == "complete":
            break
    assert answer["status"] == "complete"
    assert answer["count"] == want
