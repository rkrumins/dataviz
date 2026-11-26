"""A draft's counts, rule membership and property catalog reflect the draft (``draft_search``).

Each answer is main's corrected entity by entity for what the draft changed. Proven here against
a scripted "main" (the stub provider, which answers with the same evaluator) and a scripted draft
service: every answer on the draft must equal the stub's answer over the draft's composed graph —
the truth — whatever the predicate, the scope, the batch size or how many commits were folded in.
A predicate that can't be answered entity by entity keeps main's answer and says so; a failing
correction is main's answer, said to be main's.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest
from pydantic import TypeAdapter

from backend.app.providers import draft_search
from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.providers.falkordb_search.catalog import CatalogStats, answer_of
from backend.app.providers.falkordb_search.session import COMPLETE, MemorySessionStore, Session
from backend.app.providers.versioned_branch_provider import VersionedBranchProvider
from backend.app.services.advanced_search_service import AdvancedSearchService
from backend.app.services.deep_search import SearchRunContext
from backend.app.services.graph_reads import published_data_version
from backend.app.services.versioning import config as vconfig
from backend.app.services.view_scope import EffectiveViewScope
from backend.common.models.graph import GraphNode
from backend.common.models.search import (
    DegreePredicate, DescendantOfPredicate, EntityTypePredicate, GroupPredicate,
    HasPropertyPredicate, IsPredicate, NodeRef, Predicate, PropertyPredicate, SearchCountsRequest,
    SearchMembershipEdge, SearchMembershipRequest, SearchOptions, SearchQuery, SearchScope,
    TagPredicate, TextPredicate,
)
from backend.common.predicate_eval import NODE_FIELDS, matches
from backend.graph.adapters.stub_deep_search import StubDeepSearchProvider


@pytest.fixture(autouse=True)
def memory_store(monkeypatch):
    from backend.app.providers.falkordb_search import session as session_mod
    store = MemorySessionStore()
    monkeypatch.setattr(session_mod, "_MEMORY", store)
    return store


MAIN = [
    {"urn": "db", "entityType": "Database", "displayName": "warehouse"},
    {"urn": "t1", "entityType": "Table", "displayName": "orders", "owner": "ann"},
    {"urn": "t2", "entityType": "Table", "displayName": "users", "owner": "bob"},
    {"urn": "c1", "entityType": "Column", "displayName": "id", "tier": "gold", "rows": 10,
     "tags": ["pii"]},
    {"urn": "c2", "entityType": "Column", "displayName": "name", "tier": "silver", "rows": 20},
    {"urn": "c3", "entityType": "Column", "displayName": "email", "tier": "gold", "rows": 5},
]


def _edge(src, tgt, kind="CONTAINS"):
    return {"id": f"e:{src}>{tgt}", "source": src, "target": tgt, "type": kind}


MAIN_EDGES = [_edge("db", "t1"), _edge("db", "t2"), _edge("t1", "c1"), _edge("t1", "c2"),
              _edge("t2", "c3"), _edge("c1", "c3", "FLOWS_TO")]


def _props(n: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in n.items() if k not in NODE_FIELDS}


def _graph_node(n: Dict[str, Any]) -> GraphNode:
    return GraphNode(urn=n["urn"], entityType=n["entityType"], displayName=n["displayName"],
                     properties=_props(n), tags=n.get("tags") or [])


def _reader(n: Dict[str, Any]) -> Dict[str, Any]:
    """A node as ``overlay_payloads`` serves it."""
    return {"urn": n["urn"], "entityId": f"id-{n['urn']}", "entityType": n["entityType"],
            "displayName": n["displayName"], "properties": _props(n), "tags": n.get("tags") or []}


class Main(StubDeepSearchProvider):
    """Main's store: the stub's search, plus the reads a draft's correction asks of it, and a
    catalog that keeps its statistics where a FalkorDB catalog does."""
    name = "main"

    def __init__(self, nodes=MAIN, edges=MAIN_EDGES):
        super().__init__(nodes=nodes, edges=edges, lineage_edge_types=["FLOWS_TO"])
        self.versions: List[str] = []
        self.catalog_complete = True

    def physical_graph_id(self):
        return "falkor:main"

    def _get_containment_edge_types(self):
        return ["CONTAINS"]

    async def deep_search_count(self, query, *, context=None, advance=True):
        self.versions.append(context.data_version)
        return await super().deep_search_count(query, context=context, advance=advance)

    async def deep_search_membership(self, scope, items, urns, *, context=None):
        self.versions.append(context.data_version)
        return await super().deep_search_membership(scope, items, urns, context=context)

    async def get_nodes(self, query):
        wanted = set(query.urns or ())
        return [_graph_node(n) for n in self._nodes if n["urn"] in wanted]

    async def get_ancestor_chains(self, urns):
        return {u: self._ancestors(self._by_urn[u]) for u in urns if u in self._by_urn}

    async def deep_search_catalog(self, scope, *, context, wait_ms, session_id=None,
                                  refresh=False):
        self.versions.append(context.data_version)
        return await catalog_of(self, scope, context, complete=self.catalog_complete)


async def catalog_of(provider: StubDeepSearchProvider, scope, context, complete=True):
    """A catalog of ``provider``'s fixture, read whole and kept as the scan keeps one."""
    from backend.app.providers.falkordb_search.catalog import _skipped_keys
    from backend.app.providers.falkordb_search.session import store_for
    stats = CatalogStats()
    for n in provider._in_scope(scope):
        stats.add_entity(n["entityType"], _props(n), n.get("tags"), _skipped_keys())
    session = Session(f"cat-{uuid.uuid4().hex[:8]}", "catalog", context.data_version, None, 0,
                      [], [], 1, scanned=1, count=sum(stats.entities.values()),
                      status=COMPLETE if complete else "running")
    await store_for(provider).save(session, None, 600, accumulator=stats.to_json())
    return answer_of(stats, session, context)


