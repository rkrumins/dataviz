"""An import job resumes from its cursor, and records its work only as a fenced checkpoint.

The import worker runs on its job's lease (``job_lease``). Each unit of work — a batch of parsed
rows staged, a window of rows resolved and built onto the draft — commits in ONE transaction with
the job's checkpoint: the cursor (``parse:<n>`` | ``node:<row>`` | ``edge:<row>`` | ``replace``),
how far it has got (``processed``/``total``/``progress``) and its running tallies. So a job taken
over or handed back resumes exactly where the last unit landed, and a superseded worker's unit
rolls back at its checkpoint. Proven here with the store, the lease and the versioning service
faked at their boundaries; integration/test_import_windows.py runs the same on Postgres, crashing
an import at every kind of unit and resuming it.

Also here: a failed job a person retries is queued again — only a failed one — and an export's
every attempt writes a file of its own, and its progress keeps the job's takeover count.
"""
from __future__ import annotations

import contextlib
import json
import shutil
import tempfile
from types import SimpleNamespace

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export import (
    export_worker,
    import_worker,
    snapshot,
    stream,
)
from backend.app.services.versioning.import_export.export_worker import ExportWorker, epoch_key
from backend.app.services.versioning.import_export.import_worker import (
    ImportWorker,
    _Position,
    _window_after,
)
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import QUEUED, Superseded

_NO_TALLIES = {"new": 0, "updated": 0, "unchanged": 0, "deleted": 0, "invalid": 0}


class _Session:
    def __init__(self, log, row=None):
        self._log, self._row = log, row

    async def execute(self, stmt, params=None):
        self._log.append(("sql", stmt, params))
        return SimpleNamespace(rowcount=1)

    async def get(self, _orm, _key, **_kw):
        return self._row


def _sessions(log, row=None):
    @contextlib.asynccontextmanager
    async def session():
        yield _Session(log, row)
    return session


class _Lease:
    """The job's lease: records its checkpoints in the session's log, in order."""

    epoch = 1

    def __init__(self, log, *, superseded=False, finishes=True):
        self._log, self._superseded, self._finishes = log, superseded, finishes
        self.finished = None

    def check(self):
        pass

    async def checkpoint(self, s, **values):
        if self._superseded:
            raise Superseded("taken over")
        self._log.append(("checkpoint", values))

    async def retry_transient(self, fn, *_args, **_kwargs):
        return await fn()

    async def finish(self, status="completed", **values):
        self.finished = (status, values)
        return self._finishes


def _at(worker, cursor, summary=None, processed=0, total=0):
    """The job's row says it got to ``cursor``."""
    async def position(_job_id):
        worker._cursor = cursor
        return _Position(cursor, dict(summary or {}), processed, total)
    worker._position = position


def _checkpoints(log):
    return [entry[1] for entry in log if entry[0] == "checkpoint"]


def test_the_cursor_says_where_the_next_window_starts():
    assert _window_after("node:-1") == ("node", -1)
    assert _window_after("node:41") == ("node", 41)
    assert _window_after("edge:7") == ("edge", 7)
    assert _window_after("replace") == (None, -1)          # every window done


async def test_a_resumed_parse_stages_only_the_rows_past_its_cursor(monkeypatch):
    """Staged before: rows 0-2 (``parse:3``). The file is read again from the start; rows 3-6 are
    staged, each batch with the cursor past it in the same transaction, compare-and-set on the
    cursor before it — then the job moves on to its first window, with how many rows it has."""
    log = []
    monkeypatch.setattr(ver_db, "graphver_session", _sessions(log))
    monkeypatch.setattr(import_worker, "_PARSE_BATCH", 2)
    root = tempfile.mkdtemp(prefix="import-resume-")
    try:
        store = LocalFsObjectStore(root)

        async def body():
            yield "".join(json.dumps({"kind": "node", "urn": f"urn:{i}", "entityType": "T"}) + "\n"
                          for i in range(7)).encode()
        await store.put_stream("source", body())
        worker = ImportWorker(versioning=None, store=store)
        worker._lease = _Lease(log)
        _at(worker, "parse:3")
        await worker._stage("vjob_1", "source", "ndjson")
    finally:
        shutil.rmtree(root, ignore_errors=True)

    staged = [[row["row_index"] for row in entry[2]] for entry in log if entry[0] == "sql"]
    assert staged == [[3, 4, 5], [6]], "rows below the cursor are never staged again"
    assert [entry[0] for entry in log] == ["sql", "checkpoint", "sql", "checkpoint", "checkpoint"], \
        "each batch commits with its checkpoint"
    assert _checkpoints(log) == [
        {"expect_cursor": "parse:3", "last_cursor": "parse:6", "total": 6, "current_phase": "parse"},
        {"expect_cursor": "parse:6", "last_cursor": "parse:7", "total": 7, "current_phase": "parse"},
        {"expect_cursor": "parse:7", "last_cursor": "node:-1", "total": 7, "current_phase": "nodes"},
    ]


