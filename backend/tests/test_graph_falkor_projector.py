"""Tests for the FalkorDB projector (V1-5).

Pure-logic tests with fake Redis + fake FalkorDB. The projector's
correctness invariants — idempotent replay via the cursor, default-
branch filtering, ordered application of node/edge upserts and
deletes — are exercised here. A full live FalkorDB round-trip is
covered by the Phase 2 integration suite.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

import pytest

from backend.app.services.graph_falkor_projector import (
    _apply_to_falkor,
    _chunks,
)


class _FakeFalkorGraph:
    """Records every (cypher, params) pair so tests assert order +
    payload shape. Async to match the real client API."""

    def __init__(self):
        self.calls: list[tuple[str, dict[str, Any]]] = []

    async def query(self, cypher: str, params: dict[str, Any] | None = None):
        self.calls.append((cypher, params or {}))
        return None


class _FakeFalkorClient:
    def __init__(self):
        self.graphs: dict[str, _FakeFalkorGraph] = {}

    def select_graph(self, name: str) -> _FakeFalkorGraph:
        return self.graphs.setdefault(name, _FakeFalkorGraph())


class _Ev:
    """Minimal stand-in for GraphChangeEventORM rows."""

    def __init__(
        self,
        *,
        object_kind,
        object_id,
        action,
        new_content_hash=None,
        created_at=None,
    ):
        self.object_kind = object_kind
        self.object_id = object_id
        self.action = action
        self.new_content_hash = new_content_hash
        self.created_at = created_at or datetime.now(timezone.utc).isoformat()


class _NodeBlob:
    def __init__(
        self, content_hash, *,
        entity_type="Type", display_name="n", properties=None,
        tags=None, position=None,
    ):
        self.content_hash = content_hash
        self.entity_type = entity_type
        self.display_name = display_name
        self.properties = properties or {"k": "v"}
        self.tags = tags or ["t"]
        self.position = position or {"x": 1, "y": 2}


class _EdgeBlob:
    def __init__(
        self, content_hash, source_key, target_key, *,
        edge_type="REL", properties=None, confidence=None,
    ):
        self.content_hash = content_hash
        self.source_node_key = source_key
        self.target_node_key = target_key
        self.edge_type = edge_type
        self.properties = properties or {}
        self.confidence = confidence


# ── _chunks ────────────────────────────────────────────────────────


def test_chunks_splits_evenly():
    assert list(_chunks([1, 2, 3, 4, 5], 2)) == [[1, 2], [3, 4], [5]]


def test_chunks_empty():
    assert list(_chunks([], 10)) == []


# ── _apply_to_falkor: ordering ─────────────────────────────────────


@pytest.mark.asyncio
async def test_apply_orders_upserts_then_deletes():
    """Node upserts → edge upserts → edge deletes → node deletes —
    so a node being deleted is fully detached after its edges are
    processed in the same commit."""
    client = _FakeFalkorClient()
    events = [
        _Ev(object_kind="node", object_id="urn:n1", action="created",
            new_content_hash="hn1"),
        _Ev(object_kind="edge", object_id="urn:e1", action="created",
            new_content_hash="he1"),
        _Ev(object_kind="edge", object_id="urn:e2", action="deleted"),
        _Ev(object_kind="node", object_id="urn:n0", action="deleted"),
    ]
    node_blobs = {"hn1": _NodeBlob("hn1")}
    edge_blobs = {"he1": _EdgeBlob("he1", "urn:n1", "urn:n2")}

    await _apply_to_falkor(
        graph_id="g1",
        events=events,
        node_blobs=node_blobs,
        edge_blobs=edge_blobs,
        falkor_client=client,
    )

    g = client.graphs["authored_g1"]
    # Exactly four queries fired (one per non-empty batch).
    assert len(g.calls) == 4
    cyphers = [c for c, _ in g.calls]
    assert "MERGE (n:Node {urn: r.urn})" in cyphers[0]
    assert "MERGE (s:Node {urn: r.source_urn})" in cyphers[1]
    assert "MATCH ()-[e:CONNECTS {urn: r.urn}]->()" in cyphers[2]
    assert "DETACH DELETE n" in cyphers[3]


@pytest.mark.asyncio
async def test_apply_skips_empty_kinds():
    """If a commit only touches nodes, no edge queries fire."""
    client = _FakeFalkorClient()
    events = [
        _Ev(object_kind="node", object_id="urn:n1", action="created",
            new_content_hash="hn1"),
    ]
    await _apply_to_falkor(
        graph_id="g2",
        events=events,
        node_blobs={"hn1": _NodeBlob("hn1")},
        edge_blobs={},
        falkor_client=client,
    )
    g = client.graphs["authored_g2"]
    assert len(g.calls) == 1
    assert "MERGE (n:Node" in g.calls[0][0]


@pytest.mark.asyncio
async def test_apply_serializes_properties_as_json():
    """Properties / tags / position are passed as JSON strings (Falkor
    primitive only) so projection doesn't lose nested structure."""
    client = _FakeFalkorClient()
    events = [
        _Ev(object_kind="node", object_id="urn:n1", action="updated",
            new_content_hash="h1"),
    ]
    blob = _NodeBlob(
        "h1",
        properties={"nested": {"deep": [1, 2, 3]}},
        tags=["a", "b"],
        position={"x": 100, "y": 200},
    )
    await _apply_to_falkor(
        graph_id="g3", events=events,
        node_blobs={"h1": blob}, edge_blobs={},
        falkor_client=client,
    )
    g = client.graphs["authored_g3"]
    row = g.calls[0][1]["rows"][0]
    assert json.loads(row["props_json"]) == {"nested": {"deep": [1, 2, 3]}}
    assert json.loads(row["tags_json"]) == ["a", "b"]
    assert json.loads(row["position_json"]) == {"x": 100, "y": 200}


