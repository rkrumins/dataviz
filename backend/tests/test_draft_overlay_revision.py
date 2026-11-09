"""The published graph as it was at a past revision, read through the overlay — no database.

A revision is ``main``'s store at its head with the patch set of everything main changed since put
back over it (``GraphVersioningService.revision_overlay_delta``): what changed is loaded as it was
then, what was made since is gone, and what was deleted since is back. Its delta is a line of its
own per revision, extended when the head moves; its ancestors are walked at the revision; its reads
take the store's admission slots. It never answers from the graph as it is now — Advanced Search
and rolled-up traces refuse (name search and closures walk its own reads) — and it is read-only. A rollup under containment that moved since says it may be stale.
"""
import asyncio
import itertools

import pytest

from backend.app.providers.draft_overlay_provider import DraftOverlayProvider
from backend.app.services.versioning.errors import RevisionReadOnly, RevisionUnsupported
from backend.common.models.graph import AggregatedEdgeResult, GraphEdge, GraphNode, NodeQuery

_GRAPHS = itertools.count()


def _n(urn, name=None):
    return GraphNode(urn=urn, entityType="Table", displayName=name or urn)


class Head:
    """main's store at its head: what it holds now."""
    name = "head-store"
    manager_cache_key = ("prov", "key")

    def __init__(self):
        self.nodes = {u: _n(u, f"{u} now") for u in ("A", "N", "S", "T1", "T2", "C")}

    def set_containment_edge_types(self, *a, **k):
        pass

    async def get_node(self, urn):
        return self.nodes.get(urn)

    async def get_nodes(self, query: NodeQuery):
        return [self.nodes[u] for u in (query.urns or []) if u in self.nodes]

    async def get_aggregated_edges_between(self, *a, **k):
        return AggregatedEdgeResult(aggregatedEdges=[], totalSourceEdges=0)


#: main as it was at the revision, for what changed since.
THEN = {"eA": {"urn": "A", "entityType": "Table", "displayName": "A then"},
        "eD": {"urn": "D", "entityType": "Table", "displayName": "D then"}}


def _patch(*, moved=False):
    """Since the revision main renamed A, made N and deleted D (and its link under S); with
    ``moved``, it also moved C from T1 to T2."""
    edges = [{"id": "kD", "sourceUrn": "S", "targetUrn": "D", "edgeType": "CONTAINS", "lazy": True}]
    if moved:
        edges.append({"id": "kC", "sourceUrn": "T1", "targetUrn": "C", "edgeType": "CONTAINS",
                      "lazy": True,
                      "was": {"sourceUrn": "T2", "targetUrn": "C", "edgeType": "CONTAINS"}})
    return {"nodesUpsert": [{"urn": "D", "entityId": "eD", "entityType": "Table",
                             "displayName": "D", "qualifiedName": None, "lazy": True}],
            "nodesNew": ["D"], "nodesModified": [{"entityId": "eA", "urn": "A"}],
            "nodesRemove": [{"entityId": "eN", "urn": "N"}],
            "edgesUpsert": edges, "edgesRemove": []}


class Svc:
    """``revision_overlay_delta`` and the values a read loads, recording what each was asked."""

    def __init__(self, patch):
        self.patch = patch
        self.deltas = []
        self.loads = []

    async def revision_overlay_delta(self, *, graph_id, as_of_seq, head_seq, extend=None):
        self.deltas.append({"as_of_seq": as_of_seq, "head_seq": head_seq, "extend": extend})
        return {**self.patch, "since": {"asOf": as_of_seq, "head": head_seq}}

    async def branch_overlay_delta(self, **kw):
        raise AssertionError("main's head index is all of it: a revision never asks for it")

    async def overlay_version(self, **kw):
        raise AssertionError("a revision's version is given, never read")

    async def overlay_payloads(self, *, graph_id, branch_id, entity_ids, kind="node",
                               as_of_seq=None):
        self.loads.append((kind, list(entity_ids), as_of_seq))
        return [] if kind == "edge" else [THEN[e] for e in entity_ids if e in THEN]


def _revision(svc, *, seq=3, head=9, gid=None, base=None):
    p = DraftOverlayProvider(base or Head(), svc=svc, graph_id=gid or f"g{next(_GRAPHS)}",
                             branch_id="main", as_of_seq=seq, version=("rev", seq, head),
                             read_ns=f"rev{seq}@{head}:{head}:ok")
    p.set_containment_edge_types(["CONTAINS"])
    return p


