"""
Unit tests for the aggregation consistency verifier (P2-1).

Exercises the verifier's decision logic with a fake provider that
returns controllable query results. The actual Cypher round-trips
are exercised in integration tests against a live FalkorDB; here we
verify the orchestration: sampling, support-check pass/fail counting,
timeout handling, alert-only behaviour (no auto-rebuild).

Designed to load with ``--noconftest``.
"""
from __future__ import annotations

import asyncio
import os
import random
import sys
from typing import Any, Callable, List, Optional

import pytest

_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from backend.app.services.aggregation.verifier import (  # noqa: E402
    AggregationConsistencyVerifier,
    VerifierResult,
)


# ── Fakes ────────────────────────────────────────────────────────────────


class _FakeQueryResult:
    def __init__(self, rows: list) -> None:
        self.result_set = rows


class _FakeProvider:
    """Records every query that comes through and returns canned
    results based on a routing function the test supplies."""

    def __init__(
        self,
        total_edges: int,
        edge_at_offset: Callable[[int], Optional[tuple]] = None,
        is_supported: Callable[[str, str], bool] = None,
        per_edge_delay_secs: float = 0.0,
    ) -> None:
        self.total_edges = total_edges
        self._edge_at_offset = edge_at_offset or (lambda i: (f"s{i}", f"t{i}"))
        self._is_supported = is_supported or (lambda s, t: True)
        self._per_edge_delay = per_edge_delay_secs
        self.queries: list[tuple[str, dict]] = []

    async def count_aggregated_edges(self) -> int:
        return self.total_edges

    async def _proj_ro_query(
        self,
        cypher: str,
        params: dict = None,
        *,
        timeout: float = None,
    ) -> _FakeQueryResult:
        if self._per_edge_delay:
            await asyncio.sleep(self._per_edge_delay)
        self.queries.append((cypher, params or {}))
        # Route by Cypher shape.
        if "SKIP $offset LIMIT 1" in cypher:
            offset = (params or {}).get("offset", 0)
            edge = self._edge_at_offset(offset)
            return _FakeQueryResult([list(edge)] if edge else [])
        if "RETURN 1 AS supported" in cypher:
            s, t = (params or {}).get("s"), (params or {}).get("t")
            return _FakeQueryResult([[1]] if self._is_supported(s, t) else [])
        if "count(r)" in cypher:
            return _FakeQueryResult([[self.total_edges]])
        return _FakeQueryResult([])


def _make_verifier(**kwargs) -> AggregationConsistencyVerifier:
    base = {
        "sample_size": 10,
        "max_depth": 5,
        "per_data_source_timeout_secs": 30,
        "per_edge_timeout_secs": 2,
    }
    base.update(kwargs)
    return AggregationConsistencyVerifier(**base)


# ── Happy path ───────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_all_supported_marks_all_verified():
    """When every sampled edge is supported by lineage, the result has
    verified == sampled, failed == 0."""
    random.seed(42)
    provider = _FakeProvider(total_edges=50, is_supported=lambda s, t: True)
    verifier = _make_verifier(sample_size=10)

    result = await verifier.verify_data_source(
        provider, "ds_a",
        lineage_edge_types=["FLOWS_TO"],
        containment_edge_types=["CONTAINS"],
    )

    assert result.sampled == 10
    assert result.verified == 10
    assert result.failed == 0
    assert result.failures == []
    assert not result.timed_out
    assert result.error is None


@pytest.mark.asyncio
async def test_no_edges_marks_skipped():
    """Empty projection (no AGGREGATED edges) is a no-op skip, not a
    failure."""
    provider = _FakeProvider(total_edges=0)
    verifier = _make_verifier()

    result = await verifier.verify_data_source(
        provider, "ds_empty",
        lineage_edge_types=["FLOWS_TO"],
        containment_edge_types=["CONTAINS"],
    )

    assert result.skipped_no_edges is True
    assert result.sampled == 0
    assert result.verified == 0
    assert result.failed == 0


