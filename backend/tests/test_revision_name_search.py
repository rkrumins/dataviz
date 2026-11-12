"""Searching names at a past revision — exactly — with no database.

A revision's name search is its store's search as it is now, corrected by the patch set of what
main changed since (``DraftOverlayProvider.search_names``): a node the patch set holds no value of
is unchanged since, so it is the store's match or not; one it holds a value of — renamed, made,
deleted or re-urned since — is judged by its value then, from its version row. Its pages walk one
order, the patch set's matches first. Over a Postgres reader (a stale projection) the overlay
searches its own state there instead, which that reader does only as of a revision. The route
serves a bounded page of hits, each with its ancestors, root first.
"""
import asyncio
import itertools

import pytest
from httpx import AsyncClient

from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.services.context_engine import ContextEngine
from backend.common.interfaces.provider import name_matches
from backend.common.models.graph import GraphNode, NodePage

from backend.tests.test_api_graph import _StubProvider

_GRAPHS = itertools.count()


def _n(urn, name, qname=None, etype="Table"):
    return GraphNode(urn=urn, entityType=etype, displayName=name, qualifiedName=qname)


#: main's store at its head. Since the revision main renamed A, made N, deleted D and gave M the
#: urn M2 (with a new name); S, U and V are as they were.
HEAD = [_n("A", "Orders now", "db.orders"), _n("N", "Orders new"), _n("S", "Orders store"),
        _n("U", "Unrelated"), _n("M2", "Orders moved"), _n("V", "Orders view", etype="View")]

#: main as it was at the revision, for what changed since.
THEN = {"eA": {"urn": "A", "entityType": "Table", "displayName": "Customers then",
               "qualifiedName": "db.customers"},
        "eD": {"urn": "D", "entityType": "Table", "displayName": "Orders deleted"},
        "eM": {"urn": "M", "entityType": "Table", "displayName": "Shipments"}}

PATCH = {
    "nodesUpsert": [{"urn": "D", "entityId": "eD", "entityType": "Table",
                     "displayName": "Orders deleted", "qualifiedName": None, "lazy": True}],
    "nodesNew": ["D"],
    "nodesModified": [
        {"entityId": "eA", "urn": "A", "entityType": "Table", "displayName": "Customers then",
         "qualifiedName": "db.customers"},
        {"entityId": "eM", "urn": "M", "entityType": "Table", "displayName": "Shipments",
         "qualifiedName": None, "baseUrn": "M2"},
    ],
    "nodesRemove": [{"entityId": "eN", "urn": "N"}],
    "edgesUpsert": [], "edgesRemove": [],
}


class Store:
    """The store's name search, as FalkorDB's: (name, urn) order, one row past the page."""
    name = "head-store"
    manager_cache_key = ("prov", "key")

    def __init__(self, nodes):
        self.nodes = {n.urn: n for n in nodes}

    def set_containment_edge_types(self, *a, **k):
        pass

    async def get_nodes(self, query):
        return [self.nodes[u] for u in (query.urns or []) if u in self.nodes]

    async def search_names(self, query, *, match="substring", entity_types=None, limit=20,
                           offset=0):
        q = query.strip().lower()
        hits = sorted((n for n in self.nodes.values()
                       if (not entity_types or n.entity_type in entity_types)
                       and (name_matches(n.display_name, q, match)
                            or name_matches(n.qualified_name, q, match))),
                      key=lambda n: (n.display_name, n.urn))
        page = hits[offset:offset + limit + 1]
        return NodePage(nodes=page[:limit], hasMore=len(page) > limit,
                        nextOffset=offset + len(page[:limit]))


class Svc:
    """The revision's patch set, its values then, and the Postgres reader's state reads."""

    def __init__(self):
        self.state_reads = []

    async def revision_overlay_delta(self, *, graph_id, as_of_seq, head_seq, extend=None):
        return {**PATCH, "since": {"asOf": as_of_seq, "head": head_seq}}

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids, kind="node",
                               as_of_seq=None):
        return [] if kind == "edge" else [THEN[e] for e in entity_ids if e in THEN]

    async def get_nodes_from_state(self, **kw):
        self.state_reads.append(kw)
        return [{"urn": "D", "entityType": "Table", "displayName": "Orders deleted"}]


