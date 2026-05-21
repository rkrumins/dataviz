"""Unit tests for the Graph Store outbox relay.

DB-independent: the Graph Store models use Postgres ``JSONB`` (a
plan-approved deviation) so they cannot run on the test-suite's SQLite.
We test the relay *contract* — claim → publish → mark processed, batch
handling, empty poll, publish-failure leaves rows unprocessed — with a
mocked session, which is exactly the behaviour the at-least-once
delivery guarantee depends on.
"""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from backend.app.services.graph_outbox_relay import (
    GRAPH_OUTBOX_STREAM,
    drain_once,
    sse_subscribe,
)


def _event(i: int) -> SimpleNamespace:
    return SimpleNamespace(
        id=f"evt_{i}",
        event_type="visualization.graph.committed",
        event_version=1,
        aggregate_type="graph",
        aggregate_id=f"g_{i}",
        payload={"i": i},
        processed=False,
    )


def _session_returning(rows):
    """A fake AsyncSession whose execute() yields `rows` via
    .scalars().all() — mirrors the SELECT ... FOR UPDATE SKIP LOCKED."""
    result = MagicMock()
    result.scalars.return_value.all.return_value = rows
    session = MagicMock()
    session.execute = AsyncMock(return_value=result)
    return session


@pytest.mark.asyncio
async def test_drain_publishes_then_marks_processed():
    rows = [_event(0), _event(1), _event(2)]
    published = []

    async def publish(ev):
        # Contract: must NOT be marked processed before publish returns.
        assert ev.processed is False
        published.append(ev.id)

    n = await drain_once(_session_returning(rows), publish, batch_size=100)

    assert n == 3
    assert published == ["evt_0", "evt_1", "evt_2"]
    assert all(r.processed is True for r in rows)


@pytest.mark.asyncio
async def test_drain_empty_is_noop():
    published = []
    n = await drain_once(_session_returning([]), lambda e: published.append(e))
    assert n == 0
    assert published == []


@pytest.mark.asyncio
async def test_publish_failure_aborts_batch_unprocessed():
    rows = [_event(0), _event(1), _event(2)]

    async def publish(ev):
        if ev.id == "evt_1":
            raise RuntimeError("redis down")

    with pytest.raises(RuntimeError, match="redis down"):
        await drain_once(_session_returning(rows), publish, batch_size=100)

    # evt_0 published+marked, evt_1 failed mid-publish, evt_2 untouched.
    # The caller's session scope rolls the whole transaction back, so
    # NONE of these processed=True values are ever committed — the
    # batch is retried wholesale next poll (at-least-once).
    assert rows[0].processed is True   # set in-memory, but rolled back by scope
    assert rows[1].processed is False
    assert rows[2].processed is False


@pytest.mark.asyncio
async def test_batch_size_forwarded_to_query_limit():
    session = _session_returning([])
    await drain_once(session, AsyncMock(), batch_size=7)
    # The compiled statement should carry our limit; assert via the
    # statement object passed to execute().
    stmt = session.execute.call_args[0][0]
    from sqlalchemy.dialects import postgresql

    compiled = str(
        stmt.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )
    assert "LIMIT 7" in compiled
    assert "FOR UPDATE SKIP LOCKED" in compiled


# ── SSE subscriber ─────────────────────────────────────────────────


class _FakeRedis:
    """Minimal Redis stand-in: returns a scripted sequence of XREAD
    results, then signals stop. One subscriber per fake."""

    def __init__(self, scripted):
        # scripted = list of (entries, post_action) tuples.
        # entries: same shape Redis returns: [(stream, [(id, fields), ...]), ...] or [].
        # post_action: callable(stop_event) invoked after this yield.
        self._scripted = list(scripted)
        self.xread_calls = []

    async def xread(self, streams, block):
        self.xread_calls.append((dict(streams), block))
        if not self._scripted:
            # No more events — just block-sleep then return empty.
            await asyncio.sleep(0.01)
            return []
        entries, post = self._scripted.pop(0)
        if post is not None:
            post()
        return entries


