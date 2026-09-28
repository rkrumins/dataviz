"""spawn_detached: work that outlives the request that started it.

A FastAPI ``BackgroundTasks`` task runs inside the request's ASGI call, so the timeout middleware
cancelled an import job at its route's deadline and the job read "running" forever. A detached task
is its own: the request's deadline leaves it running, it is held until it ends (the event loop only
keeps weak references), and however it ends badly is logged under its name.
"""
import asyncio
import logging

import pytest

from backend.app.services import background
from backend.app.services.background import spawn_detached

_LOGGER = "backend.app.services.background"


async def test_a_detached_task_outlives_the_request_that_spawned_it():
    release, finished = asyncio.Event(), asyncio.Event()

    async def job():
        await release.wait()
        finished.set()

    async def request():
        async with asyncio.timeout(0.01):          # the route's deadline, as _TimeoutMiddleware sets it
            spawn_detached(job(), name="import vjob_1")
            await asyncio.sleep(3600)

    with pytest.raises(TimeoutError):
        await request()
    release.set()
    await asyncio.wait_for(finished.wait(), timeout=1)


async def test_a_failure_is_logged_under_its_name_and_the_task_let_go(caplog):
    async def boom():
        raise RuntimeError("kaput")

    with caplog.at_level(logging.ERROR, logger=_LOGGER):
        task = spawn_detached(boom(), name="import vjob_2")
        assert task in background._tasks, "held while it runs"
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0)
    assert task not in background._tasks, "and let go once it ends"
    [record] = [r for r in caplog.records if r.name == _LOGGER]
    assert "import vjob_2" in record.getMessage() and str(record.exc_info[1]) == "kaput"


async def test_a_cancellation_is_logged_too(caplog):
    with caplog.at_level(logging.WARNING, logger=_LOGGER):
        task = spawn_detached(asyncio.sleep(3600), name="import vjob_3")
        await asyncio.sleep(0)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await asyncio.sleep(0)
    assert task not in background._tasks
    assert [r.getMessage() for r in caplog.records if r.name == _LOGGER] == \
        ["background task import vjob_3 was cancelled"]
