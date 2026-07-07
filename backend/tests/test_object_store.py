"""LocalFsObjectStore — the v1 object-store backend for import/export artifacts (no infra).

Pure filesystem + asyncio, so it runs under the per-file runner
(``PYTHONPATH=/tmp/pystub:/app python backend/tests/test_object_store.py``). Pins the behaviours
the import/export pipeline relies on: streamed put/open round-trips without buffering the whole
file, stat/existence, single-object + prefix (job-dir) deletion for the cleanup sweep, key
traversal safety (a key can never escape IMPORT_STORE_ROOT), the self-describing
{ws}/{ds}/{graph}/{job}/{name} key layout, and the LocalFs "backend" upload mode.
"""
import asyncio
import shutil
import tempfile

import pytest

from backend.app.services.storage.object_store import LocalFsObjectStore, storage_key


async def _drain(aiter):
    out = b""
    async for chunk in aiter:
        out += chunk
    return out


async def _chunks(*parts: bytes):
    for p in parts:
        yield p


async def _run() -> None:
    # storage_key encodes the ws/ds/graph/job/name layout
    assert storage_key("ws1", "ds1", "g1", "job1", "source.ndjson") == \
        "ws1/ds1/g1/job1/source.ndjson"

    root = tempfile.mkdtemp(prefix="objstore-test-")
    try:
        store = LocalFsObjectStore(root)
        key = storage_key("ws1", "ds1", "g1", "job1", "source.ndjson")

        # put_stream then open_stream round-trips the exact bytes; stat reports the size
        stat = await store.put_stream(key, _chunks(b'{"a":1}\n', b'{"b":2}\n'))
        assert stat.size == 16
        assert await _drain(store.open_stream(key)) == b'{"a":1}\n{"b":2}\n'

        # stat: existence + size, and False for a missing key
        present = await store.stat(key)
        assert present.exists is True and present.size == 16
        assert (await store.stat(storage_key("ws1", "ds1", "g1", "job1", "missing"))).exists is False

        # delete removes a single object
        await store.delete(key)
        assert (await store.stat(key)).exists is False

        # delete_prefix removes the whole job dir
        a = storage_key("ws1", "ds1", "g1", "job2", "source.ndjson")
        b = storage_key("ws1", "ds1", "g1", "job2", "rejected.ndjson")
        await store.put_stream(a, _chunks(b"a"))
        await store.put_stream(b, _chunks(b"b"))
        await store.delete_prefix("ws1/ds1/g1/job2")
        assert (await store.stat(a)).exists is False
        assert (await store.stat(b)).exists is False

        # a key that escapes the root is rejected
        with pytest.raises(ValueError):
            await store.put_stream("../escape.txt", _chunks(b"nope"))

        # upload_target reports LocalFs "backend" mode (the UI streams through the API)
        target = store.upload_target(key)
        assert target.mode == "backend" and target.key == key and target.url is None
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_object_store():
    asyncio.run(_run())


if __name__ == "__main__":
    asyncio.run(_run())
    print("object store (local fs): OK")
