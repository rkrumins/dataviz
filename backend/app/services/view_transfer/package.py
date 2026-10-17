"""The View Package: views together with their graph data, in one file.

    finance-lineage.v7.view-package.zip
      package.json        what the package holds: scope, data version, what the data holds by type
                          (``data.typeStats``), and for each part its SHA-256, size and counts
      view-bundle.json    the views, exactly as a view file (bundle.py)
      data/graph.ndjson   the graph data, exactly as the data source's own export: lossless,
                          re-importable, and importable on its own through the canvas's Import

An export job writes it (:class:`PackageExport`, run by ``ExportWorker``): the views first, then the
data streamed INTO the zip as the export reads it, deflated and hashed off the event loop, to the
job's own key — one file, written once, never read back. Reading one (:func:`read_package`)
verifies every part against its checksum and size, streaming, and never decompresses more than the
limits allow, whatever the archive claims about itself.

Format 2 writes the data as each entity's stored payload, whole (``stream.native_pages``); this
release reads formats 1 and 2 and still writes 1, so an environment that upgrades later can read
what this one exports. The next release writes 2.

A package to import is uploaded in parts (``import_export.uploads``) and checked by a
``package_inspect`` job (:func:`inspect_upload`); its data is then imported from the upload, in
place, as often and wherever it is taken.
"""
from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import zipfile
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Awaitable, Callable, Dict, Optional, Tuple

from backend.app.services.versioning.import_export import uploads
from backend.app.services.versioning.import_export.stream import TypeStats
from backend.app.services.view_transfer import limits
from backend.app.services.view_transfer.bundle import BundleError, parse_bundle
from backend.app.services.view_transfer.canonical import HASH_PREFIX

PACKAGE_FORMAT = "view-package"
#: The format this platform writes.
PACKAGE_FORMAT_VERSION = 1
#: The newest format it reads.
READ_FORMAT_VERSION = 2

MANIFEST = "package.json"
BUNDLE_PART = "view-bundle.json"
DATA_PART = "data/graph.ndjson"

#: The package's name in the object store, beside its export job's other artifacts.
PACKAGE_ARTIFACT = "view-package.zip"

#: Where an uploaded package waits for its data to be imported: ``{prefix}/{uploadId}/`` holds its
#: parts and a record of who uploaded it, and once inspected, what was found in it.
UPLOADS_PREFIX = uploads.PACKAGE_PREFIX
UPLOAD_RECORD = uploads.RECORD
#: An inspected upload's package section (``GET /packages/{id}``) and its views.
INSPECTION = "inspect.json"
UPLOAD_BUNDLE = BUNDLE_PART
#: How long an upload is kept for its data imports.
UPLOAD_TTL_SECONDS = uploads.PACKAGE_TTL_SECONDS
_CHUNK = 1024 * 1024
_ZIP_MAGIC = b"PK\x03\x04"


class PackageError(ValueError):
    """A file that isn't a readable view package; ``code`` says which way."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def _sha256(data: bytes) -> str:
    return f"{HASH_PREFIX}{hashlib.sha256(data).hexdigest()}"


async def _once(data: bytes) -> AsyncIterator[bytes]:
    yield data


# ── Writing ──────────────────────────────────────────────────────────────────


class _Sink:
    """Where the zip writes, until the generator hands the bytes on. It can't seek or tell, so
    ``zipfile`` streams: each entry's sizes and CRC follow its data."""

    def __init__(self) -> None:
        self._parts: list = []

    def write(self, data) -> int:
        self._parts.append(bytes(data))
        return len(data)

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        out = b"".join(self._parts)
        self._parts.clear()
        return out


def _write_hashed(part, digest, chunk: bytes) -> None:
    digest.update(chunk)
    part.write(chunk)


