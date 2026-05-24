"""Unit tests for the cross-DB ontology resolver (kills the 501).

Pure projection logic — feeds the resolver an OntologyORM-shaped
object (no DB needed) and asserts the resulting OntologySpec contains
the right membership sets and containment/lineage classification.
"""
from __future__ import annotations

import json
from types import SimpleNamespace

from backend.app.services.graph_versioning.ontology_resolver import to_spec


def _orm(**overrides):
    """Build an OntologyORM-compatible fake. The resolver only reads
    string columns + JSON payloads, so a SimpleNamespace is enough."""
    defaults = {
        "id": "bp_test",
        "name": "Test",
        "containment_edge_types": "[]",
        "lineage_edge_types": "[]",
        "edge_type_metadata": "{}",
        "entity_type_definitions": "{}",
        "relationship_type_definitions": "{}",
        "is_published": True,
        "deleted_at": None,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


def test_rich_definitions_drive_membership_sets():
    orm = _orm(
        entity_type_definitions=json.dumps({
            "Dataset": {"name": "Dataset"},
            "Pipeline": {"name": "Pipeline"},
        }),
        relationship_type_definitions=json.dumps({
            "CONTAINS": {"name": "CONTAINS", "is_containment": True},
            "FLOWS_TO": {"name": "FLOWS_TO", "is_lineage": True},
        }),
    )
    spec = to_spec(orm)
    assert spec.entity_types == frozenset({"Dataset", "Pipeline"})
    assert spec.relationship_types == frozenset({"CONTAINS", "FLOWS_TO"})
    assert spec.containment_edge_types == frozenset({"CONTAINS"})
    assert spec.lineage_edge_types == frozenset({"FLOWS_TO"})


def test_camelCase_classification_flags_recognized():
    # The frontend writes camelCase keys; the resolver must accept both.
    orm = _orm(
        relationship_type_definitions=json.dumps({
            "CONTAINS": {"isContainment": True},
            "FLOWS_TO": {"isLineage": True},
        }),
    )
    spec = to_spec(orm)
    assert spec.containment_edge_types == frozenset({"CONTAINS"})
    assert spec.lineage_edge_types == frozenset({"FLOWS_TO"})


def test_legacy_flat_lists_used_when_definitions_empty():
    orm = _orm(
        containment_edge_types=json.dumps(["CONTAINS"]),
        lineage_edge_types=json.dumps(["FLOWS_TO", "READS"]),
    )
    spec = to_spec(orm)
    assert spec.relationship_types == frozenset({"CONTAINS", "FLOWS_TO", "READS"})
    assert spec.containment_edge_types == frozenset({"CONTAINS"})
    assert spec.lineage_edge_types == frozenset({"FLOWS_TO", "READS"})


def test_rich_definitions_fall_back_to_legacy_when_flags_absent():
    # An ontology whose definitions exist but lack is_containment /
    # is_lineage flags falls back to the flat legacy lists for the
    # classification (membership comes from the definitions).
    orm = _orm(
        relationship_type_definitions=json.dumps({
            "CONTAINS": {"name": "CONTAINS"},
            "FLOWS_TO": {"name": "FLOWS_TO"},
        }),
        containment_edge_types=json.dumps(["CONTAINS"]),
        lineage_edge_types=json.dumps(["FLOWS_TO"]),
    )
    spec = to_spec(orm)
    assert spec.relationship_types == frozenset({"CONTAINS", "FLOWS_TO"})
    assert spec.containment_edge_types == frozenset({"CONTAINS"})
    assert spec.lineage_edge_types == frozenset({"FLOWS_TO"})


def test_empty_ontology_yields_empty_spec_back_compat():
    spec = to_spec(_orm())
    assert spec.entity_types == frozenset()
    assert spec.relationship_types == frozenset()
    assert spec.containment_edge_types == frozenset()
    assert spec.lineage_edge_types == frozenset()


def test_malformed_json_does_not_raise():
    orm = _orm(
        containment_edge_types="not-json",
        lineage_edge_types="[1,2,",
        entity_type_definitions="{",
        relationship_type_definitions="]",
    )
    # Tolerant projection — degraded ontology yields an empty spec.
    spec = to_spec(orm)
    assert spec.entity_types == frozenset()
    assert spec.relationship_types == frozenset()


def test_disagreement_between_rich_and_legacy_logs_warning(caplog):
    import logging

    orm = _orm(
        relationship_type_definitions=json.dumps({
            "CONTAINS": {"is_containment": True},
            "FLOWS_TO": {"is_lineage": True},
        }),
        # Legacy disagrees: claims FLOWS_TO is containment, CONTAINS isn't.
        containment_edge_types=json.dumps(["FLOWS_TO"]),
        lineage_edge_types=json.dumps(["CONTAINS"]),
    )
    with caplog.at_level(logging.WARNING, logger="backend.app.services.graph_versioning.ontology_resolver"):
        spec = to_spec(orm)
    msgs = [r.message for r in caplog.records]
    assert any("disagree" in m and "containment" in m for m in msgs)
    assert any("disagree" in m and "lineage" in m for m in msgs)
    # Rich wins — gate against silent regression to legacy.
    assert spec.containment_edge_types == frozenset({"CONTAINS"})
    assert spec.lineage_edge_types == frozenset({"FLOWS_TO"})


def test_legacy_only_does_not_warn(caplog):
    import logging

    orm = _orm(
        containment_edge_types=json.dumps(["CONTAINS"]),
        lineage_edge_types=json.dumps(["FLOWS_TO"]),
    )
    with caplog.at_level(logging.WARNING, logger="backend.app.services.graph_versioning.ontology_resolver"):
        to_spec(orm)
    assert not any("disagree" in r.message for r in caplog.records)
