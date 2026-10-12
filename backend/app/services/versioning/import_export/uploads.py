"""Resumable uploads: an import's file arrives in parts, each its own request and its own object.

A multi-GB file can't be one request: it would outlast the proxies and timeouts on the way, and a
dropped connection would start it over. So the dialog asks for an upload (the file's name, size and
format), sends the file ``PART_BYTES`` at a time, several parts at once and in any order, and asks
which parts arrived to resume after a failure or a reload. Each part is written once, as its own
object, so a store on a bucket's mount never appends or renames. Completing the upload starts the
import, which reads the parts in order as one stream (:func:`open_source`). Parts are swept with
every other artifact after ``OBJECT_STORE_TTL_HOURS``, so an upload has a day to finish.

A view package arrives the same way (:func:`create_package`, under ``transfer-uploads/``, not yet
bound to any graph). Once a ``package_inspect`` job has checked it, the upload's record names the
archive's data part (``archive``), and that is what :func:`open_source` reads: inflated out of the
zip as it streams, verified against its checksum at the end. The upload is read where it is — by
every import of its data, into any target — never copied.

An upload a job may still read is never swept, however old (:func:`jobs_input_prefixes`).
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import math
import os
import re
import tempfile
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, List, Optional, Set

from sqlalchemy import and_, or_, select

from backend.app.services.storage.object_store import storage_key
from backend.app.services.view_transfer.canonical import HASH_PREFIX

from .. import config, db
from ..models import JobORM

#: Bytes per part: small enough to cross a slow link inside the API's 120 s request timeout.
PART_BYTES = 16 * 1024 * 1024
#: The most one import can be. A file read a row at a time (NDJSON, CSV, TSV) can be 10 GiB...
MAX_BYTES = int(os.getenv("IMPORT_MAX_BYTES", str(10 * 1024 ** 3)))
#: ...but a JSON array or an Excel workbook is read whole, so it stays at 100 MB.
WHOLE_FILE_MAX_BYTES = int(os.getenv("IMPORT_WHOLE_FILE_MAX_BYTES", str(100 * 1024 ** 2)))
WHOLE_FILE_FORMATS = ("json", "xlsx")
RECORD = "upload.json"
_ID = re.compile(r"^iu_[0-9a-f]{32}$")
#: Where view package uploads live, each ``{prefix}/{uploadId}/``: its parts and record, and once
#: inspected what was found (``inspect.json``) and its views (``view-bundle.json``).
PACKAGE_PREFIX = "transfer-uploads"
_PACKAGE_ID = re.compile(r"^up_[0-9a-f]{32}$")
#: How long a package upload is kept for the imports of its data (``view_transfer.package``
#: prunes it then), unless the store's sweep (``OBJECT_STORE_TTL_HOURS``) comes sooner.
PACKAGE_TTL_SECONDS = 24 * 60 * 60
#: Bytes of an archive's data part inflated per worker-thread hop.
_INFLATE_BYTES = 1024 * 1024


class UploadError(Exception):
    """An upload request that can't be served: ``status`` is the HTTP status to answer with."""

    def __init__(self, message: str, status: int = 422) -> None:
        super().__init__(message)
        self.status = status


def _mb(n: int) -> str:
    return f"{n / 1024 ** 3:.0f} GB" if n >= 1024 ** 3 else f"{n / 1024 ** 2:.0f} MB"


def limit_for(fmt: str) -> int:
    return WHOLE_FILE_MAX_BYTES if fmt.lower() in WHOLE_FILE_FORMATS else MAX_BYTES


def too_large(size: int, fmt: str) -> Optional[str]:
    """Why a file of ``size`` bytes in ``fmt`` can't be imported, or ``None``."""
    cap = limit_for(fmt)
    if size <= cap:
        return None
    if fmt.lower() in WHOLE_FILE_FORMATS:
        return (f"A {'JSON' if fmt.lower() == 'json' else 'Excel'} file is read whole, so one import of it "
                f"can be at most {_mb(cap)}. Export NDJSON or CSV instead: they can be up to {_mb(MAX_BYTES)}.")
    return f"One import can be at most {_mb(cap)}. Split the file and import the parts one after another."


def upload_key(record: Dict[str, Any], name: str) -> str:
    """Where the upload keeps ``name``: its record, its parts, and what is found in it."""
    if _PACKAGE_ID.match(record["uploadId"]):
        return storage_key(PACKAGE_PREFIX, record["uploadId"], name)
    return storage_key(record["workspaceId"], record["dataSourceId"] or "none", record["graphId"],
                       "uploads", record["uploadId"], name)


def record_key(record: Dict[str, Any]) -> str:
    """The upload's record: what a completed upload's import job names as its source."""
    return upload_key(record, RECORD)


