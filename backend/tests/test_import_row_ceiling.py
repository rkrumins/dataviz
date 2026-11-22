"""One import holds at most so many rows: the platform's ``IMPORT_MAX_ROWS`` (0, no limit), or, in
the Playground, its own ``maxImportRows`` (default 200,000).

The ceiling is read where an import is made and kept on its job (``import_settings.maxRows``), as
its other limits are; a job made without one runs under the platform's. Past it, the file's read
stops before any window — the plain parse and the in-memory one alike — and the job fails
``too_many_rows``, naming the limit (``summary.failure.limit``), as any failed job reports: nothing
built on its draft, nothing published. Other workspaces keep the platform's.

The store, the lease and the version store are faked at their boundaries, as in
test_import_resume.py and test_import_job_liveness.py.
"""
from __future__ import annotations

import contextlib
import json
import shutil
import tempfile
from types import SimpleNamespace

import pytest

from backend.app.api.v1.endpoints import versioning as V
from backend.app.db.models import ProviderORM, WorkspaceDataSourceORM, WorkspaceORM
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import config
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export import import_worker
from backend.app.services.versioning.import_export import service as service_mod
from backend.app.services.versioning.import_export.import_worker import ImportWorker, TooManyRows, _Position
from backend.app.services.versioning.import_export.service import ImportExportService
from backend.app.services.versioning.job_lease import Lease


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
    epoch = 1

    def __init__(self, log):
        self._log = log

    def check(self):
        pass

    async def checkpoint(self, s, **values):
        self._log.append(("checkpoint", values))

    async def retry_transient(self, fn, *_args, **_kwargs):
        return await fn()


class _FailLease(Lease):
    """A lease whose failure is recorded instead of sent."""

    def __init__(self):
        super().__init__(job_id="vjob_1", job_type="ingest", epoch=1, workspace_id="ws_play", graph_id="g_1")
        self.failed = []

    async def fail(self, message, code="internal", action=None, phase=None, detail=None):
        self.failed.append((message, code, action, phase, detail))
        return True


def _at(worker, cursor):
    async def position(_job_id):
        worker._cursor = cursor
        return _Position(cursor, {}, 0, 0)
    worker._position = position


@contextlib.asynccontextmanager
async def _file(rows: int):
    """An ndjson file of ``rows`` nodes in a local store."""
    root = tempfile.mkdtemp(prefix="import-ceiling-")
    try:
        store = LocalFsObjectStore(root)

        async def body():
            yield "".join(json.dumps({"kind": "node", "urn": f"urn:{i}", "entityType": "T"}) + "\n"
                          for i in range(rows)).encode()
        await store.put_stream("source", body())
        yield store
    finally:
        shutil.rmtree(root, ignore_errors=True)


def _staged(log):
    return [[row["row_index"] for row in entry[2]] for entry in log if entry[0] == "sql"]


def _checkpoints(log):
    return [entry[1] for entry in log if entry[0] == "checkpoint"]


# ── The worker ──────────────────────────────────────────────────────────

async def test_a_file_past_the_platforms_ceiling_stops_while_it_is_read(monkeypatch):
    log = []
    monkeypatch.setattr(ver_db, "graphver_session", _sessions(log))
    monkeypatch.setattr(import_worker, "_PARSE_BATCH", 2)
    monkeypatch.setattr(config, "IMPORT_MAX_ROWS", 5)
    async with _file(7) as store:
        worker = ImportWorker(versioning=None, store=store)
        worker._lease = _Lease(log)
        _at(worker, None)
        with pytest.raises(TooManyRows) as stopped:
            await worker._stage("vjob_1", "source", "ndjson")
    assert stopped.value.limit == 5
    assert str(stopped.value).startswith("too_many_rows: ") and "more than 5 rows" in str(stopped.value)
    assert _staged(log) == [[0, 1], [2, 3]], "stopped at the page that went past it"
    assert "node:-1" not in [c["last_cursor"] for c in _checkpoints(log)], "never on to its windows"


@pytest.mark.parametrize("ceiling", [7, 0], ids=["at-the-ceiling", "no-ceiling"])
async def test_a_file_within_the_ceiling_or_with_none_is_read_whole(monkeypatch, ceiling):
    log = []
    monkeypatch.setattr(ver_db, "graphver_session", _sessions(log))
    async with _file(7) as store:
        worker = ImportWorker(versioning=None, store=store)
        worker._lease = _Lease(log)
        worker._max_rows = ceiling
        _at(worker, None)
        await worker._stage("vjob_1", "source", "ndjson")
    assert _staged(log) == [list(range(7))]
    assert _checkpoints(log)[-1]["last_cursor"] == "node:-1"


async def test_the_in_memory_read_stops_at_the_ceiling_too():
    async with _file(7) as store:
        worker = ImportWorker(versioning=None, store=store)
        worker._source, worker._max_rows = ("source", "ndjson"), 5
        _at(worker, "mparse:0")
        decided = []

        async def flush(job_id, snap, kind, rows, summary, processed, cursor, **values):
            decided.append(cursor)
            return summary, processed
        worker._flush_decided = flush
        with pytest.raises(TooManyRows):
            await worker._stage_pass("vjob_1", None, "node", 0)
    assert "mnode:-1" not in decided, "never on to its windows"


