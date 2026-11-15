"""The lineage-summary cells the projector maintains between batch runs stay the cells the summaries
job would make, for shapes a window's deltas used to get wrong:

* a node whose urn changes keeps its cells, keyed by their ends' urns again (``aggKey``): the job
  merges a cell by it, so one left on the old urn became two;
* a retyped node's cells take its new type's level as ``sourceLevel``/``targetLevel``, as the job
  stamps them; a type with no level leaves them as they were;
* a key whose summaries regime cannot be read hands the window's cells to the job, rather than
  moving only the canonical subset of a cube key's cells;
* a flat ontology (lineage, no containment) never gets the raw ``(source, target)`` mirror cell the
  job does not store (``AGGREGATION_MATERIALIZE_LEAF_PAIRS``, off by default);
* a lineage edge ending on a container lands on the job's boundary cells: a container is one of its
  own reps (the job's ancestors-or-self of every containment parent), in a window's deltas and in
  a reconcile's plan, with the raw pair a boundary cell when both ends are containers; and a node
  that becomes a container has the lineage it ends recounted.
"""
from __future__ import annotations

import asyncio

from backend.app.services.versioning import projection, projection_reconcile
from backend.app.services.versioning.projection import FalkorProjector


class _Capture:
    """A FalkorDB key that answers every statement with no rows, recording each."""

    def __init__(self, fail_on=None):
        self.sent, self.fail_on = [], fail_on
        self.name = "gvt_parity"

    async def query(self, cypher, params=None, timeout=None):
        if self.fail_on and self.fail_on in cypher:
            raise ConnectionError("the node went away")
        self.sent.append((cypher, params or {}))
        return type("R", (), {"result_set": []})()

    ro_query = query


def _projector() -> FalkorProjector:
    return FalkorProjector(graph_client_factory=lambda *a: _Capture())


def test_a_rekeyed_node_keeps_its_cells_keyed_by_its_new_urn():
    client = _Capture()
    asyncio.run(_projector()._rekey_in_place(
        client, [("urn:a", "urn:a2", "Table"), ("urn:b", "urn:b", "Table")]))
    out_cells, in_cells = projection._aggkey_restamp("Table")
    sent = [(c, p) for c, p in client.sent if "AGGREGATED" in c]
    assert [c for c, _p in sent] == [out_cells, in_cells]
    assert all(p["urns"] == ["urn:a2"] for _c, p in sent), "only the node that moved"
    assert "SET r.aggKey = n.urn + '|' + b.urn" in out_cells
    assert "SET r.aggKey = a.urn + '|' + n.urn" in in_cells


def test_a_retyped_nodes_cells_take_its_new_types_level():
    client = _Capture()
    asyncio.run(_projector()._relabel_in_place(
        client, [("urn:t", "Table", "View"), ("urn:c", "Column", "Field")],
        levels={"View": 2, "Table": 2}))
    stamps = [(c, p) for c, p in client.sent if "AGGREGATED" in c]
    # View has a level: both directions stamped with it. Field has none: its stamps are left.
    assert [c for c, _p in stamps] == list(projection._level_restamp("View"))
    assert all((p["urns"], p["level"]) == (["urn:t"], 2) for _c, p in stamps)
    client = _Capture()
    asyncio.run(_projector()._relabel_in_place(client, [("urn:t", "Table", "View")]))
    assert not [c for c, _p in client.sent if "AGGREGATED" in c], "no level map, no stamps"


def test_a_key_whose_regime_cannot_be_read_hands_the_cells_to_the_job():
    pairs = {("urn:p", "urn:q"): {"dw": 1, "dwc": 1, "types": {"FLOWS"}}}
    client = _Capture(fail_on="RETURN m.regime")
    applied = asyncio.run(_projector()._apply_rollups(client, pairs, 3, 4))
    assert applied is False
    assert not [c for c, _p in client.sent if "AGGREGATED" in c], "no cell written"


def test_a_flat_ontology_gets_no_mirror_cell_unless_the_job_stores_one(monkeypatch):
    def pairs_for(mirror: bool):
        monkeypatch.setenv("AGGREGATION_MATERIALIZE_LEAF_PAIRS", "true" if mirror else "false")
        out = {}
        projection_reconcile._contribute(out, ("urn:s", "FLOWS", "urn:t"), +1, {},
                                         canonical=False, level_of=lambda _u: None)
        return out

    assert pairs_for(False) == {}
    assert set(pairs_for(True)) == {("urn:s", "urn:t")}


def _canonical(pairs) -> dict:
    return {k: (v["dw"], v.get("dwc")) for k, v in pairs.items() if v.get("dwc")}


