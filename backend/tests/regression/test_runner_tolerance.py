"""Covering tests for `_runner._call_optional` / `_runner._pin` — no live
FalkorDB needed.

`_call_optional` is `_runner`'s tolerance helper for a method that isn't
guaranteed to exist on whatever's in hand. Its only caller today is
`preflight` (required by convention, not the ABC — every concrete
provider that exists happens to implement it, so the live contract run
alone can never exercise "tolerance when the method is absent"). Before
T-A landed base-class defaults, `get_nodes_batch` / `get_node_degrees`
needed the same tolerance too; `run_all` now calls both directly. Either
way, the actual bug a prior review caught applies to any such call:
building `call=provider.some_method(...)` evaluates the attribute access
eagerly, so a provider missing the method raised AttributeError before
`_pin`'s `except NotImplementedError` ever got a chance to run. A stub
that genuinely lacks the method is the only way to exercise that branch.
"""
from __future__ import annotations

import pytest

from backend.common.interfaces.provider import ProviderFeature, ProviderFeatureUnsupportedError

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


@pytest.mark.asyncio
async def test_pin_snapshots_unsupported_sentinel_for_a_declared_unsupported_feature(monkeypatch):
    """`ProviderFeatureUnsupportedError` is a `NotImplementedError` subclass
    but a more specific signal -- "this provider will never support this",
    not "not built out yet" -- and `_pin` must tell the two apart in the
    snapshot rather than collapsing both to the same sentinel string.
    """
    captured = {}
    monkeypatch.setattr(
        _runner,
        "assert_snapshot",
        lambda *, provider, name, actual: captured.update(
            provider=provider, name=name, actual=actual
        ),
    )

    async def _raises_unsupported():
        raise ProviderFeatureUnsupportedError.for_feature(ProviderFeature.TRACE_CLOSURE, "stub")

    await _runner._pin(snapshot_label="stub", name="trace_closure_d2_one_hop", call=_raises_unsupported())
    assert captured == {
        "provider": "stub",
        "name": "trace_closure_d2_one_hop",
        "actual": "unsupported",
    }
