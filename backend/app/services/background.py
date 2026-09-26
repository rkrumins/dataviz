"""Work that must outlive the request that started it.

A FastAPI ``BackgroundTasks`` task runs after the response is sent, but still inside the request's
ASGI call, so whatever ends the request ends it too: the timeout middleware cancels it at the
route's deadline. :func:`spawn_detached` runs a coroutine as a task of its own instead.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Any, Coroutine, Set

logger = logging.getLogger(__name__)

# The event loop keeps only weak references to tasks, so an unreferenced one can be
# garbage-collected mid-run. Held here until done.
_tasks: Set[asyncio.Task] = set()


def spawn_detached(coro: Coroutine[Any, Any, Any], *, name: str) -> asyncio.Task:
    """Run ``coro`` as its own task, independent of the current request, logging under ``name``
    how it ended if it raised or was cancelled."""
    task = asyncio.create_task(coro, name=name)
    _tasks.add(task)
    task.add_done_callback(_finished)
    return task


def _finished(task: asyncio.Task) -> None:
    _tasks.discard(task)
    if task.cancelled():
        logger.warning("background task %s was cancelled", task.get_name())
    elif task.exception() is not None:
        logger.error("background task %s failed", task.get_name(), exc_info=task.exception())