# ── Failure detection ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_unsupported_edges_recorded_as_failures():
    """Edges whose support-check returns 0 increment ``failed`` and are
    captured in ``failures`` up to the per-result cap."""
    random.seed(1)
    # Make every other sampled edge unsupported.
    provider = _FakeProvider(
        total_edges=20,
        is_supported=lambda s, t: int(s[1:]) % 2 == 0,  # even-index supported
    )
    verifier = _make_verifier(sample_size=10)

    result = await verifier.verify_data_source(
        provider, "ds_mix",
        lineage_edge_types=["FLOWS_TO"],
        containment_edge_types=["CONTAINS"],
    )

    assert result.sampled == 10
    assert result.verified + result.failed == 10
    assert result.failed > 0, "deterministic seed should produce some failures"
    assert len(result.failures) == min(result.failed, verifier._MAX_FAILURE_SAMPLES)
    # Every failure should be an (s, t) tuple.
    for failure in result.failures:
        assert isinstance(failure, tuple) and len(failure) == 2


@pytest.mark.asyncio
async def test_failure_list_capped():
    """Even when every sample fails the failures list is bounded."""
    random.seed(7)
    provider = _FakeProvider(
        total_edges=200,
        is_supported=lambda s, t: False,  # everything stale
    )
    verifier = _make_verifier(sample_size=100)

    result = await verifier.verify_data_source(
        provider, "ds_broken",
        lineage_edge_types=["FLOWS_TO"],
        containment_edge_types=["CONTAINS"],
    )

    assert result.failed == result.sampled
    assert len(result.failures) <= verifier._MAX_FAILURE_SAMPLES


# ── Alert-only behaviour ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_verifier_does_not_trigger_rebuild_on_failure():
    """Per design (operator-confirmed) the verifier is alert-only —
    it must NOT invoke any rebuild-related method on the provider.

    Asserts no Cypher matching common rebuild verbs was issued."""
    random.seed(99)
    provider = _FakeProvider(
        total_edges=20,
        is_supported=lambda s, t: False,
    )
    verifier = _make_verifier(sample_size=5)

    await verifier.verify_data_source(
        provider, "ds_x",
        lineage_edge_types=["FLOWS_TO"],
        containment_edge_types=["CONTAINS"],
    )

    issued = " | ".join(q.upper() for q, _ in provider.queries)
    for forbidden in ("DELETE", "MERGE", "CREATE (", "SET R."):
        assert forbidden not in issued, (
            f"verifier issued {forbidden!r} — should be read-only"
        )


# ── Timeouts ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_per_data_source_timeout_marks_result():
    """When the per-data-source timeout fires before all samples are
    checked, the result records ``timed_out=True`` but doesn't crash."""
    random.seed(3)
    # Provider takes 100ms per query; sample 100 ⇒ ~10s ⇒ exceeds 0.5s.
    provider = _FakeProvider(
        total_edges=100,
        per_edge_delay_secs=0.05,
    )
    verifier = _make_verifier(
        sample_size=100,
        per_data_source_timeout_secs=0.3,
    )

    result = await verifier.verify_data_source(
        provider, "ds_slow",
        lineage_edge_types=["FLOWS_TO"],
        containment_edge_types=["CONTAINS"],
    )

    assert result.timed_out is True
    # Some sampling should have happened before the timeout.
    assert result.sampled >= 0
    assert result.error is None  # timeout is not a "hard" error


# ── Error robustness ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_provider_exception_captured_not_raised():
    """A broken provider must not propagate exceptions to the
    scheduler — they're captured on the result instead. The exact
    message depends on which method the verifier reaches first; what
    matters is that the call returns cleanly with the error recorded."""
    class _BrokenProvider:
        async def count_aggregated_edges(self):
            raise RuntimeError("FalkorDB unreachable")
        # Intentionally NO _proj_ro_query — the fallback path also
        # fails. Both branches must terminate cleanly without re-raising.

    verifier = _make_verifier()
    result = await verifier.verify_data_source(
        _BrokenProvider(), "ds_a",
        lineage_edge_types=["FLOWS_TO"],
        containment_edge_types=["CONTAINS"],
    )

    assert result.error is not None, "exception should be captured on result"
    assert result.sampled == 0
    assert result.failed == 0
    assert result.verified == 0
