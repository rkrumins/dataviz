"""The object stores for import/export artifacts: the database store (the default) and LocalFs.

Pins the behaviours the import/export pipeline relies on: streamed put/open round-trips without
buffering the whole file, stat/existence, single-object + prefix (job-dir) deletion for the cleanup
sweep, key traversal safety (a key can never escape IMPORT_STORE_ROOT), the self-describing
{ws}/{ds}/{graph}/{job}/{name} key layout, and the "backend" upload mode.

The database store is what lets several API pods share artifacts, so it is held to more: bytes
land in 1 MiB chunks whatever sizes arrive, a read can start at any offset, an overwrite is
invisible until it is whole, a failed put leaves nothing behind, and the sweep reclaims expired
objects and the chunks of puts that died. Those run on the unit-test database (SQLite).
"""
import asyncio
import contextlib
import os
import random
import shutil
import tempfile
import time
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import async_sessionmaker

from backend.app.db.models import ObjectStoreChunkORM, ObjectStoreObjectORM
from backend.app.services.storage import object_store
from backend.app.services.storage.object_store import (
    DatabaseObjectStore,
    LocalFsObjectStore,
    ObjectStat,
    get_object_store,
    storage_key,
)

MiB = 1 << 20


async def _drain(aiter):
    out = b""
    async for chunk in aiter:
        out += chunk
    return out


async def _chunks(*parts: bytes):
    for p in parts:
        yield p


async def _run() -> None:
    # storage_key encodes the ws/ds/graph/job/name layout
    assert storage_key("ws1", "ds1", "g1", "job1", "source.ndjson") == \
        "ws1/ds1/g1/job1/source.ndjson"

    root = tempfile.mkdtemp(prefix="objstore-test-")
    try:
        store = LocalFsObjectStore(root)
        key = storage_key("ws1", "ds1", "g1", "job1", "source.ndjson")

        # put_stream then open_stream round-trips the exact bytes; stat reports the size
        stat = await store.put_stream(key, _chunks(b'{"a":1}\n', b'{"b":2}\n'))
        assert stat.size == 16
        assert await _drain(store.open_stream(key)) == b'{"a":1}\n{"b":2}\n'

        # stat: existence + size, and False for a missing key
        present = await store.stat(key)
        assert present.exists is True and present.size == 16
        assert (await store.stat(storage_key("ws1", "ds1", "g1", "job1", "missing"))).exists is False

        # delete removes a single object
        await store.delete(key)
        assert (await store.stat(key)).exists is False

        # delete_prefix removes the whole job dir
        a = storage_key("ws1", "ds1", "g1", "job2", "source.ndjson")
        b = storage_key("ws1", "ds1", "g1", "job2", "rejected.ndjson")
        await store.put_stream(a, _chunks(b"a"))
        await store.put_stream(b, _chunks(b"b"))
        await store.delete_prefix("ws1/ds1/g1/job2")
        assert (await store.stat(a)).exists is False
        assert (await store.stat(b)).exists is False

        # a key that escapes the root is rejected
        with pytest.raises(ValueError):
            await store.put_stream("../escape.txt", _chunks(b"nope"))

        # upload_target reports LocalFs "backend" mode (the UI streams through the API)
        target = store.upload_target(key)
        assert target.mode == "backend" and target.key == key and target.url is None
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_object_store():
    asyncio.run(_run())


async def test_local_fs_reads_from_an_offset_and_sweeps_old_files(tmp_path):
    store = LocalFsObjectStore(tmp_path)
    data = bytes(range(256)) * 40
    await store.put_stream("ws1/job1/source.ndjson", _chunks(data))
    for start in (0, 1000, len(data), len(data) + 5):
        assert await _drain(store.open_stream("ws1/job1/source.ndjson", start=start)) == data[start:]

    await store.put_stream("ws1/job2/export.ndjson", _chunks(b"old"))
    past = time.time() - 2 * 3600
    os.utime(tmp_path / "ws1" / "job2" / "export.ndjson", (past, past))
    assert await store.sweep(older_than_hours=1) == 1
    assert (await store.stat("ws1/job2/export.ndjson")).exists is False
    assert (await store.stat("ws1/job1/source.ndjson")).exists is True


async def test_local_fs_failed_put_leaves_no_half_file(tmp_path, monkeypatch):
    """A mount's reader must never take half a file for the whole one: a put that fails, while
    writing or when closing (on a bucket mount, closing is the upload), leaves nothing."""
    store = LocalFsObjectStore(tmp_path)

    async def broken():
        yield b"x" * 1000
        raise RuntimeError("the client went away")

    with pytest.raises(RuntimeError):
        await store.put_stream("ws1/job1/source.ndjson", broken())
    assert (await store.stat("ws1/job1/source.ndjson")).exists is False

    real_open = open

    class _FailsOnClose:
        def __init__(self, f):
            self._f = f

        def write(self, data):
            return self._f.write(data)

        def close(self):
            self._f.close()
            raise OSError("the bucket refused the upload")

    monkeypatch.setattr("builtins.open", lambda *a, **k: _FailsOnClose(real_open(*a, **k)))
    with pytest.raises(OSError):
        await store.put_stream("ws1/job2/export.ndjson", _chunks(b"all of it"))
    monkeypatch.undo()
    assert (await store.stat("ws1/job2/export.ndjson")).exists is False


