"""The View Package: views together with their graph data, in one file.

    finance-lineage.v7.view-package.zip
      package.json        what the package holds: scope, data version, and for each part its
                          SHA-256, size and counts
      view-bundle.json    the views, exactly as a view file (bundle.py)
      data/graph.ndjson   the graph data, exactly as the data source's own export: lossless,
                          re-importable, and importable on its own through the canvas's Import

The data part IS the existing graph export (``ExportWorker``); the package is assembled around it
once it is written, streaming, so the data is never held in memory. Reading one back verifies
every part against its checksum and size, and never decompresses more than the limits allow,
whatever the archive claims about itself.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, AsyncIterator, Dict

from backend.app.services.view_transfer import limits
from backend.app.services.view_transfer.canonical import HASH_PREFIX

PACKAGE_FORMAT = "view-package"
PACKAGE_FORMAT_VERSION = 1

MANIFEST = "package.json"
BUNDLE_PART = "view-bundle.json"
DATA_PART = "data/graph.ndjson"

#: The package's name in the object store, beside its export job's other artifacts.
PACKAGE_ARTIFACT = "view-package.zip"

#: Where an inspected package waits for its data to be imported: ``{prefix}/{uploadId}/`` holds
#: the data part and a record of who uploaded it (and, once imported, where its data went).
UPLOADS_PREFIX = "transfer-uploads"
UPLOAD_DATA = "graph.ndjson"
UPLOAD_RECORD = "upload.json"
#: How long an upload is kept for its data import.
UPLOAD_TTL_SECONDS = 24 * 60 * 60
_CHUNK = 1024 * 1024


class PackageError(ValueError):
    """A file that isn't a readable view package; ``code`` says which way."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


def _sha256(data: bytes) -> str:
    return f"{HASH_PREFIX}{hashlib.sha256(data).hexdigest()}"


async def file_chunks(path: str) -> AsyncIterator[bytes]:
    f = await asyncio.to_thread(open, path, "rb")
    try:
        while True:
            chunk = await asyncio.to_thread(f.read, _CHUNK)
            if not chunk:
                return
            yield chunk
    finally:
        await asyncio.to_thread(f.close)


async def _read_all(store, key: str) -> bytes:
    return b"".join([chunk async for chunk in store.open_stream(key)])


# ── Writing ──────────────────────────────────────────────────────────────────


async def assemble(store, *, bundle_key: str, data_key: str, package_key: str,
                   manifest: Dict[str, Any]) -> Dict[str, Any]:
    """Zip the bundle and the data part (both already in ``store``) with a manifest of the two,
    through a temporary file, into ``package_key``. Returns the manifest written and the size."""
    bundle = await _read_all(store, bundle_key)
    fd, path = tempfile.mkstemp(suffix=".zip")
    os.close(fd)
    try:
        archive = await asyncio.to_thread(zipfile.ZipFile, path, "w", zipfile.ZIP_DEFLATED, True)
        try:
            await asyncio.to_thread(archive.writestr, BUNDLE_PART, bundle)
            digest, size = hashlib.sha256(), 0
            part = await asyncio.to_thread(archive.open, DATA_PART, "w", force_zip64=True)
            try:
                async for chunk in store.open_stream(data_key):
                    digest.update(chunk)
                    size += len(chunk)
                    await asyncio.to_thread(part.write, chunk)
            finally:
                await asyncio.to_thread(part.close)
            parts = dict(manifest.get("parts") or {})
            parts[BUNDLE_PART] = {**(parts.get(BUNDLE_PART) or {}), "sha256": _sha256(bundle), "bytes": len(bundle)}
            parts[DATA_PART] = {**(parts.get(DATA_PART) or {}), "sha256": f"{HASH_PREFIX}{digest.hexdigest()}",
                                "bytes": size}
            written = {**manifest, "format": PACKAGE_FORMAT, "formatVersion": PACKAGE_FORMAT_VERSION, "parts": parts}
            await asyncio.to_thread(archive.writestr, MANIFEST, json.dumps(written, indent=2, ensure_ascii=False))
        finally:
            await asyncio.to_thread(archive.close)
        stat = await store.put_stream(package_key, file_chunks(path))
        return {"manifest": written, "bytes": stat.size}
    finally:
        os.unlink(path)


async def finish_export(store, job_id: str, result_uri: str, summary: Dict[str, Any], *,
                        package: Dict[str, Any]) -> Dict[str, Any]:
    """The ``ExportWorker`` hook for a package export: once the data is written, package it with
    the bundle stored beside it, and make the package the job's result."""
    prefix = result_uri.rsplit("/", 1)[0]
    bundle_key = f"{prefix}/{BUNDLE_PART}"
    package_key = f"{prefix}/{PACKAGE_ARTIFACT}"
    manifest = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "scope": package.get("scope") or "view",
        "data": {"version": package.get("dataVersion") or "published",
                 "nodes": summary.get("nodes"), "edges": summary.get("edges")},
        "parts": {BUNDLE_PART: {"views": package.get("views"), "bundleHash": package.get("bundleHash")}},
    }
    written = await assemble(store, bundle_key=bundle_key, data_key=result_uri, package_key=package_key,
                             manifest=manifest)
    # The parts live on inside the package; keep one copy.
    await store.delete(result_uri)
    await store.delete(bundle_key)
    return {"resultUri": package_key,
            "summary": {"package": {"fileName": package.get("fileName"), "bytes": written["bytes"]}}}


