"""Cancelling an export: whose it is to cancel, what a cancel changes, and that its worker stops.

Pins: an export records who started it. Its creator cancels it, and so does a manager; anyone else
is refused, and so is everyone but a manager for an export with no creator on record, the job left
running. One that already ended is left as it ended, and a cancel names who made it, keeping the
rest of the summary. The worker running a cancelled export stops at its next progress checkpoint —
while a spreadsheet still reads every record for its columns, not only once the file's bytes flow
— with its records closed and the part of the file it wrote gone. One cancelled just as its file
was finished removes that file, and never finishes the job.
"""
from __future__ import annotations

import contextlib
from types import SimpleNamespace

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db
from backend.app.services.versioning.import_export import export_worker, snapshot, stream
from backend.app.services.versioning.import_export.export_worker import ExportWorker
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import Superseded
from backend.app.services.versioning.service import AccessDenied, Viewer


class _Session:
    """One graphver session: hands out the job's row, and keeps what is added to it."""

    def __init__(self, row=None, added=None):
        self._row, self._added = row, added
        self.locked = False

    async def get(self, _orm, _key, with_for_update=False):
        self.locked = self.locked or with_for_update
        return self._row

    def add(self, row):
        self._added.append(row)

    async def flush(self):
        self._added[-1].id = "vjob_1"


def _sessions(row=None, added=None, opened=None):
    @contextlib.asynccontextmanager
    async def session():
        s = _Session(row, added)
        if opened is not None:
            opened.append(s)
        yield s
    return session


def _service() -> ImportExportService:
    return ImportExportService(versioning=object(), store=object())


async def test_an_export_records_who_started_it(monkeypatch):
    added = []
    monkeypatch.setattr(db, "graphver_session", _sessions(added=added))
    await _service().create_export_job(workspace_id="ws1", data_source_id="ds1", graph_id="g1",
                                       actor="usr_a", export_format="csv", extra_props=["Owner"])
    assert added[0].field_scope == {"actor": "usr_a", "props": ["Owner"]}


def _job(**values):
    row = SimpleNamespace(job_type="export", status="running", field_scope={"actor": "usr_a"},
                          summary={"nodes": 10, "takeovers": 1}, completed_at=None, updated_at=None)
    for key, value in values.items():
        setattr(row, key, value)
    return row


async def test_its_creator_or_a_manager_cancels_it_and_no_one_else(monkeypatch):
    for viewer, status in ((Viewer(actor="usr_a"), "running"),
                           (Viewer(actor="usr_m", can_manage=True), "pending")):
        row, opened = _job(status=status), []
        monkeypatch.setattr(db, "graphver_session", _sessions(row, opened=opened))
        assert await _service().cancel_export("j1", viewer=viewer) is True
        assert (row.status, row.summary) == ("cancelled", {"nodes": 10, "takeovers": 1, "cancelledBy": viewer.actor})
        assert row.completed_at and row.completed_at == row.updated_at
        assert opened[0].locked, "read FOR UPDATE: the cancel and a claim or a finish take turns"

    for row in (_job(), _job(field_scope={"package": {"fileName": "v.zip"}})):    # another's; none on record
        monkeypatch.setattr(db, "graphver_session", _sessions(row))
        with pytest.raises(AccessDenied, match="Only the person who started this export"):
            await _service().cancel_export("j1", viewer=Viewer(actor="usr_b"))
        assert row.status == "running" and "cancelledBy" not in row.summary


async def test_an_export_that_already_ended_is_left_as_it_ended(monkeypatch):
    for status in ("completed", "failed", "cancelled"):
        row = _job(status=status, completed_at="2026-10-12T10:00:00+00:00")
        monkeypatch.setattr(db, "graphver_session", _sessions(row))
        assert await _service().cancel_export("j1", viewer=Viewer(actor="usr_a")) is False
        assert (row.status, row.completed_at, row.summary) == (
            status, "2026-10-12T10:00:00+00:00", {"nodes": 10, "takeovers": 1})

    for row in (None, _job(job_type="ingest")):                     # no such job; an import isn't one
        monkeypatch.setattr(db, "graphver_session", _sessions(row))
        with pytest.raises(ValueError, match="export not found"):
            await _service().cancel_export("j1", viewer=Viewer(actor="usr_a", can_manage=True))


