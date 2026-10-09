"""The View Package format: written in one streaming pass, read back verified, checked on upload.

Pins: the export job writes the package once — the views' file, then the data deflated into a zip64
part as it streams — to its attempt's own key, and never reads anything back from the store; the
manifest says what the data holds (per kind, per type, per part with its checksum); reading one
verifies each part streaming, says when a part was changed or doesn't match, counts the types of a
package whose manifest didn't (formats 1 and 2 alike), and refuses an archive that isn't a package,
would unpack past the limits, or comes from a newer platform. An uploaded package is checked by its
inspect job: what it found waits beside the upload, and the upload's record names the data part its
imports read — or why it can't be imported.
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import struct
import zipfile
from types import SimpleNamespace

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning import db as ver_db
from backend.app.services.versioning.import_export import snapshot, stream, uploads
from backend.app.services.versioning.import_export.export_worker import ExportWorker
from backend.app.services.view_transfer import limits, package
from backend.app.services.view_transfer.bundle import assemble_bundle
from backend.app.services.view_transfer.canonical import content_hash, portable_definition
from backend.app.services.view_transfer.package import (
    DATA_PART, PackageError, PackageExport, read_package, write_package,
)
from backend.tests.test_export_native_lines import _Snap, edge, node


def _bundle() -> bytes:
    definition = portable_definition({"layout": {"type": "reference", "referenceLayout": {"layers": []}}}, "graph")
    view = {"source": "s1", "portableId": "pv_1", "version": 3, "definitionHash": content_hash(definition),
            "metadata": {"name": "Finance lineage"}, "definition": definition}
    return json.dumps(assemble_bundle(views=[view], sources={"s1": {"ontology": {"id": "bp_1"}}},
                                      exported_by=None, product=None, environment="dev")).encode()


BUNDLE = _bundle()
NDJSON = b"".join(json.dumps({"kind": "node", "entity_id": f"n{i}", "urn": f"urn:n{i}",
                              "entityType": "Table" if i % 2 else "Column"}).encode() + b"\n"
                  for i in range(5000))


async def _chunks(data: bytes, size: int = 65536):
    for i in range(0, len(data), size):
        yield data[i:i + size]


async def _package(tmp_path, content: bytes = NDJSON, **manifest) -> str:
    """A package of ``content``, written as the export job writes one; its path."""
    def manifest_of(found):
        return {"format": "view-package", "formatVersion": 1, "scope": "view",
                "parts": {"view-bundle.json": {"views": 1, **found["view-bundle.json"]},
                          DATA_PART: found[DATA_PART]}, **manifest}

    path = tmp_path / "p.zip"
    path.write_bytes(b"".join([c async for c in write_package(BUNDLE, _chunks(content), manifest_of)]))
    return str(path)


def _zip64_local_header(path: str, name: str) -> bool:
    """Whether ``name``'s local header carries the zip64 extra field (no 4 GB limit on the part)."""
    with zipfile.ZipFile(path) as z:
        offset = z.getinfo(name).header_offset
    with open(path, "rb") as f:
        f.seek(offset)
        head = f.read(30)
        name_len, extra_len = struct.unpack("<HH", head[26:30])
        f.seek(offset + 30 + name_len)
        extra = f.read(extra_len)
    return extra[:2] == b"\x01\x00"


async def test_a_package_written_as_it_streams_reads_back_verified(tmp_path):
    path = await _package(tmp_path)
    assert _zip64_local_header(path, DATA_PART)
    parsed = read_package(path)
    assert parsed.verified and parsed.bundle == BUNDLE
    assert parsed.parts[DATA_PART]["bytes"] == len(NDJSON)
    assert parsed.manifest["scope"] == "view"
    assert not hasattr(parsed, "data_path"), "the data is checked streaming, never unpacked to disk"
    assert parsed.type_stats == {"nodeCount": 5000, "edgeCount": 0,
                                 "entityTypeCounts": {"Column": 2500, "Table": 2500}, "edgeTypeCounts": {}}, \
        "a manifest without typeStats: counted from the data as it was checked"


