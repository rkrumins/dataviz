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


# ---------------------------------------------------------------------------
# The native property budget — _admit_native_keys, and the writers that
# apply it: save_custom_graph, create_node and the versioning projector.
#
# FalkorDB numbers property names with a 16-bit id per graph and never frees
# one. A source whose nodes carry thousands of per-node metadata keys spent
# a 241k-node graph's 65,533 ids on keys that appear once, after which the
# rollups could be neither written nor indexed. The budget keeps the names
# that carry the graph native and stores the long tail as values.
# ---------------------------------------------------------------------------

import asyncio
import types

from backend.app.providers.falkordb_provider import (
    _NATIVE_PROPERTY_BUDGET_DEFAULT,
    AttributeNameLimitReached,
    FalkorDBProvider,
    _admit_native_keys,
    _native_property_budget,
)
from backend.common.models.graph import GraphNode


class TestAdmitNativeKeys:
    def test_registered_names_stay_native_whatever_the_budget(self):
        """A name the graph already holds has spent its id, and flipping its
        storage form would leave a native value under a blob value — the one
        state a search predicate then matches wrongly."""
        native, demoted = _admit_native_keys(
            [{"a": 1, "b": 2}], registered={"a", "urn"}, budget=2,
        )
        assert "a" in native
        assert demoted == ["b"]

    def test_the_reserve_is_always_native(self):
        native, demoted = _admit_native_keys(
            [{"id": "x", "zzz": 1}], registered=set(), budget=1, reserve=("id", ""),
        )
        assert "id" in native
        assert demoted == ["zzz"]

    def test_keys_are_admitted_by_how_many_nodes_carry_them_then_by_name(self):
        rows = [{"common": 1, "rare_b": 1}, {"common": 1, "rare_a": 1}, {"common": 1}]
        native, demoted = _admit_native_keys(rows, registered=set(), budget=2)
        assert native == {"common", "rare_a"}
        assert demoted == ["rare_b"]

    def test_values_that_cannot_be_native_take_no_slot(self):
        native, demoted = _admit_native_keys(
            [{"nested": {"x": 1}, "flat": 1, "none": None, "urn": "u"}],
            registered=set(), budget=1,
        )
        assert native == {"flat"}
        assert demoted == []

    def test_a_full_budget_demotes_every_new_key_most_common_first(self):
        rows = [{"p": 1, "q": 1}, {"p": 1}]
        native, demoted = _admit_native_keys(rows, registered={"x"}, budget=1)
        assert native == {"x"}
        assert demoted == ["p", "q"]

    def test_the_budget_env_is_clamped_and_defaults(self, monkeypatch):
        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "10")
        assert _native_property_budget() == 100
        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "nope")
        assert _native_property_budget() == 50_000
        monkeypatch.delenv("FALKORDB_NATIVE_PROPERTY_BUDGET")
        assert _native_property_budget() == 50_000


class TestSplitUnderBudget:
    def test_a_scalar_outside_the_native_set_is_stored_as_a_value(self):
        native, residual = _split_user_properties(
            {"keep": 1, "drop": "v", "nested": {"a": 1}}, native_keys={"keep"},
        )
        assert native == {"keep": 1}
        assert json.loads(residual) == {"drop": "v", "nested": {"a": 1}}

    def test_no_native_set_means_the_split_it_always_was(self):
        native, residual = _split_user_properties({"a": 1, "b": [1, 2]})
        assert native == {"a": 1, "b": [1, 2]}
        assert residual == "{}"

    def test_the_properties_panel_still_sees_a_demoted_key(self):
        native, residual = _split_user_properties(
            {"keep": 1, "drop": "v"}, native_keys={"keep"},
        )
        node = _node_from_props(
            {"urn": "urn:x", "displayName": "X", **native, "propertiesRaw": residual},
            "T",
        )
        assert node.properties == {"keep": 1, "drop": "v"}


