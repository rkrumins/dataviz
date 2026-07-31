"""Property-storage analysis and preview — service + endpoint tests.

The analyzer runs against a fake provider answering the only two Cypher shapes
it is allowed to issue: the label list, and one capped sample per label. There
is deliberately no ``count`` shape — see ``TestAnalyzePropertyStorage
.test_never_counts_at_all``.

The storage ENDPOINT is cache-only, so its tests seed a ``data_source_stats``
row instead and assert the provider is never touched.
"""
import json

import pytest
from httpx import AsyncClient

from backend.app.services.property_alignment import (
    analyze_property_storage,
    preview_alignment,
    run_alignment,
)
from backend.app.services.context_engine import ContextEngine
from backend.graph.adapters.schema_mapping import SchemaMapping


# ── Fake FalkorDB surface ────────────────────────────────────────────────

class _Node:
    """Stands in for the driver's Node object — the analyzer reads
    ``.properties``, exactly as the real read path does."""

    def __init__(self, props):
        self.properties = props


class _Result:
    def __init__(self, rows):
        self.result_set = rows


class _FakeRedis:
    """Just enough of the provider's Redis handle to serve the counts cache."""

    def __init__(self, payload):
        self._payload = payload

    async def get(self, key):
        if key.endswith(":stats_cache") and self._payload is not None:
            return json.dumps(self._payload)
        return None


class _FakeGraph:
    """Answers the analyzer's queries from an in-memory {label: [props]} map.

    ``label_totals`` seeds the counts cache the analyzer extrapolates against.
    Pass ``None`` to simulate a cold cache. It deliberately does NOT implement
    ``count(n)`` — the analyzer must never issue one, and a test that relied on
    it would hide a regression rather than catch it.
    """

    def __init__(self, nodes_by_label, label_totals=None):
        self._nodes = nodes_by_label
        # Platform default; overridden per-test where the mapping matters.
        self._mapping = SchemaMapping()
        self._cache_ns = "graph:test"
        if label_totals is None:
            # Default: the cache knows exactly what we seeded, so estimates
            # come out equal to the sampled truth and stay easy to assert on.
            label_totals = {lbl: len(rows) for lbl, rows in nodes_by_label.items()}
        self._redis = (
            _FakeRedis({"entityTypeCounts": label_totals})
            if label_totals is not False else _FakeRedis(None)
        )
        self.queries = []

    async def _ro_query_tolerant(self, cypher, params=None, *, timeout=None, op=None):
        self.queries.append(cypher)
        if "db.labels()" in cypher:
            return _Result([[lbl] for lbl in self._nodes])
        for label, rows in self._nodes.items():
            if f"MATCH (n:`{label}`)" not in cypher:
                continue
            limit = int((params or {}).get("lim", 200))
            return _Result([[_Node(p)] for p in rows[:limit]])
        return _Result([])


def _container(**kw):
    return json.dumps(kw)


class _IdSpaceGraph:
    """A graph addressed by internal node ID, for the alignment runner.

    ``nodes`` is ``{id: props}``. Records every window it was asked for so a
    test can assert the walk covered the ID space exactly once, and applies
    writes so idempotency is observable.
    """

    def __init__(self, nodes, max_id=None):
        self.nodes = dict(nodes)
        self._max_id = max_id if max_id is not None else (
            max(self.nodes) if self.nodes else -1
        )
        self.windows = []
        self.writes = []
        self.read_failures = set()

    async def _ro_query(self, cypher, params=None, *, timeout=None, op=None):
        if "max(ID(n))" in cypher:
            return _Result([[self._max_id]])
        lo, hi = params["lo"], params["hi"]
        self.windows.append((lo, hi))
        if lo in self.read_failures:
            raise RuntimeError("simulated window read failure")
        key = cypher.split("n.`")[1].split("`")[0]
        rows = [
            [p.get("urn"), p.get(key), p.get("displayName"),
             p.get("qualifiedName"), p.get("description")]
            for nid, p in sorted(self.nodes.items())
            if lo <= nid < hi and p.get(key) is not None
        ]
        return _Result(rows)

    async def _query(self, cypher, params=None, *, timeout=None, op=None):
        batch = (params or {}).get("batch") or []
        self.writes.append(batch)
        key = cypher.split("REMOVE n.`")[1].split("`")[0]
        by_urn = {p.get("urn"): p for p in self.nodes.values() if p.get("urn")}
        for item in batch:
            node = by_urn.get(item["urn"])
            if node is None:
                continue
            node.update(item["nativeProps"])
            node["propertiesRaw"] = item["propertiesRaw"]
            node["searchableText"] = item["searchableText"]
            node.pop(key, None)
        return _Result([])


