"""
Tests for the native-property storage refactor in FalkorDBProvider.

Pre-refactor: ``node.properties`` was JSON-stringified into a single
``n.properties`` field on each FalkorDB node. Post-refactor: each scalar
user-property becomes a real FalkorDB property (so it's indexable and
Cypher-queryable). Non-scalar values fall back to a ``n.propertiesRaw``
JSON blob. See backend/scripts/migrate_native_properties.py for the
backfill.

Pure-unit tests cover the split/reconstruct helpers and run without a
FalkorDB. Round-trip tests require a live FalkorDB and are skipped when
one isn't available.
"""

import json
import os

import pytest
import pytest_asyncio

from backend.app.providers.falkordb_provider import (
    _RESERVED_NODE_KEYS,
    _compute_searchable_text,
    _edge_from_row,
    _node_from_props,
    _split_user_properties,
)
from backend.app.providers.property_shapes import (
    coerce_container,
    coerce_tags,
    flatten_properties,
)
from backend.graph.adapters.schema_mapping import SchemaMapping


# ---------------------------------------------------------------------------
# Pure unit tests — _split_user_properties
# ---------------------------------------------------------------------------

class TestSplitUserProperties:
    def test_empty_input(self):
        native, residual = _split_user_properties({})
        assert native == {}
        assert residual == "{}"

    def test_none_input(self):
        native, residual = _split_user_properties(None)
        assert native == {}
        assert residual == "{}"

    def test_scalars_go_native(self):
        native, residual = _split_user_properties({
            "stringVal": "hello",
            "intVal": 42,
            "floatVal": 3.14,
            "boolVal": True,
        })
        assert native == {
            "stringVal": "hello", "intVal": 42,
            "floatVal": 3.14, "boolVal": True,
        }
        assert residual == "{}"

    def test_flat_string_list_goes_native(self):
        # NOTE: "tags" is a reserved node key — use a non-reserved name.
        native, residual = _split_user_properties({"owners": ["a", "b", "c"]})
        assert native == {"owners": ["a", "b", "c"]}
        assert residual == "{}"

    def test_flat_mixed_scalar_list_goes_native(self):
        native, residual = _split_user_properties(
            {"mixedList": ["a", 1, True, 2.5]}
        )
        assert native == {"mixedList": ["a", 1, True, 2.5]}
        assert residual == "{}"

    def test_nested_dict_goes_residual(self):
        native, residual = _split_user_properties(
            {"meta": {"author": "alice", "version": 1}}
        )
        assert native == {}
        assert json.loads(residual) == {"meta": {"author": "alice", "version": 1}}

    def test_list_of_dicts_goes_residual(self):
        native, residual = _split_user_properties(
            {"events": [{"ts": 1}, {"ts": 2}]}
        )
        assert native == {}
        assert json.loads(residual) == {"events": [{"ts": 1}, {"ts": 2}]}

    def test_mixed_native_and_residual(self):
        native, residual = _split_user_properties({
            "logicalType": "STRING",
            "rowCount": 1000,
            "meta": {"owner": "alice"},
        })
        assert native == {"logicalType": "STRING", "rowCount": 1000}
        assert json.loads(residual) == {"meta": {"owner": "alice"}}

    def test_none_value_dropped(self):
        native, residual = _split_user_properties({
            "kept": "yes",
            "dropped": None,
        })
        assert native == {"kept": "yes"}
        assert "dropped" not in json.loads(residual)

    def test_reserved_key_collision_dropped(self, caplog):
        # User can't accidentally clobber a provider-owned field.
        native, residual = _split_user_properties({
            "urn": "evil-overwrite",
            "level": 99,
            "displayName": "tampered",
            "legitProp": "kept",
        })
        assert native == {"legitProp": "kept"}
        assert json.loads(residual) == {}
        assert "collided with reserved node keys" in caplog.text

    def test_reserved_set_includes_essentials(self):
        # Catches refactors that accidentally remove a reserved key.
        for k in (
            "urn", "entityType", "displayName", "qualifiedName",
            "description", "tags", "layerAssignment", "childCount",
            "sourceSystem", "lastSyncedAt", "level", "levelDigest",
            "properties", "propertiesRaw",
        ):
            assert k in _RESERVED_NODE_KEYS