async def write_package(bundle: bytes, data: AsyncIterator[bytes],
                        manifest_of: Callable[[Dict[str, Dict[str, Any]]], Dict[str, Any]],
                        ) -> AsyncIterator[bytes]:
    """The package's bytes as they are produced: the bundle, then ``data`` deflated into the data
    part as it arrives (zip64: no size limit), then the manifest, which
    ``manifest_of({part: {sha256, bytes}})`` builds once both parts are written. The deflating and
    hashing run in worker threads; only finished bytes reach the event loop."""
    sink = _Sink()
    archive = zipfile.ZipFile(sink, "w", zipfile.ZIP_DEFLATED)
    part = None
    try:
        await asyncio.to_thread(archive.writestr, BUNDLE_PART, bundle)
        yield sink.take()
        digest, size = hashlib.sha256(), 0
        part = archive.open(DATA_PART, "w", force_zip64=True)
        async with contextlib.aclosing(data):
            async for chunk in data:
                await asyncio.to_thread(_write_hashed, part, digest, chunk)
                size += len(chunk)
                out = sink.take()
                if out:
                    yield out
        await asyncio.to_thread(part.close)
        part = None
        manifest = manifest_of({BUNDLE_PART: {"sha256": _sha256(bundle), "bytes": len(bundle)},
                                DATA_PART: {"sha256": f"{HASH_PREFIX}{digest.hexdigest()}", "bytes": size}})
        await asyncio.to_thread(archive.writestr, MANIFEST,
                                json.dumps(manifest, indent=2, ensure_ascii=False))
        await asyncio.to_thread(archive.close)
        yield sink.take()
    finally:
        if part is not None:              # cut off midway: close quietly, the bytes go nowhere
            with contextlib.suppress(Exception):
                part.close()
            with contextlib.suppress(Exception):
                archive.close()


def _dumps(bundle: Dict[str, Any]) -> bytes:
    return json.dumps(bundle, ensure_ascii=False, indent=2).encode("utf-8")


#: Why a view whose version places no entities can't be packaged with "its" data.
NO_PLACEMENTS = ("This view places no entities of its own, so it has no data to package. Package "
                 "the whole data source instead.")


async def build_bundle(session, options: Dict[str, Any], workspace_id: Optional[str],
                       data_source_id: Optional[str]) -> Tuple[Dict[str, Any], Optional[Dict[str, Any]]]:
    """The views' file, built from the versions sealed when the package was asked for (``options``:
    the job's ``package``), and the data's scope.

    A view package's data is that sealed version's own placements, with their contained entities —
    never the view as it is now, which may have moved on since. A version that places nothing has no
    data of its own, and is refused rather than packaging the whole data source in its name. A data
    source's package has no scope."""
    from backend.app.api.v1.endpoints.versioning import _live_containment_types, export_scope_of
    from backend.app.db.models import ViewORM
    from backend.app.services.view_transfer.export import export_views

    requests = []
    for ref in options.get("views") or []:
        row = await session.get(ViewORM, ref["viewId"])
        if row is None:
            raise LookupError("A view in this package was deleted before it could be packaged.")
        requests.append((row, ref["version"], False))
    bundle, sealed = await export_views(session, requests, actor=options.get("actor"))
    scope = None
    if options.get("scope") == "view":
        containment = await _live_containment_types(session, workspace_id, data_source_id)
        scope = await asyncio.to_thread(export_scope_of, sealed[0].definition, containment)
        if scope is None:
            raise ValueError(NO_PLACEMENTS)
    return bundle, scope


async def _no_phase(name: str, **values) -> None:
    pass


