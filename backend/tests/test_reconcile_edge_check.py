"""Pure comparison logic for the attribute-aware projection verify (S2).

The deep EDGE check is the coverage the id-set diff cannot give: a present edge (matching `r.id`)
written with a wrong type, a dropped confidence, or blanked properties leaves the id-set identical.
These pin the field-by-field comparison the check rides on — including the two subtle cases
(confidence float tolerance / None, and the JSON-string properties round-trip).
"""
from backend.app.services.versioning.reconcile import (
    _conf_equal,
    _edge_field_mismatches,
    _parse_props,
)


def _pg(edge_type="FLOWS_TO", confidence=0.9, properties=None):
    return {"entityId": "E1", "edgeType": edge_type, "confidence": confidence,
            "properties": properties if properties is not None else {"sql": "s"}}


def test_faithful_edge_has_no_mismatch():
    # cache holds exactly what the projector should have written: sanitised type, same confidence,
    # JSON-serialised properties.
    pg = _pg()
    assert _edge_field_mismatches(pg, "FLOWS_TO", 0.9, '{"sql": "s"}') == []


def test_dropped_confidence_is_a_mismatch():
    # the pre-fix bug: confidence blanked to None on write.
    out = _edge_field_mismatches(_pg(confidence=0.9), "FLOWS_TO", None, '{"sql": "s"}')
    assert [f[0] for f in out] == ["confidence"]
    assert out[0][1] == 0.9 and out[0][2] is None


def test_blanked_properties_is_a_mismatch():
    out = _edge_field_mismatches(_pg(properties={"sql": "s"}), "FLOWS_TO", 0.9, "{}")
    assert [f[0] for f in out] == ["properties"]


def test_mistyped_edge_is_a_mismatch():
    # a present edge (same r.id) written with the wrong relationship type — invisible to the id-diff.
    out = _edge_field_mismatches(_pg(edge_type="FLOWS_TO"), "DERIVES_FROM", 0.9, '{"sql": "s"}')
    assert [f[0] for f in out] == ["edgeType"]
    assert out[0][1] == "FLOWS_TO" and out[0][2] == "DERIVES_FROM"


def test_multiple_fields_drift_at_once():
    out = _edge_field_mismatches(_pg(edge_type="A", confidence=0.9, properties={"k": 1}),
                                 "B", None, "{}")
    assert {f[0] for f in out} == {"edgeType", "confidence", "properties"}


def test_edgeless_confidence_none_matches_none():
    # an edge that legitimately carries no confidence must NOT read as drift against a null cache val.
    assert _edge_field_mismatches(_pg(confidence=None), "FLOWS_TO", None, '{"sql": "s"}') == []


def test_conf_equal_none_and_number():
    assert _conf_equal(None, None) is True
    assert _conf_equal(0.9, None) is False
    assert _conf_equal(None, 0.9) is False
    assert _conf_equal(0.9, 0.9) is True
    assert _conf_equal(0.9, 0.9 + 1e-12) is True          # float-representation tolerant
    assert _conf_equal(0.9, 0.8) is False
    assert _conf_equal(0.0, 0.0) is True                  # 0.0 is a real confidence, not "absent"


def test_parse_props_handles_json_string_native_and_garbage():
    assert _parse_props('{"a": 1}') == {"a": 1}
    assert _parse_props("{}") == {}
    assert _parse_props(None) == {}
    assert _parse_props({"a": 1}) == {"a": 1}              # tolerate a legacy native dict
    assert _parse_props("not json") == {}                 # unparseable residual → empty, never raises
