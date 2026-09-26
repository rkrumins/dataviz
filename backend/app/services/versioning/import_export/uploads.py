"""Resumable uploads: an import's file arrives in parts, each its own request and its own object.

A multi-GB file can't be one request: it would outlast the proxies and timeouts on the way, and a
dropped connection would start it over. So the dialog asks for an upload (the file's name, size and
format), sends the file ``PART_BYTES`` at a time, several parts at once and in any order, and asks
which parts arrived to resume after a failure or a reload. Each part is written once, as its own
object, so a store on a bucket's mount never appends or renames. Completing the upload starts the
import, which reads the parts in order as one stream (:func:`open_source`). Parts are swept with
every other artifact after ``OBJECT_STORE_TTL_HOURS``, so an upload has a day to finish.
"""
from __future__ import annotations

import json
import math
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict, List, Optional

from backend.app.services.storage.object_store import storage_key

#: Bytes per part: small enough to cross a slow link inside the API's 120 s request timeout.
PART_BYTES = 16 * 1024 * 1024
#: The most one import can be. A file read a row at a time (NDJSON, CSV, TSV) can be 10 GiB...
MAX_BYTES = int(os.getenv("IMPORT_MAX_BYTES", str(10 * 1024 ** 3)))
#: ...but a JSON array or an Excel workbook is read whole, so it stays at 100 MB.
WHOLE_FILE_MAX_BYTES = int(os.getenv("IMPORT_WHOLE_FILE_MAX_BYTES", str(100 * 1024 ** 2)))
WHOLE_FILE_FORMATS = ("json", "xlsx")
RECORD = "upload.json"
_ID = re.compile(r"^iu_[0-9a-f]{32}$")


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


def _key(record: Dict[str, Any], name: str) -> str:
    return storage_key(record["workspaceId"], record["dataSourceId"] or "none", record["graphId"],
                       "uploads", record["uploadId"], name)


def record_key(record: Dict[str, Any]) -> str:
    """The upload's record: what a completed upload's import job names as its source."""
    return _key(record, RECORD)


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
    key = _key(record, f"part-{n:05d}")
    stat = await store.put_stream(key, _exactly(chunks, expected))
    if stat.size != expected:
        await store.delete(key)
        raise UploadError(f"Part {n} should hold {expected} bytes, and {stat.size} arrived. Send it again.")
    return stat.size


async def received(store, record: Dict[str, Any]) -> List[int]:
    """The parts stored whole."""
    out = []
    for n in range(record["parts"]):
        stat = await store.stat(_key(record, f"part-{n:05d}"))
        if stat.exists and stat.size == part_size(record, n):
            out.append(n)
    return out


async def open_source(store, source_uri: str) -> AsyncIterator[bytes]:
    """An import's file as one stream: a single object, or a completed upload's parts in order."""
    if not source_uri.endswith("/" + RECORD):
        async for chunk in store.open_stream(source_uri):
            yield chunk
        return
    record = await _json(store, source_uri)
    if record is None:
        raise FileNotFoundError(source_uri)
    for n in range(record["parts"]):
        async for chunk in store.open_stream(_key(record, f"part-{n:05d}")):
            yield chunk


async def source_size(store, source_uri: str) -> int:
    """How many bytes :func:`open_source` will yield."""
    if source_uri.endswith("/" + RECORD):
        record = await _json(store, source_uri)
        return int((record or {}).get("size") or 0)
    return (await store.stat(source_uri)).size
