"""The optional S3-compatible object store (``OBJECT_STORE_BACKEND=s3``), call by call against
botocore's Stubber, and what the API does with a store that presigns.

boto3 is optional (``requirements-s3.txt``), so the tests that need it skip without it. The rest
hold either way: the default backends never import boto3, ``s3`` without a bucket or without boto3
says what is missing, a store that serves downloads itself gets the browser redirected there, and a
package's parts go straight to a store that presigns, counted as received like any other.

What the bucket is asked: one PutObject up to 16 MiB, a multipart upload above it (aborted when the
put fails, even when cancelled — while the upload is being made too), ranged reads, HeadObject for stat, one DeleteObject per object (GCS
has no multi-object delete), and listings for the prefix delete, the sweep and the upload prune.
The same behaviours run against a live endpoint in test_object_store.py's contract (and
integration/test_s3_store_minio.py) when ``OBJECT_STORE_S3_TEST_ENDPOINT`` is set.
"""
from __future__ import annotations

import asyncio
import importlib.util
import io
import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest

from backend.app.api.v1.endpoints.graph_export import stored_download
from backend.app.services.storage.object_store import (
    LocalFsObjectStore, ObjectStat, UploadTarget, get_object_store,
)
from backend.tests.test_view_transfer_import import graph  # noqa: F401 — a fixture
from backend.tests.test_view_transfer_packages_api import _TRANSFER, services, small_parts  # noqa: F401

HAVE_BOTO3 = importlib.util.find_spec("boto3") is not None
needs_boto3 = pytest.mark.skipif(not HAVE_BOTO3, reason="boto3 is optional: pip install -r requirements-s3.txt")

MiB = 1 << 20
_REPO = Path(__file__).resolve().parents[2]


async def _chunks(*parts: bytes):
    for p in parts:
        yield p


async def _drain(aiter) -> bytes:
    return b"".join([c async for c in aiter])


def live_store(monkeypatch, *, presign: bool = False):
    """A store on the endpoint ``OBJECT_STORE_S3_TEST_ENDPOINT`` (MinIO: ``docker compose --profile
    s3 up -d minio``), in ``OBJECT_STORE_S3_TEST_BUCKET`` (``synodic``, created if missing), under a
    prefix of its own; the test skips without one."""
    endpoint = os.getenv("OBJECT_STORE_S3_TEST_ENDPOINT")
    if not endpoint or not HAVE_BOTO3:
        pytest.skip("set OBJECT_STORE_S3_TEST_ENDPOINT, with boto3 installed (requirements-s3.txt)")
    from backend.app.services.storage.s3_store import S3ObjectStore

    for name, default in (("AWS_ACCESS_KEY_ID", "minioadmin"), ("AWS_SECRET_ACCESS_KEY", "minioadmin")):
        monkeypatch.setenv(name, os.getenv(name, default))
    bucket = os.getenv("OBJECT_STORE_S3_TEST_BUCKET", "synodic")
    store = S3ObjectStore(bucket, prefix=f"test-{uuid.uuid4().hex}", endpoint_url=endpoint,
                          region=os.getenv("OBJECT_STORE_S3_TEST_REGION", "us-east-1"),
                          addressing="path", presign=presign)
    try:
        store._client.head_bucket(Bucket=bucket)
    except store._errors.ClientError:
        store._client.create_bucket(Bucket=bucket)
    return store


# ── Without boto3 too ────────────────────────────────────────────────────────


def test_the_default_backends_never_import_boto3():
    """A fresh interpreter, so nothing another test imported counts: the database and LocalFs
    stores are built without boto3 being loaded, installed or not."""
    code = ("import os, sys\n"
            "from backend.app.services.storage.object_store import get_object_store\n"
            "os.environ.pop('OBJECT_STORE_BACKEND', None)\n"
            "get_object_store()\n"
            "os.environ['OBJECT_STORE_BACKEND'] = 'local'\n"
            "get_object_store()\n"
            "assert 'boto3' not in sys.modules and 'botocore' not in sys.modules, 'boto3 was imported'\n")
    env = {**os.environ, "PYTHONPATH": os.pathsep.join(filter(None, [str(_REPO), os.getenv("PYTHONPATH")]))}
    env.setdefault("JWT_SECRET_KEY", "test-only-jwt-secret-key-not-for-production-use")
    done = subprocess.run([sys.executable, "-c", code], cwd=_REPO, env=env, capture_output=True, text=True,
                          timeout=120)
    assert done.returncode == 0, done.stderr


