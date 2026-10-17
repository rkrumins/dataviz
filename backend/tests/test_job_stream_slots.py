"""A job-progress stream holds one of its process's slots while it is open.

``AGGREGATION_JOB_SSE_MAX_CONCURRENT`` bounds how many of these streams one
process serves at once. Past it, the endpoint refuses with 503 rather than
queue a caller that would hold a worker while contributing nothing. The
handler gives the slot back when the stream ends, and that is the line worth
a test: a slot that leaks is not a slow failure but a permanent one, because
every stream after the last free slot is refused for the life of the process.
"""
from __future__ import annotations

import asyncio

import pytest

from backend.app.services.aggregation.models import AggregationJobORM
from tests.common.api_key_world import api_key_app, mint

EVENTS = "/api/v1/admin/data-sources/ds_a/aggregation-jobs/agg_a/events"


@pytest.fixture()
async def client(db_session, monkeypatch):
    async with api_key_app(db_session, monkeypatch) as http:
        yield http


@pytest.fixture()
async def key(client, db_session, monkeypatch):
    """A key whose streams end by themselves, over a job that never speaks."""
    from backend.app import jobs
    from backend.app.api.v1.endpoints import aggregation

    class _Silent:
        def stream(self, _scope, _from_seq):
            return self._forever()

        async def _forever(self):
            await asyncio.Event().wait()
            yield  # pragma: no cover — never reached

    db_session.add(AggregationJobORM(id="agg_a", data_source_id="ds_a"))
    await db_session.commit()
    monkeypatch.setattr(jobs, "get_consumer", lambda: _Silent())
    monkeypatch.setattr(aggregation, "_KEY_STREAM_SECONDS", 0.05)
    return await mint(db_session, data="read", resources={"dataSources": ["ds_a"]})


async def test_a_finished_stream_gives_its_slot_back(client, key, monkeypatch):
    from backend.app.api.v1.endpoints import aggregation

    monkeypatch.setattr(aggregation, "_job_stream_slots", asyncio.Semaphore(1))

    for attempt in (1, 2):
        resp = await asyncio.wait_for(client.get(EVENTS, headers=key.headers), 10)
        assert resp.status_code == 200, f"stream {attempt}: {resp.status_code}"


async def test_a_full_process_refuses_rather_than_queues(client, key, monkeypatch):
    from backend.app.api.v1.endpoints import aggregation

    monkeypatch.setattr(aggregation, "_job_stream_slots", asyncio.Semaphore(0))

    resp = await asyncio.wait_for(client.get(EVENTS, headers=key.headers), 10)

    assert resp.status_code == 503
    assert resp.headers["Retry-After"] == "5"
