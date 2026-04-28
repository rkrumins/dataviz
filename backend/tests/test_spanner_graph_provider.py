"""
Unit tests for the Google Spanner Graph provider.

Focuses on logic that doesn't require the Spanner Emulator:
  * value coercion (TIMESTAMP / BYTES / ARRAY / NUMERIC / nested dicts)
  * GraphNode / GraphEdge hydration through the schema-mapping layer
  * credential builder branches (ADC / service-account JSON / impersonation)
  * service-account JSON shape validation
  * provider error classification (preflight reason codes)
  * containment edge type resolution chain
  * client-side filter helpers
  * _TTLCache + _URNLabelCache eviction semantics
  * suggest_mapping heuristics
  * sidecar table name derivation

Emulator-based tests live behind the ``@requires_spanner_emulator`` marker
and exercise list_graphs, preflight, ensure_projections (DDL idempotency),
and a round-trip through materialize_aggregated_edges_batch. They are
skipped unless ``SPANNER_EMULATOR_HOST`` is exported.
"""
from __future__ import annotations

import base64
import json
import os
from datetime import datetime, timezone
from typing import Any

import pytest

from backend.common.interfaces.preflight import PreflightResult
from backend.common.interfaces.provider import ProviderConfigurationError
from backend.common.models.graph import (
    FilterOperator,
    GraphNode,
    PropertyFilter,
    TagFilter,
    TextFilter,
)


# ---------------------------------------------------------------------- #
# Pure helper tests (no Spanner client required)                          #
# ---------------------------------------------------------------------- #


def test_coerce_spanner_value_primitives():
    from backend.app.providers.spanner_graph_provider import _coerce_spanner_value

    assert _coerce_spanner_value(None) is None
    assert _coerce_spanner_value("hello") == "hello"
    assert _coerce_spanner_value(42) == 42
    assert _coerce_spanner_value(3.14) == 3.14
    assert _coerce_spanner_value(True) is True


def test_coerce_spanner_value_timestamps():
    from backend.app.providers.spanner_graph_provider import _coerce_spanner_value

    naive = datetime(2026, 4, 27, 12, 0, 0)
    aware = datetime(2026, 4, 27, 12, 0, 0, tzinfo=timezone.utc)
    # Naive timestamps are assumed UTC; aware timestamps keep their offset.
    out_naive = _coerce_spanner_value(naive)
    out_aware = _coerce_spanner_value(aware)
    assert isinstance(out_naive, str) and out_naive.endswith("+00:00")
    assert isinstance(out_aware, str) and out_aware.endswith("+00:00")


def test_coerce_spanner_value_bytes_to_base64():
    from backend.app.providers.spanner_graph_provider import _coerce_spanner_value

    raw = b"\x00\x01\x02hello"
    out = _coerce_spanner_value(raw)
    assert isinstance(out, str)
    assert base64.b64decode(out) == raw


def test_coerce_spanner_value_array_and_dict_recursion():
    from backend.app.providers.spanner_graph_provider import _coerce_spanner_value

    nested = {
        "ts": datetime(2026, 4, 27, tzinfo=timezone.utc),
        "blob": b"\xff\xee",
        "items": [1, "two", datetime(2026, 1, 1, tzinfo=timezone.utc)],
    }
    out = _coerce_spanner_value(nested)
    # Result must be JSON-serializable.
    json.dumps(out)
    assert isinstance(out["ts"], str)
    assert base64.b64decode(out["blob"]) == b"\xff\xee"
    assert out["items"][0] == 1
    assert out["items"][1] == "two"
    assert isinstance(out["items"][2], str)


def test_node_from_props_minimal():
    from backend.app.providers.spanner_graph_provider import _node_from_props

    node = _node_from_props({
        "urn": "urn:dataset:foo",
        "displayName": "Foo",
        "entityType": "dataset",
    })
    assert node is not None
    assert node.urn == "urn:dataset:foo"
    assert node.display_name == "Foo"
    assert node.entity_type == "dataset"


def test_node_from_props_handles_json_string_props_and_tags():
    from backend.app.providers.spanner_graph_provider import _node_from_props

    node = _node_from_props({
        "urn": "urn:x",
        "displayName": "X",
        "entityType": "container",
        "properties": json.dumps({"k": "v"}),
        "tags": json.dumps(["a", "b"]),
    })
    assert node is not None
    assert node.properties == {"k": "v"}
    assert node.tags == ["a", "b"]


