"""An input a job may still read is never swept, however old.

A view package's data is imported from its upload, in place, by as many jobs as take it; a graph
import reads its uploaded parts; a failed job is resumed, or queued again, from the same input. So
the sweeps keep the inputs of pending and running jobs, and of failed ones from the last
``STAGING_GC_DAYS``: ``uploads.jobs_input_prefixes`` names them, read just before anything is
deleted, and both object stores' sweeps and the package uploads' prune skip them. When they can't
be read, nothing is swept that pass.
"""
from __future__ import annotations

import contextlib
import os
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import update

from backend.app.db.models import ObjectStoreObjectORM
from backend.app.services.storage import object_store
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import config
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export import uploads
from backend.tests.test_object_store import db_store, sessions  # noqa: F401 — fixtures

_KEYS = ("transfer-uploads/up_live/part-00000", "transfer-uploads/up_live/upload.json",
         "transfer-uploads/up_gone/part-00000", "ws1/ds1/g1/vjob_1/export.ndjson")
_KEEP = {"transfer-uploads/up_live"}


async def _one(data=b"x"):
    yield data


async def test_the_local_store_sweep_keeps_what_a_job_still_reads(tmp_path):
    store = LocalFsObjectStore(tmp_path)
    for key in _KEYS:
        await store.put_stream(key, _one())
    past = time.time() - 3 * 86_400
    for key in _KEYS:
        os.utime(tmp_path / key, (past, past))

    assert await store.sweep(older_than_hours=24, keep_prefixes=_KEEP) == 2
    assert [k for k in _KEYS if (tmp_path / k).exists()] == list(_KEYS[:2])
    assert await store.sweep(older_than_hours=24) == 2, "unpinned, they go"


async def test_the_database_store_sweep_keeps_what_a_job_still_reads(db_store, sessions):  # noqa: F811
    for key in _KEYS:
        await db_store.put_stream(key, _one())
    async with sessions() as s:
        await s.execute(update(ObjectStoreObjectORM).values(
            created_at=(datetime.now(timezone.utc) - timedelta(days=3)).isoformat()))

    assert await db_store.sweep(older_than_hours=24, keep_prefixes=_KEEP) == 2
    assert [k for k in _KEYS if (await db_store.stat(k)).exists] == list(_KEYS[:2])
    assert await db_store.sweep(older_than_hours=24, keep_prefixes={"transfer-uploads/up_li"}) == 2, \
        "a prefix keeps what is under it, not what merely starts like it"


async def test_the_pinned_inputs_are_those_of_live_and_resumable_jobs(monkeypatch):
    seen = []

    class _Rows:
        def all(self):
            return [("transfer-uploads/up_1/upload.json", None),
                    (None, "transfer-uploads/up_2/upload.json"),
                    ("ws1/ds1/g1/vjob_3/source.ndjson", None)]

    @contextlib.asynccontextmanager
    async def session():
        class _S:
            async def execute(self, stmt):
                seen.append(stmt)
                return _Rows()
        yield _S()

    monkeypatch.setattr(ver_db, "graphver_session", session)
    assert await uploads.jobs_input_prefixes() == {
        "transfer-uploads/up_1", "transfer-uploads/up_2", "ws1/ds1/g1/vjob_3"}
    params = seen[0].compile().params
    assert {"pending", "running"} <= set(params["status_1"]) and params["status_2"] == "failed"
    cutoff = datetime.fromisoformat(params["updated_at_1"])
    assert abs((datetime.now(timezone.utc) - cutoff) - timedelta(days=config.STAGING_GC_DAYS)) < timedelta(minutes=1)


class _Versioning:
    async def sweep_idle_drafts(self):
        return []


async def _sweep(monkeypatch, pins):
    from backend.app.services import draft_views
    from backend.app.services.view_transfer import package
    from backend.app.services.versioning.import_export import import_worker
    from backend.app.services.versioning.worker import ProjectionWorker

    calls = []

    class _Store:
        async def sweep(self, *, older_than_hours, keep_prefixes=()):
            calls.append(("sweep", set(keep_prefixes)))
            return 0

    async def prune(store=None, **kwargs):
        calls.append(("prune", set(kwargs["keep_prefixes"])))
        return 0

    async def nothing(*_args, **_kwargs):
        return {}

    monkeypatch.setattr(object_store, "get_object_store", lambda: _Store())
    monkeypatch.setattr(package, "prune_uploads", prune)
    monkeypatch.setattr(uploads, "jobs_input_prefixes", pins)
    monkeypatch.setattr(import_worker, "sweep_staged_rows", nothing)
    monkeypatch.setattr(draft_views, "settle", nothing)
    await ProjectionWorker(None, versioning=_Versioning()).sweep_once()
    return calls


async def test_the_worker_sweeps_around_what_jobs_still_read(monkeypatch):
    async def pins():
        return set(_KEEP)

    assert await _sweep(monkeypatch, pins) == [("prune", _KEEP), ("sweep", _KEEP)]


async def test_nothing_is_swept_when_the_pins_cant_be_read(monkeypatch):
    async def pins():
        raise ConnectionError("graphver is down")

    assert await _sweep(monkeypatch, pins) == []
