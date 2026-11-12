"""Resumable uploads: an import's file arrives in parts, each its own request and its own object.

A multi-GB file can't be one request: it would outlast the proxies and timeouts on the way, and a
dropped connection would start it over. So the dialog asks for an upload (the file's name, size and
format), sends the file ``PART_BYTES`` at a time (or the ``partBytes`` a client asked for, to send
parts of its own size), several parts at once and in any order, and asks
which parts arrived to resume after a failure or a reload. A client may instead send a run of parts
in one request, up to the whole file: it is cut into its parts as it arrives (:func:`put_part`).
Each part is written once, as its own
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
import base64
import binascii
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
#: The part sizes a client may ask for instead. At least 5 MiB, S3's own floor for a part, so a
#: 10 GiB file is at most 2,048 parts. At most 100 MiB: a part is what a dropped connection costs,
#: and a client that would send more at once sends a run of parts in one request.
MIN_PART_BYTES = 5 * 1024 * 1024
MAX_PART_BYTES = 100 * 1024 * 1024
#: Parts looked up at once to find which arrived: thousands of parts take seconds, not minutes,
#: and one request holds only a few of the database's connections.
_STAT_CONCURRENCY = 8
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


#: An upload starts with its description, a few hundred bytes of JSON, or with the file itself as
#: the body, sent as anything else. A JSON body larger than this is a file sent as JSON.
DESCRIPTION_MAX_BYTES = 64 * 1024
DESCRIPTION_TOO_LARGE = (
    'A JSON body here is the upload\'s description, {"fileName", "size", "format"}: at most 64 KB. To '
    "send the file itself as the body, send it as application/octet-stream (or text/csv), with "
    "?fileName= and ?format=.")
FORM_REFUSED = (
    "Send the file's bytes as the request body, not as a form (multipart/form-data): with curl, "
    "--data-binary @file or -T file rather than -F; in Postman, Body → binary. Guide: "
    "/docs/import-export-api#from-your-service-upsert-and-full-replace")


#: The digests a request may say its body has (RFC 9530 ``Content-Digest``), checked as it arrives.
_DIGESTS: Dict[str, Callable[[], Any]] = {"sha-256": hashlib.sha256, "sha-512": hashlib.sha512}
_DIGEST_ITEM = re.compile(r"\s*([A-Za-z0-9-]+)\s*=\s*:([A-Za-z0-9+/]*={0,2}):\s*(?:;[^,]*)?")


def content_digest(header: Optional[str]) -> Optional[tuple]:
    """What a request's ``Content-Digest`` says its body hashes to — ``(algorithm, digest)``, the
    strongest it names that this server checks — or ``None`` when it sends none. One that can't be
    read, or names only algorithms this server doesn't check, is refused (400): a client that asks
    for its body to be checked is never let through unchecked."""
    if header is None or not header.strip():
        return None
    named: Dict[str, str] = {}
    for item in header.split(","):
        match = _DIGEST_ITEM.fullmatch(item)
        if match is None:
            raise UploadError(f"Content-Digest {header!r} can't be read: send it as sha-256=:<the body's "
                              "sha-256, base64>: (RFC 9530).", 400)
        named[match.group(1).lower()] = match.group(2)
    for alg in ("sha-512", "sha-256"):
        if alg in named:
            try:
                return alg, base64.b64decode(named[alg], validate=True)
            except binascii.Error:
                raise UploadError(f"Content-Digest's {alg} isn't base64.", 400)
    raise UploadError(f"Content-Digest names {', '.join(sorted(named))}; this server checks sha-256 and "
                      "sha-512.", 400)


async def checked(chunks: AsyncIterator[bytes], digest: Optional[tuple]) -> AsyncIterator[bytes]:
    """``chunks``, then — once they end — a check that they hash to ``digest``. A body that doesn't
    is refused (422) there, before its import can use it; its caller drops what it stored."""
    if digest is None:
        async for chunk in chunks:
            yield chunk
        return
    alg, want = digest
    hasher = _DIGESTS[alg]()
    async for chunk in chunks:
        hasher.update(chunk)
        yield chunk
    got = hasher.digest()
    if got != want:
        raise UploadError(
            f"The body's {alg} is :{base64.b64encode(got).decode()}:, not the "
            f":{base64.b64encode(want).decode()}: its Content-Digest says: it changed on the way, or the "
            "digest is of another file. None of it is used: send it again.", 422)


def _media_type(content_type: Optional[str]) -> str:
    return (content_type or "").split(";", 1)[0].strip().lower()


def sent_as_json(content_type: Optional[str]) -> bool:
    """Whether a body is JSON, as FastAPI reads one: a body with no type counts."""
    kind = _media_type(content_type)
    return not kind or kind == "application/json" or kind.endswith("+json")


def is_form(content_type: Optional[str]) -> bool:
    """Whether a body is a form: its file would come wrapped in the form's own lines."""
    return _media_type(content_type) == "multipart/form-data"