# ---------------------------------------------------------------------------
# Pure unit tests — _node_from_props (read-path reconstruction)
# ---------------------------------------------------------------------------

class TestNodeFromProps:
    def test_minimal_node(self):
        node = _node_from_props({"urn": "urn:x", "displayName": "X"}, "domain")
        assert node is not None
        assert node.urn == "urn:x"
        assert node.display_name == "X"
        assert node.entity_type == "domain"
        assert node.properties == {}

    def test_missing_urn_returns_none(self):
        assert _node_from_props({"displayName": "X"}, "domain") is None

    def test_native_properties_collected_from_top_level(self):
        # Post-refactor shape: user props live as top-level FalkorDB fields.
        node = _node_from_props({
            "urn": "urn:x", "displayName": "X",
            "logicalType": "STRING", "rowCount": 1000,
        }, "schemaField")
        assert node.properties == {"logicalType": "STRING", "rowCount": 1000}

    def test_container_is_hydrated_and_flattened(self):
        """Supersedes ``test_legacy_blob_is_no_longer_hydrated``.

        W1.3 stopped parsing the ``n.properties`` container on the
        assumption operators would run the backfill script. That left the
        Properties panel EMPTY meanwhile, and could never help a graph
        whose container is named something else. The container is read
        again — flattened, and at the LOWEST priority."""
        node = _node_from_props({
            "urn": "urn:x", "displayName": "X",
            "properties": json.dumps({"logicalType": "STRING", "rowCount": 1000}),
        }, "schemaField")
        assert node.properties == {"logicalType": "STRING", "rowCount": 1000}

    def test_container_nesting_becomes_folder_paths(self):
        """Nested dicts flatten to ``parent/child`` — a real indexable
        FalkorDB key that PropertyEditor's groupByPath renders as a folder."""
        node = _node_from_props({
            "urn": "urn:x",
            "properties": json.dumps({
                "technical": {"format": "parquet", "cols": [1, 2]},
                "owner": "team",
            }),
        }, "dataset")
        assert node.properties == {
            "technical/format": "parquet",
            "technical/cols": [1, 2],
            "owner": "team",
        }

    def test_native_properties_win_over_container(self):
        """Mid-migration nodes carry both. Native fields are the source of
        truth and must override the stale container copy, so already-migrated
        data is never affected by the fallback."""
        node = _node_from_props({
            "urn": "urn:x", "displayName": "X",
            "logicalType": "STRING_NEW",
            "properties": json.dumps({
                "logicalType": "STRING_OLD", "rowCount": 1000,
            }),
        }, "schemaField")
        assert node.properties["logicalType"] == "STRING_NEW"
        # Container-only keys still surface — that's the whole point.
        assert node.properties["rowCount"] == 1000

    def test_residual_blob_merged(self):
        # Non-scalar user values live in propertiesRaw.
        node = _node_from_props({
            "urn": "urn:x", "displayName": "X",
            "logicalType": "STRING",
            "propertiesRaw": json.dumps({"meta": {"author": "alice"}}),
        }, "schemaField")
        assert node.properties == {
            "logicalType": "STRING",
            "meta": {"author": "alice"},
        }

    def test_invalid_legacy_blob_does_not_crash(self):
        node = _node_from_props({
            "urn": "urn:x", "displayName": "X",
            "properties": "this is not json",
            "logicalType": "STRING",
        }, "schemaField")
        assert node is not None
        # Native still recovered; bad blob silently skipped.
        assert node.properties == {"logicalType": "STRING"}

    def test_residual_wins_over_container(self):
        """Full priority order: container < native < propertiesRaw."""
        node = _node_from_props({
            "urn": "urn:x",
            "properties": json.dumps({"a": "from-container", "b": "from-container"}),
            "a": "from-native",
            "propertiesRaw": json.dumps({"b": "from-residual"}),
        }, "dataset")
        assert node.properties == {"a": "from-native", "b": "from-residual"}

    def test_reserved_fields_excluded_from_properties(self):
        # The user `properties` dict must not contain provider-owned fields.
        node = _node_from_props({
            "urn": "urn:x",
            "displayName": "X",
            "qualifiedName": "x.y.z",
            "level": 2,
            "layerAssignment": "Source",
            "logicalType": "STRING",
            "sourceSystem": "snowflake",
        }, "schemaField")
        assert node.properties == {"logicalType": "STRING"}
        assert node.display_name == "X"
        assert node.qualified_name == "x.y.z"
        assert node.layer_assignment == "Source"
        assert node.source_system == "snowflake"


