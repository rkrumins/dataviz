"""Reads NEVER trigger materialization (trigger-model decision, 2026-07-12).

Aggregation is event-driven — projection on merge/publish/import
(``projection_target._hook``) and post-purge (worker) — plus manual (control
plane) and a scheduled drift sweep. It is NEVER driven from a browse read.

The removed read-path "auto" self-heal trigger fired whenever a result looked
stale, including on the transient ``chain_cache_miss`` read-cache condition that
nothing on the browse path ever warmed — so a browse-only user got a perpetual
re-trigger that ran a multi-minute worker job, found "no changes", and fired
again the next damping window. ``get_aggregated_edges`` must now return the
provider's result — including its honest freshness fields (``stale`` /
``stale_reason`` / ``stamp_version`` / ``regime``) so the UI can offer a
"re-aggregate" affordance — WITHOUT enqueueing anything, whatever the staleness.
"""
import asyncio

from backend.app.services.context_engine import ContextEngine
from backend.common.models.graph import (
    AggregatedEdgeRequest,
    AggregatedEdgeResult,
    OntologyMetadata,
)


class _Provider:
    """Just enough surface for ``engine.get_aggregated_edges``.
    ``materialize_aggregated_edges_batch`` is a tripwire: the read path must
    never call it (inline or otherwise)."""

    def __init__(self, result):
        self._result = result
        self._redis = None

    async def get_aggregated_edges_between(self, **kw):
        return self._result

    async def materialize_aggregated_edges_batch(self, *a, **kw):  # pragma: no cover
        raise AssertionError("read path must never materialize")


def _engine(provider):
    e = ContextEngine(provider=provider)
    e._workspace_id = "ws1"
    e._data_source_id = "ds1"

    async def _meta():
        return OntologyMetadata(
            containmentEdgeTypes=["HAS"], lineageEdgeTypes=["FLOWS_TO"],
            edgeTypeMetadata={}, entityTypeHierarchy={}, rootEntityTypes=[],
        )

    e.get_ontology_metadata = _meta
    return e


def _run(coro):
    return asyncio.new_event_loop().run_until_complete(coro)


def _result(**kw):
    base = dict(aggregatedEdges=[], totalSourceEdges=0)
    base.update(kw)
    return AggregatedEdgeResult(**base)


def _request():
    return AggregatedEdgeRequest(
        sourceUrns=["urn:a"], targetUrns=["urn:b"], granularity=None,
    )


def test_stale_legacy_cells_do_not_trigger():
    """Legacy stampVersion<2 cells are stale-but-honest — the migration
    script heals them, not the read path."""
    p = _Provider(_result(stale=True, staleReason="legacy_cells",
                          stampVersion=1, regime="boundary",
                          lastMaterializedAt="2026-07-01T00:00:00Z"))
    result = _run(_engine(p).get_aggregated_edges(_request()))
    assert result.materialization_triggered is False
    # honest freshness still flows through untouched
    assert result.stale is True and result.stale_reason == "legacy_cells"


def test_unmaterialized_does_not_trigger():
    """A never-materialized graph is healed by the ingest/merge projection
    event, not by the first browse of it."""
    p = _Provider(_result(stale=True, staleReason="unmaterialized",
                          stampVersion=1, regime="unknown"))
    result = _run(_engine(p).get_aggregated_edges(_request()))
    assert result.materialization_triggered is False
    assert result.stale is True and result.stale_reason == "unmaterialized"


def test_healthy_result_does_not_trigger():
    p = _Provider(_result(stale=False, stampVersion=2, regime="boundary",
                          lastMaterializedAt="2026-07-11T00:00:00Z"))
    result = _run(_engine(p).get_aggregated_edges(_request()))
    assert result.materialization_triggered is False
    assert result.stale is False


def test_read_path_trigger_method_is_gone():
    """Guard against the read-path self-heal method silently reappearing —
    its return would resurrect the browse-driven job-churn loop."""
    assert not hasattr(ContextEngine, "_trigger_materialize_in_background")