class PackageExport:
    """A view package's export job, around the data ``ExportWorker`` writes: the views first (phase
    ``bundle``), then the data, streamed into the package as it is read (phase ``data``)."""

    def __init__(self, options: Dict[str, Any], *, workspace_id: Optional[str],
                 data_source_id: Optional[str]) -> None:
        self._options = options
        self._ws, self._ds = workspace_id, data_source_id
        self._bundle = b""
        self._bundle_hash: Optional[str] = None

    async def prepare(self, phase: Callable[..., Awaitable[None]] = _no_phase) -> Optional[Dict[str, Any]]:
        """Build the views' file (``phase('bundle')``; the JSON is written in a worker thread), then
        say the data comes next (``phase('data')``). Returns the data's scope (:func:`build_bundle`)."""
        from backend.app.db.engine import get_async_session

        await phase("bundle")
        async with get_async_session() as session:
            bundle, scope = await build_bundle(session, self._options, self._ws, self._ds)
        self._bundle = await asyncio.to_thread(_dumps, bundle)
        self._bundle_hash = bundle["bundleHash"]
        await phase("data")
        return scope

    @staticmethod
    def key(result_uri: str) -> str:
        """Where the package goes: beside the job's other artifacts, in place of its data file."""
        return f"{result_uri.rsplit('/', 1)[0]}/{PACKAGE_ARTIFACT}"

    def write(self, data: AsyncIterator[bytes], tally: Dict[str, int], stats: TypeStats) -> AsyncIterator[bytes]:
        """The package around ``data`` (the export's NDJSON), its manifest from what the data
        held (``tally``: per kind; ``stats``: per type), counted as it streamed."""
        options = self._options

        def manifest_of(found: Dict[str, Dict[str, Any]]) -> Dict[str, Any]:
            counts = {"nodes": tally.get("node", 0), "edges": tally.get("edge", 0)}
            return {
                "format": PACKAGE_FORMAT, "formatVersion": PACKAGE_FORMAT_VERSION,
                "createdAt": datetime.now(timezone.utc).isoformat(),
                "scope": options.get("scope") or "view",
                "data": {"version": options.get("dataVersion") or "published", **counts,
                         "typeStats": stats.as_dict()},
                "parts": {
                    BUNDLE_PART: {"views": len(options.get("views") or []), "bundleHash": self._bundle_hash,
                                  **found[BUNDLE_PART]},
                    DATA_PART: {**found[DATA_PART], **counts},
                },
            }

        return write_package(self._bundle, data, manifest_of)

    def summary(self, size: int) -> Dict[str, Any]:
        return {"fileName": self._options.get("fileName"), "bytes": size, "bundleHash": self._bundle_hash}


# ── Reading ──────────────────────────────────────────────────────────────────


@dataclass
class ParsedPackage:
    manifest: Dict[str, Any]
    bundle: bytes
    #: Per part: what the manifest says, what was found, and whether they agree.
    parts: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    #: What the data holds by type (``stream.TypeStats``): the manifest's, or, from an exporter that
    #: didn't write it, counted from the data as it was checked.
    type_stats: Dict[str, Any] = field(default_factory=dict)

    @property
    def verified(self) -> bool:
        return all(p.get("verified") for p in self.parts.values())


class _TypeTally:
    """Counts data lines by type as they stream past: a format-1 record names its type itself, a
    format-2 line inside its ``payload``. A line that isn't a node or an edge isn't counted (the
    import reports it)."""

    def __init__(self) -> None:
        self.stats = TypeStats()
        self._tail = b""

    def feed(self, chunk: bytes) -> None:
        lines = (self._tail + chunk).split(b"\n")
        self._tail = lines.pop()
        for line in lines:
            self._count(line)

    def close(self) -> None:
        self._count(self._tail)
        self._tail = b""

    def _count(self, line: bytes) -> None:
        if not line.strip():
            return
        try:
            record = json.loads(line)
        except ValueError:
            return
        kind = record.get("kind") if isinstance(record, dict) else None
        if kind in ("node", "edge"):
            fields = record["payload"] if isinstance(record.get("payload"), dict) else record
            self.stats.add(kind, [fields.get("entityType" if kind == "node" else "edgeType")])