# ---------------------------------------------------------------------------
# Pure unit tests — property_shapes transforms
# ---------------------------------------------------------------------------

class TestCoerceContainer:
    def test_json_string(self):
        assert coerce_container('{"a": 1}') == {"a": 1}

    def test_native_map(self):
        assert coerce_container({"a": 1}) == {"a": 1}

    def test_empty_object_is_not_none(self):
        """``{}`` (parsed, empty) must be distinguishable from ``None``
        (unparseable) — the migration's REMOVE hinges on the difference."""
        assert coerce_container("{}") == {}
        assert coerce_container("{}") is not None

    def test_non_dict_json_returns_none(self):
        # A JSON array parses fine but is not a property container.
        assert coerce_container("[1, 2]") is None
        assert coerce_container("null") is None
        assert coerce_container('"a string"') is None

    def test_malformed_returns_none(self):
        assert coerce_container("not json at all") is None

    def test_empty_and_missing_return_none(self):
        assert coerce_container("") is None
        assert coerce_container(None) is None
        assert coerce_container(42) is None


class TestFlattenProperties:
    def test_nested_dicts_become_paths(self):
        assert flatten_properties({"a": {"b": {"c": 1}}}) == {"a/b/c": 1}

    def test_scalar_list_stays_at_its_path(self):
        # FalkorDB stores flat scalar lists natively — already indexable.
        assert flatten_properties({"a": {"tags": [1, 2]}}) == {"a/tags": [1, 2]}

    def test_list_of_dicts_stays_at_its_path(self):
        out = flatten_properties({"hist": [{"x": 1}]})
        assert out == {"hist": [{"x": 1}]}

    def test_empty_dict_is_preserved_as_a_value(self):
        # Descending into {} would lose the key entirely.
        assert flatten_properties({"a": {}}) == {"a": {}}

    def test_depth_cap_leaves_remainder_intact(self):
        deep = {"l1": {"l2": {"l3": "v"}}}
        assert flatten_properties(deep, max_depth=2) == {"l1/l2": {"l3": "v"}}

    def test_custom_separator(self):
        assert flatten_properties({"a": {"b": 1}}, separator=".") == {"a.b": 1}

    def test_key_already_containing_separator_kept_verbatim(self):
        assert flatten_properties({"a/b": 1}) == {"a/b": 1}

    def test_non_mapping_input(self):
        assert flatten_properties(None) == {}
        assert flatten_properties("nope") == {}


class TestCoerceTags:
    def test_plain_string_is_a_single_tag(self):
        """The regression that mattered: this used to raise inside
        ``_node_from_props``, whose broad ``except`` then dropped the
        ENTIRE node from every read."""
        assert coerce_tags("production") == ["production"]

    def test_json_array(self):
        assert coerce_tags('["a", "b"]') == ["a", "b"]

    def test_native_list(self):
        assert coerce_tags(["a"]) == ["a"]

    def test_malformed_array_is_empty_not_raising(self):
        assert coerce_tags("[oops") == []

    def test_empty_inputs(self):
        assert coerce_tags(None) == []
        assert coerce_tags("") == []
        assert coerce_tags("   ") == []


# ---------------------------------------------------------------------------
# Mapping-driven read path — onboarded third-party graph shapes
# ---------------------------------------------------------------------------