# ── Analyzer ─────────────────────────────────────────────────────────────

class TestAnalyzePropertyStorage:
    async def test_container_shaped_label(self):
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "properties": _container(technical={"format": "parquet"})},
            {"urn": "u2", "properties": _container(technical={"format": "csv"})},
        ]})
        report = await analyze_property_storage(graph, SchemaMapping())

        info = report["labels"]["dataset"]
        assert info["storage"] == "container"
        assert info["sampled"] == 2
        assert info["containerKeys"] == ["properties"]
        assert info["inferredPaths"] == ["technical/format"]
        assert info["affectedEstimate"] == 2
        assert report["totals"]["needsAlignment"] == ["dataset"]

    async def test_native_shaped_label_needs_no_alignment(self):
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "logicalType": "STRING", "rowCount": 5},
        ]})
        report = await analyze_property_storage(graph, SchemaMapping())

        info = report["labels"]["dataset"]
        assert info["storage"] == "native"
        assert info["nativeKeys"] == ["logicalType", "rowCount"]
        assert info["affectedEstimate"] == 0
        assert report["totals"]["needsAlignment"] == []

    async def test_mixed_shape_is_reported_separately(self):
        """Mid-migration: some nodes rewritten, some not. An operator needs to
        see that rather than a binary answer."""
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "properties": _container(a=1)},
            {"urn": "u2", "owner": "team"},
        ]})
        report = await analyze_property_storage(graph, SchemaMapping())
        assert report["labels"]["dataset"]["storage"] == "mixed"

    async def test_foreign_container_key(self):
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "attributes": _container(owner={"team": "data"})},
        ]})
        report = await analyze_property_storage(
            graph, SchemaMapping(properties_field="attributes"),
        )
        info = report["labels"]["dataset"]
        assert info["storage"] == "container"
        assert info["inferredPaths"] == ["owner/team"]

    async def test_unparseable_container_is_counted_not_hidden(self):
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "properties": "not json"},
        ]})
        report = await analyze_property_storage(graph, SchemaMapping())
        assert report["labels"]["dataset"]["unparseable"] == 1

    async def test_reserved_key_collision_reported_with_samples(self):
        """A source field named `level` is shadowed on read and deleted on
        write. The report must name it and show values so the operator can
        recognise it as theirs."""
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "level": "tier-1", "properties": _container(a=1)},
        ]})
        report = await analyze_property_storage(graph, SchemaMapping())

        collisions = report["labels"]["dataset"]["collisions"]
        assert [c["field"] for c in collisions] == ["level"]
        assert collisions[0]["samples"] == ["tier-1"]
        assert collisions[0]["suggested"] == "source/level"

    async def test_platform_stamped_keys_are_not_false_collisions(self):
        """`urn`/`displayName` are stamped onto foreign graphs by the platform
        itself, so reporting them as collisions would be noise."""
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "displayName": "X", "entityType": "dataset",
             "properties": _container(a=1)},
        ]})
        report = await analyze_property_storage(graph, SchemaMapping())
        assert report["labels"]["dataset"]["collisions"] == []

    async def test_empty_graph(self):
        report = await analyze_property_storage(_FakeGraph({}), SchemaMapping())
        assert report["labels"] == {}
        assert report["totals"]["affectedEstimate"] in (0, None)

    async def test_label_with_no_nodes(self):
        report = await analyze_property_storage(
            _FakeGraph({"dataset": []}), SchemaMapping(),
        )
        assert report["labels"]["dataset"]["storage"] == "empty"
        assert report["totals"]["needsAlignment"] == []

    async def test_empty_container_is_not_pitched_as_work(self):
        """A node carrying `n.properties = "{}"` has nothing trapped in it.
        Flagging it would offer the operator a rewrite that yields zero new
        searchable properties."""
        graph = _FakeGraph({"dataset": [{"urn": "u1", "properties": "{}"}]})
        report = await analyze_property_storage(graph, SchemaMapping())

        assert report["labels"]["dataset"]["storage"] != "container"
        assert report["totals"]["needsAlignment"] == []
        assert report["totals"]["newPaths"] == 0

    async def test_never_counts_at_all(self):
        """The scale contract: ONE bounded query per label, plus the label
        list. An exact `count(n) WHERE n.<container> IS NOT NULL` is a
        non-indexable full scan that blows its budget on a large graph, and a
        swallowed timeout would report zero affected nodes for exactly the
        graphs with the most trapped properties."""
        graph = _FakeGraph({
            "dataset": [{"urn": "u1", "properties": _container(a=1)}],
            "domain": [{"urn": "u2", "properties": _container(b=2)}],
        })
        await analyze_property_storage(graph, SchemaMapping())

        assert not any("count(" in q for q in graph.queries)
        # 1 label list + 1 sample per label. Nothing else, ever.
        assert len(graph.queries) == 3

    async def test_query_count_is_flat_in_graph_size(self):
        """A 5-node label and a 500-node label cost the same number of round
        trips — the sample is capped and nothing scales with node count."""
        small = _FakeGraph({"dataset": [
            {"urn": f"u{i}", "properties": _container(a=i)} for i in range(5)
        ]})
        large = _FakeGraph({"dataset": [
            {"urn": f"u{i}", "properties": _container(a=i)} for i in range(5000)
        ]})
        await analyze_property_storage(small, SchemaMapping())
        await analyze_property_storage(large, SchemaMapping())
        assert len(small.queries) == len(large.queries)

    async def test_estimate_extrapolates_from_the_cached_total(self):
        """Half the sample is container-shaped and the cache says the label
        holds 1,000,000 nodes — so roughly 500,000 are affected, computed
        without touching the graph."""
        graph = _FakeGraph(
            {"dataset": [
                {"urn": "u1", "properties": _container(a=1)},
                {"urn": "u2", "owner": "team"},
            ]},
            label_totals={"dataset": 1_000_000},
        )
        report = await analyze_property_storage(graph, SchemaMapping())

        info = report["labels"]["dataset"]
        assert info["affectedEstimate"] == 500_000
        assert info["labelTotal"] == 1_000_000
        assert info["sampled"] == 2
        assert info["containerSampled"] == 1
        assert report["totals"]["affectedEstimate"] == 500_000
        assert report["sizedFromCache"] is True

    async def test_cold_counts_cache_reports_unknown_not_zero(self):
        """Without cached totals the ratio is still known but the absolute is
        not. Say so — inventing 0 is how the biggest graphs got told they had
        no problem."""
        graph = _FakeGraph(
            {"dataset": [{"urn": "u1", "properties": _container(a=1)}]},
            label_totals=False,          # cold cache
        )
        report = await analyze_property_storage(graph, SchemaMapping())

        info = report["labels"]["dataset"]
        assert info["affectedEstimate"] is None
        assert info["labelTotal"] is None
        # The shape is still known, so the label still needs alignment.
        assert info["storage"] == "container"
        assert report["totals"]["needsAlignment"] == ["dataset"]
        assert report["sizedFromCache"] is False

    async def test_sample_size_is_reported_so_the_ui_can_qualify_it(self):
        graph = _FakeGraph({"dataset": [{"urn": "u1", "properties": _container(a=1)}]})
        report = await analyze_property_storage(
            graph, SchemaMapping(), sample_per_label=50,
        )
        assert report["samplePerLabel"] == 50

    async def test_container_key_disabled_classifies_everything_native(self):
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "properties": _container(a=1), "owner": "team"},
        ]})
        report = await analyze_property_storage(
            graph, SchemaMapping(properties_field=None),
        )
        assert report["labels"]["dataset"]["storage"] == "native"
        assert report["totals"]["needsAlignment"] == []

    async def test_separator_flows_into_inferred_paths(self):
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "properties": _container(a={"b": 1})},
        ]})
        report = await analyze_property_storage(
            graph, SchemaMapping(properties_separator="."),
        )
        assert report["labels"]["dataset"]["inferredPaths"] == ["a.b"]
        assert report["separator"] == "."