async def test_a_format_2_package_reads_and_a_newer_one_is_refused(tmp_path):
    native = b"".join(json.dumps({"kind": k, "entity_id": f"x{i}", "payload": p}).encode() + b"\n"
                      for i, (k, p) in enumerate([("node", {"entityType": "Table"}),
                                                  ("edge", {"edgeType": "PRODUCES"})]))
    stats = {"nodeCount": 9, "edgeCount": 9, "entityTypeCounts": {"X": 9}, "edgeTypeCounts": {"Y": 9}}
    parsed = read_package(await _package(tmp_path, native, formatVersion=2))
    assert parsed.verified and parsed.manifest["formatVersion"] == 2
    assert parsed.type_stats == {"nodeCount": 1, "edgeCount": 1, "entityTypeCounts": {"Table": 1},
                                 "edgeTypeCounts": {"PRODUCES": 1}}, "format 2 counts types from the payloads"
    declared = read_package(await _package(tmp_path, native, formatVersion=2, data={"typeStats": stats}))
    assert declared.type_stats == stats, "the manifest's own count, when it has one"

    with pytest.raises(PackageError) as err:
        read_package(await _package(tmp_path, formatVersion=package.READ_FORMAT_VERSION + 1))
    assert err.value.code == "newer_format"
    assert package.PACKAGE_FORMAT_VERSION == 1, "this release still writes format 1"


async def test_the_export_job_writes_the_package_once_to_its_attempts_own_key(tmp_path, monkeypatch):
    """No store read, one store write: the package goes to this attempt's key (epoch 2), with the
    views first, the data streamed into it, and a manifest of both."""
    nodes = [node("n1", {"urn": "urn:a", "entityType": "Table", "qualifiedName": "db.a"}),
             node("n2", {"urn": "urn:b", "entityType": "Table"})]
    edges = [edge("e1", "n1", "n2")]
    row = SimpleNamespace(graph_id="g1", import_format="ndjson", as_of_seq=7, branch_id=None,
                          result_uri="ws1/ds1/g1/vjob_1/export.ndjson", summary={})

    @contextlib.asynccontextmanager
    async def session():
        yield SimpleNamespace(get=_returning(row))

    async def open_snapshot(**kwargs):
        assert kwargs["as_of_seq"] == 7, "published data, pinned when the package was asked for"
        return _Snap(nodes, edges)

    monkeypatch.setattr(ver_db, "graphver_session", session)
    monkeypatch.setattr(snapshot, "open_snapshot", open_snapshot)

    class _Store(LocalFsObjectStore):
        def __init__(self, root):
            super().__init__(root)
            self.puts, self.reads = [], 0

        async def put_stream(self, key, chunks):
            self.puts.append(key)
            return await super().put_stream(key, chunks)

        def open_stream(self, key, **kw):
            self.reads += 1
            return super().open_stream(key, **kw)

    class _Lease:
        epoch = 2
        finished = None

        def check(self):
            pass

        async def finish(self, status="completed", **values):
            self.finished = (status, values)
            return True

    store, lease = _Store(tmp_path / "store"), _Lease()
    pkg = PackageExport({"fileName": "finance.v3.view-package.zip", "scope": "source", "dataVersion": "published",
                         "views": [{"viewId": "view_1", "version": 3}]}, workspace_id="ws1", data_source_id="ds1")
    pkg._bundle, pkg._bundle_hash = BUNDLE, "sha256:bundle"          # its views, built (phase 'bundle')
    summary = await ExportWorker(None, store, package=pkg).run("vjob_1", lease=lease)

    key = "ws1/ds1/g1/vjob_1/view-package-e2.zip"
    assert store.puts == [key] and store.reads == 0
    assert lease.finished == ("completed", {"summary": summary, "result_uri": key})
    assert summary["package"] == {"fileName": "finance.v3.view-package.zip", "bytes": summary["bytes"],
                                  "bundleHash": "sha256:bundle"}
    parsed = read_package(str(tmp_path / "store" / key))
    assert parsed.verified and parsed.bundle == BUNDLE
    assert parsed.manifest["data"] == {
        "version": "published", "nodes": 2, "edges": 1,
        "typeStats": {"nodeCount": 2, "edgeCount": 1, "entityTypeCounts": {"Table": 2},
                      "edgeTypeCounts": {"PRODUCES": 1}}}
    assert parsed.parts[DATA_PART]["nodes"] == 2 and parsed.parts[DATA_PART]["edges"] == 1
    assert parsed.parts["view-bundle.json"]["views"] == 1
    with zipfile.ZipFile(str(tmp_path / "store" / key)) as z:
        lines = [json.loads(line) for line in z.read(DATA_PART).splitlines()]
    assert [(r["kind"], r["entity_id"]) for r in lines] == [("node", "n1"), ("node", "n2"), ("edge", "e1")]
    assert lines[2]["sourceUrn"] == "urn:a", "format 1: the data source's own export records"