class TestMappedNodeReads:
    def test_container_under_a_foreign_key(self):
        """The case the migration script can never fix: the container is
        not named ``properties``, so the script's WHERE never matches it."""
        mapping = SchemaMapping(properties_field="attributes")
        node = _node_from_props({
            "urn": "urn:x",
            "attributes": json.dumps({"owner": {"team": "data"}}),
        }, "dataset", mapping)
        assert node.properties == {"owner/team": "data"}

    def test_container_as_a_native_map(self):
        node = _node_from_props({
            "urn": "urn:x", "properties": {"x": {"y": 2}},
        }, "dataset")
        assert node.properties == {"x/y": 2}

    def test_unparseable_container_yields_no_properties_but_keeps_the_node(self):
        node = _node_from_props({
            "urn": "urn:x", "properties": "[1,2,3]",
        }, "dataset")
        assert node is not None
        assert node.properties == {}

    def test_custom_separator_from_mapping(self):
        mapping = SchemaMapping(properties_separator=".")
        node = _node_from_props({
            "urn": "urn:x", "properties": json.dumps({"a": {"b": 1}}),
        }, "dataset", mapping)
        assert node.properties == {"a.b": 1}

    def test_collect_unmapped_false_hides_physical_noise(self):
        """A foreign graph's internal fields (``_id``, ``__typename``) would
        otherwise leak into the Properties panel — the same class of leak
        that forced ``entityId``/``searchableText`` into the reserved set."""
        mapping = SchemaMapping(collect_unmapped_as_properties=False)
        node = _node_from_props({
            "urn": "urn:x", "_id": "internal", "__typename": "Dataset",
            "properties": json.dumps({"real": 1}),
        }, "dataset", mapping)
        assert node.properties == {"real": 1}

    def test_reserved_key_collision_is_rescued_by_override(self):
        """A source field named ``level`` is shadowed on read and deleted on
        write. An explicit override moves it somewhere safe instead."""
        mapping = SchemaMapping(property_overrides={"level": "source/level"})
        node = _node_from_props({
            "urn": "urn:x", "level": "tier-1",
        }, "dataset", mapping)
        assert node.properties == {"source/level": "tier-1"}

    def test_override_does_not_clobber_the_platform_value(self):
        mapping = SchemaMapping(property_overrides={"level": "existing"})
        node = _node_from_props({
            "urn": "urn:x", "level": 2, "existing": "keep-me",
        }, "dataset", mapping)
        assert node.properties["existing"] == "keep-me"

    def test_empty_container_does_not_warn(self, caplog):
        """A node whose container is empty has nothing trapped in it. Warning
        would send an operator to align a graph with nothing to unpack."""
        import backend.app.providers.falkordb_provider as provider_module
        provider_module._logged_legacy_blob = False
        with caplog.at_level("WARNING"):
            node = _node_from_props({
                "urn": "urn:x", "properties": "{}", "owner": "team",
            }, "dataset")
        assert node.properties == {"owner": "team"}
        assert not any("nested under" in r.message for r in caplog.records)

    def test_populated_container_still_warns(self, caplog):
        import backend.app.providers.falkordb_provider as provider_module
        provider_module._logged_legacy_blob = False
        with caplog.at_level("WARNING"):
            _node_from_props({
                "urn": "urn:x", "properties": json.dumps({"a": 1}),
            }, "dataset")
        assert any("nested under" in r.message for r in caplog.records)

    def test_unreadable_container_does_not_warn(self, caplog):
        """Nothing was hydrated, so there is nothing to tell the operator
        about unpacking — the value is preserved untouched either way."""
        import backend.app.providers.falkordb_provider as provider_module
        provider_module._logged_legacy_blob = False
        with caplog.at_level("WARNING"):
            _node_from_props({"urn": "urn:x", "properties": "not json"}, "dataset")
        assert not any("nested under" in r.message for r in caplog.records)

    def test_container_key_never_leaks_as_a_property(self):
        """Even a non-default container name must not show up as a property
        row — it is structure, not data."""
        mapping = SchemaMapping(properties_field="attributes")
        node = _node_from_props({
            "urn": "urn:x", "attributes": json.dumps({"a": 1}),
        }, "dataset", mapping)
        assert "attributes" not in node.properties