def test_s3_says_what_is_missing(monkeypatch):
    from backend.app.services.storage import s3_store

    monkeypatch.setenv("OBJECT_STORE_BACKEND", "s3")
    monkeypatch.delenv("OBJECT_STORE_S3_BUCKET", raising=False)
    with pytest.raises(RuntimeError, match="OBJECT_STORE_S3_BUCKET"):
        get_object_store()

    monkeypatch.setenv("OBJECT_STORE_S3_BUCKET", "artifacts")
    monkeypatch.setitem(sys.modules, "boto3", None)          # as in the default image
    monkeypatch.setitem(sys.modules, "boto3.session", None)
    s3_store.shared.cache_clear()
    with pytest.raises(RuntimeError, match="requirements-s3.txt"):
        get_object_store()
    s3_store.shared.cache_clear()

    monkeypatch.setenv("OBJECT_STORE_BACKEND", "gcs")
    with pytest.raises(NotImplementedError, match="'s3'"):
        get_object_store()


async def test_a_store_that_serves_downloads_itself_gets_the_browser_redirected(tmp_path):
    asked = []

    class _Serves:
        def download_url(self, key, *, filename):
            asked.append((key, filename))
            return f"https://bucket.example/{key}?signed"

        def open_stream(self, *a, **k):
            raise AssertionError("no API worker streams a file the store serves")

    async def download(store, key, range_header=None):
        return await stored_download(store, key, size=10, etag='"j-10"', modified=None, filename="v.view-package.zip",
                               media_type="application/zip", range_header=range_header, if_range=None)

    moved = await download(_Serves(), "ws/ds/g/j/export.zip", "bytes=4-")
    assert moved.status_code == 307, "the browser asks the bucket again, its Range included"
    assert moved.headers["location"] == "https://bucket.example/ws/ds/g/j/export.zip?signed"
    assert asked == [("ws/ds/g/j/export.zip", "v.view-package.zip")]

    class _Declines(_Serves):
        def download_url(self, key, *, filename):
            return None                                       # presigning off

        async def open_stream(self, key, *, start=0, chunk_size=1 << 20):
            yield b"0123456789"[start:]

    assert (await download(_Declines(), "k", "bytes=4-")).status_code == 206
    assert (await download(LocalFsObjectStore(tmp_path), "k")).status_code == 200, "a store with no URLs streams"


class _Presigning(LocalFsObjectStore):
    """A store that hands out presigned part URLs; what lands at them is a put like any other."""

    def upload_target(self, key, *, size=None):
        return UploadTarget(key=key, mode="presigned", url=f"https://bucket.example/{key}?size={size}")


@pytest.mark.usefixtures("view_portability_enabled")
async def test_package_parts_go_straight_to_a_store_that_presigns(
        test_client, db_session, graph, services, small_parts, tmp_path):  # noqa: F811
    _, jobs = services
    jobs.store = _Presigning(tmp_path / "store")
    raw = bytes(range(256)) * 10                               # parts of 1024, 1024 and 512 bytes

    created = await test_client.post(f"{_TRANSFER}/packages/uploads", json={"fileName": "p.zip", "size": len(raw)})
    assert created.status_code == 201, created.text
    up = created.json()
    folder = f"transfer-uploads/{up['uploadId']}"
    assert up["partUrls"] == [f"https://bucket.example/{folder}/part-0000{n}?size={size}"
                              for n, size in enumerate((1024, 1024, 512))], "each signed for its exact size"

    for n in (0, 2):                                           # the browser's PUTs, as they land
        await jobs.store.put_stream(f"{folder}/part-0000{n}", _chunks(raw[n * 1024:(n + 1) * 1024]))
    url = f"{_TRANSFER}/packages/uploads/{up['uploadId']}"
    resumed = (await test_client.get(url)).json()
    assert resumed["received"] == [0, 2] and resumed["partUrls"] == up["partUrls"]
    early = await test_client.post(f"{url}/complete")
    assert early.status_code == 409 and early.json()["detail"]["missing"] == [1]

    await jobs.store.put_stream(f"{folder}/part-00001", _chunks(raw[1024:2048]))
    assert (await test_client.post(f"{url}/complete")).status_code == 202
    checking = (await test_client.get(url)).json()
    assert checking["status"] == "inspecting" and "partUrls" not in checking, \
        "what is checked is what is imported: no more URLs to change a part"


