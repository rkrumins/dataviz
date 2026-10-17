"""``probe_projection_lag`` — the Infrastructure page's projection rollup.

* It counts only graphs whose data source is live, in six buckets that read consistently: in sync
  and failed never overlap, and a graph behind with an error counts as failed, not catching up.
* Its worst list holds at most 8 graphs, most behind first, and only ones that are behind, failing
  or being projected; each row is named from the data-source directory.
* Without the live data sources it says nothing rather than counting every orphan.
"""
from contextlib import asynccontextmanager
from types import SimpleNamespace

from sqlalchemy.dialects import postgresql

from backend.app.services.system_status import probes
from backend.app.services.versioning import db as vdb


def _sql(stmt) -> str:
    return str(stmt.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


def _worst_row(**over):
    row = dict(id="g1", workspace_id="ws1", data_source_id="ds_live", kind="manual",
               main_head_commit_seq=9, fork_parent_graph_id=None, falkor_graph_name="customer_360",
               falkor_provider="falkor-eu", owns_falkor_graph=False, projected_commit_seq=4,
               target_commit_seq=9, lag=5, status="idle", last_error=None,
               last_projected_at="2026-10-17T10:00:00+00:00", progress_done=None,
               progress_total=None, updated_at="2026-10-17T10:00:01+00:00")
    return SimpleNamespace(**{**row, **over})


def _graphver(agg, worst):
    seen = []

    class _Result:
        def __init__(self, rows):
            self._rows = rows

        def one(self):
            return self._rows

        def all(self):
            return self._rows

    class _Session:
        async def execute(self, stmt):
            seen.append(stmt)
            return _Result(agg if len(seen) == 1 else worst)

    @asynccontextmanager
    async def session():
        yield _Session()

    return session, seen


async def test_the_rollup_counts_live_graphs_and_names_the_worst(monkeypatch):
    agg = SimpleNamespace(total=3, fresh=1, lagging=1, projecting=0, rebuilding=0, evicted=0,
                          failed=1, max_lag=5)
    session, seen = _graphver(agg, [_worst_row()])

    async def present():
        return ["ds_live"]

    async def directory(ids):
        assert ids == ["ds_live"]
        return {"ds_live": {"label": "Customer 360", "workspaceName": "Sales",
                            "providerName": "Primary", "providerType": "falkordb"}}

    monkeypatch.setattr(probes, "_present_data_source_ids", present)
    monkeypatch.setattr(probes, "_resolve_data_sources", directory)
    monkeypatch.setattr(vdb, "graphver_session", session)

    out = await probes.probe_projection_lag()

    assert {k: v for k, v in out.items() if k != "worst"} == {
        "totalGraphs": 3, "fresh": 1, "lagging": 1, "projecting": 0, "rebuilding": 0,
        "evicted": 0, "failed": 1, "maxLag": 5}
    assert out["worst"] == [{
        "graphId": "g1", "workspaceId": "ws1", "workspaceName": "Sales",
        "dataSourceId": "ds_live", "dataSourceLabel": "Customer 360",
        "providerName": "Primary", "providerType": "falkordb", "kind": "manual",
        "falkorGraphName": "customer_360", "falkorProvider": "falkor-eu",
        "committed": 9, "projected": 4, "target": 9, "lag": 5, "status": "idle",
        "lastError": None, "lastProjectedAt": "2026-10-17T10:00:00+00:00",
        "progressDone": None, "progressTotal": None, "updatedAt": "2026-10-17T10:00:01+00:00",
    }]

    agg_sql, worst_sql = (_sql(s) for s in seen)
    for sql in (agg_sql, worst_sql):
        assert "graphver.graphs.data_source_id IN ('ds_live')" in sql, sql
        assert "LEFT OUTER JOIN graphver.projection_state" in sql, sql
    # The buckets: in sync and failed never overlap; an errored lagging graph is failed only.
    assert "count(*) FILTER (WHERE graphver.graphs.main_head_commit_seq - " \
           "coalesce(graphver.projection_state.projected_commit_seq, 0) <= 0 AND " \
           "graphver.projection_state.last_error IS NULL) AS fresh" in agg_sql, agg_sql
    assert "= 'idle' AND graphver.projection_state.last_error IS NULL) AS lagging" in agg_sql
    assert "count(*) FILTER (WHERE graphver.projection_state.last_error IS NOT NULL) AS failed" \
        in agg_sql
    for bucket in ("projecting", "rebuilding", "evicted"):
        assert f"= '{bucket}') AS {bucket}" in agg_sql, bucket
    # The worst list: only graphs that need attention, most behind first, at most 8.
    assert "graphver.projection_state.last_error IS NOT NULL" in worst_sql
    assert "'projecting'" in worst_sql and "'rebuilding'" in worst_sql
    assert worst_sql.rstrip().endswith(
        "ORDER BY graphver.graphs.main_head_commit_seq - "
        "coalesce(graphver.projection_state.projected_commit_seq, 0) DESC \n LIMIT 8"), worst_sql


async def test_without_the_live_data_sources_it_reports_nothing(monkeypatch):
    async def present():
        raise ConnectionError("management DB down")

    session, seen = _graphver(None, [])
    monkeypatch.setattr(probes, "_present_data_source_ids", present)
    monkeypatch.setattr(vdb, "graphver_session", session)

    assert await probes.probe_projection_lag() is None
    assert seen == []