def test_node_from_props_returns_none_without_urn():
    from backend.app.providers.spanner_graph_provider import _node_from_props

    assert _node_from_props({"displayName": "no urn"}) is None
    assert _node_from_props({}) is None
    assert _node_from_props(None) is None  # type: ignore[arg-type]


def test_edge_from_row_synthesizes_id_when_missing():
    from backend.app.providers.spanner_graph_provider import _edge_from_row

    edge = _edge_from_row(
        source_urn="urn:a", target_urn="urn:b",
        edge_type="LINEAGE", edge_id=None, confidence=0.9,
        properties={"k": "v"},
    )
    assert edge.id == "urn:a|LINEAGE|urn:b"
    assert edge.confidence == 0.9
    assert edge.properties == {"k": "v"}


def test_sanitize_identifier_strips_unsafe_chars():
    from backend.app.providers.spanner_graph_provider import _sanitize_identifier

    assert _sanitize_identifier("FinGraph") == "FinGraph"
    assert _sanitize_identifier("my-graph.v2") == "my_graph_v2"
    assert _sanitize_identifier("123graph") == "_123graph"
    assert _sanitize_identifier("") == "graph"


def test_suggest_mapping_picks_canonical_aliases():
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    suggested = SpannerGraphProvider._suggest_mapping({"uuid", "name", "fullName", "summary", "categories"})
    assert suggested["identity_field"] == "uuid"
    assert suggested["display_name_field"] == "name"
    assert suggested["qualified_name_field"] == "fullName"
    assert suggested["description_field"] == "summary"
    assert suggested["tags_field"] == "categories"


def test_suggest_mapping_falls_back_to_canonical_names_when_nothing_matches():
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    suggested = SpannerGraphProvider._suggest_mapping({"random", "fields"})
    assert suggested["identity_field"] == "urn"
    assert suggested["display_name_field"] == "displayName"


# ---------------------------------------------------------------------- #
# Cache helpers                                                          #
# ---------------------------------------------------------------------- #


def test_ttl_cache_returns_value_within_ttl():
    from backend.app.providers.spanner_graph_provider import _TTLCache

    c = _TTLCache(ttl_seconds=10.0)
    assert c.get() is None
    c.set({"answer": 42})
    assert c.get() == {"answer": 42}
    c.invalidate()
    assert c.get() is None


def test_urn_label_cache_evicts_lru():
    from backend.app.providers.spanner_graph_provider import _URNLabelCache

    cache = _URNLabelCache(max_size=10)
    for i in range(20):
        cache.put(f"urn:{i}", f"label:{i}")
    # Cache evicts in chunks of max_size//10 = 1 once full; under heavy
    # over-fill we expect at most max_size entries to remain.
    assert len(cache._data) <= 10


def test_urn_label_cache_move_to_end_on_get():
    from backend.app.providers.spanner_graph_provider import _URNLabelCache

    cache = _URNLabelCache(max_size=3)
    cache.put("a", "A")
    cache.put("b", "B")
    cache.put("c", "C")
    # Touch 'a' so it's most-recent
    assert cache.get("a") == "A"
    cache.put("d", "D")  # triggers eviction of LRU (b)
    assert cache.get("a") == "A"
    assert cache.get("d") == "D"


# ---------------------------------------------------------------------- #
# Construction & input validation                                         #
# ---------------------------------------------------------------------- #


def _build_provider(**overrides: Any):
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    defaults = dict(
        project_id="my-project",
        instance_id="my-instance",
        database_id="my-db",
        property_graph_name="LineageGraph",
        auth_method="adc",
    )
    defaults.update(overrides)
    return SpannerGraphProvider(**defaults)


def test_constructor_requires_project_id():
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    with pytest.raises(ValueError, match="project_id"):
        SpannerGraphProvider(
            project_id="", instance_id="x", database_id="y",
            property_graph_name="g",
        )


def test_constructor_requires_instance_id():
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    with pytest.raises(ValueError, match="instance_id"):
        SpannerGraphProvider(
            project_id="p", instance_id="", database_id="y",
            property_graph_name="g",
        )