def _stubbed_provider(registered):
    """A provider whose graph reads answer from ``registered`` and whose
    writes are recorded — enough to see what save_custom_graph and
    create_node put on the wire."""
    p = FalkorDBProvider(host="x", graph_name="g")
    p._entity_type_levels = {}
    calls = {"batches": [], "queries": []}

    async def _ensure_connected():
        return None

    async def _type_casing_maps():
        return {}, {}

    async def _query(cypher, params=None, **kw):
        calls["queries"].append((cypher, params))
        if "db.propertyKeys" in cypher:
            return types.SimpleNamespace(result_set=[[n] for n in sorted(registered)])
        return types.SimpleNamespace(result_set=[])

    async def ensure_indices(labels):
        return None

    async def _bulk_write_batch(cypher, params, *, what):
        calls["batches"].append((cypher, params))

    async def _cache_urn_labels_bulk(mapping):
        return None

    async def _cache_urn_label(urn, label):
        return None

    async def _resolve_urn_labels_bulk(urns):
        return {}

    p._ensure_connected = _ensure_connected
    p._type_casing_maps = _type_casing_maps
    p._query = _query
    p.ensure_indices = ensure_indices
    p._bulk_write_batch = _bulk_write_batch
    p._cache_urn_labels_bulk = _cache_urn_labels_bulk
    p._cache_urn_label = _cache_urn_label
    p._resolve_urn_labels_bulk = _resolve_urn_labels_bulk
    return p, calls


def _node(urn, props):
    return GraphNode(urn=urn, entityType="Table", displayName=urn, properties=props)


def _platform_names():
    """Every property name the platform owns, from the modules that define
    them — the materializer's three sets, the provider's reserved node keys
    and the four names that live nowhere else."""
    from backend.app.providers import falkordb_materialize as mat

    return (
        set(_RESERVED_NODE_KEYS)
        | set(mat._ROLLUP_ATTRIBUTE_NAMES)
        | set(mat._META_ATTRIBUTE_NAMES)
        | set(mat._PROJECTION_NODE_ATTRIBUTE_NAMES)
        | set(fp._PROJECTOR_ATTRIBUTE_NAMES)
    )


def _graph_of(n):
    """A graph holding ``n`` registered names, the platform's own among them
    — so the reserve no-ops and the budget arithmetic below is about the
    user's keys, which is what these tests are about."""
    platform = _platform_names()
    return platform | {f"filler{i}" for i in range(n - len(platform))}


class TestWritersUnderBudget:
    def test_save_custom_graph_keeps_the_common_keys_and_stores_the_long_tail(
        self, monkeypatch, caplog,
    ):
        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "100")
        p, calls = _stubbed_provider(_graph_of(90))
        room = 100 - 90 - len(p._native_key_reserve())
        assert room >= 2
        tail = [f"k{i:02d}" for i in range(12)]
        nodes = [_node(f"urn:{i}", {"owner": "x", tail[i]: i}) for i in range(12)]

        with caplog.at_level("WARNING"):
            assert asyncio.run(p.save_custom_graph(nodes, []))

        # One read of the graph's names, on the write node.
        assert sum(1 for c, _ in calls["queries"] if "db.propertyKeys" in c) == 1
        items = [it for _, params in calls["batches"] for it in params["batch"]]
        assert len(items) == 12
        native_seen = set().union(*(it["nativeProps"].keys() for it in items))
        # owner is on every node → first in; then the tail by name until full.
        assert native_seen == {"owner", *tail[:room - 1]}
        for it in items:
            blob = json.loads(it["propertiesRaw"])
            for k, v in blob.items():
                assert k in tail[room - 1:] and k not in it["nativeProps"]
        assert any(
            "stored as values in propertiesRaw" in r.getMessage() for r in caplog.records
        )

    def test_a_registered_name_stays_native_on_a_full_graph(self, monkeypatch):
        """The user's graph: every id spent. Nothing already native may move
        to the blob, and nothing new may be registered."""
        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "100")
        p, calls = _stubbed_provider(_graph_of(100) | {"owner"})
        nodes = [_node("urn:1", {"owner": "x", "brand_new": 1})]
        asyncio.run(p.save_custom_graph(nodes, []))
        (item,) = [it for _, params in calls["batches"] for it in params["batch"]]
        assert item["nativeProps"] == {"owner": "x"}
        assert json.loads(item["propertiesRaw"]) == {"brand_new": 1}

    def test_edges_alone_read_no_names(self):
        p, calls = _stubbed_provider(set())
        asyncio.run(p.save_custom_graph([], []))
        assert not any("db.propertyKeys" in c for c, _ in calls["queries"])

    def test_create_node_reuses_its_reading_and_counts_what_it_admitted(
        self, monkeypatch,
    ):
        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "100")
        p, calls = _stubbed_provider(_graph_of(90))
        room = 100 - 90 - len(p._native_key_reserve())
        first = {f"a{i}": i for i in range(room)}            # fills the budget
        asyncio.run(p.create_node(_node("urn:1", first)))
        asyncio.run(p.create_node(_node("urn:2", {**first, "late": 1})))
        assert sum(1 for c, _ in calls["queries"] if "db.propertyKeys" in c) == 1
        merges = [params for c, params in calls["queries"] if "MERGE (n:" in c]
        assert set(merges[0]["p"]) >= set(first)
        # The second node's keys were admitted by the first write and stay
        # native; the newcomer has no room and is stored as a value.
        assert set(first) <= set(merges[1]["p"])
        assert "late" not in merges[1]["p"]
        assert json.loads(merges[1]["p"]["propertiesRaw"]) == {"late": 1}