def _commit_fields(graph_id: str, branch: str, commit_id: str) -> dict:
    return {
        "event_id": f"evt_{commit_id}",
        "event_type": "visualization.graph.committed",
        "event_version": "1",
        "aggregate_type": "graph",
        "aggregate_id": graph_id,
        "payload": json.dumps({
            "graph_id": graph_id,
            "branch": branch,
            "commit_id": commit_id,
            "commit_hash": f"hash-{commit_id}",
            "root_hash": f"root-{commit_id}",
            "actor": "alice",
            "delta_summary": {"nodes_added": 1},
        }),
    }


@pytest.mark.asyncio
async def test_sse_subscribe_emits_commit_event_for_matching_branch():
    stop = asyncio.Event()
    fake = _FakeRedis([
        (
            [(GRAPH_OUTBOX_STREAM, [
                ("1700000000-0", _commit_fields("g1", "main", "c1")),
            ])],
            lambda: stop.set(),
        ),
    ])

    frames = []
    async for frame in sse_subscribe(
        graph_id="g1", branch="main",
        stop_event=stop, redis_client=fake, block_ms=10,
        heartbeat_secs=1000.0,
    ):
        frames.append(frame)

    # First frame is the ": connected" greeting.
    assert frames[0].startswith(": connected")
    # Second is the commit event.
    commit_frame = frames[1]
    assert "id: 1700000000-0\n" in commit_frame
    assert "event: commit\n" in commit_frame
    data_line = next(l for l in commit_frame.splitlines() if l.startswith("data: "))
    payload = json.loads(data_line[len("data: "):])
    assert payload["commit_id"] == "c1"
    assert payload["root_hash"] == "root-c1"
    assert payload["actor"] == "alice"


@pytest.mark.asyncio
async def test_sse_subscribe_filters_other_branches():
    stop = asyncio.Event()
    fake = _FakeRedis([
        (
            [(GRAPH_OUTBOX_STREAM, [
                ("1-0", _commit_fields("g1", "feature-x", "c1")),
                ("2-0", _commit_fields("g1", "main", "c2")),
                ("3-0", _commit_fields("g2", "main", "c3")),
            ])],
            lambda: stop.set(),
        ),
    ])

    frames = []
    async for frame in sse_subscribe(
        graph_id="g1", branch="main",
        stop_event=stop, redis_client=fake, block_ms=10,
        heartbeat_secs=1000.0,
    ):
        frames.append(frame)

    commit_frames = [f for f in frames if "event: commit" in f]
    assert len(commit_frames) == 1
    assert "id: 2-0\n" in commit_frames[0]


@pytest.mark.asyncio
async def test_sse_subscribe_uses_last_event_id_as_cursor():
    stop = asyncio.Event()
    fake = _FakeRedis([
        ([], lambda: stop.set()),
    ])

    async for _ in sse_subscribe(
        graph_id="g1", branch="main",
        last_event_id="42-0",
        stop_event=stop, redis_client=fake, block_ms=10,
    ):
        pass

    streams, _block = fake.xread_calls[0]
    assert streams == {GRAPH_OUTBOX_STREAM: "42-0"}


@pytest.mark.asyncio
async def test_sse_subscribe_defaults_to_dollar_cursor():
    stop = asyncio.Event()
    fake = _FakeRedis([
        ([], lambda: stop.set()),
    ])

    async for _ in sse_subscribe(
        graph_id="g1", branch="main",
        stop_event=stop, redis_client=fake, block_ms=10,
    ):
        pass

    streams, _block = fake.xread_calls[0]
    assert streams == {GRAPH_OUTBOX_STREAM: "$"}