# ── Reading ──────────────────────────────────────────────────────────────────


@dataclass
class ParsedPackage:
    manifest: Dict[str, Any]
    bundle: bytes
    #: Where the data part was unpacked to (a temporary file the caller removes).
    data_path: str
    #: Per part: what the manifest says, what was found, and whether they agree.
    parts: Dict[str, Dict[str, Any]] = field(default_factory=dict)

    @property
    def verified(self) -> bool:
        return all(p.get("verified") for p in self.parts.values())


def read_package(path: str) -> ParsedPackage:
    """Open the package at ``path``, unpack its data part to a temporary file and check every part
    against the manifest. Blocking: run it in a thread. Raises :class:`PackageError`."""
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise PackageError("This file isn't a readable package: the archive is damaged.", code="not_a_package")
    with archive:
        names = set(archive.namelist())
        missing = [n for n in (MANIFEST, BUNDLE_PART, DATA_PART) if n not in names]
        if missing:
            raise PackageError(
                "This archive isn't a view package: it has no " + ", ".join(missing) + ".", code="not_a_package")
        caps = {MANIFEST: limits.MAX_PACKAGE_MANIFEST_BYTES, BUNDLE_PART: limits.MAX_BUNDLE_BYTES}
        manifest_raw = _read_capped(archive, MANIFEST, caps[MANIFEST])
        try:
            manifest = json.loads(manifest_raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise PackageError("The package's manifest isn't valid JSON.", code="not_a_package")
        if not isinstance(manifest, dict) or manifest.get("format") != PACKAGE_FORMAT:
            raise PackageError("This archive isn't a view package.", code="not_a_package")
        version = manifest.get("formatVersion")
        if not isinstance(version, int) or version < 1:
            raise PackageError("This package has no valid format version.", code="not_a_package")
        if version > PACKAGE_FORMAT_VERSION:
            raise PackageError(
                f"This package was made by a newer version of the platform (format {version}; this one "
                f"reads up to {PACKAGE_FORMAT_VERSION}).", code="newer_format")
        bundle = _read_capped(archive, BUNDLE_PART, caps[BUNDLE_PART])

        fd, data_path = tempfile.mkstemp(suffix=".ndjson")
        digest, size = hashlib.sha256(), 0
        try:
            with os.fdopen(fd, "wb") as out, archive.open(DATA_PART) as source:
                while True:
                    chunk = source.read(_CHUNK)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > limits.MAX_PACKAGE_DATA_BYTES:
                        raise PackageError(
                            f"This package's data unpacks to more than "
                            f"{limits.MAX_PACKAGE_DATA_BYTES // (1024 ** 3)} GB, the most a package can hold.",
                            code="too_large")
                    digest.update(chunk)
                    out.write(chunk)
        except BaseException:
            os.unlink(data_path)
            raise

    declared = manifest.get("parts") if isinstance(manifest.get("parts"), dict) else {}
    found = {BUNDLE_PART: (_sha256(bundle), len(bundle)),
             DATA_PART: (f"{HASH_PREFIX}{digest.hexdigest()}", size)}
    parts = {}
    for name, (sha, nbytes) in found.items():
        claim = declared.get(name) if isinstance(declared.get(name), dict) else {}
        parts[name] = {**claim, "sha256": sha, "bytes": nbytes,
                       "verified": claim.get("sha256") == sha and claim.get("bytes") == nbytes}
    return ParsedPackage(manifest=manifest, bundle=bundle, data_path=data_path, parts=parts)


def _read_capped(archive: zipfile.ZipFile, name: str, cap: int) -> bytes:
    """A part's bytes, never decompressing past ``cap`` whatever the archive declares."""
    with archive.open(name) as source:
        data = source.read(cap + 1)
    if len(data) > cap:
        raise PackageError(f"The package's {name} is larger than it can be.", code="too_large")
    return data


async def prune_uploads(store=None, *, older_than_seconds: int = UPLOAD_TTL_SECONDS) -> int:
    """Drop package uploads older than a day, whether or not their data was imported. A store
    that can't tell an object's age keeps them."""
    if store is None:
        from backend.app.services.storage.object_store import get_object_store
        store = get_object_store()
    prune = getattr(store, "prune_older_than", None)
    return await prune(UPLOADS_PREFIX, older_than_seconds) if callable(prune) else 0


__all__ = [
    "PACKAGE_FORMAT", "PACKAGE_FORMAT_VERSION", "MANIFEST", "BUNDLE_PART", "DATA_PART", "PACKAGE_ARTIFACT",
    "UPLOADS_PREFIX", "UPLOAD_DATA", "UPLOAD_RECORD", "UPLOAD_TTL_SECONDS",
    "PackageError", "ParsedPackage", "assemble", "file_chunks", "finish_export", "prune_uploads", "read_package",
]
