"""Unit tests for `_runner.make_contract_test`'s skip-gate — no live
database needed.

Uses the real "neo4j" catalog registration (self-registers just by
importing `backend.common.providers.catalog`, unlike "falkordb" — see
that package's own docstring) so these tests need no `backend.app`
import and no live instance: the point is to prove the gate skips
*before* ever trying to build a provider, using an env prefix
("ZZTEST") nothing else in the suite reads.
"""
from __future__ import annotations

import socket

import pytest

from backend.common.providers.catalog import registered_type_ids

from . import _runner


async def _cleanup(provider) -> None:
    pass


def _closed_port() -> int:
    """A port nothing is listening on: bind, read the OS-assigned port,
    close immediately -- a fast, deterministic "connection refused"."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_neo4j_is_registered_for_these_tests_to_mean_anything():
    # If this ever goes False, the tests below would skip for the wrong
    # reason (an unregistered type_id) instead of the gate under test.
    assert "neo4j" in registered_type_ids()


@pytest.mark.asyncio
async def test_skips_when_host_env_var_is_unset(monkeypatch):
    monkeypatch.delenv("ZZTEST_HOST", raising=False)
    contract_test = _runner.make_contract_test("neo4j", env_prefix="ZZTEST", cleanup=_cleanup)
    with pytest.raises(pytest.skip.Exception):
        await contract_test()


@pytest.mark.asyncio
async def test_skips_when_host_is_set_but_unreachable(monkeypatch):
    monkeypatch.setenv("ZZTEST_HOST", "127.0.0.1")
    monkeypatch.setenv("ZZTEST_PORT", str(_closed_port()))
    contract_test = _runner.make_contract_test("neo4j", env_prefix="ZZTEST", cleanup=_cleanup)
    with pytest.raises(pytest.skip.Exception):
        await contract_test()


@pytest.mark.asyncio
async def test_the_pre_run_cleanup_gets_a_connected_provider(monkeypatch):
    """The clean slate has to actually clean. Adapters connect lazily, so
    a cleanup callback handed a freshly-built instance drives a `None`
    engine handle, raises into its own `except`, and does nothing at all —
    silently, leaving the next run to seed on top of a crashed run's
    leftovers. Pin the ORDER rather than the mechanism: the connection is
    opened first, and it is opened even though the opening read fails,
    which is the normal state of a graph that does not exist yet."""
    order = []

    class _FakeProvider:
        async def get_node(self, urn):
            order.append("connect")
            # What FalkorDB answers on a graph that has never been created.
            raise RuntimeError("Invalid graph operation on empty key")

        async def close(self):
            order.append("close")

    async def _record_cleanup(provider):
        order.append("cleanup")

    async def _record_seed(provider):
        order.append("seed")

    async def _record_run_all(provider, **kwargs):
        order.append("run_all")

    monkeypatch.setattr(
        "backend.common.providers.catalog.create_provider_instance",
        lambda spec: _FakeProvider(),
    )
    monkeypatch.setattr(_runner, "seed", _record_seed)
    monkeypatch.setattr(_runner, "run_all", _record_run_all)

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listening:
        listening.bind(("127.0.0.1", 0))
        listening.listen(1)
        monkeypatch.setenv("ZZTEST_HOST", "127.0.0.1")
        monkeypatch.setenv("ZZTEST_PORT", str(listening.getsockname()[1]))
        contract_test = _runner.make_contract_test(
            "neo4j", env_prefix="ZZTEST", cleanup=_record_cleanup,
        )
        await contract_test()

    assert order == ["connect", "cleanup", "seed", "run_all", "cleanup", "close"]
