"""The View Package format: a package is assembled around an export's data without holding it in
memory, reads back verified part by part, and says so when a part was changed or doesn't match;
an archive that isn't a package, or that would unpack past the limits, is refused."""
from __future__ import annotations

import io
import json
import os
import zipfile

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.view_transfer import limits, package
from backend.app.services.view_transfer.package import PackageError, assemble, finish_export, read_package

BUNDLE = json.dumps({"format": "view-bundle", "formatVersion": 1, "views": []}).encode()
NDJSON = b"".join(json.dumps({"kind": "node", "entity_id": f"n{i}", "urn": f"urn:n{i}"}).encode() + b"\n"
                  for i in range(5000))


async def _put(store, key, data):
    async def chunks():
        for i in range(0, len(data), 65536):
            yield data[i:i + 65536]
    await store.put_stream(key, chunks())


@pytest.fixture
def store(tmp_path):
    return LocalFsObjectStore(tmp_path / "store")


async def _package(store, tmp_path, **manifest):
    await _put(store, "job/view-bundle.json", BUNDLE)
    await _put(store, "job/export.ndjson", NDJSON)
    out = await assemble(store, bundle_key="job/view-bundle.json", data_key="job/export.ndjson",
                         package_key="job/view-package.zip", manifest={"scope": "view", **manifest})
    path = tmp_path / "copy.zip"
    path.write_bytes(b"".join([c async for c in store.open_stream("job/view-package.zip")]))
    return out, str(path)


async def test_a_package_reads_back_verified(store, tmp_path):
    out, path = await _package(store, tmp_path)
    assert out["manifest"]["format"] == "view-package" and out["bytes"] == os.path.getsize(path)
    parsed = read_package(path)
    try:
        assert parsed.verified
        assert parsed.bundle == BUNDLE
        with open(parsed.data_path, "rb") as data:
            assert data.read() == NDJSON
        assert parsed.parts["data/graph.ndjson"]["bytes"] == len(NDJSON)
        assert parsed.manifest["scope"] == "view"
    finally:
        os.unlink(parsed.data_path)


async def test_the_export_hook_makes_the_package_the_result(store, tmp_path):
    await _put(store, "ws/ds/g/job/view-bundle.json", BUNDLE)
    await _put(store, "ws/ds/g/job/export.ndjson", NDJSON)
    finished = await finish_export(store, "job", "ws/ds/g/job/export.ndjson", {"nodes": 5000, "edges": 0},
                                   package={"fileName": "finance.v7.view-package.zip", "scope": "source",
                                            "dataVersion": "draft", "views": 1, "bundleHash": "sha256:b"})
    assert finished["resultUri"] == "ws/ds/g/job/view-package.zip"
    assert finished["summary"]["package"]["fileName"] == "finance.v7.view-package.zip"
    assert not (await store.stat("ws/ds/g/job/export.ndjson")).exists, "one copy of the data: in the package"
    path = tmp_path / "p.zip"
    path.write_bytes(b"".join([c async for c in store.open_stream(finished["resultUri"])]))
    parsed = read_package(str(path))
    os.unlink(parsed.data_path)
    assert parsed.verified
    assert parsed.manifest["data"] == {"version": "draft", "nodes": 5000, "edges": 0}
    assert parsed.parts["view-bundle.json"]["bundleHash"] == "sha256:b"


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


async def test_a_changed_part_is_noticed(store, tmp_path):
    _, path = await _package(store, tmp_path)
    _rewrite(path, "data/graph.ndjson", NDJSON.replace(b"urn:n1\"", b"urn:X1\""))
    parsed = read_package(path)
    os.unlink(parsed.data_path)
    assert not parsed.verified
    assert parsed.parts["data/graph.ndjson"]["verified"] is False
    assert parsed.parts["view-bundle.json"]["verified"] is True


async def test_a_package_that_unpacks_too_far_is_refused(store, tmp_path, monkeypatch):
    _, path = await _package(store, tmp_path)
    monkeypatch.setattr(limits, "MAX_PACKAGE_DATA_BYTES", 10_000)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    monkeypatch.setattr(package.tempfile, "tempdir", str(scratch))
    with pytest.raises(PackageError) as err:
        read_package(path)
    assert err.value.code == "too_large"
    assert list(scratch.iterdir()) == [], "no half-unpacked data is left behind"


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


async def test_a_package_from_a_newer_platform_is_refused(store, tmp_path):
    _, path = await _package(store, tmp_path)
    with zipfile.ZipFile(path) as z:
        manifest = json.loads(z.read("package.json"))
    _rewrite(path, "package.json", json.dumps({**manifest, "formatVersion": 99}).encode())
    with pytest.raises(PackageError) as err:
        read_package(path)
    assert err.value.code == "newer_format"
