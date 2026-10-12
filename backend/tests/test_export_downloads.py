"""A stored export's download, which resumes, and who may read an export job.

Pins: ``Range`` gets exactly the bytes asked for (206, with ``Content-Range``), however it is put
(a span, from an offset, the last N); the whole file (200) for no range, or one not served
(several ranges, another unit) or not valid; 416 for one wholly past the end; ``If-Range`` naming
another version of the file gets all of it. A download broken off anywhere resumes into the same
bytes, and every download says its size, ``Accept-Ranges`` and its validators. One not finished
is a 409, one no longer kept a 404, and its job says it isn't kept. An export job is readable only
by those who may read what it exported: someone else's private draft's export, or one of a view
the caller can't read, is a 404 as for none, and missing from the list; an import isn't an export.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from email.utils import format_datetime

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints.graph_export import byte_range
from backend.app.api.v1.endpoints.versioning import get_import_export_service, get_versioning_service
from backend.app.services.storage.object_store import LocalFsObjectStore
from backend.app.services.versioning.service import AccessDenied

SIZE = 3 * (1 << 20) + 123                          # past the store's 1 MiB reads, and not a multiple
DATA = os.urandom(SIZE)
DONE_AT = "2026-09-24T10:00:00+00:00"
BASE = "/api/v1/ws1/versioning/graphs/g1/exports"


def test_a_range_header_is_read_as_http_reads_it():
    assert byte_range(None, 100) is None
    assert byte_range("bytes=0-9", 100) == (0, 9)
    assert byte_range("bytes=90-", 100) == (90, 99)
    assert byte_range("bytes=95-200", 100) == (95, 99), "a last byte past the end means the end"
    assert byte_range("bytes=-10", 100) == (90, 99)
    assert byte_range("bytes=-500", 100) == (0, 99)
    for not_served in ("bytes=0-1,5-6", "items=0-9", "bytes=9-0", "bytes=abc", "bytes=-", "bytes=--5"):
        assert byte_range(not_served, 100) is None, not_served
    for past_the_end in (("bytes=100-", 100), ("bytes=-0", 100), ("bytes=0-", 0)):
        with pytest.raises(ValueError):
            byte_range(*past_the_end)


# ── Through the API ──────────────────────────────────────────────────────────


class _Versioning:
    async def get_graph(self, graph_id):
        return {"graph_id": graph_id, "workspace_id": "ws1", "data_source_id": "ds1", "provider_id": None}

    async def assert_branch_readable(self, *, graph_id, branch_id, viewer):
        if branch_id == "br_private":
            raise AccessDenied(f"{viewer.actor} cannot view branch {branch_id}")


class _ImportExport:
    """Export jobs held in a dict; their files in a real store."""

    def __init__(self, store):
        self.store = store
        self.jobs: dict = {}

    def add(self, job_id, **extra):
        self.jobs[job_id] = {"jobId": job_id, "jobType": "export", "status": "completed", "graphId": "g1",
                             "branchId": None, "scopeViewId": None, "importFormat": "csv",
                             "resultUri": f"ws1/ds1/g1/{job_id}/export.csv", "completedAt": DONE_AT,
                             "fileName": "Finance-DWH.csv", **extra}

    async def get_job(self, job_id):
        return self.jobs.get(job_id)

    async def list_jobs(self, *, graph_id, job_type):
        return [j for j in self.jobs.values() if j["graphId"] == graph_id and j["jobType"] == job_type]


@pytest.fixture
async def api(tmp_path):
    from backend.app.main import app

    store = LocalFsObjectStore(tmp_path)
    jobs = _ImportExport(store)
    jobs.add("j1")

    async def body():
        yield DATA

    await store.put_stream(jobs.jobs["j1"]["resultUri"], body())
    app.dependency_overrides[get_versioning_service] = _Versioning
    app.dependency_overrides[get_import_export_service] = lambda: jobs
    yield jobs
    app.dependency_overrides.pop(get_versioning_service, None)
    app.dependency_overrides.pop(get_import_export_service, None)


async def test_a_download_says_its_size_and_resumes_from_anywhere(test_client, api):
    whole = await test_client.get(f"{BASE}/j1/download")
    assert whole.status_code == 200 and whole.content == DATA
    etag = whole.headers["etag"]
    assert whole.headers["content-length"] == str(SIZE) and whole.headers["accept-ranges"] == "bytes"
    assert whole.headers["last-modified"] == format_datetime(datetime(2026, 9, 24, 10, tzinfo=timezone.utc), usegmt=True)
    assert 'filename="Finance-DWH.csv"' in whole.headers["content-disposition"]

    span = await test_client.get(f"{BASE}/j1/download", headers={"Range": "bytes=1048570-1048580"})
    assert span.status_code == 206 and span.content == DATA[1048570:1048581]
    assert span.headers["content-range"] == f"bytes 1048570-1048580/{SIZE}" and span.headers["content-length"] == "11"

    # Broken off anywhere, a download resumes from where it stopped into the same file.
    for stopped_at in (1, (1 << 20) - 1, 1 << 20, 2 * (1 << 20) + 7, SIZE - 1):
        rest = await test_client.get(f"{BASE}/j1/download", headers={"Range": f"bytes={stopped_at}-", "If-Range": etag})
        assert rest.status_code == 206, stopped_at
        assert DATA[:stopped_at] + rest.content == DATA, stopped_at

    tail = await test_client.get(f"{BASE}/j1/download", headers={"Range": "bytes=-100"})
    assert tail.status_code == 206 and tail.content == DATA[-100:]
    by_date = await test_client.get(f"{BASE}/j1/download",
                                    headers={"Range": "bytes=0-0", "If-Range": whole.headers["last-modified"]})
    assert by_date.status_code == 206 and by_date.content == DATA[:1]


async def test_a_range_not_served_gets_the_whole_file_and_one_past_the_end_a_416(test_client, api):
    for headers in ({"Range": "bytes=0-1,5-6"}, {"Range": "bytes=0-9", "If-Range": '"another-version"'}):
        whole = await test_client.get(f"{BASE}/j1/download", headers=headers)
        assert whole.status_code == 200 and whole.content == DATA, headers
    past = await test_client.get(f"{BASE}/j1/download", headers={"Range": f"bytes={SIZE}-"})
    assert past.status_code == 416 and past.headers["content-range"] == f"bytes */{SIZE}"


async def test_an_export_not_finished_or_no_longer_kept_is_not_downloaded(test_client, api):
    api.add("j_running", status="running", completedAt=None)
    assert (await test_client.get(f"{BASE}/j_running/download")).status_code == 409

    await api.store.delete(api.jobs["j1"]["resultUri"])            # swept after a day
    gone = await test_client.get(f"{BASE}/j1/download")
    assert gone.status_code == 404 and "no longer kept" in gone.json()["detail"]
    assert (await test_client.get(f"{BASE}/j1")).json()["kept"] is False


async def test_an_export_is_only_for_those_who_may_read_what_it_exported(test_client, api, monkeypatch):
    from backend.app.api.v1.endpoints import view_guards

    async def readable_view(session, view_id, user, claims):
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")

    monkeypatch.setattr(view_guards, "readable_view", readable_view)
    api.add("j_draft", branchId="br_mine")
    api.add("j_private", branchId="br_private")
    api.add("j_view", scopeViewId="v_hidden")
    api.add("j_import", jobType="ingest")

    listed = await test_client.get(BASE)
    assert [j["jobId"] for j in listed.json()] == ["j1", "j_draft"]
    assert (await test_client.get(f"{BASE}/j_draft")).status_code == 200
    for job_id in ("j_private", "j_view", "j_import", "j_missing"):
        for path in (f"{BASE}/{job_id}", f"{BASE}/{job_id}/download"):
            refused = await test_client.get(path)
            assert refused.status_code == 404 and refused.json()["detail"] == "export not found", (path, refused.text)
