"""Check sync's word on the lineage summaries is about the graph it scanned.

The scan counts the ``:AGGREGATED`` rollups in the data source's graph. A dedicated source keeps
its rollups in ``{graph_name}_proj``, which the scan never reads, so that count — always zero
there — would report its summaries as never built, with a rebuild offered that cannot change it.
"""
import asyncio

import pytest

from backend.app.api.v1.endpoints import versioning as V
from backend.app.services import projection_target
from backend.app.services.versioning.reconcile import DriftReport, ProjectionReconciler


def _report() -> DriftReport:
    return DriftReport(
        graph_id="g1", falkor_graph_name="fg", committed_seq=3, projected_seq=3, status="idle",
        fresh=True, pg_nodes=2, pg_edges=1, falkor_nodes=2, falkor_edges=1, missing_nodes=[],
        extra_nodes=[], missing_edges=[], extra_edges=[], mismatched=[], edge_mismatched=[],
        truncated=False, in_sync=True, checked_at="2026-10-27T00:00:00+00:00", duration_ms=5,
        rollups={"status": "missing", "aggregated": 0, "stubs": 0})


@pytest.mark.parametrize("mode, reported", [("dedicated", False), ("in_source", True)])
def test_the_summaries_are_reported_only_where_the_scan_can_see_them(monkeypatch, mode, reported):
    async def _reconcile(self, graph_id, *, deep=False, sample_limit=50):
        return _report()

    async def _mode(ds_id):
        assert ds_id == "ds1"
        return mode

    monkeypatch.setattr(ProjectionReconciler, "reconcile", _reconcile)
    monkeypatch.setattr(V, "get_falkor_read_factory", lambda: None)
    monkeypatch.setattr(projection_target, "_projection_mode", _mode)
    out = asyncio.run(V.reconcile_projection(
        "ws1", "g1", V.ReconcileRequest(), _user=None, _meta={"data_source_id": "ds1"}))
    assert (out.rollups is not None) is reported
    assert out.in_sync is True