class TestProjectorUnderBudget:
    def test_a_seed_spends_the_same_budget_as_a_direct_load(self, monkeypatch, caplog):
        """A versioned graph and a direct-load graph must spend their
        attribute ids the same way: the projector is the writer behind the
        one in-product recreate (Data health → Rebuild)."""
        from backend.app.services.versioning import projection as proj

        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "100")

        class Client:
            def __init__(self):
                self.calls = []

            async def query(self, cypher, params=None, timeout=None):
                self.calls.append((cypher, params))
                if "db.propertyKeys" in cypher:
                    return types.SimpleNamespace(
                        result_set=[[n] for n in sorted(_graph_of(96))]
                    )
                return types.SimpleNamespace(result_set=[])

        client = Client()
        projector = proj.FalkorProjector.__new__(proj.FalkorProjector)
        projector._batch = 1000
        upserts = [
            ("e1", "urn:1", {"entityType": "T", "properties": {"common": 1, "rare": 1}}),
            ("e2", "urn:2", {"entityType": "T", "properties": {"common": 1}}),
        ]
        with caplog.at_level("WARNING"):
            asyncio.run(projector._apply(client, upserts, [], [], []))

        # 96 registered + the three name fallbacks = 99 → room for one.
        (batch,) = [params["batch"] for c, params in client.calls if "MERGE (n:" in c]
        by_urn = {it["urn"]: it for it in batch}
        assert by_urn["urn:1"]["nativeProps"] == {"common": 1}
        assert json.loads(by_urn["urn:1"]["propertiesRaw"]) == {"rare": 1}
        assert by_urn["urn:2"]["nativeProps"] == {"common": 1}
        assert any("projection:" in r.getMessage() and "rare" in r.getMessage()
                   for r in caplog.records)

    def test_a_pass_with_no_node_upserts_reads_no_names(self):
        from backend.app.services.versioning import projection as proj

        class Client:
            def __init__(self):
                self.calls = []

            async def query(self, cypher, params=None, timeout=None):
                self.calls.append(cypher)
                return types.SimpleNamespace(result_set=[])

        client = Client()
        projector = proj.FalkorProjector.__new__(proj.FalkorProjector)
        projector._batch = 1000
        asyncio.run(projector._apply(client, [], [], [], []))
        assert not any("db.propertyKeys" in c for c in client.calls)


# ---------------------------------------------------------------------------
# Reserving the platform's own property names (the schema/data race)
#
# The rollup names are schema: fixed, known here, needed by every rollup a
# graph will ever hold. A source's keys are data. Both draw on the same
# 65,534 attribute ids, never freed, and until the writers staked a claim the
# data got there first: a ~65,000-key source filled a production graph and
# the first aggregation run found room for none of the nine names a rollup
# write needs.
# ---------------------------------------------------------------------------

