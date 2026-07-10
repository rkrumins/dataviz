"""The ontology authoring case guard rejects genuine duplicate TYPE DECLARATIONS
(two def ids differing only by case) but must NOT reject a well-formed ontology
just because its containment/lineage REFERENCE lists spell a type in a different
case than its declared id — those lists are references, reconciled in place.
"""
import os
import sys
from types import SimpleNamespace

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from fastapi import HTTPException

from backend.app.api.v1.endpoints.ontologies import (
    _normalize_edge_type_references,
    _reject_case_insensitive_type_dupes,
)


def _req(entity=None, rel=None, containment=None, lineage=None):
    return SimpleNamespace(
        entity_type_definitions=entity,
        relationship_type_definitions=rel,
        containment_edge_types=containment,
        lineage_edge_types=lineage,
    )


# ── The guard: uniqueness over declared type ids only ────────────────────────

def test_consistent_mixed_case_ontology_is_accepted():
    # The exact state the (fixed) frontend produces: declared ids in their own casing,
    # reference lists matching. Previously the union-with-lists check 422'd this.
    _reject_case_insensitive_type_dupes(_req(
        entity={"Roots": {}, "Node": {}},
        rel={"Has": {}, "Flows_To": {}},
        containment=["Has"], lineage=["Flows_To"]))  # must not raise


def test_reference_list_case_drift_is_not_a_collision():
    # containment references 'HAS' while the declared id is 'Has' — a reference spelling,
    # not a second type. Must not be rejected (normalization reconciles it).
    _reject_case_insensitive_type_dupes(_req(
        rel={"Has": {}}, containment=["HAS"]))  # must not raise


def test_duplicate_relationship_declarations_rejected():
    with pytest.raises(HTTPException) as e:
        _reject_case_insensitive_type_dupes(_req(rel={"Has": {}, "HAS": {}}))
    assert e.value.status_code == 422


def test_duplicate_entity_declarations_rejected():
    with pytest.raises(HTTPException) as e:
        _reject_case_insensitive_type_dupes(_req(entity={"Node": {}, "NODE": {}}))
    assert e.value.status_code == 422


# ── Normalization: reconcile reference lists to declared casing ──────────────

def test_normalize_rewrites_and_dedupes_to_declared_casing():
    req = _req(rel={"HAS": {}, "FLOWS_TO": {}},
               containment=["Has", "HAS"], lineage=["flows_to"])
    _normalize_edge_type_references(req)
    assert req.containment_edge_types == ["HAS"]      # both variants → declared, deduped
    assert req.lineage_edge_types == ["FLOWS_TO"]


def test_normalize_noop_without_relationship_defs():
    req = _req(containment=["Has"])  # partial update, no rel defs to reconcile against
    _normalize_edge_type_references(req)
    assert req.containment_edge_types == ["Has"]      # untouched


def test_normalize_preserves_unmatched_reference():
    req = _req(rel={"HAS": {}}, containment=["HAS", "OWNS"])  # OWNS matches nothing
    _normalize_edge_type_references(req)
    assert req.containment_edge_types == ["HAS", "OWNS"]


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__, "-q"]))