def test_the_database_is_the_default_store(monkeypatch, tmp_path):
    """Every API pod must see what another stored, so the shared database is the default."""
    monkeypatch.delenv("OBJECT_STORE_BACKEND", raising=False)
    assert isinstance(get_object_store(), DatabaseObjectStore)
    monkeypatch.setenv("OBJECT_STORE_BACKEND", "local")
    monkeypatch.setenv("IMPORT_STORE_ROOT", str(tmp_path))
    assert isinstance(get_object_store(), LocalFsObjectStore)
    monkeypatch.setenv("OBJECT_STORE_BACKEND", "s3")
    with pytest.raises(NotImplementedError):
        get_object_store()


async def test_the_worker_sweeps_the_store_daily(monkeypatch):
    """The versioning worker's daily pass reclaims every kind of artifact, not only uploads."""
    from backend.app.services import draft_views
    from backend.app.services.versioning import config
    from backend.app.services.versioning.worker import ProjectionWorker

    swept = []

    class _Store:
        async def sweep(self, *, older_than_hours):
            swept.append(older_than_hours)
            return 0

    class _Versioning:
        async def sweep_idle_drafts(self):
            return []

    async def _settle(_versioning):
        return {}

    monkeypatch.setattr(object_store, "get_object_store", lambda: _Store())
    monkeypatch.setattr(draft_views, "settle", _settle)
    await ProjectionWorker(None, versioning=_Versioning()).sweep_once()
    assert swept == [config.OBJECT_STORE_TTL_HOURS]


# ── DatabaseObjectStore ──────────────────────────────────────────────────────


@pytest.fixture()
def sessions(db_engine, db_session):
    """Committing sessions on the unit-test database, as ``get_async_session`` behaves in
    production. ``db_session`` creates the tables (and drops them afterwards)."""
    factory = async_sessionmaker(db_engine, expire_on_commit=False)

    @contextlib.asynccontextmanager
    async def session():
        async with factory() as s, s.begin():
            yield s

    return session


@pytest.fixture()
def db_store(sessions):
    return DatabaseObjectStore(session_factory=sessions)


async def _uneven(data: bytes):
    """``data`` in small chunks of uneven sizes, the way a request body arrives."""
    rng, i = random.Random(7), 0
    while i < len(data):
        n = rng.randint(1, 96 * 1024)
        yield data[i:i + n]
        i += n


async def _chunk_rows(sessions, blob_id=None):
    """``(blob_id, seq, bytes)`` for every stored chunk, or only ``blob_id``'s."""
    q = select(ObjectStoreChunkORM.blob_id, ObjectStoreChunkORM.seq, func.length(ObjectStoreChunkORM.data))
    if blob_id is not None:
        q = q.where(ObjectStoreChunkORM.blob_id == blob_id)
    async with sessions() as s:
        return [tuple(r) for r in (await s.execute(
            q.order_by(ObjectStoreChunkORM.blob_id, ObjectStoreChunkORM.seq))).all()]


async def _blob_of(sessions, key):
    async with sessions() as s:
        return (await s.execute(
            select(ObjectStoreObjectORM.blob_id).where(ObjectStoreObjectORM.key == key))).scalar_one_or_none()