def test_a_window_edge_ending_on_a_container_lands_on_the_jobs_boundary_cells():
    from backend.tests.test_versioning_rollup_canonical import _deltas
    from backend.tests.test_versioning_rollup_canonical import _projector as canonical_projector

    async def resolver(svc, gid):
        return (["CONTAINS"], ["FLOWS"])

    # a0>a1>a2>a3 and b0>b1>b2>b3: a2 and b2 are containers, a3 and b3 leaves.
    leaf_to_box = _deltas(canonical_projector(resolver), [
        ("e1", "create", {"sourceEntityId": "a3", "targetEntityId": "b2", "edgeType": "FLOWS"})])
    assert _canonical(leaf_to_box) == {
        ("urn:a0", "urn:b0"): (1, 1), ("urn:a1", "urn:b1"): (1, 1), ("urn:a2", "urn:b2"): (1, 1)}
    box_to_box = _deltas(canonical_projector(resolver), [
        ("e1", "create", {"sourceEntityId": "a2", "targetEntityId": "b2", "edgeType": "FLOWS"})])
    # The raw pair is a boundary cell (both ends containers), never a cube one.
    assert _canonical(box_to_box) == {
        ("urn:a0", "urn:b0"): (1, 1), ("urn:a1", "urn:b1"): (1, 1), ("urn:a2", "urn:b2"): (0, 1)}


def _big_box(children: int, dead: int = 0):
    """The chains of ``_Svc`` with b2 holding ``children`` more children, ``x0``…, after ``b3``.
    The first ``dead`` of b2's containment edges are deleted, ``b3``'s first. Each full read of a
    node's edges (``_incident_edge_ids``) is recorded."""
    from backend.tests.test_versioning_rollup_canonical import _Svc

    class _BigBox(_Svc):
        def __init__(self):
            super().__init__()
            self.full_reads = []
            for k in range(children):
                self.parent[f"x{k}"], self.types[f"x{k}"] = "b2", "lvl3"
            self.dead = (["ce_b3"] + [f"ce_x{k}" for k in range(children)])[:dead]

        async def _skeletons_at(self, s, gid, bid, ids, seq):
            out = await super()._skeletons_at(s, gid, bid, ids, seq)
            return {i: None if i in self.dead else p for i, p in out.items()}

        async def _incident_edge_ids(self, s, gid, bid, node_ids, **kw):
            self.full_reads.append(set(node_ids))
            return await super()._incident_edge_ids(s, gid, bid, node_ids, **kw)

    return _BigBox()


def test_a_large_container_is_known_for_one_from_a_few_of_its_children():
    from backend.tests.test_versioning_rollup_canonical import _deltas
    from backend.tests.test_versioning_rollup_canonical import _projector as canonical_projector

    async def resolver(svc, gid):
        return (["CONTAINS"], ["FLOWS"])

    edge = [("e1", "create", {"sourceEntityId": "a3", "targetEntityId": "b2", "edgeType": "FLOWS"})]
    boxed = {("urn:a0", "urn:b0"): (1, 1), ("urn:a1", "urn:b1"): (1, 1),
             ("urn:a2", "urn:b2"): (1, 1)}
    probe = projection._KIDS_PROBE
    # Far more children than are read: one of the first is live, so none other is read.
    svc = _big_box(children=3 * probe)
    assert _canonical(_deltas(canonical_projector(resolver, svc), edge)) == boxed
    assert svc.full_reads == []
    # Every row read is of a child deleted since: then all of them are, and a later one is live.
    svc = _big_box(children=3 * probe, dead=probe)
    assert _canonical(_deltas(canonical_projector(resolver, svc), edge)) == boxed
    assert svc.full_reads == [{"b2"}]
    # None of them live at all: not a container, as when every child was read.
    svc = _big_box(children=3 * probe, dead=3 * probe + 1)
    gone = _canonical(_deltas(canonical_projector(resolver, svc), edge))
    assert ("urn:a2", "urn:b2") not in gone and svc.full_reads == [{"b2"}], gone


def test_a_reconcile_lands_container_lineage_on_the_jobs_cells_and_recounts_a_new_container():
    contains = [("a0", "CONTAINS", "a1"), ("a1", "CONTAINS", "a2"),
                ("b0", "CONTAINS", "b1"), ("b1", "CONTAINS", "b2"), ("b2", "CONTAINS", "b3")]

    def plan(expected, actual):
        out = projection_reconcile.plan_rollup_deltas(
            expected, actual, lineage_types={"FLOWS"}, cont_types={"CONTAINS"}, canonical=True,
            cap=10_000, level_of=lambda _u: None)
        return {k: v.get("dwc") for k, v in out.pairs.items() if v.get("dwc")}

    # A new lineage edge from a2 (a leaf: nothing under it yet) to the container b2.
    lineage = [("a2", "FLOWS", "b2")]
    assert plan(contains + lineage, contains) == {
        ("a0", "b0"): 1, ("a1", "b1"): 1, ("a1", "b2"): 1}
    # a2 gains its first child: it becomes one of its own reps, and its lineage moves cells.
    grown = contains + [("a2", "CONTAINS", "a3")]
    assert plan(grown + lineage, contains + lineage) == {("a1", "b2"): -1, ("a2", "b2"): 1}