class Draft:
    """The draft's side: a scripted versioning service over ``MAIN``, committed to by ``commit``
    — what each commit wrote kept by seq, so a fold can read the draft as it was."""

    def __init__(self, main_nodes=MAIN, main_edges=MAIN_EDGES):
        self.main = {n["urn"]: dict(n) for n in main_nodes}
        self.nodes = {u: dict(n) for u, n in self.main.items()}
        self.edges = {e["id"]: dict(e) for e in main_edges}
        self.seq = 0
        self.history: Dict[int, Dict[str, Optional[Dict[str, Any]]]] = {}
        # The type of each edge row a commit wrote — None for a delete, whose row names none.
        self.edge_rows: Dict[int, List[Optional[str]]] = {}
        self.loads: List[List[str]] = []
        self.windows: List[Any] = []
        self.as_of: List[Any] = []
        # Its own graph: no patch set another test's draft cached is ever read for it.
        self.graph_id = f"g-{uuid.uuid4().hex[:8]}"

    def commit(self, nodes: Dict[str, Optional[Dict[str, Any]]], add_edges=(), drop_edges=()):
        self.seq += 1
        self.history[self.seq] = {f"id-{u}": (dict(n, urn=u) if n else None)
                                  for u, n in nodes.items()}
        self.edge_rows[self.seq] = [e["type"] for e in add_edges] + [None for _ in drop_edges]
        for u, n in nodes.items():
            if n is None:
                self.nodes.pop(u, None)
            else:
                self.nodes[u] = dict(n, urn=u)
        for e in add_edges:
            self.edges[e["id"]] = e
        for e in drop_edges:
            self.edges.pop(e["id"], None)

    def truth(self) -> StubDeepSearchProvider:
        return StubDeepSearchProvider(nodes=list(self.nodes.values()),
                                      edges=list(self.edges.values()),
                                      lineage_edge_types=["FLOWS_TO"])

    # -- the GraphVersioningService surface the overlay reads -- #
    async def overlay_version(self, *, graph_id, branch_id):
        return (f"cmt-{self.seq}", 1, 1, "open")

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        drafted = {u for writes in self.history.values() for u in
                   (eid[3:] for eid in writes)}
        delta = {"nodesUpsert": [], "nodesModified": [], "nodesRemove": [], "edgesUpsert": [],
                 "edgesRemove": [], "nodesNew": []}
        for u in sorted(drafted):
            now, was = self.nodes.get(u), self.main.get(u)
            if now is None and was is not None:
                delta["nodesRemove"].append({"urn": u, "entityId": f"id-{u}"})
            elif now is not None and was is None:
                delta["nodesUpsert"].append({"urn": u, "entityId": f"id-{u}",
                                             "entityType": now["entityType"],
                                             "displayName": now["displayName"], "lazy": True})
                delta["nodesNew"].append(u)
            elif now is not None and now != was:
                delta["nodesModified"].append({"urn": u, "entityId": f"id-{u}"})
        main_edges = {e["id"]: e for e in MAIN_EDGES}
        for eid, e in self.edges.items():
            if eid not in main_edges:
                delta["edgesUpsert"].append({"id": eid, "sourceUrn": e["source"],
                                             "targetUrn": e["target"], "edgeType": e["type"],
                                             "lazy": True})
        for eid, e in main_edges.items():
            if eid not in self.edges:
                delta["edgesRemove"].append({"id": eid, "sourceUrn": e["source"],
                                             "targetUrn": e["target"], "edgeType": e["type"]})
        return delta

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids, kind="node",
                               as_of_seq=None):
        self.loads.append(list(entity_ids))
        return [_reader(self.nodes[e[3:]]) for e in entity_ids if e[3:] in self.nodes]

    async def ancestor_chains(self, *, graph_id, branch_id, urns, containment_edge_types,
                              as_of_seq=None):
        truth = self.truth()
        return {u: truth._ancestors(truth._by_urn[u]) for u in urns if u in truth._by_urn}

    async def draft_search_window(self, *, graph_id, branch_id, commit_id, since_seq=None,
                                  limit=0, containment_types=None):
        seq = int(commit_id.split("-")[1]) if commit_id else None
        self.windows.append((since_seq, seq))
        if since_seq is None:
            return {"seq": seq, "nodes": None, "edges": False}
        nodes = sorted({eid for s, writes in self.history.items()
                        if since_seq < s <= seq for eid in writes})
        moves = {t.upper() for t in containment_types or ()}
        edges = any(t is None or containment_types is None or t.upper() in moves
                    for s, rows in self.edge_rows.items() if since_seq < s <= seq for t in rows)
        return {"seq": seq, "nodes": nodes if len(nodes) <= limit else None, "edges": edges}

    async def draft_nodes_as_of(self, *, graph_id, branch_id, entity_ids, seq):
        self.as_of.append((list(entity_ids), seq))
        out = {}
        for eid in entity_ids:
            held = [writes[eid] for s, writes in sorted(self.history.items())
                    if s <= seq and eid in writes]
            if held:
                out[eid] = {"urn": eid[3:], "node": _reader(held[-1]) if held[-1] else None}
        return out


SCOPE = SearchScope(viewId="v", scopeMode="view", rootUrns=["db"], maxDepth=12)
TYPED = SearchScope(viewId="v", scopeMode="view", entityTypes=["Column"])
CONTEXT = SearchRunContext(data_version="7.draftns", scope_hash="scope-1")

RULES = {
    "gold": PropertyPredicate(key="tier", op="eq", value="gold"),
    "big": PropertyPredicate(key="rows", op="gt", value=8, valueType="number"),
    "named": TextPredicate(value="NAM", target="name"),
    "pii": TagPredicate(op="has", values=["pii"]),
    "cols": EntityTypePredicate(op="in", values=["column"]),
    "owned": HasPropertyPredicate(key="owner"),
    "under_t2": GroupPredicate(op="and", children=[DescendantOfPredicate(urns=["t2"])]),
    "not_gold": GroupPredicate(op="not", children=[PropertyPredicate(key="tier", op="eq",
                                                                      value="gold")]),
    "either": GroupPredicate(op="or", children=[TagPredicate(values=["pii"]),
                                                PropertyPredicate(key="rows", op="lt", value=8,
                                                                  valueType="number")]),
}


def _first_draft(draft: Optional[Draft] = None) -> Draft:
    """A draft that changes c2, removes c3 and creates c4 under t2."""
    draft = draft or Draft()
    draft.commit({"c2": {**draft.main["c2"], "tier": "gold", "rows": 50},
                  "c3": None,
                  "c4": {"entityType": "Column", "displayName": "phone", "tier": "gold",
                         "rows": 7}},
                 add_edges=[_edge("t2", "c4")], drop_edges=[_edge("t2", "c3")])
    return draft


def _overlay(draft, main=None) -> DraftOverlayProvider:
    p = DraftOverlayProvider(main or Main(), svc=draft, graph_id=draft.graph_id, branch_id="d1")
    p.set_containment_edge_types(["CONTAINS"])
    return p


async def _count(overlay, scope, items, wait_ms=5000):
    """Each rule's count on the draft, as the counts service composes it."""
    out = {}
    for rid, p in items:
        query = SearchQuery(predicate=p, scope=scope, options=SearchOptions(results="hits"))
        out[rid] = (await overlay.deep_search_count(query, context=CONTEXT))["count"]
    deltas = await overlay.deep_search_count_deltas(scope, items, context=CONTEXT,
                                                    wait_ms=wait_ms)
    if deltas is None:
        return out, None
    return {rid: n + deltas["deltas"].get(rid, 0) for rid, n in out.items()}, deltas


async def _truth_counts(draft, scope, items):
    truth = draft.truth()
    return {rid: (await truth.deep_search_count(SearchQuery(predicate=p, scope=scope)))["count"]
            for rid, p in items}


# ---------------------------------------------------------------------------
# Counts
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("scope", [SCOPE, TYPED], ids=["roots", "types"])
async def test_counts_are_the_drafts(scope):
    draft = _first_draft()
    items = list(RULES.items())
    counts, deltas = await _count(_overlay(draft), scope, items)
    assert deltas["status"] == "complete" and deltas["approximate"] == {}
    assert counts == await _truth_counts(draft, scope, items)
    assert counts["gold"] == 3          # c1, c2 (now gold), c4 (created); c3 removed


async def test_main_counts_are_mains_own_session():
    """Main's half is read on main's version — what main's own reads key it by — so a draft's
    commits never re-key it; the draft's is counted apart."""
    main = Main()
    draft = _first_draft()
    overlay = _overlay(draft, main)
    await _count(overlay, SCOPE, [("gold", RULES["gold"])])
    assert set(main.versions) == {published_data_version(CONTEXT.data_version, main)}
    assert published_data_version("7.anything", main) == published_data_version("7.x", main)
    assert published_data_version("", main) == ""


