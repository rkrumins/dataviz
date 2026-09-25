"""Resumable import uploads: a file sent in parts, each its own request and its own object.

Pins: a file is split into fixed parts (the last holds the rest); a part must hold exactly its
share, and a wrong one is not kept; sending a part again replaces it; which parts arrived is what a
client resumes from; the parts read back in order as one file, however they arrived; a file too
large for its format is refused before any of it is sent; an upload is its owner's only. Through
the API: completing an upload before every part is in is a 409, then it starts the import from the
upload, once (asking again answers with the same import).
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning.import_export import uploads
from backend.app.services.versioning.import_export.uploads import UploadError

DATA = b"".join(b'{"kind":"node","urn":"urn:%d"}\n' % i for i in range(7))   # 7 rows, 210 bytes


async def _body(data: bytes):
    yield data


@pytest.fixture
def small_parts(monkeypatch):
    monkeypatch.setattr(uploads, "PART_BYTES", 64)


def _where(**extra):
    return {"workspace_id": "ws1", "data_source_id": "ds1", "graph_id": "g1", **extra}


async def _upload(store, data=DATA, fmt="ndjson"):
    return await uploads.create(store, **_where(owner="u1", file_name="big.ndjson", size=len(data), fmt=fmt))


async def test_a_file_is_split_into_parts_that_read_back_in_order(tmp_path, small_parts):
    store = LocalFsObjectStore(tmp_path)
    record = await _upload(store)
    assert (record["parts"], record["partBytes"]) == (4, 64)
    assert [uploads.part_size(record, n) for n in range(4)] == [64, 64, 64, 18]

    parts = [DATA[i:i + 64] for i in range(0, len(DATA), 64)]
    for n in (3, 1, 0):                                   # any order
        await uploads.put_part(store, record, n, _body(parts[n]))
    assert await uploads.received(store, record) == [0, 1, 3], "what a client resumes from"
    await uploads.put_part(store, record, 2, _body(parts[2]))

    source = uploads.record_key(record)
    assert b"".join([c async for c in uploads.open_source(store, source)]) == DATA
    assert await uploads.source_size(store, source) == len(DATA)


async def test_a_part_must_hold_exactly_its_share(tmp_path, small_parts):
    store = LocalFsObjectStore(tmp_path)
    record = await _upload(store)
    for n, data in ((0, b"x" * 63), (0, b"x" * 65), (3, b"x" * 64)):
        with pytest.raises(UploadError):
            await uploads.put_part(store, record, n, _body(data))
    assert await uploads.received(store, record) == [], "a wrong part is not kept"
    with pytest.raises(UploadError, match="no part 4"):
        await uploads.put_part(store, record, 4, _body(b"x"))

    await uploads.put_part(store, record, 0, _body(b"a" * 64))
    await uploads.put_part(store, record, 0, _body(b"b" * 64))        # sent again: replaces it
    assert b"".join([c async for c in store.open_stream(
        uploads.record_key(record).replace("upload.json", "part-00000"))]) == b"b" * 64


async def test_a_file_too_large_for_its_format_is_refused_before_it_is_sent(tmp_path):
    store = LocalFsObjectStore(tmp_path)
    with pytest.raises(UploadError) as big:
        await uploads.create(store, **_where(owner="u1", file_name="f.csv", size=uploads.MAX_BYTES + 1, fmt="csv"))
    assert big.value.status == 413 and "at most 10 GB" in str(big.value)
    for fmt in ("json", "xlsx"):
        with pytest.raises(UploadError) as whole:
            await uploads.create(store, **_where(owner="u1", file_name="f", size=uploads.WHOLE_FILE_MAX_BYTES + 1,
                                                 fmt=fmt))
        assert whole.value.status == 413 and "read whole" in str(whole.value) and "NDJSON or CSV" in str(whole.value)
    # A streamed format of the same size is fine.
    await uploads.create(store, **_where(owner="u1", file_name="f.ndjson", size=uploads.WHOLE_FILE_MAX_BYTES + 1,
                                         fmt="ndjson"))


async def test_an_upload_is_its_owners_only(tmp_path):
    store = LocalFsObjectStore(tmp_path)
    record = await _upload(store)
    assert (await uploads.load(store, **_where(upload_id=record["uploadId"], owner="u1")))["size"] == len(DATA)
    for upload_id, owner in ((record["uploadId"], "u2"), ("iu_" + "0" * 32, "u1"), ("../escape", "u1")):
        with pytest.raises(UploadError) as gone:
            await uploads.load(store, **_where(upload_id=upload_id, owner=owner))
        assert gone.value.status == 404
    with pytest.raises(UploadError):                     # another graph's upload isn't found here
        await uploads.load(store, **_where(graph_id="g2", upload_id=record["uploadId"], owner="u1"))


# ── Through the API ──────────────────────────────────────────────────────────


class _Versioning:
    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1", "provider_id": None}


class _ImportExport:
    """Import jobs recorded rather than run."""

    def __init__(self, store):
        self.store = store
        self.created: list = []
        self.started: list = []

    async def create_import_job(self, **kwargs):
        self.created.append(kwargs)
        return {"job_id": f"vjob_{len(self.created)}", "branch_id": "br_1", "source_uri": kwargs["source_uri"]}

    async def start_import(self, job_id):
        self.started.append(job_id)
        return "pending"

    async def get_job(self, job_id):
        return {"jobId": job_id, "status": "pending"}


@pytest.fixture
def api(tmp_path, small_parts):
    from backend.app.main import app

    jobs = _ImportExport(LocalFsObjectStore(tmp_path))
    app.dependency_overrides[get_versioning_service] = _Versioning
    app.dependency_overrides[get_import_export_service] = lambda: jobs
    yield jobs
    app.dependency_overrides.pop(get_versioning_service, None)
    app.dependency_overrides.pop(get_import_export_service, None)


BASE = "/api/v1/ws1/versioning/graphs/g1/imports/uploads"


async def test_an_upload_becomes_one_import_once_every_part_is_in(test_client, api):
    r = await test_client.post(BASE, json={"fileName": "big.ndjson", "size": len(DATA), "format": "ndjson"})
    assert r.status_code == 201, r.text
    up = r.json()
    assert (up["parts"], up["partBytes"], up["received"]) == (4, 64, [])
    url = f"{BASE}/{up['uploadId']}"

    parts = [DATA[i:i + 64] for i in range(0, len(DATA), 64)]
    sent = await asyncio.gather(*[test_client.put(f"{url}/parts/{n}", content=parts[n]) for n in (0, 2, 3)])
    assert [s.status_code for s in sent] == [200, 200, 200], [s.text for s in sent]
    assert (await test_client.get(url)).json()["received"] == [0, 2, 3]

    early = await test_client.post(f"{url}/complete")
    assert early.status_code == 409 and "1 of the file's 4 parts" in early.json()["detail"]
    assert api.created == []

    assert (await test_client.put(f"{url}/parts/1", content=parts[1])).status_code == 200
    done = await test_client.post(f"{url}/complete", params={"reconcileMode": "replace"})
    assert done.status_code == 202, done.text
    assert done.json()["jobId"] == "vjob_1" and done.json()["status"] == "pending"
    (job,) = api.created
    assert job["import_format"] == "ndjson" and job["reconcile_mode"] == "replace"
    assert job["source_uri"].endswith(f"/uploads/{up['uploadId']}/upload.json")
    assert b"".join([c async for c in uploads.open_source(api.store, job["source_uri"])]) == DATA
    assert api.started == ["vjob_1"]

    again = await test_client.post(f"{url}/complete")
    assert again.status_code == 202 and again.json()["jobId"] == "vjob_1"
    assert len(api.created) == 1, "asking again answers with the import already started"


async def test_the_api_refuses_what_an_upload_cant_take(test_client, api):
    too_big = await test_client.post(BASE, json={"fileName": "f.json", "size": uploads.WHOLE_FILE_MAX_BYTES + 1,
                                                 "format": "json"})
    assert too_big.status_code == 413 and "read whole" in too_big.json()["detail"]
    unknown = await test_client.post(BASE, json={"fileName": "f.bin", "size": 10, "format": "parquet"})
    assert unknown.status_code == 422

    up = (await test_client.post(BASE, json={"fileName": "f.ndjson", "size": 10, "format": "ndjson"})).json()
    wrong = await test_client.put(f"{BASE}/{up['uploadId']}/parts/0", content=b"too many bytes")
    assert wrong.status_code == 422 and "10 bytes" in wrong.json()["detail"]
    assert (await test_client.get(f"{BASE}/iu_{'0' * 32}")).status_code == 404
