"""Task 5: top-level-nodes materialization in the counts lane.

Covers the ``collect_counts`` materialization step (added after the
counts upsert) and the dirty-flag write in ``enqueue.mark_stats_changed``:

* Large graphs materialize the top-level payload; small graphs don't.
* Change detection short-circuits steady-state polls (no provider work).
* The Redis dirty flag forces a recompute even when the fingerprint
  matches, and is restored when the recompute fails.
* Session discipline: the roots query + its admission gate never run
  while a DB session is held.

Mirrors the fake-provider/engine/session approach of
``test_insights_handler_sessions.py``.
"""
from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from backend.app.config import resilience
from backend.app.db.models import DataSourcePollingConfigORM
from backend.app.db.repositories import stats_repo
from backend.app.services.top_level_cache import containment_digest
from backend.common.models.graph import GraphNode, TopLevelNodesResult
from backend.insights_service import cache_warmer, collector
from backend.insights_service.schemas import StatsJobEnvelope

_CONTAINMENT = ["CONTAINS"]
_ROOTS = ["dataset"]
_FP_FIELDS = ("nodeCount", "edgeCount", "entityTypeCounts", "edgeTypeCounts")


def _envelope() -> StatsJobEnvelope:
    return StatsJobEnvelope(
        data_source_id="ds1", workspace_id="ws1",
        enqueued_at=datetime.now(timezone.utc),
    )


def _stats(node_count: int = 150_000) -> dict:
    return {
        "nodeCount": node_count,
        "edgeCount": 42,
        "entityTypeCounts": {"dataset": node_count},
        "edgeTypeCounts": {"CONTAINS": 42},
    }


def _resolved(containment=_CONTAINMENT, roots=_ROOTS):
    return SimpleNamespace(
        containment_edge_types=list(containment),
        root_entity_types=list(roots),
    )


def _tl_result(n: int = 3, total: int = 150_000) -> TopLevelNodesResult:
    nodes = [
        GraphNode(urn=f"urn:{i}", entityType="dataset", displayName=f"node{i}", childCount=i)
        for i in range(n)
    ]
    return TopLevelNodesResult(
        nodes=nodes, totalCount=total, hasMore=False, nextCursor=None,
        rootTypeCount=n, orphanCount=0,
    )


def _stored_payload(stats: dict, digest: str, *, fingerprint=None) -> str:
    fp = fingerprint or {k: stats[k] for k in _FP_FIELDS}
    return json.dumps({
        "v": 1, "digest": digest, "fingerprint": fp,
        "totalCount": stats["nodeCount"], "truncated": False, "nodes": [],
    })


