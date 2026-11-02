"""No stats path reads a fork's whole graph — needs Postgres.

A fork's data source has a row, so every way a data source's stats are polled found it: a publish
on the fork nudged the insights poll, a stats read that missed the cache queued one, and the poll
built the fork's engine and asked it for its counts — through Postgres, which composes the whole
graph, parent's entities included, in one process. A fork's counts are not the root's store's
counts plus its patch set (the overlay keeps none), so a fork has no stats of its own: nothing
queues a poll for it, a poll queued before this answers that it is not available for a fork, and a
stats read says so instead of "computing" for a poll that never lands.
"""
import os
from datetime import datetime, timezone

import pytest

from backend.app.services.versioning import config
from backend.tests.integration.test_fork_data_sources import WS, _client, _fork, _parent
from backend.tests.integration.test_fork_overlay_delta import _n, _run
from backend.tests.integration.test_versioning_bounded_reads import _whole_graph_reads_refused

pytestmark = [pytest.mark.integration, pytest.mark.skipif(
    not os.getenv("GRAPHVER_E2E"), reason="set GRAPHVER_E2E=1 + a live Postgres to run")]


def test_no_stats_path_reads_a_forks_whole_graph(monkeypatch, forks_on):
    from backend.app.services import projection_target, stats_cache
    from backend.insights_service import collector, enqueue
    from backend.insights_service.schemas import StatsJobEnvelope

    queued = []

    async def claimed(envelope, **kw):
        queued.append(envelope.data_source_id)
        return "1-0"

    class _Redis:
        async def set(self, *a, **kw):
            return True

    monkeypatch.setattr(enqueue, "enqueue_job", claimed)
    monkeypatch.setattr(enqueue, "get_redis", lambda: _Redis())
    # The fork reads Postgres: its reader's counts would compose the whole graph.
    monkeypatch.setattr(config, "FORK_REWIND_MAX", 0)

    async def case(svc):
        parent_ds, gid = await _parent(svc, pinned=True)
        await svc.apply_ops(graph_id=gid, actor="alice", message="seed", ops=[_n("A"), _n("B")])
        async with _client() as c:
            fork = (await _fork(c, gid)).json()
        fork_ds = fork["dataSourceId"]
        await svc.apply_ops(graph_id=fork["graphId"], actor="u_forker", message="own", ops=[_n("C")])

        with _whole_graph_reads_refused():
            await projection_target.nudge_stats_after_projection(fork_ds)      # a fork's publish
            assert await enqueue.enqueue_stats_job_safe(fork_ds, WS) is None   # a cache miss
            assert await enqueue.enqueue_stats_job_safe_ex(fork_ds, WS) == (None, "fork")
            assert await enqueue.enqueue_stats_job(fork_ds, WS) is None
            await enqueue.mark_stats_changed(fork_ds, WS)
            assert queued == []
            with pytest.raises(RuntimeError, match="not available for a fork"):  # one queued before
                await collector.collect_counts(StatsJobEnvelope(
                    data_source_id=fork_ds, workspace_id=WS,
                    enqueued_at=datetime.now(timezone.utc)))
        meta = stats_cache.build_computing_envelope(fork_ds, WS, None)["meta"]
        assert (meta["status"], meta["refreshing"], meta.get("poll_url")) == (
            "unavailable", False, None), meta
        assert meta["missing_fields"] == [stats_cache.FORK_STATS]

        # Its parent's are polled as ever.
        await projection_target.nudge_stats_after_projection(parent_ds)
        assert queued == [parent_ds]
        assert stats_cache.build_computing_envelope(parent_ds, WS, "2-0")["meta"]["status"] \
            == "computing"
    _run(case)