# ── Preview ──────────────────────────────────────────────────────────────

class TestPreviewAlignment:
    async def test_before_after_reflects_the_proposed_mapping(self):
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "displayName": "X",
             "attributes": _container(owner={"team": "data"})},
        ]})
        result = await preview_alignment(
            graph,
            SchemaMapping(properties_field="attributes"),
            current=SchemaMapping(),
        )

        sample = result["samples"][0]
        # Current mapping looks for `properties`, which isn't there — so the
        # real container leaks through as one opaque, unqueryable property.
        assert list(sample["before"]) == ["attributes"]
        # Proposed mapping unpacks it into folder paths.
        assert sample["after"] == {"owner/team": "data"}
        assert sample["urn"] == "u1"

    async def test_newly_searchable_lists_what_becomes_indexable(self):
        """The half a property bag can't show: which keys become real
        FalkorDB fields, and therefore searchable."""
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "properties": _container(
                fmt="parquet", nested={"deep": {"deeper": {"a": [{"x": 1}]}}},
            )},
        ]})
        result = await preview_alignment(graph, SchemaMapping())

        sample = result["samples"][0]
        assert "fmt" in sample["newlySearchable"]
        # A list-of-dicts leaf can't be native — it lands in propertiesRaw.
        assert "nested/deep/deeper/a" not in sample["newlySearchable"]

    async def test_promises_nothing_when_the_node_is_already_native(self):
        """`before` and `after` are identical whenever the mapping hasn't
        changed, because the read path already hydrates the container. The
        payoff must therefore be measured against the node's REAL fields —
        otherwise an already-aligned graph is told it has properties to gain."""
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "owner": "team", "rowCount": 5},
        ]})
        result = await preview_alignment(graph, SchemaMapping())

        sample = result["samples"][0]
        assert sample["before"] == sample["after"]
        assert sample["newlySearchable"] == []

    async def test_counts_only_the_trapped_half_of_a_mixed_node(self):
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "owner": "team", "properties": _container(fmt="parquet")},
        ]})
        result = await preview_alignment(graph, SchemaMapping())

        # `owner` is already a field; only `fmt` is trapped in the container.
        assert result["samples"][0]["newlySearchable"] == ["fmt"]

    async def test_preview_writes_nothing(self):
        graph = _FakeGraph({"dataset": [{"urn": "u1", "properties": _container(a=1)}]})
        await preview_alignment(graph, SchemaMapping())
        assert all(
            "SET" not in q and "REMOVE" not in q and "MERGE" not in q
            for q in graph.queries
        )

    async def test_nodes_without_urn_are_skipped(self):
        graph = _FakeGraph({"dataset": [{"noUrn": 1}, {"urn": "u1"}]})
        result = await preview_alignment(graph, SchemaMapping())
        assert [s["urn"] for s in result["samples"]] == ["u1"]

    async def test_limit_is_respected(self):
        graph = _FakeGraph({"dataset": [{"urn": f"u{i}"} for i in range(10)]})
        result = await preview_alignment(graph, SchemaMapping(), limit=3)
        assert result["count"] == 3


