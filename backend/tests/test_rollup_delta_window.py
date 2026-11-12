"""A publish window's lineage-summary deltas, at any size (``_compute_rollup_deltas``).

Pins:
- A window with more edges than a page (a publish of millions) is read a page of edge ids at a
  time and maintained in place: no cap on its size hands it to the aggregation job, and it nets
  to what one read of the whole window would.
- Only a child that is there on both sides of the window has moved. Children the window created
  under a container, however many (a large import), are no move: their lineage is the window's
  own. A re-parented child's lineage from before the window leaves its old ancestors and joins
  the new ones, and lineage the window itself created under it counts once.
- A move whose subtree is past the cap is a restructure, and goes to the job.

Pure unit tests, on the fakes of ``test_versioning_rollup_canonical`` (4-level containment
chains a0⊃a1⊃a2⊃a3 and b0⊃b1⊃b2⊃b3) and ``test_projection_dedicated_rollups``.
"""
import asyncio
from types import SimpleNamespace

from backend.app.services.versioning import projection
from backend.app.services.versioning.projection import FalkorProjector
from backend.tests.test_projection_dedicated_rollups import _FLOWS, _Before, _in_source
from backend.tests.test_versioning_rollup_canonical import _Session, _deltas, _projector


def _contains(parent, child):
    return {"sourceEntityId": parent, "targetEntityId": child, "edgeType": "CONTAINS"}


def test_a_window_of_any_size_is_netted_a_page_at_a_time(monkeypatch):
    monkeypatch.setattr(projection.config, "PROJECTION_PAGE", 2)
    rows = [(f"e{i}", "create", _FLOWS) for i in range(5)]
    proj = _projector(_in_source, _Before({}))
    proj._svc.window = {eid: (op, payload) for eid, op, payload in rows}
    session = _Session(rows)
    paged = asyncio.run(proj._compute_rollup_deltas(session, SimpleNamespace(id="g1"), "main", 1, 2))
    assert session.pages == [["e0", "e1"], ["e2", "e3"], ["e4"]]
    assert paged and all(v["dw"] == 5 for v in paged.values()), paged
    monkeypatch.setattr(projection.config, "PROJECTION_PAGE", 1000)
    assert paged == _deltas(_projector(_in_source, _Before({})), rows)


def test_children_the_window_created_are_no_move(monkeypatch):
    monkeypatch.setattr(FalkorProjector, "_MOVE_EDGE_CAP", 2)
    created = [(f"c{i}", "create", _contains("a2", f"n{i}")) for i in range(5)]
    lineage = ("l1", "create", {"sourceEntityId": "n1", "targetEntityId": "b3", "edgeType": "FLOWS"})
    assert isinstance(_deltas(_projector(_in_source, _Before({})), created + [lineage]), dict)


def test_a_re_parented_childs_lineage_moves_and_the_windows_own_counts_once(monkeypatch):
    class _Moving(_Before):
        """a3 moves from a2 to b2 in the window (1, 2]; under it, ``e_old`` from before the window
        and ``e_new`` from the window, both a3 → b3."""

        async def _containment_parents_climb(self, s, gid, bid, node_ids, cset, as_of):
            self.parent["a3"] = "a2" if as_of <= 1 else "b2"
            return await super()._containment_parents_climb(s, gid, bid, node_ids, cset, as_of)

        async def _containment_descendants(self, s, gid, bid, roots, cont, seq, cap):
            return set(roots)

        async def _incident_live_edges(self, s, gid, bid, nodes, seq):
            return {"e_old": _FLOWS, "e_new": _FLOWS}

    pairs = _deltas(_projector(_in_source, _Moving({"c_old": _contains("a2", "a3"), "e_old": _FLOWS})),
                    [("c_old", "delete", None), ("c_new", "create", _contains("b2", "a3")),
                     ("e_new", "create", _FLOWS)])
    assert pairs[("urn:a2", "urn:b2")]["dw"] == -1       # e_old leaves a2's chain…
    assert pairs[("urn:b2", "urn:b3")]["dw"] == 2        # …for b2's, which e_new joins once


def test_only_a_move_past_the_cap_goes_to_the_job(monkeypatch):
    monkeypatch.setattr(FalkorProjector, "_MOVE_EDGE_CAP", 2)

    class _BigMove(_Before):
        async def _containment_descendants(self, s, gid, bid, roots, cont, seq, cap):
            return {f"d{i}" for i in range(cap)}

    assert _deltas(_projector(_in_source, _BigMove({})),
                   [("c1", "create", _contains("b2", "a3"))]) == "stale"