async def test_a_count_reads_a_large_draft_a_step_at_a_time(monkeypatch):
    monkeypatch.setattr(draft_search, "BATCH", 1)
    draft = _first_draft()
    overlay = _overlay(draft)
    items = [("gold", RULES["gold"])]
    seen = []
    for _ in range(10):
        deltas = await overlay.deep_search_count_deltas(SCOPE, items, context=CONTEXT,
                                                        wait_ms=0)
        seen.append((deltas["status"], deltas["progress"]["scanned"]))
        if deltas["status"] == "complete":
            break
    assert seen == [("running", 1), ("running", 2), ("complete", 3)]
    counts, _ = await _count(overlay, SCOPE, items)
    assert counts == await _truth_counts(draft, SCOPE, items)


async def test_a_later_commit_is_folded_in_not_read_again():
    draft = _first_draft()
    items = list(RULES.items())
    await _count(_overlay(draft), SCOPE, items)
    # A second commit: c1 is no longer gold; then c2 changes again.
    draft.commit({"c1": {**draft.nodes["c1"], "tier": "bronze"}})
    draft.loads.clear()
    counts, deltas = await _count(_overlay(draft), SCOPE, items)
    assert deltas["status"] == "complete"
    assert counts == await _truth_counts(draft, SCOPE, items)
    assert draft.loads == [["id-c1"]], "only what the commit wrote is read"
    assert draft.as_of == [(["id-c1"], 1)]
    draft.commit({"c2": {**draft.nodes["c2"], "tier": "silver"}})
    counts, _ = await _count(_overlay(draft), SCOPE, items)
    assert counts == await _truth_counts(draft, SCOPE, items)
    assert counts["gold"] == 1          # c4


async def test_a_fold_of_more_than_half_the_draft_reads_it_whole():
    draft = Draft()
    draft.commit({"c2": {**draft.main["c2"], "tier": "gold"}})
    items = [("gold", RULES["gold"])]
    await _count(_overlay(draft), SCOPE, items)
    draft.commit({"c1": {**draft.main["c1"], "tier": "x"}, "c3": {**draft.main["c3"], "rows": 1}})
    draft.as_of.clear()
    counts, _ = await _count(_overlay(draft), SCOPE, items)
    assert counts == await _truth_counts(draft, SCOPE, items)
    assert draft.as_of == []


async def test_a_rule_that_follows_relationships_keeps_mains_count_and_says_so():
    draft = _first_draft()
    items = [("orphan", DegreePredicate(direction="both", op="eq", value=0)),
             ("gold", RULES["gold"])]
    counts, deltas = await _count(_overlay(draft), SCOPE, items)
    main_counts = {rid: (await Main().deep_search_count(SearchQuery(predicate=p, scope=SCOPE),
                                                        context=CONTEXT))["count"]
                   for rid, p in items}
    assert counts["orphan"] == main_counts["orphan"]
    assert deltas["approximate"] == {"orphan": draft_search.RELATIONSHIPS}
    assert counts["gold"] == 3


async def test_a_rule_naming_an_entity_the_draft_changed_keeps_mains_count():
    draft = _first_draft()
    items = [("is_c2", IsPredicate(refs=[NodeRef(urn="c2")]))]
    context = SearchRunContext(data_version="7.d", scope_hash="s",
                               named={"is_c2": frozenset({"c2"})})
    deltas = await _overlay(draft).deep_search_count_deltas(SCOPE, items, context=context,
                                                            wait_ms=1000)
    assert deltas["approximate"] == {"is_c2": draft_search.NAMES_CHANGED}


async def test_a_draft_that_changes_nothing_counts_as_main():
    overlay = _overlay(Draft())
    assert await overlay.deep_search_count_deltas(SCOPE, [("gold", RULES["gold"])],
                                                  context=CONTEXT, wait_ms=100) is None


async def test_a_failing_correction_is_mains_count_said_so():
    class Broken(Draft):
        async def overlay_payloads(self, **kw):
            raise RuntimeError("postgres went away")

    deltas = await _overlay(_first_draft_on(Broken())).deep_search_count_deltas(
        SCOPE, [("gold", RULES["gold"])], context=CONTEXT, wait_ms=100)
    assert deltas == {"deltas": {}, "approximate": {"gold": draft_search.NOT_DRAFT_AWARE},
                      "status": "complete", "progress": {"scanned": 0, "total": 0}}


def _first_draft_on(draft: Draft) -> Draft:
    draft.commit({"c2": {**draft.main["c2"], "tier": "gold"}})
    return draft


async def test_a_draft_too_large_to_read_whole_counts_as_main_said_so(monkeypatch):
    monkeypatch.setattr(vconfig, "DRAFT_SEARCH_MAX_DELTA", 2)
    draft = _first_draft()                                  # it changed three entities
    items = [("gold", RULES["gold"]), ("orphan", DegreePredicate(direction="both", op="eq", value=0))]
    counts, deltas = await _count(_overlay(draft), SCOPE, items)
    note = draft_search.TOO_LARGE.format(n=2)
    assert note == "Your draft changed more than 2 entities, so these counts show the published graph."
    assert deltas == {"deltas": {}, "approximate": {"gold": note, "orphan": note},
                      "status": "complete", "progress": {"scanned": 0, "total": 0}}
    assert counts["gold"] == 2 and draft.loads == []        # main's (c1, c3): none of it read


async def test_a_fold_stays_exact_however_large_the_draft(monkeypatch):
    draft = _first_draft()
    items = [("gold", RULES["gold"])]
    await _count(_overlay(draft), SCOPE, items)             # read whole while it is small
    monkeypatch.setattr(vconfig, "DRAFT_SEARCH_MAX_DELTA", 2)
    draft.commit({"c1": {**draft.nodes["c1"], "tier": "bronze"}})
    counts, deltas = await _count(_overlay(draft), SCOPE, items)
    assert deltas["approximate"] == {} and draft.as_of == [(["id-c1"], 1)]
    assert counts == await _truth_counts(draft, SCOPE, items)


async def test_a_commit_that_moves_nothing_is_folded_in():
    """A relationship of a type that isn't containment moves no entity, so a commit that writes
    one is folded in; one that moves an entity has the draft read whole again."""
    draft = _first_draft()
    items = list(RULES.items())
    await _count(_overlay(draft), SCOPE, items)
    draft.commit({"c1": {**draft.nodes["c1"], "tier": "bronze"}},
                 add_edges=[_edge("c2", "c4", "FLOWS_TO")])
    counts, _ = await _count(_overlay(draft), SCOPE, items)
    assert counts == await _truth_counts(draft, SCOPE, items)
    assert draft.as_of == [(["id-c1"], 1)], "folded in"
    draft.commit({"c2": {**draft.nodes["c2"], "tier": "silver"}},
                 add_edges=[_edge("t1", "c4")], drop_edges=[_edge("t2", "c4")])
    draft.as_of.clear()
    counts, _ = await _count(_overlay(draft), SCOPE, items)
    assert counts == await _truth_counts(draft, SCOPE, items)
    assert draft.as_of == [], "a move: read whole"


def _pointed(store, prefix: str) -> str:
    [sid] = [sid for name, (_at, sid) in store._pointers.items() if name.startswith(prefix)]
    return sid


