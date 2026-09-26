"""Object store for import/export artifacts — the management database by default, pluggable.

The import/export pipeline stages large files (upload → parse → preview/rejected/export) as blobs
keyed by a self-describing ``{workspace}/{data_source}/{graph}/{job}/{name}`` path, so any artifact
is attributable to its workspace/data source/graph/job at a glance. Everything streams — a 5M-row
file is never buffered whole.

:class:`DatabaseObjectStore` keeps the blobs in the management database, in 1 MiB chunks, because
production runs several API pods with no shared volume: an upload one pod stored must be there
when the next request lands on another. :class:`LocalFsObjectStore` keeps them as files under
``IMPORT_STORE_ROOT`` instead: a directory every pod mounts (a shared volume, or an S3/GCS bucket
through its FUSE driver), which keeps multi-GB files out of the database, or one pod's own disk for
a single-pod stack. Cloud backends implement the same :class:`ObjectStore` Protocol and differ only
in ``upload_target`` (a presigned PUT instead of the backend-streamed blob endpoint) — no caller
rework.
"""
from __future__ import annotations

import asyncio
import contextlib
import os
import shutil
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import AsyncIterator, Dict, Optional, Protocol

from sqlalchemy import delete, select

from backend.app.db.engine import get_async_session
from backend.app.db.models import ObjectStoreChunkORM, ObjectStoreObjectORM

# 1 MiB read chunk — bounded memory for arbitrarily large artifacts.
_READ_CHUNK = 1 << 20
# Chunks the database store writes per transaction: a multi-GB put commits every few MiB rather
# than holding one transaction open for the whole object.
_CHUNKS_PER_TXN = 8


def storage_key(*parts: str) -> str:
    """Build a store key from path segments (``ws/ds/graph/job/name``)."""
    return "/".join(str(p).strip("/") for p in parts)


@dataclass(frozen=True)
class ObjectStat:
    key: str
    size: int
    exists: bool


@dataclass(frozen=True)
class UploadTarget:
    """Where a client uploads an artifact.

    ``mode="backend"`` (LocalFs): the UI streams the file to a backend blob endpoint, which writes
    it to the store. ``mode="presigned"`` (cloud): ``url`` is a presigned PUT the client uploads to
    directly. Same call shape either way.
    """

    key: str
    mode: str
    url: Optional[str] = None
    headers: Dict[str, str] = field(default_factory=dict)


class ObjectStore(Protocol):
    async def put_stream(self, key: str, chunks: AsyncIterator[bytes]) -> ObjectStat: ...
    def open_stream(
        self, key: str, *, chunk_size: int = _READ_CHUNK, start: int = 0
    ) -> AsyncIterator[bytes]: ...
    async def stat(self, key: str) -> ObjectStat: ...
    async def delete(self, key: str) -> None: ...
    async def delete_prefix(self, prefix: str) -> None: ...
    def upload_target(self, key: str) -> UploadTarget: ...
    async def sweep(self, *, older_than_hours: float) -> int: ...