def test_a_revision_is_keyed_by_its_version():
    with pytest.raises(ValueError):
        DraftOverlayProvider(Head(), svc=Svc(_patch()), graph_id="g", branch_id="main", as_of_seq=3)
    with pytest.raises(ValueError):
        DraftOverlayProvider(Head(), svc=Svc(_patch()), graph_id="g", branch_id="main",
                             as_of_seq=3, version=("v", 3, 9))


def test_a_revision_reads_main_as_it_was_then():
    svc = Svc(_patch())
    p = _revision(svc)

    async def run():
        return [await p.get_node(u) for u in ("A", "N", "D", "S")]

    a, n, d, s = asyncio.run(run())
    assert a.display_name == "A then"            # changed since: its value then
    assert n is None                             # made since: not there yet
    assert d.display_name == "D then"            # deleted since: back
    assert s.display_name == "S now"             # untouched: the store's, as it is
    # One patch set, of this revision against the head the version names; values load as of then.
    assert svc.deltas == [{"as_of_seq": 3, "head_seq": 9, "extend": None}]
    assert {seq for _k, _ids, seq in svc.loads} == {3}
    # Its ancestors are walked at the revision, and its reads take the store's slots.
    assert p._writer._as_of == 3
    assert p.manager_cache_key == ("prov", "key")
    assert p.physical_graph_id().endswith("|rev3@9:9:ok")


def test_two_revisions_keep_two_patch_sets_and_one_follows_the_head():
    svc = Svc(_patch())
    gid = f"g{next(_GRAPHS)}"

    async def run():
        for seq in (3, 5, 3):                    # the second read of 3 is served from its line
            await _revision(svc, seq=seq, gid=gid).get_node("A")
        await _revision(svc, seq=3, head=12, gid=gid).get_node("A")

    asyncio.run(run())
    assert [(c["as_of_seq"], c["head_seq"]) for c in svc.deltas] == [(3, 9), (5, 9), (3, 12)]
    # The head moved: revision 3's patch set at head 9 is extended, not built again.
    assert svc.deltas[0]["extend"] is None and svc.deltas[1]["extend"] is None
    assert svc.deltas[2]["extend"]["since"] == {"asOf": 3, "head": 9}


def test_a_draft_reads_take_no_store_slot_and_a_revision_does():
    draft = DraftOverlayProvider(Head(), svc=Svc(_patch()), graph_id="g", branch_id="d1")
    assert draft.manager_cache_key is None
    assert _revision(Svc(_patch())).manager_cache_key == ("prov", "key")


def test_a_revision_refuses_what_it_would_answer_from_the_graph_as_it_is_now():
    p = _revision(Svc(_patch()))

    async def refused(call):
        with pytest.raises(RevisionUnsupported) as exc:
            await call
        assert isinstance(exc.value, NotImplementedError)  # routes that answer one with 501 do
        assert exc.value.status_code == 501 and exc.value.detail["type"] == "revision_unsupported"

    async def run():
        await refused(p.search_nodes("x"))
        await refused(p.deep_search(None))
        await refused(p.deep_search_session(None, context=None))
        await refused(p.trace_at_level("A", 1, 1, 1, [], [], 10, 100))
        await refused(p.expand_aggregated("A", "B", None, [], [], 10, 100))

    asyncio.run(run())


def test_a_revision_is_read_only():
    p = _revision(Svc(_patch()))
    edge = GraphEdge(id="e", sourceUrn="A", targetUrn="S", edgeType="FLOWS")

    async def run():
        for call in (p.create_node(_n("Z")), p.create_edge(edge), p.update_edge("e", {}),
                     p.delete_edge("e"), p.save_custom_graph([], [])):
            with pytest.raises(RevisionReadOnly) as exc:
                await call
            assert exc.value.status_code == 409 and exc.value.detail["type"] == "revision_read_only"

    asyncio.run(run())


def test_a_rollup_says_it_may_be_stale_only_when_containment_moved_since():
    async def rollup(patch):
        return await _revision(Svc(patch)).get_aggregated_edges_between(
            ["T1"], None, None, ["CONTAINS"], ["FLOWS"])

    still = asyncio.run(rollup(_patch()))
    assert not still.stale and still.stale_reason is None
    moved = asyncio.run(rollup(_patch(moved=True)))
    assert moved.stale and moved.stale_reason == "revision_structure_moved"