import re

from backend.app.providers import falkordb_provider as fp
from backend.common.derived_artifacts import is_derived_label


def _reserve_calls(queries):
    """The (cypher, params) pairs of the reserve statement pair."""
    return [(c, p) for c, p in queries if "_PropReserve" in c]


class TestPlatformNameReserve:
    def test_the_names_on_the_wire_are_every_name_the_platform_writes(self):
        """Asserted on what the reserve actually put on the wire, not on a
        constant. The four in _PROJECTOR_ATTRIBUTE_NAMES are spelled out
        because no imported set pins them: `confidence` is SET by every edge
        writer (save_custom_graph's edge batch, create_node's containment
        edge, create_edge, projection._edge_merge_cypher); `gvSeq` and `seq`
        are the versioning projector's own rollup schema (projection.py
        `r.gvSeq = item.seq` and `MERGE (m:_GVRollupMeta) SET m.seq`), which
        no capacity pre-flight covers; `purgedAt` is the _AggMeta purge
        stamp."""
        p, calls = _stubbed_provider(set())
        asyncio.run(p.save_custom_graph([_node("urn:1", {"a": 1})], []))
        (_, params), _ = _reserve_calls(calls["queries"])

        staked = set(params["names"])
        assert staked == _platform_names()
        assert {"confidence", "gvSeq", "seq", "purgedAt"} <= staked

    def test_the_carrier_label_is_one_every_count_excludes(self):
        """A run that dies between the two statements leaves a carrier
        behind — and DERIVED_LABELS is what every count and fingerprint
        surface filters on."""
        p, calls = _stubbed_provider(set())
        asyncio.run(p.save_custom_graph([_node("urn:1", {"a": 1})], []))
        (create, _), _ = _reserve_calls(calls["queries"])
        assert is_derived_label(re.search(r"CREATE \(r:(\w+)\)", create).group(1))

    def test_save_custom_graph_stakes_the_names_before_its_first_write(self):
        p, calls = _stubbed_provider(set())
        assert asyncio.run(p.save_custom_graph([_node("urn:1", {"owner": "x"})], []))

        order = [c for c, _ in calls["queries"]]
        counted = next(i for i, c in enumerate(order) if "db.propertyKeys" in c)
        create = next(i for i, c in enumerate(order) if c.startswith("CREATE (r:_PropReserve)"))
        delete = next(i for i, c in enumerate(order) if "_PropReserve" in c and "DELETE" in c)
        # The reading the call already takes decides whether to reserve; the
        # data write follows both.
        assert counted < create < delete
        assert calls["batches"]

    def test_a_graph_that_already_holds_them_is_not_reserved_again(self):
        """No latch and no wasted statement pair: the graph's own registered
        names are the state, so a dropped or recreated graph reads back
        without them and is staked again by construction."""
        p, calls = _stubbed_provider(_platform_names())
        asyncio.run(p.save_custom_graph([_node("urn:1", {"a": 1})], []))
        assert not _reserve_calls(calls["queries"])

    def test_create_node_stakes_them_too(self):
        p, calls = _stubbed_provider(set())
        assert asyncio.run(p.create_node(_node("urn:1", {"a": 1})))
        assert len(_reserve_calls(calls["queries"])) == 2

    def test_a_graph_with_no_attribute_ids_left_refuses_the_ingest(self):
        """Terminal, and before a single row lands: ids are never freed, so
        the store refuses every rollup write and index on that graph for
        good."""
        p, calls = _stubbed_provider(set())
        inner = p._query

        async def _query(cypher, params=None, **kw):
            if "_PropReserve" in cypher:
                raise RuntimeError(
                    "Max number of attributes exceeded, graph does not support "
                    "more than 65534 unique attribute names"
                )
            return await inner(cypher, params, **kw)

        p._query = _query
        with pytest.raises(AttributeNameLimitReached) as exc:
            asyncio.run(p.save_custom_graph([_node("urn:1", {"a": 1})], []))
        assert "never freed" in str(exc.value) and "recreate" in str(exc.value)
        assert not calls["batches"]

    def test_create_node_surfaces_the_refusal_rather_than_returning_false(self):
        """create_node reports every other failure as False; this one the
        operator has to hear, so its except tail re-raises this class."""
        p, _ = _stubbed_provider(set())
        inner = p._query

        async def _query(cypher, params=None, **kw):
            if "_PropReserve" in cypher:
                raise RuntimeError("Max number of attributes exceeded")
            return await inner(cypher, params, **kw)

        p._query = _query
        with pytest.raises(AttributeNameLimitReached):
            asyncio.run(p.create_node(_node("urn:1", {"a": 1})))

    def test_the_refusal_reaches_the_operator_through_the_breaker(self):
        """Every application caller reaches the provider through a
        CircuitBreakerProxy. A terminal, operator-facing refusal must not be
        counted as a downstream failure and relabelled ProviderUnavailable —
        three refused ingests would otherwise open the breaker and take the
        graph's READS offline for a condition reads do not have."""
        from backend.common.adapters.circuit import CircuitBreakerProxy

        class _Target:
            async def create_node(self, node):
                raise AttributeNameLimitReached("full")

        proxy = CircuitBreakerProxy(_Target(), name="g", fail_max=3, reset_timeout=30)
        for _ in range(3):
            with pytest.raises(AttributeNameLimitReached):
                asyncio.run(proxy.create_node(_node("urn:1", {})))
        assert proxy.breaker_state == "closed"

    def test_any_other_failure_warns_the_ingest_proceeds_and_it_retries(self, caplog):
        """Blocking every ingest because a statement did not parse on some
        build would be worse than the problem being solved — and because
        nothing is latched, the next write tries again rather than leaving
        the platform unstaked for the life of the provider."""
        p, calls = _stubbed_provider(set())
        inner = p._query
        failing = {"on": True}

        async def _query(cypher, params=None, **kw):
            if "_PropReserve" in cypher and failing["on"]:
                calls["queries"].append((cypher, params))
                raise RuntimeError("errMsg: some transient store error")
            return await inner(cypher, params, **kw)

        p._query = _query
        with caplog.at_level("WARNING"):
            assert asyncio.run(p.save_custom_graph([_node("urn:1", {"a": 1})], []))
        assert calls["batches"]
        assert any(
            "reserving the platform's property names" in r.getMessage()
            for r in caplog.records
        )

        failing["on"] = False
        asyncio.run(p.save_custom_graph([_node("urn:2", {"a": 1})], []))
        assert len(_reserve_calls(calls["queries"])) == 3   # failed CREATE, then the pair