async def test_a_correction_a_later_one_supersedes_is_deleted(memory_store, monkeypatch):
    """Not left to its hour: the complete one a later version's is folded from, once that one
    completes; one still running for an earlier version, once the later one starts."""
    items = [("gold", RULES["gold"])]
    draft = _first_draft()
    await _count(_overlay(draft), SCOPE, items)
    first = _pointed(memory_store, "draft-search:")
    draft.commit({"c1": {**draft.nodes["c1"], "tier": "bronze"}})
    await _count(_overlay(draft), SCOPE, items)
    later = _pointed(memory_store, "draft-search:")
    assert later != first and await memory_store.load(first) is None
    assert (await memory_store.load(later)).status == COMPLETE

    monkeypatch.setattr(draft_search, "BATCH", 1)
    other = _first_draft()
    await _overlay(other).deep_search_count_deltas(SCOPE, items, context=CONTEXT, wait_ms=0)
    running = [sid for name, (_at, sid) in memory_store._pointers.items()
               if name.startswith("draft-search-running:") and sid not in (first, later)]
    assert len(running) == 1 and (await memory_store.load(running[0])).status == "running"
    other.commit({"c1": {**other.nodes["c1"], "tier": "bronze"}})
    await _overlay(other).deep_search_count_deltas(SCOPE, items, context=CONTEXT, wait_ms=0)
    assert await memory_store.load(running[0]) is None


async def test_a_correction_is_saved_every_few_steps_and_when_it_completes(memory_store, monkeypatch):
    monkeypatch.setattr(draft_search, "BATCH", 1)
    monkeypatch.setattr(draft_search, "SAVE_EVERY", 2)
    saved, real = [], memory_store.save

    async def save(session, token, ttl_s, **kw):
        saved.append(session.scanned)
        return await real(session, token, ttl_s, **kw)
    monkeypatch.setattr(memory_store, "save", save)
    deltas = await _overlay(_first_draft()).deep_search_count_deltas(
        SCOPE, [("gold", RULES["gold"])], context=CONTEXT, wait_ms=5000)
    assert deltas["status"] == "complete" and saved == [2, 3]


# ---------------------------------------------------------------------------
# Membership
# ---------------------------------------------------------------------------

async def test_membership_answers_what_the_draft_changed_on_the_draft():
    draft = _first_draft()
    urns = ["c1", "c2", "c3", "c4", "t1"]
    items = list(RULES.items())
    out = await _overlay(draft).deep_search_membership(SCOPE, items, urns, context=CONTEXT)
    want = await draft.truth().deep_search_membership(SCOPE, items, urns)
    assert {k: sorted(v) for k, v in out["matches"].items()} == \
        {k: sorted(v) for k, v in want["matches"].items()}
    assert sorted(out["matches"]["gold"]) == ["c1", "c2", "c4"]
    assert out["notes"] == []


async def test_membership_of_a_relationship_rule_is_mains_less_what_the_draft_removed():
    draft = _first_draft()
    rule = GroupPredicate(op="not", children=[DegreePredicate(direction="in", op="eq", value=0,
                                                              edgeClass="lineage")])
    out = await _overlay(draft).deep_search_membership(
        SCOPE, [("fed", rule)], ["c1", "c3", "c4"], context=CONTEXT)
    assert out["matches"]["fed"] == []       # c3 had lineage in, but the draft removed it
    assert out["notes"] == [draft_search.MEMBERSHIP_MAINS.format(n=1)]


class EdgeDraft(Draft):
    """A draft that serves its relationships' values as the versioning service does."""

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids, kind="node",
                               as_of_seq=None):
        if kind != "edge":
            return await super().overlay_payloads(graph_id=graph_id, branch_id=branch_id,
                                                  entity_ids=entity_ids, kind=kind)
        return [{"id": e, "sourceUrn": self.edges[e]["source"], "targetUrn": self.edges[e]["target"],
                 "edgeType": self.edges[e]["type"], "properties": self.edges[e].get("properties") or {}}
                for e in entity_ids if e in self.edges]


P_EDGES = TypeAdapter(Predicate).validate_python


def _flow(src, tgt, **props):
    return {"id": f"e:{src}>{tgt}", "source": src, "target": tgt, "type": "FLOWS_TO", "properties": props}


EDGE_RULES = {
    "to_gold": P_EDGES({"kind": "edges", "edgeTypes": ["FLOWS_TO"], "targetWhere": {
        "kind": "property", "key": "tier", "op": "eq", "value": "gold"}}),
    "streams": P_EDGES({"kind": "edges", "edgePredicate": {
        "kind": "edgeProperty", "key": "mode", "op": "eq", "value": "stream"}}),
}


def _asked_edges(draft, ids):
    held = {**{e["id"]: e for e in MAIN_EDGES}, **draft.edges}
    return [SearchMembershipEdge(id=i, source=held[i]["source"], target=held[i]["target"]) for i in ids]


async def test_edge_membership_judges_the_relationships_the_draft_changed_on_the_draft():
    """c2 → c4 and c1 → c4 are new in the draft (c4 created gold), c1 → c3 lost its end (c3
    removed): each is answered as the draft holds it — the truth over the draft's graph."""
    draft = _first_draft(EdgeDraft())
    draft.commit({}, add_edges=[_flow("c2", "c4", mode="stream"), _flow("c1", "c4", mode="batch")])
    asked = _asked_edges(draft, ["e:c1>c3", "e:c2>c4", "e:c1>c4"])
    items = list(EDGE_RULES.items())
    out = await _overlay(draft).deep_search_edge_membership(SCOPE, items, asked, context=CONTEXT)
    want = await draft.truth().deep_search_edge_membership(SCOPE, items, asked)
    assert out["matches"] == want["matches"] == {"to_gold": ["e:c2>c4", "e:c1>c4"],
                                                 "streams": ["e:c2>c4"]}
    assert out["notes"] == []
    # Main alone: c1 → c3 still reaches a gold column, and the draft's relationships are unknown.
    main = await Main().deep_search_edge_membership(SCOPE, items, asked)
    assert main["matches"] == {"to_gold": ["e:c1>c3"], "streams": []}


async def test_edge_membership_of_a_relationship_the_draft_removed_is_nothing():
    draft = EdgeDraft()
    draft.commit({}, drop_edges=[_flow("c1", "c3")])
    asked = _asked_edges(draft, ["e:c1>c3"])
    out = await _overlay(draft).deep_search_edge_membership(
        SCOPE, [("to_gold", EDGE_RULES["to_gold"])], asked, context=CONTEXT)
    assert out["matches"] == {"to_gold": []}


async def test_edge_membership_keeps_mains_answer_for_one_whose_end_alone_changed_and_says_so():
    main = Main(edges=[*MAIN_EDGES, _flow("c1", "c2")])
    draft = _first_draft_on(EdgeDraft())               # c2 changed to gold, c1 → c2 unchanged
    asked = [SearchMembershipEdge(id="e:c1>c2", source="c1", target="c2")]
    out = await _overlay(draft, main).deep_search_edge_membership(
        SCOPE, list(EDGE_RULES.items()), asked, context=CONTEXT)
    assert out["matches"] == {"to_gold": [], "streams": []}
    assert out["notes"] == [draft_search.EDGE_MEMBERSHIP_ENDS.format(n=1)]