def _returning(value):
    async def get(*_args, **_kwargs):
        return value
    return get


def _rewrite(path, name, data):
    """The package at ``path`` with one part replaced, as someone editing it by hand would."""
    with zipfile.ZipFile(path) as src:
        parts = {n: src.read(n) for n in src.namelist()}
    parts[name] = data
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as dst:
        for n, d in parts.items():
            dst.writestr(n, d)
    with open(path, "wb") as f:
        f.write(buf.getvalue())


async def test_a_changed_part_is_noticed(tmp_path):
    path = await _package(tmp_path)
    _rewrite(path, DATA_PART, NDJSON.replace(b"urn:n1\"", b"urn:X1\""))
    parsed = read_package(path)
    assert not parsed.verified
    assert parsed.parts[DATA_PART]["verified"] is False
    assert parsed.parts["view-bundle.json"]["verified"] is True


async def test_a_package_that_unpacks_too_far_is_refused(tmp_path, monkeypatch):
    path = await _package(tmp_path)
    monkeypatch.setattr(limits, "MAX_PACKAGE_DATA_BYTES", 10_000)
    with pytest.raises(PackageError) as err:
        read_package(path)
    assert err.value.code == "too_large"


def test_a_package_may_unpack_to_as_much_as_an_export_writes():
    assert limits.MAX_PACKAGE_DATA_BYTES == stream.MAX_BYTES