def _wire(
    monkeypatch,
    *,
    stats: dict,
    resolved,
    stored_top_level=None,
    stored_updated_at=None,
    tl_result=None,
    tl_raises=None,
    resolved_after=None,
    dirty: bool = False,
):
    """Shared fakes for ``collect_counts`` materialization tests.

    Returns a namespace of observations: ``events`` (ordered session /
    provider-IO trace), ``upserts``, ``tl_calls``, ``sets``, ``touched``,
    ``consumed``, ``restored``, ``polling_config``.

    ``resolved_after`` (when set) is what ``get_resolved_ontology`` returns
    AFTER the roots query runs — simulating a mid-query ontology re-resolve.
    """
    events: list[str] = []
    polling_config = SimpleNamespace(
        last_polled_at=None, last_status=None, last_error="prev",
    )
    stored_row = SimpleNamespace(
        top_level_nodes=stored_top_level,
        top_level_updated_at=stored_updated_at,
        node_count=stats["nodeCount"],
        edge_count=stats["edgeCount"],
    )

    class _FakeSession:
        async def get(self, orm, _key):
            if orm is DataSourcePollingConfigORM:
                return polling_config
            return SimpleNamespace(provider_id="prov1")

    @asynccontextmanager
    async def fake_jobs_session():
        events.append("session_open")
        yield _FakeSession()
        events.append("session_close")

    monkeypatch.setattr(collector, "get_jobs_session", fake_jobs_session)

    async def fake_get_stats(bypass_cache=False):
        events.append(f"io:get_stats(bypass={bypass_cache})")
        return stats

    provider = SimpleNamespace(get_stats=fake_get_stats)

    resolved_state = {"current": resolved}

    async def fake_get_resolved_ontology():
        return resolved_state["current"]

    tl_calls: list[dict] = []

    async def fake_top_level(**kw):
        events.append("io:get_top_level")
        tl_calls.append(kw)
        if resolved_after is not None:
            resolved_state["current"] = resolved_after
        if tl_raises is not None:
            raise tl_raises
        return tl_result

    engine = SimpleNamespace(
        provider=provider,
        get_resolved_ontology=fake_get_resolved_ontology,
        get_top_level_or_orphan_nodes=fake_top_level,
        get_ontology_metadata=AsyncMock(),
    )
    monkeypatch.setattr(
        collector.ContextEngine, "for_workspace", AsyncMock(return_value=engine),
    )

    @asynccontextmanager
    async def noop_gate(*_a, **_kw):
        yield

    monkeypatch.setattr(collector.admission, "gate", noop_gate)

    upserts: list[dict] = []

    async def fake_upsert_counts(**kw):
        events.append("upsert_counts")
        upserts.append(kw)

    monkeypatch.setattr(collector, "upsert_data_source_stats_counts", fake_upsert_counts)

    reads: list[str] = []

    async def fake_get_ds_stats(_session, ds_id):
        events.append("get_stored")
        reads.append(ds_id)
        return stored_row

    sets: list[str] = []

    async def fake_set_top_level(_session, _ds_id, payload_json):
        events.append("set_top_level")
        sets.append(payload_json)

    touched: list[str] = []

    async def fake_touch_freshness(_session, ds_id):
        events.append("touch_freshness")
        touched.append(ds_id)
        # Mirror the real helper: advance the freshness marker, leave the
        # stored payload bytes untouched.
        stored_row.top_level_updated_at = datetime.now(timezone.utc).isoformat()

    monkeypatch.setattr(stats_repo, "get_data_source_stats", fake_get_ds_stats)
    monkeypatch.setattr(stats_repo, "set_top_level_nodes", fake_set_top_level)
    monkeypatch.setattr(stats_repo, "touch_top_level_freshness", fake_touch_freshness)

    consumed: list[str] = []
    restored: list[str] = []

    async def fake_consume(ds_id):
        consumed.append(ds_id)
        return dirty

    async def fake_restore(ds_id):
        restored.append(ds_id)

    monkeypatch.setattr(collector, "consume_dirty_flag", fake_consume)
    monkeypatch.setattr(collector, "restore_dirty_flag", fake_restore)

    monkeypatch.setattr(cache_warmer, "schedule_warm", lambda **_kw: None)

    return SimpleNamespace(
        events=events, upserts=upserts, tl_calls=tl_calls, sets=sets,
        touched=touched, reads=reads, consumed=consumed, restored=restored,
        polling_config=polling_config, stored_row=stored_row,
    )


def _assert_no_io_in_session(events: list[str]) -> None:
    """Provider IO must never run while a DB session is held."""
    depth = 0
    for e in events:
        if e == "session_open":
            depth += 1
        elif e == "session_close":
            depth -= 1
        elif e.startswith("io:"):
            assert depth == 0, f"provider IO {e!r} held a session (depth={depth}): {events}"
    assert depth == 0, f"unbalanced sessions: {events}"


@pytest.mark.asyncio
async def test_big_graph_no_payload_materializes(monkeypatch) -> None:
    stats = _stats(150_000)
    obs = _wire(
        monkeypatch, stats=stats, resolved=_resolved(),
        stored_top_level=None, tl_result=_tl_result(3),
    )

    await collector.collect_counts(_envelope())

    # Counts upsert still happened, and the roots query materialized.
    assert len(obs.upserts) == 1
    assert len(obs.tl_calls) == 1
    assert obs.tl_calls[0]["limit"] == collector.TOP_LEVEL_MATERIALIZE_LIMIT == 1000
    assert obs.tl_calls[0]["include_child_count"] is True
    assert obs.tl_calls[0]["query_timeout"] == resilience.STATS_POLL_TIMEOUT_LARGE_SECS
    assert len(obs.sets) == 1
    payload = json.loads(obs.sets[0])
    assert payload["v"] == 1
    assert payload["totalCount"] == 150_000
    assert len(payload["nodes"]) == 3
    assert payload["digest"] == containment_digest(_CONTAINMENT, _ROOTS)
    _assert_no_io_in_session(obs.events)


