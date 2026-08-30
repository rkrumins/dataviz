"""Covering tests for `_runner._call_optional` — no live FalkorDB needed.

Every concrete provider that exists today (FalkorDB, Neo4j, Spanner) happens
to implement get_nodes_batch / get_node_degrees / preflight, so the live
contract run (test_falkordb_provider_contract.py) can only prove "no
regression when the method is present". It can never exercise "tolerance
when the method is absent" — the actual bug a prior review caught: building
`call=provider.some_method(...)` evaluates the attribute access eagerly, so
a provider missing the method raised AttributeError before `_pin`'s
`except NotImplementedError` ever got a chance to run. A stub that
genuinely lacks the method is the only way to exercise that branch.
"""
from __future__ import annotations

import pytest

from . import _runner


class _StubProvider:
    """Deliberately lacks every non-ABC method `_call_optional` guards."""


class _PresentProvider:
    async def get_node_degrees(self, urns, edge_types=None):
        return {"urns": urns, "edge_types": edge_types}


@pytest.mark.asyncio
async def test_call_optional_raises_not_implemented_when_method_missing():
    with pytest.raises(NotImplementedError):
        await _runner._call_optional(_StubProvider(), "get_node_degrees", ["urn:x"])


@pytest.mark.asyncio
async def test_call_optional_calls_through_when_method_present():
    result = await _runner._call_optional(
        _PresentProvider(), "get_node_degrees", ["urn:x"], ["DERIVES_FROM"]
    )
    assert result == {"urns": ["urn:x"], "edge_types": ["DERIVES_FROM"]}


@pytest.mark.asyncio
async def test_pin_snapshots_the_tolerant_sentinel_for_a_missing_method(monkeypatch):
    """The exact reported failure mode: before the fix, this composition
    raised AttributeError while building the `call=` argument, before `_pin`
    was ever entered. Monkeypatches `assert_snapshot` (no disk I/O) to
    confirm `_pin` now completes and pins the tolerant sentinel instead.
    """
    captured = {}
    monkeypatch.setattr(
        _runner,
        "assert_snapshot",
        lambda *, provider, name, actual: captured.update(
            provider=provider, name=name, actual=actual
        ),
    )
    await _runner._pin(
        snapshot_label="stub",
        name="get_node_degrees_datasets",
        call=_runner._call_optional(_StubProvider(), "get_node_degrees", ["urn:x"]),
    )
    assert captured == {
        "provider": "stub",
        "name": "get_node_degrees_datasets",
        "actual": "NotImplementedError",
    }
