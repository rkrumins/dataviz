"""The job-list live overlay: one round of reads, not one per running row.

Job History polls ``GET /aggregation-jobs`` every 10s and the durable PG
counters only advance at outer-batch boundaries, so the list endpoint layers
each running row's live Redis snapshot on top. That overlay used to be a
``for`` loop of awaited snapshot reads — one serial round trip per running
row, inside a single request. Fine at the handful of concurrent jobs a small
install runs; not at a few hundred sources with a fleet of workers, where the
first paint of the page pays for every one of them in series.

These pin the shape the fix has to keep: the reads are issued together, each
row still gets ITS OWN snapshot, a snapshot that fails does not take the
request (or the other rows) with it, and terminal rows are never read at all.
"""
from __future__ import annotations

import asyncio
import types

from backend.app.api.v1.endpoints import aggregation as agg_api


def _run(coro):
    return asyncio.run(coro)


def _row(job_id, status, **over):
    return types.SimpleNamespace(
        id=job_id, status=status, processed_edges=0, total_edges=0,
        created_edges=0, progress=0, last_checkpoint_at=None, **over,
    )


class _Store:
    """Counts how many reads are in flight at once, and answers each with a
    snapshot naming the job it was asked about."""

    def __init__(self, snaps, fail=()):
        self._snaps = snaps
        self._fail = set(fail)
        self.asked: list = []
        self.in_flight = 0
        self.at_once = 0

    async def get(self, job_id):
        self.asked.append(job_id)
        self.in_flight += 1
        self.at_once = max(self.at_once, self.in_flight)
        try:
            await asyncio.sleep(0)          # a real round trip yields here
            if job_id in self._fail:
                raise ConnectionError("bus down")
            return self._snaps.get(job_id)
        finally:
            self.in_flight -= 1


def _list(rows, store, monkeypatch):
    page = types.SimpleNamespace(items=list(rows))

    class _Svc:
        async def list_jobs_global(self, session, **kw):
            return page

    import backend.app.jobs as jobs_mod
    monkeypatch.setattr(jobs_mod, "get_state_store", lambda: store)
    return _run(agg_api.list_jobs_global(request=None, svc=_Svc(), session=None))


def test_every_running_rows_snapshot_is_read_in_one_round(monkeypatch):
    rows = [_row(f"j{i}", "running") for i in range(5)]
    store = _Store({
        f"j{i}": {"processed_edges": str(i * 10), "progress": str(i)}
        for i in range(5)
    })
    page = _list(rows, store, monkeypatch)

    assert store.at_once == 5, (
        "the snapshot reads must be issued together — awaited in a loop, a "
        "page of running jobs costs one serial round trip each"
    )
    # Each row took ITS OWN snapshot, in order: the reads are gathered, so a
    # mis-zip here would silently show one job's progress on another's row.
    assert [r.processed_edges for r in page.items] == [0, 10, 20, 30, 40]
    assert [r.progress for r in page.items] == [0, 1, 2, 3, 4]


def test_a_snapshot_that_fails_costs_only_its_own_row(monkeypatch):
    rows = [_row("a", "running"), _row("b", "running")]
    store = _Store({"b": {"progress": "42"}}, fail={"a"})
    page = _list(rows, store, monkeypatch)

    assert page.items[0].progress == 0          # kept its durable value
    assert page.items[1].progress == 42


def test_terminal_rows_are_never_asked_for(monkeypatch):
    rows = [_row("done", "completed"), _row("live", "running"), _row("dead", "failed")]
    store = _Store({"live": {"progress": "7"}})
    page = _list(rows, store, monkeypatch)

    assert store.asked == ["live"]
    assert page.items[1].progress == 7


def test_the_overlay_never_fails_the_request(monkeypatch):
    class _Broken:
        async def get(self, job_id):
            raise RuntimeError("no bus")

    rows = [_row("a", "running")]
    page = _list(rows, _Broken(), monkeypatch)
    assert page.items[0].progress == 0