async def test_a_damaged_part_is_refused_not_failed_on(tmp_path):
    path = await _package(tmp_path)
    with zipfile.ZipFile(path) as z:
        info = z.getinfo(DATA_PART)
    with open(path, "r+b") as f:
        f.seek(info.header_offset + 30 + len(DATA_PART) + 20 + info.compress_size // 2)
        byte = f.read(1)
        f.seek(-1, os.SEEK_CUR)
        f.write(bytes([byte[0] ^ 0xFF]))                   # a flipped byte inside the deflated data
    with pytest.raises(PackageError) as err:
        read_package(path)
    assert err.value.code == "not_a_package"


def test_an_archive_that_is_not_a_package_is_refused(tmp_path):
    path = tmp_path / "other.zip"
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("readme.txt", "hello")
    with pytest.raises(PackageError) as err:
        read_package(str(path))
    assert err.value.code == "not_a_package"

    broken = tmp_path / "broken.zip"
    broken.write_bytes(b"PK\x03\x04 not really a zip")
    with pytest.raises(PackageError):
        read_package(str(broken))


@pytest.mark.parametrize("flag, method", [(1, None), (None, 99)], ids=["encrypted", "unknown-method"])
async def test_a_part_zipfile_will_not_read_is_refused_not_failed_on(tmp_path, flag, method):
    """An encrypted part, or one packed with a method zipfile lacks, is a verdict on the file —
    not a check that broke and is worth queueing again."""
    path = await _package(tmp_path)
    with zipfile.ZipFile(path) as z:
        offset = z.getinfo(DATA_PART).header_offset
    with open(path, "r+b") as f:
        raw = bytearray(f.read())
        central = raw.find(b"PK\x01\x02")
        while struct.unpack_from("<I", raw, central + 42)[0] != offset:   # the data part's entry
            central = raw.find(b"PK\x01\x02", central + 4)
        if flag:
            struct.pack_into("<H", raw, central + 8, struct.unpack_from("<H", raw, central + 8)[0] | flag)
        if method:
            struct.pack_into("<H", raw, central + 10, method)
        f.seek(0)
        f.write(raw)
    with pytest.raises(PackageError) as err:
        read_package(path)
    assert err.value.code == "not_a_package"


# ── Checking an upload ───────────────────────────────────────────────────────


async def _uploaded(store, raw: bytes):
    record = await uploads.create_package(store, owner="u1", file_name="p.zip", size=len(raw))
    for n in range(record["parts"]):
        start = n * record["partBytes"]
        await uploads.put_part(store, record, n, _chunks(raw[start:start + uploads.part_size(record, n)]))
    return record


async def _read(store, key):
    return b"".join([c async for c in store.open_stream(key)])


@pytest.fixture
def scratch(tmp_path, monkeypatch):
    """Where temporary files go, to see none is left behind."""
    path = tmp_path / "tmp"
    path.mkdir()
    monkeypatch.setattr("tempfile.tempdir", str(path))
    return path


async def test_an_uploaded_package_is_checked_and_its_data_read_where_it_is(tmp_path, monkeypatch, scratch):
    monkeypatch.setattr(uploads, "PART_BYTES", 4096)
    store = LocalFsObjectStore(tmp_path / "store")
    with open(await _package(tmp_path), "rb") as f:
        raw = f.read()
    record = await _uploaded(store, raw)
    phases = []

    async def phase(name, **values):
        phases.append((name, values.get("processed"), values.get("total")))

    summary = await package.inspect_upload(store, uploads.record_key(record), phase)
    assert summary == {"views": 1, "integrity": "verified", "bytes": len(NDJSON)}
    assert phases[-1] == ("verify", None, None)
    assert phases[:-1] == [("spool", n, record["parts"]) for n in range(record["parts"] + 1)], \
        "progress counted in parts (a job's counts are 32-bit; a package's bytes aren't)"
    assert list(scratch.iterdir()) == [], "the spool is gone"

    checked = json.loads(await _read(store, uploads.record_key(record)))
    assert checked["views"] == ["Finance lineage"]
    assert checked["archive"]["member"] == DATA_PART and checked["archive"]["bytes"] == len(NDJSON)
    inspection = json.loads(await _read(store, uploads.upload_key(record, package.INSPECTION)))
    assert inspection["package"]["integrity"] == "verified"
    assert inspection["package"]["data"]["typeStats"]["nodeCount"] == 5000
    assert await _read(store, uploads.upload_key(record, package.UPLOAD_BUNDLE)) == BUNDLE

    data = b"".join([c async for c in uploads.open_source(store, uploads.record_key(record))])
    assert data == NDJSON, "the data part, inflated out of the uploaded parts"
    assert list(scratch.iterdir()) == []


@pytest.mark.parametrize("raw, code", [
    (b'{"format": "view-bundle"}', "view_file"),
    (b"PK\x03\x04 not really a zip", "not_a_package"),
])
async def test_a_file_that_is_no_package_is_answered_not_failed(tmp_path, raw, code):
    store = LocalFsObjectStore(tmp_path / "store")
    record = await _uploaded(store, raw)
    summary = await package.inspect_upload(store, uploads.record_key(record))
    assert summary["invalid"]["code"] == code
    checked = json.loads(await _read(store, uploads.record_key(record)))
    assert checked["error"]["code"] == code and "archive" not in checked


async def test_day_old_uploads_are_pruned_unless_a_job_still_reads_them(tmp_path):
    import time

    store = LocalFsObjectStore(tmp_path / "store")

    async def one():
        yield b"{}"
    for upload in ("up_old", "up_pinned", "up_new"):
        await store.put_stream(f"transfer-uploads/{upload}/upload.json", one())
    past = time.time() - 2 * 86_400
    for upload in ("up_old", "up_pinned"):
        os.utime(tmp_path / "store" / "transfer-uploads" / upload, (past, past))
    assert await package.prune_uploads(store, keep_prefixes={"transfer-uploads/up_pinned"}) == 1
    assert sorted(p.name for p in (tmp_path / "store" / "transfer-uploads").iterdir()) == ["up_new", "up_pinned"]
