"""validate_entities_rich(): the rich commit-boundary ontology gate.

Pure-function tests pinning the contract shared with ``mutation_validator``:
entity types must be defined (case-insensitive), edge source/target entity-type
compatibility, containment ``can_contain`` (empty = unrestricted), CREATES only
(updates/deletes always pass), and the ``{entity_id, kind, reason, rule}``
violation shape (a superset of the legacy shape).
"""
from backend.app.services.versioning.ontology import (
    EdgeRule, EntityRule, OntologyRules, canonicalize_payload_types,
    validate_entities_rich,
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


def test_missing_edge_type_rejected_under_strict():
    # A create edge with no/empty edgeType can't be typed against a declared schema → rejected
    # with a clear, distinct reason. Normalization can't help (there is nothing to canonicalize).
    for payload in ({"sourceEntityId": "ds1", "targetEntityId": "ds2"},
                    {"edgeType": "", "sourceEntityId": "ds1", "targetEntityId": "ds2"},
                    {"edgeType": "   ", "sourceEntityId": "ds1", "targetEntityId": "ds2"}):
        viol = validate_entities_rich([("e", "edge", payload, "create")], TYPES, RULES)
        assert [v["rule"] for v in viol] == ["missing_edge_type"], payload
        assert "missing edgeType" in viol[0]["reason"]
    # An unconstrained schema (no declared edge types) leaves a missing edgeType open.
    open_rules = OntologyRules(entity_types={"Dataset": EntityRule()})
    assert validate_entities_rich(
        [("e", "edge", {"sourceEntityId": "ds1", "targetEntityId": "ds2"}, "create")],
        TYPES, open_rules) == []


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


# --------------------------------------------------------------------------- #
# canonicalize_payload_types(): case-insensitive normalization to declared casing.
# USER MANDATE 2026-07-06 — a case variant of a declared type must NEVER fail; it is
# rewritten to the ontology's exact declared spelling at the commit boundary.
# --------------------------------------------------------------------------- #

# Declared-casing map (as resolved_ontology_to_rules builds it): UPPER → declared.
# edge-type keys are UPPER(declared id); edge_type_canonical maps UPPER → declared
# (exactly as resolved_ontology_to_rules builds it — "FlowsTo".upper() == "FLOWSTO").
MIXED = OntologyRules(
    entity_types={"System": EntityRule(), "Dataset": EntityRule()},
    edge_types={"HAS": EdgeRule(is_containment=True), "FLOWSTO": EdgeRule()},
    containment_edge_types=frozenset({"HAS"}),
    edge_type_canonical={"HAS": "Has", "FLOWSTO": "FlowsTo"},
)


def test_canonicalize_edge_type_to_declared_casing():
    for variant in ("has", "HAS", "Has", "hAs"):
        p = {"edgeType": variant, "sourceEntityId": "a", "targetEntityId": "b"}
        canonicalize_payload_types(p, MIXED)
        assert p["edgeType"] == "Has", variant


def test_canonicalize_entity_type_to_declared_casing():
    for variant in ("dataset", "DATASET", "DataSet"):
        p = {"entityType": variant}
        canonicalize_payload_types(p, MIXED)
        assert p["entityType"] == "Dataset", variant


def test_canonicalize_uppercase_fallback_when_no_declared_map():
    # RULES has edge_types keyed UPPERCASE and no edge_type_canonical → normalize to UPPER.
    p = {"edgeType": "contains", "sourceEntityId": "a", "targetEntityId": "b"}
    canonicalize_payload_types(p, RULES)
    assert p["edgeType"] == "CONTAINS"


def test_canonicalize_declared_casing_preserved_verbatim():
    p = {"edgeType": "Has", "entityType": None}
    canonicalize_payload_types(p, MIXED)
    assert p["edgeType"] == "Has"


def test_canonicalize_leaves_unknown_and_missing_untouched():
    p = {"edgeType": "mystery", "sourceEntityId": "a", "targetEntityId": "b"}
    canonicalize_payload_types(p, MIXED)
    assert p["edgeType"] == "mystery"                 # unknown → left for the gate
    node = {"entityType": "Widget"}
    canonicalize_payload_types(node, MIXED)
    assert node["entityType"] == "Widget"
    empty = {"sourceEntityId": "a", "targetEntityId": "b"}   # no type fields
    canonicalize_payload_types(empty, MIXED)
    assert empty == {"sourceEntityId": "a", "targetEntityId": "b"}


def test_canonicalize_is_idempotent_and_noop_without_rules():
    p = {"edgeType": "has", "sourceEntityId": "a", "targetEntityId": "b"}
    canonicalize_payload_types(p, MIXED)
    once = dict(p)
    canonicalize_payload_types(p, MIXED)
    assert p == once and p["edgeType"] == "Has"
    q = {"edgeType": "has"}
    canonicalize_payload_types(q, None)              # no rules → untouched
    canonicalize_payload_types(None, MIXED)          # tombstone payload → no crash
    assert q["edgeType"] == "has"


def test_canonical_edge_type_matches_containment_and_lineage_lists():
    assert MIXED.canonical_edge_type("HAS") == "Has"
    assert MIXED.canonical_edge_type("flowsto") == "FlowsTo"
    assert MIXED.canonical_edge_type("nope") is None


# --------------------------------------------------------------------------- #
# Field rules: a property's type, its allowed values, whether it is required —  #
# judged at publish on what the publish changes (field_violations).            #
# --------------------------------------------------------------------------- #

def _fields_rules():
    from backend.app.ontology.models import FieldData
    from backend.app.ontology.rules import field_rules
    return field_rules([
        FieldData(id="name", name="Name", type="string", required=True),       # the entity's name
        FieldData(id="description", name="Description", required=True),        # a reserved node key
        FieldData(id="owner", name="Owner", type="string", required=True),
        FieldData(id="tier", name="Tier", type="status", allowed_values=["gold", "silver"]),
        FieldData(id="hint", name="Hint", type="status", allowed_values=["a"], allow_other=True),
        FieldData(id="rows", name="Rows", type="number"),
        FieldData(id="note", name="Note", type="markdown"),                     # nothing to judge
    ])


def test_field_rules_are_the_property_fields_with_something_to_judge():
    rules = _fields_rules()
    assert sorted(rules) == ["owner", "rows", "tier"]
    assert rules["tier"].allowed == ("gold", "silver") and rules["owner"].required
    assert rules["rows"].type == "number" and rules["rows"].name == "Rows"


def test_resolved_ontology_threads_allowed_values_into_the_rules():
    from backend.app.ontology.resolver import parse_entity_definitions
    from backend.app.ontology.rules import resolved_ontology_to_rules
    from backend.app.ontology.models import ResolvedOntology
    defs = parse_entity_definitions({"Table": {"name": "Table", "fields": [
        {"id": "tier", "name": "Tier", "type": "status", "allowed_values": ["gold", 2, " ", "gold", True]},
        {"id": "code", "name": "Code", "unique": True, "format": {"prefix": "#"}},
    ]}})
    assert defs["Table"].fields[0].allowed_values == ["gold", "2", "true"]
    assert defs["Table"].fields[1].format == {"prefix": "#"}
    rules = resolved_ontology_to_rules(ResolvedOntology(entity_type_definitions=defs))
    assert rules.entity_types["Table"].fields["tier"].allowed == ("gold", "2", "true")
    assert rules.entity_types["Table"].unique_fields == frozenset({"code"})


def test_a_value_is_judged_by_its_type_leniently_where_the_data_is():
    from backend.app.services.versioning.ontology import FieldRule, field_value_problem
    num, flag, day = FieldRule(type="number", name="Rows"), FieldRule(type="boolean"), FieldRule(type="date")
    assert field_value_problem(num, 3) is None and field_value_problem(num, "1,200") is None   # a CSV's text
    assert field_value_problem(num, "many")[0] == "field_type"
    assert field_value_problem(num, True)[0] == "field_type"
    assert field_value_problem(flag, "TRUE") is None and field_value_problem(flag, "yes")[0] == "field_type"
    assert field_value_problem(day, "2026-01-31") is None and field_value_problem(day, "31/01/2026")
    assert field_value_problem(FieldRule(type="datetime"), "2026-01-31T09:00:00Z") is None
    assert field_value_problem(FieldRule(type="url"), "example.com")[0] == "field_type"
    assert field_value_problem(FieldRule(type="email"), "ana@example.com") is None
    assert field_value_problem(FieldRule(type="markdown"), {"any": "thing"}) is None          # not judged
    assert field_value_problem(num, "") is None and field_value_problem(num, None) is None     # no value


def test_a_value_is_one_of_the_allowed_ones_compared_as_text():
    from backend.app.services.versioning.ontology import FieldRule, field_value_problem
    tier = FieldRule(type="status", allowed=("gold", "silver"), name="Tier")
    assert field_value_problem(tier, "gold") is None and field_value_problem(tier, " gold ") is None
    rule, reason = field_value_problem(tier, "bronze")
    assert rule == "field_not_allowed" and reason == "Tier must be one of 'gold', 'silver' — 'bronze' isn't."
    level = FieldRule(type="number", allowed=("1", "2"))
    assert field_value_problem(level, 2) is None and field_value_problem(level, 2.0) is None
    assert field_value_problem(level, 3)[0] == "field_not_allowed"
    tags = FieldRule(type="tags", allowed=("pii", "gdpr"))
    assert field_value_problem(tags, ["pii", "gdpr"]) is None and field_value_problem(tags, "pii, gdpr") is None
    assert field_value_problem(tags, ["pii", "hr"])[1].endswith("'hr' isn't.")


def test_only_what_a_publish_changes_is_judged():
    from backend.app.services.versioning.ontology import field_violations
    rules = OntologyRules(entity_types={"Table": EntityRule(fields=_fields_rules())})

    def node(**props):
        return {"entityType": "Table", "displayName": "Orders", "urn": "urn:t", "properties": props}

    # A new one: every field of its type — required ones too (matched case-insensitively).
    found = field_violations([("t", {**node(tier="bronze", rows="x"), "entityType": "table"}, None)], rules)
    assert [(v["rule"], v["field"]) for v in found] == [
        ("field_required", "owner"), ("field_type", "rows"), ("field_not_allowed", "tier")]
    assert found[0] == {"entity_id": "t", "kind": "node", "type": "Table", "name": "Orders", "urn": "urn:t",
                        "rule": "field_required", "field": "owner", "fieldName": "Owner", "value": None,
                        "reason": "Owner is required for a new Table."}
    # Legacy values it leaves alone pass; a value it changes is judged; a required one emptied is refused.
    legacy = node(tier="bronze", rows="x")
    assert field_violations([("t", {**legacy, "displayName": "Renamed"}, legacy)], rules) == []
    assert [v["field"] for v in field_violations([("t", node(tier="copper", rows="x"), legacy)], rules)] == ["tier"]
    emptied = field_violations([("t", node(owner=""), node(owner="ana"))], rules)
    assert [(v["rule"], v["reason"]) for v in emptied] == [
        ("field_required", "Owner is required on Table — it can't be emptied or removed.")]
    # A type it moves into is judged as new; edges, deletes and types without field rules pass.
    assert field_violations([("t", node(), {"entityType": "View", "properties": {}})], rules)
    assert field_violations([("t", None, legacy), ("v", {"entityType": "View"}, None)], rules) == []
    assert field_violations([("t", node(), None)], None) == []


def test_a_refusal_keeps_a_hundred_values_and_counts_them_all_by_field():
    from backend.app.services.versioning.errors import FieldViolation
    from backend.app.services.versioning.ontology import FieldFindings, field_violations
    rules = OntologyRules(entity_types={"Table": EntityRule(fields=_fields_rules())})
    found = FieldFindings()
    assert not found
    for page in range(3):                                   # page after page, as a publish judges
        found.add(field_violations([(f"t{page}-{i}", {"entityType": "Table", "properties": {"tier": "x"}}, None)
                                    for i in range(50)], rules))
    assert found.total == 300 and len(found.examples) == 100 and found.examples[0]["entity_id"] == "t0-0"
    ids = [f"gv:t{page}-{i}" for page in range(3) for i in range(50)]
    assert found.by_field() == [
        {"entityType": "Table", "field": "owner", "fieldName": "Owner", "rule": "field_required", "count": 150,
         "ids": ids, "idsComplete": True},
        {"entityType": "Table", "field": "tier", "fieldName": "Tier", "rule": "field_not_allowed", "count": 150,
         "ids": ids, "idsComplete": True}]
    refusal = FieldViolation(found)
    assert refusal.detail["total"] == 300 and len(refusal.detail["violations"]) == 100
    assert refusal.detail["byField"] == found.by_field()
    assert str(refusal).startswith("300 values break the fields their entity types define")


def test_a_refusal_names_the_refused_entities_per_field_up_to_what_one_bulk_job_takes(monkeypatch):
    """Each per-field count names its entities as a bulk property job's ``ids`` target names them,
    so one job can fill a required field on all of them — at most as many as a job takes."""
    from backend.app.services.versioning import config, ontology
    from backend.app.services.versioning.ontology import FieldFindings, FieldRule, field_violations
    assert ontology.FIELD_IDS_MAX == config.PROPERTY_JOB_MAX_IDS
    monkeypatch.setattr(ontology, "FIELD_IDS_MAX", 4)
    rules = OntologyRules(entity_types={"Table": EntityRule(fields={"owner": FieldRule(required=True, name="Owner")})})
    found = FieldFindings()
    for page in range(2):
        found.add(field_violations([(f"t{page}-{i}", {"entityType": "Table", "properties": {}}, None)
                                    for i in range(3)], rules))
    [owner] = found.by_field()
    assert owner["count"] == 6 and owner["ids"] == ["gv:t0-0", "gv:t0-1", "gv:t0-2", "gv:t1-0"]
    assert owner["idsComplete"] is False