async def test_a_job_past_its_parse_is_not_parsed_again():
    worker = ImportWorker(versioning=None, store=None)
    _at(worker, "edge:12")

    async def parse(*_args):
        raise AssertionError("parsed again")
    worker._parse = parse
    await worker._stage("vjob_1", "source", "ndjson")


class _Versioning:
    """apply_ops ends its transaction with the caller's hook, as the real one does."""

    def __init__(self, log):
        self._log, self.applied = log, []

    async def apply_ops(self, *, on_commit=None, **kwargs):
        self.applied.append(kwargs)
        self._log.append(("ops", [op["entity_id"] for op in kwargs["ops"]]))
        await on_commit(_Session(self._log))


def _windowed(worker, rows_by_start):
    async def window(_job_id, kind, after):
        return [dict(row) for row in rows_by_start.get((kind, after), [])]

    async def lookups(_snap, _rows):
        return {}
    worker._window, worker._node_lookups, worker._edge_lookups = window, lookups, lookups


async def test_a_window_lands_its_ops_resolutions_and_checkpoint_in_one_transaction(monkeypatch):
    log = []
    monkeypatch.setattr(ver_db, "graphver_session", _sessions(log))
    svc = _Versioning(log)
    worker = ImportWorker(svc, store=None)
    worker._lease = _Lease(log)
    _at(worker, "node:-1", {"takeovers": 1}, processed=0, total=4)
    _windowed(worker, {("node", -1): [
        {"kind": "node", "urn": "urn:a", "entityType": "T", "_row_index": 0},
        {"kind": "node", "urn": "urn:b", "_row_index": 2}]})          # no type: quarantined

    assert await worker._next_window("vjob_1", None, "g1", "br1", "usr_1") is True
    [applied] = svc.applied
    assert (applied["graph_id"], applied["branch_id"], applied["message"]) == ("g1", "br1", "import")
    assert [entry[0] for entry in log] == ["ops", "sql", "checkpoint"], \
        "the resolutions, then the checkpoint, inside the ops' transaction"
    _kind, stmt, params = log[1]
    assert stmt is import_worker._RESOLVE_ROWS and params["idx"] == [0, 2]
    assert params["statuses"] == ["new", "invalid"]
    assert _checkpoints(log) == [{
        "expect_cursor": "node:-1", "last_cursor": "node:2", "processed": 2, "progress": 50,
        "current_phase": "nodes", "summary": {**_NO_TALLIES, "takeovers": 1, "new": 1, "invalid": 1}}]


async def test_a_window_with_nothing_to_apply_still_commits_its_checkpoint(monkeypatch):
    log = []
    monkeypatch.setattr(ver_db, "graphver_session", _sessions(log))
    svc = _Versioning(log)
    worker = ImportWorker(svc, store=None)
    worker._lease = _Lease(log)
    _at(worker, "edge:3", {**_NO_TALLIES, "new": 5}, processed=8, total=10)
    _windowed(worker, {("edge", 3): [{"kind": "edge", "edgeType": "E", "sourceUrn": "urn:x",
                                      "targetUrn": "urn:y", "_row_index": 9}]})

    assert await worker._next_window("vjob_1", None, "g1", "br1", "usr_1") is True
    assert svc.applied == [], "no ops: no commit onto the draft"
    assert [entry[0] for entry in log] == ["sql", "checkpoint"]
    assert _checkpoints(log)[0]["last_cursor"] == "edge:9"
    assert _checkpoints(log)[0]["summary"] == {**_NO_TALLIES, "new": 5, "invalid": 1}
    assert (_checkpoints(log)[0]["processed"], _checkpoints(log)[0]["progress"]) == (9, 90)


async def test_the_windows_run_nodes_then_edges_then_stop():
    worker = ImportWorker(versioning=None, store=None)
    asked = []

    async def window(_job_id, kind, after):
        asked.append((kind, after))
        return []
    worker._window = window
    _at(worker, "node:12")
    assert await worker._next_window("vjob_1", None, "g1", "br1", "u") is False
    assert asked == [("node", 12), ("edge", -1)], "past the last node row: the edges, from the first"
    asked.clear()
    _at(worker, "replace")
    assert await worker._next_window("vjob_1", None, "g1", "br1", "u") is False
    assert asked == [], "every window done"


async def test_a_superseded_window_raises_rather_than_carry_on(monkeypatch):
    """The checkpoint finds the job is no longer this worker's: the window's transaction rolls
    back (the exception leaves apply_ops), and the worker stops — it is not a failure to record."""
    log = []
    monkeypatch.setattr(ver_db, "graphver_session", _sessions(log))
    worker = ImportWorker(_Versioning(log), store=None)
    worker._lease = _Lease(log, superseded=True)
    _at(worker, "node:-1", total=1)
    _windowed(worker, {("node", -1): [{"kind": "node", "urn": "urn:a", "entityType": "T",
                                       "_row_index": 0}]})
    with pytest.raises(Superseded):
        await worker._next_window("vjob_1", None, "g1", "br1", "usr_1")
    assert _checkpoints(log) == []


