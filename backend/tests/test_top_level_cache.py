"""
Unit tests for backend.app.services.top_level_cache

No live Redis/Postgres: ``get_data_source_stats`` and
``enqueue_stats_job_safe_ex`` are monkeypatched at the module level, and
Redis is a plain AsyncMock (mirrors test_graph_cache.py's approach).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from unittest.mock import AsyncMock

import pytest

from backend.app.services import top_level_cache
from backend.common.models.graph import GraphNode, TopLevelNodesResult


# ── fakes ────────────────────────────────────────────────────────────

class _FakeResolved:
    def __init__(self, containment_edge_types=None, root_entity_types=None):
        self.containment_edge_types = containment_edge_types or []
        self.root_entity_types = root_entity_types or []


class _FakeEngine:
    def __init__(self, resolved: Optional[_FakeResolved]):
        self._resolved = resolved

    async def get_resolved_ontology(self):
        return self._resolved


class _FakeStatsRow:
    def __init__(self, node_count=200_000, top_level_nodes=None, top_level_updated_at=None):
        self.node_count = node_count
        self.top_level_nodes = top_level_nodes
        self.top_level_updated_at = top_level_updated_at


CONTAINMENT = ["CONTAINS"]
ROOT_TYPES = ["Domain"]
DIGEST = top_level_cache.containment_digest(CONTAINMENT, ROOT_TYPES)


def _engine(resolved: bool = True) -> _FakeEngine:
    return _FakeEngine(_FakeResolved(CONTAINMENT, ROOT_TYPES) if resolved else None)


def _fresh_ts() -> str:
    return datetime.now(timezone.utc).isoformat()


def _stale_ts() -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=400)).isoformat()


def _expired_ts() -> str:
    return (datetime.now(timezone.utc) - timedelta(days=8)).isoformat()


def _node_dict(display_name: str, entity_type: str = "Table") -> dict:
    node = GraphNode(urn=f"urn:{entity_type}:{display_name}", entityType=entity_type, displayName=display_name)
    return node.model_dump(by_alias=True, mode="json")


def _stored_payload(names, *, digest, total=None, truncated=False, entity_types=None, fingerprint=None) -> dict:
    entity_types = entity_types or ["Table"] * len(names)
    return {
        "v": 1,
        "digest": digest,
        "fingerprint": fingerprint or {
            "nodeCount": 200_000, "edgeCount": 400_000,
            "entityTypeCounts": {}, "edgeTypeCounts": {},
        },
        "totalCount": total if total is not None else len(names),
        "truncated": truncated,
        "nodes": [_node_dict(n, et) for n, et in zip(names, entity_types)],
    }


def _patch(monkeypatch, row=None, enqueue=None):
    monkeypatch.setattr(top_level_cache, "get_data_source_stats", AsyncMock(return_value=row))
    enqueue = enqueue if enqueue is not None else AsyncMock()
    monkeypatch.setattr(top_level_cache, "enqueue_stats_job_safe_ex", enqueue)
    return enqueue


# ── containment_digest ──────────────────────────────────────────────

def test_containment_digest_deterministic_and_order_insensitive():
    d1 = top_level_cache.containment_digest(["CONTAINS", "HAS_CHILD"], ["Domain", "Platform"])
    d2 = top_level_cache.containment_digest(["HAS_CHILD", "CONTAINS"], ["Platform", "Domain"])
    assert d1 == d2
    assert len(d1) == 40  # sha1 hex digest


def test_containment_digest_changes_when_type_added():
    d1 = top_level_cache.containment_digest(["CONTAINS"], ["Domain"])
    d2 = top_level_cache.containment_digest(["CONTAINS", "HAS_CHILD"], ["Domain"])
    assert d1 != d2


# ── should_rematerialize ─────────────────────────────────────────────

def _stored():
    return {
        "v": 1,
        "digest": "abc",
        "fingerprint": {
            "nodeCount": 100, "edgeCount": 200,
            "entityTypeCounts": {"Table": 100}, "edgeTypeCounts": {"REL": 200},
        },
    }


def _fresh_stats():
    return {
        "nodeCount": 100, "edgeCount": 200,
        "entityTypeCounts": {"Table": 100}, "edgeTypeCounts": {"REL": 200},
    }


def test_should_rematerialize_true_when_missing():
    assert top_level_cache.should_rematerialize(None, fresh_stats=_fresh_stats(), digest="abc", dirty=False)


def test_should_rematerialize_true_when_version_mismatch():
    stored = _stored()
    stored["v"] = 2
    assert top_level_cache.should_rematerialize(stored, fresh_stats=_fresh_stats(), digest="abc", dirty=False)


@pytest.mark.parametrize("field", ["nodeCount", "edgeCount", "entityTypeCounts", "edgeTypeCounts"])
def test_should_rematerialize_true_on_each_fingerprint_field_mismatch(field):
    fresh = _fresh_stats()
    fresh[field] = {"Other": 1} if isinstance(fresh[field], dict) else fresh[field] + 1
    assert top_level_cache.should_rematerialize(_stored(), fresh_stats=fresh, digest="abc", dirty=False)


def test_should_rematerialize_true_on_digest_mismatch():
    assert top_level_cache.should_rematerialize(_stored(), fresh_stats=_fresh_stats(), digest="different", dirty=False)


def test_should_rematerialize_true_when_dirty():
    assert top_level_cache.should_rematerialize(_stored(), fresh_stats=_fresh_stats(), digest="abc", dirty=True)


def test_should_rematerialize_false_steady_state():
    assert not top_level_cache.should_rematerialize(_stored(), fresh_stats=_fresh_stats(), digest="abc", dirty=False)


# ── build_top_level_payload / round-trip ────────────────────────────

def _result(nodes, total, has_more) -> TopLevelNodesResult:
    return TopLevelNodesResult(
        nodes=nodes, totalCount=total, hasMore=has_more, nextCursor=None,
        rootTypeCount=0, orphanCount=0,
    )


def test_build_payload_round_trip_nodes_rehydrate():
    nodes = [
        GraphNode(urn="urn:1", entityType="Table", displayName="Alpha"),
        GraphNode(urn="urn:2", entityType="Domain", displayName="Beta"),
    ]
    stats = {"nodeCount": 2, "edgeCount": 0, "entityTypeCounts": {}, "edgeTypeCounts": {}}
    serialized = top_level_cache.build_top_level_payload(_result(nodes, 2, False), stats=stats, digest="d1")
    payload = json.loads(serialized)

    assert payload["v"] == 1
    assert payload["digest"] == "d1"
    assert payload["truncated"] is False
    rehydrated = [GraphNode.model_validate(n) for n in payload["nodes"]]
    assert [n.display_name for n in rehydrated] == ["Alpha", "Beta"]
    assert [n.entity_type for n in rehydrated] == ["Table", "Domain"]


def test_build_payload_truncated_true_when_has_more():
    nodes = [GraphNode(urn="urn:1", entityType="Table", displayName="Alpha")]
    stats = {"nodeCount": 5, "edgeCount": 0, "entityTypeCounts": {}, "edgeTypeCounts": {}}
    serialized = top_level_cache.build_top_level_payload(_result(nodes, 5, True), stats=stats, digest="d1")
    assert json.loads(serialized)["truncated"] is True


def test_build_payload_truncated_true_when_fewer_nodes_than_total():
    nodes = [GraphNode(urn="urn:1", entityType="Table", displayName="Alpha")]
    stats = {"nodeCount": 5, "edgeCount": 0, "entityTypeCounts": {}, "edgeTypeCounts": {}}
    serialized = top_level_cache.build_top_level_payload(_result(nodes, 5, False), stats=stats, digest="d1")
    assert json.loads(serialized)["truncated"] is True


def test_build_payload_truncated_false_when_complete():
    nodes = [GraphNode(urn="urn:1", entityType="Table", displayName="Alpha")]
    stats = {"nodeCount": 1, "edgeCount": 0, "entityTypeCounts": {}, "edgeTypeCounts": {}}
    serialized = top_level_cache.build_top_level_payload(_result(nodes, 1, False), stats=stats, digest="d1")
    assert json.loads(serialized)["truncated"] is False


def test_build_payload_byte_cap_truncates_and_logs_warning(monkeypatch, caplog):
    monkeypatch.setattr(top_level_cache, "_MAX_PAYLOAD_BYTES", 200)
    nodes = [
        GraphNode(urn=f"urn:{i}", entityType="Table", displayName=f"Node{i:04d}")
        for i in range(250)
    ]
    stats = {"nodeCount": 250, "edgeCount": 0, "entityTypeCounts": {}, "edgeTypeCounts": {}}
    caplog.set_level(logging.WARNING, logger="backend.app.services.top_level_cache")

    serialized = top_level_cache.build_top_level_payload(_result(nodes, 250, False), stats=stats, digest="d1")
    payload = json.loads(serialized)

    assert len(payload["nodes"]) == 200
    assert payload["truncated"] is True
    assert any("oversized" in rec.message for rec in caplog.records)


# ── try_serve_top_level: kill switch / row / small graph ────────────

@pytest.mark.asyncio
async def test_try_serve_kill_switch_off(monkeypatch):
    monkeypatch.setenv("TOP_LEVEL_SERVE_MATERIALIZED", "false")
    get_stats = AsyncMock()
    enqueue = _patch(monkeypatch, row=None, enqueue=AsyncMock())
    monkeypatch.setattr(top_level_cache, "get_data_source_stats", get_stats)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert (result, total) == (None, None)
    get_stats.assert_not_awaited()
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_try_serve_no_row(monkeypatch):
    enqueue = _patch(monkeypatch, row=None)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert (result, total) == (None, None)
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_try_serve_small_graph_no_enqueue(monkeypatch):
    row = _FakeStatsRow(node_count=500)
    enqueue = _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert (result, total) == (None, None)
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_try_serve_no_payload_enqueues(monkeypatch):
    row = _FakeStatsRow(top_level_nodes=None)
    enqueue = _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert (result, total) == (None, None)
    enqueue.assert_awaited_once()


@pytest.mark.asyncio
async def test_try_serve_version_mismatch_no_enqueue(monkeypatch):
    payload = _stored_payload(["Alpha"], digest=DIGEST)
    payload["v"] = 2
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    enqueue = _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert (result, total) == (None, None)
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_try_serve_ontology_unresolved_no_enqueue(monkeypatch):
    payload = _stored_payload(["Alpha"], digest=DIGEST)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    enqueue = _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(resolved=False), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert (result, total) == (None, None)
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_try_serve_digest_mismatch_enqueues(monkeypatch):
    payload = _stored_payload(["Alpha"], digest="stale-digest")
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    enqueue = _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert (result, total) == (None, None)
    enqueue.assert_awaited_once()


# ── freshness tiers ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_try_serve_fresh_serves_without_enqueue(monkeypatch):
    payload = _stored_payload(["Alpha", "Beta"], digest=DIGEST)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    enqueue = _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert result is not None
    assert [n.display_name for n in result.nodes] == ["Alpha", "Beta"]
    enqueue.assert_not_awaited()


@pytest.mark.asyncio
async def test_try_serve_stale_serves_and_enqueues(monkeypatch):
    payload = _stored_payload(["Alpha", "Beta"], digest=DIGEST)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_stale_ts())
    enqueue = _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert result is not None
    enqueue.assert_awaited_once()


@pytest.mark.asyncio
async def test_try_serve_expired_returns_none_with_total_and_enqueues(monkeypatch):
    payload = _stored_payload(["Alpha", "Beta"], digest=DIGEST, total=2)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_expired_ts())
    enqueue = _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert result is None
    assert total == 2
    enqueue.assert_awaited_once()


# ── slicing ───────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_try_serve_first_page(monkeypatch):
    names = ["Alpha", "Beta", "Delta", "Epsilon", "Gamma"]
    payload = _stored_payload(names, digest=DIGEST, total=5)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    _patch(monkeypatch, row=row)

    result, _ = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=3, cursor=None,
    )
    assert [n.display_name for n in result.nodes] == ["Alpha", "Beta", "Delta"]
    assert result.has_more is True
    assert result.next_cursor == "Delta"
    assert result.total_count == 5


@pytest.mark.asyncio
async def test_try_serve_mid_window_cursor(monkeypatch):
    names = ["Alpha", "Beta", "Delta", "Epsilon", "Gamma"]
    payload = _stored_payload(names, digest=DIGEST, total=5)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    _patch(monkeypatch, row=row)

    result, _ = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=2, cursor="Beta",
    )
    assert [n.display_name for n in result.nodes] == ["Delta", "Epsilon"]
    assert result.has_more is True
    assert result.next_cursor == "Epsilon"


@pytest.mark.asyncio
async def test_try_serve_duplicate_display_names_at_cursor_boundary(monkeypatch):
    names = ["Alpha", "Beta", "Beta", "Gamma"]
    payload = _stored_payload(names, digest=DIGEST, total=4)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    _patch(monkeypatch, row=row)

    first, _ = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=2, cursor=None,
    )
    assert [n.display_name for n in first.nodes] == ["Alpha", "Beta"]
    assert first.next_cursor == "Beta"

    # Strict '>' excludes the duplicate "Beta" — matches live FalkorDB
    # cursor semantics (contract-identical, not a caching bug).
    second, _ = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=2, cursor="Beta",
    )
    assert [n.display_name for n in second.nodes] == ["Gamma"]


@pytest.mark.asyncio
async def test_try_serve_beyond_window_truncated_goes_live(monkeypatch):
    payload = _stored_payload(["Alpha", "Beta"], digest=DIGEST, total=500, truncated=True)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor="Zeta",
    )
    assert result is None
    assert total == 500


@pytest.mark.asyncio
async def test_try_serve_beyond_window_not_truncated_serves_empty_page(monkeypatch):
    payload = _stored_payload(["Alpha", "Beta"], digest=DIGEST, total=2, truncated=False)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    _patch(monkeypatch, row=row)

    result, total = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor="Zeta",
    )
    assert result is not None
    assert result.nodes == []
    assert result.has_more is False
    assert result.next_cursor is None
    assert result.total_count == 2


@pytest.mark.asyncio
async def test_try_serve_limit_exceeds_window_truncated_has_more_true(monkeypatch):
    payload = _stored_payload(["Alpha", "Beta"], digest=DIGEST, total=500, truncated=True)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    _patch(monkeypatch, row=row)

    result, _ = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert [n.display_name for n in result.nodes] == ["Alpha", "Beta"]
    assert result.has_more is True
    assert result.next_cursor == "Beta"


# ── classification ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_try_serve_classifies_root_and_orphan_nodes(monkeypatch):
    names = ["Alpha", "Beta", "Delta", "Gamma"]
    entity_types = ["Domain", "Domain", "Schema", "Table"]
    payload = _stored_payload(names, digest=DIGEST, total=4, entity_types=entity_types)
    row = _FakeStatsRow(top_level_nodes=json.dumps(payload), top_level_updated_at=_fresh_ts())
    _patch(monkeypatch, row=row)

    result, _ = await top_level_cache.try_serve_top_level(
        session=object(), engine=_engine(), ds_id="ds1", ws_id="ws1", limit=10, cursor=None,
    )
    assert result.root_type_count == 2
    assert result.orphan_count == 2


# ── dirty flag ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_consume_dirty_flag_true_when_set(monkeypatch):
    redis = AsyncMock()
    redis.getdel = AsyncMock(return_value="1")
    monkeypatch.setattr(top_level_cache, "get_redis", lambda: redis)

    assert await top_level_cache.consume_dirty_flag("ds1") is True
    redis.getdel.assert_awaited_once_with("insights:toplevel:dirty:ds1")


@pytest.mark.asyncio
async def test_consume_dirty_flag_false_when_absent(monkeypatch):
    redis = AsyncMock()
    redis.getdel = AsyncMock(return_value=None)
    monkeypatch.setattr(top_level_cache, "get_redis", lambda: redis)

    assert await top_level_cache.consume_dirty_flag("ds1") is False


@pytest.mark.asyncio
async def test_consume_dirty_flag_swallows_redis_errors(monkeypatch):
    redis = AsyncMock()
    redis.getdel = AsyncMock(side_effect=Exception("boom"))
    monkeypatch.setattr(top_level_cache, "get_redis", lambda: redis)

    assert await top_level_cache.consume_dirty_flag("ds1") is False


@pytest.mark.asyncio
async def test_restore_dirty_flag_sets_with_ttl(monkeypatch):
    redis = AsyncMock()
    monkeypatch.setattr(top_level_cache, "get_redis", lambda: redis)

    await top_level_cache.restore_dirty_flag("ds1")
    redis.set.assert_awaited_once_with("insights:toplevel:dirty:ds1", "1", ex=86400)


@pytest.mark.asyncio
async def test_restore_dirty_flag_swallows_redis_errors(monkeypatch):
    redis = AsyncMock()
    redis.set = AsyncMock(side_effect=Exception("boom"))
    monkeypatch.setattr(top_level_cache, "get_redis", lambda: redis)

    await top_level_cache.restore_dirty_flag("ds1")  # must not raise
