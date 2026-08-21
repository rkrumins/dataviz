"""VersionedBranchProvider.trace_closure — the closure walk over a branch's
Postgres state (2026-08-20).

THE GAP THIS CLOSES (reported live as a 501): a draft/versioned data source
had no trace_closure at all — DraftOverlayProvider honestly raised
NotImplementedError when its base was this provider, so the Lens and the
native canvas trace were structurally dead on every versioned source.

Contract: one bounded, honest walk — no cursors are ever issued (a draft is
draft-scale; the whole flow ships in one response, the driver sees empty
frontiers and reads it as exhausted), truncation is said when the cap bites,
and containment ancestor chains ship so the canvas can nest participants.
"""
import asyncio

from backend.app.providers.versioned_branch_provider import VersionedBranchProvider


def _run(coro):
    return asyncio.run(coro)


class _FakeStateSvc:
    """In-memory stand-in for the versioning service's *_from_state reads.

    Graph under test (lineage L, containment C):

        P ⊃ F ⊃ c1          PU ⊃ u1        PD ⊃ d1
        u2 —L→ u1 —L→ c1 —L→ d1
    """

    NODES = {u: {"urn": u, "displayName": u, "entityType": "node", "properties": {}}
             for u in ["P", "F", "c1", "PU", "u1", "u2", "PD", "d1"]}
    EDGES = [
        {"id": "c:P>F", "sourceUrn": "P", "targetUrn": "F", "edgeType": "CONTAINS"},
        {"id": "c:F>c1", "sourceUrn": "F", "targetUrn": "c1", "edgeType": "CONTAINS"},
        {"id": "c:PU>u1", "sourceUrn": "PU", "targetUrn": "u1", "edgeType": "CONTAINS"},
        {"id": "c:PD>d1", "sourceUrn": "PD", "targetUrn": "d1", "edgeType": "CONTAINS"},
        {"id": "l:u2>u1", "sourceUrn": "u2", "targetUrn": "u1", "edgeType": "TRANSFORMS"},
        {"id": "l:u1>c1", "sourceUrn": "u1", "targetUrn": "c1", "edgeType": "TRANSFORMS"},
        {"id": "l:c1>d1", "sourceUrn": "c1", "targetUrn": "d1", "edgeType": "TRANSFORMS"},
    ]

    async def get_edges_from_state(self, *, graph_id, branch_id, as_of_seq,
                                   source_urns=None, target_urns=None, any_urns=None,
                                   edge_types=None, min_confidence=None,
                                   limit=100, offset=0):
        out = []
        for e in self.EDGES:
            if edge_types and e["edgeType"] not in edge_types:
                continue
            if source_urns is not None and e["sourceUrn"] not in source_urns:
                continue
            if target_urns is not None and e["targetUrn"] not in target_urns:
                continue
            if any_urns is not None and e["sourceUrn"] not in any_urns and e["targetUrn"] not in any_urns:
                continue
            out.append(dict(e))
        return out[offset:offset + limit]

    async def get_nodes_from_state(self, *, graph_id, branch_id, as_of_seq,
                                   urns=None, entity_types=None, search_query=None,
                                   limit=100, offset=0, containment_edge_types=None,
                                   include_child_count=True):
        rows = [dict(self.NODES[u]) for u in (urns or []) if u in self.NODES]
        return rows[offset:offset + limit]


def _provider() -> VersionedBranchProvider:
    return VersionedBranchProvider(_FakeStateSvc(), graph_id="g1", branch_id="b1")


def _closure(p, **over):
    kwargs = dict(
        urn="F", upstream_depth=25, downstream_depth=25,
        lineage_edge_types=["TRANSFORMS"], containment_edge_types=["CONTAINS"],
        max_nodes=2000, timeout_ms=10000,
    )
    kwargs.update(over)
    return _run(p.trace_closure(**kwargs))


def test_container_focus_walks_the_whole_flow_with_ancestors():
    r = _closure(_provider())
    urns = {n.urn for n in r.nodes}
    # Flow: c1 (the focus's lineage-bearing child) + u1, u2 upstream + d1 down.
    assert {"F", "c1", "u1", "u2", "d1"} <= urns
    # Ancestor chains ship so the canvas can nest: P, PU, PD.
    assert {"P", "PU", "PD"} <= urns
    assert {e.id for e in r.edges} == {"l:u2>u1", "l:u1>c1", "l:c1>d1"}
    assert len(r.containment_edges) >= 4
    assert "u1" in r.upstream_urns and "u2" in r.upstream_urns
    assert "d1" in r.downstream_urns
    assert r.truncated is False
    # Draft walks are one-shot: no cursors, no frontier.
    assert r.frontier_up == [] and r.frontier_down == []
    assert r.seed_cursor is None


def test_direction_depths_bound_the_walk():
    r = _closure(_provider(), upstream_depth=1, downstream_depth=0)
    urns = {n.urn for n in r.nodes}
    assert "u1" in urns
    assert "u2" not in urns      # 2 hops up — outside the depth
    assert "d1" not in urns      # downstream off
    assert {e.id for e in r.edges} == {"l:u1>c1"}


def test_max_nodes_cap_is_said_out_loud():
    r = _closure(_provider(), max_nodes=3)
    assert r.truncated is True
    assert r.truncation_reason == "max_nodes"


def test_continuation_cursors_are_a_safe_empty_page():
    # This provider never ISSUES cursors, so an arriving one (a client bug
    # or a cross-provider cache echo) is answered with an empty page, not
    # an error and not a duplicate walk.
    r = _closure(_provider(), after_cursor="e:5")
    assert r.nodes == [] and r.edges == []
    assert r.truncated is False


def test_a_capped_seed_descent_is_said_out_loud():
    """The seed descent collects the focus's containment descendants BEFORE the
    lineage walk starts. When `max_nodes` cuts it short, the response is a
    partial view of the focus — the lineage under the descendants it never
    reached was never walked. Silence there reads as "nothing more inside".

    `max_nodes=1` cuts the descent at the focus itself (P ⊃ F ⊃ c1).
    """
    r = _closure(_provider(), urn="P", max_nodes=1)

    assert r.seed_truncated is True
    assert r.truncated is True
    assert r.truncation_reason == "max_nodes"
    # And it is NOT resumable — this provider issues no cursors, so the client
    # must re-focus rather than page.
    assert r.seed_cursor is None


def test_an_uncapped_seed_descent_says_nothing():
    """The flag has to stay off for a descent that completed, or every draft
    trace would claim to be partial."""
    r = _closure(_provider(), urn="P")

    assert r.seed_truncated is False