def read_package(path: str) -> ParsedPackage:
    """Open the package at ``path`` and check every part against the manifest: the data part is
    streamed through its checksum, never unpacked to disk. What the data holds by type comes from
    the manifest, or is counted on the same pass. Blocking: run it in a thread. Raises
    :class:`PackageError`."""
    try:
        archive = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, ValueError, NotImplementedError):
        raise PackageError("This file isn't a readable package: the archive is damaged.", code="not_a_package")
    try:
        with archive:
            return _read(archive)
    except (PackageError, BundleError):
        raise
    # A part fails its CRC or won't inflate; or zipfile refuses it — encrypted (RuntimeError), a
    # compression method it lacks (NotImplementedError), a corrupt header (ValueError): a verdict
    # on the file, never a check that broke and is worth running again.
    except (zipfile.BadZipFile, zlib.error, EOFError, RuntimeError, NotImplementedError,
            ValueError) as exc:
        raise PackageError(f"This file isn't a readable package: a part of it is damaged ({exc}).",
                           code="not_a_package")


def _read(archive: zipfile.ZipFile) -> ParsedPackage:
    """:func:`read_package`'s reading: the manifest and the bundle, then the data part streamed
    through its checksum (and the type count, when the manifest has none)."""
    names = set(archive.namelist())
    missing = [n for n in (MANIFEST, BUNDLE_PART, DATA_PART) if n not in names]
    if missing:
        raise PackageError(
            "This archive isn't a view package: it has no " + ", ".join(missing) + ".", code="not_a_package")
    manifest_raw = _read_capped(archive, MANIFEST, limits.MAX_PACKAGE_MANIFEST_BYTES)
    try:
        manifest = json.loads(manifest_raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise PackageError("The package's manifest isn't valid JSON.", code="not_a_package")
    if not isinstance(manifest, dict) or manifest.get("format") != PACKAGE_FORMAT:
        raise PackageError("This archive isn't a view package.", code="not_a_package")
    version = manifest.get("formatVersion")
    if not isinstance(version, int) or version < 1:
        raise PackageError("This package has no valid format version.", code="not_a_package")
    if version > READ_FORMAT_VERSION:
        raise PackageError(
            f"This package was made by a newer version of the platform (format {version}; this one "
            f"reads up to {READ_FORMAT_VERSION}).", code="newer_format")
    bundle = _read_capped(archive, BUNDLE_PART, limits.MAX_BUNDLE_BYTES)

    data = manifest.get("data") if isinstance(manifest.get("data"), dict) else {}
    declared_stats = data.get("typeStats") if isinstance(data.get("typeStats"), dict) else None
    tally = None if declared_stats is not None else _TypeTally()
    digest, size = hashlib.sha256(), 0
    with archive.open(DATA_PART) as source:
        while chunk := source.read(_CHUNK):
            size += len(chunk)
            if size > limits.MAX_PACKAGE_DATA_BYTES:
                raise PackageError(
                    f"This package's data unpacks to more than "
                    f"{limits.MAX_PACKAGE_DATA_BYTES // (1024 ** 3)} GB, the most a package can hold.",
                    code="too_large")
            digest.update(chunk)
            if tally is not None:
                tally.feed(chunk)
    if tally is not None:
        tally.close()

    declared = manifest.get("parts") if isinstance(manifest.get("parts"), dict) else {}
    found = {BUNDLE_PART: (_sha256(bundle), len(bundle)),
             DATA_PART: (f"{HASH_PREFIX}{digest.hexdigest()}", size)}
    parts = {}
    for name, (sha, nbytes) in found.items():
        claim = declared.get(name) if isinstance(declared.get(name), dict) else {}
        parts[name] = {**claim, "sha256": sha, "bytes": nbytes,
                       "verified": claim.get("sha256") == sha and claim.get("bytes") == nbytes}
    return ParsedPackage(manifest=manifest, bundle=bundle, parts=parts,
                         type_stats=declared_stats if tally is None else tally.stats.as_dict())


def _read_capped(archive: zipfile.ZipFile, name: str, cap: int) -> bytes:
    """A part's bytes, never decompressing past ``cap`` whatever the archive declares."""
    with archive.open(name) as source:
        data = source.read(cap + 1)
    if len(data) > cap:
        raise PackageError(f"The package's {name} is larger than it can be.", code="too_large")
    return data


def _check(path: str):
    """The package at ``path``, read and verified, and its views parsed. Blocking."""
    with open(path, "rb") as f:
        head = f.read(4)
    if head != _ZIP_MAGIC:
        raise PackageError("This is a view file, without data. Import it with \"Import a view\".",
                           code="view_file")
    checked = read_package(path)
    return checked, parse_bundle(checked.bundle)


# ── Inspecting an upload ─────────────────────────────────────────────────────


async def inspect_upload(store, source_uri: str,
                         phase: Callable[..., Awaitable[None]] = _no_phase) -> Dict[str, Any]:
    """The ``package_inspect`` job's work on the upload whose record is ``source_uri``: every part
    checked against the manifest, and the views as a view file's are. What it finds waits beside
    the parts for ``GET /packages/{id}`` (:data:`INSPECTION`, :data:`UPLOAD_BUNDLE`), and then the
    record says the upload is ready, naming the data part its imports read in place (``archive``) —
    or why it is no package to import (``error``: an answer, not a failure of the job).
    ``phase(name, **job columns)`` reports progress. Returns the job's summary."""
    record = await uploads.read_record(store, source_uri)
    parts = record["parts"]

    async def spooled(done: int) -> None:          # counted in parts: a job's counts are 32-bit
        await phase("spool", processed=done, total=parts, progress=done * 90 // parts)

    await phase("spool", processed=0, total=parts, progress=0)
    path = await uploads.spool(store, record, progress=spooled)
    try:
        await phase("verify")
        try:
            checked, parsed = await asyncio.to_thread(_check, path)
        except (PackageError, BundleError) as exc:
            error = {"code": exc.code, "message": str(exc)}
            await uploads.save(store, {**record, "error": error})
            return {"invalid": error}
    finally:
        await asyncio.to_thread(os.unlink, path)

    manifest = checked.manifest
    data = manifest.get("data") if isinstance(manifest.get("data"), dict) else {}
    integrity = "verified" if checked.verified else "modified"
    inspection = {"package": {
        "scope": manifest.get("scope"), "data": {**data, "typeStats": checked.type_stats},
        "createdAt": manifest.get("createdAt"), "parts": checked.parts, "integrity": integrity,
    }}
    await store.put_stream(uploads.upload_key(record, UPLOAD_BUNDLE), _once(checked.bundle))
    await store.put_stream(uploads.upload_key(record, INSPECTION), _once(json.dumps(inspection).encode("utf-8")))
    found = checked.parts[DATA_PART]
    await uploads.save(store, {
        **record, "views": [(v.raw.get("metadata") or {}).get("name") for v in parsed.views],
        "archive": {"member": DATA_PART, "bytes": found["bytes"], "sha256": found["sha256"]},
    })
    return {"views": len(parsed.views), "integrity": integrity, "bytes": found["bytes"]}


async def prune_uploads(store=None, *, older_than_seconds: int = UPLOAD_TTL_SECONDS, keep_prefixes=()) -> int:
    """Drop package uploads older than a day, whether or not their data was imported, but none a job
    may still read (``keep_prefixes``). A store that can't tell an object's age keeps them."""
    if store is None:
        from backend.app.services.storage.object_store import get_object_store
        store = get_object_store()
    prune = getattr(store, "prune_older_than", None)
    if not callable(prune):
        return 0
    return await prune(UPLOADS_PREFIX, older_than_seconds, keep_prefixes=keep_prefixes)


__all__ = [
    "PACKAGE_FORMAT", "PACKAGE_FORMAT_VERSION", "READ_FORMAT_VERSION", "MANIFEST", "BUNDLE_PART", "DATA_PART",
    "PACKAGE_ARTIFACT", "UPLOADS_PREFIX", "UPLOAD_RECORD", "INSPECTION", "UPLOAD_BUNDLE", "UPLOAD_TTL_SECONDS",
    "NO_PLACEMENTS", "PackageError", "PackageExport", "ParsedPackage", "build_bundle", "inspect_upload",
    "prune_uploads", "read_package", "write_package",
]