@pytest.mark.usefixtures("view_portability_enabled")
async def test_parts_go_through_the_api_when_the_store_does_not_presign(
        test_client, db_session, graph, services):  # noqa: F811
    created = await test_client.post(f"{_TRANSFER}/packages/uploads", json={"fileName": "p.zip", "size": 10})
    assert created.status_code == 201 and "partUrls" not in created.json()


# ── Against the Stubber ──────────────────────────────────────────────────────


@pytest.fixture
def stubbed(monkeypatch):
    """A store on a stubbed client: every call it makes must be the next one expected."""
    from botocore.stub import Stubber

    from backend.app.services.storage.s3_store import S3ObjectStore

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    store = S3ObjectStore("bkt", prefix="/pre/", endpoint_url="https://s3.example.test", region="us-east-1",
                          addressing="path")
    with Stubber(store._client) as stub:
        yield store, stub
        stub.assert_no_pending_responses()


def _at(**ago):
    return datetime.now(timezone.utc) - timedelta(**ago)


def _listed(*objects):
    return {"IsTruncated": False, "Contents": [
        {"Key": key, "LastModified": when, "Size": 1, "ETag": '"e"'} for key, when in objects]}


@needs_boto3
def test_the_client_is_configured_for_s3_and_gcs_alike(monkeypatch):
    from backend.app.services.storage.s3_store import S3ObjectStore

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    config = S3ObjectStore("bkt", region="auto", endpoint_url="https://storage.googleapis.com",
                           addressing="path")._client.meta.config
    assert config.signature_version == "s3v4"
    assert config.retries == {"mode": "standard", "total_max_attempts": 6}, "5 retries after the first try"
    assert config.request_checksum_calculation == "when_required", "GCS refuses the default CRC32 checksums"
    assert config.s3["addressing_style"] == "path"


@needs_boto3
async def test_a_small_put_is_one_put_object(stubbed):
    store, stub = stubbed
    stub.add_response("put_object", {"ETag": '"e"'}, {"Bucket": "bkt", "Key": "pre/ws/j/a.ndjson", "Body": b"ab"})
    assert await store.put_stream("ws/j/a.ndjson", _chunks(b"a", b"b")) == \
        ObjectStat(key="ws/j/a.ndjson", size=2, exists=True)


@needs_boto3
async def test_a_put_of_one_api_part_is_one_put_object(stubbed):
    store, stub = stubbed
    data = b"p" * (16 * MiB)                # what a package part sent through the API is
    stub.add_response("put_object", {"ETag": '"e"'}, {"Bucket": "bkt", "Key": "pre/up/part-00000", "Body": data})
    assert (await store.put_stream("up/part-00000", _chunks(data[:MiB], data[MiB:]))).size == 16 * MiB