@pytest.mark.asyncio
async def test_sse_subscribe_ignores_non_commit_event_types():
    stop = asyncio.Event()
    other = {
        "event_id": "evt_x",
        "event_type": "visualization.something.else",
        "event_version": "1",
        "aggregate_type": "graph",
        "aggregate_id": "g1",
        "payload": json.dumps({"graph_id": "g1", "branch": "main"}),
    }
    fake = _FakeRedis([
        (
            [(GRAPH_OUTBOX_STREAM, [("1-0", other)])],
            lambda: stop.set(),
        ),
    ])

    frames = []
    async for frame in sse_subscribe(
        graph_id="g1", branch="main",
        stop_event=stop, redis_client=fake, block_ms=10,
        heartbeat_secs=1000.0,
    ):
        frames.append(frame)

    # Only the initial ": connected" greeting; no commit frame.
    assert all("event: commit" not in f for f in frames)


def _ws_advanced_fields(graph_id, branch, user_id, ws_version):
    return {
        "event_id": "evt_ws",
        "event_type": "visualization.working_set.advanced",
        "event_version": "1",
        "aggregate_type": "working_set",
        "aggregate_id": graph_id,
        "payload": json.dumps({
            "graph_id": graph_id,
            "branch": branch,
            "user_id": user_id,
            "ws_change_version": ws_version,
        }),
    }


@pytest.mark.asyncio
async def test_sse_subscribe_emits_working_set_advanced_for_same_user():
    stop = asyncio.Event()
    fake = _FakeRedis([
        (
            [(GRAPH_OUTBOX_STREAM, [
                ("9-0", _ws_advanced_fields("g1", "main", "alice", 7)),
            ])],
            lambda: stop.set(),
        ),
    ])

    frames = []
    async for frame in sse_subscribe(
        graph_id="g1", branch="main", user_id="alice",
        stop_event=stop, redis_client=fake, block_ms=10,
        heartbeat_secs=1000.0,
    ):
        frames.append(frame)

    ws_frames = [f for f in frames if "event: working_set_advanced" in f]
    assert len(ws_frames) == 1
    data_line = next(
        l for l in ws_frames[0].splitlines() if l.startswith("data: ")
    )
    assert json.loads(data_line[len("data: "):]) == {"ws_change_version": 7}


@pytest.mark.asyncio
async def test_sse_subscribe_drops_working_set_advanced_for_other_user():
    stop = asyncio.Event()
    fake = _FakeRedis([
        (
            [(GRAPH_OUTBOX_STREAM, [
                ("9-0", _ws_advanced_fields("g1", "main", "bob", 7)),
            ])],
            lambda: stop.set(),
        ),
    ])

    frames = []
    async for frame in sse_subscribe(
        graph_id="g1", branch="main", user_id="alice",
        stop_event=stop, redis_client=fake, block_ms=10,
        heartbeat_secs=1000.0,
    ):
        frames.append(frame)

    assert all("working_set_advanced" not in f for f in frames)


@pytest.mark.asyncio
async def test_sse_subscribe_drops_working_set_advanced_when_user_id_unset():
    stop = asyncio.Event()
    fake = _FakeRedis([
        (
            [(GRAPH_OUTBOX_STREAM, [
                ("9-0", _ws_advanced_fields("g1", "main", "alice", 7)),
            ])],
            lambda: stop.set(),
        ),
    ])

    frames = []
    async for frame in sse_subscribe(
        graph_id="g1", branch="main",  # no user_id
        stop_event=stop, redis_client=fake, block_ms=10,
        heartbeat_secs=1000.0,
    ):
        frames.append(frame)

    assert all("working_set_advanced" not in f for f in frames)


@pytest.mark.asyncio
async def test_sse_subscribe_emits_heartbeat_when_silent():
    stop = asyncio.Event()

    def stop_after_first():
        # Schedule stop after a tiny delay so the loop has time to
        # emit at least one heartbeat.
        asyncio.get_event_loop().call_later(0.05, stop.set)

    fake = _FakeRedis([
        ([], stop_after_first),
    ])

    frames = []
    async for frame in sse_subscribe(
        graph_id="g1", branch="main",
        stop_event=stop, redis_client=fake, block_ms=5,
        heartbeat_secs=0.01,
    ):
        frames.append(frame)
        if any(f.startswith(": heartbeat") for f in frames):
            stop.set()

    assert any(f.startswith(": heartbeat") for f in frames)