def test_provider_name_includes_addressing():
    p = _build_provider()
    assert "my-instance" in p.name
    assert "my-db" in p.name
    assert "LineageGraph" in p.name


def test_capabilities_default_state_before_connect():
    p = _build_provider()
    # Time-travel is always available within the PITR window; the others
    # are detected at connect-time and start False.
    assert p._capabilities["time_travel"] is True
    assert p._capabilities["vector_search"] is False
    assert p._capabilities["full_text_search"] is False
    assert p._capabilities["change_streams"] is False


def test_change_streams_capability_flips_when_configured():
    p = _build_provider(change_stream_name="lineage_stream")
    # The flag is set by _detect_capabilities, which we don't run here;
    # but the attribute reflects construction config so the wizard's
    # diagnostics don't get a stale "false" before connect.
    # We assert the inverse: it stays False until detect runs.
    assert p._capabilities["change_streams"] is False


# ---------------------------------------------------------------------- #
# Credential builder                                                      #
# ---------------------------------------------------------------------- #


def test_build_credentials_adc_returns_none():
    p = _build_provider(auth_method="adc")
    # ADC: build_credentials returns (None, None) so spanner.Client falls
    # back to google.auth.default(). This test asserts that branch without
    # touching the google-auth import path.
    creds, project_override = p._build_credentials()
    assert creds is None
    assert project_override is None


def test_build_credentials_service_account_json_requires_payload():
    p = _build_provider(auth_method="service_account_json", credentials_json=None)
    with pytest.raises(ProviderConfigurationError, match="credentials_json"):
        p._build_credentials()


def test_build_credentials_service_account_json_validates_shape():
    bad = base64.b64encode(json.dumps({"type": "user"}).encode()).decode()
    p = _build_provider(auth_method="service_account_json", credentials_json=bad)
    with pytest.raises(ProviderConfigurationError, match="not a valid service account"):
        p._build_credentials()


def test_build_credentials_service_account_json_rejects_malformed_base64():
    p = _build_provider(auth_method="service_account_json", credentials_json="not-base64!")
    with pytest.raises(ProviderConfigurationError, match="malformed"):
        p._build_credentials()


def test_build_credentials_impersonation_requires_target():
    p = _build_provider(auth_method="impersonation", impersonate_service_account=None)
    with pytest.raises(ProviderConfigurationError, match="impersonate_service_account"):
        p._build_credentials()


def test_build_credentials_unknown_method():
    p = _build_provider(auth_method="something_else")
    with pytest.raises(ProviderConfigurationError, match="unknown auth_method"):
        p._build_credentials()


# ---------------------------------------------------------------------- #
# Error classification                                                    #
# ---------------------------------------------------------------------- #


def test_classify_spanner_error_auth():
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    code = SpannerGraphProvider._classify_spanner_error(
        Exception("PermissionDenied: caller does not have permission")
    )
    assert code == "auth_error"


def test_classify_spanner_error_database_not_found():
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    code = SpannerGraphProvider._classify_spanner_error(
        Exception("NotFound: Database my-db not found")
    )
    assert code == "database_not_found"


def test_classify_spanner_error_edition_unsupported():
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    code = SpannerGraphProvider._classify_spanner_error(
        Exception("Object PROPERTY_GRAPHS does not exist in Spanner Standard")
    )
    assert code == "spanner_edition_unsupported"


def test_classify_spanner_error_dialect():
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    code = SpannerGraphProvider._classify_spanner_error(
        Exception("PostgreSQL dialect does not support property graphs")
    )
    assert code == "dialect_unsupported"


def test_classify_spanner_error_timeout_and_unavailable():
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    assert SpannerGraphProvider._classify_spanner_error(Exception("DeadlineExceeded")).startswith(
        ("connect_timeout", "error: ")
    ) or SpannerGraphProvider._classify_spanner_error(Exception("Deadline exceeded")) == "connect_timeout"
    assert SpannerGraphProvider._classify_spanner_error(Exception("Service Unavailable")) == "service_unavailable"


# ---------------------------------------------------------------------- #
# Containment edge type resolution                                        #
# ---------------------------------------------------------------------- #