@pytest.mark.asyncio
async def test_steady_state_skips_engine(monkeypatch) -> None:
    stats = _stats(150_000)
    digest = containment_digest(_CONTAINMENT, _ROOTS)
    obs = _wire(
        monkeypatch, stats=stats, resolved=_resolved(),
        stored_top_level=_stored_payload(stats, digest),
        tl_result=_tl_result(3), dirty=False,
    )

    await collector.collect_counts(_envelope())

    # Fingerprint + digest match and not dirty → no roots query, no rewrite.
    assert obs.tl_calls == []
    assert obs.sets == []
    assert len(obs.upserts) == 1  # counts still refreshed
    assert obs.consumed == ["ds1"]
    assert obs.restored == []


@pytest.mark.asyncio
async def test_dirty_flag_forces_recompute(monkeypatch) -> None:
    stats = _stats(150_000)
    digest = containment_digest(_CONTAINMENT, _ROOTS)
    obs = _wire(
        monkeypatch, stats=stats, resolved=_resolved(),
        stored_top_level=_stored_payload(stats, digest),  # would otherwise skip
        tl_result=_tl_result(3), dirty=True,
    )

    await collector.collect_counts(_envelope())

    # Dirty forces a rebuild despite the matching fingerprint; the flag
    # was consumed and NOT restored (the rebuild succeeded).
    assert len(obs.tl_calls) == 1
    assert len(obs.sets) == 1
    assert obs.consumed == ["ds1"]
    assert obs.restored == []


@pytest.mark.asyncio
async def test_sub_threshold_does_no_materialization(monkeypatch) -> None:
    stats = _stats(50_000)  # below STATS_POLL_LARGE_THRESHOLD (100k)
    obs = _wire(
        monkeypatch, stats=stats, resolved=_resolved(),
        stored_top_level=None, tl_result=_tl_result(3),
    )

    await collector.collect_counts(_envelope())

    assert len(obs.upserts) == 1
    assert obs.reads == []        # stored payload never read
    assert obs.consumed == []     # dirty flag never touched
    assert obs.tl_calls == []
    assert obs.sets == []


@pytest.mark.asyncio
async def test_engine_failure_preserves_counts_and_restores_dirty(monkeypatch) -> None:
    stats = _stats(150_000)
    obs = _wire(
        monkeypatch, stats=stats, resolved=_resolved(),
        stored_top_level=None,
        tl_raises=asyncio.TimeoutError("roots query timed out"),
        dirty=True,
    )

    # Must not raise out of collect_counts.
    await collector.collect_counts(_envelope())

    assert len(obs.upserts) == 1                       # counts write intact
    assert obs.polling_config.last_status == "success"  # poll-success stamp intact
    assert len(obs.tl_calls) == 1                      # attempted the roots query
    assert obs.sets == []                              # write never happened
    assert obs.restored == ["ds1"]                     # consumed dirty flag restored


@pytest.mark.asyncio
async def test_detection_uses_payload_fingerprint_not_row_columns(monkeypatch) -> None:
    """Deep-poll-first ordering: the stored ROW counts equal fresh stats,
    but the in-payload fingerprint differs → must rematerialize. Change
    detection reads the payload's fingerprint, not the row's count columns."""
    stats = _stats(150_000)
    digest = containment_digest(_CONTAINMENT, _ROOTS)
    stale_fp = {k: stats[k] for k in _FP_FIELDS}
    stale_fp["edgeCount"] = 999  # payload fingerprint diverges from fresh stats
    obs = _wire(
        monkeypatch, stats=stats, resolved=_resolved(),
        stored_top_level=_stored_payload(stats, digest, fingerprint=stale_fp),
        tl_result=_tl_result(3), dirty=False,
    )
    # Row columns match fresh stats exactly (would fool a row-based check).
    assert obs.stored_row.node_count == stats["nodeCount"]
    assert obs.stored_row.edge_count == stats["edgeCount"]

    await collector.collect_counts(_envelope())

    assert len(obs.tl_calls) == 1
    assert len(obs.sets) == 1


