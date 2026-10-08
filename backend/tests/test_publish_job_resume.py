"""A publish job is safe to run again: a draft its earlier attempt merged is never published twice.

A publish job's squash commits in one transaction, but the job is finished in another: a worker
that dies (or is taken over) between the two leaves a merged draft and a job still to finish. The
next attempt finds the draft merged and publishes nothing — it re-runs only what a publish sets
off (the read caches bumped, the views' "data updated" stamped, the draft's layout overlay
promoted, the projection lane nudged) and completes with the commit the draft landed as. So too
when a superseded attempt's squash lands under this one and its publish is refused for it. The
job ends through its lease's fenced finish; a job no longer this worker's stops quietly. The
versioning service, the job row and the lease are faked here; the same runs on Postgres in
integration/test_versioning_publish_job.py.
"""
from __future__ import annotations

import contextlib
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import versioning as ep
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import Superseded
from backend.app.services.versioning.service import NotUpToDate


class _Versioning:
    """``merged`` answers each look at the draft in turn (None: not merged); ``publish`` is what the
    publish does: return its commit, or raise."""

    def __init__(self, merged, publish=None):
        self._merged, self._publish = list(merged), publish
        self.published = []

    async def merged_commit_id(self, *, graph_id, branch_id):
        assert (graph_id, branch_id) == ("g1", "br1")
        return self._merged.pop(0)

    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1"}

    async def publish(self, **kwargs):
        self.published.append(kwargs)
        if isinstance(self._publish, Exception):
            raise self._publish
        return self._publish


class _Lease:
    epoch = 2

    def __init__(self, finishes=True):
        self._finishes = finishes
        self.finished = None
        self.released = self.failed = False

    async def finish(self, status="completed", **values):
        self.finished = (status, values)
        return self._finishes

    async def release(self):
        self.released = True

    async def fail(self, *_args, **_kwargs):
        self.failed = True


@pytest.fixture
def set_off(monkeypatch):
    """What a publish sets off, recorded; the job row and the management DB faked."""
    calls = []

    def recorder(name):
        async def record(*args):
            calls.append((name, *args))
        return record

    for name in ("_bump_main_cache", "_touch_views_data_updated", "_promote_view_layout_overlay",
                 "nudge_projection"):
        monkeypatch.setattr(ep, name, recorder(name))

    async def project_here(_graph_id):
        raise AssertionError("a job leaves the projection to the projection lane")
    monkeypatch.setattr(ep, "project_now", project_here)

    async def nothing(*_args):
        return None
    monkeypatch.setattr(ep, "_live_containment_types", nothing)
    monkeypatch.setattr(ep, "_rules_for_meta", nothing)

    @contextlib.asynccontextmanager
    async def management_session():
        yield None
    monkeypatch.setattr("backend.app.db.engine.get_async_session", management_session)

    row = SimpleNamespace(field_scope={"actor": "usr_1", "message": "ship it"}, graph_id="g1",
                          branch_id="br1", workspace_id="ws1", data_source_id="ds1")

    class _Session:
        async def get(self, _orm, _key):
            return row

    @contextlib.asynccontextmanager
    async def job_session():
        yield _Session()
    monkeypatch.setattr(ver_db, "graphver_session", job_session)
    return calls


def _service(monkeypatch, svc):
    monkeypatch.setattr(ep, "get_versioning_service", lambda: svc)
    return ImportExportService(versioning=svc, store=object(), publish_hook=ep._publish_from_job)


_SET_OFF = [("_bump_main_cache", "g1"), ("_touch_views_data_updated", "g1", "usr_1"),
            ("_promote_view_layout_overlay", "br1", "usr_1"), ("nudge_projection", "g1")]


async def test_a_publish_job_publishes_and_sets_off_what_a_publish_does(monkeypatch, set_off):
    svc = _Versioning(merged=[None], publish="cmt_new")
    lease = _Lease()
    assert await _service(monkeypatch, svc).run_publish("vjob_1", lease) == {"commitId": "cmt_new"}
    assert len(svc.published) == 1 and set_off == _SET_OFF
    assert lease.finished == ("completed", {"summary": {"commitId": "cmt_new"}})


async def test_a_job_whose_draft_already_merged_publishes_nothing_and_sets_off_the_rest(
        monkeypatch, set_off):
    """The worker died after its squash committed: the next attempt completes with that commit,
    the overlay promoted and the caches bumped, and nothing is published twice."""
    svc = _Versioning(merged=["cmt_landed"], publish=AssertionError("published twice"))
    lease = _Lease()
    assert await _service(monkeypatch, svc).run_publish("vjob_1", lease) == {"commitId": "cmt_landed"}
    assert svc.published == [] and set_off == _SET_OFF
    assert lease.finished == ("completed", {"summary": {"commitId": "cmt_landed"}})


async def test_a_publish_refused_because_a_zombie_merged_the_draft_completes(monkeypatch, set_off):
    """Not merged when this attempt looked; merged by a superseded attempt's squash before this
    one's publish ran, which is refused for it (the draft is no longer open)."""
    svc = _Versioning(merged=[None, "cmt_zombie"], publish=ValueError("branch br1 is merged"))
    lease = _Lease()
    assert await _service(monkeypatch, svc).run_publish("vjob_1", lease) == {"commitId": "cmt_zombie"}
    assert len(svc.published) == 1 and set_off == _SET_OFF, "set off once, after the merge is found"
    assert lease.finished == ("completed", {"summary": {"commitId": "cmt_zombie"}})


async def test_a_refused_publish_fails_the_job_with_the_routes_answer(monkeypatch, set_off):
    svc = _Versioning(merged=[None, None], publish=NotUpToDate("br1", 3, 5))
    lease = _Lease()
    result = await _service(monkeypatch, svc).run_publish("vjob_1", lease)
    assert result["error"]["status"] == 409 and result["error"]["detail"]["type"] == "not_up_to_date"
    status, values = lease.finished
    assert (status, values["summary"]) == ("failed", result) and values["error_message"]
    assert set_off == [], "nothing landed: nothing to set off"


async def test_a_publish_job_no_longer_this_workers_stops_quietly(monkeypatch, set_off):
    svc = _Versioning(merged=["cmt_landed"])
    lease = _Lease(finishes=False)
    ie = _service(monkeypatch, svc)
    with pytest.raises(Superseded):
        await ie.run_publish("vjob_1", lease)
    svc = _Versioning(merged=["cmt_landed"])
    ie = _service(monkeypatch, svc)
    await ie.run_publish_safe("vjob_1", lease)
    assert not (lease.failed or lease.released), "the job's new owner finishes it"