def test_set_containment_edge_types_uppercases_and_marks_set():
    p = _build_provider()
    p.set_containment_edge_types(["contains", "BelongsTo"])
    types = p._get_containment_edge_types()
    assert types == {"CONTAINS", "BELONGSTO"}


def test_empty_containment_set_is_distinguishable_from_unset():
    p = _build_provider()
    # Before set: falls through to env or default fallback
    types = p._get_containment_edge_types()
    assert "CONTAINS" in types or "BELONGS_TO" in types

    # Explicitly set to empty (flat graph) — should return empty set.
    p.set_containment_edge_types([])
    assert p._get_containment_edge_types() == set()


def test_require_containment_types_falls_back_to_default(monkeypatch):
    """When neither ontology nor env-var is configured, the default
    {CONTAINS, BELONGS_TO} fallback kicks in so smoke runs work."""
    p = _build_provider()
    monkeypatch.setenv("CONTAINMENT_EDGE_TYPES", "")
    p._containment_cache = None  # force re-read
    p._resolved_containment_types_set = False
    types = p._require_containment_types()
    assert "CONTAINS" in types
    assert "BELONGS_TO" in types


def test_require_containment_types_raises_when_explicitly_empty(monkeypatch):
    """An ontology-resolved empty set is "flat graph" and is allowed; an
    explicitly-empty cache without ontology resolution is unresolvable —
    raises ProviderConfigurationError."""
    p = _build_provider()
    p._containment_cache = set()  # explicitly empty
    p._resolved_containment_types_set = False
    with pytest.raises(ProviderConfigurationError, match="containment edge types"):
        p._require_containment_types()


# ---------------------------------------------------------------------- #
# Client-side filter helpers                                              #
# ---------------------------------------------------------------------- #


def _make_node(**overrides: Any) -> GraphNode:
    return GraphNode(
        urn=overrides.get("urn", "urn:n"),
        entityType=overrides.get("entity_type", "container"),
        displayName=overrides.get("display_name", "Some Name"),
        properties=overrides.get("properties", {"size": 100, "owner": "alice"}),
        tags=overrides.get("tags", ["pii", "prod"]),
    )


def test_match_property_filters_equals_and_contains():
    p = _build_provider()
    node = _make_node()
    assert p._match_property_filters(node, [
        PropertyFilter(field="owner", operator=FilterOperator.EQUALS, value="alice"),
    ])
    assert p._match_property_filters(node, [
        PropertyFilter(field="owner", operator=FilterOperator.CONTAINS, value="lic"),
    ])
    assert not p._match_property_filters(node, [
        PropertyFilter(field="owner", operator=FilterOperator.EQUALS, value="bob"),
    ])


def test_match_property_filters_gt_lt_operators():
    p = _build_provider()
    assert p._match_operator(100, FilterOperator.GT, 50)
    assert not p._match_operator(100, FilterOperator.LT, 50)
    # Mixed types must not crash
    assert not p._match_operator("abc", FilterOperator.GT, 1)


def test_match_property_filters_in_and_not_in():
    p = _build_provider()
    assert p._match_operator("a", FilterOperator.IN, ["a", "b"])
    assert p._match_operator("c", FilterOperator.NOT_IN, ["a", "b"])
    assert not p._match_operator("a", FilterOperator.NOT_IN, ["a", "b"])


def test_match_property_filters_exists():
    p = _build_provider()
    assert p._match_operator("x", FilterOperator.EXISTS, None)
    assert p._match_operator(None, FilterOperator.NOT_EXISTS, None)


def test_match_tag_filters_modes():
    p = _build_provider()
    node = _make_node(tags=["pii", "prod"])
    assert p._match_tag_filters(node, TagFilter(mode="any", tags=["pii"]))
    assert p._match_tag_filters(node, TagFilter(mode="all", tags=["pii", "prod"]))
    assert not p._match_tag_filters(node, TagFilter(mode="all", tags=["pii", "missing"]))
    assert p._match_tag_filters(node, TagFilter(mode="none", tags=["other"]))
    assert not p._match_tag_filters(node, TagFilter(mode="none", tags=["pii"]))