@pytest.mark.parametrize("kept, ceiling", [({"maxRows": 3}, 3), ({}, 1000), (None, 1000)],
                         ids=["its-jobs", "platforms", "made-before"])
async def test_a_job_runs_under_the_ceiling_it_was_made_with_else_the_platforms(monkeypatch, kept, ceiling):
    monkeypatch.setattr(config, "IMPORT_MAX_ROWS", 1000)
    worker = ImportWorker(versioning=None, store=None, facts=False)
    seen = []

    async def job(_job_id):
        return {"graph_id": "g1", "branch_id": "br1", "source_uri": "k", "import_format": "ndjson",
                "reconcile_mode": "upsert", "import_settings": kept}

    async def owner(*_args):
        return "usr_1"

    async def stage(*_args):
        seen.append(worker._max_rows)
        raise TooManyRows(worker._max_rows)
    for name, fake in (("_job", job), ("_branch_owner", owner), ("_stage", stage)):
        setattr(worker, name, fake)
    with pytest.raises(TooManyRows):
        await worker.run("vjob_1", lease=_Lease([]))
    assert seen == [ceiling]


async def test_a_job_past_its_ceiling_fails_too_many_rows_naming_it_and_publishes_nothing(monkeypatch):
    job = SimpleNamespace(workspace_id="ws_play", data_source_id="ds_1", scope_view_id=None,
                          reconcile_mode="upsert", branch_id="br_1", graph_id="g_1", auto_publish=True,
                          import_settings={"maxRows": 200_000})
    monkeypatch.setattr(ver_db, "graphver_session", _sessions([], job))

    class _Worker:
        def __init__(self, *_args, **_kwargs):
            pass

        async def run(self, job_id, lease=None):
            raise TooManyRows(200_000)
    monkeypatch.setattr(service_mod, "ImportWorker", _Worker)
    svc = ImportExportService(versioning=object(), store=object())
    published = []

    async def auto_publish(*args, **kwargs):
        published.append(args)
    svc._auto_publish = auto_publish
    lease = _FailLease()

    await svc.run_import_safe("vjob_1", lease)
    [(message, code, action, phase, detail)] = lease.failed
    assert message.startswith("too_many_rows: ") and "200,000" in message
    assert (code, action, phase, detail) == ("too_many_rows", None, "parse", {"limit": 200_000})
    assert published == []


async def test_a_failure_keeps_its_detail_beside_its_code():
    log = []
    lease = Lease(job_id="vjob_1", job_type="ingest", epoch=1, workspace_id="ws_play", graph_id="g_1",
                  session_factory=_sessions(log))
    assert await lease.fail("too_many_rows: …", "too_many_rows", phase="parse", detail={"limit": 5})
    [(_kind, _stmt, params)] = log
    assert json.loads(params["failure"]) == {"limit": 5, "code": "too_many_rows", "action": None,
                                             "reason": "too_many_rows: …"}
    assert params["phase"] == "parse"


def test_too_many_rows_is_never_waited_out():
    from backend.app.services.versioning.job_lease import is_transient

    assert not is_transient(TooManyRows(200_000))


# ── Where an import is made ─────────────────────────────────────────────

@pytest.fixture
async def estate(db_session):
    db_session.add_all([
        ProviderORM(id="prov_1", name="Graphs", provider_type="falkordb"),
        WorkspaceORM(id="ws_play", name="Playground", kind="playground",
                     playground_settings=json.dumps({"sandboxProviderId": "prov_1"})),
        WorkspaceORM(id="ws_team", name="Team"),
    ])
    await db_session.flush()
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_play", workspace_id="ws_play", provider_id="prov_1", graph_name="a"),
        WorkspaceDataSourceORM(id="ds_team", workspace_id="ws_team", provider_id="prov_1", graph_name="b"),
    ])
    await db_session.commit()


@pytest.mark.asyncio
async def test_in_the_playground_an_import_keeps_its_ceiling_and_elsewhere_the_platforms(
        db_session, estate, monkeypatch):
    monkeypatch.setattr(config, "IMPORT_MAX_ROWS", 0)
    assert (await V._import_settings_for(db_session, "ds_play", None))[1]["maxRows"] == 200_000
    assert (await V._import_settings_for(db_session, "ds_team", None))[1]["maxRows"] == 0
    assert (await V._import_settings_for(db_session, None, None))[1]["maxRows"] == 0

    (await db_session.get(WorkspaceORM, "ws_play")).playground_settings = json.dumps(
        {"sandboxProviderId": "prov_1", "maxImportRows": 5000})
    monkeypatch.setattr(config, "IMPORT_MAX_ROWS", 1_000_000)
    await db_session.flush()
    assert (await V._import_settings_for(db_session, "ds_play", None))[1]["maxRows"] == 5000
    assert (await V._import_settings_for(db_session, "ds_team", None))[1]["maxRows"] == 1_000_000