class TestMappedEdgeReads:
    def test_native_edge_properties_are_collected(self):
        """The node bug, mirrored: ``_edge_from_row`` read ONLY the
        container key, so a graph storing edge properties as ordinary
        fields returned ``{}`` for every edge."""
        edge = _edge_from_row("a", "b", "TRANSFORMS", {
            "id": "e1", "confidence": 0.9,
            "discoveredBy": "auto", "score": 3,
        })
        assert edge.properties == {"discoveredBy": "auto", "score": 3}
        assert edge.confidence == 0.9
        assert edge.id == "e1"

    def test_container_still_works_and_flattens(self):
        edge = _edge_from_row("a", "b", "T", {
            "properties": json.dumps({"n": {"d": 1}}),
        })
        assert edge.properties == {"n/d": 1}

    def test_malformed_container_does_not_raise(self):
        # Previously an unguarded json.loads — one bad edge took down the
        # whole read.
        edge = _edge_from_row("a", "b", "T", {"properties": "NOT JSON"})
        assert edge.properties == {}

    def test_reserved_edge_fields_excluded(self):
        edge = _edge_from_row("a", "b", "AGGREGATED", {
            "weight": 5, "aggKey": "k", "sourceLevel": 1, "targetLevel": 2,
            "realProp": "keep",
        })
        assert edge.properties == {"realProp": "keep"}

    def test_edge_id_falls_back_to_composite(self):
        edge = _edge_from_row("a", "b", "T", {})
        assert edge.id == "a|T|b"


# ---------------------------------------------------------------------------
# Round-trip integration tests against a live FalkorDB
# ---------------------------------------------------------------------------

def _falkordb_available() -> bool:
    """Returns True only if FalkorDB's graph module is loaded — not just
    that some Redis on the port answers PING. A plain Redis with the
    `falkordb` Python client installed will pass PING but then fail
    every GRAPH.* command later, which produces a confusing fixture
    error instead of a clean skip.
    """
    try:
        import falkordb  # noqa: F401
        import redis
        r = redis.Redis(
            host=os.getenv("FALKORDB_HOST", "localhost"),
            port=int(os.getenv("FALKORDB_PORT", "6379")),
            socket_connect_timeout=2,
        )
        # MODULE LIST returns the loaded Redis modules. Absence of "graph"
        # means we're talking to plain Redis, not FalkorDB.
        modules = r.execute_command("MODULE", "LIST") or []
        has_graph = any(
            (b"graph" in m if isinstance(m, bytes) else "graph" in str(m).lower())
            for entry in modules
            for m in (entry if isinstance(entry, (list, tuple)) else [entry])
        )
        r.close()
        return has_graph
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Pure unit tests — _compute_searchable_text (W1.3)
# ---------------------------------------------------------------------------


class TestComputeSearchableText:
    """``searchableText`` is the denormalised column ``target='any'``
    text search hits. It joins displayName + qualifiedName +
    description + every string-valued user property, lowercased.
    Bounded by ``DEEP_SEARCH_SEARCHABLE_TEXT_CAP`` so a node with
    very large string properties cannot bloat storage."""

    def test_includes_property_values(self):
        text = _compute_searchable_text(
            "Orders", "warehouse.public.orders", "Customer order events",
            {"sourceSystem": "snowflake", "owner": "data-platform"},
        )
        # All four sources collapsed + lowercased.
        assert "orders" in text
        assert "warehouse.public.orders" in text
        assert "customer order events" in text
        assert "snowflake" in text
        assert "data-platform" in text

    def test_skips_non_string_property_values(self):
        text = _compute_searchable_text(
            "X", None, None,
            {"rowCount": 1_000_000, "active": True, "name": "Orders"},
        )
        # Only the string property contributes.
        assert "orders" in text
        assert "1000000" not in text
        assert "true" not in text

    def test_empty_inputs_return_empty(self):
        assert _compute_searchable_text(None, None, None, None) == ""
        assert _compute_searchable_text("", "", "", {}) == ""

    def test_truncates_at_word_boundary_below_cap(self, monkeypatch):
        """When the result exceeds the cap, the helper trims to the
        last word boundary so the tail never ends mid-token (a
        partial token would defeat ``CONTAINS '<word>'`` substring
        search downstream)."""
        from backend.app.services.deep_search import get_deep_search_settings
        monkeypatch.setenv("DEEP_SEARCH_SEARCHABLE_TEXT_CAP", "20")
        get_deep_search_settings.cache_clear()

        text = _compute_searchable_text(
            "First word boundary", None, None,
            {"extra": "rest of the string that should be dropped"},
        )
        assert len(text) <= 20
        # Last char must be neither mid-token nor a trailing space.
        assert not text.endswith(" ")
        # Verify the trim happened at a space, not mid-word.
        full = "First word boundary rest of the string that should be dropped".lower()
        # The result should be a prefix of the full string up to a space.
        assert full.startswith(text)
        assert text == "" or full[len(text)] == " "