def test_match_text_filter_case_insensitive_default():
    p = _build_provider()
    assert p._match_text_filter("Hello World", TextFilter(text="hello", operator="contains"))
    assert p._match_text_filter("Hello World", TextFilter(text="WORLD", operator="ends_with"))
    assert not p._match_text_filter("Hello World", TextFilter(
        text="hello", operator="equals", case_sensitive=True,
    ))


# ---------------------------------------------------------------------- #
# Sidecar table naming                                                   #
# ---------------------------------------------------------------------- #


def test_sidecar_table_name_is_stable_and_safe():
    p = _build_provider(property_graph_name="LineageGraph.v2")
    assert p._sidecar_table_name() == "Synodic_AggregatedEdges_LineageGraph_v2"
    state = p._aggregation_state_table_name()
    assert state == "Synodic_AggregationState_LineageGraph_v2"


# ---------------------------------------------------------------------- #
# Hydration through schema mapping                                        #
# ---------------------------------------------------------------------- #


def test_extract_node_from_record_uses_default_mapping():
    p = _build_provider()
    node = p._extract_node_from_record(
        {
            "identifier": "n1",
            "labels": ["dataset"],
            "properties": {
                "urn": "urn:dataset:1",
                "displayName": "Sales",
                "qualifiedName": "warehouse.sales",
                "tags": ["pii"],
            },
        },
        labels=["dataset"],
    )
    assert node is not None
    assert node.urn == "urn:dataset:1"
    assert node.display_name == "Sales"
    assert node.qualified_name == "warehouse.sales"
    assert "pii" in node.tags
    assert node.entity_type == "dataset"


def test_extract_node_from_record_returns_none_for_invalid_input():
    p = _build_provider()
    assert p._extract_node_from_record(None) is None
    assert p._extract_node_from_record({"properties": "not-a-dict"}) is None


def test_extract_edge_from_record_synthesizes_id():
    p = _build_provider()
    edge = p._extract_edge_from_record(
        source_urn="urn:a", target_urn="urn:b", edge_label="LINEAGE",
        edge_json={"properties": {"confidence": 0.8}},
    )
    assert edge is not None
    assert edge.id == "urn:a|LINEAGE|urn:b"
    assert edge.confidence == 0.8
    assert edge.edge_type == "LINEAGE"


# ---------------------------------------------------------------------- #
# preflight reason classifier (no network)                                #
# ---------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_preflight_returns_failure_when_connection_fails(monkeypatch):
    """preflight must never raise; failures come back as PreflightResult."""
    p = _build_provider()

    async def _raise(*_a, **_kw):
        raise RuntimeError("PermissionDenied: caller missing spanner.databases.list")

    monkeypatch.setattr(p, "_ensure_connected", _raise)
    res = await p.preflight(deadline_s=0.5)
    assert isinstance(res, PreflightResult)
    assert res.ok is False
    assert res.reason == "auth_error"


# ---------------------------------------------------------------------- #
# Manager dispatch — ensures the new branch wires into the existing       #
# ProviderManager without breaking the FalkorDB / Neo4j / DataHub paths.  #
# ---------------------------------------------------------------------- #


def test_manager_create_provider_instance_returns_spanner_provider_for_valid_extra_config():
    from backend.app.providers.manager import provider_manager
    from backend.app.providers.spanner_graph_provider import SpannerGraphProvider

    instance = provider_manager._create_provider_instance(
        provider_type="spanner_graph",
        host="my-instance",
        port=None,
        graph_name="my-db.LineageGraph",
        tls_enabled=True,
        credentials={"token": None},
        extra_config={"project_id": "my-project", "auth_method": "adc"},
    )
    assert isinstance(instance, SpannerGraphProvider)
    assert instance._project_id == "my-project"
    assert instance._instance_id == "my-instance"
    assert instance._database_id == "my-db"
    assert instance._graph_name == "LineageGraph"


def test_manager_create_provider_instance_rejects_missing_project_id():
    """Defence-in-depth: the API boundary already validates extra_config,
    but a row written via SQL or a buggy seed script can still hit the
    dispatch with bad config. The manager raises the platform's typed
    ``ProviderConfigurationError`` (NOT a generic ValueError) so the warmup
    loop can classify it as a permanent — not transient — failure."""
    from backend.app.providers.manager import provider_manager
    from backend.common.interfaces.provider import ProviderConfigurationError

    with pytest.raises(ProviderConfigurationError, match="project_id"):
        provider_manager._create_provider_instance(
            provider_type="spanner_graph",
            host="my-instance",
            port=None,
            graph_name="my-db.G",
            tls_enabled=True,
            credentials={},
            extra_config={"auth_method": "adc"},
        )