# ── Endpoints ────────────────────────────────────────────────────────────

class _ExplodingProvider:
    """Any graph query at all is a bug on the storage read path."""

    def __init__(self):
        self._mapping = SchemaMapping()

    async def _ro_query_tolerant(self, *a, **kw):
        raise AssertionError(
            "the cache-only storage endpoint must never touch the provider",
        )

    _ro_query = _ro_query_tolerant


PROFILE = {
    "containerKey": "properties",
    "separator": "/",
    "collectUnmapped": True,
    "propertyOverrides": {},
    "labels": {
        "dataset": {
            "sampled": 200, "containerSampled": 200, "labelTotal": 12043,
            "storage": "container", "nativeKeys": [],
            "containerKeys": ["properties"],
            "inferredPaths": ["technical/format"],
            "affectedEstimate": 12043, "unparseable": 0,
            "collisions": [
                {"field": "level", "samples": ["tier-1"],
                 "suggested": "source/level"},
            ],
        },
    },
    "totals": {
        "labels": 1, "affectedEstimate": 12043, "newPaths": 1,
        "needsAlignment": ["dataset"],
    },
    "samplePerLabel": 200,
    "sizedFromCache": True,
    "elapsedMs": 9,
}


async def _seed_profiled_source(db_session, *, ds_id="ds_prop", stats=None):
    from backend.app.db import models as _m
    db_session.add(_m.WorkspaceORM(id="ws_prop", name="Prop WS"))
    db_session.add(_m.ProviderORM(id="prov_prop", name="P", provider_type="falkordb"))
    db_session.add(_m.WorkspaceDataSourceORM(
        id=ds_id, workspace_id="ws_prop", provider_id="prov_prop",
        graph_name="g", label="Prop Source",
    ))
    if stats is not None:
        db_session.add(_m.DataSourceStatsORM(
            data_source_id=ds_id, schema_stats=json.dumps(stats),
            schema_updated_at="2026-07-31T00:00:00Z",
        ))
    await db_session.commit()


