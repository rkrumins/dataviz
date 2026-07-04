"""Object store for import/export artifacts — LocalFS in v1, pluggable for S3/GCS later.

The import/export pipeline stages large files (upload → parse → preview/rejected/export) as blobs
keyed by a self-describing ``{workspace}/{data_source}/{graph}/{job}/{name}`` path, so any artifact
is attributable to its workspace/data source/graph/job at a glance. Everything streams — a 5M-row
file is never buffered whole.

v1 ships :class:`LocalFsObjectStore` (a mounted volume rooted at ``IMPORT_STORE_ROOT``). Cloud
backends implement the same :class:`ObjectStore` Protocol and differ only in ``upload_target``
(a presigned PUT instead of the backend-streamed blob endpoint) — no caller rework.
"""
from __future__ import annotations

import asyncio
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import AsyncIterator, Dict, Optional, Protocol

# 1 MiB read chunk — bounded memory for arbitrarily large artifacts.
_READ_CHUNK = 1 << 20


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
    def open_stream(self, key: str, *, chunk_size: int = _READ_CHUNK) -> AsyncIterator[bytes]: ...
    async def stat(self, key: str) -> ObjectStat: ...
    async def delete(self, key: str) -> None: ...
    async def delete_prefix(self, prefix: str) -> None: ...
    def upload_target(self, key: str) -> UploadTarget: ...


class LocalFsObjectStore:
    """Filesystem-backed object store rooted at ``root`` (``IMPORT_STORE_ROOT``)."""

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
            async for chunk in chunks:
                await asyncio.to_thread(f.write, chunk)
                size += len(chunk)
        finally:
            await asyncio.to_thread(f.close)
        return ObjectStat(key=key, size=size, exists=True)

    async def open_stream(
        self, key: str, *, chunk_size: int = _READ_CHUNK
    ) -> AsyncIterator[bytes]:
        path = self._resolve(key)
        f = await asyncio.to_thread(open, path, "rb")
        try:
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


def get_object_store() -> ObjectStore:
    """Return the configured object store (``OBJECT_STORE_BACKEND``): local in v1.

    S3/GCS backends implement the same Protocol; they're wired here when added. Kept as a
    call-time factory (not a module constant) so env changes take effect without re-import."""
    from backend.app.services.versioning import config

    backend = config.object_store_backend()
    if backend == "local":
        return LocalFsObjectStore(config.import_store_root())
    raise NotImplementedError(
        f"OBJECT_STORE_BACKEND={backend!r} not yet implemented (v1 ships 'local')"
    )
