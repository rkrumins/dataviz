"""
Tests for backend.app.ontology.urn — URN generation, normalisation, validation, parsing.
"""
from backend.app.ontology.urn import make_urn, normalize_urn, is_valid_urn, parse_synodic_urn


class TestMakeUrn:
    def test_with_explicit_slug(self):
        urn = make_urn("dataset", slug="orders_table", source_system="datahub")
        assert urn == "urn:synodic:datahub:dataset:orders_table"

    def test_default_slug_is_generated(self):
        urn = make_urn("domain")
        assert urn.startswith("urn:synodic:manual:domain:")
        slug = urn.split(":")[-1]
        assert len(slug) > 0

    def test_lowercase_normalization(self):
        urn = make_urn("Dataset", source_system="DataHub", slug="MySlug")
        # entity_type and source_system are lowered; slug is kept as-is
        assert ":datahub:dataset:" in urn

    def test_default_source_system_is_manual(self):
        urn = make_urn("pipeline", slug="etl1")
        assert urn == "urn:synodic:manual:pipeline:etl1"


class TestNormalizeUrn:
    def test_converts_legacy_prefix(self):
        result = normalize_urn("urn:nexus:manual:domain:abc123")
        assert result == "urn:synodic:manual:domain:abc123"

    def test_preserves_non_legacy_urn(self):
        datahub = "urn:li:dataset:(urn:li:dataPlatform:postgres,orders,PROD)"
        assert normalize_urn(datahub) == datahub

    def test_preserves_synodic_prefix(self):
        original = "urn:synodic:manual:domain:abc"
        assert normalize_urn(original) == original

    def test_strips_whitespace(self):
        assert normalize_urn("  urn:synodic:manual:domain:x  ") == "urn:synodic:manual:domain:x"

    def test_strips_whitespace_and_converts_legacy(self):
        result = normalize_urn("  urn:nexus:foo:bar:baz  ")
        assert result == "urn:synodic:foo:bar:baz"


class TestIsValidUrn:
    def test_accepts_synodic_urn(self):
        assert is_valid_urn("urn:synodic:manual:domain:abc") is True

    def test_accepts_datahub_urn(self):
        assert is_valid_urn("urn:li:dataset:foo") is True

    def test_accepts_legacy_urn(self):
        assert is_valid_urn("urn:nexus:manual:domain:abc") is True

    def test_rejects_no_urn_prefix(self):
        assert is_valid_urn("not-a-urn") is False

    def test_rejects_empty_string(self):
        assert is_valid_urn("") is False

    def test_rejects_bare_urn(self):
        assert is_valid_urn("urn:") is False


class TestParseSynodicUrn:
    def test_extracts_components(self):
        result = parse_synodic_urn("urn:synodic:datahub:dataset:orders_table")
        assert result == {
            "source_system": "datahub",
            "entity_type": "dataset",
            "slug": "orders_table",
        }

    def test_parses_legacy_prefix_via_normalization(self):
        result = parse_synodic_urn("urn:nexus:manual:domain:abc123")
        assert result is not None
        assert result["source_system"] == "manual"
        assert result["entity_type"] == "domain"
        assert result["slug"] == "abc123"

    def test_returns_none_for_non_synodic(self):
        assert parse_synodic_urn("urn:li:dataset:foo") is None

    def test_returns_none_for_incomplete_synodic(self):
        # Only two parts after prefix — needs three (source, type, slug)
        assert parse_synodic_urn("urn:synodic:manual:domain") is None

    def test_slug_with_colons_preserved(self):
        urn = "urn:synodic:datahub:schemafield:urn:li:schemaField:(id)"
        result = parse_synodic_urn(urn)
        assert result is not None
        assert result["slug"] == "urn:li:schemaField:(id)"
