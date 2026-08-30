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