# ── The worker ───────────────────────────────────────────────────────────────


class _Lease:
    """The job's lease, its row cancelled at checkpoint ``cancelled_at``: that write and every one
    after it find the row no longer running at this epoch, as ``Lease.checkpoint`` does."""

    epoch = 1

    def __init__(self, *, cancelled_at=None, finishes=True):
        self._cancelled_at, self._finishes = cancelled_at, finishes
        self.checkpoints, self.finished = [], None

    def check(self):
        pass

    async def checkpoint(self, s, **values):
        if self._cancelled_at is not None and len(self.checkpoints) + 1 >= self._cancelled_at:
            raise Superseded("cancelled")
        self.checkpoints.append(values)

    async def finish(self, status="completed", **values):
        self.finished = (status, values)
        return self._finishes


def _records(log, pages=4):
    """``stream.record_pages`` over ``pages`` pages of three nodes, logging each page it gives and
    when it is closed."""
    async def record_pages(snap, sel, tally=None, stats=None):
        tally.update(node=0, edge=0, passes=tally.get("passes", 0) + 1)
        try:
            for p in range(pages):
                page = [{"kind": "node", "entity_id": f"e{p}{i}", "urn": f"urn:n{p}{i}", "entityType": "Table",
                         "displayName": f"T{p}{i}"} for i in range(3)]
                tally["node"] += len(page)
                log.append(("page", tally["passes"], p))
                yield page
        finally:
            log.append(("closed", tally["passes"]))
    return record_pages


KEY = "ws1/ds1/g1/j1/export.csv"


@pytest.fixture
def export(tmp_path, monkeypatch):
    """Run ``j1``, a CSV export, on ``lease``: a checkpoint at every page and every chunk."""
    async def snapshot_of(**_kw):
        return object()

    row = SimpleNamespace(graph_id="g1", import_format="csv", as_of_seq=None, branch_id=None,
                          result_uri=KEY, summary={"takeovers": 1})
    monkeypatch.setattr(db, "graphver_session", _sessions(row))
    monkeypatch.setattr(snapshot, "open_snapshot", snapshot_of)
    monkeypatch.setattr(export_worker, "_PROGRESS_SECS", 0)
    store = LocalFsObjectStore(tmp_path)

    async def run(lease, log):
        monkeypatch.setattr(stream, "record_pages", _records(log))
        return await ExportWorker(None, store).run("j1", lease=lease)
    run.store = store
    return run


async def test_a_cancelled_export_stops_while_it_still_reads_for_its_columns(export):
    log, lease = [], _Lease(cancelled_at=3)
    with pytest.raises(Superseded):
        await export(lease, log)
    # Cancelled as the second page of the column pass came: no further page read, no second pass.
    assert log == [("page", 1, 0), ("page", 1, 1), ("closed", 1)]
    assert [c["summary"]["passes"] for c in lease.checkpoints] == [0, 1], lease.checkpoints
    assert lease.finished is None
    assert not (await export.store.stat(KEY)).exists, "the part written (the BOM) is gone"


async def test_one_cancelled_as_its_file_was_finished_removes_the_file(export):
    log, lease = [], _Lease(finishes=False)
    with pytest.raises(Superseded):
        await export(lease, log)
    assert lease.finished[0] == "completed" and ("page", 2, 3) in log, "it wrote the whole file"
    assert not (await export.store.stat(KEY)).exists

    lease = _Lease()
    summary = await export(lease, [])
    assert summary == {"nodes": 12, "edges": 0, "bytes": (await export.store.stat(KEY)).size}
    assert lease.checkpoints[-1]["summary"]["takeovers"] == 1, "progress merges into the summary"