class TestStorageEndpointIsCacheOnly:
    """The scale contract at the HTTP boundary: this handler serves what the
    stats service profiled and never scans. A live classification would sample
    every label on the request path — fine at 10k nodes, ruinous at 10M."""

    async def test_serves_the_cached_profile_in_an_envelope(
        self, test_client: AsyncClient, db_session,
    ):
        await _seed_profiled_source(db_session, stats={
            "totalNodes": 12043, "totalEdges": 0, "propertyStorage": PROFILE,
        })
        resp = await test_client.get(
            "/api/v1/ws_prop/graph/properties/storage?dataSourceId=ds_prop")
        assert resp.status_code == 200

        body = resp.json()
        assert body["meta"]["status"] in ("fresh", "stale")
        data = body["data"]
        assert data["labels"]["dataset"]["storage"] == "container"
        assert data["labels"]["dataset"]["affectedEstimate"] == 12043
        assert data["totals"]["needsAlignment"] == ["dataset"]
        assert data["labels"]["dataset"]["collisions"][0]["field"] == "level"

    async def test_never_calls_the_provider(
        self, test_client: AsyncClient, db_session,
    ):
        from backend.app.main import app
        from backend.app.api.v1.endpoints.graph import get_context_engine

        await _seed_profiled_source(db_session, stats={
            "totalNodes": 1, "totalEdges": 0, "propertyStorage": PROFILE,
        })

        async def _override():
            return ContextEngine(provider=_ExplodingProvider())

        app.dependency_overrides[get_context_engine] = _override
        try:
            resp = await test_client.get(
                "/api/v1/ws_prop/graph/properties/storage?dataSourceId=ds_prop")
        finally:
            app.dependency_overrides.pop(get_context_engine, None)
        assert resp.status_code == 200

    async def test_cold_source_reports_computing_not_a_timeout(
        self, test_client: AsyncClient, db_session,
    ):
        """No cached row yet. The answer is "we're working on it" with a job
        to poll — never a scan the user waits on."""
        await _seed_profiled_source(db_session, stats=None)
        resp = await test_client.get(
            "/api/v1/ws_prop/graph/properties/storage?dataSourceId=ds_prop")

        assert resp.status_code == 200
        assert resp.json()["meta"]["status"] == "computing"

    async def test_profiled_source_without_the_block_yields_null_data(
        self, test_client: AsyncClient, db_session,
    ):
        """A row profiled before this feature existed. `propertyStorage` is
        absent, so `data` is null — the tab shows "not profiled yet" rather
        than crashing on a missing key."""
        await _seed_profiled_source(db_session, stats={
            "totalNodes": 5, "totalEdges": 0, "entityTypeStats": [],
        })
        resp = await test_client.get(
            "/api/v1/ws_prop/graph/properties/storage?dataSourceId=ds_prop")

        assert resp.status_code == 200
        assert resp.json()["data"] is None

    async def test_requires_a_data_source(self, test_client: AsyncClient):
        resp = await test_client.get("/api/v1/ws_prop/graph/properties/storage")
        assert resp.status_code == 400


