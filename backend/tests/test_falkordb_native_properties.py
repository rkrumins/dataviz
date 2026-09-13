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
    _node_from_props,
    _split_user_properties,
)


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

    def test_legacy_blob_is_no_longer_hydrated(self):
        """W1.3 (greenfield cleanup): the pre-refactor JSON blob on
        ``n.properties`` is no longer parsed by the read path. Pre-
        refactor nodes lose those properties until backfilled via
        ``backend/scripts/migrate_native_properties.py``. A one-time
        warning surfaces so operators notice."""
        node = _node_from_props({
            "urn": "urn:x", "displayName": "X",
            "properties": json.dumps({"logicalType": "STRING", "rowCount": 1000}),
        }, "schemaField")
        # The legacy-blob keys are NOT visible on the read path.
        assert node.properties == {}

    def test_native_properties_unaffected_by_legacy_blob(self):
        """Mid-migration nodes carry both — native fields are returned;
        the blob is ignored (no merge, no override needed)."""
        node = _node_from_props({
            "urn": "urn:x", "displayName": "X",
            "logicalType": "STRING_NEW",
            "properties": json.dumps({"logicalType": "STRING_OLD"}),
        }, "schemaField")
        assert node.properties["logicalType"] == "STRING_NEW"
        # Blob keys not in native stay invisible.
        assert "rowCount" not in node.properties

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

    def test_four_arg_calls_unchanged(self):
        """Existing 4-positional-arg call sites (no tags) must compile
        and behave exactly as before — ``tags`` is a new trailing
        keyword with default ``None``."""
        text = _compute_searchable_text(
            "Orders", "warehouse.public.orders", "Customer order events",
            {"sourceSystem": "snowflake"},
        )
        assert "orders" in text
        assert "snowflake" in text

    def test_tags_are_folded_in_lower_cased(self):
        text = _compute_searchable_text(
            "Orders", None, None, None, tags=["PII", "GDPR"],
        )
        assert "pii" in text
        assert "gdpr" in text

    def test_tags_as_json_string_are_parsed(self):
        """Tags stored on a node are a JSON-encoded string at some call
        sites (e.g. the migration backfill reading ``n.tags`` back off
        a FalkorDB node) — parse it the same as a native list."""
        text = _compute_searchable_text(
            None, None, None, None, tags=json.dumps(["PII", "GDPR"]),
        )
        assert "pii" in text
        assert "gdpr" in text

    def test_tags_ignored_when_not_list_or_str(self):
        text = _compute_searchable_text("X", None, None, None, tags=123)
        assert text == "x"

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