def _revision(svc, base, *, seq=3, head=9):
    # A graph of its own: the process's cached patch sets are keyed by graph, and other tests'
    # revisions of g0, g1… are other patch sets.
    p = DraftOverlayProvider(base, svc=svc, graph_id=f"names{next(_GRAPHS)}", branch_id="main",
                             as_of_seq=seq, version=("rev", seq, head),
                             read_ns=f"rev{seq}@{head}:{head}:ok")
    p.set_containment_edge_types(["CONTAINS"])
    return p


def test_a_name_matches_ignoring_case_in_each_mode():
    assert name_matches("Orders Daily", "orders", "prefix")
    assert not name_matches("Orders Daily", "daily", "prefix")
    assert name_matches("Orders Daily", "daily", "suffix")
    assert name_matches("Orders Daily", "ders da", "substring")
    assert name_matches("Orders Daily", "orders daily", "exact")
    assert not name_matches("Orders Daily", "orders", "exact")
    assert not name_matches(None, "x", "substring") and not name_matches("", "x", "substring")


def test_a_revision_finds_names_as_they_were_then():
    p = _revision(Svc(), Store(HEAD))

    async def urns(q, **kw):
        return [n.urn for n in (await p.search_names(q, **kw)).nodes]

    async def run():
        # Deleted since: there then, first. Unchanged: the store's. Renamed, made or re-urned
        # since: not by their names now.
        assert await urns("orders") == ["D", "S", "V"]
        assert await urns("orders new") == []
        # Renamed since: found by its name then, and served as it was then.
        assert await urns("customers") == ["A"]
        assert (await p.search_names("customers")).nodes[0].display_name == "Customers then"
        assert await urns("db.cust", match="prefix") == ["A"]          # its qualified name then
        assert await urns("db.orders") == []
        # Re-urned since: found under the urn it had then, never under the one it has now.
        assert await urns("shipments", match="exact") == ["M"]
        assert await urns("orders", entity_types=["View"]) == ["V"]
        assert await urns("deleted", match="suffix") == ["D"]

    asyncio.run(run())


def test_its_pages_walk_one_order_without_repeating_or_skipping():
    p = _revision(Svc(), Store(HEAD))

    async def walk():
        seen, offset = [], 0
        while True:
            page = await p.search_names("orders", limit=1, offset=offset)
            seen += [n.urn for n in page.nodes]
            if not page.has_more:
                return seen
            offset = page.next_offset

    assert asyncio.run(walk()) == ["D", "S", "V"]


def test_over_a_postgres_reader_it_searches_its_own_state_at_the_revision():
    svc = Svc()
    p = _revision(svc, VersionedBranchProvider(svc, graph_id="g", branch_id="main"))
    page = asyncio.run(p.search_names("orders", match="prefix", entity_types=["Table"], limit=5))
    assert [n.urn for n in page.nodes] == ["D"] and not page.has_more
    (read,) = svc.state_reads
    assert (read["as_of_seq"], read["name_query"], read["name_match"]) == (3, "orders", "prefix")
    assert read["entity_types"] == ["Table"] and read["limit"] == 6      # one row past the page


def test_the_postgres_reader_searches_names_only_as_of_a_revision():
    head = VersionedBranchProvider(Svc(), graph_id="g", branch_id="main")
    with pytest.raises(NotImplementedError, match="catching up"):
        asyncio.run(head.search_names("orders"))


class _NamesStub(_StubProvider):
    """A reader that searches names, inside a two-level hierarchy."""

    async def search_names(self, query, *, match="substring", entity_types=None, limit=20,
                           offset=0):
        self.asked = (query, match, entity_types, limit, offset)
        return NodePage(nodes=[_n("urn:t", "Orders")], hasMore=True, nextOffset=offset + 1)

    async def get_ancestor_chains(self, urns):
        return {"urn:t": ["urn:schema", "urn:db"]}

    async def get_nodes(self, query):
        names = {"urn:schema": "sales", "urn:db": "warehouse"}
        return [_n(u, names[u], etype="Container") for u in query.urns or [] if u in names]


