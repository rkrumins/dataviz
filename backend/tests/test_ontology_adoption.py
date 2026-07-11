"""Unit tests for the ontology-adoption classifier (backend/app/ontology/adoption.py).

Adoption compares an ontology's DECLARED types against a data source's PHYSICAL
(profiled) types, classifying each physical type as exact / case-drift / unmapped
so the UI can show "are we hitting FalkorDB labels/indices correctly". The
classifier is pure — driven by declared-id sets + (id, count) physical stats.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.ontology.adoption import classify_dimension, build_source_adoption


def _phys(*pairs):
    return [{"id": i, "count": c} for i, c in pairs]


# ── classify_dimension ───────────────────────────────────────────────────────

def test_exact_match():
    d = classify_dimension({"HAS", "FLOWS_TO"}, _phys(("HAS", 100), ("FLOWS_TO", 40)))
    assert {e.id for e in d.exact} == {"HAS", "FLOWS_TO"}
    assert d.case_drift == [] and d.unmapped == []
    assert d.match_weighted == 100.0 and d.match_by_type == 100.0
    assert d.total_types == 2 and d.total_instances == 140


def test_case_drift_is_not_exact_and_names_the_declared_spelling():
    d = classify_dimension({"HAS"}, _phys(("has", 50)))
    assert d.exact == []
    assert len(d.case_drift) == 1
    assert d.case_drift[0].id == "has" and d.case_drift[0].declared == "HAS" and d.case_drift[0].count == 50
    # drift is present-but-wrong-case → NOT counted as matched
    assert d.match_weighted == 0.0 and d.match_by_type == 0.0


def test_unmapped_type():
    d = classify_dimension({"HAS"}, _phys(("WIDGET", 30)))
    assert [u.id for u in d.unmapped] == ["WIDGET"]
    assert d.exact == [] and d.case_drift == []


def test_instance_weighting_vs_by_type():
    # HAS exact (900 instances), has drift, WIDGET unmapped (100 instances)
    d = classify_dimension({"HAS"}, _phys(("HAS", 900), ("WIDGET", 100)))
    # weighted: 900 exact instances / 1000 total = 90%; by-type: 1 exact / 2 types = 50%
    assert d.match_weighted == 90.0
    assert d.match_by_type == 50.0


def test_declared_unused_surfaced():
    d = classify_dimension({"HAS", "FLOWS_TO", "OWNS"}, _phys(("HAS", 10)))
    assert set(d.declared_unused) == {"FLOWS_TO", "OWNS"}


def test_empty_physical_is_vacuously_full():
    d = classify_dimension({"HAS"}, [])
    assert d.match_weighted == 100.0 and d.match_by_type == 100.0
    assert d.total_types == 0 and d.total_instances == 0


# ── build_source_adoption (entity + edge dimensions + combined) ──────────────

def test_build_source_adoption_combines_dimensions_weighted():
    schema_stats = {
        "entityTypeStats": [{"id": "Roots", "count": 3}, {"id": "Node", "count": 97}],
        "edgeTypeStats": [{"id": "HAS", "count": 400}, {"id": "flows_to", "count": 100}],
    }
    src = build_source_adoption(
        entity_ids={"Roots", "Node"}, edge_ids={"HAS", "FLOWS_TO"}, schema_stats=schema_stats)
    # entities all exact (100 instances); edges: HAS exact (400), flows_to drift (100)
    assert src.nodes.match_weighted == 100.0
    assert src.edges.match_weighted == 80.0            # 400 / 500
    # combined instance-weighted: (100 + 400) exact / (100 + 500) total = 500/600 = 83.3
    assert round(src.match_weighted, 1) == 83.3


def test_build_source_adoption_flags_case_drift_edge():
    schema_stats = {"entityTypeStats": [], "edgeTypeStats": [{"id": "flows_to", "count": 5}]}
    src = build_source_adoption(entity_ids=set(), edge_ids={"FLOWS_TO"}, schema_stats=schema_stats)
    assert src.edges.case_drift[0].id == "flows_to"
    assert src.edges.case_drift[0].declared == "FLOWS_TO"


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