async def test_membership_falls_back_to_main_when_the_draft_cant_be_read():
    class Broken(Draft):
        async def overlay_version(self, **kw):
            raise RuntimeError("no versioning")

    out = await _overlay(Broken()).deep_search_membership(
        SCOPE, [("gold", RULES["gold"])], ["c1", "c3"], context=CONTEXT)
    assert sorted(out["matches"]["gold"]) == ["c1", "c3"]
    assert out["notes"] == [draft_search.MEMBERSHIP_NOT_DRAFT_AWARE]


# ---------------------------------------------------------------------------
# The catalog
# ---------------------------------------------------------------------------

async def test_the_catalog_is_the_drafts():
    draft = _first_draft()
    out = await _overlay(draft).deep_search_catalog(SCOPE, context=CONTEXT, wait_ms=2000)
    want = await catalog_of(draft.truth(), SCOPE, CONTEXT)
    assert out["status"] == "complete"
    assert out["entities"] == want["entities"] == 6
    got = {p["key"]: p for p in out["properties"]}
    for p in want["properties"]:
        held = got[p["key"]]
        for field in ("count", "byEntityType", "kinds", "distinct", "distinctExact", "values"):
            assert held[field] == p[field], (p["key"], field)
    # c3 (rows 5, the least) went: the range still bounds every value, and says it may be wider.
    rows = got["rows"]
    assert (rows["min"], rows["max"]) == (5, 50) and rows["rangeExact"] is False
    assert got["tier"]["rangeExact"] is True
    assert draft_search.CATALOG_RANGES in out["notes"]
    assert out["dataVersion"] == CONTEXT.data_version


async def test_the_catalog_folds_a_later_commit_in():
    draft = _first_draft()
    await _overlay(draft).deep_search_catalog(SCOPE, context=CONTEXT, wait_ms=2000)
    draft.commit({"c1": {**draft.nodes["c1"], "tier": "bronze", "tags": []}})
    draft.loads.clear()
    out = await _overlay(draft).deep_search_catalog(SCOPE, context=CONTEXT, wait_ms=2000)
    want = await catalog_of(draft.truth(), SCOPE, CONTEXT)
    assert draft.loads == [["id-c1"]]
    assert {p["key"]: p["values"] for p in out["properties"]} == \
        {p["key"]: p["values"] for p in want["properties"]}
    assert out["tags"] == want["tags"] == []


async def test_while_mains_catalog_is_read_it_is_served_as_it_grows():
    main = Main()
    main.catalog_complete = False
    out = await _overlay(_first_draft(), main).deep_search_catalog(SCOPE, context=CONTEXT,
                                                                    wait_ms=2000)
    assert out["status"] == "running"
    assert {p["key"] for p in out["properties"]} == {"owner", "rows", "tier"}


async def test_a_catalog_read_a_step_at_a_time_reads_its_statistics_once(monkeypatch):
    """Its statistics are read from the correction once a request, not once a step: the
    change's, main's and the fold's copy of main's — however many steps it takes."""
    monkeypatch.setattr(draft_search, "BATCH", 1)
    parsed, real = [], CatalogStats.from_json
    monkeypatch.setattr(CatalogStats, "from_json",
                        classmethod(lambda cls, raw: parsed.append(raw) or real(raw)))
    draft = _first_draft()
    out = await _overlay(draft).deep_search_catalog(SCOPE, context=CONTEXT, wait_ms=2000)
    want = await catalog_of(draft.truth(), SCOPE, CONTEXT)
    assert out["status"] == "complete" and len(parsed) == 3
    assert {p["key"]: (p["count"], p["values"]) for p in out["properties"]} == \
        {p["key"]: (p["count"], p["values"]) for p in want["properties"]}


async def test_a_catalog_of_a_draft_too_large_to_read_whole_is_mains_said_so(monkeypatch):
    monkeypatch.setattr(vconfig, "DRAFT_SEARCH_MAX_DELTA", 2)
    out = await _overlay(_first_draft()).deep_search_catalog(SCOPE, context=CONTEXT, wait_ms=2000)
    rows = {p["key"]: p for p in out["properties"]}["rows"]
    assert (rows["min"], rows["max"]) == (5, 20)            # main's: the draft's c2 holds 50
    assert out["notes"][-1] == draft_search.TOO_LARGE_CATALOG.format(n=2)


def test_a_change_to_too_many_tags_stops_counting_them(monkeypatch):
    from backend.app.providers.falkordb_search import catalog
    monkeypatch.setattr(catalog, "TAG_SETS_MAX", 2)
    change = CatalogStats()
    for i in range(5):
        change.add_entity("Table", {}, [f"t{i}"], frozenset())
    assert change.tags_counted is False and change.tags == {}
    merged, _wide = CatalogStats(tags={"pii": 3}, tagged=3).folded(change)
    assert merged.tags_counted is False and merged.tags == {}
    session = Session("s", "catalog", "1", None, 0, [], [], 1, status=COMPLETE)
    answer = answer_of(merged, session, CONTEXT)
    assert answer["tags"] == [] and answer["tagged"] is None
    # Within the cap they are counted, and a tag the change takes out as it puts back is gone.
    few = CatalogStats()
    few.add_entity("Table", {}, ["a"], frozenset())
    few.add_entity("Table", {}, ["a"], frozenset(), -1)
    assert few.tags == {} and few.tags_counted


async def test_a_catalog_whose_draft_cant_be_read_is_mains_said_so():
    class Broken(Draft):
        async def overlay_payloads(self, **kw):
            raise RuntimeError("postgres went away")

    out = await _overlay(_first_draft_on(Broken())).deep_search_catalog(
        SCOPE, context=CONTEXT, wait_ms=500)
    assert draft_search.CATALOG_NOT_DRAFT_AWARE in out["notes"]
    assert out["status"] == "complete"


# ---------------------------------------------------------------------------
# A draft over a lagging main: a 501, not an AttributeError's 500
# ---------------------------------------------------------------------------

async def test_a_draft_over_a_lagging_main_refuses_counts_membership_and_the_catalog():
    overlay = DraftOverlayProvider(VersionedBranchProvider(object(), graph_id="g", branch_id="m"),
                                   svc=_first_draft(), graph_id="g-lag", branch_id="d1")
    query = SearchQuery(predicate=RULES["gold"], scope=SCOPE)
    with pytest.raises(NotImplementedError, match="catching up"):
        await overlay.deep_search_count(query, context=CONTEXT)
    with pytest.raises(NotImplementedError, match="catching up"):
        await overlay.deep_search_membership(SCOPE, [("gold", RULES["gold"])], ["c1"],
                                             context=CONTEXT)
    with pytest.raises(NotImplementedError, match="catching up"):
        await overlay.deep_search_catalog(SCOPE, context=CONTEXT, wait_ms=100)
    for name in ("deep_search_session", "deep_search_export", "deep_search_export_open",
                 "deep_search_ancestor_counts"):
        assert callable(getattr(VersionedBranchProvider, name))


# ---------------------------------------------------------------------------
# Through the service: counts compose, membership carries the notes
# ---------------------------------------------------------------------------

