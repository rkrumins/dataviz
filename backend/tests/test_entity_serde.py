"""Canonical entity ↔ payload serialization contract (entity_serde).

The bug this closes: five edge producers FLATTENED user props to the payload top level and dropped
`confidence`, while the reseed reads the canonical `{confidence(top), properties(nested)}` shape —
so a rebuild blanked every edge's confidence + properties. These tests pin the canonical shape and
the both-ways tolerance of `row_to_edge_payload` / `payload_to_edge`.
"""
from backend.app.services.versioning import entity_serde as es
from backend.common.models.graph import GraphEdge, GraphNode


def test_edge_to_payload_is_canonical():
    e = GraphEdge(id="E1", sourceUrn="urn:a", targetUrn="urn:b", edgeType="FLOWS",
                  confidence=0.9, properties={"sql": "select 1", "cols": ["a", "b"]})
    p = es.edge_to_payload(e)
    assert p == {"edgeType": "FLOWS", "sourceEntityId": "urn:a", "targetEntityId": "urn:b",
                 "confidence": 0.9, "properties": {"sql": "select 1", "cols": ["a", "b"]}}


def test_edge_to_payload_omits_empty_confidence_and_properties():
    e = GraphEdge(id="E", sourceUrn="a", targetUrn="b", edgeType="REL")
    assert es.edge_to_payload(e) == {"edgeType": "REL", "sourceEntityId": "a", "targetEntityId": "b"}


def test_row_to_edge_payload_canonical_row_passthrough():
    row = {"kind": "edge", "id": "E1", "edgeType": "FLOWS",
           "sourceEntityId": "urn:a", "targetEntityId": "urn:b",
           "confidence": 0.42, "properties": {"k": "v"}}
    assert es.row_to_edge_payload(row) == {
        "edgeType": "FLOWS", "sourceEntityId": "urn:a", "targetEntityId": "urn:b",
        "confidence": 0.42, "properties": {"k": "v"}}


def test_row_to_edge_payload_recovers_legacy_flattened():
    # The pre-fix shape: user props spread at top level, endpoints as source/target, no confidence.
    legacy = {"kind": "edge", "id": "E1", "edgeType": "FLOWS",
              "source": "urn:a", "target": "urn:b", "sql": "select 1", "weight": 3}
    p = es.row_to_edge_payload(legacy)
    assert p["sourceEntityId"] == "urn:a" and p["targetEntityId"] == "urn:b"
    assert p["edgeType"] == "FLOWS"
    assert p["properties"] == {"sql": "select 1", "weight": 3}   # re-nested, not lost
    assert "confidence" not in p                                  # legacy never stored it


def test_payload_to_edge_roundtrips_both_shapes():
    e = GraphEdge(id="E1", sourceUrn="urn:a", targetUrn="urn:b", edgeType="FLOWS",
                  confidence=0.7, properties={"m": {"nested": 1}})
    back = es.payload_to_edge("E1", es.edge_to_payload(e))
    assert back.source_urn == "urn:a" and back.target_urn == "urn:b"
    assert back.edge_type == "FLOWS" and back.confidence == 0.7
    assert back.properties == {"m": {"nested": 1}}
    # legacy flattened payload recovers identically (minus confidence, never stored)
    legacy = {"edgeType": "FLOWS", "sourceEntityId": "urn:a", "targetEntityId": "urn:b", "m": {"nested": 1}}
    lback = es.payload_to_edge("E1", legacy)
    assert lback.properties == {"m": {"nested": 1}} and lback.confidence is None


def test_node_to_payload_nests_properties():
    n = GraphNode(urn="urn:x", entityType="Layer", displayName="Sales",
                  properties={"owner": "team-a"})
    p = es.node_to_payload(n)
    assert p["urn"] == "urn:x" and p["entityType"] == "Layer" and p["displayName"] == "Sales"
    assert p["properties"] == {"owner": "team-a"}                 # nested, not flattened