class TestProjectorStakesItsOwnNames:
    """The projector writes through its own client and never touches a
    provider, so it makes the call itself — off the registered names it
    already reads, so a full seed that DROPs the graph stakes them again."""

    class _Client:
        def __init__(self, registered=()):
            self.calls = []
            self.registered = sorted(registered)

        async def query(self, cypher, params=None, timeout=None):
            self.calls.append(cypher)
            if "db.propertyKeys" in cypher:
                return types.SimpleNamespace(result_set=[[n] for n in self.registered])
            return types.SimpleNamespace(result_set=[])

    def _upsert(self):
        return [("e1", "urn:1", {"entityType": "T", "properties": {"a": 1}})]

    def _projector(self):
        from backend.app.services.versioning import projection as proj

        projector = proj.FalkorProjector.__new__(proj.FalkorProjector)
        projector._batch = 1000
        return projector

    def test_a_pass_with_nodes_stakes_them_before_the_first_merge(self):
        client = self._Client()
        asyncio.run(self._projector()._apply(client, self._upsert(), [], [], []))

        assert client.calls.index("MATCH (r:_PropReserve) DELETE r") < next(
            i for i, c in enumerate(client.calls) if "MERGE (n:" in c
        )

    def test_a_graph_that_already_holds_them_is_not_reserved_again(self):
        client = self._Client(_platform_names())
        asyncio.run(self._projector()._apply(client, self._upsert(), [], [], []))
        assert not any("_PropReserve" in c for c in client.calls)

    def test_a_pass_with_no_node_upserts_stakes_nothing(self):
        client = self._Client()
        asyncio.run(self._projector()._apply(client, [], [], [], []))
        assert not any("_PropReserve" in c for c in client.calls)


