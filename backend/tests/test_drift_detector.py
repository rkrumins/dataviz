"""
Tests for backend.app.ontology.drift_detector — detect_drift, _closest_match, _common_prefix.
"""
from backend.app.ontology.drift_detector import detect_drift, _closest_match, _common_prefix


class TestDetectDrift:
    def test_no_drift_when_all_mapped(self):
        report = detect_drift(
            external_entity_types=["Dataset", "Pipeline"],
            external_relationship_types=["FLOWS_TO"],
            entity_type_mappings={"Dataset": "dataset", "Pipeline": "pipeline"},
            relationship_type_mappings={"FLOWS_TO": "flows_to"},
        )
        assert report.has_drift is False
        assert report.issues == []

    def test_unmapped_entity_type(self):
        report = detect_drift(
            external_entity_types=["Dataset", "NewType"],
            external_relationship_types=[],
            entity_type_mappings={"Dataset": "dataset"},
            relationship_type_mappings={},
        )
        assert report.has_drift is True
        assert len(report.issues) == 1
        assert report.issues[0].kind == "unmapped_entity_type"
        assert report.issues[0].external_label == "NewType"

    def test_unmapped_relationship_type(self):
        report = detect_drift(
            external_entity_types=[],
            external_relationship_types=["CONTAINS", "UNKNOWN_REL"],
            entity_type_mappings={},
            relationship_type_mappings={"CONTAINS": "contains"},
        )
        assert report.has_drift is True
        assert len(report.issues) == 1
        assert report.issues[0].kind == "unmapped_relationship_type"
        assert report.issues[0].external_label == "UNKNOWN_REL"

    def test_case_insensitive_mapping_lookup(self):
        report = detect_drift(
            external_entity_types=["DATASET"],
            external_relationship_types=[],
            entity_type_mappings={"Dataset": "dataset"},
            relationship_type_mappings={},
        )
        assert report.has_drift is False

    def test_schema_hash_determinism(self):
        kwargs = dict(
            external_entity_types=["A", "B"],
            external_relationship_types=["X"],
            entity_type_mappings={"A": "a", "B": "b"},
            relationship_type_mappings={"X": "x"},
        )
        r1 = detect_drift(**kwargs)
        r2 = detect_drift(**kwargs)
        assert r1.schema_hash == r2.schema_hash

    def test_schema_hash_changes_with_input(self):
        r1 = detect_drift(["A"], [], {"A": "a"}, {})
        r2 = detect_drift(["A", "B"], [], {"A": "a", "B": "b"}, {})
        assert r1.schema_hash != r2.schema_hash

    def test_suggestion_when_known_types_provided(self):
        report = detect_drift(
            external_entity_types=["data_set"],
            external_relationship_types=[],
            entity_type_mappings={},
            relationship_type_mappings={},
            known_synodic_entity_types=["dataset", "pipeline"],
        )
        assert report.has_drift is True
        assert report.issues[0].suggestion == "dataset"


class TestClosestMatch:
    def test_finds_matching_candidate(self):
        result = _closest_match("dataset", ["pipeline", "dataset_v2", "domain"])
        assert result == "dataset_v2"

    def test_empty_candidates_returns_none(self):
        assert _closest_match("anything", []) is None

    def test_no_common_prefix_returns_none(self):
        assert _closest_match("xyz", ["abc", "def"]) is None

    def test_ignores_underscores_and_dashes(self):
        result = _closest_match("data-set", ["dataset", "domain"])
        assert result == "dataset"


class TestCommonPrefix:
    def test_identical_strings(self):
        assert _common_prefix("abc", "abc") == "abc"

    def test_partial_overlap(self):
        assert _common_prefix("abcdef", "abcxyz") == "abc"

    def test_no_overlap(self):
        assert _common_prefix("xyz", "abc") == ""

    def test_empty_string(self):
        assert _common_prefix("", "abc") == ""
        assert _common_prefix("abc", "") == ""

    def test_one_is_prefix_of_other(self):
        assert _common_prefix("abc", "abcdef") == "abc"