@pytest.mark.asyncio
async def test_resolved_none_skips_materialization(monkeypatch) -> None:
    stats = _stats(150_000)
    obs = _wire(
        monkeypatch, stats=stats, resolved=None,  # ontology resolution failed
        stored_top_level=None, tl_result=_tl_result(3),
    )

    await collector.collect_counts(_envelope())

    assert len(obs.upserts) == 1   # counts still upserted
    assert obs.reads == []         # no materialization work
    assert obs.consumed == []
    assert obs.tl_calls == []
    assert obs.sets == []


@pytest.mark.asyncio
async def test_steady_state_skip_advances_freshness(monkeypatch) -> None:
    """Finding 1: the skip branch must advance ``top_level_updated_at`` (like
    the deep lane's touch_schema_freshness) so a stable large graph's payload
    never ages into the serve path's absolute-expiry tier and forces the live
    O(N) scan. Timestamp-only — the payload bytes are untouched and the roots
    query never runs."""
    stats = _stats(150_000)
    digest = containment_digest(_CONTAINMENT, _ROOTS)
    stored = _stored_payload(stats, digest)
    old_ts = "2000-01-01T00:00:00+00:00"
    obs = _wire(
        monkeypatch, stats=stats, resolved=_resolved(),
        stored_top_level=stored, stored_updated_at=old_ts,
        tl_result=_tl_result(3), dirty=False,
    )

    await collector.collect_counts(_envelope())

    # Engine roots method not called, payload not rewritten...
    assert obs.tl_calls == []
    assert obs.sets == []
    # ...but freshness advanced off the stale timestamp, payload bytes intact.
    assert obs.touched == ["ds1"]
    assert obs.stored_row.top_level_updated_at > old_ts
    assert obs.stored_row.top_level_nodes == stored
    assert len(obs.upserts) == 1  # counts still refreshed


@pytest.mark.asyncio
async def test_ontology_shift_mid_query_skips_persist(monkeypatch) -> None:
    """Finding 2: if the ontology re-resolves mid roots-query (TTL lapse) to a
    shape different from the digest stamped pre-query, do NOT persist — the
    nodes were computed under a different ontology than the digest claims. The
    counts write + poll-success stamp stay intact and the consumed dirty flag
    is restored so the next poll retries. No exception escapes."""
    stats = _stats(150_000)
    before = _resolved(["CONTAINS"], ["dataset"])
    after = _resolved(["OWNS"], ["schema"])  # different digest
    assert containment_digest(
        ["CONTAINS"], ["dataset"]
    ) != containment_digest(["OWNS"], ["schema"])
    obs = _wire(
        monkeypatch, stats=stats, resolved=before,
        stored_top_level=None, resolved_after=after,
        tl_result=_tl_result(3), dirty=True,
    )

    await collector.collect_counts(_envelope())

    assert len(obs.tl_calls) == 1                       # roots query ran
    assert obs.sets == []                               # but nothing persisted
    assert obs.consumed == ["ds1"]
    assert obs.restored == ["ds1"]                      # consumed dirty flag restored
    assert len(obs.upserts) == 1                        # counts write intact
    assert obs.polling_config.last_status == "success"  # poll-success stamp intact


@pytest.mark.asyncio
async def test_mark_stats_changed_sets_dirty_flag_and_enqueues(monkeypatch) -> None:
    from backend.insights_service import enqueue as enqueue_mod

    sets: list[tuple] = []

    class _Redis:
        async def set(self, key, val, nx=False, ex=None):
            sets.append((key, val, nx, ex))
            return True

    monkeypatch.setattr(enqueue_mod, "get_redis", lambda: _Redis())

    enqueued: list[tuple] = []

    async def fake_safe(ds, ws, **_kw):
        enqueued.append((ds, ws))
        return "1-1"

    monkeypatch.setattr(enqueue_mod, "enqueue_stats_job_safe", fake_safe)

    await enqueue_mod.mark_stats_changed("ds1", "ws1")

    # Dirty flag set with the 24h TTL, cooldown gate still set, still enqueues.
    assert ("insights:toplevel:dirty:ds1", "1", False, 86400) in sets
    assert any(k == "insights:stats:cooldown:ds1" for (k, *_rest) in sets)
    assert enqueued == [("ds1", "ws1")]