class LocalFsObjectStore:
    """Filesystem-backed object store rooted at ``root`` (``IMPORT_STORE_ROOT``).

    A file is written front to back in one go and never appended to or renamed: all a bucket
    mounted through Mountpoint for Amazon S3 or Cloud Storage FUSE supports. Rewriting a key
    truncates and rewrites its file (Mountpoint needs ``--allow-overwrite``, and ``--allow-delete``
    for the sweep)."""

    def __init__(self, root: str | os.PathLike) -> None:
        self._root = Path(root)

    def _resolve(self, key: str) -> Path:
        """Resolve ``key`` under the root, rejecting any path that escapes it."""
        root = self._root.resolve()
        path = (self._root / key).resolve()
        if path != root and root not in path.parents:
            raise ValueError(f"key escapes store root: {key!r}")
        return path

    async def put_stream(self, key: str, chunks: AsyncIterator[bytes]) -> ObjectStat:
        path = self._resolve(key)
        await asyncio.to_thread(path.parent.mkdir, parents=True, exist_ok=True)
        size = 0
        f = await asyncio.to_thread(open, path, "wb")
        try:
            try:
                async for chunk in chunks:
                    await asyncio.to_thread(f.write, chunk)
                    size += len(chunk)
            finally:
                # On a bucket mount, closing is what uploads the file: it can fail too.
                await asyncio.to_thread(f.close)
        except BaseException:
            # Never leave half a file under the key, where a reader would take it for the whole.
            with contextlib.suppress(OSError):
                await asyncio.to_thread(path.unlink, True)
            raise
        return ObjectStat(key=key, size=size, exists=True)

    async def open_stream(
        self, key: str, *, chunk_size: int = _READ_CHUNK, start: int = 0
    ) -> AsyncIterator[bytes]:
        path = self._resolve(key)
        f = await asyncio.to_thread(open, path, "rb")
        try:
            if start:
                await asyncio.to_thread(f.seek, start)
            while True:
                chunk = await asyncio.to_thread(f.read, chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            await asyncio.to_thread(f.close)

    async def stat(self, key: str) -> ObjectStat:
        path = self._resolve(key)
        exists = await asyncio.to_thread(path.is_file)
        size = (await asyncio.to_thread(path.stat)).st_size if exists else 0
        return ObjectStat(key=key, size=size, exists=exists)

    async def delete(self, key: str) -> None:
        path = self._resolve(key)
        await asyncio.to_thread(path.unlink, True)  # missing_ok=True

    async def delete_prefix(self, prefix: str) -> None:
        path = self._resolve(prefix)
        await asyncio.to_thread(shutil.rmtree, path, True)  # ignore_errors=True

    def upload_target(self, key: str) -> UploadTarget:
        self._resolve(key)  # validate the key up front
        return UploadTarget(key=key, mode="backend", url=None)

    async def prune_older_than(self, prefix: str, seconds: float) -> int:
        """Delete each entry directly under ``prefix`` last changed more than ``seconds`` ago.
        Returns how many went. Optional: callers check for it (see view_transfer.package)."""
        root = self._resolve(prefix)

        def _prune() -> int:
            if not root.is_dir():
                return 0
            cutoff = time.time() - seconds
            gone = 0
            for entry in root.iterdir():
                if entry.stat().st_mtime < cutoff:
                    if entry.is_dir():
                        shutil.rmtree(entry, True)
                    else:
                        entry.unlink(True)
                    gone += 1
            return gone

        return await asyncio.to_thread(_prune)

    async def sweep(self, *, older_than_hours: float) -> int:
        """Delete every file under the root last written more than ``older_than_hours`` ago.
        Returns how many went."""
        def _sweep() -> int:
            cutoff = time.time() - older_than_hours * 3600
            gone = 0
            for path in self._root.rglob("*"):
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink(True)
                    gone += 1
            return gone

        return await asyncio.to_thread(_sweep)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hours_ago(hours: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


def _add_chunks(session, blob_id: str, first_seq: int, datas) -> None:
    session.add_all(ObjectStoreChunkORM(blob_id=blob_id, seq=first_seq + i, data=data)
                    for i, data in enumerate(datas))


def _upsert_object(session, **values):
    """Insert the object's row, or repoint the one already there, in the session's dialect."""
    if session.get_bind().dialect.name == "sqlite":
        from sqlalchemy.dialects.sqlite import insert
    else:
        from sqlalchemy.dialects.postgresql import insert
    stmt = insert(ObjectStoreObjectORM).values(**values)
    return stmt.on_conflict_do_update(
        index_elements=["key"],
        set_={col: getattr(stmt.excluded, col) for col in values if col != "key"},
    )


class DatabaseObjectStore:
    """Object store in the management database, shared by every API pod.

    An object is an ``object_store_objects`` row naming a blob; the blob is ``object_store_chunks``
    rows of exactly ``_READ_CHUNK`` bytes (the last may be shorter). Bytes move a chunk or a few
    at a time, each in a short transaction, so a multi-GB artifact is never held in memory or in
    one transaction. A put becomes visible only once its last chunk is in: until then a reader
    gets the previous version, whole.
    """

    def __init__(self, *, session_factory=None) -> None:
        self._session = session_factory or get_async_session

    async def put_stream(self, key: str, chunks: AsyncIterator[bytes]) -> ObjectStat:
        blob_id = uuid.uuid4().hex
        size, seq, pending, buf = 0, 0, [], bytearray()
        try:
            async for chunk in chunks:
                size += len(chunk)
                buf += chunk
                while len(buf) >= _READ_CHUNK:
                    pending.append(bytes(buf[:_READ_CHUNK]))
                    del buf[:_READ_CHUNK]
                    if len(pending) == _CHUNKS_PER_TXN:
                        async with self._session() as s:
                            _add_chunks(s, blob_id, seq, pending)
                        seq, pending = seq + len(pending), []
            if buf:
                pending.append(bytes(buf))
            async with self._session() as s:
                _add_chunks(s, blob_id, seq, pending)
                # The swap, in this one transaction: the key names the new blob, and the blob it
                # named before goes.
                previous = (await s.execute(
                    select(ObjectStoreObjectORM.blob_id)
                    .where(ObjectStoreObjectORM.key == key).with_for_update()
                )).scalar_one_or_none()
                await s.execute(_upsert_object(
                    s, key=key, blob_id=blob_id, size=size, chunk_count=seq + len(pending),
                    created_at=_now()))
                if previous is not None:
                    await s.execute(
                        delete(ObjectStoreChunkORM).where(ObjectStoreChunkORM.blob_id == previous))
        except BaseException:
            # Best effort: anything left behind is an orphan, and ``sweep`` reclaims orphans.
            with contextlib.suppress(Exception):
                async with self._session() as s:
                    await s.execute(
                        delete(ObjectStoreChunkORM).where(ObjectStoreChunkORM.blob_id == blob_id))
            raise
        return ObjectStat(key=key, size=size, exists=True)

    async def open_stream(
        self, key: str, *, chunk_size: int = _READ_CHUNK, start: int = 0
    ) -> AsyncIterator[bytes]:
        async with self._session() as s:
            row = (await s.execute(
                select(ObjectStoreObjectORM.blob_id, ObjectStoreObjectORM.chunk_count)
                .where(ObjectStoreObjectORM.key == key)
            )).first()
        if row is None:
            raise FileNotFoundError(key)
        blob_id, count = row
        offset = start % _READ_CHUNK
        for seq in range(start // _READ_CHUNK, count):
            # One chunk per session, and none held while the caller works through it.
            async with self._session() as s:
                data = (await s.execute(
                    select(ObjectStoreChunkORM.data)
                    .where(ObjectStoreChunkORM.blob_id == blob_id, ObjectStoreChunkORM.seq == seq)
                )).scalar_one_or_none()
            if data is None:
                raise FileNotFoundError(f"{key} was replaced or deleted while it was read")
            for i in range(offset, len(data), chunk_size):
                yield data[i:i + chunk_size]
            offset = 0

    async def stat(self, key: str) -> ObjectStat:
        async with self._session() as s:
            size = (await s.execute(
                select(ObjectStoreObjectORM.size).where(ObjectStoreObjectORM.key == key)
            )).scalar_one_or_none()
        return ObjectStat(key=key, size=size or 0, exists=size is not None)

    async def delete(self, key: str) -> None:
        async with self._session() as s:
            blob_id = (await s.execute(
                delete(ObjectStoreObjectORM).where(ObjectStoreObjectORM.key == key)
                .returning(ObjectStoreObjectORM.blob_id)
            )).scalar_one_or_none()
            if blob_id is not None:
                await s.execute(
                    delete(ObjectStoreChunkORM).where(ObjectStoreChunkORM.blob_id == blob_id))

    async def delete_prefix(self, prefix: str) -> None:
        """Delete every object under ``prefix/`` (a job's artifacts), as LocalFs removes that
        directory. ``%`` and ``_`` in the prefix match only themselves."""
        under = ObjectStoreObjectORM.key.startswith(prefix.rstrip("/") + "/", autoescape=True)
        async with self._session() as s:
            await s.execute(delete(ObjectStoreChunkORM).where(
                ObjectStoreChunkORM.blob_id.in_(select(ObjectStoreObjectORM.blob_id).where(under))))
            await s.execute(delete(ObjectStoreObjectORM).where(under))

    def upload_target(self, key: str) -> UploadTarget:
        return UploadTarget(key=key, mode="backend", url=None)

    async def sweep(self, *, older_than_hours: float) -> int:
        """Delete every object written more than ``older_than_hours`` ago, one per transaction so a
        backlog never becomes one enormous delete; then the chunks no object names, once they are
        an hour old (a put still in progress has such chunks too). Returns how many objects went."""
        async with self._session() as s:
            expired = (await s.execute(
                select(ObjectStoreObjectORM.key, ObjectStoreObjectORM.blob_id)
                .where(ObjectStoreObjectORM.created_at < _hours_ago(older_than_hours))
            )).all()
        removed = 0
        for key, blob_id in expired:
            async with self._session() as s:
                # Only while the key still names this blob: a rewrite since took the blob with it.
                gone = await s.execute(delete(ObjectStoreObjectORM).where(
                    ObjectStoreObjectORM.key == key, ObjectStoreObjectORM.blob_id == blob_id))
                await s.execute(
                    delete(ObjectStoreChunkORM).where(ObjectStoreChunkORM.blob_id == blob_id))
            removed += gone.rowcount
        async with self._session() as s:
            await s.execute(delete(ObjectStoreChunkORM).where(
                ObjectStoreChunkORM.created_at < _hours_ago(1),
                ObjectStoreChunkORM.blob_id.not_in(select(ObjectStoreObjectORM.blob_id))))
        return removed


def get_object_store() -> ObjectStore:
    """Return the configured object store (``OBJECT_STORE_BACKEND``): the management database by
    default, which every API pod shares; ``local`` for files under ``IMPORT_STORE_ROOT``.

    S3/GCS backends implement the same Protocol; they're wired here when added. Kept as a
    call-time factory (not a module constant) so env changes take effect without re-import."""
    from backend.app.services.versioning import config

    backend = config.object_store_backend()
    if backend == "database":
        return DatabaseObjectStore()
    if backend == "local":
        return LocalFsObjectStore(config.import_store_root())
    raise NotImplementedError(
        f"OBJECT_STORE_BACKEND={backend!r} not yet implemented (use 'database' or 'local')"
    )