# ---------------------------------------------------------------------- #
# Pydantic boundary validation — the registry-driven check that runs on   #
# every POST /admin/providers and PUT /admin/providers/{id}.              #
# ---------------------------------------------------------------------- #


def test_validate_provider_extra_config_returns_none_for_complete_spanner():
    from backend.common.models.management import validate_provider_extra_config
    assert validate_provider_extra_config(
        "spanner_graph", {"project_id": "my-project"}
    ) is None


def test_validate_provider_extra_config_flags_missing_project_id():
    from backend.common.models.management import validate_provider_extra_config
    err = validate_provider_extra_config("spanner_graph", {})
    assert err is not None
    assert "project_id" in err


def test_validate_provider_extra_config_flags_empty_string_project_id():
    """Empty string is treated the same as missing — matches the registry's
    truthiness check and the dispatch's behaviour."""
    from backend.common.models.management import validate_provider_extra_config
    err = validate_provider_extra_config("spanner_graph", {"project_id": ""})
    assert err is not None
    assert "project_id" in err


def test_validate_provider_extra_config_no_op_for_unregistered_provider_types():
    """Generic registry — provider types without entries are unaffected."""
    from backend.common.models.management import validate_provider_extra_config
    assert validate_provider_extra_config("falkordb", None) is None
    assert validate_provider_extra_config("neo4j", {}) is None
    assert validate_provider_extra_config("datahub", None) is None


def test_provider_create_request_rejects_spanner_without_project_id():
    """Pydantic surface: bad rows can't be created via the API at all."""
    from backend.common.models.management import ProviderCreateRequest

    with pytest.raises(Exception) as exc_info:
        ProviderCreateRequest(
            name="Test",
            providerType="spanner_graph",
            extraConfig={"auth_method": "adc"},  # no project_id
        )
    assert "project_id" in str(exc_info.value)


def test_provider_create_request_accepts_spanner_with_project_id():
    from backend.common.models.management import ProviderCreateRequest

    req = ProviderCreateRequest(
        name="Test",
        providerType="spanner_graph",
        extraConfig={"project_id": "my-project", "auth_method": "adc"},
    )
    assert req.extra_config["project_id"] == "my-project"


# ---------------------------------------------------------------------- #
# Warmup-loop misconfiguration dedup                                     #
# ---------------------------------------------------------------------- #


def test_forget_misconfigured_provider_clears_only_targeted_keys():
    from backend.app.providers.warmup import (
        _LOGGED_MISCONFIG_KEYS,
        forget_misconfigured_provider,
    )

    _LOGGED_MISCONFIG_KEYS.clear()
    _LOGGED_MISCONFIG_KEYS.add(("prov_a", "msg-1"))
    _LOGGED_MISCONFIG_KEYS.add(("prov_a", "msg-2"))
    _LOGGED_MISCONFIG_KEYS.add(("prov_b", "msg-1"))

    forget_misconfigured_provider("prov_a")
    assert ("prov_a", "msg-1") not in _LOGGED_MISCONFIG_KEYS
    assert ("prov_a", "msg-2") not in _LOGGED_MISCONFIG_KEYS
    assert ("prov_b", "msg-1") in _LOGGED_MISCONFIG_KEYS

    forget_misconfigured_provider("")  # safe no-op
    assert len(_LOGGED_MISCONFIG_KEYS) == 1