async def _post(client: AsyncClient, engine: ContextEngine, body):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    async def _override():
        return engine

    app.dependency_overrides[get_context_engine] = _override
    try:
        return await client.post("/api/v1/test-ws/graph/search/names", json=body)
    finally:
        app.dependency_overrides.pop(get_context_engine, None)


async def test_the_route_serves_a_page_of_hits_with_where_each_sits(test_client: AsyncClient):
    stub = _NamesStub()
    resp = await _post(test_client, ContextEngine(provider=stub),
                       {"q": "ord", "match": "prefix", "entityTypes": ["Table"], "limit": 5,
                        "offset": 10})
    assert resp.status_code == 200
    body = resp.json()
    assert body["hasMore"] is True and body["nextOffset"] == 11
    (hit,) = body["hits"]
    assert hit["node"]["urn"] == "urn:t"
    assert [(a["urn"], a["displayName"]) for a in hit["ancestorPath"]] == [
        ("urn:db", "warehouse"), ("urn:schema", "sales")]                   # root first
    assert stub.asked == ("ord", "prefix", ["Table"], 5, 10)


async def test_the_route_bounds_what_it_is_asked(test_client: AsyncClient):
    for body in ({"q": ""}, {"q": "x", "limit": 51}, {"q": "x", "offset": 1001},
                 {"q": "x", "match": "regex"}):
        resp = await _post(test_client, ContextEngine(provider=_NamesStub()), body)
        assert resp.status_code == 422, body


async def test_a_reader_that_cannot_search_names_answers_501(test_client: AsyncClient):
    resp = await _post(test_client, ContextEngine(provider=_StubProvider()), {"q": "x"})
    assert resp.status_code == 501


class _Rows:
    def __init__(self, rows):
        self.result_set = rows


@pytest.mark.parametrize("match,op", [("substring", "CONTAINS"), ("prefix", "STARTS WITH"),
                                      ("suffix", "ENDS WITH"), ("exact", "=")])
def test_falkordb_searches_names_by_label_in_one_order(monkeypatch, match, op):
    """What the store is asked (the live suite runs it: test_search_names_live.py): each label
    scanned under its own MATCH, names and qualified names compared lower-cased under the mode,
    one fixed order, and one row past the page."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    p = FalkorDBProvider(host="x", graph_name="g")

    async def connected():
        return None
    asked = []

    async def ro_query(cypher, params=None, **kw):
        asked.append((cypher, params))
        return _Rows([[u] for u in ("a", "b", "c")])
    monkeypatch.setattr(p, "_ensure_connected", connected)
    monkeypatch.setattr(p, "_ro_query", ro_query)
    monkeypatch.setattr(p, "_decoded_without", lambda rows, anchors: False)
    monkeypatch.setattr(p, "_extract_node_from_result", lambda urn: _n(urn, urn))

    page = asyncio.run(p.search_names("Ord", match=match, entity_types=["Table", "View"],
                                      limit=2, offset=4))
    assert [n.urn for n in page.nodes] == ["a", "b"] and page.has_more and page.next_offset == 6
    cypher, params = asked[0]
    assert params == {"q": "ord", "skip": 4, "limit": 3}
    assert "MATCH (n:Table) WHERE" in cypher and "MATCH (n:View) WHERE" in cypher
    assert f"{op} $q OR toLower(toString(n.qualifiedName)) {op} $q" in cypher
    assert cypher.endswith("ORDER BY n.displayName, n.urn, id(n) SKIP $skip LIMIT $limit RETURN n")

    asyncio.run(p.search_names("Ord", match=match))
    assert asked[1][0].startswith("MATCH (n) WHERE ")       # no type: every node
