"""``versioned_graphs_summary``'s largest graph, which the copy-room explainer draws.

* It is the platform copy with the largest measured size, named by its data source; a connected
  graph (never copied) and a graph not measured yet never count, and between equals the graph id
  decides, so every refresh names the same one.
* Its name is best effort: when the data-source directory can't be read (``{}``), the label is
  null and the figures still answer.
* While no copy is measured there is none, and the directory isn't asked.

Forks are left out by the query, as for every figure (the live inventory test seeds one).
"""
from contextlib import asynccontextmanager
from types import SimpleNamespace

from backend.app.services.system_status import probes
from backend.app.services.versioning import db as vdb

_GB = 1 << 30


def _graph(gid, *, owned=True, size=None):
    return SimpleNamespace(id=gid, data_source_id=f"ds_{gid}", workspace_id="ws_1", status="idle",
                           projected_commit_seq=3, falkor_graph_name=f"gvp_{gid}",
                           last_error=None, candidate_state=None, owns_falkor_graph=owned,
                           size_bytes=size)


async def _summary(monkeypatch, rows, directory=None):
    """The figures over ``rows``, the directory answering ``directory`` (None: by each id's label);
    and the ids the directory was asked for."""
    asked = []

    class _Session:
        async def execute(self, stmt):
            return SimpleNamespace(all=lambda: rows)

    @asynccontextmanager
    async def session():
        yield _Session()

    async def own():
        return set()

    async def resolve(ids):
        asked.append(ids)
        return {i: {"label": f"Label of {i}"} for i in ids} if directory is None else directory

    monkeypatch.setattr(vdb, "graphver_session", session)
    monkeypatch.setattr(probes, "_sources_with_own_settings", own)
    monkeypatch.setattr(probes, "_resolve_data_sources", resolve)
    return await probes.versioned_graphs_summary(), asked


async def test_the_largest_measured_platform_copy_named_by_its_data_source(monkeypatch):
    rows = [_graph("a", size=2 * _GB), _graph("b", size=9 * _GB),
            _graph("c", owned=False, size=20 * _GB), _graph("d")]
    summary, asked = await _summary(monkeypatch, rows)
    assert summary["largestGraph"] == {"graphId": "b", "dataSourceId": "ds_b", "workspaceId": "ws_1",
                                       "label": "Label of ds_b", "bytes": 9 * _GB}
    assert asked == [["ds_b"]]
    assert summary["graphs"] == 4


async def test_between_equals_the_graph_id_decides(monkeypatch):
    for rows in ([_graph("x", size=_GB), _graph("y", size=_GB)],
                 [_graph("y", size=_GB), _graph("x", size=_GB)]):
        assert (await _summary(monkeypatch, rows))[0]["largestGraph"]["graphId"] == "y"


async def test_unnamed_when_the_directory_cant_be_read(monkeypatch):
    summary, _ = await _summary(monkeypatch, [_graph("b", size=9 * _GB)], directory={})
    assert summary["largestGraph"] == {"graphId": "b", "dataSourceId": "ds_b", "workspaceId": "ws_1",
                                       "label": None, "bytes": 9 * _GB}
    assert summary["inMemory"] == 1


async def test_none_while_no_copy_is_measured(monkeypatch):
    summary, asked = await _summary(monkeypatch, [_graph("a"), _graph("c", owned=False, size=_GB)])
    assert summary["largestGraph"] is None
    assert asked == []
