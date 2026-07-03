"""validate_entities_rich(): the rich commit-boundary ontology gate.

Pure-function tests pinning the contract shared with ``mutation_validator``:
entity types must be defined (case-insensitive), edge source/target entity-type
compatibility, containment ``can_contain`` (empty = unrestricted), CREATES only
(updates/deletes always pass), and the ``{entity_id, kind, reason, rule}``
violation shape (a superset of the legacy shape).
"""
from backend.app.services.versioning.ontology import (
    EdgeRule, EntityRule, OntologyRules, validate_entities_rich,
)

RULES = OntologyRules(
    entity_types={
        "System": EntityRule(can_contain=frozenset({"Dataset"})),
        "Dataset": EntityRule(can_contain=frozenset({"Column"})),
        "Column": EntityRule(),                       # empty can_contain = unrestricted
    },
    edge_types={
        "CONTAINS": EdgeRule(is_containment=True),    # endpoint types via can_contain
        "FLOWS_TO": EdgeRule(source_types=frozenset({"Dataset"}),
                             target_types=frozenset({"Dataset"})),
        "TAGS": EdgeRule(),                           # unrestricted endpoints
    },
    containment_edge_types=frozenset({"CONTAINS"}),
)

TYPES = {"sys1": "System", "ds1": "Dataset", "ds2": "Dataset", "col1": "Column"}


def _edge(eid, src, tgt, etype):
    return (eid, "edge", {"edgeType": etype, "sourceEntityId": src, "targetEntityId": tgt},
            "create")


def test_no_rules_or_no_creates_passes():
    assert validate_entities_rich([_edge("e", "ds1", "ds2", "FLOWS_TO")], {}, None) == []
    assert validate_entities_rich(
        [("n", "node", {"entityType": "Nope"}, "update"),
         ("n2", "node", None, "delete")], {}, RULES) == []


def test_unknown_entity_type_rejected_and_case_insensitive_accepted():
    viol = validate_entities_rich(
        [("n1", "node", {"entityType": "Widget"}, "create")], {}, RULES)
    assert len(viol) == 1
    assert viol[0]["rule"] == "unknown_entity_type"
    assert viol[0]["entity_id"] == "n1" and viol[0]["kind"] == "node" and viol[0]["reason"]
    assert validate_entities_rich(
        [("n2", "node", {"entityType": "DATASET"}, "create")], {}, RULES) == []


def test_unknown_edge_type_rejected():
    viol = validate_entities_rich([_edge("e1", "ds1", "ds2", "MYSTERY")], TYPES, RULES)
    assert [v["rule"] for v in viol] == ["unknown_edge_type"]


def test_edge_source_and_target_compatibility():
    assert validate_entities_rich([_edge("ok", "ds1", "ds2", "FLOWS_TO")], TYPES, RULES) == []
    viol = validate_entities_rich([_edge("bad", "sys1", "col1", "FLOWS_TO")], TYPES, RULES)
    assert sorted(v["rule"] for v in viol) == ["invalid_source", "invalid_target"]


def test_containment_can_contain_enforced_and_empty_is_unrestricted():
    assert validate_entities_rich([_edge("ok", "ds1", "col1", "CONTAINS")], TYPES, RULES) == []
    viol = validate_entities_rich([_edge("bad", "sys1", "col1", "CONTAINS")], TYPES, RULES)
    assert [v["rule"] for v in viol] == ["containment_not_allowed"]
    # Column has empty can_contain → may contain anything known.
    assert validate_entities_rich([_edge("ok2", "col1", "ds1", "CONTAINS")], TYPES, RULES) == []


def test_unresolvable_endpoint_skips_that_check():
    # Target type unknown to the caller → only the source side is judged.
    assert validate_entities_rich(
        [_edge("e", "ds1", "ghost", "FLOWS_TO")], {"ds1": "Dataset"}, RULES) == []
    viol = validate_entities_rich(
        [_edge("e2", "ghost", "col1", "FLOWS_TO")], {"col1": "Column"}, RULES)
    assert [v["rule"] for v in viol] == ["invalid_target"]


def test_unrestricted_edge_type_allows_any_endpoints():
    assert validate_entities_rich([_edge("e", "sys1", "col1", "TAGS")], TYPES, RULES) == []


def test_edge_updates_and_deletes_never_gated():
    assert validate_entities_rich(
        [("e1", "edge", {"edgeType": "MYSTERY", "sourceEntityId": "sys1",
                         "targetEntityId": "col1"}, "update"),
         ("e2", "edge", None, "delete")], TYPES, RULES) == []