def test_node_payload_roundtrips():
    n = GraphNode(urn="urn:x", entityType="Object", displayName="Accounts",
                  properties={"rows": 10})
    back = es.payload_to_node("urn:x", es.node_to_payload(n))
    assert back.urn == "urn:x" and back.entity_type == "Object"
    assert back.display_name == "Accounts" and back.properties == {"rows": 10}


def test_discriminator_preserved_top_level_when_present():
    row = {"kind": "edge", "edgeType": "FLOWS", "sourceEntityId": "a", "targetEntityId": "b",
           "discriminator": "d1", "properties": {"k": "v"}}
    p = es.row_to_edge_payload(row)
    assert p["discriminator"] == "d1" and p["properties"] == {"k": "v"}


def test_is_flattened_edge_payload_detects_the_pre_fix_shape():
    # Pre-fix flattened: user props spread at the top level, no nested `properties`, no confidence.
    assert es.is_flattened_edge_payload(
        {"edgeType": "FLOWS", "sourceEntityId": "a", "targetEntityId": "b",
         "sql": "select 1", "weight": 3}) is True
    # Canonical (nested properties) is NOT flattened.
    assert es.is_flattened_edge_payload(
        {"edgeType": "FLOWS", "sourceEntityId": "a", "targetEntityId": "b",
         "confidence": 0.9, "properties": {"sql": "select 1"}}) is False
    # A legitimately attribute-less edge (only envelope keys) is NOT flattened.
    assert es.is_flattened_edge_payload(
        {"edgeType": "CONTAINS", "sourceEntityId": "a", "targetEntityId": "b"}) is False
    # An explicit discriminator is envelope, not a stray user prop.
    assert es.is_flattened_edge_payload(
        {"edgeType": "FLOWS", "sourceEntityId": "a", "targetEntityId": "b",
         "discriminator": "d1", "properties": {"k": "v"}}) is False


def test_edge_payload_matches_versioned_branch_provider():
    """The write-through edit path serializes edges via ``versioned_branch_provider._edge_payload`` —
    a SEPARATE implementation from ``entity_serde.edge_to_payload``. If the two drift, an edit and a
    bootstrap/reseed would store DIFFERENT shapes for the same edge and the round-trip breaks. This
    pins them equal (a drift guard as a test, not a runtime import, so providers stays cycle-free)."""
    from backend.app.providers.versioned_branch_provider import _edge_payload
    cases = [
        GraphEdge(id="E1", sourceUrn="urn:a", targetUrn="urn:b", edgeType="FLOWS",
                  confidence=0.9, properties={"sql": "select 1", "cols": ["a", "b"]}),
        GraphEdge(id="E2", sourceUrn="a", targetUrn="b", edgeType="REL"),          # neither conf nor props
        GraphEdge(id="E3", sourceUrn="x", targetUrn="y", edgeType="DERIVES",
                  confidence=0.0, properties={"m": {"nested": 1}}),                # 0.0 must NOT be dropped
    ]
    for e in cases:
        assert es.edge_to_payload(e) == _edge_payload(e), e.id


# ── a source graph's node, as history keeps it ────────────────────────────────────────────────

def test_source_node_payload_is_the_readers_for_an_ordinary_node():
    """Pins hash stability: a node that uses no platform name converts exactly as the reader
    reads it, so graphs already enabled keep their content hashes."""
    from backend.app.providers.falkordb_provider import _node_from_props
    from backend.app.services.versioning.entity_serde import source_node_payload

    props = {"urn": "urn:t", "displayName": "Orders", "qualifiedName": "db.orders",
             "description": "d", "tags": '["a", "b"]', "layerAssignment": "gold",
             "sourceSystem": "erp", "lastSyncedAt": "2026-01-01", "owner": "ana", "rows": 5,
             "propertiesRaw": '{"nested": {"a": 1}}'}
    want = _node_from_props(dict(props), "Table").model_dump(by_alias=True, exclude_none=True)
    assert source_node_payload(dict(props), "Table") == want
    assert source_node_payload({"name": "no urn"}, "Table") is None