def _finishing_worker(log, *, facts, finishes=True):
    worker = ImportWorker(versioning=None, store=None, facts=facts)
    lease = _Lease(log, finishes=finishes)

    async def job(_job_id):
        return {"graph_id": "g1", "branch_id": "br1", "source_uri": "k", "import_format": "ndjson",
                "reconcile_mode": "upsert"}

    async def owner(*_args):
        return "usr_1"

    async def stage(*_args):
        log.append(("stage",))

    async def build(*_args):
        log.append(("build",))
        return {**_NO_TALLIES, "new": 3}

    async def derive(*_args):
        log.append(("facts",))

    for name, fake in (("_job", job), ("_branch_owner", owner), ("_stage", stage),
                       ("_resolve_and_build", build), ("_derive_facts", derive)):
        setattr(worker, name, fake)
    return worker, lease


async def test_an_import_finishes_through_its_fenced_finish():
    log = []
    worker, lease = _finishing_worker(log, facts=True)
    assert await worker.run("vjob_1", lease=lease) == {**_NO_TALLIES, "new": 3}
    assert log == [("stage",), ("build",), ("facts",)], "the layout facts come from the whole import"
    assert lease.finished == ("completed", {"summary": {**_NO_TALLIES, "new": 3}, "progress": 100})

    log.clear()
    worker, lease = _finishing_worker(log, facts=False)
    await worker.run("vjob_1", lease=lease)
    assert ("facts",) not in log, "no view to write them to: no facts"


async def test_an_import_taken_over_at_its_finish_stops_there():
    worker, lease = _finishing_worker([], facts=True, finishes=False)
    with pytest.raises(Superseded):
        await worker.run("vjob_1", lease=lease)


@pytest.mark.parametrize("status, cursor, queued, cleared", [
    ("failed", "edge:41", True, False),          # resumes from its cursor
    ("failed", None, True, True),                # staged before leases: starts over, rows dropped
    ("running", "edge:41", False, False),        # its worker's: never queued twice
    ("pending", None, False, False),
    ("completed", "edge:41", False, False),
])
async def test_only_a_failed_job_is_queued_again(monkeypatch, status, cursor, queued, cleared):
    log = []
    row = SimpleNamespace(status=status, last_cursor=cursor, current_phase=None,
                          error_message="it broke", completed_at="t", updated_at="t",
                          summary={**_NO_TALLIES, "new": 9, "takeovers": 4,
                                   "failure": {"code": "infrastructure", "action": "resume"}})
    monkeypatch.setattr(ver_db, "graphver_session", _sessions(log, row))
    svc = ImportExportService(versioning=object(), store=object())

    assert await svc.requeue_failed("vjob_1") is queued
    deletes = [entry[1] for entry in log if getattr(entry[1], "is_delete", False)]
    assert bool(deletes) is cleared
    if queued:
        assert (row.status, row.current_phase, row.error_message, row.completed_at) == \
            ("pending", QUEUED, None, None)
        assert row.summary == {**_NO_TALLIES, "new": 9}, "its takeovers start over, its failure goes"
        assert row.last_cursor == cursor, "kept: the next claim resumes from it"
    else:
        assert row.status == status


def test_every_export_attempt_writes_a_file_of_its_own():
    key = "ws1/ds1/g1/vjob_1/export.ndjson"
    assert epoch_key(key, 1) == key, "the first attempt: the key the job was created with"
    assert epoch_key(key, 2) == "ws1/ds1/g1/vjob_1/export-e2.ndjson"
    assert epoch_key("ws1/ds1/g1/vjob_1/export.csv", 7) == "ws1/ds1/g1/vjob_1/export-e7.csv"


async def test_an_export_saying_how_far_it_has_got_keeps_its_takeover_count(monkeypatch):
    """A running export's progress merges into the row's summary: its ``takeovers`` is how a claim
    tells a job that keeps killing its worker, so an export that cleared it with every tick would be
    taken over forever instead of failing as poison."""
    log = []
    row = SimpleNamespace(graph_id="g1", import_format="ndjson", as_of_seq=None, branch_id=None,
                          result_uri="ws1/ds1/g1/vjob_1/export.ndjson", summary={"takeovers": 2})
    monkeypatch.setattr(ver_db, "graphver_session", _sessions(log, row))
    monkeypatch.setattr(export_worker, "_PROGRESS_SECS", 0)          # a tick with every chunk

    async def no_snapshot(**_kwargs):
        return None

    async def body():
        yield b"{}\n"
        yield b"{}\n"

    monkeypatch.setattr(snapshot, "open_snapshot", no_snapshot)
    monkeypatch.setattr(stream, "in_turn", lambda chunks: chunks)
    monkeypatch.setattr(stream, "write_export", lambda _pages, **_kwargs: body())

    class _Store:
        async def put_stream(self, _key, chunks):
            return SimpleNamespace(size=sum([len(c) async for c in chunks]))

    await ExportWorker(versioning=None, store=_Store()).run("vjob_1", lease=_Lease(log))
    ticks = _checkpoints(log)
    assert [t["summary"]["bytes"] for t in ticks] == [3, 6]
    assert all(t["summary"]["takeovers"] == 2 for t in ticks), ticks