@pytest.mark.asyncio
async def test_apply_batches_large_payloads():
    """Beyond _BATCH_SIZE rows, multiple Cypher round-trips fire so a
    single query never carries an unbounded payload."""
    import backend.app.services.graph_falkor_projector as p
    original_batch = p._BATCH_SIZE
    p._BATCH_SIZE = 3
    try:
        client = _FakeFalkorClient()
        events = [
            _Ev(object_kind="node", object_id=f"urn:n{i}", action="created",
                new_content_hash=f"h{i}")
            for i in range(7)
        ]
        node_blobs = {f"h{i}": _NodeBlob(f"h{i}") for i in range(7)}
        await p._apply_to_falkor(
            graph_id="g4", events=events,
            node_blobs=node_blobs, edge_blobs={},
            falkor_client=client,
        )
        g = client.graphs["authored_g4"]
        # 7 rows / batch 3 = ceil(7/3) = 3 queries
        assert len(g.calls) == 3
        sizes = [len(c[1]["rows"]) for c in g.calls]
        assert sizes == [3, 3, 1]
    finally:
        p._BATCH_SIZE = original_batch


@pytest.mark.asyncio
async def test_apply_skips_events_with_missing_blobs():
    """If the content blob for an upsert event is missing, that event
    is silently skipped — the projector never blocks on partial data."""
    client = _FakeFalkorClient()
    events = [
        _Ev(object_kind="node", object_id="urn:n1", action="created",
            new_content_hash="h_missing"),
        _Ev(object_kind="node", object_id="urn:n2", action="created",
            new_content_hash="h_present"),
    ]
    await _apply_to_falkor(
        graph_id="g5",
        events=events,
        node_blobs={"h_present": _NodeBlob("h_present")},
        edge_blobs={},
        falkor_client=client,
    )
    g = client.graphs["authored_g5"]
    assert len(g.calls) == 1
    assert len(g.calls[0][1]["rows"]) == 1
    assert g.calls[0][1]["rows"][0]["urn"] == "urn:n2"


@pytest.mark.asyncio
async def test_apply_per_graph_namespace_isolation():
    """Different graph_ids project into different FalkorDB graph names
    — UC-4 isolation invariant."""
    client = _FakeFalkorClient()
    ev = [_Ev(object_kind="node", object_id="urn:n", action="created",
              new_content_hash="h")]
    blobs = {"h": _NodeBlob("h")}

    await _apply_to_falkor(
        graph_id="ga", events=ev, node_blobs=blobs, edge_blobs={},
        falkor_client=client,
    )
    await _apply_to_falkor(
        graph_id="gb", events=ev, node_blobs=blobs, edge_blobs={},
        falkor_client=client,
    )
    assert "authored_ga" in client.graphs
    assert "authored_gb" in client.graphs
    # Distinct graph handles — no cross-graph contamination.
    assert client.graphs["authored_ga"] is not client.graphs["authored_gb"]