def _service(provider) -> AdvancedSearchService:
    svc = AdvancedSearchService(SimpleNamespace(provider=provider), session=None,
                                workspace_id="ws")

    async def resolve(requested):
        return EffectiveViewScope(
            view_id="v", workspace_id="ws", data_source_id=None, canvas_kind="graph",
            root_urns=("db",), entity_type_allow_list=frozenset(), layer_allow_list=frozenset(),
            max_depth=12, scope_hash="scope-1")

    async def guard(scope):
        return None

    svc._resolve_scope = resolve
    svc._guard_view_data_source = guard
    return svc


async def test_the_counts_service_moves_mains_counts_by_the_drafts():
    draft = _first_draft()
    request = SearchCountsRequest.model_validate({
        "scope": {"viewId": "v"}, "waitMs": 2000,
        "items": [{"id": "gold", "predicate": RULES["gold"].model_dump(by_alias=True)},
                  {"id": "orphan", "predicate": {"kind": "degree", "direction": "both",
                                                 "op": "eq", "value": 0}}]})
    out = await _service(_overlay(draft)).counts(request, run_context=CONTEXT)
    gold, orphan = out.counts["gold"], out.counts["orphan"]
    assert (gold.count, gold.status, gold.approximate) == (3, "complete", False)
    assert orphan.approximate and orphan.note == draft_search.RELATIONSHIPS
    assert out.data_version == CONTEXT.data_version


async def test_the_membership_service_carries_the_drafts_notes():
    request = SearchMembershipRequest.model_validate({
        "scope": {"viewId": "v"}, "urns": ["c3", "c4"],
        "items": [{"id": "gold", "predicate": RULES["gold"].model_dump(by_alias=True)},
                  {"id": "orphan", "predicate": {"kind": "degree", "direction": "both",
                                                 "op": "eq", "value": 0}}]})
    out = await _service(_overlay(_first_draft())).membership(request, run_context=CONTEXT)
    assert out.matches["gold"] == ["c4"]
    assert out.notes == [draft_search.MEMBERSHIP_MAINS.format(n=1)]


# ---------------------------------------------------------------------------
# A bulk property job's draft matches: what main's export can't name
# ---------------------------------------------------------------------------

def _judge(overlay, asked=None):
    svc = _service(overlay)

    async def judge(request):
        if asked is not None:
            asked.append(list(request.urns))
        return await svc.membership(request, run_context=CONTEXT)
    return judge


def _json(predicate) -> Dict[str, Any]:
    return predicate.model_dump(mode="json", by_alias=True)


async def test_draft_matches_are_what_the_draft_made_or_changed_that_matches_a_batch_at_a_time(
        monkeypatch):
    """c2 changed to gold and c4 created gold; c3 removed is never asked; c1 is main's to find."""
    monkeypatch.setattr(draft_search, "BATCH", 1)
    overlay, asked = _overlay(_first_draft()), []
    out = await draft_search.draft_matches(overlay, {"viewId": "v"}, _json(RULES["gold"]),
                                           _judge(overlay, asked))
    assert out == {"ids": ["id-c2", "id-c4"]}
    assert asked == [["c2"], ["c4"]]
    out = await draft_search.draft_matches(overlay, {"viewId": "v"}, _json(RULES["not_gold"]),
                                           _judge(overlay))
    assert out == {"ids": []}


async def test_draft_matches_are_none_when_the_draft_cant_answer_for_them(monkeypatch):
    """A search its values can't answer, a draft past the limit, a fork, a draft that can't be
    read: no draft matches, and why."""
    overlay = _overlay(_first_draft())
    orphan = {"kind": "degree", "direction": "both", "op": "eq", "value": 0}
    assert await draft_search.draft_matches(overlay, {"viewId": "v"}, orphan, _judge(overlay)) == \
        {"unsearched": "inexact"}

    class Broken(Draft):
        async def overlay_payloads(self, **kw):
            raise RuntimeError("postgres went away")

    broken = _overlay(_first_draft_on(Broken()))
    assert await draft_search.draft_matches(broken, {"viewId": "v"}, _json(RULES["gold"]),
                                            _judge(broken)) == {"unsearched": "unread"}

    fork = DraftOverlayProvider(Main(), svc=_first_draft(), graph_id="g-fork", branch_id="d1",
                                fork=True)
    asked = []
    assert await draft_search.draft_matches(fork, {"viewId": "v"}, _json(RULES["gold"]),
                                            _judge(fork, asked)) == {"unsearched": "fork"}
    monkeypatch.setattr(vconfig, "DRAFT_SEARCH_MAX_DELTA", 2)       # D: c2, c3, c4
    assert await draft_search.draft_matches(overlay, {"viewId": "v"}, _json(RULES["gold"]),
                                            _judge(overlay, asked)) == {"unsearched": "too_large"}
    assert asked == []


class _EdgeOverlay:
    """A draft's patch set of relationships, for ``edge_draft_matches``: ``upsert`` (id → its
    type, ends and properties), ``removed`` ids and the urns of the nodes it changed."""

    def __init__(self, upsert, removed=(), nodes=(), fork=False, lineage=("FLOWS_TO",)):
        from backend.common.models.graph import GraphEdge
        self.edges = {eid: GraphEdge(id=eid, edgeType=t, sourceUrn=s, targetUrn=g, properties=props)
                      for eid, (t, s, g, props) in upsert.items()}
        self.removed, self.nodes, self.fork, self.lineage = set(removed), set(nodes), fork, lineage
        self.loaded: List[List[str]] = []

    def _searches_draft(self):
        return not self.fork

    def _get_containment_edge_types(self):
        return ["CONTAINS"]

    def _get_lineage_edge_types(self):
        if self.lineage is None:
            raise RuntimeError("no ontology")
        return list(self.lineage)

    async def _delta_(self):
        async def edges(batch):
            self.loaded.append([e.id for e in batch])
            return batch
        return SimpleNamespace(edge_upsert=self.edges, edge_remove={e: None for e in self.removed},
                               node_modified={u: f"id-{u}" for u in self.nodes}, node_upsert={},
                               node_remove=set(), shared={}, edges=edges)


def _ends_judge(meets: Dict[str, set], asked=None, notes=(), refuse=False):
    """Membership over ``meets`` (rule id → the urns it matches): what each end meets."""
    from backend.app.services.advanced_search_service import ValidationError
    from backend.common.models.search import SearchMembershipResult

    async def judge(request):
        if refuse:
            raise ValidationError("not a rule")
        if asked is not None:
            asked.append((sorted(request.urns), [i.predicate.kind for i in request.items]))
        return SearchMembershipResult(matches={i.id: [u for u in request.urns if u in meets.get(i.id, ())]
                                               for i in request.items}, notes=list(notes))
    return judge