@pytest.fixture()
async def alignment_client(test_client: AsyncClient):
    from backend.app.main import app
    from backend.app.api.v1.endpoints.graph import get_context_engine

    graph = _FakeGraph({"dataset": [
        {"urn": "u1", "displayName": "X", "level": "tier-1",
         "properties": _container(technical={"format": "parquet"})},
    ]})
    engine = ContextEngine(provider=graph)

    async def _override():
        return engine

    app.dependency_overrides[get_context_engine] = _override
    yield test_client, graph
    app.dependency_overrides.pop(get_context_engine, None)


class TestPropertyStorageEndpoints:
    async def test_preview_endpoint(self, alignment_client):
        client, _ = alignment_client
        resp = await client.post(
            "/api/v1/ws_test/graph/properties/storage/preview",
            json={"mapping": {
                "containerKey": "properties",
                "separator": "/",
                "collectUnmapped": True,
                "propertyOverrides": {"level": "source/level"},
            }},
        )
        assert resp.status_code == 200

        sample = resp.json()["samples"][0]
        assert sample["after"]["technical/format"] == "parquet"
        # The collision is rescued only under the PROPOSED mapping.
        assert sample["after"]["source/level"] == "tier-1"
        assert "source/level" not in sample["before"]

    async def test_preview_does_not_write(self, alignment_client):
        client, graph = alignment_client
        await client.post(
            "/api/v1/ws_test/graph/properties/storage/preview",
            json={"mapping": {"containerKey": "properties", "separator": "/"}},
        )
        assert all("SET" not in q and "REMOVE" not in q for q in graph.queries)

    async def test_preview_rejects_an_out_of_range_limit(self, alignment_client):
        client, _ = alignment_client
        resp = await client.post(
            "/api/v1/ws_test/graph/properties/storage/preview",
            json={"mapping": {"containerKey": "properties"}, "limit": 999},
        )
        assert resp.status_code == 422


