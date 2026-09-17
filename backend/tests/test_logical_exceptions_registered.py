"""The provider signals the breaker must IGNORE, pinned as a set.

Each one means "healthy, just not right now": an instance replaying its RDB
(``ProviderLoading``), a node being replaced (``ProviderFailingOver``), one
slow query (``ProviderTimeout``), flow control (``ProviderBusy``). They are
registered as logical exceptions so a guarded proxy re-raises them untouched
— the breaker never opens, and it still opens for a store that is genuinely
unreachable.

They were added by different changes, and each removed a real outage:
counting a warm-up turned a few-second reload into a 30s+ one; counting a
rotating pod refused every graph on every OTHER shard for the reset window;
counting a slow query rendered "graph service unavailable" over a FalkorDB
that was serving fine. Dropping any one of them brings its outage back,
which is why the whole set is pinned here rather than left to the comment
beside the registrations.
"""
from __future__ import annotations

import pytest

from backend.common.adapters.circuit import (
    CircuitBreakerProxy,
    ProviderBusy,
    ProviderFailingOver,
    ProviderLoading,
    ProviderTimeout,
    ProviderUnavailable,
    _DEFAULT_IGNORED_EXCEPTIONS,
)

_THE_SET = (ProviderLoading, ProviderFailingOver, ProviderTimeout, ProviderBusy)


class _Provider:
    def __init__(self) -> None:
        self.calls = 0
        self.raise_exc: BaseException | None = None

    @property
    def name(self) -> str:
        return "p"

    async def get_nodes(self) -> list:
        self.calls += 1
        if self.raise_exc is not None:
            raise self.raise_exc
        return []


def test_every_flow_control_signal_is_registered() -> None:
    for exc_type in _THE_SET:
        assert exc_type in _DEFAULT_IGNORED_EXCEPTIONS, exc_type.__name__


def test_they_all_subclass_provider_unavailable() -> None:
    """The shared surface is what keeps existing HTTP handlers and metric
    emitters — which filter on the parent — working for every new signal."""
    for exc_type in _THE_SET:
        assert issubclass(exc_type, ProviderUnavailable), exc_type.__name__


@pytest.mark.parametrize("exc_type", _THE_SET, ids=lambda t: t.__name__)
async def test_none_of_them_opens_a_breaker(exc_type) -> None:
    target = _Provider()
    target.raise_exc = exc_type("p", "not right now")
    proxy = CircuitBreakerProxy(target, name="p", fail_max=1)

    for _ in range(5):
        with pytest.raises(exc_type):
            await proxy.get_nodes()
    assert proxy.breaker_state == "closed"
    assert target.calls == 5, "no fast-fail: every call must reach the target"


async def test_a_store_that_is_genuinely_gone_still_opens_it() -> None:
    """The narrowing that keeps the set honest."""
    target = _Provider()
    target.raise_exc = ConnectionError("Error 111 connecting. Connection refused.")
    proxy = CircuitBreakerProxy(target, name="p", fail_max=2)

    for _ in range(2):
        with pytest.raises(ProviderUnavailable):
            await proxy.get_nodes()
    assert proxy.breaker_state == "open"