async def test_edge_draft_matches_are_the_relationships_the_draft_made_or_changed_that_match():
    """Of the types the search takes — every link by default, never the hierarchy's or a roll-up —
    filtered on the draft's values, with the source meeting From and the target To (or, either way
    round, the other); one the draft removed is never asked."""
    overlay = _EdgeOverlay({
        "e1": ("FLOWS_TO", "a", "b", {"tier": "gold"}), "e2": ("FEEDS", "b", "a", {"tier": "gold"}),
        "e3": ("CONTAINS", "a", "b", {"tier": "gold"}), "e4": ("AGGREGATED", "a", "b", {"tier": "gold"}),
        "e5": ("FLOWS_TO", "a", "c", {"tier": "silver"}), "e6": ("FLOWS_TO", "a", "b", {})},
        removed=["e6"], nodes=["b"])
    asked = []
    gold = {"kind": "edgeProperty", "key": "tier", "op": "eq", "value": "gold"}
    from_a = {"kind": "edges", "edgePredicate": gold, "sourceWhere": {"kind": "is", "refs": [{"urn": "a"}]}}
    out = await draft_search.edge_draft_matches(overlay, {"viewId": "v"}, from_a,
                                                _ends_judge({"from": {"a"}, "to": {"a", "b"}}, asked))
    assert out == {"ids": ["e1"], "unsearched": "ends"}, "the draft changed b: an end may now match"
    assert overlay.loaded == [["e1", "e2", "e5"]]
    assert asked == [(["a", "b"], ["is", "all"])], "e5 filtered out first"
    either = {**from_a, "direction": "either"}
    out = await draft_search.edge_draft_matches(overlay, {"viewId": "v"}, either,
                                                _ends_judge({"from": {"a"}, "to": {"a", "b"}}))
    assert out == {"ids": ["e1", "e2"], "unsearched": "ends"}
    # A class, or named types; no end tested, so no note of the ends.
    for predicate, ids in (({"kind": "edges", "edgeClass": "lineage"}, ["e1", "e5"]),
                           ({"kind": "edges", "edgeClass": "containment"}, ["e3"]),
                           ({"kind": "edges", "edgeClass": "any"}, ["e1", "e2", "e3", "e5"]),
                           ({"kind": "edges", "edgeTypes": ["feeds"]}, ["e2"])):
        out = await draft_search.edge_draft_matches(overlay, {"viewId": "v"}, predicate,
                                                    _ends_judge({"from": {"a", "b"}, "to": {"a", "b", "c"}}))
        assert out == {"ids": ids}, predicate


async def test_edge_draft_matches_are_none_when_the_draft_cant_answer_for_them(monkeypatch):
    overlay = _EdgeOverlay({"e1": ("FLOWS_TO", "a", "b", {})})
    edges = {"kind": "edges", "sourceWhere": {"kind": "isOrphan"}}
    meets = {"from": {"a"}, "to": {"b"}}
    for judge, why in ((_ends_judge(meets, notes=[draft_search.RELATIONSHIPS]), "inexact"),
                       (_ends_judge(meets, refuse=True), "inexact"),
                       (_ends_judge(meets, notes=[draft_search.MEMBERSHIP_NOT_DRAFT_AWARE]), "unread")):
        assert await draft_search.edge_draft_matches(overlay, {"viewId": "v"}, edges, judge) == \
            {"unsearched": why}
    assert await draft_search.edge_draft_matches(
        _EdgeOverlay({}, fork=True), {"viewId": "v"}, edges, _ends_judge(meets)) == {"unsearched": "fork"}
    assert await draft_search.edge_draft_matches(
        _EdgeOverlay({}, lineage=None), {"viewId": "v"}, {"kind": "edges", "edgeClass": "lineage"},
        _ends_judge(meets)) == {"unsearched": "inexact"}
    monkeypatch.setattr(vconfig, "DRAFT_SEARCH_MAX_DELTA", 0)
    assert await draft_search.edge_draft_matches(
        overlay, {"viewId": "v"}, edges, _ends_judge(meets)) == {"unsearched": "too_large"}


def test_an_edge_filter_reads_its_own_fields_and_its_properties_by_every_operator():
    from backend.common.models.search import (
        EdgeGroupPredicate, EdgeHasPropertyPredicate, EdgePropertyPredicate,
    )
    from backend.common.predicate_eval import edge_matches

    edge = {"id": "e1", "confidence": 0.8, "properties": {"tier": "Gold", "rank": 5}}
    assert edge_matches(edge, None)
    assert edge_matches(edge, EdgePropertyPredicate(key="confidence", op="gt", value=0.5, valueType="number"))
    assert edge_matches(edge, EdgePropertyPredicate(key="tier", op="eq", value="gold"))      # in any case
    assert not edge_matches(edge, EdgePropertyPredicate(key="tier", op="eq", value="gold",
                                                        caseSensitive=True))
    assert edge_matches(edge, EdgePropertyPredicate(key="rank", op="in", value=[5.0], valueType="number"))
    # A user's property is stored natively within the name budget: every operator reads it.
    assert edge_matches(edge, EdgePropertyPredicate(key="rank", op="gt", value=4, valueType="number"))
    assert edge_matches(edge, EdgePropertyPredicate(key="tier", op="startsWith", value="go"))
    assert not edge_matches(edge, EdgePropertyPredicate(key="rank", op="between", value=[6, 9],
                                                        valueType="number"))
    assert edge_matches(edge, EdgeGroupPredicate(op="not", children=[EdgeHasPropertyPredicate(key="owner")]))
    assert not edge_matches(edge, EdgeGroupPredicate(op="and", children=[
        EdgeHasPropertyPredicate(key="tier"), EdgeHasPropertyPredicate(key="confidence", negate=True)]))


# ---------------------------------------------------------------------------
# The shared evaluator: the FalkorDB compiler's meaning
# ---------------------------------------------------------------------------

def test_node_dict_is_the_node_as_falkordb_holds_it():
    node = GraphNode(urn="u", entityType="Data Set", displayName="Orders",
                     qualifiedName="db.orders", description="All orders",
                     properties={"owner": "Ann", "childCount": 3, "rows": 4}, tags=["PII"])
    nd = draft_search.node_dict(node)
    assert nd["entityType"] == "Data_Set"
    assert "childCount" not in nd and nd["owner"] == "Ann" and nd["rows"] == 4
    assert nd["searchableText"] == "orders db.orders all orders ann pii"
    assert nd["layerAssignment"] == "" and nd["tags"] == ["PII"]


def test_the_evaluator_reads_predicates_as_the_compiler_does():
    nd = {"urn": "u", "entityType": "Dataset", "displayName": "Orders", "qualifiedName": "",
          "tags": ["pii", "eu"], "searchableText": "orders"}
    # toLower(labels(n)[0]) IN the values lowered.
    assert matches(nd, EntityTypePredicate(op="in", values=["DATASET"]))
    # A tag "has" is any of its values, as the compiler ORs them.
    assert matches(nd, TagPredicate(op="has", values=["pii", "gdpr"]))
    # Tags are text as the node stores them: JSON.
    assert matches(nd, TextPredicate(value='"pii", "eu"', target="tags"))
    assert not matches(nd, TextPredicate(value="pii", target="tags", match="exact"))
    # Case-sensitive text is compared as written.
    assert not matches(nd, TextPredicate(value="orders", target="name", caseSensitive=True))
    assert matches(nd, TextPredicate(value="Ord", target="name", caseSensitive=True,
                                     match="prefix"))


def test_what_cant_be_answered_on_the_drafts_values_is_said():
    assert draft_search.inexact(RULES["gold"], set()) is None
    assert draft_search.inexact(DegreePredicate(direction="in", op="gt", value=0),
                                set()) == draft_search.RELATIONSHIPS
    assert draft_search.inexact(PropertyPredicate(key="childCount", op="gt", value=1,
                                                  valueType="number"),
                                set()) == draft_search.PLATFORM_FIELD
    assert draft_search.inexact(RULES["gold"], {"x"}, frozenset({"x"})) == \
        draft_search.NAMES_CHANGED
    # A rule that styles relationships is counted on the published graph.
    assert draft_search.inexact(EDGE_RULES["streams"], set()) == draft_search.RELATIONSHIP_COUNT