class TestProviderLevelBudgetOverride:
    """A graph store whose sources carry unusually wide key sets can raise
    its own budget. It sits on the PROVIDER row, not the data source: every
    name the budget admits is permanent, so a budget set too low leaves that
    graph's keys unsearchable for good, and that is a capacity decision at
    the privilege level that owns the store."""

    def _provider(self, extra):
        p = FalkorDBProvider(host="x", graph_name="g", extra_config=extra)
        return p

    def test_the_provider_value_wins_over_the_fleet_env(self, monkeypatch):
        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "8000")
        p = self._provider({"nativePropertyBudget": 40_000})
        assert p._native_property_budget() == 40_000

    def test_no_override_falls_back_to_the_fleet_env(self, monkeypatch):
        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "12345")
        assert self._provider(None)._native_property_budget() == 12_345
        assert self._provider({})._native_property_budget() == 12_345

    def test_the_override_is_clamped_at_both_ends(self):
        assert self._provider({"nativePropertyBudget": 1})._native_property_budget() == 100
        assert self._provider(
            {"nativePropertyBudget": 999_999}
        )._native_property_budget() == 60_000

    def test_an_unreadable_override_falls_back_rather_than_to_the_floor(self):
        """A typo must not silently pin a graph at 100 names and make almost
        every key on it permanently unsearchable."""
        for bad in ("lots", None, {}, [1]):
            p = self._provider({"nativePropertyBudget": bad})
            expected = (
                _native_property_budget() if bad is None
                else _NATIVE_PROPERTY_BUDGET_DEFAULT
            )
            assert p._native_property_budget() == expected, bad

    def test_it_is_resolved_once_per_provider(self, monkeypatch):
        p = self._provider({"nativePropertyBudget": 20_000})
        assert p._native_property_budget() == 20_000
        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "100")
        assert p._native_property_budget() == 20_000

    def test_the_writers_spend_the_provider_budget(self, monkeypatch):
        """Not just resolved — actually applied to what gets demoted."""
        monkeypatch.setenv("FALKORDB_NATIVE_PROPERTY_BUDGET", "60000")
        p, calls = _stubbed_provider(set())
        p._extra_config = {"nativePropertyBudget": 100}
        p._native_budget_cached = None
        room = 100 - len(p._native_key_reserve())
        nodes = [_node(f"urn:{i}", {f"k{i:03d}": i}) for i in range(room + 25)]
        asyncio.run(p.save_custom_graph(nodes, []))
        items = [it for _, params in calls["batches"] for it in params["batch"]]
        native_seen = set().union(*(it["nativeProps"].keys() for it in items))
        assert len(native_seen) <= room, native_seen


class TestBudgetOverrideIsProviderLevelOnly:
    """A data source is a lower privilege than provider config. It may not
    set the budget, for the same reason it may not set cacheConnection."""

    def _merged(self, merge_fn):
        return merge_fn(
            {"nativePropertyBudget": 40_000},
            {"nativePropertyBudget": 100, "schemaMapping": {"a": 1}},
        )

    def test_the_manager_drops_a_data_source_attempt(self):
        from backend.app.providers.manager import ProviderManager

        merged = self._merged(ProviderManager._merge_extra_config)
        assert merged["nativePropertyBudget"] == 40_000
        assert merged["schemaMapping"] == {"a": 1}, "unrelated keys still merge"

    def test_the_registry_drops_it_too(self):
        from backend.app.registry.provider_registry import ProviderRegistry

        merged = self._merged(ProviderRegistry._merge_extra_config)
        assert merged["nativePropertyBudget"] == 40_000

    def test_a_data_source_cannot_introduce_one(self):
        from backend.app.providers.manager import ProviderManager

        merged = ProviderManager._merge_extra_config(
            {"falkordbConnection": {"mode": "cluster"}},
            {"nativePropertyBudget": 100},
        )
        assert "nativePropertyBudget" not in merged
