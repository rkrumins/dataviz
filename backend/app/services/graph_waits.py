"""A graph request that only waits holds nothing while it waits.

Every graph read is admitted (``providers/manager.py::admit_graph_request``,
sized from the GRAPH_READ pool) and holds a GRAPH_READ database session for
the whole request. Some requests spend most of that time waiting on work
another request does:
- a scan another request moves on (``falkordb_search/session.py::wait_for_commit``);
- an answer another request, in this process or another, computes
  (``graph_cache``).

While waiting they use neither. A burst of them — a popular subset view opened
cold, a Narrow everyone runs at once — filled a worker's admissions and its
pool, and every other graph read on that worker was shed with a 429, ordinary
canvases included.

``waiting()`` wraps such a wait. The request's dependencies register what it
holds (``hold``):
- its admission, given back for the wait and taken again after — never
  refused, since the request was admitted once and refusing it now would fail
  it halfway;
- its database session, whose transaction is ended when nothing in it is
  pending, so the connection goes back to the pool. The factory keeps loaded
  objects as they are (``expire_on_commit=False``), and the next statement
  opens a new transaction. A route that writes through it commits before it
  waits on anything — those that write commit at once.

Outside a request (a worker, a test) nothing is held, and ``waiting()`` is a
no-op.
"""
from __future__ import annotations

import contextlib
from collections.abc import AsyncIterator, Callable
from contextvars import ContextVar, Token

StepOut = Callable[[], contextlib.AbstractAsyncContextManager[None]]

_HELD: ContextVar[tuple[StepOut, ...]] = ContextVar("graph_waits_held", default=())


def hold(step_out: StepOut) -> Token:
    """Register something this request holds, and how to let go of it for a
    wait: ``step_out()`` gives it up on entry and takes it back on exit."""
    return _HELD.set(_HELD.get() + (step_out,))


def let_go(token: Token) -> None:
    """Forget what ``hold`` registered (and anything registered after it)."""
    try:
        _HELD.reset(token)
    except ValueError:
        # Torn down in another context than the one it was set in: what that
        # context holds isn't this request's.
        pass


@contextlib.asynccontextmanager
async def waiting() -> AsyncIterator[None]:
    """Wait on another request's work holding nothing of this one's. A wait
    inside a wait holds nothing more to let go of."""
    held = _HELD.get()
    if not held:
        yield
        return
    async with contextlib.AsyncExitStack() as stack:
        for step_out in held:
            await stack.enter_async_context(step_out())
        inner = _HELD.set(())
        try:
            yield
        finally:
            _HELD.reset(inner)


def session_step_out(session) -> StepOut:
    """For a request's database session: end its transaction for the wait when
    nothing in it is pending, so its connection goes back to the pool."""
    @contextlib.asynccontextmanager
    async def step_out() -> AsyncIterator[None]:
        if session.in_transaction() and not (session.new or session.dirty or session.deleted):
            await session.commit()
        yield
    return step_out