def too_large(size: int, fmt: str) -> Optional[str]:
    """Why a file of ``size`` bytes in ``fmt`` can't be imported, or ``None``."""
    cap = limit_for(fmt)
    if size <= cap:
        return None
    if fmt.lower() in WHOLE_FILE_FORMATS:
        return (f"{'A JSON' if fmt.lower() == 'json' else 'An Excel'} file is read whole, so one import of it "
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


def _checked_part_bytes(part_bytes: Optional[int]) -> int:
    """The part size a client asked for, within bounds, else ``PART_BYTES``."""
    if part_bytes is None:
        return PART_BYTES
    if not MIN_PART_BYTES <= part_bytes <= MAX_PART_BYTES:
        raise UploadError(f"partBytes can be from {MIN_PART_BYTES} to {MAX_PART_BYTES} bytes "
                          f"({_mb(MIN_PART_BYTES)} to {_mb(MAX_PART_BYTES)}), and {part_bytes} isn't.")
    return part_bytes


def _checked_size(size: int, fmt: str) -> None:
    if size <= 0:
        raise UploadError("The file is empty.")
    reason = too_large(size, fmt)
    if reason:
        raise UploadError(reason, 413)


def _new_record(*, workspace_id: str, data_source_id: Optional[str], graph_id: str, owner: str,
                file_name: str, fmt: str, part_bytes: int) -> Dict[str, Any]:
    return {
        "uploadId": f"iu_{uuid.uuid4().hex}", "owner": owner, "workspaceId": workspace_id,
        "dataSourceId": data_source_id, "graphId": graph_id, "fileName": file_name,
        "format": fmt, "partBytes": part_bytes, "createdAt": datetime.now(timezone.utc).isoformat(),
    }


async def create(store, *, workspace_id: str, data_source_id: Optional[str], graph_id: str, owner: str,
                 file_name: str, size: int, fmt: str, part_bytes: Optional[int] = None) -> Dict[str, Any]:
    """Start an upload of ``size`` bytes: its record, saying how the file is to be split — into
    ``part_bytes`` parts when the client asks for a size of its own, else ``PART_BYTES``."""
    _checked_size(size, fmt)
    record = _new_record(workspace_id=workspace_id, data_source_id=data_source_id, graph_id=graph_id,
                         owner=owner, file_name=file_name, fmt=fmt, part_bytes=_checked_part_bytes(part_bytes))
    record.update(size=size, parts=math.ceil(size / record["partBytes"]))
    await save(store, record)
    return record


async def create_from_body(store, chunks: AsyncIterator[bytes], *, workspace_id: str,
                           data_source_id: Optional[str], graph_id: str, owner: str, file_name: str,
                           fmt: str, declared: Optional[int] = None,
                           part_bytes: Optional[int] = None, digest: Optional[tuple] = None) -> Dict[str, Any]:
    """Start an upload with its file: a request body of any size, stored as the upload's parts as it
    arrives — whether it says its size (``declared``, its Content-Length) or is streamed without
    one — one chunk held at a time, each part written once as its own object.

    The upload exists once the whole body is in: its record, with the size that arrived, is written
    last, so a body that breaks off leaves no upload, only parts nothing names, which the store's
    sweep takes. A body past what one import of ``fmt`` can be is refused (413) — one that says so
    before any of it is read, a streamed one as soon as it passes it — and so is one that doesn't
    hash to its ``digest`` (422): neither keeps any of itself."""
    if declared is not None:
        _checked_size(declared, fmt)
    record = _new_record(workspace_id=workspace_id, data_source_id=data_source_id, graph_id=graph_id,
                         owner=owner, file_name=file_name, fmt=fmt, part_bytes=_checked_part_bytes(part_bytes))
    body, written, size = _Body(checked(within_limit(chunks, fmt), digest)), [], 0
    try:
        while True:
            key = upload_key(record, f"part-{len(written):05d}")
            written.append(key)
            size += (await store.put_stream(key, body.part(record["partBytes"]))).size
            if not await body.more():
                break
        if size == 0:
            raise UploadError("The file is empty.")
        if declared is not None and size != declared:
            raise UploadError(f"The body ended {size} bytes in, short of the {declared} its Content-Length "
                              "said. Send it again.")
    except UploadError:
        for key in written:             # refused: none of it is kept
            await store.delete(key)
        raise
    record.update(size=size, parts=len(written))
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
    """When the upload may be swept (unless a job still reads it): ``OBJECT_STORE_TTL_HOURS`` after
    it was started — a package's ``PACKAGE_TTL_SECONDS`` at most."""
    ttl = config.OBJECT_STORE_TTL_HOURS * 3600
    if _PACKAGE_ID.match(record["uploadId"]):
        ttl = min(PACKAGE_TTL_SECONDS, ttl)
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


def _wrong_size(record: Dict[str, Any], n: int, got: str) -> str:
    """Why a body sent to part ``n`` was refused (``got``: what came instead), and how the file is
    split — and, for an import's upload, how to ask for parts of another size (a package's takes no
    ``partBytes``)."""
    pb = record["partBytes"]
    if n == record["parts"] - 1:
        must = f"Part {n} must hold exactly {part_size(record, n)} bytes, the rest of the file"
    else:
        must = (f"Part {n} must hold exactly {pb} bytes, or run on from it to the end of a later part "
                f"(a multiple of {pb} bytes) or of the file ({record['size'] - n * pb} bytes)")
    why = (f"{must}, and {got}. This upload splits the file into {record['parts']} parts of partBytes "
           f"({pb}) bytes, the last holding the rest: part n starts at byte n × partBytes of the file, "
           "sent as the raw request body.")
    if _PACKAGE_ID.match(record["uploadId"]):
        return why
    return (f"{why} To send parts of another size, start the upload with that partBytes "
            f"({_mb(MIN_PART_BYTES)} to {_mb(MAX_PART_BYTES)}).")


def _ends_on_a_part(record: Dict[str, Any], n: int, length: int) -> bool:
    """Whether a body of ``length`` bytes sent to part ``n`` ends where a part does."""
    end = n * record["partBytes"] + length
    return length > 0 and (end == record["size"] or (end < record["size"] and end % record["partBytes"] == 0))


class _Body:
    """A request body taken a part at a time: :meth:`part` yields its next ``size`` bytes (fewer if
    it ends first), and :meth:`more` says whether any of it is left. It holds one chunk at most."""

    def __init__(self, chunks: AsyncIterator[bytes]) -> None:
        self._chunks = chunks.__aiter__()
        self._held = b""
        self._ended = False

    async def more(self) -> bool:
        while not self._held and not self._ended:
            try:
                self._held = await self._chunks.__anext__()
            except StopAsyncIteration:
                self._ended = True
        return bool(self._held)

    async def part(self, size: int) -> AsyncIterator[bytes]:
        while size and await self.more():
            chunk, self._held = self._held[:size], self._held[size:]
            size -= len(chunk)
            yield chunk


async def put_part(store, record: Dict[str, Any], n: int, chunks: AsyncIterator[bytes], *,
                   declared: Optional[int] = None, digest: Optional[tuple] = None) -> int:
    """Store part ``n`` — and the parts after it, when the body runs on, each as its bytes arrive —
    replacing any earlier try. Returns the bytes stored.

    The body is the file's bytes from part ``n``'s start: exactly part ``n``, or on to the end of a
    later part or of the file, so one request can carry the whole file (to part 0), or the rest of
    it from the first part missing. One that says it ends anywhere else (``declared``, its
    Content-Length) is refused before any of it is read. One that does end anywhere else, or runs
    past the file, is refused once that shows, and none of it is kept; so is one that doesn't hash
    to its ``digest``. One cut off — the client went away, or stopped sending — keeps the parts it
    brought whole: send the rest from the first one missing."""
    if not 0 <= n < record["parts"]:
        raise UploadError(f"This upload has parts 0 to {record['parts'] - 1}; there is no part {n}.")
    if declared is not None and not _ends_on_a_part(record, n, declared):
        raise UploadError(_wrong_size(record, n, f"this request's body is {declared} bytes"))
    body, written, stored = _Body(checked(chunks, digest)), [], 0
    try:
        for k in range(n, record["parts"]):
            expected = part_size(record, k)
            key = upload_key(record, f"part-{k:05d}")
            written.append(key)
            stat = await store.put_stream(key, body.part(expected))
            if stat.size != expected:
                if k == n:
                    raise UploadError(_wrong_size(record, n, f"{stat.size} arrived") + " Send it again.")
                raise UploadError(_wrong_size(record, n, f"the body ended {stat.size} bytes into part {k}"))
            stored += stat.size
            if not await body.more():
                return stored
        raise UploadError(_wrong_size(record, n, "more arrived than the file holds from there"))
    except UploadError:
        for key in written:             # the body as a whole was wrong: none of it is kept
            await store.delete(key)
        raise


async def within_limit(chunks: AsyncIterator[bytes], fmt: str) -> AsyncIterator[bytes]:
    """An import's file sent in one request, refused (413) as soon as it passes what one import of
    ``fmt`` can be: a body with no Content-Length (chunked) is held to that too."""
    cap, seen = limit_for(fmt), 0
    async for chunk in chunks:
        seen += len(chunk)
        if seen > cap:
            raise UploadError(too_large(seen, fmt), 413)
        yield chunk


async def received(store, record: Dict[str, Any]) -> List[int]:
    """The parts stored whole, looked up ``_STAT_CONCURRENCY`` at a time."""
    gate = asyncio.Semaphore(_STAT_CONCURRENCY)

    async def whole(n: int) -> bool:
        async with gate:
            stat = await store.stat(upload_key(record, f"part-{n:05d}"))
        return stat.exists and stat.size == part_size(record, n)

    found = await asyncio.gather(*(whole(n) for n in range(record["parts"])))
    return [n for n, ok in enumerate(found) if ok]


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