# ---------------------------------------------------------------------------
# The relationship catalog
# ---------------------------------------------------------------------------

#: Main's relationships with properties — one to an entity outside the view (x1, under no root).
REL_NODES = MAIN + [{"urn": "x1", "entityType": "Table", "displayName": "outside"}]
REL_EDGES = MAIN_EDGES[:-1] + [
    {**_edge("c1", "c3", "FLOWS_TO"), "properties": {"mode": "batch", "lag": 5}},
    {**_edge("c2", "c3", "FLOWS_TO"), "properties": {"mode": "batch", "owner": "kim"}},
    {**_edge("c1", "x1", "FLOWS_TO"), "properties": {"mode": "zzz"}},
]


def _rel_stats(nodes, edges, scope) -> CatalogStats:
    """The relationship catalog of a graph, read whole: every relationship with both ends in
    the scope, by type, its properties as stored."""
    truth = StubDeepSearchProvider(nodes=nodes, edges=edges, lineage_edge_types=["FLOWS_TO"])
    inside = {n["urn"] for n in truth._in_scope(scope)}
    stats = CatalogStats()
    for e in edges:
        if e["source"] in inside and e["target"] in inside:
            stats.add_entities(e["type"], 1)
            stats.add_properties(e["type"], e.get("properties") or {}, frozenset())
    return stats


class RelMain(Main):
    """Main holding ``REL_EDGES``: its relationship catalog, and its relationships read between
    their ends as FalkorDB stores them — each user property in the JSON bag."""

    def __init__(self):
        super().__init__(nodes=REL_NODES, edges=REL_EDGES)
        self.between: List[Any] = []

    async def deep_search_catalog(self, scope, *, context, wait_ms, session_id=None,
                                  refresh=False, subject="entities"):
        assert subject == "relationships"
        from backend.app.providers.falkordb_search.session import store_for
        stats = _rel_stats(REL_NODES, REL_EDGES, scope)
        session = Session(f"rcat-{uuid.uuid4().hex[:8]}", "catalog:relationships",
                          context.data_version, None, 0, [], [], 1, scanned=1,
                          count=sum(stats.entities.values()), status=COMPLETE)
        await store_for(self).save(session, None, 600, accumulator=stats.to_json())
        return answer_of(stats, session, context, subject="relationships")

    async def relationships_between(self, pairs):
        import json as _json
        self.between.append(list(pairs))
        out: Dict[Any, List[Any]] = {}
        for e in REL_EDGES:
            if (e["source"], e["target"]) in set(pairs):
                out.setdefault((e["source"], e["target"]), []).append(
                    (e["type"], {"id": e["id"], "gvHash": "h",
                                 "properties": _json.dumps(e.get("properties") or {})}))
        return out


class RelDraft(Draft):
    """A draft over ``REL_EDGES``: its patch set names each relationship it added, changed (with
    where main holds it) or removed, and serves each one's value."""

    def __init__(self):
        super().__init__(REL_NODES, REL_EDGES)

    def truth(self) -> StubDeepSearchProvider:
        return StubDeepSearchProvider(nodes=list(self.nodes.values()),
                                      edges=list(self.edges.values()),
                                      lineage_edge_types=["FLOWS_TO"])

    async def branch_overlay_delta(self, *, graph_id, branch_id):
        delta = await super().branch_overlay_delta(graph_id=graph_id, branch_id=branch_id)
        main_edges = {e["id"]: e for e in REL_EDGES}
        delta["edgesUpsert"], delta["edgesRemove"] = [], []
        for eid, e in self.edges.items():
            held = main_edges.get(eid)
            if held == e:
                continue
            row = {"id": eid, "sourceUrn": e["source"], "targetUrn": e["target"],
                   "edgeType": e["type"], "lazy": True}
            if held is not None:
                row["was"] = {"sourceUrn": held["source"], "targetUrn": held["target"],
                              "edgeType": held["type"]}
            delta["edgesUpsert"].append(row)
        for eid, e in main_edges.items():
            if eid not in self.edges:
                delta["edgesRemove"].append({"id": eid, "sourceUrn": e["source"],
                                             "targetUrn": e["target"], "edgeType": e["type"]})
        return delta

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids, kind="node",
                               as_of_seq=None):
        if kind != "edge":
            return await super().overlay_payloads(graph_id=graph_id, branch_id=branch_id,
                                                  entity_ids=entity_ids, kind=kind)
        return [{"id": eid, "sourceUrn": self.edges[eid]["source"],
                 "targetUrn": self.edges[eid]["target"], "edgeType": self.edges[eid]["type"],
                 "properties": self.edges[eid].get("properties") or {}}
                for eid in entity_ids if eid in self.edges]


def _rel_draft() -> RelDraft:
    """A draft that changes one relationship, removes one, adds one — and changes the one to
    the entity outside the view, which stays out."""
    draft = RelDraft()
    draft.commit({}, add_edges=[
        {**_edge("c1", "c3", "FLOWS_TO"), "properties": {"mode": "stream", "lag": 9}},
        {**_edge("c3", "c1", "FLOWS_TO"), "properties": {"mode": "batch", "since": 2024}},
        {**_edge("c1", "x1", "FLOWS_TO"), "properties": {"mode": "yyy"}},
    ], drop_edges=[_edge("c2", "c3", "FLOWS_TO")])
    return draft


async def test_the_relationship_catalog_is_the_drafts():
    draft, main = _rel_draft(), RelMain()
    out = await _overlay(draft, main).deep_search_catalog(SCOPE, context=CONTEXT, wait_ms=2000,
                                                         subject="relationships")
    truth = _rel_stats(list(draft.nodes.values()), list(draft.edges.values()), SCOPE)
    want = answer_of(truth, Session("t", "t", "1", None, 0, [], [], 1, status=COMPLETE,
                                    count=sum(truth.entities.values())),
                     CONTEXT, subject="relationships")
    assert out["status"] == "complete" and out["subject"] == "relationships"
    assert out["entities"] == want["entities"]
    assert out["entityTypes"] == want["entityTypes"]
    got = {p["key"]: p for p in out["properties"]}
    assert set(got) == {p["key"] for p in want["properties"]} == {"mode", "lag", "since"}
    for p in want["properties"]:
        for field in ("count", "byEntityType", "kinds", "distinct", "values"):
            assert got[p["key"]][field] == p[field], (p["key"], field)
    # "owner" went with the removed relationship; "zzz" and "yyy" are outside the view.
    assert {v["value"] for v in got["mode"]["values"]} == {"stream", "batch"}
    # Main's side was read between each relationship's ends, never by its id.
    assert main.between and all(isinstance(p, tuple) for part in main.between for p in part)


async def test_a_relationship_catalog_of_a_draft_too_large_is_mains_said_so(monkeypatch):
    monkeypatch.setattr(vconfig, "DRAFT_SEARCH_MAX_DELTA", 1)
    out = await _overlay(_rel_draft(), RelMain()).deep_search_catalog(
        SCOPE, context=CONTEXT, wait_ms=2000, subject="relationships")
    assert draft_search.TOO_LARGE_RELATIONSHIP_CATALOG.format(n=1) in out["notes"]
    assert {p["key"] for p in out["properties"]} == {"mode", "lag", "owner"}