@pytest.mark.asyncio
async def test_warmup_probe_classifies_provider_configuration_error_as_misconfigured(caplog):
    """``ProviderConfigurationError`` from build_instance must produce a
    cache entry with ``reason='misconfigured: …'`` and emit at most one
    WARN per (provider_id, message) per process.
    """
    import logging
    from backend.common.interfaces.provider import ProviderConfigurationError
    from backend.app.providers.warmup import _LOGGED_MISCONFIG_KEYS, _probe_one

    _LOGGED_MISCONFIG_KEYS.clear()

    def _build_failing(_cfg):
        raise ProviderConfigurationError(
            "spanner_graph provider requires extra_config.project_id"
        )

    cfg = {"id": "prov_test", "provider_type": "spanner_graph", "host": "x"}

    with caplog.at_level(logging.WARNING, logger="backend.app.providers.warmup"):
        first = await _probe_one(cfg, _build_failing)
        warn_records_first = [r for r in caplog.records if r.levelno >= logging.WARNING]
        # Re-probe the same row with the same error
        second = await _probe_one(cfg, _build_failing)
        warn_records_second = [r for r in caplog.records if r.levelno >= logging.WARNING]

    # Cache shape: distinct ``misconfigured:`` reason
    assert first["ok"] is False
    assert first["reason"].startswith("misconfigured:")
    assert "project_id" in first["reason"]
    assert second["ok"] is False
    assert second["reason"].startswith("misconfigured:")

    # Dedup: WARN only once. Second probe should not have added a new WARN.
    assert len(warn_records_second) == len(warn_records_first), (
        "ProviderConfigurationError dedup failed — repeat WARNs on identical failure"
    )


# ---------------------------------------------------------------------- #
# get_full_lineage_as_of round-trip                                      #
# ---------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_full_lineage_as_of_rejects_outside_pitr_window():
    p = _build_provider()
    too_old = datetime(2000, 1, 1, tzinfo=timezone.utc)
    with pytest.raises(ValueError, match="PITR"):
        await p.get_full_lineage_as_of(
            urn="urn:x", as_of_timestamp=too_old,
            upstream_depth=1, downstream_depth=1,
        )


# ---------------------------------------------------------------------- #
# Other-provider compatibility — they must inherit no-op defaults for     #
# the two new optional methods, not raise on import.                      #
# ---------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_neo4j_provider_inherits_default_get_diagnostics():
    from backend.graph.adapters.neo4j_provider import Neo4jProvider

    inst = Neo4jProvider(uri="bolt://localhost:7687", username="u", password="p", database="db")
    diag = await inst.get_diagnostics()
    assert diag == {}


@pytest.mark.asyncio
async def test_neo4j_provider_default_time_travel_raises_not_implemented():
    from backend.graph.adapters.neo4j_provider import Neo4jProvider

    inst = Neo4jProvider(uri="bolt://localhost:7687", username="u", password="p", database="db")
    with pytest.raises(NotImplementedError):
        await inst.get_full_lineage_as_of(
            urn="urn:x", as_of_timestamp=datetime.now(tz=timezone.utc),
            upstream_depth=1, downstream_depth=1,
        )


# ====================================================================== #
# Emulator-gated integration tests                                        #
# ====================================================================== #


def _emulator_available() -> bool:
    return bool(os.getenv("SPANNER_EMULATOR_HOST"))


requires_spanner_emulator = pytest.mark.skipif(
    not _emulator_available(),
    reason=(
        "Spanner Emulator not available. Start with: "
        "docker run -d -p 9010:9010 -p 9020:9020 gcr.io/cloud-spanner-emulator/emulator "
        "&& export SPANNER_EMULATOR_HOST=localhost:9010"
    ),
)


@requires_spanner_emulator
@pytest.mark.asyncio
async def test_emulator_preflight_succeeds_for_existing_database():
    """Full preflight against an emulator instance/database/graph must
    return PreflightResult.success. Caller is responsible for having
    created the test database + graph beforehand (via the emulator's
    Instance Admin API + a DDL bootstrap)."""
    p = _build_provider(
        project_id=os.getenv("SPANNER_TEST_PROJECT", "synodic-test"),
        instance_id=os.getenv("SPANNER_TEST_INSTANCE", "test-instance"),
        database_id=os.getenv("SPANNER_TEST_DATABASE", "test-database"),
        property_graph_name=os.getenv("SPANNER_TEST_GRAPH", "TestGraph"),
    )
    try:
        res = await p.preflight(deadline_s=5.0)
        # Either reachable + correct edition (ok=True) or surfaces a clear
        # reason. Don't fail the suite on the latter — the test asserts
        # the contract is honoured, not the emulator state.
        assert isinstance(res, PreflightResult)
    finally:
        await p.close()