def part_size(record: Dict[str, Any], n: int) -> int:
    """How many bytes part ``n`` holds: ``partBytes``, but the last holds what remains."""
    return record["size"] - record["partBytes"] * (record["parts"] - 1) if n == record["parts"] - 1 \
        else record["partBytes"]


async def _json(store, key: str) -> Optional[Dict[str, Any]]:
    if not (await store.stat(key)).exists:
        return None
    return json.loads(b"".join([chunk async for chunk in store.open_stream(key)]))


async def _once(data: bytes) -> AsyncIterator[bytes]:
    yield data


async def save(store, record: Dict[str, Any]) -> None:
    await store.put_stream(record_key(record), _once(json.dumps(record).encode("utf-8")))


async def create(store, *, workspace_id: str, data_source_id: Optional[str], graph_id: str, owner: str,
                 file_name: str, size: int, fmt: str) -> Dict[str, Any]:
    """Start an upload of ``size`` bytes: its record, saying how the file is to be split."""
    if size <= 0:
        raise UploadError("The file is empty.")
    reason = too_large(size, fmt)
    if reason:
        raise UploadError(reason, 413)
    record = {
        "uploadId": f"iu_{uuid.uuid4().hex}", "owner": owner, "workspaceId": workspace_id,
        "dataSourceId": data_source_id, "graphId": graph_id, "fileName": file_name, "size": size,
        "format": fmt, "partBytes": PART_BYTES, "parts": math.ceil(size / PART_BYTES),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    await save(store, record)
    return record


async def create_package(store, *, owner: str, file_name: str, size: int) -> Dict[str, Any]:
    """Start an upload of a view package of ``size`` bytes. It belongs to no graph until its data
    is imported somewhere, and may go to several."""
    if size <= 0:
        raise UploadError("The file is empty.")
    if size > MAX_BYTES:
        raise UploadError(f"A package can be at most {_mb(MAX_BYTES)}.", 413)
    record = {
        "uploadId": f"up_{uuid.uuid4().hex}", "owner": owner, "fileName": file_name, "size": size,
        "format": "zip", "partBytes": PART_BYTES, "parts": math.ceil(size / PART_BYTES),
        "createdAt": datetime.now(timezone.utc).isoformat(),
    }
    await save(store, record)
    return record


async def load_package(store, upload_id: str, owner: str) -> Dict[str, Any]:
    """The package upload's record, if it is this user's; else 404, the same either way."""
    gone = UploadError("This upload has expired or was never started. Choose the file again.", 404)
    if not _PACKAGE_ID.match(upload_id or ""):
        raise gone
    record = await _json(store, storage_key(PACKAGE_PREFIX, upload_id, RECORD))
    # A record with no parts was kept by a release that took a package in one request: gone too.
    if record is None or record.get("owner") != owner or "parts" not in record:
        raise gone
    return record


def expires_at(record: Dict[str, Any]) -> datetime:
    """When the package upload may be swept (unless a job still reads it)."""
    ttl = min(PACKAGE_TTL_SECONDS, config.OBJECT_STORE_TTL_HOURS * 3600)
    return datetime.fromisoformat(record["createdAt"]) + timedelta(seconds=ttl)


def is_archive_source(source_uri: str) -> bool:
    """Whether a job's source is a view package upload: its data is read out of the archive."""
    return source_uri.startswith(PACKAGE_PREFIX + "/") and source_uri.endswith("/" + RECORD)


async def load(store, *, workspace_id: str, data_source_id: Optional[str], graph_id: str, upload_id: str,
               owner: str) -> Dict[str, Any]:
    """The upload's record, if it is this user's upload to this graph; else 404, the same either way."""
    gone = UploadError("This upload has expired or was never started. Choose the file again.", 404)
    if not _ID.match(upload_id or ""):
        raise gone
    probe = {"workspaceId": workspace_id, "dataSourceId": data_source_id, "graphId": graph_id,
             "uploadId": upload_id}
    record = await _json(store, record_key(probe))
    if record is None or record.get("owner") != owner:
        raise gone
    return record


async def _exactly(chunks: AsyncIterator[bytes], limit: int) -> AsyncIterator[bytes]:
    """Pass ``chunks`` through, refusing more than ``limit`` bytes as soon as they arrive."""
    seen = 0
    async for chunk in chunks:
        seen += len(chunk)
        if seen > limit:
            raise UploadError(f"This part is larger than the {limit} bytes it should hold.")
        yield chunk


async def put_part(store, record: Dict[str, Any], n: int, chunks: AsyncIterator[bytes]) -> int:
    """Store part ``n``, replacing any earlier try. It must hold exactly its share of the file."""
    if not 0 <= n < record["parts"]:
        raise UploadError(f"This upload has parts 0 to {record['parts'] - 1}; there is no part {n}.")
    expected = part_size(record, n)
    key = upload_key(record, f"part-{n:05d}")
    stat = await store.put_stream(key, _exactly(chunks, expected))
    if stat.size != expected:
        await store.delete(key)
        raise UploadError(f"Part {n} should hold {expected} bytes, and {stat.size} arrived. Send it again.")
    return stat.size


async def received(store, record: Dict[str, Any]) -> List[int]:
    """The parts stored whole."""
    out = []
    for n in range(record["parts"]):
        stat = await store.stat(upload_key(record, f"part-{n:05d}"))
        if stat.exists and stat.size == part_size(record, n):
            out.append(n)
    return out


async def read_record(store, source_uri: str) -> Dict[str, Any]:
    """The record a job's source names. Raises ``FileNotFoundError`` once it is gone."""
    record = await _json(store, source_uri)
    if record is None:
        raise FileNotFoundError(source_uri)
    return record


async def _parts(store, record: Dict[str, Any]) -> AsyncIterator[bytes]:
    for n in range(record["parts"]):
        async for chunk in store.open_stream(upload_key(record, f"part-{n:05d}")):
            yield chunk


async def spool(store, record: Dict[str, Any],
                progress: Optional[Callable[[int], Awaitable[None]]] = None) -> str:
    """The uploaded file, its parts in order, in a temporary file the caller removes (a zip is read
    from its end, so it can't be read as a stream). ``progress(parts so far)`` after each part."""
    fd, path = tempfile.mkstemp(suffix=".zip")
    try:
        with os.fdopen(fd, "wb") as out:
            for n in range(record["parts"]):
                async for chunk in store.open_stream(upload_key(record, f"part-{n:05d}")):
                    await asyncio.to_thread(out.write, chunk)
                if progress is not None:
                    await progress(n + 1)
    except BaseException:
        os.unlink(path)
        raise
    return path


def _inflate(member, digest) -> bytes:
    chunk = member.read(_INFLATE_BYTES)
    digest.update(chunk)
    return chunk


async def _archive_member(store, record: Dict[str, Any]) -> AsyncIterator[bytes]:
    """An inspected package's data part, inflated as it is read and checked against the checksum
    and size its inspection recorded: a part changed since (or a damaged copy) fails at the end
    rather than importing as something else. Its spool goes when the stream ends or is closed."""
    archive = record["archive"]
    path = await spool(store, record)
    try:
        zf = await asyncio.to_thread(zipfile.ZipFile, path)
        try:
            member = await asyncio.to_thread(zf.open, archive["member"])
            try:
                digest, size = hashlib.sha256(), 0
                while chunk := await asyncio.to_thread(_inflate, member, digest):
                    size += len(chunk)
                    yield chunk
            finally:
                await asyncio.to_thread(member.close)
            if (f"{HASH_PREFIX}{digest.hexdigest()}", size) != (archive["sha256"], archive["bytes"]):
                raise ValueError("The package's data isn't what was checked when it was uploaded. "
                                 "Upload the file again.")
        finally:
            await asyncio.to_thread(zf.close)
    finally:
        await asyncio.to_thread(os.unlink, path)


async def open_source(store, source_uri: str) -> AsyncIterator[bytes]:
    """An import's file as one stream: a single object, a completed upload's parts in order, or an
    inspected package upload's data part. Close it (``contextlib.aclosing``) when stopping early:
    a package's spool goes then, not whenever the stream is collected."""
    if not source_uri.endswith("/" + RECORD):
        async for chunk in store.open_stream(source_uri):
            yield chunk
        return
    record = await read_record(store, source_uri)
    chunks = _archive_member(store, record) if record.get("archive") else _parts(store, record)
    async with contextlib.aclosing(chunks):
        async for chunk in chunks:
            yield chunk


async def source_size(store, source_uri: str) -> int:
    """How many bytes :func:`open_source` will yield."""
    if source_uri.endswith("/" + RECORD):
        record = await _json(store, source_uri) or {}
        return int((record.get("archive") or {}).get("bytes") or record.get("size") or 0)
    return (await store.stat(source_uri)).size


async def jobs_input_prefixes() -> Set[str]:
    """Where the inputs live (an upload's folder, a job's own) that a job may still read: those of
    pending and running jobs, and of failed ones from the last ``STAGING_GC_DAYS`` (they resume,
    or are queued again, from the same input). The sweeps keep them however old. Read just before
    a sweep deletes anything; an upload new jobs may take is refused once it nears its TTL, so none
    is pinned between this read and the delete."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=config.STAGING_GC_DAYS)).isoformat()
    async with db.graphver_session() as s:
        rows = (await s.execute(select(JobORM.source_uri, JobORM.payload_uri).where(
            or_(JobORM.source_uri.is_not(None), JobORM.payload_uri.is_not(None)),
            or_(JobORM.status.in_(("pending", "running")),
                and_(JobORM.status == "failed", JobORM.updated_at >= cutoff))))).all()
    return {uri.rsplit("/", 1)[0] for row in rows for uri in row if uri and "/" in uri}