class TestPropertyMappingSaveMergesServerSide:
    """The save endpoint exists specifically so a client never does
    read-modify-write on ``extra_config``: that column is replaced wholesale on
    PATCH, and the response redacts secrets to ``***``, so a round-trip through
    the client would overwrite real credentials with the mask."""

    def _apply(self, existing_extra_config, body):
        """Run the merge the endpoint performs, without the DB/HTTP layers."""
        import json as _json
        try:
            existing = _json.loads(existing_extra_config) if existing_extra_config else {}
        except (ValueError, TypeError):
            existing = {}
        if not isinstance(existing, dict):
            existing = {}
        schema_mapping = dict(existing.get("schemaMapping") or {})
        schema_mapping.update({
            "properties_field": body["containerKey"],
            "properties_separator": body["separator"],
            "collect_unmapped_as_properties": body["collectUnmapped"],
            "property_overrides": body["propertyOverrides"],
        })
        existing["schemaMapping"] = schema_mapping
        return existing

    def test_unrelated_extra_config_keys_survive(self):
        before = json.dumps({
            "falkordbConnection": {"host": "graph.internal", "password": "s3cret"},
            "cacheConnection": {"host": "cache.internal"},
        })
        after = self._apply(before, {
            "containerKey": "attributes", "separator": "/",
            "collectUnmapped": True, "propertyOverrides": {},
        })
        assert after["falkordbConnection"] == {
            "host": "graph.internal", "password": "s3cret",
        }
        assert after["cacheConnection"] == {"host": "cache.internal"}
        assert after["schemaMapping"]["properties_field"] == "attributes"

    def test_non_property_mapping_fields_survive(self):
        """Identity/entity-type mapping is out of this feature's scope and must
        not be clobbered by a property-mapping save."""
        before = json.dumps({"schemaMapping": {
            "identity_field": "id", "entity_type_strategy": "property",
        }})
        after = self._apply(before, {
            "containerKey": "properties", "separator": ".",
            "collectUnmapped": False, "propertyOverrides": {"level": "source/level"},
        })
        assert after["schemaMapping"]["identity_field"] == "id"
        assert after["schemaMapping"]["entity_type_strategy"] == "property"
        assert after["schemaMapping"]["properties_separator"] == "."
        assert after["schemaMapping"]["collect_unmapped_as_properties"] is False

    def test_malformed_existing_config_does_not_lose_the_save(self):
        after = self._apply("}{ not json", {
            "containerKey": "properties", "separator": "/",
            "collectUnmapped": True, "propertyOverrides": {},
        })
        assert after["schemaMapping"]["properties_field"] == "properties"

    def test_result_parses_back_into_a_schema_mapping(self):
        after = self._apply(None, {
            "containerKey": "attributes", "separator": ".",
            "collectUnmapped": False, "propertyOverrides": {"level": "source/level"},
        })
        mapping = SchemaMapping.from_extra_config(after)
        assert mapping.properties_field == "attributes"
        assert mapping.properties_separator == "."
        assert mapping.collect_unmapped_as_properties is False
        assert mapping.property_overrides == {"level": "source/level"}


# ── The alignment run ────────────────────────────────────────────────────

