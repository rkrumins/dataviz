"""The optional S3 store against a live S3-compatible endpoint: opt-in, skipped unless
``OBJECT_STORE_S3_TEST_ENDPOINT`` is set (with boto3 installed)::

    pip install -r backend/requirements-s3.txt && docker compose --profile s3 up -d minio
    OBJECT_STORE_S3_TEST_ENDPOINT=http://localhost:9000 python -m pytest -q tests/integration/test_s3_store_minio.py

What a stub can't show: a multipart put whose parts the bucket really joins, ranged reads across a
part boundary, a failed put that leaves no incomplete upload behind, and presigned URLs a client
without this site's cookies uses as they are: a part PUT signed for its exact length, a download
saved under its name. The contract every store keeps runs against the same endpoint in
test_object_store.py.
"""
from __future__ import annotations

import hashlib
import urllib.error
import urllib.request

import pytest

from backend.tests.test_s3_object_store import live_store

MiB = 1 << 20


async def _chunks(*parts: bytes):
    for p in parts:
        yield p


def _http(method: str, url: str, body: bytes = None):
    """``(status, headers, body)`` of a bare request, as a browser's to a presigned URL (whose
    file slice carries no form type, which urllib would otherwise add)."""
    request = urllib.request.Request(url, data=body, method=method,
                                     headers={"Content-Type": "application/octet-stream"} if body else {})
    try:
        with urllib.request.urlopen(request, timeout=60) as resp:
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as err:
        return err.code, err.headers, err.read()


async def test_a_multipart_put_is_joined_and_read_from_any_offset(monkeypatch):
    store = live_store(monkeypatch)
    try:
        data = bytes(range(251)) * (33 * MiB // 251) + b"tail"       # three parts: 16, 16 and ~1 MiB
        key = "ws/ds/g/job1/export.zip"

        async def uneven():
            for i in range(0, len(data), 5 * MiB):
                yield data[i:i + 5 * MiB]

        assert (await store.put_stream(key, uneven())).size == len(data)
        assert (await store.stat(key)).size == len(data)
        digest = hashlib.sha256()
        async for chunk in store.open_stream(key):
            digest.update(chunk)
        assert digest.digest() == hashlib.sha256(data).digest()
        start = 16 * MiB - 3                                          # across the first part boundary
        assert b"".join([c async for c in store.open_stream(key, start=start)]) == data[start:]
    finally:
        await store.sweep(older_than_hours=-1)


async def test_a_failed_multipart_put_leaves_no_incomplete_upload(monkeypatch):
    store = live_store(monkeypatch)

    async def broken():
        yield b"x" * (16 * MiB)
        yield b"y" * MiB
        raise RuntimeError("the job lost its lease")

    with pytest.raises(RuntimeError):
        await store.put_stream("ws/ds/g/job2/export.zip", broken())
    assert (await store.stat("ws/ds/g/job2/export.zip")).exists is False
    pending = store._client.list_multipart_uploads(Bucket=store._bucket, Prefix=store._prefix)
    assert not pending.get("Uploads"), "the parts it stored were freed"


async def test_presigned_urls_work_without_this_sites_session(monkeypatch):
    store = live_store(monkeypatch, presign=True)
    try:
        part = b"0123456789" * 1000
        key = "transfer-uploads/up_1/part-00000"
        status, _, _ = _http("PUT", store.upload_target(key, size=len(part)).url, part)
        assert status == 200
        assert (await store.stat(key)).size == len(part), "a part sent straight to the bucket is received"

        status, headers, body = _http("GET", store.download_url(key, filename="v.view-package.zip"))
        assert (status, body) == (200, part)
        assert headers["Content-Disposition"] == 'attachment; filename="v.view-package.zip"'
    finally:
        await store.sweep(older_than_hours=-1)


async def test_a_presigned_part_takes_only_its_signed_length(monkeypatch):
    store = live_store(monkeypatch, presign=True)
    try:
        url = store.upload_target("transfer-uploads/up_1/part-00001", size=10).url
        if _http("PUT", url.replace("X-Amz-Signature=", "X-Amz-Signature=0"), b"0123456789")[0] == 200:
            pytest.skip("this endpoint doesn't check signatures, so it can't hold a signed length")
        assert _http("PUT", url, b"01234567890123456789")[0] == 403, "twice the bytes: refused"
        assert _http("PUT", url, b"0123456789")[0] == 200
    finally:
        await store.sweep(older_than_hours=-1)