skip_if_no_falkordb = pytest.mark.skipif(
    not _falkordb_available(),
    reason=(
        "FalkorDB not available "
        "(start with: docker run -p 6379:6379 falkordb/falkordb)"
    ),
)


@pytest_asyncio.fixture
async def fresh_provider():
    """A fresh FalkorDB provider on an isolated graph name, torn down after."""
    from backend.app.providers.falkordb_provider import FalkorDBProvider

    graph_name = f"test_native_props_{os.getpid()}"
    provider = FalkorDBProvider(
        host=os.getenv("FALKORDB_HOST", "localhost"),
        port=int(os.getenv("FALKORDB_PORT", "6379")),
        graph_name=graph_name,
    )
    await provider._ensure_connected()
    yield provider
    try:
        await provider._graph.delete()
    except Exception:
        pass


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_round_trip_native_properties(fresh_provider):
    """save_custom_graph → get_node preserves a mix of scalar + nested props."""
    from backend.app.models.graph import GraphNode

    node = GraphNode(
        urn="urn:test:dataset:1",
        entityType="dataset",
        displayName="customers",
        properties={
            "logicalType": "TABLE",
            "rowCount": 1_000_000,
            "isPii": True,
            "tagsList": ["PII", "GDPR"],
            "meta": {"owner": "alice", "version": 2},  # → residual
        },
        tags=["PII"],
    )
    ok = await fresh_provider.save_custom_graph([node], [])
    assert ok

    loaded = await fresh_provider.get_node("urn:test:dataset:1")
    assert loaded is not None
    assert loaded.urn == "urn:test:dataset:1"
    assert loaded.display_name == "customers"
    assert loaded.properties["logicalType"] == "TABLE"
    assert loaded.properties["rowCount"] == 1_000_000
    assert loaded.properties["isPii"] is True
    assert loaded.properties["tagsList"] == ["PII", "GDPR"]
    assert loaded.properties["meta"] == {"owner": "alice", "version": 2}


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_native_property_queryable_in_cypher(fresh_provider):
    """A scalar user-property is reachable via direct Cypher — the whole
    point of the refactor. Pre-refactor the only way to query it was a
    Python post-filter."""
    from backend.app.models.graph import GraphNode

    nodes = [
        GraphNode(urn=f"urn:t:{i}", entityType="dataset",
                  displayName=f"d{i}",
                  properties={"logicalType": "TABLE" if i % 2 == 0 else "VIEW"})
        for i in range(10)
    ]
    await fresh_provider.save_custom_graph(nodes, [])

    # Direct native predicate, no Python post-filter. If this returns 0,
    # the write path is still storing as a blob.
    result = await fresh_provider._ro_query(
        "MATCH (n:dataset) WHERE n.logicalType = $lt RETURN count(n) AS c",
        params={"lt": "TABLE"},
    )
    rs = getattr(result, "result_set", None) or []
    assert rs and int(rs[0][0]) == 5


@pytest.mark.asyncio
@skip_if_no_falkordb
async def test_legacy_blob_stripped_on_write(fresh_provider):
    """An upsert removes the legacy n.properties blob — the read-path
    transitional code becomes dead weight as soon as a node is touched."""
    from backend.app.models.graph import GraphNode

    node = GraphNode(
        urn="urn:strip:1",
        entityType="dataset",
        displayName="d",
        properties={"logicalType": "TABLE"},
    )
    await fresh_provider.save_custom_graph([node], [])

    result = await fresh_provider._ro_query(
        "MATCH (n:dataset {urn: $urn}) "
        "RETURN n.properties AS legacyBlob, n.logicalType AS native",
        params={"urn": "urn:strip:1"},
    )
    rs = getattr(result, "result_set", None) or []
    assert rs
    legacy_blob, native = rs[0][0], rs[0][1]
    assert legacy_blob is None, (
        f"legacy n.properties blob was not stripped: {legacy_blob!r}"
    )
    assert native == "TABLE"