class TestRunAlignment:
    """The scale-critical half. The CLI script this replaces buffered every
    URN for a label into a Python list before writing anything — roughly a
    gigabyte of strings at 10M nodes. These assert the replacement walks the
    ID space in bounded windows instead."""

    async def test_unpacks_containers_into_native_fields(self):
        graph = _IdSpaceGraph({
            0: {"urn": "u0", "properties": _container(technical={"format": "parquet"})},
            1: {"urn": "u1", "properties": _container(owner="team")},
        })
        stats = await run_alignment(graph, SchemaMapping(), window=10)

        assert stats["processed"] == 2
        assert stats["aligned"] == 2
        assert graph.nodes[0]["technical/format"] == "parquet"
        assert graph.nodes[1]["owner"] == "team"
        # The container is gone once its contents are native.
        assert "properties" not in graph.nodes[0]

    async def test_walks_the_id_space_in_bounded_windows(self):
        """Memory is bounded by the window, not the graph. A 10M-node ID space
        must still be walked in fixed-size steps."""
        graph = _IdSpaceGraph({}, max_id=10_000_000)
        await run_alignment(graph, SchemaMapping(), window=1_000_000)

        assert graph.windows == [
            (0, 1_000_000), (1_000_000, 2_000_000), (2_000_000, 3_000_000),
            (3_000_000, 4_000_000), (4_000_000, 5_000_000), (5_000_000, 6_000_000),
            (6_000_000, 7_000_000), (7_000_000, 8_000_000), (8_000_000, 9_000_000),
            (9_000_000, 10_000_000), (10_000_000, 11_000_000),
        ]
        # Contiguous and non-overlapping: every id is visited exactly once.
        assert all(a[1] == b[0] for a, b in zip(graph.windows, graph.windows[1:]))

    async def test_resumes_from_a_stored_cursor(self):
        graph = _IdSpaceGraph({
            0: {"urn": "u0", "properties": _container(a=1)},
            50: {"urn": "u50", "properties": _container(b=2)},
        })
        stats = await run_alignment(graph, SchemaMapping(), window=10, start_id=50)

        # The first window's node was never read — the resume skipped it.
        assert stats["processed"] == 1
        assert graph.windows[0][0] == 50
        assert "properties" in graph.nodes[0]
        assert "properties" not in graph.nodes[50]

    async def test_cancels_between_windows_and_reports_where_it_stopped(self):
        graph = _IdSpaceGraph({i: {"urn": f"u{i}", "properties": _container(a=i)}
                               for i in range(100)}, max_id=100)
        calls = {"n": 0}

        def _cancel():
            calls["n"] += 1
            return calls["n"] > 2

        stats = await run_alignment(
            graph, SchemaMapping(), window=10, should_cancel=_cancel,
        )
        assert stats["cancelled"] is True
        # Resumable: lastId is where the next run picks up.
        assert 0 < stats["lastId"] < 100

    async def test_is_idempotent(self):
        graph = _IdSpaceGraph({
            0: {"urn": "u0", "properties": _container(a=1)},
        })
        await run_alignment(graph, SchemaMapping(), window=10)
        second = await run_alignment(graph, SchemaMapping(), window=10)

        assert second["processed"] == 0
        assert second["aligned"] == 0

    async def test_unparseable_container_is_preserved_not_destroyed(self):
        """The original script's REMOVE fired regardless of whether the blob
        parsed, destroying the data it was meant to migrate."""
        graph = _IdSpaceGraph({
            0: {"urn": "u0", "properties": "not json"},
        })
        stats = await run_alignment(graph, SchemaMapping(), window=10)

        assert stats["unparseable"] == 1
        assert stats["aligned"] == 0
        assert graph.nodes[0]["properties"] == "not json"

    async def test_node_without_urn_is_skipped_and_counted(self):
        graph = _IdSpaceGraph({
            0: {"properties": _container(a=1)},
            1: {"urn": "u1", "properties": _container(b=2)},
        })
        stats = await run_alignment(graph, SchemaMapping(), window=10)

        assert stats["skippedNoUrn"] == 1
        assert stats["aligned"] == 1

    async def test_dry_run_writes_nothing(self):
        graph = _IdSpaceGraph({
            0: {"urn": "u0", "properties": _container(a=1)},
        })
        stats = await run_alignment(graph, SchemaMapping(), window=10, dry_run=True)

        assert stats["aligned"] == 1        # what it WOULD do
        assert graph.writes == []
        assert graph.nodes[0]["properties"] is not None

    async def test_searchable_text_is_refreshed_in_the_same_pass(self):
        """The old script left this stale and offered a separate,
        non-composable --searchable-text flag to fix it."""
        graph = _IdSpaceGraph({
            0: {"urn": "u0", "displayName": "Revenue",
                "properties": _container(owner="alice")},
        })
        await run_alignment(graph, SchemaMapping(), window=10)

        text = graph.nodes[0]["searchableText"]
        assert "revenue" in text.lower()
        assert "alice" in text.lower()

    async def test_a_failed_window_does_not_abandon_the_run(self):
        graph = _IdSpaceGraph({
            0: {"urn": "u0", "properties": _container(a=1)},
            15: {"urn": "u15", "properties": _container(b=2)},
        })
        graph.read_failures = {0}
        stats = await run_alignment(graph, SchemaMapping(), window=10)

        # The second window still ran.
        assert stats["aligned"] == 1
        assert "properties" not in graph.nodes[15]

    async def test_collision_overrides_are_applied_on_write(self):
        graph = _IdSpaceGraph({
            0: {"urn": "u0", "properties": _container(level="tier-1")},
        })
        await run_alignment(
            graph,
            SchemaMapping(property_overrides={"level": "source/level"}),
            window=10,
        )
        assert graph.nodes[0]["source/level"] == "tier-1"
        assert "level" not in graph.nodes[0]

    async def test_no_container_key_is_a_no_op(self):
        graph = _IdSpaceGraph({0: {"urn": "u0", "a": 1}})
        stats = await run_alignment(
            graph, SchemaMapping(properties_field=None), window=10,
        )
        assert stats["processed"] == 0
        assert graph.windows == []