async def test_db_store_round_trips_an_object_in_1_mib_chunks(db_store, sessions):
    data = random.Random(1).randbytes(3 * MiB + MiB // 2)
    key = storage_key("ws1", "ds1", "g1", "job1", "source.ndjson")

    stat = await db_store.put_stream(key, _uneven(data))
    assert stat == ObjectStat(key=key, size=len(data), exists=True)
    assert await db_store.stat(key) == stat
    assert await _drain(db_store.open_stream(key)) == data
    assert [n for _, _, n in await _chunk_rows(sessions)] == [MiB, MiB, MiB, MiB // 2], \
        "whatever sizes arrive, the bytes land in 1 MiB chunks"
    assert db_store.upload_target(key).mode == "backend"


async def test_db_store_reads_from_any_offset(db_store):
    data = random.Random(2).randbytes(3 * MiB + MiB // 2)
    await db_store.put_stream("ws1/job1/export.ndjson", _uneven(data))
    for start in (0, 12_345, MiB + 777, 2 * MiB, 3 * MiB, len(data) - 1, len(data), len(data) + 10, 5 * MiB):
        assert await _drain(db_store.open_stream("ws1/job1/export.ndjson", start=start)) == data[start:], start

    pieces = [len(c) async for c in db_store.open_stream("ws1/job1/export.ndjson", chunk_size=100_000, start=5)]
    assert max(pieces) <= 100_000 and sum(pieces) == len(data) - 5


async def test_db_store_overwrite_is_invisible_until_whole(db_store, sessions, monkeypatch):
    monkeypatch.setattr(object_store, "_CHUNKS_PER_TXN", 2)   # so the rewrite commits as it goes
    key = "ws1/job1/export.ndjson"
    old = random.Random(3).randbytes(2 * MiB + 10)
    await db_store.put_stream(key, _chunks(old))
    old_blob = await _blob_of(sessions, key)
    new = random.Random(4).randbytes(5 * MiB + 20)
    seen, committed = [], []

    async def rewrite():
        for i in range(0, len(new), MiB):
            yield new[i:i + MiB]
            seen.append((await _drain(db_store.open_stream(key)), (await db_store.stat(key)).size))
            committed.append(len(await _chunk_rows(sessions)) - len(await _chunk_rows(sessions, old_blob)))

    await db_store.put_stream(key, rewrite())
    assert max(committed) >= 4, "the rewrite committed chunks before it finished"
    assert all(body == old and size == len(old) for body, size in seen), \
        "until then every reader got the old object, whole"
    assert await _drain(db_store.open_stream(key)) == new
    assert await _chunk_rows(sessions, old_blob) == [], "the old chunks went with the swap"
    assert len(await _chunk_rows(sessions)) == 6


async def test_db_store_failed_put_leaves_nothing(db_store, sessions, monkeypatch):
    monkeypatch.setattr(object_store, "_CHUNKS_PER_TXN", 2)
    await db_store.put_stream("ws1/job1/upload.json", _chunks(b"old"))

    async def broken():
        for _ in range(5):
            yield b"x" * MiB
        raise RuntimeError("the client went away")

    for key in ("ws1/job1/upload.json", "ws1/job2/upload.json"):
        with pytest.raises(RuntimeError):
            await db_store.put_stream(key, broken())
    assert (await db_store.stat("ws1/job2/upload.json")).exists is False
    assert await _drain(db_store.open_stream("ws1/job1/upload.json")) == b"old", "the object it was replacing is intact"
    assert len(await _chunk_rows(sessions)) == 1, "and no chunk of either failed put is left"


async def test_db_store_missing_key(db_store):
    stream = db_store.open_stream("ws1/job1/missing")    # nothing is read until it is iterated
    with pytest.raises(FileNotFoundError):
        await stream.__anext__()
    assert await db_store.stat("ws1/job1/missing") == ObjectStat(key="ws1/job1/missing", size=0, exists=False)
    await db_store.delete("ws1/job1/missing")


async def test_db_store_delete_and_delete_prefix_match_keys_literally(db_store, sessions):
    keys = ["ws/g/job_1/source.ndjson", "ws/g/job_1/rejected.ndjson", "ws/g/jobX1/source.ndjson",
            "ws/g/job_10/source.ndjson", "ws/g/job%1/source.ndjson", "ws/g/job_1"]
    for key in keys:
        await db_store.put_stream(key, _chunks(key.encode()))

    async def left():
        return [k for k in keys if (await db_store.stat(k)).exists]

    await db_store.delete_prefix("ws/g/job_1")
    assert await left() == ["ws/g/jobX1/source.ndjson", "ws/g/job_10/source.ndjson",
                            "ws/g/job%1/source.ndjson", "ws/g/job_1"], \
        "only what is under the job's directory: '_' is not a wildcard"
    await db_store.delete_prefix("ws/g/job%1/")
    assert await left() == ["ws/g/jobX1/source.ndjson", "ws/g/job_10/source.ndjson", "ws/g/job_1"], \
        "nor is '%'"
    await db_store.delete("ws/g/jobX1/source.ndjson")
    assert await left() == ["ws/g/job_10/source.ndjson", "ws/g/job_1"]
    assert len(await _chunk_rows(sessions)) == 2, "the chunks went with their objects"


async def test_db_store_sweep_reclaims_old_objects_and_dead_puts(db_store, sessions):
    await db_store.put_stream("ws1/job1/export.ndjson", _chunks(b"o" * (MiB + 1)))
    await db_store.put_stream("ws1/job2/export.ndjson", _chunks(b"n"))
    ago = lambda **kw: (datetime.now(timezone.utc) - timedelta(**kw)).isoformat()  # noqa: E731
    async with sessions() as s:
        await s.execute(update(ObjectStoreObjectORM).where(ObjectStoreObjectORM.key == "ws1/job1/export.ndjson")
                        .values(created_at=ago(days=2)))
        s.add(ObjectStoreChunkORM(blob_id="died", seq=0, data=b"d", created_at=ago(hours=2)))
        s.add(ObjectStoreChunkORM(blob_id="running", seq=0, data=b"r", created_at=ago(minutes=5)))

    assert await db_store.sweep(older_than_hours=24) == 1
    assert (await db_store.stat("ws1/job1/export.ndjson")).exists is False
    assert await _drain(db_store.open_stream("ws1/job2/export.ndjson")) == b"n"
    assert {b for b, _, _ in await _chunk_rows(sessions)} == \
        {await _blob_of(sessions, "ws1/job2/export.ndjson"), "running"}, \
        "an hour-old orphan goes; a put still running keeps its chunks"


if __name__ == "__main__":
    asyncio.run(_run())
    print("object store (local fs): OK")
