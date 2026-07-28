"""Property-storage analysis and preview — service + endpoint tests.

Both endpoints are read-only diagnostics over a sampled graph, so these run
against a fake provider that answers the three Cypher shapes the analyzer
issues (label list, per-label sample, per-label count). No FalkorDB needed.
"""
import json

import pytest
from httpx import AsyncClient

from backend.app.services.property_alignment import (
    analyze_property_storage,
    preview_alignment,
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


class _FakeGraph:
    """Answers the analyzer's queries from an in-memory {label: [props]} map."""

    def __init__(self, nodes_by_label):
        self._nodes = nodes_by_label
        # Platform default; overridden per-test where the mapping matters.
        self._mapping = SchemaMapping()
        self.queries = []

    async def _ro_query_tolerant(self, cypher, params=None, *, timeout=None, op=None):
        self.queries.append(cypher)
        if "db.labels()" in cypher:
            return _Result([[lbl] for lbl in self._nodes])
        for label, rows in self._nodes.items():
            if f"MATCH (n:`{label}`)" not in cypher:
                continue
            if "count(n)" in cypher:
                key = cypher.split("n.`")[1].split("`")[0]
                return _Result([[sum(1 for p in rows if key in p)]])
            limit = int((params or {}).get("lim", 200))
            return _Result([[_Node(p)] for p in rows[:limit]])
        return _Result([])


def _container(**kw):
    return json.dumps(kw)


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
        assert info["affectedNodes"] == 2
        assert report["totals"]["needsAlignment"] == ["dataset"]

    async def test_native_shaped_label_needs_no_alignment(self):
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "logicalType": "STRING", "rowCount": 5},
        ]})
        report = await analyze_property_storage(graph, SchemaMapping())

        info = report["labels"]["dataset"]
        assert info["storage"] == "native"
        assert info["nativeKeys"] == ["logicalType", "rowCount"]
        assert info["affectedNodes"] == 0
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
        assert report["totals"]["affectedNodes"] == 0

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

    async def test_native_after_lists_what_becomes_indexable(self):
        """The half a property bag can't show: which keys become real
        FalkorDB fields, and therefore searchable."""
        graph = _FakeGraph({"dataset": [
            {"urn": "u1", "properties": _container(
                fmt="parquet", nested={"deep": {"deeper": {"a": [{"x": 1}]}}},
            )},
        ]})
        result = await preview_alignment(graph, SchemaMapping())

        sample = result["samples"][0]
        assert "fmt" in sample["nativeAfter"]
        # A list-of-dicts leaf can't be native — it lands in propertiesRaw.
        assert "nested/deep/deeper/a" not in sample["nativeAfter"]

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
    async def test_storage_report(self, alignment_client):
        client, _ = alignment_client
        resp = await client.get("/api/v1/ws_test/graph/properties/storage")
        assert resp.status_code == 200

        body = resp.json()
        assert body["containerKey"] == "properties"
        assert body["separator"] == "/"
        assert body["labels"]["dataset"]["storage"] == "container"
        assert body["labels"]["dataset"]["inferredPaths"] == ["technical/format"]
        assert body["totals"]["needsAlignment"] == ["dataset"]

    async def test_storage_report_surfaces_collisions(self, alignment_client):
        client, _ = alignment_client
        resp = await client.get("/api/v1/ws_test/graph/properties/storage")
        collisions = resp.json()["labels"]["dataset"]["collisions"]
        assert [c["field"] for c in collisions] == ["level"]

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