@needs_boto3
async def test_a_large_put_goes_up_in_parts_of_just_over_16_mib(stubbed):
    store, stub = stubbed
    data = bytes(range(256)) * (32 * MiB // 256) + b"end"
    key = {"Bucket": "bkt", "Key": "pre/ws/j/export.zip"}
    stub.add_response("create_multipart_upload", {"UploadId": "u1"}, key)
    # Arriving 3 MiB at a time, a part goes once more than 16 MiB is held: 18 MiB, then the rest.
    for n, part in enumerate((data[:18 * MiB], data[18 * MiB:]), start=1):
        stub.add_response("upload_part", {"ETag": f'"e{n}"'}, {**key, "UploadId": "u1", "PartNumber": n, "Body": part})
    stub.add_response("complete_multipart_upload", {}, {**key, "UploadId": "u1", "MultipartUpload": {"Parts": [
        {"PartNumber": 1, "ETag": '"e1"'}, {"PartNumber": 2, "ETag": '"e2"'}]}})

    async def uneven():                     # arriving in pieces that straddle the part boundaries
        for i in range(0, len(data), 3 * MiB):
            yield data[i:i + 3 * MiB]

    assert (await store.put_stream("ws/j/export.zip", uneven())).size == len(data)


@needs_boto3
async def test_a_failed_multipart_put_is_aborted(stubbed):
    store, stub = stubbed
    key = {"Bucket": "bkt", "Key": "pre/ws/j/export.zip"}
    stub.add_response("create_multipart_upload", {"UploadId": "u1"}, key)
    stub.add_response("upload_part", {"ETag": '"e1"'})
    stub.add_response("abort_multipart_upload", {}, {**key, "UploadId": "u1"})

    async def broken():
        yield b"x" * (16 * MiB + 1)
        raise RuntimeError("the job lost its lease")

    with pytest.raises(RuntimeError, match="lease"):
        await store.put_stream("ws/j/export.zip", broken())


@needs_boto3
async def test_a_cancelled_multipart_put_is_still_aborted(stubbed):
    store, stub = stubbed
    stub.add_response("create_multipart_upload", {"UploadId": "u1"})
    stub.add_response("upload_part", {"ETag": '"e1"'})
    stub.add_response("abort_multipart_upload", {}, {"Bucket": "bkt", "Key": "pre/ws/j/export.zip", "UploadId": "u1"})
    first_part_in = asyncio.Event()

    async def stalls():
        yield b"x" * (16 * MiB + 1)
        first_part_in.set()
        await asyncio.Event().wait()

    put = asyncio.create_task(store.put_stream("ws/j/export.zip", stalls()))
    await first_part_in.wait()
    put.cancel()
    with pytest.raises(asyncio.CancelledError):
        await put


@needs_boto3
async def test_a_put_cancelled_while_its_upload_is_made_still_aborts_it(stubbed):
    import threading

    store, stub = stubbed
    stub.add_response("abort_multipart_upload", {}, {"Bucket": "bkt", "Key": "pre/ws/j/export.zip", "UploadId": "u1"})
    asked, made = threading.Event(), threading.Event()

    def create_multipart_upload(**_kw):     # the bucket answers after the put was cancelled
        asked.set()
        made.wait(5)
        return {"UploadId": "u1"}

    store._client.create_multipart_upload = create_multipart_upload

    async def big():
        yield b"x" * (16 * MiB + 1)

    put = asyncio.create_task(store.put_stream("ws/j/export.zip", big()))
    await asyncio.to_thread(asked.wait, 5)
    put.cancel()
    await asyncio.sleep(0)
    made.set()
    with pytest.raises(asyncio.CancelledError):
        await put


@needs_boto3
async def test_reads_take_a_range_from_any_offset(stubbed):
    from botocore.response import StreamingBody

    store, stub = stubbed
    data = bytes(range(256)) * 40

    def body(part: bytes):
        return {"Body": StreamingBody(io.BytesIO(part), len(part)), "ContentLength": len(part)}

    key = {"Bucket": "bkt", "Key": "pre/ws/j/export.ndjson"}
    stub.add_response("get_object", body(data), key)
    stub.add_response("get_object", body(data[1000:]), {**key, "Range": "bytes=1000-"})
    stub.add_client_error("get_object", "InvalidRange", http_status_code=416,
                          expected_params={**key, "Range": f"bytes={len(data)}-"})
    stub.add_client_error("get_object", "NoSuchKey", http_status_code=404,
                          expected_params={"Bucket": "bkt", "Key": "pre/ws/j/missing"})

    pieces = [c async for c in store.open_stream("ws/j/export.ndjson", chunk_size=4000)]
    assert b"".join(pieces) == data and max(map(len, pieces)) <= 4000
    assert await _drain(store.open_stream("ws/j/export.ndjson", start=1000)) == data[1000:]
    assert await _drain(store.open_stream("ws/j/export.ndjson", start=len(data))) == b"", "past the end: nothing"
    with pytest.raises(FileNotFoundError):
        await _drain(store.open_stream("ws/j/missing"))


@needs_boto3
async def test_stat_and_delete(stubbed):
    store, stub = stubbed
    stub.add_response("head_object", {"ContentLength": 42}, {"Bucket": "bkt", "Key": "pre/ws/j/a"})
    stub.add_client_error("head_object", "404", http_status_code=404)
    stub.add_response("delete_object", {}, {"Bucket": "bkt", "Key": "pre/ws/j/a"})
    stub.add_client_error("delete_object", "NoSuchKey", http_status_code=404)   # GCS: already gone

    assert await store.stat("ws/j/a") == ObjectStat(key="ws/j/a", size=42, exists=True)
    assert await store.stat("ws/j/b") == ObjectStat(key="ws/j/b", size=0, exists=False)
    await store.delete("ws/j/a")
    await store.delete("ws/j/b")


@needs_boto3
async def test_delete_prefix_deletes_each_object_under_the_folder_page_by_page(stubbed):
    store, stub = stubbed
    listing = {"Bucket": "bkt", "Prefix": "pre/ws/g/job_1/"}
    stub.add_response("list_objects", {**_listed(("pre/ws/g/job_1/a", _at())), "IsTruncated": True}, listing)
    stub.add_response("delete_object", {}, {"Bucket": "bkt", "Key": "pre/ws/g/job_1/a"})
    stub.add_response("list_objects", _listed(("pre/ws/g/job_1/b", _at())), {**listing, "Marker": "pre/ws/g/job_1/a"})
    stub.add_response("delete_object", {}, {"Bucket": "bkt", "Key": "pre/ws/g/job_1/b"})
    await store.delete_prefix("ws/g/job_1/")


@needs_boto3
async def test_the_sweep_deletes_what_is_old_but_keeps_inputs_jobs_still_read(stubbed):
    store, stub = stubbed
    stub.add_response("list_objects", _listed(
        ("pre/ws/ds/g/j1/export.zip", _at(days=2)),
        ("pre/ws/ds/g/j2/export.zip", _at(minutes=5)),
        ("pre/transfer-uploads/up_1/part-00000", _at(days=2)),      # a running import reads it
        ("pre/transfer-uploads/up_10/part-00000", _at(days=2)),     # only shares the pin's name
    ), {"Bucket": "bkt", "Prefix": "pre/"})
    stub.add_response("delete_object", {}, {"Bucket": "bkt", "Key": "pre/ws/ds/g/j1/export.zip"})
    stub.add_response("delete_object", {}, {"Bucket": "bkt", "Key": "pre/transfer-uploads/up_10/part-00000"})
    assert await store.sweep(older_than_hours=24, keep_prefixes={"transfer-uploads/up_1"}) == 2


@needs_boto3
async def test_prune_drops_old_uploads_whole_by_their_newest_object(stubbed):
    store, stub = stubbed
    stub.add_response("list_objects", _listed(
        ("pre/transfer-uploads/up_a/part-00000", _at(days=3)),
        ("pre/transfer-uploads/up_a/upload.json", _at(days=2)),
        ("pre/transfer-uploads/up_b/part-00000", _at(days=3)),
        ("pre/transfer-uploads/up_b/inspect.json", _at(minutes=1)),  # checked a minute ago: kept
        ("pre/transfer-uploads/up_c/part-00000", _at(days=3)),       # pinned by a job
    ), {"Bucket": "bkt", "Prefix": "pre/transfer-uploads/"})
    stub.add_response("delete_object", {}, {"Bucket": "bkt", "Key": "pre/transfer-uploads/up_a/part-00000"})
    stub.add_response("delete_object", {}, {"Bucket": "bkt", "Key": "pre/transfer-uploads/up_a/upload.json"})
    assert await store.prune_older_than("transfer-uploads", 24 * 3600,
                                        keep_prefixes={"transfer-uploads/up_c"}) == 1


@needs_boto3
async def test_prune_uploads_reaches_the_s3_store(stubbed):
    """``view_transfer.package.prune_uploads`` prunes only a store that can tell an upload's age."""
    from backend.app.services.view_transfer.package import prune_uploads

    store, stub = stubbed
    stub.add_response("list_objects", _listed(), {"Bucket": "bkt", "Prefix": "pre/transfer-uploads/"})
    assert await prune_uploads(store, keep_prefixes=()) == 0


@needs_boto3
def test_keys_never_climb_out_of_the_prefix(stubbed):
    store, _ = stubbed
    for key in ("../other/x", "ws/../../x", "/abs", "ws/./x"):
        with pytest.raises(ValueError):
            store.upload_target(key)


@needs_boto3
def test_presigned_urls_only_when_asked_for(monkeypatch):
    from backend.app.services.storage.s3_store import S3ObjectStore

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    settings = dict(prefix="pre", endpoint_url="https://s3.example.test", region="us-east-1", addressing="path")

    plain = S3ObjectStore("bkt", **settings)
    assert plain.upload_target("transfer-uploads/up_1/part-00000") == \
        UploadTarget(key="transfer-uploads/up_1/part-00000", mode="backend", url=None)
    assert plain.download_url("ws/j/export.zip", filename="x.zip") is None

    signing = S3ObjectStore("bkt", presign=True, **settings)
    target = signing.upload_target("transfer-uploads/up_1/part-00003", size=1234)
    assert target.mode == "presigned"
    put = urlparse(target.url)
    assert put.path == "/bkt/pre/transfer-uploads/up_1/part-00003"
    query = parse_qs(put.query)
    assert query["X-Amz-SignedHeaders"] == ["content-length;host"], "the part's length is signed"
    assert query["X-Amz-Expires"] == ["86400"], "good for as long as an upload is kept"
    assert not any(k.lower().startswith("x-amz-checksum") or k.lower() == "x-amz-sdk-checksum-algorithm"
                   for k in query), "nothing a browser's PUT would have to add"

    get = urlparse(signing.download_url("ws/j/export.zip", filename="x.view-package.zip"))
    assert get.path == "/bkt/pre/ws/j/export.zip"
    assert parse_qs(get.query)["response-content-disposition"] == ['attachment; filename="x.view-package.zip"']
    assert parse_qs(get.query)["X-Amz-Expires"] == ["3600"]


@needs_boto3
def test_get_object_store_builds_one_s3_store_per_configuration(monkeypatch):
    from backend.app.services.storage import s3_store

    monkeypatch.setenv("AWS_ACCESS_KEY_ID", "testing")
    monkeypatch.setenv("AWS_SECRET_ACCESS_KEY", "testing")
    monkeypatch.setenv("OBJECT_STORE_BACKEND", "s3")
    monkeypatch.setenv("OBJECT_STORE_S3_BUCKET", "artifacts")
    monkeypatch.setenv("OBJECT_STORE_S3_ENDPOINT_URL", "http://minio:9000")
    monkeypatch.setenv("OBJECT_STORE_S3_ADDRESSING", "path")
    s3_store.shared.cache_clear()
    try:
        store = get_object_store()
        assert isinstance(store, s3_store.S3ObjectStore) and get_object_store() is store
        assert (store._bucket, store._prefix, store._presign) == ("artifacts", "synodic-import-store/", False), \
            "by default every key is under a prefix of the store's own, which the sweep keeps to"
        monkeypatch.setenv("OBJECT_STORE_S3_PREFIX", "/")
        assert get_object_store() is store, "never the bucket's root: the sweep would empty it"
        monkeypatch.setenv("OBJECT_STORE_S3_PRESIGN", "1")
        assert get_object_store() is not store and get_object_store()._presign is True
    finally:
        s3_store.shared.cache_clear()
