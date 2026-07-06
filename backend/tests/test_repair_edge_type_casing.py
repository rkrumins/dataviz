"""plan_edge_repairs(): the pure decision logic of the edge-type casing repair script.

Verifies: a case variant of a declared type is rewritten to the declared casing; an already
canonical edge is left alone; an unknown type is left for a human; a missing edgeType is
reported (not guessed) unless --infer-containment and the endpoints form the sole declared
containment pair.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))

from backend.app.services.versioning.ontology import EntityRule, EdgeRule, OntologyRules
from backend.scripts.repair_edge_type_casing import plan_edge_repairs

RULES = OntologyRules(
    entity_types={
        "Layer": EntityRule(can_contain=frozenset({"Object"})),
        "Object": EntityRule(),
    },
    edge_types={"HAS": EdgeRule(is_containment=True), "FLOWS_TO": EdgeRule()},
    containment_edge_types=frozenset({"HAS"}),
    edge_type_canonical={"HAS": "HAS", "FLOWS_TO": "FLOWS_TO"},
)

NODES = {"L1": {"entityType": "Layer"}, "O1": {"entityType": "Object"}}


def _edge(edt, src="L1", tgt="O1"):
    return {"edgeType": edt, "sourceEntityId": src, "targetEntityId": tgt}


def test_case_variant_rewritten_to_declared_casing():
    ops, missing, single = plan_edge_repairs(
        {"e1": _edge("has"), "e2": _edge("HaS")}, NODES, RULES)
    assert missing == [] and single == "HAS"
    assert {o["entity_id"] for o in ops} == {"e1", "e2"}
    assert all(o["payload"]["edgeType"] == "HAS" and o["op"] == "update" for o in ops)
    # endpoints preserved on the update payload
    assert ops[0]["payload"]["sourceEntityId"] == "L1"


def test_already_canonical_and_unknown_left_untouched():
    ops, missing, _ = plan_edge_repairs(
        {"ok": _edge("HAS"), "mystery": _edge("owns")}, NODES, RULES)
    assert ops == [] and missing == []


def test_missing_edge_type_reported_not_guessed_by_default():
    ops, missing, _ = plan_edge_repairs(
        {"m": {"sourceEntityId": "L1", "targetEntityId": "O1"}}, NODES, RULES)
    assert ops == []
    assert len(missing) == 1 and missing[0]["inferred"] is None
    assert missing[0]["source_type"] == "Layer" and missing[0]["target_type"] == "Object"


def test_infer_containment_sets_single_type_on_valid_pair():
    ops, missing, single = plan_edge_repairs(
        {"m": {"sourceEntityId": "L1", "targetEntityId": "O1"}}, NODES, RULES,
        infer_containment=True)
    assert single == "HAS"
    assert len(ops) == 1 and ops[0]["payload"]["edgeType"] == "HAS"
    assert missing[0]["inferred"] == "HAS"


def test_infer_containment_skips_invalid_pair():
    # Object cannot contain Layer (Object.can_contain is empty → nothing allowed).
    ops, missing, _ = plan_edge_repairs(
        {"m": {"sourceEntityId": "O1", "targetEntityId": "L1"}}, NODES, RULES,
        infer_containment=True)
    assert ops == [] and missing[0]["inferred"] is None


def test_infer_disabled_when_multiple_containment_types():
    rules = OntologyRules(
        entity_types={"Layer": EntityRule(can_contain=frozenset({"Object"})), "Object": EntityRule()},
        edge_types={"HAS": EdgeRule(is_containment=True), "OWNS": EdgeRule(is_containment=True)},
        containment_edge_types=frozenset({"HAS", "OWNS"}),
        edge_type_canonical={"HAS": "HAS", "OWNS": "OWNS"},
    )
    ops, missing, single = plan_edge_repairs(
        {"m": {"sourceEntityId": "L1", "targetEntityId": "O1"}}, NODES, rules,
        infer_containment=True)
    assert single is None and ops == [] and missing[0]["inferred"] is None