def test_reserved_names_a_field_cannot_take_are_kept_under_src():
    from backend.app.services.versioning.entity_serde import source_node_payload

    p = source_node_payload({
        "urn": "urn:t", "name": 42, "displayName": 7, "description": 3.5, "qualifiedName": ["x"],
        "tags": "a,b", "entityType": "Dataset", "entityId": "ERP-17",
        "gvHash": 1, "searchableText": "x", "level": 2, "levelDigest": "d", "childCount": 9,
        "urnSource": "id", "nameSource": "name",
    }, "Table")
    assert p["displayName"] == "42", "a numeric name still names the node"
    assert p["entityType"] == "Table" and "qualifiedName" not in p and "description" not in p
    assert p["properties"] == {
        "name": 42, "__src.displayName": 7, "__src.description": 3.5, "__src.qualifiedName": ["x"],
        "__src.tags": "a,b", "__src.entityType": "Dataset", "__src.entityId": "ERP-17"}
    same = source_node_payload({"urn": "urn:t", "entityId": "urn:t", "entityType": "Table",
                                "tags": ["a"]}, "Table")
    assert same["properties"] == {} and same["tags"] == ["a"], "nothing new: nothing kept"
    unlabelled = source_node_payload({"urn": "urn:u", "entityType": "Column"}, None)
    assert unlabelled["entityType"] == "Column" and unlabelled["properties"] == {}


def test_bags_are_unpacked_native_winning():
    from backend.app.services.versioning.entity_serde import source_node_payload

    p = source_node_payload({
        "urn": "urn:t", "owner": "native",
        "properties": '{"owner": "legacy", "legacy": 1, "urn": "inside"}',
        "propertiesRaw": '{"raw": {"deep": true}}',
    }, "Table")
    assert p["properties"] == {"owner": "native", "legacy": 1, "raw": {"deep": True},
                               "__src.urn": "inside"}
    text = source_node_payload({"urn": "urn:t", "properties": "free text", "propertiesRaw": "[1]"},
                               "Table")
    assert text["properties"] == {"__src.properties": "free text", "__src.propertiesRaw": "[1]"}


# ── values Postgres can hold ──────────────────────────────────────────────────────────────────

def test_storable_turns_dates_into_stored_text_and_reports_nothing():
    from datetime import date, datetime, time, timedelta, timezone

    from backend.app.services.versioning.entity_serde import storable

    value = {"at": datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc),
             "naive": datetime(2026, 1, 2, 3, 4, 5), "day": date(2026, 1, 2),
             "clock": time(5, 6, 7), "took": timedelta(seconds=90),
             "list": [date(2026, 1, 2)], "deep": {"d": date(2026, 1, 2)}, "n": 1, "ok": "x"}
    got, issues = storable(value)
    assert got == {"at": "2026-01-02T03:04:05Z", "naive": "2026-01-02T03:04:05Z", "day": "2026-01-02",
                   "clock": "05:06:07", "took": "0:01:30", "list": ["2026-01-02"],
                   "deep": {"d": "2026-01-02"}, "n": 1, "ok": "x"}
    assert issues == []


def test_storable_names_every_value_it_had_to_change():
    import json

    from backend.app.services.versioning.entity_serde import storable

    got, issues = storable({"score": float("nan"), "hi": float("inf"), "lo": float("-inf"),
                            "note": "a\x00b", "deep": [{"x": float("nan")}], "k\x00ey": 1,
                            "raw": b"\x01"}, "properties")
    json.dumps(got, allow_nan=False)
    assert got == {"score": "NaN", "hi": "Infinity", "lo": "-Infinity", "note": "ab",
                   "deep": [{"x": "NaN"}], "key": 1, "raw": "b'\\x01'"}
    assert sorted((i["path"], i["problem"]) for i in issues) == [
        ("properties.deep[0].x", "nan"), ("properties.hi", "infinity"), ("properties.key", "nul"),
        ("properties.lo", "infinity"), ("properties.note", "nul"), ("properties.raw", "unsupported"),
        ("properties.score", "nan")]
